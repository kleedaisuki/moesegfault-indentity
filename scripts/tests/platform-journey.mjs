import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, readdirSync} from "node:fs";
import {resolve, join} from "node:path";
import {randomBytes, randomUUID} from "node:crypto";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {Miniflare, convertV4MiniflareOptions} from "miniflare";
import {waitFixtureReady} from "../lib/platform-journey-http.mjs";

const root = resolve(import.meta.dirname, "../..");
const temp = resolve(root, ".temp/platform-journey-tests");
mkdirSync(temp, {recursive: true});
const state = mkdtempSync(join(temp, "worker-"));
const now = () => Math.floor(Date.now() / 1000);
const emails = [];
const callbacks = [];
let emailStatus = 200;
let callbackStatus = 204;

for (const service of ["notifications", "decisions"]) {
  const className = service === "notifications" ? "NotificationsApi" : "DecisionsApi";
  const operation = service === "notifications" ? "drain" : "maintain";
  const source = `import {WorkerEntrypoint} from 'cloudflare:workers';
    import {${operation},deliver} from './apps/${service}/src/outbox.ts';
    export {default,${className}} from './apps/${service}/src/index.ts';
    export class TestAdmin extends WorkerEntrypoint {async fetch(request){if(new URL(request.url).pathname==='/deliver'){const cached=await request.json();await deliver(this.env,cached.outbox_id)}else await ${operation}(this.env);return new Response('ok')}}`;
  await build({stdin: {contents: source, resolveDir: root, sourcefile: `${service}-test.ts`, loader: "ts"}, bundle: true, format: "esm", platform: "neutral", conditions: ["workerd", "worker", "browser"], external: ["cloudflare:workers"], outfile: join(state, `${service}.mjs`)});
}
await build({entryPoints: [join(root, "apps/platform-journey/src/index.ts")], bundle: true, format: "esm", platform: "neutral", external: ["cloudflare:workers"], outfile: join(state, "journey-fixture.mjs")});
await build({stdin: {contents: "export {encryptJson,decryptJson,keyedDigest,sha256} from './packages/service-platform/src/index.ts'; export {decisionSchema} from './apps/decisions/src/model.ts';", resolveDir: root, loader: "ts"}, bundle: true, format: "esm", platform: "node", outfile: join(state, "fixture-model.mjs")});
const fixtureModel = await import(pathToFileURL(join(state, "fixture-model.mjs")).href);
const fixture = `import {WorkerEntrypoint} from 'cloudflare:workers';
  export class EmailCapture extends WorkerEntrypoint {async send(message){const response=await this.env.EMAIL_SINK.fetch('https://email-sink.internal',{method:'POST',body:JSON.stringify(message)});if(!response.ok)throw new Error('fixture_provider_'+response.status);return response.json()}}
  export class CallbackCapture extends WorkerEntrypoint {async fetch(request){const response=await this.env.CALLBACK_SINK.fetch(request.clone());if(!response.ok)return response;return this.env.FCALL.fetch(request)}}
  export default {fetch(request,env){const url=new URL(request.url);const [,binding,...parts]=url.pathname.split('/');url.pathname='/'+parts.join('/');return env[binding].fetch(new Request(url,request))}};`;
