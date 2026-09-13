import type {
  AuthenticationResult,
  AuthenticationStart,
  AccountSessionEnvelope,
  Authenticator,
  AuthenticatorRegistrationResult,
  BindingProvider,
  BindingTransactionResult,
  BrowserContext,
  CeremonyTransaction,
  IdentityBinding,
  IdentitySession,
  Account,
  ProblemDetails,
  PublicKeyCredentialCreationOptionsJson,
  PublicKeyCredentialJson,
  PublicKeyCredentialRequestOptionsJson,
  RecoveryCodeRotation,
  RecoveryCodeStatus,
  RecoveryResult,
  RecoveryStart,
  RegistrationResult,
  RegistrationStart,
  ResourceList,
} from "./types";

/** 单次请求的额外认证语义。Additional authentication semantics for one request. */
export interface RequestControls {
  csrfToken?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** 状态变更必须携带的认证与重试控制。Authentication and retry controls required for state changes. */
export interface MutationControls extends RequestControls {
  csrfToken: string;
  idempotencyKey: string;
}

/** 可注入的 Fetch 签名，便于隔离浏览器与测试。Injectable Fetch signature for browser/test isolation. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * 可观测、类型化的 API 错误；绝不包含请求秘密。
 * Observable, typed API error that never contains request secrets.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly type: string;
  public readonly correlationId?: string;
  public readonly problem?: ProblemDetails;

  /** 根据已净化的问题详情创建错误。Constructs an error from a sanitized Problem Details response. */
  public constructor(status: number, problem?: ProblemDetails, correlationId?: string) {
    super(problem?.detail ?? problem?.title ?? `请求失败（HTTP ${status}）`);
    this.name = "ApiError";
    this.status = status;
    this.type = problem?.type ?? "about:blank";
    this.problem = problem;
    this.correlationId = correlationId ?? problem?.correlation_id;
  }
}

/**
 * Identity HTTP API 的强类型浏览器客户端。
 * Strongly typed browser client for the Identity HTTP API.
 *
 * @example
 * ```ts
 * const api = new IdentityApiClient("https://identity.moesegfault.dev");
 * const { account } = await api.getPrincipal();
 * ```
 */
export class IdentityApiClient {
  readonly #origin: string;
  readonly #fetch: FetchLike;

