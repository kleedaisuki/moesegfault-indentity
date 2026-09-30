/** Offline regression tests for safe HTTP diagnostics; no production requests are made. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { endpoints, parseArguments, parseCurlOutput, summarize } from "../measure-http-latency.mjs";

test("CLI restricts target and request count before touching the network", () => {
  assert.deepEqual(parseArguments([]), { environment: "production", direct: false, samples: 1 });
  assert.deepEqual(parseArguments(["staging", "--direct", "--samples=3"]), { environment: "staging", direct: true, samples: 3 });
  for (const value of ["--samples=0", "--samples=6", "https://evil.example", "--cookie=secret"]) assert.throws(() => parseArguments([value]));
  assert.throws(() => parseArguments(["staging", "production"]));
});

test("parser ignores proxy CONNECT headers and strips secrets", () => {
  const result = parseCurlOutput("HTTP/1.1 200 Connection established\r\nServer-Timing: proxy-secret\r\n\r\nHTTP/2 401\r\nCache-Control: no-store\r\nCF-RAY: example-SIN\r\nSet-Cookie: secret=hidden\r\nAuthorization: secret\r\n\r\n\nMOE_HTTP_METRICS:401|0.01|0.02|0.03|0.04|0.05|0.06|217|2");
  assert.equal(result.status, 401);
  assert.equal(result.total, 0.06);
  assert.deepEqual(result.headers, { "cache-control": "no-store", "cf-ray": "example-SIN" });
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("parser rejects absent, malformed and nonfinite timing records", () => {
  for (const value of ["", "\nMOE_HTTP_METRICS:200", "\nMOE_HTTP_METRICS:200|0|0|0|0|NaN|1|2|1.1"]) assert.throws(() => parseCurlOutput(value));
});

test("endpoint list is anonymous and expects 401 for account authority", () => {
  assert.equal(endpoints("production").length, 7);
  assert.equal(endpoints("production").at(-1).expectedStatus, 401);
  assert.ok(endpoints("staging").every(({ url }) => new URL(url).hostname.endsWith("-staging.moesegfault.dev")));
});

test("summary excludes failures from timings but never hides them", () => {
  assert.deepEqual(summarize([{ url: "a", ok: true, total: 0.1 }, { url: "a", ok: false, total: 12 }, { url: "a", ok: true, total: 0.3 }, { url: "b", ok: false }]), [
    { url: "a", successes: 2, failures: 1, median_ms: 200, min_ms: 100, max_ms: 300 },
    { url: "b", successes: 0, failures: 1, median_ms: null, min_ms: null, max_ms: null },
  ]);
});
