import { readFile } from 'node:fs/promises';
import { selectedEnvironment } from './provision-platform.mjs';

const target = process.argv[2];
if (!['staging', 'production'].includes(target)) throw new Error('Usage: node scripts/reconcile-platform-domains.mjs <staging|production>');
const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ZONE_ID: zone } = process.env;
if (!account || !token || !zone) throw new Error('Platform domains require CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID from the deployment environment');
for (const unit of ['notifications', 'decisions']) {
  const config = selectedEnvironment(JSON.parse(await readFile(`wrangler.${unit}.jsonc`, 'utf8')), target);
  const hostname = `${unit}${target === 'staging' ? '-staging' : ''}.moesegfault.dev`;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/domains`, {
    method: 'PUT',
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostname, service: config.name, zone_id: zone, zone_name: 'moesegfault.dev' }),
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new Error(`Custom domain ${hostname}: HTTP ${response.status}, non-JSON provider response`); }
  if (!response.ok || body.success !== true) throw new Error(`Custom domain ${hostname}: HTTP ${response.status}; requires Workers Scripts Write for this account and correct zone. ${JSON.stringify(body.errors ?? [])}`);
  console.log(JSON.stringify({ event: 'platform_domain_reconciled', environment: target, hostname, service: config.name }));
}
