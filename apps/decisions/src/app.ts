import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { correlationId, decryptJson, encryptJson, json, keyedDigest, problem, secure, sha256 } from "@moesegfault/service-platform";
import { callbackTarget, decisionSchema, parseSubmission, randomToken, type DecisionPayload, type DecisionRow, type Env } from "./model";
import { drain } from "./outbox";
import { completedPage, decisionPage, expiredPage, landingPage } from "./pages";

type AppEnv = { Bindings: Env };
export const publicApp = new Hono<AppEnv>();
export const privateApp = new Hono<AppEnv>();
const now = (): number => Math.floor(Date.now() / 1000);

function html(body: string, status = 200): Response {
  return secure(new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } }));
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("invalid_content_type");
  const body = await request.text();
  if (new TextEncoder().encode(body).length > 65536) throw new Error("request_too_large");
  return JSON.parse(body) as unknown;
}

for (const app of [publicApp, privateApp]) {
  app.use("*", async (c, next) => {
    await next();
    c.res = secure(c.res);
    c.header("x-moesegfault-correlation-id", correlationId(c.req.raw));
  });
}
publicApp.get("/", () => html(landingPage()));
publicApp.get("/healthz", async (c) => {
  await c.env.DB.prepare("SELECT 1 AS ready").first();
  return json({ status: "ok", service: "decisions", version: "0.2.0" });
});

publicApp.get("/d/:token", async (c) => {
  const token = c.req.param("token");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return html(expiredPage(), 404);
  const digest = await sha256(token);
  const row = await c.env.DB.prepare("SELECT * FROM decisions WHERE token_digest=?").bind(digest).first<DecisionRow>();
  if (!row) return html(expiredPage(), 404);
  const { input } = await decryptJson<DecisionPayload>(c.env.OUTBOX_KEY, row.payload, row.decision_id);
  if (row.state === "submitted") return html(completedPage(input.locale));
  if (row.state !== "pending" || row.expires_at <= now()) return html(expiredPage(), 410);
  const nonce = randomToken();
  const csrf = await encryptJson(c.env.OUTBOX_KEY, { decision_id: row.decision_id, nonce, expires_at: Math.min(row.expires_at, now() + 3600) }, "decision-csrf");
  setCookie(c, `__Host-decision-${digest.slice(0, 12)}`, nonce, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 3600 });
  return c.html(decisionPage(input, token, csrf));
});

publicApp.post("/d/:token/submit", async (c) => {
  if (c.req.header("origin") !== c.env.PUBLIC_ORIGIN) return problem(403, "origin_rejected");
  const token = c.req.param("token");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return html(expiredPage(), 404);
  const digest = await sha256(token);
  const row = await c.env.DB.prepare("SELECT * FROM decisions WHERE token_digest=?").bind(digest).first<DecisionRow>();
  if (!row) return html(expiredPage(), 404);
  if (row.state !== "pending" || row.expires_at <= now()) return html(expiredPage(), 410);
  if (!c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) return problem(415, "form_required");
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > 65536) return problem(413, "request_too_large");
  const form = new FormData();
  for (const [key, value] of new URLSearchParams(raw)) form.append(key, value);
  try {
    const value = form.get("csrf");
    if (typeof value !== "string") return problem(403, "csrf_rejected");
    const csrf = await decryptJson<{ decision_id: string; nonce: string; expires_at: number }>(c.env.OUTBOX_KEY, value, "decision-csrf");
    if (csrf.decision_id !== row.decision_id || csrf.expires_at <= now() || csrf.nonce !== getCookie(c, `__Host-decision-${digest.slice(0, 12)}`)) return problem(403, "csrf_rejected");
  } catch { return problem(403, "csrf_rejected"); }
  const { input } = await decryptJson<DecisionPayload>(c.env.OUTBOX_KEY, row.payload, row.decision_id);
  let response;
  try { response = parseSubmission(input, form); }
  catch { return problem(422, "invalid_response", "Review the required fields and selected choices."); }
  const eventId = crypto.randomUUID();
  const timestamp = now();
  const payload = await encryptJson(c.env.OUTBOX_KEY, { event_id: eventId, type: "decision.submitted", decision_id: row.decision_id, service: input.service, submitted_at: timestamp, response, context: input.context ?? {} }, eventId);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO decision_submissions(decision_id,event_id,payload,created_at) SELECT decision_id,?,?,? FROM decisions WHERE decision_id=? AND state='pending' AND expires_at>?").bind(eventId, payload, timestamp, row.decision_id, timestamp),
      c.env.DB.prepare("INSERT INTO decision_outbox(outbox_id,decision_id,kind,available_at,created_at) SELECT ?,decision_id,'callback',?,? FROM decision_submissions WHERE decision_id=? AND event_id=?").bind(eventId, timestamp, timestamp, row.decision_id, eventId),
      c.env.DB.prepare("UPDATE decisions SET state='submitted',submitted_at=? WHERE decision_id=? AND EXISTS (SELECT 1 FROM decision_submissions WHERE decision_id=? AND event_id=?)").bind(timestamp, row.decision_id, row.decision_id, eventId),
    ]);
  } catch (error) {
    const submitted = await c.env.DB.prepare("SELECT event_id FROM decision_submissions WHERE decision_id=?").bind(row.decision_id).first();
    if (submitted) return html(completedPage(input.locale));
    throw error;
  }
  const submitted = await c.env.DB.prepare("SELECT event_id FROM decision_submissions WHERE decision_id=? AND event_id=?").bind(row.decision_id, eventId).first();
  if (!submitted) return html(expiredPage(), 410);
  console.log(JSON.stringify({ event: "decision_submitted", decision_id: row.decision_id, service: row.service, event_id: eventId, correlation_id: correlationId(c.req.raw) }));
  c.executionCtx.waitUntil(drain(c.env));
  return new Response(null, { status: 303, headers: { location: `/d/${token}` } });
});

