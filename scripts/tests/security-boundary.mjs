/**
 * Exercise the deployed Worker request boundary against isolated local D1.
 * 使用隔离的本地 D1 验证实际 Worker 请求边界，而非仅验证纯函数。
 *
 * Prerequisites / 前提：npm ci; npm run build:identity.
 * Run / 运行：node scripts/tests/security-boundary.mjs.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const shim = join(root, "crates", "identity-worker", "build", "worker", "shim.mjs");
const wasm = join(root, "crates", "identity-worker", "build", "index_bg.wasm");
const stateRoot = join(root, ".temp");
const loginOrigin = "http://localhost:5173";
const foreignOrigin = "https://attacker.example";
const operation = "authenticateWithPassword";

assert.ok(existsSync(wrangler), "Run npm ci before this test");
assert.ok(existsSync(shim), "Run npm run build:identity before this test");
assert.ok(existsSync(wasm), "Worker WASM artifact is missing");
mkdirSync(stateRoot, { recursive: true });
const state = mkdtempSync(join(stateRoot, "security-boundary-"));

/** Run a bounded Wrangler command against test-only local storage. / 对测试专用本地存储运行有时限的 Wrangler 命令。 */
function runWrangler(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
  });
  assert.equal(result.status, 0, `Wrangler failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}

/** Reserve an ephemeral loopback port. / 分配临时本地端口。 */
async function freePort() {
  const server = createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  return port;
}

/** Read the local D1 count without assuming Wrangler's human-output layout. / 不依赖 Wrangler 人类可读输出格式读取本地 D1 行数。 */
function claimCount(key) {
  const sql = `SELECT COUNT(*) AS n FROM idempotency_records WHERE operation='${operation}' AND idempotency_key='${key}'`;
  const output = runWrangler([
    "d1", "execute", "moesegfault-identity-staging", "--local", `--persist-to=${state}`,
    "--config=wrangler.identity.jsonc", `--command=${sql}`, "--json",
  ]);
  const result = JSON.parse(output);
  return result[0].results[0].n;
}

/** Assert a request's exact boundary outcome and D1 preclaim state. / 断言请求边界结果与 D1 声明状态。 */
async function probe(base, name, headers, cookie, expectedStatus, expectedTitle, expectedClaims) {
  const key = `security-boundary-${name}`;
  const response = await fetch(`${base}/v1/password/authentications`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      cookie,
      ...headers,
    },
    body: '{"malformed":}',
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, `${name}: ${JSON.stringify(body)}`);
  assert.equal(body.title, expectedTitle, name);
  assert.equal(claimCount(key), expectedClaims, `${name}: unexpected preclaim`);
  console.log(`${name}: ${response.status} ${body.title}; claims=${expectedClaims}`);
}

runWrangler([
  "d1", "migrations", "apply", "moesegfault-identity-staging", "--local",
  `--persist-to=${state}`, "--config=wrangler.identity.jsonc",
]);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const worker = spawn(process.execPath, [wrangler, "dev", "--local", "--config=wrangler.identity.jsonc",
  "--ip=127.0.0.1", `--port=${port}`, `--persist-to=${state}`,
  `--var=LOGIN_ORIGIN:${loginOrigin}`, "--var=ACCOUNT_ORIGIN:http://localhost:5174",
  "--var=CSRF_PEPPER:test-only-csrf-pepper", "--var=TRANSACTION_PEPPER:test-only-transaction-pepper",
], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
for (const stream of [worker.stdout, worker.stderr]) {
  stream.on("data", (chunk) => { logs += chunk.toString(); });
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited early: ${logs}`);
    try {
      const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1_000) });
      if (health.ok) { ready = true; break; }
    } catch { /* Worker is still starting. / Worker 仍在启动。 */ }
    await new Promise((ok) => setTimeout(ok, 200));
  }
  assert.ok(ready, `Local Worker did not start within 20s: ${logs}`);
  const context = await fetch(`${base}/v1/browser-context`, { headers: { origin: loginOrigin } });
  assert.equal(context.status, 200, `browser-context returned ${context.status}`);
  const cookie = context.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("__Host-identity_browser="));
  const { csrf_token: token } = await context.json();
  assert.ok(token);
  const valid = { origin: loginOrigin, "x-moesegfault-csrf": token };

  // Malformed JSON distinguishes a passed preclaim + handler from every early 403 rejection.
  // 无效 JSON 可区分已进入 handler 的声明与所有提前 403 拒绝。
  await probe(base, "missing-metadata", valid, cookie, 400, "Invalid JSON request", 1);
  await probe(base, "same-site", { ...valid, "sec-fetch-site": "same-site" }, cookie, 400, "Invalid JSON request", 1);
  await probe(base, "cross-site", { ...valid, "sec-fetch-site": "cross-site" }, cookie, 403, "Invalid browser request context", 0);
  await probe(base, "foreign-origin", { ...valid, origin: foreignOrigin }, cookie, 403, "Origin is not allowed", 0);
  await probe(base, "missing-origin", { "x-moesegfault-csrf": token }, cookie, 403, "Origin is not allowed", 0);
  await probe(base, "invalid-token", { ...valid, "x-moesegfault-csrf": "wrong" }, cookie, 403, "CSRF validation failed", 0);
  await probe(base, "missing-token", { origin: loginOrigin }, cookie, 403, "CSRF validation failed", 0);
} finally {
  worker.kill();
}
