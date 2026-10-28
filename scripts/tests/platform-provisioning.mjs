import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDatabase, selectedEnvironment } from '../provision-platform.mjs';
const uuid = '12345678-1234-1234-1234-123456789abc';
const binding = { unit: 'notifications', database_name: 'moesegfault-notifications-staging' };
const databases = [{ name: binding.database_name, uuid }];
test('platform state reuses fixed environment name and pins existing identity', () => {
  assert.equal(resolveDatabase(binding, databases, 'staging'), uuid);
  assert.equal(resolveDatabase({ ...binding, database_id: uuid }, databases, 'staging'), uuid);
  assert.throws(() => resolveDatabase({ ...binding, database_id: 'other' }, databases, 'staging'), /mismatch/);
  assert.throws(() => resolveDatabase(binding, [], 'staging'), /exactly one/);
  assert.throws(() => resolveDatabase(binding, [...databases, ...databases], 'staging'), /exactly one/);
});
test('cross-environment resolution and unknown targets fail closed', () => {
  assert.throws(() => resolveDatabase(binding, databases, 'production'), /unexpected database/);
  const config = { name: 'staging', env: { production: { name: 'production' } } };
  assert.equal(selectedEnvironment(config, 'staging').name, 'staging');
  assert.equal(selectedEnvironment(config, 'production').name, 'production');
  assert.throws(() => selectedEnvironment(config, 'preview'), /Unsupported/);
  assert.throws(() => selectedEnvironment({}, 'production'), /Unsupported/);
});

test('full provision creates each missing database once and resolves config on retry', async () => {
  const { mkdtemp, mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { resolve, join } = await import('node:path');
  const { provision } = await import('../provision-platform.mjs');
  const originalCwd = process.cwd();
  await mkdir(resolve(originalCwd, '.temp'), { recursive: true });
  const directory = await mkdtemp(resolve(originalCwd, '.temp/platform-provision-'));
  const originalFetch = globalThis.fetch;
  const state = [];
  let creates = 0;
  globalThis.fetch = async (url, init = {}) => {
    assert.match(String(url), /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/test-account\/d1\/database/);
    assert.equal(init.headers.Authorization, 'Bearer fake-test-token');
    if (init.method === 'POST') {
      const { name } = JSON.parse(init.body);
      creates += 1;
      state.push({ name, uuid: creates === 1 ? uuid : 'abcdefab-1234-1234-1234-123456789abc' });
    }
    return Response.json({ success: true, result: state });
  };
  try {
    process.chdir(directory);
    for (const unit of ['notifications', 'decisions']) {
      await writeFile(join(directory, `wrangler.${unit}.jsonc`), JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: `moesegfault-${unit}-staging`, database_id: '' }],
      }));
    }
    const environment = { CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'fake-test-token' };
    await provision('staging', environment);
    assert.equal(creates, 2);
    await provision('staging', environment);
    assert.equal(creates, 2, 'retry must reuse existing databases');
    const config = JSON.parse(await readFile('wrangler.notifications.jsonc', 'utf8'));
    assert.equal(config.d1_databases[0].database_id, uuid);
    config.d1_databases[0].database_id = '11111111-1234-1234-1234-123456789abc';
    await writeFile('wrangler.notifications.jsonc', JSON.stringify(config));
    await assert.rejects(provision('staging', environment), /Pinned database mismatch/);
    assert.equal(creates, 2, 'mismatch must never replace persistent data');
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
  }
});
