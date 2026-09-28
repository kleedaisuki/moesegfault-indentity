/**
 * Contract tests for reviewed OAuth client migration generation.
 * OAuth 客户端迁移生成器的契约测试；不访问远端数据库。
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nextMigrationNumber, renderClientMigration } from '../generate-oauth-client-migration.mjs';

/** Build a valid confidential app manifest with a real public key. / 构造含真实公钥的机密应用清单。 */
function confidential() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    client_id: 'app-staging', display_name: 'App staging', client_type: 'confidential',
    token_endpoint_auth_method: 'private_key_jwt', sector_identifier: 'app.example.com',
    subject_salt_revision: 1,
    redirect_uris: [{ uri: 'https://app.example.com/auth/callback', match_mode: 'exact' }],
    post_logout_redirect_uris: [{ uri: 'https://app.example.com/' }],
    scopes: ['openid', 'profile', 'offline_access'],
    public_jwks: [{ ...publicKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig', kid: 'app-2026-09' }],
  };
}

test('generates create-only client, redirects, grants, and public key', () => {
  const sql = renderClientMigration(confidential());
  assert.match(sql, /INSERT INTO oauth_clients/);
  assert.match(sql, /INSERT INTO oauth_redirect_uris/);
  assert.match(sql, /INSERT INTO oauth_post_logout_redirect_uris/);
  assert.match(sql, /INSERT INTO oauth_client_keys/);
  assert.match(sql, /INSERT INTO security_audit_events/);
  assert.match(sql, /INSERT INTO audit_archive_outbox/);
  assert.equal((sql.match(/INSERT INTO oauth_client_scopes/g) ?? []).length, 3);
  assert.doesNotMatch(sql, /INSERT OR REPLACE|UPDATE oauth_clients|DELETE FROM/);
});

test('rejects private keys, unsupported scopes, and non-loopback HTTP', () => {
  const withPrivate = confidential();
  withPrivate.public_jwks[0].d = 'private';
  assert.throws(() => renderClientMigration(withPrivate), /private JWK field/);
  const withScope = confidential();
  withScope.scopes.push('email');
  assert.throws(() => renderClientMigration(withScope), /implemented grants/);
  const withHttp = confidential();
  withHttp.redirect_uris[0].uri = 'http://app.example.com/auth/callback';
  assert.throws(() => renderClientMigration(withHttp), /HTTPS/);
});

test('accepts a valid RSA public key and rejects a borrowed pairwise sector', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
  const manifest = confidential();
  manifest.public_jwks = [{ ...rsa, alg: 'RS256', use: 'sig', kid: 'rsa-key' }];
  assert.match(renderClientMigration(manifest), /'RS256'/);
  manifest.sector_identifier = 'other.example.com';
  assert.throws(() => renderClientMigration(manifest), /redirect host must equal sector_identifier/);
});

test('native variable-port mode is limited to loopback and has no keys', () => {
  const native = { ...confidential(), client_type: 'native', token_endpoint_auth_method: 'none', public_jwks: [], redirect_uris: [{ uri: 'http://127.0.0.1/callback', match_mode: 'native_loopback_any_port' }] };
  assert.match(renderClientMigration(native), /native_loopback_any_port/);
  native.redirect_uris[0].uri = 'http://192.168.1.10/callback';
  assert.throws(() => renderClientMigration(native), /HTTPS or native loopback/);
});

test('SQL escapes display names and rejects duplicate redirects', () => {
  const manifest = confidential();
  manifest.display_name = "O'Brien's App";
  assert.match(renderClientMigration(manifest), /O''Brien''s App/);
  manifest.redirect_uris.push(manifest.redirect_uris[0]);
  assert.throws(() => renderClientMigration(manifest), /duplicate redirect URI/);
});

test('discovers next migration number instead of hardcoding an active worktree slot', () => {
  assert.equal(nextMigrationNumber(['0001_a.sql', '0005_oauth.sql', '0006_password.sql']), '0007');
});

test('staging and production manifests keep clients and redirect hosts separate', () => {
  const staging = confidential();
  staging.redirect_uris[0].uri = 'https://app-staging.example.com/auth/callback';
  staging.sector_identifier = 'app-staging.example.com';
  const production = confidential();
  production.client_id = 'app-production';
  const stagingSql = renderClientMigration(staging);
  const productionSql = renderClientMigration(production);
  assert.match(stagingSql, /app-staging\.example\.com/);
  assert.doesNotMatch(productionSql, /app-staging\.example\.com/);
  assert.match(productionSql, /app-production/);
  assert.doesNotMatch(stagingSql, /app-production/);
});

