import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {chromium} from "playwright";

const origin = "https://decisions.example.test";

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

function diagnostic(mode, observation) {
  const referer = observation.headers.referer;
  const refererUrl = referer ? new URL(referer) : null;
  console.log(JSON.stringify({event: "native_decision_form", mode, status: observation.status,
    origin: observation.headers.origin ?? null, referer_present: Boolean(referer),
    referer_path_present: Boolean(refererUrl && refererUrl.pathname !== "/")}));
}

async function freshDecision(post, decision, mode) {
  const response = await post("DAPI", "/v1/decisions", {
    ...decision,
    title: "Native form confirmation",
    locale: "en",
    expires_at: Math.floor(Date.now() / 1000) + 600,
    context: {...decision.context, test_run: `native-${mode}-${randomUUID()}`},
  }, `native-${mode}-${randomUUID()}`);
  assert.equal(response.status, 202, "Native form fixture creation must be accepted");
  const accepted = await response.json();
  assert.ok(typeof accepted.url === "string" && new URL(accepted.url).origin === origin,
    "Native form fixture must return its configured HTTPS origin");
  return accepted;
}

async function bridge(context, mf, mode, accepted) {
  const observations = [];
  const failures = [];
  const path = new URL(accepted.url).pathname;
  await context.route(`${origin}/**`, async route => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      const headers = await request.allHeaders();
      const method = request.method();
      const body = request.postDataBuffer();
      // Forward the browser's headers verbatim: fabricating Origin or Cookie
      // would conceal precisely the native-navigation regression this probes.
      const response = await mf.dispatchFetch(`${origin}/DPUBLIC${url.pathname}${url.search}`, {
        method, headers, ...(body === null ? {} : {body}), redirect: "manual",
      });
      const responseHeaders = Object.fromEntries(response.headers.entries());
      if (mode === "legacy-no-referrer" && method === "GET" && url.pathname === path) {
        responseHeaders["referrer-policy"] = "no-referrer";
      }
      const observation = {method, pathname: url.pathname, headers, status: response.status,
        policy: responseHeaders["referrer-policy"],
        location: responseHeaders.location,
        problem: response.headers.get("content-type")?.includes("application/problem+json")
          ? await response.clone().json() : null};
      observations.push(observation);
      await route.fulfill({status: response.status, headers: responseHeaders,
        body: Buffer.from(await response.arrayBuffer())});
    } catch (error) {
      failures.push(error);
      await route.abort("failed");
    }
  });
  return {observations, failures, path};
}

async function fillResponse(page) {
  await page.getByRole("radio", {name: "Approve", exact: true}).check();
  await page.getByRole("textbox", {name: "Your reply", exact: true}).fill("staging-ok");
}