privateApp.post("/v1/decisions", async (c) => {
  const key = c.req.header("idempotency-key");
  if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) return problem(400, "idempotency_key_required");
  let raw: unknown;
  try { raw = await readJson(c.req.raw); }
  catch { return problem(400, "invalid_json"); }
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) return problem(422, "invalid_decision", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const input = parsed.data;
  const requestDigest = await keyedDigest(c.env.OUTBOX_KEY, `decisions-idempotency.v1:${JSON.stringify(input)}`);
  const existing = await c.env.DB.prepare("SELECT * FROM decisions WHERE service=? AND idempotency_key=?").bind(input.service, key).first<DecisionRow>();
  if (existing) return replay(c.env, existing, requestDigest);
  if (input.expires_at <= now() || input.expires_at > now() + 7 * 86400) return problem(422, "invalid_expiry");
  if (!callbackTarget(c.env, input)) return problem(403, "callback_not_registered");
  const id = crypto.randomUUID();
  const token = randomToken();
  const encrypted = await encryptJson(c.env.OUTBOX_KEY, { input, token } satisfies DecisionPayload, id);
  const timestamp = now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO decisions(decision_id,service,idempotency_key,request_digest,token_digest,payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(id, input.service, key, requestDigest, await sha256(token), encrypted, timestamp, input.expires_at),
      c.env.DB.prepare("INSERT INTO decision_outbox(outbox_id,decision_id,kind,available_at,created_at) VALUES(?,?,'notification',?,?)").bind(crypto.randomUUID(), id, timestamp, timestamp),
    ]);
  } catch (error) {
    const raced = await c.env.DB.prepare("SELECT * FROM decisions WHERE service=? AND idempotency_key=?").bind(input.service, key).first<DecisionRow>();
    if (raced) return replay(c.env, raced, requestDigest);
    throw error;
  }
  c.executionCtx.waitUntil(drain(c.env));
  console.log(JSON.stringify({ event: "decision_created", decision_id: id, service: input.service, correlation_id: correlationId(c.req.raw) }));
  return json({ decision_id: id, state: "pending", url: `${c.env.PUBLIC_ORIGIN}/d/${token}`, expires_at: input.expires_at }, 202);
});

privateApp.get("/v1/decisions/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT decision_id,service,state,expires_at,submitted_at FROM decisions WHERE decision_id=?").bind(c.req.param("id")).first();
  if (!row) return problem(404, "decision_not_found");
  const jobs = await c.env.DB.prepare("SELECT kind,state,attempts,last_error_code FROM decision_outbox WHERE decision_id=?").bind(c.req.param("id")).all();
  return json({ ...row, deliveries: jobs.results });
});

async function replay(env: Env, row: DecisionRow, digest: string): Promise<Response> {
  if (row.request_digest !== digest) return problem(409, "idempotency_conflict");
  const { token } = await decryptJson<DecisionPayload>(env.OUTBOX_KEY, row.payload, row.decision_id);
  return json({ decision_id: row.decision_id, state: row.state, url: `${env.PUBLIC_ORIGIN}/d/${token}`, expires_at: row.expires_at }, 202);
}

function onError(error: Error): Response {
  console.error(JSON.stringify({ event: "decisions_request_failed", error_type: error.name, error_message: error.message.replace(/\b[A-Za-z0-9_-]{43}\b/g, "[capability]").slice(0, 300) }));
  return problem(503, "decisions_unavailable");
}
publicApp.onError(onError);
privateApp.onError(onError);
publicApp.notFound(() => problem(404, "not_found"));
privateApp.notFound(() => problem(404, "not_found"));
