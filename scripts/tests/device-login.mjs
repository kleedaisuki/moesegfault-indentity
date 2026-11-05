import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { discover, startDeviceAuthorization, pollDeviceAuthorization, verifyIdToken } from '../device-login.mjs';

const issuer = 'https://identity.example.com';
const client = 'remote-native';
const metadata = {
  issuer, device_authorization_endpoint: `${issuer}/v1/oauth/device-authorizations`,
  token_endpoint: `${issuer}/v1/oauth/token`, jwks_uri: `${issuer}/.well-known/jwks.json`,
  grant_types_supported: ['urn:ietf:params:oauth:grant-type:device_code'],
};
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'signing', alg: 'RS256', use: 'sig' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
function signedToken(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: client, sub: 'pairwise-subject', token_use: 'id', iat: 1000, exp: 1300, ...overrides })).toString('base64url');
  const payload = `${header}.${claims}`;
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
}

test('remote device journey discovers, starts, polls with backoff and verifies the signed identity', async () => {
  let time = 1_000_000;
  let polls = 0;
  const sleeps = [];
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/openid-configuration')) return json(metadata);
    if (url === metadata.device_authorization_endpoint) {
      assert.equal(init.body.get('client_id'), client);
      assert.equal(init.body.get('scope'), 'openid profile');
      return json({ device_code: 'opaque-device', user_code: 'ABCD-EFGH', verification_uri: 'https://login.example.com/device', expires_in: 600, interval: 5 });
    }
    if (url === metadata.jwks_uri) return json({ keys: [jwk] });
    assert.equal(url, metadata.token_endpoint);
    assert.equal(init.body.get('device_code'), 'opaque-device');
    assert.equal(init.body.get('grant_type'), metadata.grant_types_supported[0]);
    polls++;
    if (polls === 1) return json({ error: 'authorization_pending' }, 400);
    if (polls === 2) return json({ error: 'slow_down' }, 400);
    return json({ access_token: 'access', token_type: 'Bearer', id_token: signedToken() });
  };
  const discovered = await discover(issuer, { fetcher });
  const authorization = await startDeviceAuthorization(discovered, client, 'openid profile', { fetcher });
  const tokens = await pollDeviceAuthorization(discovered, client, authorization, {
    fetcher, now: () => time, sleep: async (ms) => { sleeps.push(ms); time += ms; },
  });
  assert.deepEqual(sleeps, [5000, 5000, 10000]);
  const claims = await verifyIdToken(discovered, client, tokens.id_token, { fetcher, now: () => time });
  assert.equal(claims.sub, 'pairwise-subject');
});

test('denial is terminal and local expiry never sends a late poll', async () => {
  let polls = 0;
  const fetcher = async () => { polls++; return json({ error: 'access_denied' }, 400); };
  const authorization = { expires_in: 600, interval: 5, device_code: 'opaque' };
  await assert.rejects(pollDeviceAuthorization(metadata, client, authorization, { fetcher, sleep: async () => {} }), { code: 'access_denied' });
  assert.equal(polls, 1);
  let time = 0;
  await assert.rejects(pollDeviceAuthorization(metadata, client, { ...authorization, expires_in: 4 }, {
    fetcher, now: () => time, sleep: async (ms) => { time += ms; },
  }), /expired/);
  assert.equal(polls, 1);
});

test('timeouts reduce polling frequency without hiding HTTP or protocol failures', async () => {
  let polls = 0;
  const sleeps = [];
  const fetcher = async () => {
    polls++;
    if (polls === 1) throw new DOMException('Timed out', 'TimeoutError');
    return json({ error: 'invalid_client' }, 401);
  };
  await assert.rejects(pollDeviceAuthorization(metadata, client, { expires_in: 600, interval: 5 }, {
    fetcher, sleep: async (ms) => { sleeps.push(ms); },
  }), { code: 'invalid_client' });
  assert.deepEqual(sleeps, [5000, 10000]);
});

