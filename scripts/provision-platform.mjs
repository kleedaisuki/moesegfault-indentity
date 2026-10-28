import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const units = ['notifications', 'decisions'];

export function selectedEnvironment(config, target) {
  if (target === 'staging') return config;
  if (target === 'production' && config.env?.production) return config.env.production;
  throw new Error(`Unsupported or unconfigured platform environment: ${target}`);
}

export function resolveDatabase(binding, databases, target) {
  const expectedName = `moesegfault-${binding.unit}-${target}`;
  if (binding.database_name !== expectedName) throw new Error(`Refusing unexpected database name: ${binding.database_name}`);
  const matches = databases.filter((database) => database.name === expectedName);
  if (matches.length !== 1) throw new Error(`Expected exactly one database named ${expectedName}, found ${matches.length}`);
  const id = matches[0].uuid;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error(`Invalid database UUID for ${expectedName}`);
  if (binding.database_id && binding.database_id !== id) throw new Error(`Pinned database mismatch for ${expectedName}: expected ${binding.database_id}, received ${id}`);
  return id;
}

async function cloudflare(account, token, path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    signal: AbortSignal.timeout(30000),
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new Error(`Cloudflare ${init.method ?? 'GET'} ${path}: HTTP ${response.status}, non-JSON provider response`); }
  if (!response.ok || body.success !== true) {
    const errors = (body.errors ?? []).map(({ code, message }) => ({ code, message }));
    throw new Error(`Cloudflare ${init.method ?? 'GET'} ${path}: HTTP ${response.status} ${JSON.stringify(errors)}`);
  }
  return body;
}

async function listDatabases(account, token) {
  const databases = [];
  for (let page = 1; ; page += 1) {
    const body = await cloudflare(account, token, `/d1/database?per_page=100&page=${page}`);
    databases.push(...body.result);
    if (body.result.length < 100) return databases;
  }
}

export async function provision(target, environment = process.env) {
  if (!['staging', 'production'].includes(target)) throw new Error('Usage: node scripts/provision-platform.mjs <staging|production>');
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = environment;
  if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
  let databases = await listDatabases(account, token);
  for (const unit of units) {
    const path = `wrangler.${unit}.jsonc`;
    const config = JSON.parse(await readFile(path, 'utf8'));
    const selected = selectedEnvironment(config, target);
    if (selected.d1_databases?.length !== 1 || selected.d1_databases[0].binding !== 'DB') {
      throw new Error(`Expected one dedicated DB binding in ${path} for ${target}`);
    }
    for (const binding of selected.d1_databases) {
      const expectedName = `moesegfault-${unit}-${target}`;
      if (binding.database_name !== expectedName) throw new Error(`Refusing unexpected database name: ${binding.database_name}`);
      if (!databases.some((database) => database.name === binding.database_name)) {
        if (binding.database_id) throw new Error(`Pinned database ${binding.database_name} does not exist; refusing replacement`);
        await cloudflare(account, token, '/d1/database', { method: 'POST', body: JSON.stringify({ name: expectedName, primary_location_hint: 'apac' }) });
        databases = await listDatabases(account, token);
      }
      binding.database_id = resolveDatabase({ ...binding, unit }, databases, target);
      console.log(JSON.stringify({ event: 'platform_database_resolved', environment: target, service: unit, database: binding.database_name, database_id: binding.database_id }));
    }
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  provision(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
