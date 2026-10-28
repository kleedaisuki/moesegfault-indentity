import { decryptJson, providerError, retryDelay } from "@moesegfault/service-platform";
import { callbackTarget, type DecisionPayload, type DecisionRow, type Env } from "./model";

interface OutboxRow { outbox_id: string; decision_id: string; kind: "notification" | "callback"; attempts: number }

function deliveryError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function dispatch(env: Env, job: OutboxRow, row: DecisionRow): Promise<void> {
  const { input, token } = await decryptJson<DecisionPayload>(env.OUTBOX_KEY, row.payload, row.decision_id);
  if (job.kind === "notification") {
    if (row.state !== "pending" || row.expires_at <= Math.floor(Date.now() / 1000)) return;
    const response = await env.NOTIFICATIONS.fetch("https://notifications.internal/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `decision:${row.decision_id}`, "x-moesegfault-correlation-id": row.decision_id },
      body: JSON.stringify({ service: input.service, sender: input.sender, to: input.to, template: "decision", locale: input.locale,
        title: input.title, body: input.body, expires_at: input.expires_at,
        action: { label: input.locale === "zh-CN" ? "查看并回复" : input.locale === "ja" ? "回答する" : "Review and respond", url: `${env.PUBLIC_ORIGIN}/d/${token}` } }),
    });
    if (response.status !== 202) throw deliveryError(`notifications_http_${response.status}`);
    const accepted = await response.json<{ state: string }>();
    if (accepted.state === "failed") throw deliveryError("notifications_delivery_failed");
    return;
  }
  const target = callbackTarget(env, input);
  if (!target) throw deliveryError("callback_registration_unavailable");
  const submission = await env.DB.prepare("SELECT event_id,payload FROM decision_submissions WHERE decision_id=?").bind(row.decision_id).first<{ event_id: string; payload: string }>();
  if (!submission) throw deliveryError("submission_unavailable");
  const payload = await decryptJson<unknown>(env.OUTBOX_KEY, submission.payload, submission.event_id);
  const response = await target.fetch(`https://callback.internal${input.callback.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": submission.event_id,
      "x-moesegfault-event-id": submission.event_id, "x-moesegfault-correlation-id": row.decision_id },
    body: JSON.stringify(payload),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw deliveryError(`callback_http_${response.status}`);
}

async function deliver(env: Env, job: OutboxRow): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare("UPDATE decision_outbox SET lease_id=?,lease_until=?,attempts=attempts+1 WHERE outbox_id=? AND state='queued' AND available_at<=? AND (lease_until IS NULL OR lease_until<?) RETURNING outbox_id")
    .bind(lease, now + 60, job.outbox_id, now, now).first();
  if (!claimed) return;
  try {
    const decision = await env.DB.prepare("SELECT * FROM decisions WHERE decision_id=?").bind(job.decision_id).first<DecisionRow>();
    if (!decision) throw new Error("decision_unavailable");
    await dispatch(env, job, decision);
    await env.DB.prepare("UPDATE decision_outbox SET state='delivered',delivered_at=?,lease_id=NULL,lease_until=NULL,last_error_code=NULL WHERE outbox_id=? AND lease_id=?")
      .bind(now, job.outbox_id, lease).run();
    console.log(JSON.stringify({ event: "decision_delivery", decision_id: job.decision_id, kind: job.kind, outcome: "delivered", attempt: job.attempts + 1 }));
  } catch (error) {
    const detail = providerError(error);
    const failed = job.attempts + 1 >= 12;
    await env.DB.prepare("UPDATE decision_outbox SET state=?,available_at=?,lease_id=NULL,lease_until=NULL,last_error_code=? WHERE outbox_id=? AND lease_id=?")
      .bind(failed ? "failed" : "queued", now + retryDelay(job.attempts + 1), detail.code, job.outbox_id, lease).run();
    console.error(JSON.stringify({ event: "decision_delivery", decision_id: job.decision_id, kind: job.kind, outcome: failed ? "failed" : "retry", attempt: job.attempts + 1, error_code: detail.code, error_message: detail.message }));
  }
}

export async function drain(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const jobs = await env.DB.prepare("SELECT outbox_id,decision_id,kind,attempts FROM decision_outbox WHERE state='queued' AND available_at<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY available_at LIMIT 20").bind(now, now).all<OutboxRow>();
  for (const job of jobs.results) await deliver(env, job);
}

export async function maintain(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("UPDATE decisions SET state='expired' WHERE state='pending' AND expires_at<=?").bind(now).run();
  await drain(env);
  await env.DB.prepare("DELETE FROM decisions WHERE expires_at<? AND NOT EXISTS (SELECT 1 FROM decision_outbox o WHERE o.decision_id=decisions.decision_id AND o.state='queued')").bind(now - 30 * 86400).run();
}
