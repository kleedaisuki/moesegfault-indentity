import { z } from "zod";

const slug = z.string().max(48).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const text = z.string().trim().min(1).max(4000);
const option = z.object({ value: z.string().min(1).max(120), label: z.string().min(1).max(160) }).strict();
const field = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/).refine((name) => !["csrf", "choice"].includes(name)),
  label: z.string().min(1).max(160),
  type: z.enum(["text", "textarea", "email", "number", "checkbox", "select"]),
  required: z.boolean().default(false),
  options: z.array(option).min(1).max(30).optional(),
}).strict().refine((item) => item.type !== "select" || Boolean(item.options?.length), "Select fields need options");

export const decisionSchema = z.object({
  service: slug,
  sender: slug,
  to: z.email().max(254),
  title: z.string().trim().min(1).max(160).regex(/^[^\r\n\u0000]+$/),
  body: text.optional(),
  locale: z.enum(["en", "zh-CN", "ja"]).default("en"),
  expires_at: z.number().int().positive().max(8_640_000_000_000).optional(),
  choices: z.array(option).min(1).max(20).optional(),
  fields: z.array(field).min(1).max(20).optional(),
  callback: z.object({ binding: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), path: z.string().regex(/^\/[a-zA-Z0-9/_-]{1,200}$/) }).strict(),
  context: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.choices?.length && !value.fields?.length) ctx.addIssue({ code: "custom", message: "A choice or form is required" });
  const names = value.fields?.map((item) => item.name) ?? [];
  if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "Field names must be unique" });
  for (const options of [value.choices, ...(value.fields?.map((item) => item.options) ?? [])]) {
    const values = options?.map((item) => item.value) ?? [];
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", message: "Option values must be unique" });
  }
});

export type DecisionRequest = z.infer<typeof decisionSchema>;
export type DecisionInput = DecisionRequest & { expires_at: number };
export interface DecisionPayload { input: DecisionInput; token: string; notification_json?: string }
export const defaultDecisionLifetime = 7 * 86400;

export function resolveDecision(request: DecisionRequest, createdAt: number, configuredMaximum?: string): DecisionInput {
  const maximum = Number(configuredMaximum ?? 365 * 86400);
  if (!Number.isSafeInteger(maximum) || maximum < defaultDecisionLifetime) throw new Error("invalid_decision_lifetime_configuration");
  const expiresAt = request.expires_at ?? createdAt + defaultDecisionLifetime;
  if (expiresAt <= createdAt || expiresAt - createdAt > maximum) throw new RangeError("invalid_expiry");
  return { ...request, expires_at: expiresAt };
}
export interface DecisionRow {
  decision_id: string;
  service: string;
  request_digest: string;
  token_digest: string;
  payload: string;
  state: "pending" | "submitted" | "expired";
  expires_at: number;
  submitted_at: number | null;
}
export interface CallbackRegistration { binding: string; paths: string[] }
export interface Env {
  DB: D1Database;
  NOTIFICATIONS: Fetcher;
  OUTBOX_KEY: string;
  PUBLIC_ORIGIN: string;
  ENVIRONMENT: string;
  CALLBACK_SERVICES: string;
  MAX_DECISION_LIFETIME_SECONDS?: string;
  [binding: string]: unknown;
}
export interface Submission { choice?: string; fields: Record<string, string | number | boolean> }

export function callbackTarget(env: Env, input: Pick<DecisionInput, "service" | "callback">): Fetcher | null {
  const config = JSON.parse(env.CALLBACK_SERVICES || "{}") as Record<string, CallbackRegistration>;
  const registered = config[input.service];
  if (!registered || registered.binding !== input.callback.binding || !registered.paths.includes(input.callback.path)) return null;
  const binding = env[registered.binding] as Fetcher | undefined;
  return binding && typeof binding.fetch === "function" ? binding : null;
}

export function parseSubmission(input: Pick<DecisionInput, "choices" | "fields">, form: FormData): Submission {
  const allowed = new Set(["csrf", "choice", ...(input.fields?.map((field) => field.name) ?? [])]);
  for (const [name, value] of form.entries()) {
    if (!allowed.has(name) || typeof value !== "string" || form.getAll(name).length !== 1) throw new Error("invalid_field");
  }
  const result: Submission = { fields: {} };
  if (input.choices) {
    const choice = form.get("choice");
    if (typeof choice !== "string" || !input.choices.some((item) => item.value === choice)) throw new Error("invalid_choice");
    result.choice = choice;
  }
  for (const field of input.fields ?? []) {
    const raw = form.get(field.name);
    const value = typeof raw === "string" ? raw.trim() : "";
    if (field.type === "checkbox") {
      if (value && value !== "on") throw new Error("invalid_checkbox");
      if (field.required && !value) throw new Error("required_field");
      result.fields[field.name] = value === "on";
      continue;
    }
    if (!value && !field.required) continue;
    if (!value || value.length > 4000) throw new Error("invalid_field");
    if (field.type === "select" && !field.options?.some((item) => item.value === value)) throw new Error("invalid_option");
    if (field.type === "email" && !z.email().safeParse(value).success) throw new Error("invalid_email");
    if (field.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error("invalid_number");
      result.fields[field.name] = number;
      continue;
    }
    result.fields[field.name] = value;
  }
  return result;
}

export function randomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
