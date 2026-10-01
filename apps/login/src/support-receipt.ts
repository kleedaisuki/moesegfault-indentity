import { ApiError } from "./api/client";

/** Public failure boundaries; never describe private credential/account subreasons. */
export type SupportOperation = "browser_context" | "password_authentication" | "passkey_start" | "passkey_completion" | "oauth_resume";
/** Readable HTTP outcomes are distinct from unreadable network and browser failures. */
export type SupportTransport = "http_problem" | "network_or_cors" | "aborted" | "unexpected";
/** A user-controlled, ephemeral receipt, not an analytics event or diagnostic lookup key. */
export interface SupportReceipt {
  schema: 1;
  revision: string;
  realm: "production" | "staging" | "unknown";
  operation: SupportOperation;
  transport: SupportTransport;
  status?: number;
  problem: string;
  correlation?: string;
  observed_minute: string;
}

const problemCodes = new Set(["authentication_failed", "invalid_request", "rate_limited", "internal_error", "network_error", "transaction_expired", "not_authenticated", "forbidden"]);

/** Accept only the server's two UUID wire forms; never truncate an untrusted header. */
export function supportCorrelation(value: unknown): string | undefined {
  if (typeof value !== "string" || (value.length !== 32 && value.length !== 36)) return undefined;
  return /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value) ? value : undefined;
}

/** Fixed deployed host mapping ignores query parameters, API overrides and URL paths. */
export function supportRealm(hostname: string): SupportReceipt["realm"] {
  if (hostname === "login.moesegfault.dev") return "production";
  if (hostname === "login-staging.moesegfault.dev") return "staging";
  return "unknown";
}

/**
 * Construct a fresh allowlisted object. Never spread/serialize errors or request context.
 * No account existence, URL, exception text, cookies, credentials or protocol secrets enter it.
 */
export function failureReceipt(error: unknown, operation: SupportOperation, hostname: string, revision: string, now = Date.now()): SupportReceipt {
  const api = error instanceof ApiError ? error : undefined;
  const status = api && Number.isInteger(api.status) && api.status >= 100 && api.status <= 599 ? api.status : undefined;
  const code = typeof api?.type === "string" && api.type.startsWith("urn:moesegfault:problem:") ? api.type.slice("urn:moesegfault:problem:".length) : "unknown";
  const transport: SupportTransport = status !== undefined ? "http_problem"
    : error instanceof DOMException && error.name === "AbortError" ? "aborted"
    : api?.status === 0 || error instanceof TypeError ? "network_or_cors" : "unexpected";
  const correlation = supportCorrelation(api?.correlationId);
  return {
    schema: 1, revision: /^[0-9a-f]{40}$/i.test(revision) ? revision : "unknown",
    realm: supportRealm(hostname), operation, transport,
    ...(status !== undefined ? { status } : {}),
    problem: problemCodes.has(code) ? code : "unknown",
    ...(correlation ? { correlation } : {}),
    observed_minute: new Date(Math.floor(now / 60_000) * 60_000).toISOString(),
  };
}