const mf = new Miniflare(convertV4MiniflareOptions({persist: state, workers: [
  {name: "router", modules: true, script: fixture, compatibilityDate: "2026-10-01", serviceBindings: {
    NAPI: {name: "notifications", entrypoint: "NotificationsApi"}, DAPI: {name: "decisions", entrypoint: "DecisionsApi"},
    NADMIN: {name: "notifications", entrypoint: "TestAdmin"}, DADMIN: {name: "decisions", entrypoint: "TestAdmin"},
    NPUBLIC: "notifications", DPUBLIC: "decisions",
    FIXTURE: "journey-fixture", FCALL: {name: "journey-fixture", entrypoint: "CallbackReceiver"},
    INERT: "inert-receiver", ICALL: {name: "inert-receiver", entrypoint: "CallbackReceiver"},
    EMAIL_SINK: async request => {emails.push(await request.json()); return Response.json({messageId: randomUUID()}, {status: emailStatus});},
    CALLBACK_SINK: async request => {callbacks.push({value: await request.json(), key: request.headers.get("idempotency-key"), event: request.headers.get("x-moesegfault-event-id")}); return new Response(null, {status: callbackStatus});},
  }},
  {name: "notifications", modules: true, scriptPath: join(state, "notifications.mjs"), compatibilityDate: "2026-10-01", bindings: {ENVIRONMENT: "staging", ACCOUNT_ORIGIN: "https://account-staging.moesegfault.dev", OUTBOX_KEY: Buffer.alloc(32, 3).toString("base64url")}, d1Databases: {DB: "notifications"}, serviceBindings: {EMAIL: {name: "router", entrypoint: "EmailCapture"}}},
  {name: "decisions", modules: true, scriptPath: join(state, "decisions.mjs"), compatibilityDate: "2026-10-01", bindings: {ENVIRONMENT: "staging", OUTBOX_KEY: Buffer.alloc(32, 4).toString("base64url"), PUBLIC_ORIGIN: "https://decisions.example.test", CALLBACK_SERVICES: JSON.stringify({journey: {binding: "CALLBACK_JOURNEY", paths: ["/v1/results"]}})}, d1Databases: {DB: "decisions"}, serviceBindings: {NOTIFICATIONS: {name: "notifications", entrypoint: "NotificationsApi"}, CALLBACK_JOURNEY: {name: "router", entrypoint: "CallbackCapture"}}},
  {name: "journey-fixture", modules: true, scriptPath: join(state, "journey-fixture.mjs"), compatibilityDate: "2026-10-01", bindings: {JOURNEY_TOKEN: "a-fixture-only-one-time-token-with-at-least-32-characters"}, d1Databases: {DB: "decisions"}, serviceBindings: {NOTIFICATIONS: {name: "notifications", entrypoint: "NotificationsApi"}, DECISIONS: {name: "decisions", entrypoint: "DecisionsApi"}}},
  {name: "inert-receiver", modules: true, scriptPath: join(state, "journey-fixture.mjs"), compatibilityDate: "2026-10-01", d1Databases: {DB: "decisions"}},
]}));

const ndb = await mf.getD1Database("DB", "notifications");
const ddb = await mf.getD1Database("DB", "decisions");
async function migrate(db, name) {
  for (const file of readdirSync(join(root, "migrations", name)).filter(file => file.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(root, "migrations", name, file), "utf8").split("\n").map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join(" "));
  }
}
const request = (binding, path, init) => mf.dispatchFetch(`https://decisions.example.test/${binding}${path}`, init);
const post = (binding, path, value, key = randomUUID()) => request(binding, path, {method: "POST", headers: {"content-type": "application/json", "idempotency-key": key}, body: JSON.stringify(value)});
async function json(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, `Expected ${status}, received ${response.status}: ${JSON.stringify(value)}`);
  return value;
}
async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 20));
  }
  assert.fail(message);
}
const notification = {service: "identity", sender: "identity", to: "klee@example.test", template: "verification", code: "01234567", expires_at: now() + 600};
const decision = {service: "journey", sender: "accounts", to: "klee@example.test", title: "A choice for Klee", locale: "en", expires_at: now() + 600, choices: [{value: "approve", label: "Approve"}, {value: "reject", label: "Reject"}], fields: [{name: "note", label: "Your reply", type: "text", required: true}], callback: {binding: "CALLBACK_JOURNEY", path: "/v1/results"}, context: {test_run: "isolated-fixture"}};

