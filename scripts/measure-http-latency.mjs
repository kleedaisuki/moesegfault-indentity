/**
 * Measure anonymous, cold-connection HTTP latency without changing remote state.
 * No cookies, credentials, response bodies, or proxy URLs are included in the report.
 * curl honors the current proxy configuration; --direct bypasses explicit proxies only.
 * This is not a browser benchmark or an authenticated service latency measurement.
 *
 * @example
 * node scripts/measure-http-latency.mjs production --samples=3
 * node scripts/measure-http-latency.mjs staging --direct --samples=3
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const marker = "\nMOE_HTTP_METRICS:";
const fields = ["status", "dns", "connect", "tls", "ready", "ttfb", "total", "bytes", "protocol"];
const format = marker + "%{http_code}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_pretransfer}|%{time_starttransfer}|%{time_total}|%{size_download}|%{http_version}";
const safeHeaders = new Set(["cache-control", "cf-cache-status", "cf-ray", "content-encoding", "server-timing"]);

/** Validate the bounded CLI before any network requests are issued. */
export function parseArguments(args) {
  let environment = "production";
  let direct = false;
  let samples = 1;
  let targetSeen = false;
  for (const arg of args) {
    if (["production", "staging"].includes(arg) && !targetSeen) {
      environment = arg;
      targetSeen = true;
    } else if (arg === "--direct") {
      direct = true;
    } else if (/^--samples=[1-5]$/.test(arg)) {
      samples = Number(arg.slice(10));
    } else {
      throw new Error("Usage: node scripts/measure-http-latency.mjs [production|staging] [--direct] [--samples=1..5]");
    }
  }
  return { environment, direct, samples };
}

/** Extract final-response diagnostic headers and metrics, never the body or Set-Cookie. */
export function parseCurlOutput(output) {
  const split = output.lastIndexOf(marker);
  if (split < 0) throw new Error("curl returned no timing record");
  const values = output.slice(split + marker.length).trim().split("|");
  if (values.length !== fields.length) throw new Error("Invalid curl timing record");
  const numbers = values.slice(0, -1).map(Number);
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid curl timing value");
  const metrics = Object.fromEntries(fields.map((field, index) => [field, index === 8 ? values[index] : numbers[index]]));
  const blocks = output.slice(0, split).split(/\r?\n\r?\n/);
  let headers = {};
  for (const block of blocks) {
    if (!/^HTTP\/\S+ \d{3}/.test(block)) continue;
    headers = {};
    for (const line of block.split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim().toLowerCase();
      if (colon > 0 && safeHeaders.has(name)) headers[name] = line.slice(colon + 1).trim();
    }
  }
  return { ...metrics, headers };
}

/** Build fixed GET-only endpoints; the 401 is the expected anonymous /v1/me contract. */
export function endpoints(environment) {
  const suffix = environment === "staging" ? "-staging" : "";
  const origin = (service) => `https://${service}${suffix}.moesegfault.dev`;
  return [
    { url: `${origin("login")}/`, expectedStatus: 200 },
    { url: `${origin("account")}/`, expectedStatus: 200 },
    ...["/.well-known/openid-configuration", "/healthz", "/v1/meta/capabilities", "/v1/registration-policy"].map((path) => ({ url: origin("identity") + path, expectedStatus: 200 })),
    { url: `${origin("identity")}/v1/me`, expectedStatus: 401 },
  ];
}

/** Summarize successful samples only and retain failure counts, not misleading percentiles. */
export function summarize(records) {
  return [...new Set(records.map((record) => record.url))].map((url) => {
    const all = records.filter((record) => record.url === url);
    const good = all.filter((record) => record.ok);
    const times = good.map((record) => record.total * 1000).sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    const median = times.length ? (times[middle] + times[Math.floor((times.length - 1) / 2)]) / 2 : null;
    return { url, successes: good.length, failures: all.length - good.length, median_ms: median === null ? null : Math.round(median), min_ms: times.length ? Math.round(times[0]) : null, max_ms: times.length ? Math.round(times.at(-1)) : null };
  });
}

/** Perform at most 35 sequential anonymous requests with bounded transfer and no retries. */
export async function measure(options) {
  const records = [];
  for (let sample = 1; sample <= options.samples; sample += 1) {
    for (const endpoint of endpoints(options.environment)) {
      const args = ["-q", "--silent", "--show-error", "--compressed", "--connect-timeout", "5", "--max-time", "12", "--max-filesize", "1048576", "--dump-header", "-", "--output", process.platform === "win32" ? "NUL" : "/dev/null", "--write-out", format];
      if (options.direct) args.push("--noproxy", "*");
      const result = spawnSync(process.platform === "win32" ? "curl.exe" : "curl", [...args, endpoint.url], { encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true });
      const record = { sample, url: endpoint.url, expectedStatus: endpoint.expectedStatus, exitCode: result.status, ok: false };
      try {
        Object.assign(record, parseCurlOutput(result.stdout ?? ""));
        record.ok = result.status === 0 && record.status === endpoint.expectedStatus;
      } catch {
        record.error = "No valid curl timing record; check curl availability and network connectivity";
      }
      records.push(record);
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  return records;
}

/** Print only sanitized JSON and fail on transport errors or unexpected endpoint status. */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const records = await measure(options);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...options, connection: "fresh curl process per request; explicit proxy bypass does not bypass VPN/TUN", records, summary: summarize(records) }, null, 2));
  if (records.some((record) => !record.ok)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
