import type { DecisionInput, DecisionPayload } from "./model";

const notificationDeliveryLifetime = 7 * 86400;

function legacyEnvelope(input: DecisionInput, token: string, origin: string) {
  return { service: input.service, sender: input.sender, to: input.to, template: "decision", locale: input.locale,
    title: input.title, body: input.body, expires_at: input.expires_at,
    action: { label: input.locale === "zh-CN" ? "查看并回复" : input.locale === "ja" ? "回答する" : "Review and respond", url: `${origin}/d/${token}` } };
}

export function snapshotInvitation(input: DecisionInput, token: string, origin: string, createdAt: number): string {
  const message = legacyEnvelope(input, token, origin);
  return JSON.stringify({ ...message, expires_at: Math.min(createdAt + notificationDeliveryLifetime, input.expires_at),
    action: { ...message.action, expires_at: input.expires_at } });
}

export function invitationJson(payload: DecisionPayload, origin: string): string {
  // Legacy retries must retain their original JSON under the accepted message key.
  return payload.notification_json ?? JSON.stringify(legacyEnvelope(payload.input, payload.token, origin));
}
