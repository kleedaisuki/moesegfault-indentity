import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {readJson, safeSnippet, waitFixtureReady} from "./lib/platform-journey-http.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = resolve(root, ".temp/platform-journey");
mkdirSync(temporary, {recursive: true});

function wrangler(args, input) {
  const executable = "node_modules/wrangler/bin/wrangler.js";
  const result = spawnSync(process.execPath, [executable, ...args], {cwd: root, encoding: "utf8", input, env: {...process.env, WRANGLER_SEND_METRICS: "false"}, maxBuffer: 8 * 1024 * 1024});
  if (result.status !== 0) throw new Error(`Wrangler ${args[0]} ${args[1]} failed: ${(result.stderr || result.stdout).slice(-2000)}`);
  return result.stdout;
}

async function waitInvitation(origin, headers, decisionId) {
  let invitation;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = await readJson(await fetch(`${origin}/status/${decisionId}`, {headers}), "decision invitation acceptance status");
    invitation = status.decision.deliveries?.find(job => job.kind === "notification");
    if (invitation?.state === "failed") throw new Error(`Decision invitation failed before form confirmation: ${JSON.stringify(invitation)}`);
    if (invitation?.state === "delivered") return;
    await new Promise(done => setTimeout(done, 2000));
  }
  throw new Error(`Timed out waiting for decision invitation acceptance before confirmation: ${JSON.stringify(invitation)}`);
}

const recipient = process.env.PLATFORM_JOURNEY_RECIPIENT;
const mode = process.env.PLATFORM_JOURNEY_MODE ?? "http";
assert.ok(["http", "mailbox"].includes(mode), "PLATFORM_JOURNEY_MODE must be http or mailbox");
assert.ok(recipient && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient), "Set PLATFORM_JOURNEY_RECIPIENT in the staging GitHub environment");
console.log(`::add-mask::${recipient}`);
const runId = `${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
const token = randomBytes(32).toString("base64url");
console.log(`::add-mask::${token}`);
const config = JSON.parse(readFileSync(resolve(root, "wrangler.platform-journey.jsonc"), "utf8"));
const databases = JSON.parse(wrangler(["d1", "list", "--json"]));
const database = databases.find(item => item.name === "moesegfault-decisions-staging");
assert.ok(database?.uuid, "Decisions staging D1 must exist before running the journey");
config.main = resolve(root, "apps/platform-journey/src/index.ts");
config.d1_databases[0].database_id = database.uuid;
const configPath = resolve(temporary, "wrangler.json");
writeFileSync(configPath, JSON.stringify(config));
let deployed = false;
try {
  const output = wrangler(["deploy", "--config", configPath]);
  deployed = true;
  const origin = output.match(/https:\/\/moesegfault-platform-journey-staging\.[a-z0-9-]+\.workers\.dev/)?.[0];
  assert.ok(origin, "Wrangler deployment did not return fixture workers.dev URL");
  wrangler(["secret", "put", "JOURNEY_TOKEN", "--config", configPath], token);
  const headers = {authorization: `Bearer ${token}`, "content-type": "application/json"};
  await waitFixtureReady(origin, headers);
  let response;
  try {
    response = await fetch(`${origin}/start`, {method: "POST", headers, body: JSON.stringify({recipient, run_id: runId})});
  } catch (error) {
    throw new Error(`Fixture POST /start failed without an HTTP response; acceptance is unknown and this operation must not be retried. run_id=${runId}; ${safeSnippet(error instanceof Error ? error.message : String(error))}`);
  }
  const accepted = await readJson(response, "fixture POST /start (not retried)", 202);
  console.log(`::add-mask::${accepted.decision_url}`);
  await waitInvitation(origin, headers, accepted.decision_id);
  const summary = mode === "mailbox"
    ? `### Platform journey is waiting for the mailbox recipient\n\nOpen the decision email, select **确认启用**, enter **staging-ok**, and click **确认并提交**.\n\nDecision ID: \`${accepted.decision_id}\`\n`
    : `### Platform HTTP journey\n\nReal staging services, provider acceptance, and HTTP form/callback round trip. This does not verify mailbox receipt or a real browser.\n\nDecision ID: \`${accepted.decision_id}\`\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (mode === "http") {
    const page = await fetch(accepted.decision_url);
    assert.equal(page.status, 200, "Decision page did not open");
    assert.equal(page.headers.get("referrer-policy"), "strict-origin");
    const html = await page.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
    const cookie = page.headers.get("set-cookie")?.split(";")[0];
    assert.ok(csrf && cookie && html.includes('type="submit"'), "Decision confirmation form/CSRF cookie missing");
    const pending = await readJson(await fetch(`${origin}/status/${accepted.decision_id}`, {headers}), "decision status before confirmation");
    assert.equal(pending.decision.state, "pending", "GET must not consume the decision");
    assert.equal(pending.received, false);
    const submitted = await fetch(`${accepted.decision_url}/submit`, {method: "POST", redirect: "manual", headers: {origin: new URL(accepted.decision_url).origin, cookie, "content-type": "application/x-www-form-urlencoded"}, body: new URLSearchParams({csrf, choice: "approve", note: "staging-ok"})});
    assert.equal(submitted.status, 303, "Explicit HTTP confirmation failed");
  }
  console.log(`Decision created: ${accepted.decision_id}. Waiting for ${mode === "mailbox" ? "mailbox/browser confirmation and " : ""}durable callback.`);
  let complete = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise(resolveSleep => setTimeout(resolveSleep, 10_000));
    const statusResponse = await fetch(`${origin}/status/${accepted.decision_id}`, {headers});
    const status = await readJson(statusResponse, "decision callback status poll");
    if (!status.received) continue;
    assert.equal(status.valid, true, "Callback arrived but did not contain the expected explicit choice and form value");
    assert.equal(status.decision.state, "submitted");
    const notification = status.decision.deliveries.find(job => job.kind === "notification");
    const callback = status.decision.deliveries.find(job => job.kind === "callback");
    assert.equal(notification?.state, "delivered", "Decision email was not accepted by notification center");
    if (callback?.state !== "delivered") continue;
    const messageResponse = await fetch(`${origin}/notifications/${accepted.notification.message_id}`, {headers});
    const message = await readJson(messageResponse, "native email provider delivery status");
    assert.notEqual(message.state, "failed", `Native email provider rejected delivery: ${message.last_error_code}`);
    if (message.state !== "sent") continue;
    console.log(mode === "mailbox" ? "PASS: email decision link → explicit browser submission → durable registered-service callback." : "PASS: native email provider acceptance → explicit HTTP form submission → durable registered-service callback (no mailbox/browser claim).");
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**PASS** — ${mode === "http" ? "HTTP confirmation (not mailbox/browser verification)" : "mailbox/browser confirmation"}, native provider acceptance, and registered callback.\n`);
    complete = true;
    break;
  }
  assert.ok(complete, "Timed out waiting for mailbox/browser confirmation and callback delivery");
} finally {
  if (deployed) {
    // Leave only the inert callback entrypoint required by staging's fixed binding.
    wrangler(["secret", "delete", "JOURNEY_TOKEN", "--config", configPath]);
    wrangler(["deploy", "--config", "wrangler.platform-journey-bootstrap.jsonc"]);
  }
}
