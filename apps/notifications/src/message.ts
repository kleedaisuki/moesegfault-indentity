import { z } from "zod";

const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n\u0000]+$/);
const slug = z.string().min(1).max(48).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const action = z.object({
  label: line(80),
  url: z.url().max(2048).refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Action URLs must use HTTPS without credentials"),
}).strict();

export const messageSchema = z.object({
  service: slug,
  sender: slug,
  to: z.email().max(254),
  template: z.enum(["verification", "notification", "decision", "security"]),
  locale: z.enum(["en", "zh-CN", "ja"]).default("en"),
  subject: line(160).optional(),
  title: line(160).optional(),
  body: z.string().trim().min(1).max(8000).optional(),
  code: z.string().regex(/^[0-9]{6,10}$/).optional(),
  expires_at: z.number().int().positive().optional(),
  action: action.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.template === "verification" && (!value.code || !value.expires_at)) {
    ctx.addIssue({ code: "custom", message: "Verification requires code and expires_at" });
  }
  if (value.template === "decision" && !value.action) {
    ctx.addIssue({ code: "custom", message: "Decision requires an action" });
  }
  if (value.template === "decision" && !value.title) {
    ctx.addIssue({ code: "custom", message: "Decision requires title" });
  }
  if ((value.template === "notification" || value.template === "security") && (!value.title || !value.body)) {
    ctx.addIssue({ code: "custom", message: "Notifications require title and body" });
  }
});

export type NotificationMessage = z.infer<typeof messageSchema>;

export type MessageState = "queued" | "sending" | "sent" | "failed";

export interface MessageRow {
  message_id: string;
  service: string;
  sender: string;
  idempotency_key: string;
  payload_hash: string;
  payload: string | null;
  state: MessageState;
  attempt_count: number;
  expires_at: number;
  correlation_id: string;
  lease_token: string | null;
}

export interface EmailContent {
  from: { email: string; name: string };
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

export interface NotificationsEnv {
  DB: D1Database;
  EMAIL: { send(message: EmailContent): Promise<{ messageId: string }> };
  OUTBOX_KEY: string;
  ENVIRONMENT: string;
}
