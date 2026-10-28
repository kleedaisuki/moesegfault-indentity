import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdirSync, readFileSync, readdirSync} from "node:fs";
import {createServer} from "node:https";
import {join, resolve} from "node:path";
import {Miniflare, convertV4MiniflareOptions} from "miniflare";
import {chromium} from "playwright";

const root = resolve(import.meta.dirname, "../..");

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\/d\/[A-Za-z0-9_-]{43}/g, "/d/[capability]")
    .replace(/\b[A-Za-z0-9_-]{43,}\b/g, "[token]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[recipient]").slice(0, 1200);
}

function category(url) {
  try {
    const pathname = new URL(url).pathname;
    if (/^\/d\/[A-Za-z0-9_-]{43}\/submit$/.test(pathname)) return "decision-submit";
    if (/^\/d\/[A-Za-z0-9_-]{43}$/.test(pathname)) return "decision-page";
    return pathname === "/favicon.ico" ? "favicon" : "other";
  } catch { return "invalid-url"; }
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  assert.fail(message);
}

async function migrate(db) {
  const folder = join(root, "migrations/decisions");
  for (const file of readdirSync(folder).filter(name => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(folder, file), "utf8").split("\n")
      .map(line => line.replace(/--.*$/, "").trim()).filter(Boolean).join(" ");
    await db.exec(sql);
  }
}

async function createFixture(state) {
  const certificates = join(state, "native-https");
  mkdirSync(certificates, {recursive: true});
  const keyPath = join(certificates, "key.pem");
  const certPath = join(certificates, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath], {stdio: "pipe"});
  const callbacks = [];
  const observations = [];
  const failures = [];
  let publicWorker;
  let origin;
  let legacyPath = null;
  const server = createServer({key: readFileSync(keyPath), cert: readFileSync(certPath)}, async (request, response) => {
    const method = request.method ?? "GET";
    const url = `${origin}${request.url ?? "/"}`;
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      // Real TLS preserves Chromium's wire headers and redirect chain;
      // interception cannot model automatic 303 navigation faithfully.
      const upstream = await publicWorker.fetch(url, {method, headers, redirect: "manual",
        ...(["GET", "HEAD"].includes(method) ? {} : {body: Buffer.concat(chunks)})});
      const responseHeaders = Object.fromEntries(upstream.headers.entries());
      if (method === "GET" && new URL(url).pathname === legacyPath) responseHeaders["referrer-policy"] = "no-referrer";
      observations.push({method, pathname: new URL(url).pathname, headers, status: upstream.status,
        policy: responseHeaders["referrer-policy"], location: responseHeaders.location,
        problem: upstream.headers.get("content-type")?.includes("application/problem+json") ? await upstream.clone().json() : null});
      for (const [name, value] of Object.entries(responseHeaders)) response.setHeader(name, value);
      const cookies = upstream.headers.getSetCookie?.();
      if (cookies?.length) response.setHeader("set-cookie", cookies);
      response.writeHead(upstream.status);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      failures.push(error);
      console.error(JSON.stringify({event: "native_https_bridge_error", method, route: category(url), message: safeMessage(error)}));
      if (!response.headersSent) response.writeHead(503, {"content-type": "text/plain"});
      response.end("Native test bridge unavailable");
    }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert.ok(address && typeof address === "object", "Native HTTPS endpoint must bind a loopback port");
  origin = `https://127.0.0.1:${address.port}`;
  const control = `import {WorkerEntrypoint} from 'cloudflare:workers';
    export class CallbackCapture extends WorkerEntrypoint {async fetch(request){await this.env.CALLBACK_SINK.fetch(request.clone());return this.env.RECEIVER.fetch(request)}}
    export default {fetch(request,env){return env.DAPI.fetch(request)}};`;
  let mf;
  try {
    mf = new Miniflare(convertV4MiniflareOptions({persist: join(state, "native-mf"), workers: [
      {name: "native-control", modules: true, script: control, compatibilityDate: "2026-10-01", serviceBindings: {
        DAPI: {name: "native-decisions", entrypoint: "DecisionsApi"},
        RECEIVER: {name: "native-receiver", entrypoint: "CallbackReceiver"},
        CALLBACK_SINK: async request => {
          callbacks.push({value: await request.json(), key: request.headers.get("idempotency-key"), event: request.headers.get("x-moesegfault-event-id")});
          return new Response(null, {status: 204});
        },
      }},
      {name: "native-decisions", modules: true, scriptPath: join(state, "decisions.mjs"), compatibilityDate: "2026-10-01",
        bindings: {ENVIRONMENT: "staging", PUBLIC_ORIGIN: origin, OUTBOX_KEY: Buffer.alloc(32, 4).toString("base64url"),
          CALLBACK_SERVICES: JSON.stringify({journey: {binding: "CALLBACK_JOURNEY", paths: ["/v1/results"]}})},
        d1Databases: {DB: "native-decisions"}, serviceBindings: {
          NOTIFICATIONS: async () => Response.json({message_id: randomUUID(), state: "queued"}, {status: 202}),
          CALLBACK_JOURNEY: {name: "native-control", entrypoint: "CallbackCapture"},
        }},
      {name: "native-receiver", modules: true, scriptPath: join(state, "journey-fixture.mjs"), compatibilityDate: "2026-10-01",
        d1Databases: {DB: "native-decisions"}},
    ]}));
    publicWorker = await mf.getWorker("native-decisions");
    const controlWorker = await mf.getWorker("native-control");
    const ddb = await mf.getD1Database("DB", "native-decisions");
    await migrate(ddb);
    return {origin, ddb, callbacks, observations, failures,
      setLegacyPath(path) { legacyPath = path; },
      async post(value) {
        return controlWorker.fetch(`${origin}/v1/decisions`, {method: "POST", headers: {"content-type": "application/json", "idempotency-key": `native-${randomUUID()}`}, body: JSON.stringify(value)});
      },
      async close() {
        server.closeAllConnections();
        try {
          await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
        } finally { await mf.dispose(); }
      },
    };
  } catch (error) {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    if (mf) await mf.dispose();
    throw error;
  }
}

