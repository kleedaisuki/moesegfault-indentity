import assert from "node:assert/strict";
import {test} from "node:test";
import {readJson, safeSnippet, waitFixtureReady} from "../lib/platform-journey-http.mjs";

test("readiness retries read-only authentication propagation without creating messages", async () => {
  const requests = [];
  const responses = [new Response(null, {status: 404, headers: {"cf-ray": "fixture-ray"}}), Response.json({error: "fixture_not_bound"}, {status: 503}), Response.json({received: false, valid: false, decision: {status: 404}})];
  await waitFixtureReady("https://fixture.test", {authorization: "Bearer controlled-fixture-secret"}, {attempts: 3, intervalMs: 0, report: () => {}, fetcher: async (url, init) => {
    requests.push({url, init});
    return responses.shift();
  }});
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.url.endsWith("/status/00000000-0000-0000-0000-000000000000") && !request.init.method));
});

test("readiness failure identifies status and never attempts POST", async () => {
  await assert.rejects(waitFixtureReady("https://fixture.test", {}, {attempts: 2, intervalMs: 0, report: () => {}, fetcher: async () => new Response(null, {status: 404, headers: {"cf-ray": "propagation-ray"}})}), error => {
    assert.match(error.message, /No POST \/start was attempted/);
    assert.match(error.message, /"status":404/);
    assert.match(error.message, /propagation-ray/);
    assert.match(error.message, /\[empty\]/);
    return true;
  });
});

test("response failures retain useful bounded diagnostics without recipient or capability", async () => {
  const capability = "a".repeat(43);
  await assert.rejects(readJson(new Response(`<html>recipient user@example.com /d/${capability} proxy error</html>`, {status: 502, headers: {"content-type": "text/html", "cf-ray": "upstream-ray"}}), "notification acceptance", 202), error => {
    assert.match(error.message, /notification acceptance/);
    assert.match(error.message, /"status":502/);
    assert.match(error.message, /text\/html/);
    assert.match(error.message, /upstream-ray/);
    assert.ok(!error.message.includes(capability) && !error.message.includes("user@example.com"));
    return true;
  });
  await assert.rejects(readJson(new Response("", {headers: {"content-type": "application/json"}}), "status poll"), /Malformed JSON response/);
  assert.ok(safeSnippet("x".repeat(1000)).length <= 320);
});

test("native provider rejections remain distinguishable from fixture propagation", async () => {
  const value = await readJson(Response.json({state: "failed", last_error_code: "E_RECIPIENT_NOT_ALLOWED"}), "native provider status");
  assert.equal(value.last_error_code, "E_RECIPIENT_NOT_ALLOWED");
});