  /** 创建固定到可信 Identity origin 的客户端。Creates a client pinned to a trusted Identity origin. */
  public constructor(origin: string, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    const parsed = new URL(origin);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || !["https:", "http:"].includes(parsed.protocol)) {
      throw new TypeError("Identity API origin 必须是纯 HTTP(S) origin");
    }
    this.#origin = parsed.origin;
    this.#fetch = fetchImpl;
  }

  /** 建立或刷新匿名浏览器绑定和 CSRF token。Establishes or refreshes anonymous browser binding and CSRF token. */
  public getBrowserContext(signal?: AbortSignal) {
    return this.#request<BrowserContext>("/v1/browser-context", { method: "GET", signal });
  }

  /** 创建 Passkey 注册事务。Starts a passkey registration transaction. */
  public startRegistration(input: RegistrationStart, csrfToken: string, signal?: AbortSignal) {
    return this.#request<CeremonyTransaction<PublicKeyCredentialCreationOptionsJson>>(
      "/v1/registration-transactions",
      { method: "POST", body: input, csrfToken, idempotencyKey: createIdempotencyKey(), signal },
    );
  }

  /** 完成首个 Passkey 注册。Completes initial passkey registration. */
  public completeRegistration(transactionId: string, credential: PublicKeyCredentialJson, controls: MutationControls) {
    return this.#request<RegistrationResult>(
      `/v1/registration-transactions/${encodeURIComponent(transactionId)}/completion`,
      { method: "POST", body: { credential }, ...controls },
    );
  }

  /** 创建可发现凭据认证事务。Starts a discoverable-credential authentication transaction. */
  public startAuthentication(input: AuthenticationStart, csrfToken: string, signal?: AbortSignal) {
    return this.#request<CeremonyTransaction<PublicKeyCredentialRequestOptionsJson>>(
      "/v1/authentication-transactions",
      { method: "POST", body: input, csrfToken, idempotencyKey: createIdempotencyKey(), signal },
    );
  }

  /** 完成 Passkey assertion。Completes a passkey assertion. */
  public completeAuthentication(transactionId: string, credential: PublicKeyCredentialJson, controls: MutationControls) {
    return this.#request<AuthenticationResult>(
      `/v1/authentication-transactions/${encodeURIComponent(transactionId)}/completion`,
      { method: "POST", body: { credential }, ...controls },
    );
  }

  /** 以一次性恢复代码创建恢复事务。Starts recovery with a one-time recovery code. */
  public startRecovery(input: RecoveryStart, csrfToken: string, signal?: AbortSignal) {
    return this.#request<CeremonyTransaction<PublicKeyCredentialCreationOptionsJson>>(
      "/v1/recovery-transactions",
      { method: "POST", body: input, csrfToken, idempotencyKey: createIdempotencyKey(), signal },
    );
  }

  /** 消费恢复事务并取得受限 Passkey 注册事务。Consumes recovery and returns restricted passkey registration. */
  public completeRecovery(transactionId: string, csrfToken: string, credential: PublicKeyCredentialJson, signal?: AbortSignal) {
    return this.#request<RecoveryResult>(
      `/v1/recovery-transactions/${encodeURIComponent(transactionId)}/completion`,
      { method: "POST", body: { credential }, csrfToken, idempotencyKey: createIdempotencyKey(), signal },
    );
  }

  /** 读取当前 Principal。Reads the current principal. */
  public getPrincipal(signal?: AbortSignal) {
    return this.#request<AccountSessionEnvelope>("/v1/principals/self", { method: "GET", signal });
  }

  /** 修改可展示资料。Updates display-only profile fields. */
  public updatePrincipal(input: { display_name: string }, controls: MutationControls) {
    return this.#request<Account>("/v1/principals/self", { method: "PATCH", contentType: "application/merge-patch+json", body: input, ...controls });
  }

  /** 列出当前账号的全部 Passkey。Lists every passkey on the current account. */
  public listAuthenticators(signal?: AbortSignal) {
    return this.#request<ResourceList<Authenticator>>("/v1/principals/self/authenticators", {
      method: "GET",
      signal,
    });
  }

  /** 创建增加 Passkey 的事务；调用者为每次尝试提供新幂等键。Starts an add-passkey transaction with a caller-owned attempt key. */
  public startAuthenticatorRegistration(authenticatorLabel: string, controls: MutationControls) {
    return this.#request<CeremonyTransaction<PublicKeyCredentialCreationOptionsJson>>(
      "/v1/principals/self/authenticators/registration-transactions",
      { method: "POST", body: { authenticator_label: authenticatorLabel }, ...controls },
    );
  }

  /** 完成增加 Passkey，不把首次注册的恢复码语义泄露给调用处。Completes an add-passkey transaction without initial-registration secret semantics. */
  public completeAuthenticatorRegistration(transactionId: string, credential: PublicKeyCredentialJson, controls: MutationControls) {
    return this.#request<AuthenticatorRegistrationResult>(
      `/v1/registration-transactions/${encodeURIComponent(transactionId)}/completion`,
      { method: "POST", body: { credential }, ...controls },
    );
  }

  /** 重命名单个 Passkey。Renames a passkey. */
  public renameAuthenticator(authenticatorId: string, label: string, controls: MutationControls) {
    return this.#request<Authenticator>(
      `/v1/principals/self/authenticators/${encodeURIComponent(authenticatorId)}`,
      { method: "PATCH", contentType: "application/merge-patch+json", body: { label }, ...controls },
    );
  }

  /** 撤销单个 Passkey。Revokes one passkey. */
  public revokeAuthenticator(authenticatorId: string, controls: MutationControls) {
    return this.#request<void>(`/v1/principals/self/authenticators/${encodeURIComponent(authenticatorId)}`, {
      method: "DELETE",
      ...controls,
    });
  }

  /** 列出外部 Identity Bindings。Lists external identity bindings. */
  public listBindings(signal?: AbortSignal) {
    return this.#request<ResourceList<IdentityBinding>>("/v1/principals/self/bindings", {
      method: "GET",
      signal,
    });
  }

  /** 列出后端允许的 Binding providers。Lists server-allowlisted binding providers. */
  public listBindingProviders(signal?: AbortSignal) {
    return this.#request<ResourceList<BindingProvider>>("/v1/binding-providers", {
      method: "GET",
      signal,
    });
  }

  /** 发起外部 Binding，返回后端验证过的导航 URL。Starts an external binding and returns a server-approved navigation URL. */
  public startBinding(providerId: string, controls: MutationControls) {
    return this.#request<BindingTransactionResult>("/v1/binding-transactions", {
      method: "POST",
      body: { provider_id: providerId },
      ...controls,
    });
  }

  /** 解除外部 Binding。Removes an external identity binding. */
  public removeBinding(bindingId: string, controls: MutationControls) {
    return this.#request<void>(`/v1/principals/self/bindings/${encodeURIComponent(bindingId)}`, {
      method: "DELETE",
      ...controls,
    });
  }

  /** 列出 Identity Sessions。Lists identity sessions. */
  public listSessions(signal?: AbortSignal) {
    return this.#request<ResourceList<IdentitySession>>("/v1/principals/self/sessions", {
      method: "GET",
      signal,
    });
  }

  /** 撤销指定 Identity Session。Revokes one identity session. */
  public revokeSession(sessionId: string, controls: MutationControls) {
    return this.#request<void>(`/v1/principals/self/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      ...controls,
    });
  }

  /** 撤销全部 Identity Sessions。Revokes all identity sessions. */
  public revokeAllSessions(controls: MutationControls) {
    return this.#request<void>("/v1/principals/self/sessions", { method: "DELETE", ...controls });
  }

  /** 轮换并一次返回恢复代码。Rotates and returns recovery codes exactly once. */
  public rotateRecoveryCodes(controls: MutationControls) {
    return this.#request<RecoveryCodeRotation>("/v1/principals/self/recovery-codes/rotations", {
      method: "POST",
      body: {},
      ...controls,
    });
  }

  /** 读取恢复代码剩余数量，不返回秘密。Reads recovery-code counts without returning secrets. */
  public getRecoveryCodeStatus(signal?: AbortSignal) {
    return this.#request<RecoveryCodeStatus>("/v1/principals/self/recovery-codes", { method: "GET", signal });
  }

  /** 执行统一 JSON 请求并解析 RFC 9457 错误。Performs a JSON request and parses RFC 9457 errors. */
  async #request<T>(
    path: string,
    options: RequestControls & { method: "GET" | "POST" | "PATCH" | "DELETE"; contentType?: string; body?: unknown },
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", options.contentType ?? "application/json");
    if (options.csrfToken) headers.set("x-moesegfault-csrf", options.csrfToken);
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);

    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#origin), {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: options.signal,
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new ApiError(0, {
        type: "urn:moesegfault:problem:network_error",
        title: "无法连接身份服务",
        status: 0,
        detail: "请检查网络后重试。没有任何凭据被保存到此浏览器。",
      });
    }

    const correlationId = response.headers.get("x-moesegfault-correlation-id") ?? undefined;
    if (!response.ok) {
      throw new ApiError(response.status, await parseProblem(response), correlationId);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

/** 安全尝试解析问题详情，忽略代理生成的非 JSON 错误页。Safely parses Problem Details and ignores proxy HTML errors. */
async function parseProblem(response: Response): Promise<ProblemDetails | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined;
  try {
    return (await response.json()) as ProblemDetails;
  } catch {
    return undefined;
  }
}

/** 为不可安全重复的动作创建浏览器生命周期内幂等键。Creates a page-lifetime idempotency key for unsafe-to-repeat actions. */
export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}
