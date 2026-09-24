import { apiOrigin, parseProblem } from "@moesegfault/frontend-shared";
import type { Account, AccountPreferences, Avatar, ConnectedApp, Contact, ContactCreate, ContactVerificationTransaction, Credential, MeEnvelope, MutationProof, ProblemDetails, ProfilePatch, ResourceList, SecuritySummary, Session } from "./types";

/** 可注入的 Fetch 接口。Injectable Fetch interface. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 可安全展示且携带关联 ID 的 API 错误。Display-safe API error carrying a correlation ID. */
export class ApiError extends Error {
  /** 从后端问题详情构造错误。Constructs an error from backend Problem Details. */
  public constructor(public readonly status: number, public readonly problem?: ProblemDetails, public readonly correlationId?: string) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

/**
 * account.moesegfault.dev 使用的强类型私有 API 客户端。
 * Typed private API client used by account.moesegfault.dev.
 *
 * @example
 * ```ts
 * const api = new AccountApiClient("https://identity.moesegfault.dev");
 * const profile = await api.getMe();
 * ```
 */
export class AccountApiClient {
  readonly #origin: string;
  readonly #fetch: FetchLike;
  /** 让应用外壳在任意 401 上同步撤销本地会话。Lets the application shell synchronously revoke local session state on any 401. */
  readonly #onUnauthorized: () => void;
  public constructor(origin: string, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis), onUnauthorized: () => void = () => undefined) {
    this.#origin = apiOrigin(origin);
    this.#fetch = fetchImpl;
    this.#onUnauthorized = onUnauthorized;
  }

