import { argon2Sync, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderClientMigration } from '../generate-oauth-client-migration.mjs';

const root = resolve(import.meta.dirname, '../..');
const database = 'moesegfault-identity-staging';
export const deviceJourneyFixtureState = join(root, '.temp/device-journey-fixture.json');
export const deviceJourneyIssuer = 'https://identity-staging.moesegfault.dev';

// Match identity-worker's Argon2id PHC encoding without adding a native dependency.
// https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoargon2syncalgorithm-parameters
export function fixturePasswordHash(password, salt = randomBytes(16)) {
  const digest = argon2Sync('argon2id', {
    message: password, nonce: salt, memory: 19456, passes: 2, parallelism: 1, tagLength: 32,
  });
  const b64 = (value) => value.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=19456,t=2,p=1$${b64(salt)}$${b64(digest)}`;
}

function quote(value) { return `'${value.replaceAll("'", "''")}'`; }

function audit(event, fixture, condition = '1') {
  const id = quote(randomUUID());
  return `INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,subject_principal_id,client_id,outcome,correlation_id,policy_revision,context_json)
SELECT ${id},${quote(event)},unixepoch(),unixepoch(),p.principal_id,c.client_id,'success',${quote(fixture.runId)},1,json_object('fixture','device-journey','run_id',${quote(fixture.runId)})
FROM principals p JOIN oauth_clients c ON c.client_id=${quote(fixture.clientId)} WHERE p.principal_id=${quote(fixture.principalId)} AND ${condition};
INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at)
SELECT audit_event_id,printf('security-audit/unix-day-%d/%s.json',CAST(unixepoch()/86400 AS INTEGER),audit_event_id),unixepoch()
FROM security_audit_events WHERE audit_event_id=${id};`;
}

function validateFixture(fixture) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (fixture.issuer !== deviceJourneyIssuer || !uuid.test(fixture.principalId) || !uuid.test(fixture.runId) ||
      !/^device-journey-[0-9a-f]{24}$/.test(fixture.clientId) || !/^dj[0-9a-f]{24}$/.test(fixture.username)) {
    throw new Error('Not an owned staging device-journey fixture');
  }
}

export function renderDeviceJourneyFixtureSql(fixture, passwordHash) {
  validateFixture(fixture);
  const principal = quote(fixture.principalId);
  return `${renderClientMigration({
    client_id: fixture.clientId, display_name: fixture.clientName, client_type: 'native',
    token_endpoint_auth_method: 'none', sector_identifier: `${fixture.clientId}.example.com`,
    subject_salt_revision: 1, device_authorization_enabled: true, redirect_uris: [],
    scopes: ['openid', 'profile', 'offline_access'],
  })}
INSERT INTO principals(principal_id,kind,lifecycle_state,webauthn_user_handle,created_at,updated_at,state_changed_at)
VALUES(${principal},'human','active',randomblob(32),unixepoch(),unixepoch(),unixepoch());
INSERT INTO human_profiles(principal_id,display_name,locale,created_at,updated_at)
VALUES(${principal},'Device Journey','en',unixepoch(),unixepoch());
INSERT INTO identifiers(identifier_id,principal_id,kind,value,normalized_value,is_primary,created_at,updated_at)
VALUES(${quote(randomUUID())},${principal},'username',${quote(fixture.username)},${quote(fixture.username)},1,unixepoch(),unixepoch());
INSERT INTO password_credentials(principal_id,password_hash,hash_parameters_json,created_at,updated_at)
VALUES(${principal},${quote(passwordHash)},'{"algorithm":"argon2id","version":19,"memory_kib":19456,"iterations":2,"parallelism":1}',unixepoch(),unixepoch());
${audit('identity.device_journey.created', fixture)}\n`;
}

