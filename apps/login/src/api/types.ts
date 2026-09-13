/** RFC 9457 问题详情。RFC 9457 Problem Details payload. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  correlation_id?: string;
  [extension: string]: unknown;
}

/** API 返回的 Base64URL 编码凭据描述符。API credential descriptor encoded with Base64URL. */
export interface PublicKeyCredentialDescriptorJson {
  type: PublicKeyCredentialType;
  id: string;
  transports?: AuthenticatorTransport[];
}

/** API 返回的 WebAuthn 注册选项。WebAuthn registration options returned by the API. */
export interface PublicKeyCredentialCreationOptionsJson {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: {
    id: string;
    name: string;
    display_name: string;
  };
  pub_key_cred_params: PublicKeyCredentialParameters[];
  timeout?: number;
  exclude_credentials?: PublicKeyCredentialDescriptorJson[];
  authenticator_selection?: {
    resident_key: ResidentKeyRequirement;
    require_resident_key: boolean;
    user_verification: UserVerificationRequirement;
  };
  attestation?: AttestationConveyancePreference;
  extensions?: AuthenticationExtensionsClientInputs;
}

/** API 返回的 WebAuthn 认证选项。WebAuthn authentication options returned by the API. */
export interface PublicKeyCredentialRequestOptionsJson {
  challenge: string;
  timeout?: number;
  rp_id?: string;
  allow_credentials?: PublicKeyCredentialDescriptorJson[];
  user_verification?: UserVerificationRequirement;
  extensions?: AuthenticationExtensionsClientInputs;
}

/** 可提交给 Identity 的序列化凭据。Serialized credential submitted to Identity. */
export interface PublicKeyCredentialJson {
  id: string;
  raw_id: string;
  type: PublicKeyCredentialType;
  authenticator_attachment: string | null;
  client_extension_results: AuthenticationExtensionsClientOutputs;
  response:
    | {
        client_data_json: string;
        attestation_object: string;
        transports?: string[];
      }
    | {
        client_data_json: string;
        authenticator_data: string;
        signature: string;
        user_handle: string | null;
      };
}

/** 一次性 WebAuthn 事务的公共字段。Shared fields for a one-time WebAuthn transaction. */
export interface CeremonyTransaction<TOptions> {
  transaction_id: string;
  csrf_token: string;
  expires_at: string;
  public_key: TOptions;
}

/** 创建注册事务时的输入。Input used to begin registration. */
export interface RegistrationStart {
  username: string;
  display_name: string;
  authenticator_label: string;
  locale?: string;
  registration_capability?: string;
}

/** 注册完成后的可见结果；恢复代码只出现一次。Visible registration result; recovery codes are returned once. */
export interface RegistrationResult {
  account: Account;
  authenticator: Authenticator;
  recovery_codes?: string[];
  next_uri?: string;
  csrf_token: string;
  csrf_expires_at: string;
}

/** 创建无用户名认证事务时的输入。Input used to begin username-less authentication. */
export interface AuthenticationStart {
  purpose: "login" | "step_up";
  authorization_transaction_id?: string;
}

/** 登录完成后的导航结果。Navigation result after authentication completes. */
export interface AuthenticationResult {
  account: Account;
  session: IdentitySession;
  authorization_resume_uri?: string;
  csrf_token: string;
  csrf_expires_at: string;
}

/** 创建恢复事务时的输入。Input used to begin account recovery. */
export interface RecoveryStart {
  recovery_code: string;
  authenticator_label: string;
}

/** 恢复代码被消费后的受限事务。Restricted transaction returned after consuming a recovery code. */
export interface RecoveryResult {
  account: Account;
  authenticator: Authenticator;
  session: IdentitySession;
  recovery_codes: string[];
  csrf_token: string;
  csrf_expires_at: string;
}

/** Username identifier 的稳定管理投影。Stable management projection of a username identifier. */
export interface Identifier {
  identifier_id: string;
  kind: "username";
  value: string;
  created_at: string;
  updated_at: string;
}

/** 当前人类账号的资料与状态。Profile and state for the current human account. */
export interface Account {
  principal_id: string;
  lifecycle_state: "active" | "suspended" | "pending_deletion" | "deleted";
  profile: {
    display_name: string;
    avatar_url?: string | null;
    locale: string;
  };
  identifiers: Identifier[];
  created_at: string;
  updated_at: string;
}

/** 账号中单个 Passkey 的管理投影。Management projection for one account passkey. */
export interface Authenticator {
  authenticator_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  backup_eligible: boolean;
  backup_state: boolean;
  is_current: boolean;
  transports?: string[];
  revoked_at?: string | null;
}

/** 支持建立 Binding 的受控 provider。Allowlisted provider available for a new binding. */
export interface BindingProvider {
  provider_id: string;
  display_name: string;
  authentication_enabled: boolean;
}

/** 外部主体 Binding 的安全管理投影。Safe management projection for an external identity binding. */
export interface IdentityBinding {
  binding_id: string;
  provider_id: string;
  kind: "federated_human";
  display_label?: string | null;
  created_at: string;
  last_authenticated_at?: string | null;
  authentication_enabled: boolean;
}

/** Identity Session 的设备级投影。Device-level projection of an identity session. */
export interface IdentitySession {
  session_id: string;
  authentication_method: "passkey" | "federated";
  authenticator_id?: string | null;
  binding_id?: string | null;
  amr: string[];
  acr: string;
  authenticated_at: string;
  last_seen_at: string;
  expires_at: string;
  is_current: boolean;
  revoked_at?: string | null;
}

/** 建立外部 Binding 后需要导航到的受控 URL。Allowlisted navigation URL for establishing an external binding. */
export interface BindingTransactionResult {
  transaction_id: string;
  authorization_uri: string;
  expires_at: string;
}

/** 恢复代码轮换结果；代码不会再次返回。Recovery code rotation result; codes cannot be fetched again. */
export interface RecoveryCodeRotation {
  recovery_codes: string[];
  generated_at: string;
  total_count: number;
  remaining_count: number;
}

/** 恢复代码的非秘密计数状态。Non-secret status counts for recovery codes. */
export interface RecoveryCodeStatus {
  generated_at: string;
  total_count: number;
  remaining_count: number;
}

/** 后端列表既可裸数组也可具名包装，以兼容 OpenAPI 的资源包装。Backend lists may be bare or resource-wrapped. */
export interface ResourceList<T> {
  items: T[];
}

/** 匿名浏览器绑定及只驻留内存的 CSRF token。Anonymous browser binding with an in-memory-only CSRF token. */
export interface BrowserContext {
  csrf_token: string;
  csrf_expires_at: string;
  has_identity_session: boolean;
}

/** 当前账号与轮换后的会话 CSRF token。Current account and its rotated session CSRF token. */
export interface AccountSessionEnvelope {
  account: Account;
  csrf_token: string;
  csrf_expires_at: string;
}
