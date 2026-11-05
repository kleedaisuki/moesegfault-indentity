import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  deviceJourneyIssuer, fixturePasswordHash,
  renderDeviceJourneyFixtureSql, renderDeviceJourneyCleanupSql,
} from '../lib/device-journey-fixture.mjs';

function fixture() {
  return { issuer: deviceJourneyIssuer, clientName: 'Staging Device Journey',
    runId: randomUUID(), principalId: randomUUID(),
    clientId: 'device-journey-0123456789abcdef01234567', username: 'dj0123456789abcdef01234567' };
}

test('native Argon2id encoding matches the Worker password vector', () => {
  assert.equal(fixturePasswordHash('device journey correct horse battery staple', Buffer.from('device-journey-salt')),
    '$argon2id$v=19$m=19456,t=2,p=1$ZGV2aWNlLWpvdXJuZXktc2FsdA$B7CxjNb45ZKyrhbUCz5oKZqXoeuEF888jVxrDuRd+YQ');
});

test('staging fixture SQL provisions and cleans protocol state while preserving immutable audit roots', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const filename of (await readdir('migrations')).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()) {
      db.exec(await readFile(`migrations/${filename}`, 'utf8'));
    }
    const owned = fixture();
    const password = 'random fixture password';
    db.exec(renderDeviceJourneyFixtureSql(owned, fixturePasswordHash(password)));
    assert.equal(db.prepare('SELECT device_authorization_enabled FROM oauth_clients WHERE client_id=?').get(owned.clientId).device_authorization_enabled, 1);
    assert.equal(db.prepare('SELECT locale FROM human_profiles WHERE principal_id=?').get(owned.principalId).locale, 'en');
    const now = Math.floor(Date.now() / 1000);
    const sid = randomUUID();
    const family = randomUUID();
    const first = randomUUID();
    const next = randomUUID();
    db.prepare(`INSERT INTO identity_sessions(session_id,session_digest,principal_id,auth_method,amr_json,acr,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?,randomblob(32),?,'password','["password"]','urn:moesegfault:acr:password',?,?,?,?)`).run(sid, owned.principalId, now, now, now + 3600, now + 7200);
    db.prepare(`INSERT INTO oauth_refresh_token_families(refresh_token_family_id,client_id,principal_id,identity_session_id,scope,audience,created_at,absolute_expires_at) VALUES(?,?,?,?,'openid profile offline_access',?,?,?)`).run(family, owned.clientId, owned.principalId, sid, owned.clientId, now, now + 7200);
    db.prepare(`INSERT INTO oauth_refresh_tokens(refresh_token_id,refresh_token_family_id,token_digest,generation,issued_at,expires_at,state) VALUES(?,?,randomblob(32),?,?,?,'active')`).run(first, family, 0, now, now + 3600);
    db.prepare(`INSERT INTO oauth_refresh_tokens(refresh_token_id,refresh_token_family_id,token_digest,generation,issued_at,expires_at,state) VALUES(?,?,randomblob(32),?,?,?,'revoked')`).run(next, family, 1, now, now + 3600);
    db.prepare(`UPDATE oauth_refresh_tokens SET state='rotated',consumed_at=?,replacement_token_id=? WHERE refresh_token_id=?`).run(now, next, first);
    db.prepare("UPDATE oauth_refresh_tokens SET state='active' WHERE refresh_token_id=?").run(next);
    db.prepare(`INSERT INTO oauth_client_session_ids VALUES(?,?,?,?)`).run(owned.clientId, sid, 'csid_fixture_public_session', now);
    db.prepare(`INSERT INTO oauth_device_authorizations(device_authorization_id,device_code_digest,user_code_digest,client_id,scope,state,principal_id,identity_session_id,created_at,expires_at,next_poll_at) VALUES(?,randomblob(32),randomblob(32),?,'openid','approved',?,?,?,?,?)`).run(randomUUID(), owned.clientId, owned.principalId, sid, now, now + 600, now + 5);
    const stranger = { ...owned, runId: randomUUID() };
    db.exec(renderDeviceJourneyCleanupSql(stranger));
    assert.equal(db.prepare('SELECT lifecycle_state FROM principals WHERE principal_id=?').get(owned.principalId).lifecycle_state, 'active');
    db.exec(renderDeviceJourneyCleanupSql(owned));
    assert.equal(db.prepare('SELECT lifecycle_state FROM principals WHERE principal_id=?').get(owned.principalId).lifecycle_state, 'deleted');
    assert.equal(db.prepare('SELECT state FROM oauth_clients WHERE client_id=?').get(owned.clientId).state, 'disabled');
    for (const table of ['password_credentials', 'identifiers', 'human_profiles', 'identity_sessions', 'oauth_refresh_tokens', 'oauth_refresh_token_families', 'oauth_device_authorizations']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM security_audit_events').get().n, 3);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec(renderDeviceJourneyCleanupSql(owned));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM security_audit_events').get().n, 4);
    db.exec(renderDeviceJourneyCleanupSql(stranger));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM security_audit_events').get().n, 4);
  } finally { db.close(); }
});

