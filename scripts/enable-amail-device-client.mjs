#!/usr/bin/env node
/** Apply only the reviewed amail registration migration, without redeploying services. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = process.argv[2];
assert.ok(process.argv.length === 3 && ['staging', 'production'].includes(target),
  'usage: node scripts/enable-amail-device-client.mjs staging|production');
const client = target === 'production' ? 'amail-cli' : 'amail-cli-staging';
const sector = target === 'production' ? 'amail.moesegfault.dev' : 'amail-staging.moesegfault.dev';
const migration = '0013_amail_device_authorization.sql';
const database = `moesegfault-identity-${target}`;
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
delete env.CLOUDFLARE_ENV;
const args = ['--remote', '--config', join(root, 'wrangler.identity.jsonc'), '--env', target === 'production' ? 'production' : ''];

function wrangler(command, options = {}) {
  return execFileSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'),
    'd1', ...command, database, ...args, ...options.arguments ?? []],
  { cwd: root, env, encoding: 'utf8', timeout: 180_000, stdio: options.stdio ?? 'pipe' });
}
function query(sql) {
  const result = JSON.parse(wrangler(['execute'], { arguments: ['--command', sql, '--json'] }));
  return result.flatMap((item) => item.results);
}
function registration() {
  return {
    client: query(`SELECT client_id,display_name,client_type,token_endpoint_auth_method,sector_identifier,subject_salt_revision,state,created_at FROM oauth_clients WHERE client_id='${client}'`),
    redirects: query(`SELECT redirect_uri,match_mode FROM oauth_redirect_uris WHERE client_id='${client}' ORDER BY redirect_uri`),
    scopes: query(`SELECT scope FROM oauth_client_scopes WHERE client_id='${client}' ORDER BY scope`),
  };
}

const before = registration();
assert.equal(before.client.length, 1, 'Expected the existing amail client');
assert.equal(before.client[0].client_type, 'native');
assert.equal(before.client[0].token_endpoint_auth_method, 'none');
assert.equal(before.client[0].sector_identifier, sector);
assert.equal(before.client[0].state, 'enabled');
const applied = new Set(query('SELECT name FROM d1_migrations').map((row) => row.name));
assert.ok(applied.has('0012_device_authorization.sql'), 'Deploy device authorization schema first');
const common = await readdir(join(root, 'migrations'));
const overlay = await readdir(join(root, 'migrations/environments', target));
const pending = [...common, ...overlay].filter((name) => /^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name) && !applied.has(name));
assert.deepEqual(pending, applied.has(migration) ? [] : [migration], 'Unrelated pending Identity migrations require their own release');
if (pending.length) {
  const sql = await readFile(join(root, 'migrations/environments', target, migration), 'utf8');
  assert.ok(sql.includes(`WHERE client_id = '${client}'`), 'Migration must select this exact existing client');
  execFileSync(process.execPath, [join(root, 'scripts/prepare-migrations.mjs'), target], { cwd: root, env, stdio: 'inherit' });
  wrangler(['migrations', 'apply'], { stdio: 'inherit' });
}
assert.deepEqual(registration(), before, 'Client identity, scope and redirects must remain unchanged');
assert.deepEqual(query(`SELECT device_authorization_enabled FROM oauth_clients WHERE client_id='${client}'`), [{ device_authorization_enabled: 1 }]);
assert.equal(query(`SELECT COUNT(*) AS count FROM d1_migrations WHERE name='${migration}'`)[0].count, 1);
console.log(JSON.stringify({ environment: target, client_id: client, migration,
  device_authorization_enabled: true, identity_mapping_preserved: true, services_redeployed: false }));