test('discovery issuer binding and signed claim checks reject a different login', async () => {
  await assert.rejects(discover(issuer, { fetcher: async () => json({ ...metadata, issuer: 'https://other.example.com' }) }), /issuer/);
  const options = { fetcher: async () => json({ keys: [jwk] }), now: () => 1_000_000 };
  for (const claims of [{ token_use: 'access' }, { token_use: undefined }, { iss: 'https://other.example.com' }, { aud: 'other-client' }, { exp: 999 }, { iat: 1100 }, { sub: '' }]) {
    await assert.rejects(verifyIdToken(metadata, client, signedToken(claims), options), /claims/);
  }
  const token = signedToken();
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ iss: issuer, aud: client, sub: 'attacker', exp: 1300, iat: 1000 })).toString('base64url');
  await assert.rejects(verifyIdToken(metadata, client, parts.join('.'), options), /signature/);
});

test('CLI writes verified tokens privately, refuses overwrite and cleans up a failed login', async () => {
  const { main } = await import('../device-login.mjs');
  const { mkdir, mkdtemp, readFile, stat, access } = await import('node:fs/promises');
  const { resolve, join } = await import('node:path');
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp(resolve('.temp/device-cli-'));
  const destination = join(directory, 'tokens.json');
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stderr.write;
  let messages = '';
  const now = Math.floor(Date.now() / 1000);
  const token = signedToken({ iat: now, exp: now + 300 });
  globalThis.fetch = async (url) => {
    if (url.endsWith('/openid-configuration')) return json(metadata);
    if (url === metadata.device_authorization_endpoint) return json({ device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://login.example.com/device', expires_in: 600, interval: 0 });
    if (url === metadata.token_endpoint) return json({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', id_token: token });
    return json({ keys: [jwk] });
  };
  process.stderr.write = (message) => { messages += message; return true; };
  const args = ['--issuer', issuer, '--client-id', client, '--output', destination];
  try {
    await main(args);
    const saved = JSON.parse(await readFile(destination, 'utf8'));
    assert.equal(saved.subject, 'pairwise-subject');
    assert.equal(saved.refresh_token, 'private-refresh-token');
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.doesNotMatch(messages, /private-device-code|private-access-token|private-refresh-token/);
    await assert.rejects(main(args), { code: 'EEXIST' });
    globalThis.fetch = async () => json({ error: 'invalid_client' }, 401);
    const failedDestination = join(directory, 'failed.json');
    await assert.rejects(main(['--issuer', issuer, '--client-id', client, '--output', failedDestination]), { code: 'invalid_client' });
    await assert.rejects(access(failedDestination), { code: 'ENOENT' });
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalWrite;
  }
});

test('cancelling the browser approval wait leaves no output to block the next login', { timeout: 15_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { mkdir, mkdtemp, writeFile, access } = await import('node:fs/promises');
  const { resolve, join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp(resolve('.temp/device-cancel-'));
  const fixture = join(directory, 'fetch.mjs');
  await writeFile(fixture, `
    const metadata = ${JSON.stringify(metadata)};
    globalThis.fetch = async (url) => new Response(JSON.stringify(
      url.endsWith('/openid-configuration') ? metadata : {
        device_code: 'private-device-code', user_code: 'ABCD-EFGH',
        verification_uri: 'https://login.example.com/device', expires_in: 600, interval: 5,
      }
    ), { status: 200 });
  `);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const output = join(directory, `${signal}.json`);
    const child = spawn(process.execPath, [
      '--import', pathToFileURL(fixture).href, resolve('scripts/device-login.mjs'),
      '--issuer', issuer, '--client-id', client, '--output', output,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      await new Promise((ready, reject) => {
        let messages = '';
        child.on('error', reject);
        child.stderr.on('data', (chunk) => {
          messages += chunk.toString();
          if (messages.includes('Enter code:')) ready();
        });
        child.on('exit', () => reject(new Error('CLI exited before presenting browser approval')));
      });
      child.kill(signal);
      const [, termination] = await exited;
      assert.equal(termination, signal);
      await assert.rejects(access(output), { code: 'ENOENT' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
});
