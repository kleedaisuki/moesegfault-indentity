#!/usr/bin/env node
/** Validate deployed staging with the portable CLI and an actual browser.
 * Uses a disposable deployment-owned fixture, or an explicitly supplied staging
 * fixture. Browser credentials stay in memory; evidence excludes token material.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {access, chmod, mkdir, mkdtemp, open, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';
import {discover, verifyIdToken} from './device-login.mjs';
import {createDeviceJourneyFixture, cleanupDeviceJourneyFixture} from './lib/device-journey-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const issuer = process.env.DEVICE_JOURNEY_ISSUER ?? 'https://identity-staging.moesegfault.dev';
const loginOrigin = process.env.DEVICE_JOURNEY_LOGIN_ORIGIN ?? 'https://login-staging.moesegfault.dev';
assert.equal(issuer, 'https://identity-staging.moesegfault.dev', 'This journey owns only a staging fixture');
assert.equal(loginOrigin, 'https://login-staging.moesegfault.dev');
const supplied = ['DEVICE_JOURNEY_CLIENT_ID', 'DEVICE_JOURNEY_USERNAME', 'DEVICE_JOURNEY_PASSWORD'].map(name => process.env[name]);
assert.ok(supplied.every(Boolean) || supplied.every(value => !value), 'Supply all three fixture credentials, or allow a new staging fixture');
const generatedFixture = supplied.every(value => !value);
let fixture;
let clientId = process.env.DEVICE_JOURNEY_CLIENT_ID;
let username = process.env.DEVICE_JOURNEY_USERNAME;
let password = process.env.DEVICE_JOURNEY_PASSWORD;
let clientName = process.env.DEVICE_JOURNEY_CLIENT_NAME;
const temporary = join(root, '.temp');
await mkdir(temporary, {recursive: true});
const state = await mkdtemp(join(temporary, 'device-staging-'));
await chmod(state, 0o700);
const summary = {issuer, client_id: clientId, started_at: new Date().toISOString(), checks: [], requests: []};
const secretFiles = new Set();
const children = new Set();
let browser;
let page;
let sessionCookie;
let persisted;
let metadata;

function pass(check) {
  summary.checks.push(check);
  process.stdout.write(`PASS: ${check}\n`);
}
async function missing(path) {
  try { await access(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function responseJson(response, expected = 200) {
  const correlation = response.headers.get('x-moesegfault-correlation-id');
  summary.requests.push({path: new URL(response.url).pathname, status: response.status, ...(correlation && {correlation_id: correlation})});
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`HTTP ${response.status} non-JSON response${correlation ? ` (correlation ${correlation})` : ''}`); }
  assert.equal(response.status, expected, `HTTP ${response.status}: ${body.error ?? body.error_code ?? body.title ?? 'request_failed'}${correlation ? ` (correlation ${correlation})` : ''}`);
  return body;
}
async function form(url, fields, expected = 200) {
  return responseJson(await fetch(url, {
    method: 'POST', body: new URLSearchParams(fields), redirect: 'error', signal: AbortSignal.timeout(30_000),
  }), expected);
}
function launchCli(name) {
  const output = join(state, `${name}-tokens.json`);
  secretFiles.add(output);
  const childEnvironment = {...process.env};
  delete childEnvironment.DEVICE_JOURNEY_PASSWORD;
  const child = spawn(process.execPath, [join(root, 'scripts/device-login.mjs'), '--issuer', issuer,
    '--client-id', clientId, '--scope', 'openid profile offline_access', '--output', output], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment,
  });
  children.add(child);
  let stderr = '';
  let stdout = '';
  const exited = new Promise((done, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => { children.delete(child); done({code, signal}); });
  });
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  const prompt = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI did not present a device login within 45 seconds')), 45_000);
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const uri = /^Open (https:\/\/\S+)$/m.exec(stderr)?.[1];
      const code = /^Enter code: ([A-Z2-9]{4}-[A-Z2-9]{4})$/m.exec(stderr)?.[1];
      if (uri && code) { clearTimeout(timer); done({uri, code}); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`CLI exited before its login prompt (status ${code}; ${stderr.split('\n').filter(Boolean).at(-1) ?? 'no diagnostic'})`));
    });
  });
  return {
    child, output, prompt,
    async complete(expectedCode) {
      const result = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('CLI did not settle within 45 seconds after the browser decision')), 45_000).unref())]);
      assert.equal(result.code, expectedCode, `CLI status ${result.code}: ${stderr.split('\n').filter(Boolean).at(-1)}`);
      assert.equal(stdout, '', 'The CLI must not print tokens to stdout');
      return stderr;
    },
  };
}
async function review(prompt, authenticate) {
  assert.equal(prompt.uri, `${loginOrigin}/device`);
  await page.goto(prompt.uri);
  await page.locator('input[name="user_code"]').fill(prompt.code);
  await page.locator('form').filter({has: page.locator('input[name="user_code"]')}).locator('button[type="submit"]').click();
  if (authenticate) {
    await page.locator('main a[href^="/login?device_user_code="]').click();
    await page.locator('input[name="login"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form').filter({has: page.locator('input[name="password"]')}).locator('button[type="submit"]').click();
  }
  await page.getByRole('button', {name: 'Confirm and allow sign-in', exact: true}).waitFor();
  assert.equal(new URL(page.url()).pathname, '/device');
  const text = await page.locator('main').innerText();
  assert.ok(text.includes(prompt.code) && text.includes(clientId) && text.includes(username), 'Consent must identify this exact code, client and account');
  if (clientName) assert.ok(text.includes(clientName), 'Consent must display the registered client name');
  assert.ok(text.includes('openid profile offline_access'), 'Consent must show the requested scopes');
}
async function cleanupBrowserSession() {
  const cookies = await page.context().cookies(issuer);
  sessionCookie ??= cookies.find(cookie => cookie.name === '__Host-identity_session')?.value;
  if (!sessionCookie) return undefined;
  const headers = {cookie: `__Host-identity_session=${sessionCookie}`};
  const response = await fetch(`${issuer}/v1/me`, {headers});
  if (response.status === 401) return 401;
  const current = await responseJson(response);
  const sessions = await responseJson(await fetch(`${issuer}/v1/principals/self/sessions`, {headers}));
  const currentSession = sessions.items.find(item => item.is_current && !item.revoked_at);
  assert.ok(currentSession, 'The authenticated fixture must have a current session to sign out');
  const signedOut = await fetch(`${issuer}/v1/principals/self/sessions/${currentSession.session_id}`, {
    method: 'DELETE', headers: {...headers, origin: loginOrigin, 'x-moesegfault-csrf': current.csrf_token, 'idempotency-key': crypto.randomUUID()},
  });
  assert.equal(signedOut.status, 204, 'The staging browser session must sign out');
  return signedOut.status;
}
try {
  if (generatedFixture) fixture = await createDeviceJourneyFixture();
  clientId ??= fixture?.clientId;
  username ??= fixture?.username;
  password ??= fixture?.password;
  clientName ??= fixture?.clientName;
  assert.ok(clientId && username && password, 'The dedicated staging fixture must provide client ID, username and password');
  summary.client_id = clientId;
  metadata = await discover(issuer);
  browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width: 390, height: 844}, locale: 'en-US'});
  page = await context.newPage();
  page.setDefaultTimeout(45_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => summary.requests.push({path: new URL(request.url()).pathname, status: 0, error: request.failure()?.errorText}));
  page.on('response', response => {
    if (new URL(response.url()).origin === issuer) summary.requests.push({path: new URL(response.url()).pathname, status: response.status()});
  });
  const approval = launchCli('approval');
  await review(await approval.prompt, true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile consent must not overflow');
  await page.screenshot({path: join(state, 'staging-device-consent-mobile.png'), fullPage: true});
  await page.waitForTimeout(6200);
  assert.equal(approval.child.exitCode, null, 'CLI must continue waiting before explicit consent');
  assert.ok(await missing(approval.output), 'Opening the page and signing in must not create a token file');
  pass('deployed mobile Login accepts manual code entry, password login and explicit review without auto-approval');
  await page.getByRole('button', {name: 'Confirm and allow sign-in', exact: true}).click();
  await page.getByRole('heading', {name: 'Device sign-in approved', exact: true}).waitFor();
  await approval.complete(0);
  assert.equal((await stat(approval.output)).mode & 0o777, 0o600);
  persisted = JSON.parse(await readFile(approval.output, 'utf8'));
  assert.equal(persisted.issuer, issuer);
  assert.equal(persisted.client_id, clientId);
  const identity = await verifyIdToken(metadata, clientId, persisted.id_token);
  assert.equal(persisted.subject, identity.sub);
  assert.ok(persisted.refresh_token);
  const user = await responseJson(await fetch(metadata.userinfo_endpoint, {headers: {authorization: `Bearer ${persisted.access_token}`}, redirect: 'error'}));
  assert.equal(user.sub, identity.sub);
  assert.equal(user.preferred_username, username);
  pass('portable remote CLI polls real HTTPS endpoints, verifies OIDC and persists private tokens; UserInfo matches the fixture');

  const refreshed = await form(metadata.token_endpoint, {grant_type: 'refresh_token', client_id: clientId, refresh_token: persisted.refresh_token});
  assert.ok(refreshed.refresh_token && refreshed.refresh_token !== persisted.refresh_token, 'Refresh must rotate the secret');
  assert.equal((await verifyIdToken(metadata, clientId, refreshed.id_token)).sub, identity.sub);
  persisted = {...persisted, ...refreshed};
  const replacement = join(state, 'rotated-tokens.json');
  secretFiles.add(replacement);
  const file = await open(replacement, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(persisted)}\n`); } finally { await file.close(); }
  await rename(replacement, approval.output);
  assert.equal((await stat(approval.output)).mode & 0o777, 0o600);
  const revoke = await fetch(metadata.revocation_endpoint, {method: 'POST', body: new URLSearchParams({client_id: clientId, token: persisted.refresh_token, token_type_hint: 'refresh_token'}), redirect: 'error'});
  assert.equal(revoke.status, 200);
  const rejected = await form(metadata.token_endpoint, {grant_type: 'refresh_token', client_id: clientId, refresh_token: persisted.refresh_token}, 400);
  assert.equal(rejected.error, 'invalid_grant');
  persisted = undefined;
  pass('remote refresh rotates and is atomically persisted; explicit revocation rejects subsequent renewal');

  const denial = launchCli('denial');
  await review(await denial.prompt, false);
  await page.getByRole('button', {name: 'Deny sign-in', exact: true}).click();
  await page.getByRole('heading', {name: 'Sign-in denied', exact: true}).waitFor();
  assert.match(await denial.complete(1), /access_denied/);
  assert.ok(await missing(denial.output));
  pass('authenticated browser denial terminates the remote CLI without creating a token file');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  sessionCookie = (await context.cookies(issuer)).find(cookie => cookie.name === '__Host-identity_session')?.value;
  assert.ok(sessionCookie, 'Real browser keeps an Identity session');
  summary.outcome = 'passed';
} catch (error) {
  summary.outcome = 'failed';
  summary.error = error instanceof Error ? error.message : String(error);
  if (page) {
    summary.browser_path = new URL(page.url()).pathname;
    summary.browser_message = await page.locator('main').innerText().catch(() => 'No main content rendered');
    await page.screenshot({path: join(state, 'staging-device-failure.png'), fullPage: true}).catch(() => {});
  }
  throw error;
} finally {
  for (const child of children) child.kill();
  if (persisted?.refresh_token) {
    await fetch(metadata.revocation_endpoint, {method: 'POST', body: new URLSearchParams({client_id: clientId, token: persisted.refresh_token, token_type_hint: 'refresh_token'}), redirect: 'error'}).catch(() => {});
  }
  if (page) {
    try { summary.session_cleanup_status = await cleanupBrowserSession(); }
    catch (error) {
      summary.outcome = 'failed';
      summary.session_cleanup_error = error instanceof Error ? error.message : String(error);
    }
  }
  await browser?.close();
  for (const path of secretFiles) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (generatedFixture) {
    try {
      await cleanupDeviceJourneyFixture(fixture);
      summary.fixture_cleanup = 'passed';
    } catch (error) {
      summary.fixture_cleanup = 'failed';
      summary.outcome = 'failed';
      summary.cleanup_error = error instanceof Error ? error.message : String(error);
    }
  }
  summary.completed_at = new Date().toISOString();
  await writeFile(join(state, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {mode: 0o600});
  process.stdout.write(`Staging journey evidence: ${join(state, 'summary.json')}\n`);
  const cleanupError = summary.cleanup_error ?? summary.session_cleanup_error;
  if (cleanupError) throw new Error(cleanupError);
}
