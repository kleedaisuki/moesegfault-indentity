#!/usr/bin/env node
import { createPublicKey, verify } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code';
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Identity URLs must use HTTPS without credentials or fragments');
  return url.href;
}

async function jsonRequest(fetcher, url, init = {}) {
  const response = await fetcher(httpsUrl(url), {
    ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
  });
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`Identity returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) {
    const error = new Error(`Identity HTTP ${response.status}: ${body.error ?? 'request_failed'}`);
    error.code = body.error;
    error.status = response.status;
    error.correlationId = response.headers.get('x-moesegfault-correlation-id');
    throw error;
  }
  return body;
}

export async function discover(issuer, { fetcher = fetch } = {}) {
  httpsUrl(issuer);
  const metadata = await jsonRequest(fetcher, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (metadata.issuer !== issuer) throw new Error('Discovery issuer does not match configured issuer');
  for (const field of ['device_authorization_endpoint', 'token_endpoint', 'jwks_uri']) httpsUrl(metadata[field]);
  if (!metadata.grant_types_supported?.includes(deviceGrant)) throw new Error('Issuer does not advertise device authorization');
  return metadata;
}

export async function startDeviceAuthorization(metadata, clientId, scope = 'openid', { fetcher = fetch } = {}) {
  const authorization = await jsonRequest(fetcher, metadata.device_authorization_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope }),
  });
  httpsUrl(authorization.verification_uri);
  if (authorization.verification_uri_complete) httpsUrl(authorization.verification_uri_complete);
  return authorization;
}

// RFC 8628 slow_down adds five seconds to every subsequent polling interval.
export async function pollDeviceAuthorization(metadata, clientId, authorization, {
  fetcher = fetch, sleep = pause, now = Date.now, expiresAt = now() + authorization.expires_in * 1000,
} = {}) {
  let interval = (authorization.interval ?? 5) * 1000;
  while (now() < expiresAt) {
    await sleep(interval);
    if (now() >= expiresAt) break;
    try {
      return await jsonRequest(fetcher, metadata.token_endpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: deviceGrant, client_id: clientId, device_code: authorization.device_code }),
      });
    } catch (error) {
      if (error.name === 'TimeoutError') { interval *= 2; continue; }
      if (error.status === 400 && error.code === 'authorization_pending') continue;
      if (error.status === 400 && error.code === 'slow_down') { interval += 5000; continue; }
      throw error;
    }
  }
  throw new Error('Device authorization expired; start a new login');
}

export async function verifyIdToken(metadata, clientId, token, { fetcher = fetch, now = Date.now } = {}) {
  const parts = token?.split('.');
  if (parts?.length !== 3) throw new Error('Missing or malformed ID token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) throw new Error('Unsupported ID token signing header');
  const jwks = await jsonRequest(fetcher, metadata.jwks_uri);
  const keys = jwks.keys.filter((key) => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
  if (keys.length !== 1) throw new Error('ID token signing key is missing or ambiguous');
  const key = createPublicKey({ key: keys[0], format: 'jwk' });
  if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error('ID token signature verification failed');
  const timestamp = Math.floor(now() / 1000);
  if (claims.token_use !== 'id' || claims.iss !== metadata.issuer || claims.aud !== clientId || typeof claims.sub !== 'string' || !claims.sub ||
      !Number.isFinite(claims.exp) || claims.exp <= timestamp || !Number.isFinite(claims.iat) || claims.iat > timestamp + 60 ||
      (claims.azp !== undefined && claims.azp !== clientId)) throw new Error('ID token claims do not match this login');
  return claims;
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    issuer: { type: 'string' }, 'client-id': { type: 'string' }, output: { type: 'string' },
    scope: { type: 'string', default: 'openid' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('Usage: node device-login.mjs --issuer HTTPS_URL --client-id REGISTERED_NATIVE_ID --output NEW_TOKEN_FILE [--scope "openid profile offline_access"]\n');
    return;
  }
  if (!values.issuer || !values['client-id'] || !values.output) throw new Error('--issuer, --client-id and --output are required');
  if (!values.scope.split(/\s+/).includes('openid')) throw new Error('Scope must include openid for verified sign-in');
  const existing = await lstat(values.output).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing) throw Object.assign(new Error('Token output already exists'), { code: 'EEXIST' });
  const metadata = await discover(values.issuer);
  const authorization = await startDeviceAuthorization(metadata, values['client-id'], values.scope);
  const expiresAt = Date.now() + authorization.expires_in * 1000;
  process.stderr.write(`Open ${authorization.verification_uri}\nEnter code: ${authorization.user_code}\nApprove only if the displayed application and code match this login.\n`);
  const tokens = await pollDeviceAuthorization(metadata, values['client-id'], authorization, { expiresAt });
  const claims = await verifyIdToken(metadata, values['client-id'], tokens.id_token);
  // No destination exists during the human interaction, including on process cancellation.
  const file = await open(values.output, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify({ issuer: metadata.issuer, client_id: values['client-id'], subject: claims.sub, received_at: new Date().toISOString(), ...tokens }, null, 2)}\n`);
    process.stderr.write('Login complete. Tokens saved to the requested file.\n');
  } catch (error) {
    await unlink(values.output);
    throw error;
  } finally {
    await file.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}${error.correlationId ? ` (correlation ${error.correlationId})` : ''}\n`);
    process.exitCode = 1;
  });
}
