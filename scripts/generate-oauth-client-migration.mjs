#!/usr/bin/env node
/**
 * Generate a reviewed, create-only D1 migration for an OAuth client.
 * 从非秘密清单生成需评审、仅创建客户端的 D1 migration；本工具不修改数据库。
 *
 * Usage / 用法:
 *   node scripts/generate-oauth-client-migration.mjs .temp/new-app.json
 */
import { createPublicKey, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const allowedFields = new Set(['client_id', 'display_name', 'client_type', 'token_endpoint_auth_method', 'sector_identifier', 'subject_salt_revision', 'redirect_uris', 'post_logout_redirect_uris', 'scopes', 'public_jwks']);
const allowedScopes = new Set(['openid', 'profile', 'offline_access']);
const allowedJwkFields = new Set(['kty', 'crv', 'n', 'e', 'x', 'y', 'alg', 'use', 'kid']);

/** Reject invalid manifest state before emitting even one SQL statement. / 输出任何 SQL 前拒绝无效清单。 */
function requireField(ok, message) {
  if (!ok) throw new Error(message);
}

/** Quote an already validated string as one SQLite literal. / 将已验证字符串转为单个 SQLite 字面量。 */
function sql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Generate a time-ordered UUIDv7 for internal row and audit identities.
 * 为内部行和审计事件生成按时间排序的 UUIDv7。
 */
function uuidv7() {
  const bytes = randomBytes(16);
  let millis = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(millis & 0xffn);
    millis >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Validate one exact or native loopback redirect. / 验证精确或原生 loopback 回调。 */
function redirect(entry, native, allowVariablePort) {
  requireField(entry && typeof entry === 'object' && !Array.isArray(entry), 'redirect entry must be an object');
  requireField(Object.keys(entry).every((key) => ['uri', 'match_mode'].includes(key)), 'unknown redirect field');
  const { uri, match_mode: mode = 'exact' } = entry;
  requireField(typeof uri === 'string' && uri.length > 0 && uri.length <= 2048, 'invalid redirect URI length');
  requireField(['exact', 'native_loopback_any_port'].includes(mode), 'invalid match mode');
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('invalid redirect URI'); }
  requireField(!parsed.hash && !parsed.username && !parsed.password, 'redirect must not contain fragment or userinfo');
  requireField(parsed.href === uri, 'redirect URI must be canonical and match exactly');
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname);
  requireField(parsed.protocol === 'https:' || (native && loopback), 'redirect must use HTTPS or native loopback');
  requireField(mode === 'exact' || (allowVariablePort && native && loopback && !parsed.port), 'variable port is only for native loopback without a registered port');
  return { uri, mode };
}

