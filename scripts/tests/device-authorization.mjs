/** Exercise device authorization through a real local Worker and isolated D1.
 * Account provisioning is a fixture; password authentication, browser consent,
 * token issuance, UserInfo, refresh and revocation use the public HTTP contract.
 * Run: npm run build:identity && node scripts/tests/device-authorization.mjs [--browser|--browser-only]
 */
import assert from 'node:assert/strict';
import {createHash, createHmac, generateKeyPairSync, randomUUID, sign, verify} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {join, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const browserOnly = process.argv.includes('--browser-only');
const withBrowser = browserOnly || process.argv.includes('--browser');
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const shim = join(root, 'crates/identity-worker/build/worker/shim.mjs');
assert.ok(existsSync(wrangler), 'Run npm ci first');
assert.ok(existsSync(shim), 'Run npm run build:identity first');
mkdirSync(join(root, '.temp'), {recursive: true});
const state = mkdtempSync(join(root, '.temp/device-authorization-'));
const loginOrigin = 'http://localhost:5173';
const grant = 'urn:ietf:params:oauth:grant-type:device_code';
const client = 'device-journey';
const otherClient = 'device-other';
const now = Math.floor(Date.now() / 1000);
const principal = randomUUID();
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const publicJwk = {...publicKey.export({format: 'jwk'}), kid: 'device-journey-key', use: 'sig', alg: 'RS256'};

function command(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root, encoding: 'utf8', timeout: 90_000,
    env: {...process.env, WRANGLER_SEND_METRICS: 'false'},
  });
  assert.equal(result.status, 0, `Wrangler failed: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
}
async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
const port = await freePort();
// Chromium treats localhost as a secure context and shares its site across ports.
const base = `http://${withBrowser ? 'localhost' : '127.0.0.1'}:${port}`;
const config = join(state, 'wrangler.json');
const prepared = spawnSync(process.execPath, ['scripts/prepare-migrations.mjs', 'staging'], {cwd: root, encoding: 'utf8'});
assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
writeFileSync(config, JSON.stringify({
  name: 'device-authorization-journey', main: shim, compatibility_date: '2026-09-15',
  vars: {
    ENVIRONMENT: 'staging', ISSUER: base, LOGIN_ORIGIN: loginOrigin, ACCOUNT_ORIGIN: 'http://localhost:5174',
    AVATAR_PUBLIC_ORIGIN: 'https://avatars.example.test',
    WEBAUTHN_RP_ID: 'localhost', OAUTH_ENABLED: 'true', OIDC_ACTIVE_KID: publicJwk.kid,
    PUBLIC_JWKS: JSON.stringify({keys: [publicJwk]}),
    OIDC_PRIVATE_KEY_PKCS8: privateKey.export({format: 'der', type: 'pkcs8'}).toString('base64'),
    SESSION_PEPPER: 'device-journey-session-pepper', CSRF_PEPPER: 'device-journey-csrf-pepper',
    TRANSACTION_PEPPER: 'device-journey-transaction-pepper', AUTHORIZATION_CODE_PEPPER: 'device-journey-code-pepper',
    REFRESH_TOKEN_PEPPER: 'device-journey-refresh-pepper', PAIRWISE_SUBJECT_KEY: 'device-journey-subject-pepper',
  },
  d1_databases: [{binding: 'DB', database_name: 'device-journey', database_id: '00000000-0000-0000-0000-000000000001', migrations_dir: join(root, '.temp/migration-streams/staging')}],
  r2_buckets: [{binding: 'AUDIT_ARCHIVE', bucket_name: 'device-journey-audit'}, {binding: 'AVATARS', bucket_name: 'device-journey-avatars'}],
}));
function query(sql) {
  return JSON.parse(command(['d1', 'execute', 'device-journey', '--local', `--persist-to=${state}`, `--config=${config}`, `--command=${sql}`, '--json']))[0].results;
}
command(['d1', 'migrations', 'apply', 'device-journey', '--local', `--persist-to=${state}`, `--config=${config}`]);
// This fixed Argon2id hash encodes the test password using m=19456,t=2,p=1.
const password = 'device journey correct horse battery staple';
const passwordHash = '$argon2id$v=19$m=19456,t=2,p=1$ZGV2aWNlLWpvdXJuZXktc2FsdA$B7CxjNb45ZKyrhbUCz5oKZqXoeuEF888jVxrDuRd+YQ';
query(`INSERT INTO principals(principal_id,kind,lifecycle_state,webauthn_user_handle,created_at,updated_at,state_changed_at) VALUES('${principal}','human','active',randomblob(32),${now},${now},${now});
INSERT INTO human_profiles(principal_id,display_name,locale,created_at,updated_at) VALUES('${principal}','Device Journey','en',${now},${now});
INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,is_primary,created_at,updated_at) VALUES('${randomUUID()}','${principal}','username','devicejourney','devicejourney',1,${now},${now});
INSERT INTO password_credentials(principal_id,password_hash,created_at,updated_at) VALUES('${principal}','${passwordHash}',${now},${now});
INSERT INTO oauth_clients(client_id,display_name,client_type,token_endpoint_auth_method,sector_identifier,subject_salt_revision,device_authorization_enabled,created_at,updated_at) VALUES
('${client}','Device Journey','native','none','device.example',1,1,${now},${now}),
('${otherClient}','Other Device','native','none','other-device.example',1,1,${now},${now}),
('device-disabled','Disabled Device','native','none','disabled-device.example',1,0,${now},${now});
INSERT INTO oauth_client_scopes(client_id,scope,granted_at) SELECT c.client_id,s.scope,${now} FROM oauth_clients c CROSS JOIN oauth_scopes s WHERE c.client_id IN ('${client}','${otherClient}','device-disabled') AND s.scope IN ('openid','profile','offline_access');`);

let logs = '';
const worker = spawn(process.execPath, [wrangler, 'dev', '--local', `--config=${config}`, '--ip=127.0.0.1', `--port=${port}`, `--persist-to=${state}`], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, WRANGLER_SEND_METRICS: 'false'},
});
for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-12000); });
async function json(response, status = 200) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}
async function form(path, fields) {
  return fetch(`${base}${path}`, {method: 'POST', body: new URLSearchParams(fields)});
}
async function oauthError(response, error, status = 400) {
  const body = await json(response, status);
  assert.equal(body.error, error, JSON.stringify(body));
}
async function start(id = client) {
  const response = await form('/v1/oauth/device-authorizations', {client_id: id, scope: 'openid profile offline_access'});
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await json(response);
  assert.equal(result.interval, 5);
  assert.equal(result.expires_in, 600);
  assert.equal(result.verification_uri, `${loginOrigin}/device`);
  assert.equal(new URL(result.verification_uri_complete).searchParams.get('user_code'), result.user_code);
  assert.ok(result.device_code && result.user_code);
  return result;
}
async function poll(device, id = client) {
  return form('/v1/oauth/tokens', {grant_type: grant, client_id: id, device_code: device.device_code});
}
let sessionHeaders;
async function browser(action, body, headers = sessionHeaders) {
  return fetch(`${base}/v1/oauth/device-authorizations/${action}`, {method: 'POST', headers, body: JSON.stringify(body)});
}
function claims(token) {
  const [header, payload, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
  const value = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(value.iss, base);
  assert.equal(value.aud, client);
  assert.ok(value.exp > Date.now() / 1000);
  return value;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) throw new Error(`Worker exited: ${logs}`);
    try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch { /* Wait for the local runtime to listen. */ }
    await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready, `Worker not ready: ${logs}`);
  const metadata = await json(await fetch(`${base}/.well-known/openid-configuration`));
  assert.equal(metadata.device_authorization_endpoint, `${base}/v1/oauth/device-authorizations`);
  assert.ok(metadata.grant_types_supported.includes(grant));
  if (!browserOnly) {
    const contextResponse = await fetch(`${base}/v1/browser-context`, {headers: {origin: loginOrigin}});
    const browserCookie = contextResponse.headers.get('set-cookie')?.split(';')[0];
    const context = await json(contextResponse);
    const authenticated = await fetch(`${base}/v1/password/authentications`, {
      method: 'POST', headers: {origin: loginOrigin, cookie: browserCookie, 'content-type': 'application/json',
        'x-moesegfault-csrf': context.csrf_token, 'idempotency-key': randomUUID()},
      body: JSON.stringify({login: 'devicejourney', password}),
    });
    const sessionCookie = authenticated.headers.get('set-cookie')?.split(';')[0];
    const account = await json(authenticated);
    assert.ok(sessionCookie?.startsWith('__Host-identity_session='));
    sessionHeaders = {origin: loginOrigin, cookie: sessionCookie, 'content-type': 'application/json', 'x-moesegfault-csrf': account.csrf_token};
    console.log('PASS: real password authentication establishes the consent session');

    await oauthError(await form('/v1/oauth/device-authorizations', {client_id: 'device-disabled'}), 'unauthorized_client');
    await oauthError(await form('/v1/oauth/device-authorizations', {client_id: 'unknown'}), 'invalid_client', 401);
    const device = await start();
    const deviceWhere = value => `device_code_digest=X'${createHmac('sha256', 'device-journey-code-pepper').update(`device-code:${value.device_code}`).digest('hex')}'`;
    const readyToPoll = value => query(`UPDATE oauth_device_authorizations SET next_poll_at=unixepoch()-1 WHERE ${deviceWhere(value)}`);
    assert.equal(query(`SELECT state FROM oauth_device_authorizations WHERE ${deviceWhere(device)}`)[0].state, 'pending');
    await oauthError(await poll(device, otherClient), 'invalid_grant');
    // One real interval verifies ordinary polling; other cases advance only the fixture clock.
    await new Promise(done => setTimeout(done, device.interval * 1000));
    await oauthError(await poll(device), 'authorization_pending');
    await oauthError(await poll(device), 'slow_down');
    assert.equal(query(`SELECT poll_interval FROM oauth_device_authorizations WHERE ${deviceWhere(device)}`)[0].poll_interval, 10);

    await oauthError(await browser('lookup', {user_code: device.user_code}, {...sessionHeaders, origin: 'https://foreign.example'}), 'access_denied', 403);
    await oauthError(await browser('decision', {user_code: device.user_code, decision: 'approve'}, {...sessionHeaders, 'x-moesegfault-csrf': 'wrong'}), 'access_denied', 403);
    await oauthError(await browser('lookup', {user_code: device.user_code}, {...sessionHeaders, cookie: ''}), 'login_required', 401);
    const reviewed = await json(await browser('lookup', {user_code: device.user_code.toLowerCase().replace('-', ' ')}));
    assert.equal(reviewed.client_id, client);
    assert.equal(reviewed.client_name, 'Device Journey');
    assert.equal(reviewed.user_code, device.user_code);
    assert.equal(query(`SELECT state FROM oauth_device_authorizations WHERE ${deviceWhere(device)}`)[0].state, 'pending', 'Looking up the code must not authorize');
    assert.deepEqual(await json(await browser('decision', {user_code: device.user_code, decision: 'approve'})), {state: 'approved'});
    await oauthError(await browser('decision', {user_code: device.user_code, decision: 'deny'}), 'invalid_grant');
    readyToPoll(device);
    const tokens = await json(await poll(device));
    assert.ok(tokens.refresh_token);
    const identity = claims(tokens.id_token);
    assert.ok(identity.sub && identity.sub !== principal);
    assert.equal(identity.nonce, undefined, 'Device grant does not manufacture an OIDC nonce');
    assert.equal(identity.name, 'Device Journey');
    assert.deepEqual(identity.amr, ['password']);
    const access = claims(tokens.access_token);
    assert.equal(access.pid, undefined);
    const user = await json(await fetch(metadata.userinfo_endpoint, {headers: {authorization: `Bearer ${tokens.access_token}`}}));
    assert.equal(user.sub, identity.sub);
    assert.equal(user.preferred_username, 'devicejourney');
    await oauthError(await poll(device), 'invalid_grant');
    const refreshed = await json(await form('/v1/oauth/tokens', {grant_type: 'refresh_token', client_id: client, refresh_token: tokens.refresh_token}));
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
    assert.equal(claims(refreshed.id_token).sub, identity.sub);
    const revoked = await form('/v1/oauth/revocations', {client_id: client, token: refreshed.refresh_token, token_type_hint: 'refresh_token'});
    assert.ok(revoked.ok, `Revocation returned ${revoked.status}`);
    await oauthError(await form('/v1/oauth/tokens', {grant_type: 'refresh_token', client_id: client, refresh_token: refreshed.refresh_token}), 'invalid_grant');
    console.log('PASS: pending, persistent slow_down, explicit consent, signed tokens, UserInfo, rotation, revocation and one-time redemption');

    const denied = await start();
    assert.deepEqual(await json(await browser('decision', {user_code: denied.user_code, decision: 'deny'})), {state: 'denied'});
    await oauthError(await poll(denied), 'access_denied');
    const expired = await start();
    query(`UPDATE oauth_device_authorizations SET created_at=unixepoch()-601,expires_at=unixepoch()-1 WHERE ${deviceWhere(expired)}`);
    await oauthError(await poll(expired), 'expired_token');
    await oauthError(await browser('lookup', {user_code: expired.user_code}), 'expired_token');
    console.log('PASS: denial and expiry are terminal protocol outcomes');

    const concurrent = await start();
    const decisions = await Promise.all(['approve', 'deny'].map(decision => browser('decision', {user_code: concurrent.user_code, decision})));
    assert.equal(decisions.filter(response => response.status === 200).length, 1, 'Only one concurrent browser decision may win');
    const winning = await decisions.find(response => response.status === 200).json();
    for (const losing of decisions.filter(response => response.status !== 200)) await oauthError(losing, 'invalid_grant');
    if (winning.state === 'denied') await oauthError(await poll(concurrent), 'access_denied');
    const redemption = await start();
    await json(await browser('decision', {user_code: redemption.user_code, decision: 'approve'}));
    readyToPoll(redemption);
    const before = query(`SELECT COUNT(*) AS n FROM oauth_refresh_token_families`)[0].n;
    const exchanges = await Promise.all([poll(redemption), poll(redemption), poll(redemption)]);
    assert.equal(exchanges.filter(response => response.status === 200).length, 1, 'Only one simultaneous redemption may issue tokens');
    for (const response of exchanges) {
      const body = await response.json();
      if (response.status === 200) claims(body.id_token);
      else assert.ok(['slow_down', 'invalid_grant'].includes(body.error), JSON.stringify(body));
    }
    assert.equal(query(`SELECT COUNT(*) AS n FROM oauth_refresh_token_families`)[0].n, before + 1, 'Losing requests must not create refresh families');
    assert.equal(query(`SELECT state FROM oauth_device_authorizations WHERE ${deviceWhere(redemption)}`)[0].state, 'consumed');
    console.log('PASS: concurrent consent and redemption preserve single-winner state and refresh-family atomicity');

    query(`INSERT INTO oauth_clients(client_id,display_name,client_type,token_endpoint_auth_method,sector_identifier,subject_salt_revision,device_authorization_enabled,created_at,updated_at) VALUES('device-confidential','Confidential Device','confidential','private_key_jwt','confidential.example',1,1,${now},${now});
  INSERT INTO oauth_client_scopes(client_id,scope,granted_at) VALUES('device-confidential','openid',${now});
  INSERT INTO oauth_client_keys(client_id,kid,algorithm,public_jwk_json,created_at) VALUES('device-confidential','${publicJwk.kid}','RS256','${JSON.stringify(publicJwk)}',${now});`);
    function assertion(audience) {
      const at = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({alg: 'RS256', kid: publicJwk.kid})).toString('base64url');
      const payload = Buffer.from(JSON.stringify({iss: 'device-confidential', sub: 'device-confidential', aud: audience, iat: at, exp: at + 60, jti: randomUUID()})).toString('base64url');
      return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
    }
    const assertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
    await oauthError(await form('/v1/oauth/device-authorizations', {client_id: 'device-confidential'}), 'invalid_client', 401);
    await oauthError(await form('/v1/oauth/device-authorizations', {client_id: 'device-confidential', client_assertion_type: assertionType, client_assertion: assertion(metadata.token_endpoint)}), 'invalid_client', 401);
    const startFields = {client_id: 'device-confidential', client_assertion_type: assertionType, client_assertion: assertion(metadata.device_authorization_endpoint)};
    const confidential = await json(await form('/v1/oauth/device-authorizations', startFields));
    await oauthError(await form('/v1/oauth/device-authorizations', startFields), 'invalid_client', 401);
    await json(await browser('decision', {user_code: confidential.user_code, decision: 'approve'}));
    readyToPoll(confidential);
    const confidentialTokens = await json(await form('/v1/oauth/tokens', {client_id: 'device-confidential', grant_type: grant, device_code: confidential.device_code, client_assertion_type: assertionType, client_assertion: assertion(metadata.token_endpoint)}));
    assert.ok(confidentialTokens.id_token);
    assert.equal(confidentialTokens.refresh_token, undefined, 'No offline_access means no refresh token');
    console.log('PASS: confidential assertion audience, replay protection and device token exchange');

    const callback = 'http://127.0.0.1:9999/callback';
    query(`INSERT INTO oauth_redirect_uris(redirect_uri_id,client_id,redirect_uri,match_mode,created_at) VALUES('${randomUUID()}','${client}','${callback}','exact',${now})`);
    const verifier = 'device-journey-legacy-pkce-verifier-1234567890abcdefghijklmnopqrstuvwxyz';
    const nonce = 'legacy-authorization-code-nonce';
    const authorization = new URL(metadata.authorization_endpoint);
    authorization.search = new URLSearchParams({response_type: 'code', client_id: client, redirect_uri: callback, scope: 'openid profile', state: 'legacy-authorization-code-state', nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'}).toString();
    const navigationHeaders = {cookie: sessionCookie, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document'};
    // Undici's fetch adds sec-fetch-mode:cors; use HTTP for the top-level navigation contract.
    async function navigate(url) {
      return new Promise((done, reject) => {
        const req = httpRequest(url, {headers: navigationHeaders}, response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => {
            try {
              assert.equal(response.statusCode, 302, body);
              assert.ok(response.headers.location);
              done(response.headers.location);
            } catch (error) { reject(error); }
          });
        });
        req.on('error', reject);
        req.end();
      });
    }
    const resumedLocation = await navigate(authorization);
    const returned = new URL(await navigate(resumedLocation));
    assert.equal(returned.origin + returned.pathname, callback);
    assert.equal(returned.searchParams.get('state'), 'legacy-authorization-code-state');
    assert.equal(returned.searchParams.get('iss'), base);
    assert.ok(returned.searchParams.get('code'));
    const codeFields = {grant_type: 'authorization_code', client_id: client, code: returned.searchParams.get('code'), redirect_uri: callback, code_verifier: verifier};
    const legacyTokens = await json(await form('/v1/oauth/tokens', codeFields));
    assert.equal(claims(legacyTokens.id_token).nonce, nonce, 'Authorization Code preserves the caller nonce');
    await oauthError(await form('/v1/oauth/tokens', codeFields), 'invalid_grant');
    console.log('PASS: existing Authorization Code + PKCE preserves state, issuer, ID-token nonce and one-time exchange');

    const revokedDevice = await start();
    await json(await browser('decision', {user_code: revokedDevice.user_code, decision: 'approve'}));
    const grants = await json(await fetch(`${base}/v1/me/authorizations`, {headers: {cookie: sessionCookie}}));
    const authorizationGrant = grants.items.find(item => item.client_id === client);
    assert.ok(authorizationGrant, 'Issued tokens appear in Account connected applications');
    const disconnected = await fetch(`${base}/v1/me/authorizations/${authorizationGrant.authorization_id}`, {
      method: 'DELETE', headers: {...sessionHeaders, 'idempotency-key': randomUUID()},
    });
    assert.equal(disconnected.status, 204, await disconnected.text());
    await oauthError(await poll(revokedDevice), 'access_denied');
    assert.equal(query(`SELECT state FROM oauth_device_authorizations WHERE ${deviceWhere(revokedDevice)}`)[0].state, 'denied');
    console.log('PASS: Account authorization revocation cancels an approved, unredeemed device grant');
  }

  if (withBrowser) {
    const {runDeviceBrowserJourney} = await import('../lib/device-browser-journey.mjs');
    const browserTokens = await runDeviceBrowserJourney({root, state, issuer: base, loginOrigin, password, start, poll});
    claims(browserTokens.id_token);
  }

} catch (error) {
  console.error(`Device journey local runtime diagnostics:\n${logs}`);
  throw error;
} finally {
  worker.kill();
}
