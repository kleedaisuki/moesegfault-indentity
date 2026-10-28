import { decryptJson, providerError, retryDelay } from "@moesegfault/service-platform";
import { callbackTarget, type DecisionPayload, type DecisionRow, type Env } from "./model";
import { invitationJson } from "./invitation";

interface OutboxRow { outbox_id: string; decision_id: string; kind: "notification" | "callback"; attempts: number }
const maxAttempts = 12;

function deliveryError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function dispatch(env: Env, job: OutboxRow, row: DecisionRow): Promise<void> {
  const decision = await decryptJson<DecisionPayload>(env.OUTBOX_KEY, row.payload, row.decision_id);
  const { input } = decision;
  if (job.kind === "notification") {
    if (row.state !== "pending" || row.expires_at <= Math.floor(Date.now() / 1000)) return;
    const response = await env.NOTIFICATIONS.fetch("https://notifications.internal/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `decision:${row.decision_id}`, "x-moesegfault-correlation-id": row.decision_id },
      body: invitationJson(decision, env.PUBLIC_ORIGIN),
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

export async function deliver(env: Env, outboxId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const lease = crypto.randomUUID();
  const job = await env.DB.prepare("UPDATE decision_outbox SET lease_id=?,lease_until=?,attempts=attempts+1 WHERE outbox_id=? AND state='queued' AND attempts<? AND available_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING outbox_id,decision_id,kind,attempts")
    .bind(lease, now + 60, outboxId, maxAttempts, now, now).first<OutboxRow>();
  if (!job) return;
  try {
    const decision = await env.DB.prepare("SELECT * FROM decisions WHERE decision_id=?").bind(job.decision_id).first<DecisionRow>();
    if (!decision) throw new Error("decision_unavailable");
    await dispatch(env, job, decision);
    await env.DB.prepare("UPDATE decision_outbox SET state='delivered',delivered_at=?,lease_id=NULL,lease_until=NULL,last_error_code=NULL WHERE outbox_id=? AND lease_id=?")
      .bind(Math.floor(Date.now() / 1000), job.outbox_id, lease).run();
    console.log(JSON.stringify({ event: "decision_delivery", decision_id: job.decision_id, kind: job.kind, outcome: "delivered", attempt: job.attempts }));
  } catch (error) {
    const detail = providerError(error);
    const failed = job.attempts >= maxAttempts;
    await env.DB.prepare("UPDATE decision_outbox SET state=?,available_at=?,lease_id=NULL,lease_until=NULL,last_error_code=? WHERE outbox_id=? AND lease_id=?")
      .bind(failed ? "failed" : "queued", Math.floor(Date.now() / 1000) + retryDelay(job.attempts), detail.code, job.outbox_id, lease).run();
    console.error(JSON.stringify({ event: "decision_delivery", decision_id: job.decision_id, kind: job.kind, outcome: failed ? "failed" : "retry", attempt: job.attempts, error_code: detail.code, error_message: detail.message }));
  }
}

export async function drain(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const exhausted = await env.DB.prepare("UPDATE decision_outbox SET state='failed',lease_id=NULL,lease_until=NULL,last_error_code='attempts_exhausted' WHERE state='queued' AND attempts>=? AND (lease_until IS NULL OR lease_until<=?) RETURNING decision_id,kind,attempts")
    .bind(maxAttempts, now).all<{ decision_id: string; kind: string; attempts: number }>();
  for (const job of exhausted.results) console.error(JSON.stringify({ event: "decision_delivery", decision_id: job.decision_id, kind: job.kind, outcome: "failed", attempt: job.attempts, error_code: "attempts_exhausted" }));
  const jobs = await env.DB.prepare("SELECT outbox_id FROM decision_outbox WHERE state='queued' AND attempts<? AND available_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY available_at LIMIT 20")
    .bind(maxAttempts, now, now).all<{ outbox_id: string }>();
  for (const job of jobs.results) await deliver(env, job.outbox_id);
}

export async function maintain(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("UPDATE decisions SET state='expired' WHERE state='pending' AND expires_at<=?").bind(now).run();
  await drain(env);
  await env.DB.prepare("DELETE FROM decisions WHERE expires_at<? AND NOT EXISTS (SELECT 1 FROM decision_outbox o WHERE o.decision_id=decisions.decision_id AND o.state='queued')").bind(now - 30 * 86400).run();
}
