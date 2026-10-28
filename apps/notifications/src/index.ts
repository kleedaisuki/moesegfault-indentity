import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { correlationId, escapeHtml, json, problem, providerError, secure } from "@moesegfault/service-platform";
import { messageSchema, type NotificationsEnv } from "./message";
import { deliver, drain, enqueue, IdempotencyConflict, InvalidExpiry } from "./outbox";

type AppEnv = { Bindings: NotificationsEnv };
const api = new Hono<AppEnv>();
api.use("/v1/messages", bodyLimit({ maxSize: 32768, onError: () => problem(413, "message_too_large") }));

api.post("/v1/messages", async (context) => {
  const request = context.req.raw;
  const correlation = correlationId(request);
  const key = request.headers.get("Idempotency-Key");
  if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) return problem(400, "invalid_idempotency_key");
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return problem(415, "unsupported_media_type");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).length > 32768) return problem(413, "message_too_large");
  let input: unknown;
  try { input = JSON.parse(body); } catch { return problem(400, "invalid_json"); }
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) return problem(422, "invalid_message", "The message does not match the notification contract.");
  try {
    const row = await enqueue(context.env, parsed.data, key, correlation);
    context.executionCtx.waitUntil(deliver(context.env, row.message_id));
    const response = json({ message_id: row.message_id, state: row.state === "sending" ? "queued" : row.state }, 202);
    response.headers.set("x-moesegfault-correlation-id", correlation);
    return response;
  } catch (error: unknown) {
    if (error instanceof IdempotencyConflict) return problem(409, "idempotency_conflict");
    if (error instanceof InvalidExpiry) return problem(422, "invalid_expiry", "Expiry must be in the next seven days.");
    console.error(JSON.stringify({ event: "notification_enqueue_failed", correlation_id: correlation, ...providerError(error) }));
    return problem(503, "notification_unavailable", "The notification was not accepted. Retry with the same idempotency key.");
  }
});

api.get("/v1/messages/:id", async (context) => {
  const row = await context.env.DB.prepare(`SELECT message_id,state,attempt_count,last_error_code,provider_message_id
    FROM notification_messages WHERE message_id=?`).bind(context.req.param("id")).first();
  return row ? json(row) : problem(404, "message_not_found");
});
api.notFound(() => problem(404, "not_found"));
api.onError((error) => {
  console.error(JSON.stringify({ event: "notification_api_error", ...providerError(error) }));
  return problem(503, "notification_unavailable");
});

export class NotificationsApi extends WorkerEntrypoint<NotificationsEnv> {
  async fetch(request: Request): Promise<Response> {
    return secure(await api.fetch(request, this.env, this.ctx));
  }
}

export async function publicFetch(request: Request, env: NotificationsEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "GET" && request.method !== "HEAD") return secure(problem(404, "not_found"));
  if (path === "/healthz") {
    try {
      await env.DB.prepare("SELECT 1 FROM notification_messages LIMIT 1").all();
      return secure(json({ service: "notifications", status: "ok", environment: env.ENVIRONMENT }));
    } catch (error: unknown) {
      console.error(JSON.stringify({ event: "notification_health_failed", ...providerError(error) }));
      return secure(problem(503, "database_unavailable"));
    }
  }
  if (path !== "/") return secure(problem(404, "not_found"));
  return secure(new Response(landing.replace("{{ACCOUNT_ORIGIN}}", () => escapeHtml(env.ACCOUNT_ORIGIN)), { headers: { "content-type": "text/html; charset=utf-8" } }));
}

const landing = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>moeSegFault · Notifications</title><style>
:root{font-family:system-ui,sans-serif;color:#26110b;background:#fffaf2;color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;align-content:center;padding:clamp(24px,8vw,96px);background:radial-gradient(circle at 85% 10%,#ffdbad,transparent 50%)}main{max-width:720px}header{font-weight:800;font-size:20px}header span{color:#bd4525}h1{font:clamp(48px,12vw,96px)/1.05 Georgia,serif;letter-spacing:-.05em;margin:56px 0 32px}a{display:inline-block;padding:14px 24px;border-radius:12px;background:#ad3f23;color:#fff;text-decoration:none;font-weight:700}a:focus-visible{outline:3px solid #26110b;outline-offset:4px}footer{margin-top:64px;color:#805648;font-size:13px}@media(prefers-color-scheme:dark){:root{color:#fffaf2;background:#19100e}body{background:radial-gradient(circle at 85% 10%,#4a2d1c,transparent 50%)}footer{color:#d9b8a6}}
</style></head><body><main><header><span>✦</span> moeSegFault</header><h1>Stay<br>in the loop.</h1><a href="{{ACCOUNT_ORIGIN}}">Your account ↗</a><footer>Notifications</footer></main></body></html>`;

export default {
  fetch: publicFetch,
  async scheduled(_event: ScheduledController, env: NotificationsEnv, context: ExecutionContext): Promise<void> {
    context.waitUntil(drain(env).catch((error: unknown) => {
      console.error(JSON.stringify({ event: "notification_drain_failed", ...providerError(error) }));
      throw error;
    }));
  },
} satisfies ExportedHandler<NotificationsEnv>;