  /** 读取当前用户。Reads the current user. */
  public getMe(signal?: AbortSignal) { return this.#request<MeEnvelope>("/v1/me", { method: "GET", signal }); }
  /** 修改资料。Updates the profile. */
  public updateMe(patch: ProfilePatch, proof: MutationProof) { return this.#request<Account>("/v1/me", { method: "PATCH", body: patch, contentType: "application/merge-patch+json", ...proof }); }
  /** 上传浏览器已准备的头像文件。Uploads the browser-prepared avatar file. */
  public uploadAvatar(file: File, proof: MutationProof) { const body = new FormData(); body.set("avatar", file); return this.#request<Avatar>("/v1/me/avatar", { method: "POST", body, ...proof }); }
  /** 删除头像。Deletes the avatar. */
  public deleteAvatar(proof: MutationProof) { return this.#request<void>("/v1/me/avatar", { method: "DELETE", ...proof }); }
  /** 列出联系方式。Lists private contacts. */
  public listContacts(signal?: AbortSignal) { return this.#request<Contact[]>("/v1/me/contacts", { method: "GET", signal }); }
  /** 添加联系方式；验证由后端异步挑战。Adds a contact; backend verification follows. */
  public addContact(input: ContactCreate, proof: MutationProof) { return this.#request<Contact>("/v1/me/contacts", { method: "POST", body: input, ...proof }); }
  /** 把联系方式设为主要联系方式。Makes one contact primary. */
  public makePrimary(contactId: string, proof: MutationProof) { return this.#request<Contact>(`/v1/me/contacts/${encodeURIComponent(contactId)}`, { method: "PATCH", body: { is_primary: true }, contentType: "application/merge-patch+json", ...proof }); }
  /** 发送联系方式验证码。Sends a contact verification code. */
  public startContactVerification(contactId: string, proof: MutationProof) { return this.#request<ContactVerificationTransaction>(`/v1/me/contacts/${encodeURIComponent(contactId)}/verification-transactions`, { method: "POST", body: {}, ...proof }); }
  /** 完成联系方式验证。Completes contact verification. */
  public completeContactVerification(contactId: string, transactionId: string, code: string, proof: MutationProof) { return this.#request<Contact>(`/v1/me/contacts/${encodeURIComponent(contactId)}/verification-transactions/${encodeURIComponent(transactionId)}/completion`, { method: "POST", body: { code }, ...proof }); }
  /** 删除联系方式。Deletes a contact. */
  public deleteContact(contactId: string, proof: MutationProof) { return this.#request<void>(`/v1/me/contacts/${encodeURIComponent(contactId)}`, { method: "DELETE", ...proof }); }
  /** 读取安全能力摘要。Reads the security capability summary. */
  public getSecurity(signal?: AbortSignal) { return this.#request<SecuritySummary>("/v1/me/security", { method: "GET", signal }); }
  /** 读取账户界面偏好。Reads Account UI preferences. */
  public getPreferences(signal?: AbortSignal) { return this.#request<AccountPreferences>("/v1/me/preferences", { method: "GET", signal }); }
  /** 更新账户界面偏好。Updates Account UI preferences. */
  public updatePreferences(input: Partial<AccountPreferences>, proof: MutationProof) { return this.#request<AccountPreferences>("/v1/me/preferences", { method: "PATCH", body: input, contentType: "application/merge-patch+json", ...proof }); }
  /** 设置或替换密码。Sets or replaces the password. */
  public setPassword(password: string, proof: MutationProof, currentPassword?: string) { return this.#request<void>("/v1/me/password", { method: "PUT", body: { new_password: password, ...(currentPassword ? { current_password: currentPassword } : {}) }, ...proof }); }
  /** 删除密码，但 Passkey 或未来 MFA 必须仍可登录。Deletes the password while another sign-in method remains. */
  public deletePassword(proof: MutationProof) { return this.#request<void>("/v1/me/password", { method: "DELETE", ...proof }); }
  /** 列出 Passkey。Lists passkeys. */
  public listCredentials(signal?: AbortSignal) { return this.#request<ResourceList<Credential>>("/v1/principals/self/authenticators", { method: "GET", signal }); }
  /** 重命名 Passkey。Renames a passkey. */
  public renameCredential(id: string, label: string, proof: MutationProof) { return this.#request<Credential>(`/v1/principals/self/authenticators/${encodeURIComponent(id)}`, { method: "PATCH", body: { label }, contentType: "application/merge-patch+json", ...proof }); }
  /** 撤销 Passkey。Revokes a passkey. */
  public revokeCredential(id: string, proof: MutationProof) { return this.#request<void>(`/v1/principals/self/authenticators/${encodeURIComponent(id)}`, { method: "DELETE", ...proof }); }
  /** 列出所有会话。Lists all sessions. */
  public listSessions(signal?: AbortSignal) { return this.#request<ResourceList<Session>>("/v1/principals/self/sessions", { method: "GET", signal }); }
  /** 撤销会话。Revokes a session. */
  public revokeSession(id: string, proof: MutationProof) { return this.#request<void>(`/v1/principals/self/sessions/${encodeURIComponent(id)}`, { method: "DELETE", ...proof }); }
  /** 列出第三方授权。Lists third-party grants. */
  public listConnectedApps(signal?: AbortSignal) { return this.#request<ResourceList<ConnectedApp>>("/v1/me/authorizations", { method: "GET", signal }); }
  /** 撤销第三方授权。Revokes a third-party grant. */
  public revokeConnectedApp(id: string, proof: MutationProof) { return this.#request<void>(`/v1/me/authorizations/${encodeURIComponent(id)}`, { method: "DELETE", ...proof }); }

  /** 统一编码请求及 RFC 9457 错误。Uniformly encodes requests and RFC 9457 errors. */
  async #request<T>(path: string, options: { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown; contentType?: string; csrfToken?: string; idempotencyKey?: string; signal?: AbortSignal }): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    const isForm = options.body instanceof FormData;
    if (options.body !== undefined && !isForm) headers.set("Content-Type", options.contentType ?? "application/json");
    if (options.csrfToken) headers.set("x-moesegfault-csrf", options.csrfToken);
    if (options.method !== "GET") headers.set("Idempotency-Key", options.idempotencyKey ?? crypto.randomUUID());
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#origin), { method: options.method, headers, body: options.body === undefined || isForm ? options.body as BodyInit | undefined : JSON.stringify(options.body), credentials: "include", cache: "no-store", redirect: "error", signal: options.signal });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new ApiError(0, { type: "urn:moesegfault:problem:network", title: "Network unavailable", status: 0, detail: "Unable to reach the identity service." });
    }
    if (!response.ok) {
      if (response.status === 401) this.#onUnauthorized();
      throw new ApiError(response.status, await parseProblem<ProblemDetails>(response), response.headers.get("x-moesegfault-correlation-id") ?? undefined);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}