/** Run one isolated local D1 command using the pinned Wrangler. / 使用固定版本 Wrangler 执行隔离的本地 D1 命令。 */
function wrangler(args) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const cli = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('generated SQL applies as an actual isolated local D1 migration', { timeout: 180_000 }, async () => {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const base = join(root, '.temp', `oauth-client-provision-${randomUUID()}`);
  const migrations = join(base, 'migrations');
  const persist = join(base, 'd1');
  const config = join(base, 'wrangler.jsonc');
  await mkdir(migrations, { recursive: true });
  const names = (await readdir(join(root, 'migrations'))).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  assert.ok(names.length > 0, 'repository migration chain is missing');
  for (const name of names) {
    await copyFile(join(root, 'migrations', name), join(migrations, name));
  }
  const fixtureName = `${nextMigrationNumber(names)}_test_oauth_client.sql`;
  await writeFile(join(migrations, fixtureName), renderClientMigration(confidential()));
  await writeFile(config, JSON.stringify({ name: 'oauth-client-provision-test', compatibility_date: '2026-09-15', d1_databases: [{ binding: 'DB', database_name: 'oauth-client-provision-test', database_id: randomUUID(), migrations_dir: migrations }] }));
  wrangler(['d1', 'migrations', 'apply', 'oauth-client-provision-test', '--local', `--persist-to=${persist}`, '--config', config]);
  const applied = JSON.parse(wrangler(['d1', 'execute', 'oauth-client-provision-test', '--local', `--persist-to=${persist}`, '--config', config, '--command', 'SELECT name FROM d1_migrations ORDER BY id', '--json']));
  assert.deepEqual(applied[0].results.map(({ name }) => name), [...names, fixtureName]);
  const output = wrangler(['d1', 'execute', 'oauth-client-provision-test', '--local', `--persist-to=${persist}`, '--config', config, '--command', "SELECT client_id,client_type FROM oauth_clients WHERE client_id='app-staging'"]);
  assert.match(output, /app-staging/);
  assert.match(output, /confidential/);
  const fk = wrangler(['d1', 'execute', 'oauth-client-provision-test', '--local', `--persist-to=${persist}`, '--config', config, '--command', 'PRAGMA foreign_key_check']);
  assert.doesNotMatch(fk, /oauth_client_keys|oauth_redirect_uris|oauth_client_scopes/);
  const audit = wrangler(['d1', 'execute', 'oauth-client-provision-test', '--local', `--persist-to=${persist}`, '--config', config, '--command', "SELECT e.event_name,o.state FROM security_audit_events e JOIN audit_archive_outbox o USING(audit_event_id) WHERE e.client_id='app-staging'"]);
  assert.match(audit, /identity\.oauth_client\.created/);
  assert.match(audit, /pending/);
});

test('environment streams register only their own native client in isolated D1', { timeout: 180_000 }, async () => {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  for (const target of ['staging', 'production']) {
    const prepared = spawnSync(process.execPath, ['scripts/prepare-migrations.mjs', target], { cwd: root, encoding: 'utf8' });
    assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
  }
  const base = join(root, '.temp', `oauth-client-env-${randomUUID()}`);
  for (const [target, id, other] of [
    ['staging', 'amail-cli-staging', 'amail-cli'],
    ['production', 'amail-cli', 'amail-cli-staging'],
  ]) {
    const database = `moesegfault-identity-${target}`;
    const persist = join(base, target);
    const env = target === 'production' ? ['--env', 'production'] : [];
    const args = ['--local', `--persist-to=${persist}`, '--config', 'wrangler.identity.jsonc', ...env];
    wrangler(['d1', 'migrations', 'apply', database, ...args]);
    const rows = JSON.parse(wrangler(['d1', 'execute', database, ...args, '--command', 'SELECT client_id,client_type,token_endpoint_auth_method,sector_identifier FROM oauth_clients ORDER BY client_id', '--json']))[0].results;
    assert.ok(rows.some((row) => row.client_id === id && row.client_type === 'native' && row.token_endpoint_auth_method === 'none'));
    assert.ok(!rows.some((row) => row.client_id === other), `${target} contains ${other}`);
    const redirects = JSON.parse(wrangler(['d1', 'execute', database, ...args, '--command', `SELECT redirect_uri,match_mode FROM oauth_redirect_uris WHERE client_id='${id}'`, '--json']))[0].results;
    assert.deepEqual(redirects, [{ redirect_uri: 'http://127.0.0.1/callback', match_mode: 'native_loopback_any_port' }]);
  }
});