async function runCase(browser, fixture, decision, mode) {
  const {origin, ddb, callbacks, observations, failures} = fixture;
  const response = await fixture.post({...decision, title: "Native form confirmation", locale: "en",
    expires_at: Math.floor(Date.now() / 1000) + 600,
    context: {...decision.context, test_run: `native-${mode}-${randomUUID()}`}});
  assert.equal(response.status, 202, "Native decision fixture creation must be accepted");
  const accepted = await response.json();
  assert.ok(new URL(accepted.url).origin === origin, "Native decision must use the real HTTPS test origin");
  const path = new URL(accepted.url).pathname;
  fixture.setLegacyPath(mode === "legacy-no-referrer" ? path : null);
  const context = await browser.newContext({serviceWorkers: "block", ignoreHTTPSErrors: true});
  const page = await context.newPage();
  const browserFailures = [];
  page.on("requestfailed", request => browserFailures.push({method: request.method(), route: category(request.url()), error: safeMessage(request.failure()?.errorText)}));
  try {
    const initial = await page.goto(accepted.url, {waitUntil: "domcontentloaded"});
    assert.equal(initial?.status(), 200, "Native browser must load the actual decision HTML over TLS");
    const firstGet = observations.find(item => item.method === "GET" && item.pathname === path);
    assert.equal(firstGet?.policy, mode === "legacy-no-referrer" ? "no-referrer" : "strict-origin");
    assert.ok((await context.cookies(origin)).some(cookie => cookie.name.startsWith("__Host-decision-")
      && cookie.secure && cookie.httpOnly && cookie.sameSite === "Strict" && cookie.path === "/"),
    "Chromium must store the actual secure HTTP-only CSRF cookie");
    await page.getByRole("radio", {name: "Approve", exact: true}).check();
    await page.getByRole("textbox", {name: "Your reply", exact: true}).fill("staging-ok");
    assert.equal(await ddb.prepare("SELECT COUNT(*) FROM decision_submissions WHERE decision_id=?").bind(accepted.decision_id).first("COUNT(*)"), 0,
      "Choosing and typing must not submit a decision");
    const [submitted] = await Promise.all([
      page.waitForResponse(item => item.request().method() === "POST" && new URL(item.url()).pathname === `${path}/submit`),
      page.getByRole("button", {name: "Confirm and submit", exact: true}).click(),
    ]);
    await submitted.finished();
    const submission = observations.find(item => item.method === "POST" && item.pathname === `${path}/submit`);
    assert.ok(submission, "Explicit confirmation must issue a native POST");
    console.log(JSON.stringify({event: "native_decision_form", mode, status: submission.status, origin: submission.headers.origin ?? null,
      referer_present: Boolean(submission.headers.referer), referer_path_present: submission.headers.referer ? new URL(submission.headers.referer).pathname !== "/" : false}));
    assert.equal(failures.length, 0, "The real HTTPS-to-Worker bridge must not fail");
    if (mode === "legacy-no-referrer") {
      assert.equal(submission.headers.origin, "null", "Legacy policy must reproduce Chromium's opaque form Origin");
      assert.equal(submitted.status(), 403);
      assert.equal(submission.problem?.code, "origin_rejected");
      assert.equal(await ddb.prepare("SELECT COUNT(*) FROM decision_submissions WHERE decision_id=?").bind(accepted.decision_id).first("COUNT(*)"), 0);
      assert.equal(await ddb.prepare("SELECT state FROM decisions WHERE decision_id=?").bind(accepted.decision_id).first("state"), "pending");
      assert.ok(!callbacks.some(callback => callback.value.decision_id === accepted.decision_id), "Rejected native POST must not dispatch a callback");
      return;
    }
    assert.equal(submission.headers.origin, origin);
    assert.equal(submission.headers.referer, `${origin}/`, "Native POST must not expose its capability path in Referer");
    assert.ok(submission.headers.cookie?.includes("__Host-decision-"), "Native POST must carry Chromium's stored CSRF cookie");
    assert.equal(submitted.status(), 303, "Successful confirmation must use POST/Redirect/GET");
    assert.ok(submission.location === path, "Completion must redirect to this same decision");
    await page.getByRole("heading", {name: "Response submitted", exact: true}).waitFor();
    assert.ok(new URL(page.url()).origin === origin && new URL(page.url()).pathname === path,
      "Chromium must automatically follow the real HTTP 303 completion redirect");
    assert.ok(observations.filter(item => item.method === "GET" && item.pathname === path && item.status === 200).length >= 2,
      "The TLS server must observe the native automatic completion GET");
    assert.equal(await ddb.prepare("SELECT COUNT(*) FROM decision_submissions WHERE decision_id=?").bind(accepted.decision_id).first("COUNT(*)"), 1);
    await eventually(() => callbacks.some(callback => callback.value.decision_id === accepted.decision_id), "Native confirmation did not reach the registered receiver");
    const received = callbacks.filter(callback => callback.value.decision_id === accepted.decision_id);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].value.response, {choice: "approve", fields: {note: "staging-ok"}});
    assert.equal(received[0].key, received[0].value.event_id);
    assert.equal(received[0].event, received[0].value.event_id);
    await eventually(async () => Boolean(await ddb.prepare("SELECT 1 FROM platform_journey_callbacks WHERE decision_id=? AND response_valid=1")
      .bind(accepted.decision_id).first()), "Registered receiver did not persist the validated native response");
  } catch (error) {
    console.error(JSON.stringify({event: "native_form_failure", mode, final_origin: (() => { try { return new URL(page.url()).origin; } catch { return null; } })(),
      final_route: category(page.url()), title: (await page.title().catch(() => "unavailable")).slice(0, 100),
      requests: observations.filter(item => item.pathname === path || item.pathname === `${path}/submit`)
        .map(item => ({method: item.method, status: item.status, route: category(`${origin}${item.pathname}`)})),
      browser_failures: browserFailures, message: safeMessage(error)}));
    throw error;
  } finally {
    await context.close();
  }
}

export async function runNativeFormJourney({state, decision}) {
  let fixture;
  let browser;
  try {
    fixture = await createFixture(state);
    browser = await chromium.launch({headless: true});
    await runCase(browser, fixture, decision, "legacy-no-referrer");
    await runCase(browser, fixture, decision, "strict-origin");
    console.log("PASS: real HTTPS Chromium native forms reproduce Origin:null rejection and verify strict-origin, secure cookies, explicit submit, automatic 303 completion GET and registered callback.");
  } catch (error) {
    throw new Error(safeMessage(error));
  } finally {
    try { if (browser) await browser.close(); }
    finally { if (fixture) await fixture.close(); }
  }
}