export function renderDeviceJourneyCleanupSql(fixture) {
  validateFixture(fixture);
  const principal = quote(fixture.principalId);
  const client = quote(fixture.clientId);
  const owned = `EXISTS(SELECT 1 FROM security_audit_events WHERE event_name='identity.device_journey.created' AND subject_principal_id=${principal} AND client_id=${client} AND correlation_id=${quote(fixture.runId)})`;
  const family = `SELECT refresh_token_family_id FROM oauth_refresh_token_families WHERE principal_id=${principal} AND client_id=${client} AND ${owned}`;
  const sessions = `SELECT session_id FROM identity_sessions WHERE principal_id=${principal} AND ${owned}`;
  // Audit rows are immutable FK roots. Retain inert client/principal tombstones;
  // remove credentials and protocol state instead of disabling foreign keys.
  return `
UPDATE oauth_clients SET state='disabled',device_authorization_enabled=0,updated_at=unixepoch() WHERE client_id=${client} AND ${owned};
DELETE FROM oauth_device_authorizations WHERE client_id=${client} AND ${owned};
UPDATE oauth_refresh_tokens SET state='revoked',replacement_token_id=NULL WHERE refresh_token_family_id IN (${family});
DELETE FROM oauth_refresh_tokens WHERE refresh_token_family_id IN (${family});
DELETE FROM oauth_refresh_token_families WHERE principal_id=${principal} AND client_id=${client} AND ${owned};
DELETE FROM oauth_user_authorizations WHERE principal_id=${principal} AND client_id=${client} AND ${owned};
DELETE FROM oauth_client_session_ids WHERE client_id=${client} AND ${owned};
DELETE FROM session_authentication_methods WHERE session_id IN (${sessions});
UPDATE identity_sessions SET created_from_session_id=NULL WHERE principal_id=${principal} AND ${owned};
DELETE FROM identity_sessions WHERE principal_id=${principal} AND ${owned};
DELETE FROM pairwise_subjects WHERE principal_id=${principal} AND ${owned};
DELETE FROM password_credentials WHERE principal_id=${principal} AND ${owned};
DELETE FROM identifiers WHERE principal_id=${principal} AND ${owned};
DELETE FROM human_profiles WHERE principal_id=${principal} AND ${owned};
DELETE FROM oauth_client_scopes WHERE client_id=${client} AND ${owned};
UPDATE principals SET lifecycle_state='deleted',deleted_at=unixepoch(),updated_at=unixepoch(),state_changed_at=unixepoch() WHERE principal_id=${principal} AND ${owned};
${audit('identity.device_journey.cleaned_up', fixture, owned)}\n`;
}

async function executeStagingFile(file) {
  const configPath = join(root, 'wrangler.identity.jsonc');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.vars?.ENVIRONMENT !== 'staging' || config.vars?.ISSUER !== deviceJourneyIssuer ||
      config.d1_databases?.find((entry) => entry.binding === 'DB')?.database_name !== database) {
    throw new Error('Device fixture requires the canonical staging D1 configuration');
  }
  const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
  delete env.CLOUDFLARE_ENV;
  const result = spawnSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'),
    'd1', 'execute', database, '--remote', '--config', configPath, '--file', file, '--yes', '--json',
  ], { cwd: root, encoding: 'utf8', timeout: 120_000, env });
  // Keep SQL/password hashes in .temp only; Wrangler may include the failed SQL
  // in an error. Report service error codes and request IDs without echoing SQL.
  if (result.status !== 0) {
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    await writeFile(file.replace(/\.sql$/, '.diagnostics.log'), diagnostic, { mode: 0o600 });
    const requestIds = [...diagnostic.matchAll(/(?:request[-_ ]?id|cf[-_ ]ray)[:=\s]+[\"']?([a-z0-9-]+)/gi)].map((entry) => entry[1]);
    const codes = [...diagnostic.matchAll(/(?:code[:= ]+|\[code:\s*)(\d+)/gi)].map((entry) => entry[1]);
    throw new Error(`Staging device fixture D1 operation failed (exit ${result.status}, codes ${codes.join(',') || 'unavailable'}, request IDs ${requestIds.join(',') || 'unavailable'}${result.error ? `, ${result.error.message}` : ''}). SQL and Wrangler diagnostics remain in ${file.replace(/\.sql$/, '.diagnostics.log')}`);
  }
}

export async function createDeviceJourneyFixture() {
  await mkdir(join(root, '.temp'), { recursive: true });
  const suffix = randomBytes(12).toString('hex');
  const fixture = {
    issuer: deviceJourneyIssuer, loginOrigin: 'https://login-staging.moesegfault.dev',
    runId: randomUUID(), principalId: randomUUID(), clientId: `device-journey-${suffix}`,
    clientName: 'Staging Device Journey', username: `dj${suffix}`,
  };
  const password = randomBytes(32).toString('base64url');
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${password}\n`);
  // Persist non-secret ownership first so a cancelled runner can clean up.
  await writeFile(deviceJourneyFixtureState, `${JSON.stringify(fixture, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const sqlFile = join(root, `.temp/device-journey-${fixture.runId}-create.sql`);
  await writeFile(sqlFile, renderDeviceJourneyFixtureSql(fixture, fixturePasswordHash(password)), { flag: 'wx', mode: 0o600 });
  await executeStagingFile(sqlFile);
  return { ...fixture, password, stateFile: deviceJourneyFixtureState };
}

export async function cleanupDeviceJourneyFixture(fixture) {
  if (!fixture) {
    try { fixture = JSON.parse(await readFile(deviceJourneyFixtureState, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
  validateFixture(fixture);
  const sqlFile = join(root, `.temp/device-journey-${fixture.runId}-cleanup-${randomBytes(4).toString('hex')}.sql`);
  await writeFile(sqlFile, renderDeviceJourneyCleanupSql(fixture), { flag: 'wx', mode: 0o600 });
  await executeStagingFile(sqlFile);
  await unlink(deviceJourneyFixtureState).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--cleanup') throw new Error('Use this fixture through the staging device journey, or pass --cleanup');
  await cleanupDeviceJourneyFixture();
}