/** Validate a public JWK and reject private material. / 验证公钥 JWK 并拒绝私钥材料。 */
function publicJwk(jwk) {
  requireField(jwk && typeof jwk === 'object' && !Array.isArray(jwk), 'public JWK must be an object');
  requireField(Object.keys(jwk).every((key) => allowedJwkFields.has(key)), 'unknown or private JWK field');
  requireField(typeof jwk.kid === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(jwk.kid), 'invalid JWK kid');
  requireField(jwk.use === 'sig', 'JWK use must be sig');
  requireField((jwk.alg === 'ES256' && jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string') ||
    (jwk.alg === 'RS256' && jwk.kty === 'RSA' && typeof jwk.n === 'string' && typeof jwk.e === 'string'), 'unsupported public JWK');
  requireField(jwk.kty === 'EC' ? !('n' in jwk || 'e' in jwk) : !('crv' in jwk || 'x' in jwk || 'y' in jwk), 'mixed JWK key types');
  let key;
  try { key = createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw new Error('malformed public JWK'); }
  requireField(jwk.kty !== 'RSA' || (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048, 'RSA public key must be at least 2048 bits');
  return jwk;
}

/** Render a create-only migration; applying it twice fails rather than mutating a registered client.
 * 生成仅创建的迁移；重复应用将失败，不会悄悄修改已登记客户端。
 */
export function renderClientMigration(manifest) {
  requireField(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'manifest must be an object');
  requireField(Object.keys(manifest).every((key) => allowedFields.has(key)), 'unknown manifest field');
  const { client_id: id, display_name: name, client_type: type, token_endpoint_auth_method: auth, sector_identifier: sector, subject_salt_revision: revision, redirect_uris: redirects, post_logout_redirect_uris: logout = [], scopes, public_jwks: keys = [] } = manifest;
  requireField(typeof id === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(id), 'invalid client_id');
  requireField(typeof name === 'string' && name.length >= 1 && name.length <= 100, 'invalid display_name');
  requireField((type === 'confidential' && auth === 'private_key_jwt') || (type === 'native' && auth === 'none'), 'client type and auth method mismatch');
  requireField(typeof sector === 'string' && sector.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(sector), 'sector_identifier must be a lowercase DNS name');
  requireField(Number.isSafeInteger(revision) && revision > 0, 'invalid subject_salt_revision');
  requireField(Array.isArray(redirects) && redirects.length > 0 && redirects.length <= 20, '1–20 redirect URIs required');
  requireField(Array.isArray(logout) && logout.length <= 20, 'invalid post-logout redirect list');
  requireField(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= 3 && scopes[0] === 'openid' && scopes.every((scope) => allowedScopes.has(scope)) && new Set(scopes).size === scopes.length, 'scopes must start with openid and use implemented grants only');
  requireField(Array.isArray(keys) && ((type === 'native' && keys.length === 0) || (type === 'confidential' && keys.length >= 1 && keys.length <= 5)), 'wrong public key count');

  const parsedRedirects = redirects.map((entry) => redirect(entry, type === 'native', true));
  const parsedLogout = logout.map((entry) => redirect(entry, type === 'native', false));
  // Without a sector_identifier_uri ownership mechanism, one confidential client must not
  // borrow another redirect host's pairwise sector. / 尚无 sector_identifier_uri 所有权机制，
  // 机密客户端不得借用其他回调主机的成对 subject sector。
  requireField(type !== 'confidential' || parsedRedirects.every(({ uri }) => new URL(uri).hostname === sector), 'confidential redirect host must equal sector_identifier');
  requireField(new Set(parsedRedirects.map(({ uri }) => uri)).size === parsedRedirects.length, 'duplicate redirect URI');
  requireField(new Set(parsedLogout.map(({ uri }) => uri)).size === parsedLogout.length, 'duplicate logout redirect URI');
  const parsedKeys = keys.map(publicJwk);
  requireField(new Set(parsedKeys.map(({ kid }) => kid)).size === parsedKeys.length, 'duplicate JWK kid');

  const now = 'unixepoch()';
  const statements = [
    '-- Deployment-owned OAuth client; public metadata only. / 部署所有的 OAuth 客户端，仅含公开元数据。',
    '-- Apply as a reviewed forward-only D1 migration, not as separate CLI statements. / 作为已评审的只向前 D1 migration 应用，不得逐条执行。',
    `INSERT INTO oauth_clients(client_id,display_name,client_type,token_endpoint_auth_method,sector_identifier,subject_salt_revision,state,created_at,updated_at) VALUES(${sql(id)},${sql(name)},${sql(type)},${sql(auth)},${sql(sector)},${revision},'enabled',${now},${now});`,
  ];
  for (const { uri, mode } of parsedRedirects) statements.push(`INSERT INTO oauth_redirect_uris(redirect_uri_id,client_id,redirect_uri,match_mode,created_at) VALUES(${sql(uuidv7())},${sql(id)},${sql(uri)},${sql(mode)},${now});`);
  for (const { uri } of parsedLogout) statements.push(`INSERT INTO oauth_post_logout_redirect_uris(post_logout_redirect_uri_id,client_id,redirect_uri,created_at) VALUES(${sql(uuidv7())},${sql(id)},${sql(uri)},${now});`);
  for (const scope of scopes) statements.push(`INSERT INTO oauth_client_scopes(client_id,scope,granted_at) VALUES(${sql(id)},${sql(scope)},${now});`);
  for (const jwk of parsedKeys) statements.push(`INSERT INTO oauth_client_keys(client_id,kid,algorithm,public_jwk_json,created_at) VALUES(${sql(id)},${sql(jwk.kid)},${sql(jwk.alg)},${sql(JSON.stringify(jwk))},${now});`);
  const auditId = sql(uuidv7());
  statements.push(`INSERT INTO security_audit_events(audit_event_id,event_name,occurred_at,observed_at,client_id,outcome,correlation_id,policy_revision,context_json) VALUES(${auditId},'identity.oauth_client.created',${now},${now},${sql(id)},'success',${auditId},1,json_object('client_id',${sql(id)}));`);
  statements.push(`INSERT INTO audit_archive_outbox(audit_event_id,r2_object_key,next_attempt_at) VALUES(${auditId},printf('security-audit/unix-day-%d/%s.json',CAST(${now}/86400 AS INTEGER),${auditId}),${now});`);
  return `${statements.join('\n')}\n`;
}

/** Find the next reviewed migration slot. / 查找下一迁移编号。 */
export function nextMigrationNumber(names) {
  const numbers = names.map((name) => /^(\d{4})_.*\.sql$/.exec(name)?.[1]).filter(Boolean).map(Number);
  return String(Math.max(0, ...numbers) + 1).padStart(4, '0');
}

/** Run the documented CLI without database write privileges. / 执行不需要数据库写权限的生成命令。 */
async function main() {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/generate-oauth-client-migration.mjs <manifest.json>');
  const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const migration = renderClientMigration(manifest);
  const names = await readdir('migrations');
  for (const target of ['staging', 'production']) {
    names.push(...await readdir(join('migrations', 'environments', target)));
  }
  const number = nextMigrationNumber(names);
  const basename = `${number}_oauth_client_${manifest.client_id.replaceAll(/[^A-Za-z0-9_-]/g, '_')}.sql`;
  await mkdir('.temp', { recursive: true });
  const output = join('.temp', basename);
  await writeFile(output, migration, { flag: 'wx' });
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