async function runCase(browser, {mf, post, ddb, callbacks, decision}, mode) {
  const accepted = await freshDecision(post, decision, mode);
  const context = await browser.newContext({serviceWorkers: "block"});
  try {
    const {observations, failures, path} = await bridge(context, mf, mode, accepted);
    const page = await context.newPage();
    const initial = await page.goto(accepted.url, {waitUntil: "domcontentloaded"});
    assert.equal(initial?.status(), 200, "Native browser must load the actual decision HTML");
    const firstGet = observations.find(item => item.method === "GET" && item.pathname === path);
    assert.equal(firstGet?.policy, mode === "legacy-no-referrer" ? "no-referrer" : "strict-origin",
      "The fixture must exercise the intended document referrer policy");
    const cookies = await context.cookies(origin);
    assert.ok(cookies.some(cookie => cookie.name.startsWith("__Host-decision-")
      && cookie.secure && cookie.httpOnly && cookie.sameSite === "Strict" && cookie.path === "/"),
    "Chromium must store the real secure HTTP-only CSRF cookie");
    await fillResponse(page);
    assert.equal(await ddb.prepare("SELECT COUNT(*) FROM decision_submissions WHERE decision_id=?")
      .bind(accepted.decision_id).first("COUNT(*)"), 0, "Choosing and typing must not submit a decision");
    const [submitted] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST"
        && new URL(response.url()).pathname === `${path}/submit`),
      page.getByRole("button", {name: "Confirm and submit", exact: true}).click(),
    ]);
    await submitted.finished();
    const submission = observations.find(item => item.method === "POST" && item.pathname === `${path}/submit`);
    assert.ok(submission, "The native form must issue a browser POST");
    diagnostic(mode, submission);
    assert.equal(failures.length, 0, "The browser-to-Worker bridge must not fail");
    if (mode === "legacy-no-referrer") {
      assert.equal(submission.headers.origin, "null", "Legacy policy must reproduce Chromium's opaque form Origin");
      assert.equal(submitted.status(), 403, "The old policy must demonstrate the real origin rejection");
      assert.equal(submission.problem?.code, "origin_rejected");
      assert.equal(await ddb.prepare("SELECT COUNT(*) FROM decision_submissions WHERE decision_id=?")
        .bind(accepted.decision_id).first("COUNT(*)"), 0, "Rejected native POST must not consume the decision");
      assert.equal(await ddb.prepare("SELECT state FROM decisions WHERE decision_id=?")
        .bind(accepted.decision_id).first("state"), "pending");
      assert.ok(!callbacks.some(callback => callback.value.decision_id === accepted.decision_id),
        "Rejected native POST must not dispatch a callback");
      return;
    }
    assert.equal(submission.headers.origin, origin, "Fixed native form must retain its exact origin");
    assert.equal(submission.headers.referer, `${origin}/`, "Native form must send only the origin, never its capability path");
    assert.ok(submission.headers.cookie?.includes("__Host-decision-"), "Native POST must carry the browser's stored CSRF cookie");
    assert.equal(submitted.status(), 303, "Successful explicit confirmation must use POST/Redirect/GET");
    assert.ok(submission.location === path, "Completion redirect must remain on this decision page");
    await page.getByRole("heading", {name: "Response submitted", exact: true}).waitFor();
    assert.ok(new URL(page.url()).origin === origin && new URL(page.url()).pathname === path,
      "Chromium must follow the actual completion redirect to the same decision");
    assert.equal(await ddb.prepare("SELECT COUNT(*) FROM decision_submissions WHERE decision_id=?")
      .bind(accepted.decision_id).first("COUNT(*)"), 1, "Native confirmation must produce exactly one consumption");
    await eventually(() => callbacks.some(callback => callback.value.decision_id === accepted.decision_id),
      "Native confirmation did not reach its registered callback");
    const received = callbacks.filter(callback => callback.value.decision_id === accepted.decision_id);
    assert.equal(received.length, 1, "Native confirmation must dispatch one successful callback");
    assert.deepEqual(received[0].value.response, {choice: "approve", fields: {note: "staging-ok"}});
    assert.equal(received[0].key, received[0].value.event_id);
    await eventually(async () => Boolean(await ddb.prepare("SELECT 1 FROM platform_journey_callbacks WHERE decision_id=? AND response_valid=1")
      .bind(accepted.decision_id).first()), "The registered receiver did not persist the validated native response");
  } finally {
    await context.close();
  }
}

export async function runNativeFormJourney({mf, post, ddb, callbacks, decision}) {
  const browser = await chromium.launch({headless: true});
  try {
    const options = {mf, post, ddb, callbacks, decision};
    await runCase(browser, options, "legacy-no-referrer");
    await runCase(browser, options, "strict-origin");
    console.log("PASS: Chromium native HTML confirmation reproduces the old Origin:null failure and verifies strict-origin, secure cookies, explicit submit, completion redirect and registered callback.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/\/d\/[A-Za-z0-9_-]{43}/g, "/d/[capability]")
      .replace(/\b[A-Za-z0-9_-]{43,}\b/g, "[token]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[recipient]"));
  } finally {
    await browser.close();
  }
}