try {
  await migrate(ndb, "notifications");
  await migrate(ddb, "decisions");
  await waitFixtureReady("https://decisions.example.test/FIXTURE", {authorization: "Bearer a-fixture-only-one-time-token-with-at-least-32-characters"}, {attempts: 1, report: () => {}, fetcher: (url, init) => mf.dispatchFetch(url, {headers: init.headers})});
  await json(await request("NPUBLIC", "/healthz"), 200);
  await json(await request("DPUBLIC", "/healthz"), 200);
  const notificationsLanding = await (await request("NPUBLIC", "/")).text();
  assert.ok(notificationsLanding.includes('href="https://account-staging.moesegfault.dev"'), "Staging notification navigation must stay on the paired staging Account origin");
  assert.ok(!notificationsLanding.includes('href="https://account.moesegfault.dev"'), "Staging must never navigate to production Account");
  await json(await post("NPUBLIC", "/v1/messages", notification), 404);
  await json(await post("DPUBLIC", "/v1/decisions", decision), 404);

  const first = await json(await post("NAPI", "/v1/messages", notification, "verification-first"), 202);
  await eventually(async () => (await ndb.prepare("SELECT state FROM notification_messages WHERE message_id=?").bind(first.message_id).first())?.state === "sent", "Verification email was not sent via named entrypoint");
  const replay = await json(await post("NAPI", "/v1/messages", notification, "verification-first"), 202);
  assert.equal(replay.message_id, first.message_id);
  assert.equal(replay.state, "sent");
  const providerProbe = await request("FIXTURE", `/notifications/${first.message_id}`, {headers: {authorization: "Bearer a-fixture-only-one-time-token-with-at-least-32-characters"}});
  const providerStatus = await json(providerProbe, 200);
  assert.equal(providerStatus.state, "sent", "Staging fixture must forward native provider status without mutating an immutable subrequest response");
  assert.equal(providerProbe.headers.get("cache-control"), "no-store");
  assert.equal(emails.length, 1, "An accepted replay must not send twice");
  assert.equal(emails[0].from.email, "identity@moesegfault.dev");
  assert.ok(emails[0].html.includes("01234567") && emails[0].text.includes("01234567"));
  assert.equal(await ndb.prepare("SELECT payload FROM notification_messages WHERE message_id=?").bind(first.message_id).first("payload"), null);
  await json(await post("NAPI", "/v1/messages", {...notification, code: "87654321"}, "verification-first"), 409);
  const second = await json(await post("NAPI", "/v1/messages", {...notification, service: "security", sender: "security"}), 202);
  await eventually(async () => (await ndb.prepare("SELECT state FROM notification_messages WHERE message_id=?").bind(second.message_id).first())?.state === "sent", "Security sender was not created");
  assert.equal(await ndb.prepare("SELECT COUNT(*) FROM notification_senders").first("COUNT(*)"), 2);
  await json(await post("NAPI", "/v1/messages", {...notification, expires_at: now() - 1}), 422);

  emailStatus = 503;
  const retry = await json(await post("NAPI", "/v1/messages", {...notification, sender: "accounts"}), 202);
  await eventually(async () => (await ndb.prepare("SELECT state,attempt_count FROM notification_messages WHERE message_id=?").bind(retry.message_id).first())?.attempt_count === 1, "Provider failure was not attempted");
  await eventually(async () => (await ndb.prepare("SELECT state FROM notification_messages WHERE message_id=?").bind(retry.message_id).first())?.state === "queued", "Provider failure was not retained for retry");
  const encrypted = await ndb.prepare("SELECT payload FROM notification_messages WHERE message_id=?").bind(retry.message_id).first("payload");
  assert.ok(!encrypted.includes(notification.to) && !encrypted.includes(notification.code));
  emailStatus = 200;
  await ndb.prepare("UPDATE notification_messages SET next_attempt_at=0 WHERE message_id=?").bind(retry.message_id).run();
  await request("NADMIN", "/drain");
  assert.equal(await ndb.prepare("SELECT state FROM notification_messages WHERE message_id=?").bind(retry.message_id).first("state"), "sent");

  const accepted = await json(await post("DAPI", "/v1/decisions", decision, "decision-first"), 202);
  assert.match(accepted.url, /^https:\/\/decisions\.example\.test\/d\/[A-Za-z0-9_-]{43}$/);
  assert.equal((await json(await post("DAPI", "/v1/decisions", decision, "decision-first"), 202)).url, accepted.url);
  await json(await post("DAPI", "/v1/decisions", {...decision, title: "Different"}, "decision-first"), 409);
  await json(await post("DAPI", "/v1/decisions", {...decision, callback: {binding: "CALLBACK_JOURNEY", path: "/unregistered"}}), 403);
  await json(await post("DAPI", "/v1/decisions", {...decision, expires_at: now() + 366 * 86400}), 422);
  await json(await post("DAPI", "/v1/decisions", {...decision, title: "Invalid\nTitle"}), 422);
  const defaultRequest = {...decision};
  delete defaultRequest.expires_at;
  const beforeDefault = now();
  const defaultDecision = await json(await post("DAPI", "/v1/decisions", defaultRequest, "default-seven-days"), 202);
  assert.ok(defaultDecision.expires_at >= beforeDefault + 7 * 86400 && defaultDecision.expires_at <= now() + 7 * 86400);
  await new Promise(done => setTimeout(done, 1100));
  const defaultReplay = await json(await post("DAPI", "/v1/decisions", defaultRequest, "default-seven-days"), 202);
  assert.equal(defaultReplay.expires_at, defaultDecision.expires_at, "An omitted default deadline must be resolved once, not extended by replay");
  assert.equal(defaultReplay.url, defaultDecision.url);
  for (const days of [30, 90, 365]) {
    const deadline = now() + days * 86400;
    const longDecision = await json(await post("DAPI", "/v1/decisions", {...decision, expires_at: deadline}), 202);
    await eventually(() => emails.some(message => message.html.includes(longDecision.url)), `Explicit ${days}-day business deadline did not produce an invitation`);
    const message = emails.find(message => message.html.includes(longDecision.url));
    const displayedDeadline = new Date(deadline * 1000).toISOString().replace("T", " ").replace(/\.000Z$/, " UTC");
    assert.ok(message.text.includes(displayedDeadline), "Email must display the action deadline, not the delivery horizon");
    const notificationExpiry = await ndb.prepare("SELECT expires_at FROM notification_messages WHERE service='journey' AND idempotency_key=?").bind(`decision:${longDecision.decision_id}`).first("expires_at");
    assert.ok(notificationExpiry <= now() + 7 * 86400 && notificationExpiry < deadline, "Long business deadlines must not extend the notification queue horizon");
  }
  const legacyId = randomUUID();
  const legacyToken = randomBytes(32).toString("base64url");
  const legacyInput = fixtureModel.decisionSchema.parse({...decision, expires_at: now() + 600});
  const legacyKey = Buffer.alloc(32, 4).toString("base64url");
  const legacyPayload = await fixtureModel.encryptJson(legacyKey, {input: legacyInput, token: legacyToken}, legacyId);
  const legacyDigest = await fixtureModel.keyedDigest(legacyKey, `decisions-idempotency.v1:${JSON.stringify(legacyInput)}`);
  await ddb.batch([
    ddb.prepare("INSERT INTO decisions(decision_id,service,idempotency_key,request_digest,token_digest,payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(legacyId, "journey", "legacy-before-snapshots", legacyDigest, await fixtureModel.sha256(legacyToken), legacyPayload, now(), legacyInput.expires_at),
    ddb.prepare("INSERT INTO decision_outbox(outbox_id,decision_id,kind,available_at,created_at) VALUES(?,?,'notification',0,?)").bind(randomUUID(), legacyId, now()),
  ]);
  const legacyNotification = {service: legacyInput.service, sender: legacyInput.sender, to: legacyInput.to, template: "decision", locale: legacyInput.locale,
    title: legacyInput.title, body: legacyInput.body, expires_at: legacyInput.expires_at,
    action: {label: "Review and respond", url: `https://decisions.example.test/d/${legacyToken}`}};
  const legacyAccepted = await json(await post("NAPI", "/v1/messages", legacyNotification, `decision:${legacyId}`), 202);
  const legacyReplay = await json(await post("DAPI", "/v1/decisions", legacyInput, "legacy-before-snapshots"), 202);
  assert.equal(legacyReplay.decision_id, legacyId, "Legacy request fingerprints must still replay after optional-deadline rollout");
  await request("DADMIN", "/drain");
  assert.equal(await ddb.prepare("SELECT state FROM decision_outbox WHERE decision_id=? AND kind='notification'").bind(legacyId).first("state"), "delivered", "Legacy accepted invitation JSON must replay without an idempotency conflict");
  assert.equal(await ndb.prepare("SELECT message_id FROM notification_messages WHERE service='journey' AND idempotency_key=?").bind(`decision:${legacyId}`).first("message_id"), legacyAccepted.message_id);
  await eventually(() => emails.some(message => message.html.includes(accepted.url)), "Minimal decision without optional body did not send an email");
  const path = new URL(accepted.url).pathname;
  const page = await request("DPUBLIC", path);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("referrer-policy"), "strict-origin");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.ok(page.headers.get("content-security-policy").includes("form-action 'self'"));
  const content = await page.text();
  assert.ok(content.includes('type="submit"') && !content.includes("<script"));
  const csrf = content.match(/name="csrf" value="([^"]+)"/)[1];
  const cookie = page.headers.get("set-cookie").split(";")[0];
  assert.ok(cookie.startsWith("__Host-decision-"));
  assert.equal(await ddb.prepare("SELECT state FROM decisions WHERE decision_id=?").bind(accepted.decision_id).first("state"), "pending", "GET/link prefetch must never decide");
  assert.equal(callbacks.length, 0);
  const form = new URLSearchParams({csrf, choice: "approve", note: "staging-ok"});
  const submit = (origin, csrfCookie = cookie, body = form) => request("DPUBLIC", `${path}/submit`, {method: "POST", redirect: "manual", headers: {origin, cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded"}, body: body.toString()});
  await json(await submit("https://attacker.example.test"), 403);
  await json(await submit("https://decisions.example.test", ""), 403);
  await json(await submit("https://decisions.example.test", cookie, new URLSearchParams({csrf, choice: "invalid", note: "staging-ok"})), 422);
  callbackStatus = 503;
  const results = await Promise.all([submit("https://decisions.example.test"), submit("https://decisions.example.test")]);
  assert.ok(results.every(response => [200, 303, 410].includes(response.status)));
  assert.equal(await ddb.prepare("SELECT COUNT(*) FROM decision_submissions WHERE decision_id=?").bind(accepted.decision_id).first("COUNT(*)"), 1);
  await eventually(() => callbacks.length === 1, "Submission did not reach registered callback");
  await eventually(async () => (await ddb.prepare("SELECT lease_id FROM decision_outbox WHERE decision_id=? AND kind='callback'").bind(accepted.decision_id).first())?.lease_id === null, "Callback failure lease was not released");
  callbackStatus = 204;
  await ddb.prepare("UPDATE decision_outbox SET available_at=0 WHERE decision_id=? AND kind='callback'").bind(accepted.decision_id).run();
  await request("DADMIN", "/drain");
  assert.equal(callbacks.length, 2);
  assert.equal(callbacks[0].key, callbacks[1].key, "Retried callback must carry the stable consumption event ID");
  assert.equal(callbacks[0].event, callbacks[0].value.event_id);
  assert.deepEqual(callbacks[1].value.response, {choice: "approve", fields: {note: "staging-ok"}});
  assert.deepEqual(callbacks[1].value.context, decision.context);
  const final = await json(await request("DAPI", `/v1/decisions/${accepted.decision_id}`), 200);
  assert.equal(final.state, "submitted");
  assert.ok(final.deliveries.every(job => job.state === "delivered"));
  assert.equal((await request("FIXTURE", `/status/${accepted.decision_id}`)).status, 404, "Staging fixture must not publish status without its one-time credential");
  const fixtureStatus = await json(await request("FIXTURE", `/status/${accepted.decision_id}`, {headers: {authorization: "Bearer a-fixture-only-one-time-token-with-at-least-32-characters"}}), 200);
  assert.equal(fixtureStatus.received, true);
  assert.equal(fixtureStatus.valid, true, "Actual staging CallbackReceiver must persist only the validated callback outcome");
  const cachedJob = await ddb.prepare("SELECT outbox_id,decision_id,kind,attempts FROM decision_outbox WHERE decision_id=? AND kind='callback'").bind(accepted.decision_id).first();
  callbackStatus = 503;
  await ddb.prepare("UPDATE decision_outbox SET state='queued',attempts=11,available_at=0,lease_id='expired-previous-worker',lease_until=? WHERE outbox_id=?").bind(now() - 1, cachedJob.outbox_id).run();
  await post("DADMIN", "/deliver", cachedJob);
  let exhausted = await ddb.prepare("SELECT state,attempts,last_error_code FROM decision_outbox WHERE outbox_id=?").bind(cachedJob.outbox_id).first();
  assert.deepEqual(exhausted, {state: "failed", attempts: 12, last_error_code: "callback_http_503"}, "A stale drain snapshot must use the authoritative twelfth claim for terminal settlement");
  const exhaustedCalls = callbacks.length;
  await post("DADMIN", "/deliver", cachedJob);
  assert.equal(callbacks.length, exhaustedCalls, "A stale snapshot cannot send a thirteenth attempt");
  await ddb.prepare("UPDATE decision_outbox SET state='queued',lease_id='crashed-final-worker',lease_until=? WHERE outbox_id=?").bind(now() + 60, cachedJob.outbox_id).run();
  await request("DADMIN", "/drain");
  assert.equal(await ddb.prepare("SELECT state FROM decision_outbox WHERE outbox_id=?").bind(cachedJob.outbox_id).first("state"), "queued", "An active final-attempt lease must not be reaped early");
  await ddb.prepare("UPDATE decision_outbox SET lease_until=? WHERE outbox_id=?").bind(now() - 1, cachedJob.outbox_id).run();
  await request("DADMIN", "/drain");
  exhausted = await ddb.prepare("SELECT state,attempts,last_error_code FROM decision_outbox WHERE outbox_id=?").bind(cachedJob.outbox_id).first();
  assert.deepEqual(exhausted, {state: "failed", attempts: 12, last_error_code: "attempts_exhausted"}, "A worker dying during its final attempt must become terminal after lease expiry");
  assert.equal(callbacks.length, exhaustedCalls, "Final-lease recovery must never resend beyond the attempt budget");
  const driverAuthorization = {authorization: "Bearer a-fixture-only-one-time-token-with-at-least-32-characters"};
  assert.equal((await post("INERT", "/start", {recipient: "klee@example.test", run_id: "must-not-send"})).status, 404);
  assert.equal((await request("INERT", `/status/${accepted.decision_id}`, {headers: driverAuthorization})).status, 404);
  assert.equal((await request("INERT", `/notifications/${first.message_id}`, {headers: driverAuthorization})).status, 404);
  const lateEvent = {event_id: randomUUID(), decision_id: randomUUID(), type: "decision.submitted", service: "journey", submitted_at: now(),
    response: {choice: "approve", fields: {note: "staging-ok"}}, context: {test_run: "after-driver-cleanup"}};
  const lateHeaders = {"content-type": "application/json", "idempotency-key": lateEvent.event_id, "x-moesegfault-event-id": lateEvent.event_id};
  const lateCallback = value => request("ICALL", "/v1/results", {method: "POST", headers: lateHeaders, body: JSON.stringify(value)});
  assert.equal((await lateCallback(lateEvent)).status, 204, "DB-only private receiver must remain available after public driver cleanup");
  await ddb.prepare("UPDATE platform_journey_callbacks SET created_at=? WHERE event_id=?").bind(now() - 2 * 86400, lateEvent.event_id).run();
  assert.equal((await lateCallback(lateEvent)).status, 204, "An old asynchronous callback receipt must retain idempotency beyond the driver wait budget");
  assert.equal((await lateCallback({...lateEvent, response: {choice: "reject", fields: {note: "changed"}}})).status, 409);
  assert.equal(await ddb.prepare("SELECT COUNT(*) FROM platform_journey_callbacks WHERE event_id=? AND response_valid=1").bind(lateEvent.event_id).first("COUNT(*)"), 1);
  if (process.env.PLATFORM_NATIVE_BROWSER === "1") {
    const {runNativeFormJourney} = await import("./platform-native-form.mjs");
    await runNativeFormJourney({state, decision});
  }
  console.log("PASS: named service capabilities, sender reuse/create, branded mail, encrypted durable retries, explicit form confirmation, CSRF, callback registration, single consumption and idempotent callback recovery.");
} finally {
  await mf.dispose();
}
