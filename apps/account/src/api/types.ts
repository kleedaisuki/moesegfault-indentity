import type { Locale } from "@moesegfault/frontend-shared";

/** RFC 9457 问题详情。RFC 9457 Problem Details. */
export interface ProblemDetails {
  type: string; title: string; status: number; detail?: string; correlation_id?: string;
  error_code?: string;
  errors?: Record<string, string[]>;
}

/** 可被账号中心修改的个人资料。Editable account profile. */
export interface AccountProfile {
  display_name: string;
  bio?: string | null;
  avatar_url?: string | null;
  locale: string;
  status_message?: string | null;
  pronouns?: string | null;
  favorite_character?: string | null;
  interests?: string[];
  links?: string[];
  profile_visibility?: "private" | "members" | "public";
}

/** 稳定账号标识符。Stable account identifier. */
export interface Identifier { identifier_id: string; kind: "username"; value: string; created_at: string; updated_at: string; }

/** 账号与丰富人设资料。Account with its expressive profile. */
export interface Account {
  principal_id: string;
  lifecycle_state: "active" | "suspended" | "pending_deletion" | "deleted";
  profile: AccountProfile;
  identifiers: Identifier[];
  created_at: string;
  updated_at: string;
}

/** 当前账号与内存态 CSRF 证明。Current account with an in-memory CSRF proof. */
export interface MeEnvelope { account: Account; csrf_token: string; csrf_expires_at: string; }

/** Email 或手机联系方式；值仅在此私有界面返回。Private email or mobile contact. */
export interface Contact {
  contact_id: string;
  kind: "email" | "mobile";
  value: string;
  verification_state: "unverified" | "pending" | "verified";
  is_primary: boolean;
  country_calling_code?: string | null;
  national_number?: string | null;
  created_at: string;
  updated_at: string;
}

/** 短期联系方式验证事务。Short-lived contact verification transaction. */
export interface ContactVerificationTransaction { transaction_id: string; expires_at: string; delivery_hint: string; }

/** 账号安全能力摘要，可随着 MFA 扩展而不改变导航。Extensible account security capability summary. */
export interface SecuritySummary {
  password: boolean;
  passkey_count: number;
  mfa_methods: Array<"totp" | "passkey" | "push" | "hardware_otp">;
  verified_email_count: number;
  verified_mobile_count: number;
  recovery_ready: boolean;
  recommendations?: Array<"verify_email" | "add_passkey" | "add_second_factor" | "generate_recovery_codes">;
}

/** 界面、时区与通知偏好。Presentation, timezone and notification preferences. */
export interface AccountPreferences { locale: Locale; theme: "system" | "light" | "dark"; timezone: string; reduced_motion: boolean; compact_mode: boolean; notifications: { security_email: boolean; product_email?: boolean }; }

/** Passkey 管理投影。Passkey management projection. */
export interface Credential {
  authenticator_id: string;
  kind: "passkey";
  label: string;
  created_at: string;
  last_used_at?: string | null;
  is_current?: boolean;
  backup_state?: boolean;
}

/** 会话的用户可读投影。User-readable session projection. */
export interface Session {
  session_id: string;
  authentication_method: "password" | "passkey" | "federated";
  amr: string[];
  acr: string;
  last_seen_at: string;
  authenticated_at: string;
  expires_at: string;
  is_current: boolean;
}

/** 用户授权给第三方客户端的权限集合。Grant given by the user to a client application. */
export interface ConnectedApp {
  authorization_id: string;
  client_id: string;
  display_name: string;
  logo_url?: string | null;
  scopes: string[];
  granted_at: string;
  last_used_at?: string | null;
}

/** API 的标准资源列表。Standard API resource list. */
export interface ResourceList<T> { items: T[]; }

/** 修改个人资料的合并补丁。Merge patch used to update profile. */
export type ProfilePatch = Partial<Pick<AccountProfile, "display_name" | "bio" | "locale" | "status_message" | "pronouns" | "favorite_character" | "interests" | "links" | "profile_visibility">>;

/** 创建联系方式的输入。Input used to create a contact. */
export type ContactCreate =
  | { kind: "email"; email: string; is_primary?: boolean }
  | { kind: "mobile"; mobile: { country_calling_code: string; national_number: string }; is_primary?: boolean };

/** 状态变更的浏览器证明。Browser proof for a state mutation. */
export interface MutationProof { csrfToken: string; idempotencyKey?: string; signal?: AbortSignal; }
