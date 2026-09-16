import type { Account, AccountPreferences, MeEnvelope } from "./api/types";

/**
 * 账号应用的完整会话状态；鉴权数据不会以部分可选字段存在。
 * Complete Account session state; authentication data never exists as partial optional fields.
 */
export type AccountSession =
  | { readonly status: "pending" }
  | { readonly status: "anonymous" }
  | {
      readonly status: "authenticated";
      readonly account: Account;
      readonly preferences: AccountPreferences;
      readonly csrfToken: string;
    };

/** 原子地组装已鉴权会话。Atomically assembles an authenticated session. */
export function authenticatedSession(envelope: MeEnvelope, preferences: AccountPreferences): AccountSession {
  return { status: "authenticated", account: envelope.account, preferences, csrfToken: envelope.csrf_token };
}
