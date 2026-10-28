import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  DB?: D1Database;
  NOTIFICATIONS?: Fetcher;
  DECISIONS?: Fetcher;
  JOURNEY_TOKEN?: string;
}

const schema = "CREATE TABLE IF NOT EXISTS platform_journey_callbacks (event_id TEXT PRIMARY KEY,decision_id TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,response_valid INTEGER NOT NULL,created_at INTEGER NOT NULL)";

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), item => item.toString(16).padStart(2, "0")).join("");
}

async function authorized(request: Request, expected?: string): Promise<boolean> {
  if (!expected || expected.length < 32) return false;
  return await digest(request.headers.get("authorization") ?? "") === await digest(`Bearer ${expected}`);
}

async function fetch(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/healthz") return Response.json({status: "ok", service: "platform-journey-staging"});
  if (!await authorized(request, env.JOURNEY_TOKEN)) return new Response(null, {status: 404});
  if (!env.DB || !env.NOTIFICATIONS || !env.DECISIONS) return Response.json({error: "fixture_not_bound"}, {status: 503});
  await env.DB.exec(schema);
  if (request.method === "POST" && path === "/start") {
    const {recipient, run_id} = await request.json<{recipient: string; run_id: string}>();
    if (typeof recipient !== "string" || !recipient.includes("@") || typeof run_id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(run_id)) return Response.json({error: "invalid_fixture_request"}, {status: 422});
    const headers = {"content-type": "application/json", "idempotency-key": `journey-security:${run_id}`};
    const notification = await env.NOTIFICATIONS.fetch("https://notifications.internal/v1/messages", {method: "POST", headers,
      body: JSON.stringify({service: "journey", sender: "security", to: recipient, template: "security", locale: "zh-CN", title: "moeSegFault 通知投递检查", body: "这是一封 staging 通知中心的链路验证邮件。", expires_at: Math.floor(Date.now() / 1000) + 1800})});
    if (notification.status !== 202) return Response.json({error: "notification_rejected", upstream_status: notification.status}, {status: 502});
    const decision = await env.DECISIONS.fetch("https://decisions.internal/v1/decisions", {method: "POST", headers: {...headers, "idempotency-key": `journey-decision:${run_id}`},
      body: JSON.stringify({service: "journey", sender: "accounts", to: recipient, title: "欢迎来到 moeSegFault 决策中心", locale: "zh-CN", expires_at: Math.floor(Date.now() / 1000) + 1800,
        choices: [{value: "approve", label: "确认启用"}, {value: "reject", label: "暂不启用"}], fields: [{name: "note", label: "回复", type: "text", required: true}],
        callback: {binding: "CALLBACK_JOURNEY", path: "/v1/results"}, context: {test_run: run_id}})});
    if (decision.status !== 202) return Response.json({error: "decision_rejected", upstream_status: decision.status}, {status: 502});
    const accepted = await decision.json<{decision_id: string; url: string}>();
    return Response.json({decision_id: accepted.decision_id, decision_url: accepted.url, notification: await notification.json()}, {status: 202});
  }
  const match = /^\/status\/([a-f0-9-]{36})$/.exec(path);
  if (request.method === "GET" && match) {
    const callback = await env.DB.prepare("SELECT response_valid FROM platform_journey_callbacks WHERE decision_id=?").bind(match[1]).first<{response_valid: number}>();
    const status = await env.DECISIONS.fetch(`https://decisions.internal/v1/decisions/${match[1]}`);
    return Response.json({received: Boolean(callback), valid: callback?.response_valid === 1, decision: status.ok ? await status.json() : {status: status.status}});
  }
  const message = /^\/notifications\/([a-f0-9-]{36})$/.exec(path);
  if (request.method === "GET" && message) return env.NOTIFICATIONS.fetch(`https://notifications.internal/v1/messages/${message[1]}`);
  return new Response(null, {status: 404});
}

export class CallbackReceiver extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/results" || !this.env.DB) return new Response(null, {status: 404});
    const raw = await request.text();
    if (raw.length > 65536) return new Response(null, {status: 413});
    const event = JSON.parse(raw) as {event_id: string; decision_id: string; type: string; service: string; response: {choice?: string; fields: Record<string, unknown>}; context: {test_run?: string}};
    if (event.type !== "decision.submitted" || event.service !== "journey" || event.event_id !== request.headers.get("idempotency-key") || event.event_id !== request.headers.get("x-moesegfault-event-id") || !event.context?.test_run) return new Response(null, {status: 422});
    await this.env.DB.exec(schema);
    const hash = await digest(raw);
    const existing = await this.env.DB.prepare("SELECT payload_hash FROM platform_journey_callbacks WHERE event_id=?").bind(event.event_id).first<{payload_hash: string}>();
    if (existing) return new Response(null, {status: existing.payload_hash === hash ? 204 : 409});
    const valid = event.response.choice === "approve" && event.response.fields.note === "staging-ok";
    await this.env.DB.prepare("INSERT INTO platform_journey_callbacks(event_id,decision_id,payload_hash,response_valid,created_at) VALUES(?,?,?,?,?)")
      .bind(event.event_id, event.decision_id, hash, valid ? 1 : 0, Math.floor(Date.now() / 1000)).run();
    await this.env.DB.prepare("DELETE FROM platform_journey_callbacks WHERE created_at<?").bind(Math.floor(Date.now() / 1000) - 86400).run();
    return new Response(null, {status: 204});
  }
}

export default {async fetch(request: Request, env: Env): Promise<Response> {
  try {
    const response = await fetch(request, env);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } catch (error) {
    console.error(JSON.stringify({event: "platform_journey_failed", error_type: error instanceof Error ? error.name : "UnknownError"}));
    return Response.json({error: "fixture_unavailable"}, {status: 503});
  }
}} satisfies ExportedHandler<Env>;