test('fixture mutations reject production and malformed ownership identifiers', () => {
  const owned = fixture();
  assert.throws(() => renderDeviceJourneyCleanupSql({ ...owned, issuer: 'https://identity.moesegfault.dev' }), /owned staging/);
  assert.throws(() => renderDeviceJourneyCleanupSql({ ...owned, clientId: "arbitrary'client" }), /owned staging/);
});

test('fixture files apply and clean up through real isolated local D1', { timeout: 120_000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const root = resolve(import.meta.dirname, '../..');
  await mkdir(join(root, '.temp'), { recursive: true });
  const state = await mkdtemp(join(root, '.temp/device-fixture-d1-'));
  const config = join(state, 'wrangler.json');
  const name = 'device-fixture-local';
  await writeFile(config, JSON.stringify({ name, compatibility_date: '2026-09-15',
    d1_databases: [{ binding: 'DB', database_name: name, database_id: randomUUID(), migrations_dir: join(root, 'migrations') }],
  }));
  const invoke = (...args) => {
    const command = spawnSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'd1', ...args, '--local', `--persist-to=${state}`, `--config=${config}`,
    ], { cwd: root, encoding: 'utf8', timeout: 90_000, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
    assert.equal(command.status, 0, `${command.stderr}\n${command.stdout}`);
    return command.stdout;
  };
  invoke('migrations', 'apply', name);
  const owned = fixture();
  const create = join(state, 'create.sql');
  const cleanup = join(state, 'cleanup.sql');
  await writeFile(create, renderDeviceJourneyFixtureSql(owned, fixturePasswordHash('local randomized fixture password')));
  await writeFile(cleanup, renderDeviceJourneyCleanupSql(owned));
  invoke('execute', name, '--file', create);
  invoke('execute', name, '--file', cleanup);
  const result = JSON.parse(invoke('execute', name, '--json', '--command', `SELECT p.lifecycle_state,c.state,(SELECT COUNT(*) FROM password_credentials WHERE principal_id=p.principal_id) AS credentials FROM principals p JOIN oauth_clients c ON c.client_id='${owned.clientId}' WHERE p.principal_id='${owned.principalId}'`))[0].results;
  assert.deepEqual(result, [{ lifecycle_state: 'deleted', state: 'disabled', credentials: 0 }]);
  const audit = JSON.parse(invoke('execute', name, '--json', '--command', 'SELECT COUNT(*) AS n FROM security_audit_events'))[0].results;
  assert.equal(audit[0].n, 3);
  assert.deepEqual(JSON.parse(invoke('execute', name, '--json', '--command', 'PRAGMA foreign_key_check'))[0].results, []);
});
