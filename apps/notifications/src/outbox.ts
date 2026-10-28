import { decryptJson, encryptJson, keyedDigest, providerError, retryDelay } from "@moesegfault/service-platform";
import type { MessageRow, NotificationMessage, NotificationsEnv } from "./message";
import { renderEmail } from "./templates";

const maxAttempts = 8;
const leaseSeconds = 90;
const permanentProviderErrors = new Set([
  "E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS", "E_TOO_MANY_ATTACHMENTS",
  "E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED", "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED", "E_HEADER_USE_API_FIELD", "E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID", "E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY",
]);

export class IdempotencyConflict extends Error {}
export class InvalidExpiry extends Error {}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function aad(messageId: string): string {
  return `moesegfault.notifications.v1:${messageId}`;
}

export async function enqueue(
  env: NotificationsEnv, message: NotificationMessage, idempotencyKey: string, correlation: string,
): Promise<MessageRow> {
  const hash = await keyedDigest(env.OUTBOX_KEY, `notifications-idempotency.v1:${JSON.stringify(message)}`);
  const existing = await findByKey(env, message.service, idempotencyKey);
  if (existing) return matching(existing, hash);
  const now = nowSeconds();
  const expiresAt = message.expires_at ?? now + 86400;
  if (expiresAt <= now || expiresAt > now + 604800) throw new InvalidExpiry();
  const messageId = crypto.randomUUID();
  const payload = await encryptJson(env.OUTBOX_KEY, message, aad(messageId));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO notification_senders(local_part,address,created_at) VALUES(?,?,?) ON CONFLICT(local_part) DO NOTHING")
      .bind(message.sender, `${message.sender}@moesegfault.dev`, now),
    env.DB.prepare(`INSERT INTO notification_messages
      (message_id,service,sender,idempotency_key,payload_hash,payload,next_attempt_at,created_at,updated_at,expires_at,correlation_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(service,idempotency_key) DO NOTHING`)
      .bind(messageId, message.service, message.sender, idempotencyKey, hash, payload, now, now, now, expiresAt, correlation),
  ]);
  const row = await findByKey(env, message.service, idempotencyKey);
  if (!row) throw new Error("notification_enqueue_missing");
  return matching(row, hash);
}

async function findByKey(env: NotificationsEnv, service: string, key: string): Promise<MessageRow | null> {
  return env.DB.prepare("SELECT * FROM notification_messages WHERE service=? AND idempotency_key=?")
    .bind(service, key).first<MessageRow>();
}

function matching(row: MessageRow, hash: string): MessageRow {
  if (row.payload_hash !== hash) throw new IdempotencyConflict();
  return row;
}

export function providerCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "provider_exception";
  const code: unknown = error.code;
  return typeof code === "string" && /^E_[A-Z_]{1,60}$/.test(code) ? code : "provider_exception";
}

export function logEvent(event: string, row: MessageRow, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, message_id: row.message_id, service: row.service, sender: row.sender,
    correlation_id: row.correlation_id, attempt: row.attempt_count, ...details }));
}

export async function deliver(env: NotificationsEnv, messageId: string): Promise<void> {
  const now = nowSeconds();
  const token = crypto.randomUUID();
  const row = await env.DB.prepare(`UPDATE notification_messages
    SET state='sending',lease_token=?,lease_until=?,attempt_count=attempt_count+1,updated_at=?
    WHERE message_id=? AND expires_at>? AND attempt_count<?
      AND ((state='queued' AND next_attempt_at<=?) OR (state='sending' AND lease_until<=?))
    RETURNING *`).bind(token, now + leaseSeconds, now, messageId, now, maxAttempts, now, now).first<MessageRow>();
  if (!row || !row.payload) return;
  let message: NotificationMessage;
  try {
    message = await decryptJson<NotificationMessage>(env.OUTBOX_KEY, row.payload, aad(row.message_id));
  } catch {
    await settleFailure(env, row, "payload_decryption_failed", true);
    return;
  }
  let providerId: string;
  try {
    const result = await env.EMAIL.send(renderEmail(message, row.message_id));
    providerId = result.messageId;
  } catch (error: unknown) {
    const code = providerCode(error);
    logEvent("notification_provider_error", row, { error_code: code, error_message: providerError(error).message });
    await settleFailure(env, row, code, permanentProviderErrors.has(code));
    return;
  }
  try {
    const settled = await env.DB.prepare(`UPDATE notification_messages SET state='sent',payload=NULL,provider_message_id=?,
      updated_at=?,lease_until=NULL,lease_token=NULL,last_error_code=NULL WHERE message_id=? AND lease_token=?`)
      .bind(providerId, nowSeconds(), row.message_id, token).run();
    logEvent(settled.meta.changes === 1 ? "notification_sent" : "notification_lease_lost", row, { provider_message_id: providerId });
  } catch (error: unknown) {
    logEvent("notification_settlement_failed", row, { provider_message_id: providerId, error_message: providerError(error).message });
    throw error;
  }
}

async function settleFailure(env: NotificationsEnv, row: MessageRow, code: string, permanent: boolean): Promise<void> {
  const now = nowSeconds();
  const nextAttempt = now + retryDelay(row.attempt_count);
  const terminal = permanent || row.attempt_count >= maxAttempts || nextAttempt >= row.expires_at;
  await env.DB.prepare(`UPDATE notification_messages SET state=?,payload=CASE WHEN ? THEN NULL ELSE payload END,
    next_attempt_at=?,updated_at=?,lease_until=NULL,lease_token=NULL,last_error_code=?
    WHERE message_id=? AND lease_token=?`)
    .bind(terminal ? "failed" : "queued", terminal ? 1 : 0, nextAttempt, now, code, row.message_id, row.lease_token).run();
  logEvent(terminal ? "notification_failed" : "notification_retry", row, { error_code: code, next_attempt_at: terminal ? null : nextAttempt });
}

export async function drain(env: NotificationsEnv): Promise<void> {
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(`UPDATE notification_messages SET state='failed',payload=NULL,updated_at=?,
      last_error_code=CASE WHEN expires_at<=? THEN 'expired' ELSE 'attempts_exhausted' END,lease_until=NULL,lease_token=NULL
      WHERE state IN ('queued','sending') AND (lease_until IS NULL OR lease_until<=?) AND (expires_at<=? OR attempt_count>=?)`)
      .bind(now, now, now, now, maxAttempts),
    env.DB.prepare("DELETE FROM notification_messages WHERE state IN ('sent','failed') AND created_at<?").bind(now - 2592000),
  ]);
  const result = await env.DB.prepare(`SELECT message_id FROM notification_messages
    WHERE expires_at>? AND attempt_count<? AND ((state='queued' AND next_attempt_at<=?) OR (state='sending' AND lease_until<=?))
    ORDER BY next_attempt_at LIMIT 25`).bind(now, maxAttempts, now, now).all<{ message_id: string }>();
  for (const row of result.results) await deliver(env, row.message_id);
}
