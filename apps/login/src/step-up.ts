import { ApiError, createIdempotencyKey, IdentityApiClient } from "./api/client";
import type { MutationControls } from "./api/client";
import type { PublicKeyCredentialJson, PublicKeyCredentialRequestOptionsJson } from "./api/types";
import { getPasskey } from "./webauthn/ceremony";

/** 高风险请求始终具有当前 CSRF、本次幂等键与取消信号。High-risk controls always carry current CSRF, an attempt key, and cancellation. */
export interface HighRiskRequestControls extends MutationControls {
  csrfToken: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

/** 可测试的 Passkey assertion 边界。Testable boundary for obtaining a passkey assertion. */
export type AssertionProvider = (
  options: PublicKeyCredentialRequestOptionsJson,
  signal?: AbortSignal,
) => Promise<PublicKeyCredentialJson>;

/** 协调器的内存令牌与浏览器上下文端口。In-memory token and browser-context ports used by the coordinator. */
export interface StepUpPorts {
  readSessionCsrf(signal: AbortSignal): Promise<string>;
  refreshSessionCsrf(signal: AbortSignal): Promise<string>;
  readBrowserCsrf(signal: AbortSignal): Promise<string>;
  rememberSessionCsrf(token: string): void;
  getAssertion?: AssertionProvider;
}

/** 一次执行的可观测回调。Observable callbacks for one execution. */
export interface StepUpExecution {
  signal: AbortSignal;
  onStepUpRequired?(): void;
}

/**
 * 内联完成 Passkey 再认证，然后仅重试一次原操作。
 * Completes inline passkey reauthentication and then retries the original operation exactly once.
 *
 * 协调器只保存页面内的进度 Promise 和代际计数；不读写 Web Storage。
 * The coordinator keeps only an in-page progress promise and generation counter; it never touches Web Storage.
 *
 * @example
 * ```ts
 * await coordinator.execute(
 *   (controls) => api.revokeAuthenticator(id, controls),
 *   { signal, onStepUpRequired: () => showPasskeyPrompt() },
 * );
 * ```
 */
export class InlineStepUpCoordinator {
  readonly #api: IdentityApiClient;
  readonly #ports: StepUpPorts;
  #generation = 0;
  #inFlight?: { signal: AbortSignal; promise: Promise<string> };

  /** 为单个 Identity API 客户端创建页面级协调器。Creates a page-scoped coordinator for one Identity API client. */
  public constructor(api: IdentityApiClient, ports: StepUpPorts) {
    this.#api = api;
    this.#ports = ports;
  }

  /**
   * 执行高风险操作；只对精确的 `reauthentication_required` 问题再认证。
   * Executes a high-risk operation; only the exact `reauthentication_required` problem triggers step-up.
   */
  public async execute<T>(
    operation: (controls: HighRiskRequestControls) => Promise<T>,
    execution: StepUpExecution,
  ): Promise<T> {
    const observedGeneration = this.#generation;
    const csrfToken = await this.#ports.readSessionCsrf(execution.signal);
    let failure: unknown;
    try {
      return await operation(requestControls(csrfToken, execution.signal));
    } catch (error) {
      failure = error;
    }

    // Another tab may have rotated the shared HttpOnly session cookie while this
    // tab still holds the old per-tab CSRF value. Refresh and retry once before
    // deciding whether a passkey ceremony is required.
    if (isCsrfValidationFailed(failure)) {
      const refreshedCsrf = await this.#ports.refreshSessionCsrf(execution.signal);
      try {
        return await operation(requestControls(refreshedCsrf, execution.signal));
      } catch (error) {
        failure = error;
      }
    }
    if (!isReauthenticationRequired(failure)) throw failure;

    const needsCeremony = observedGeneration === this.#generation;
    if (needsCeremony) execution.onStepUpRequired?.();
    const retryCsrf = needsCeremony
      ? await this.#stepUp(execution.signal)
      : await this.#ports.refreshSessionCsrf(execution.signal);
    return operation(requestControls(retryCsrf, execution.signal));
  }

  /** 共享 ceremony；若旧路由取消了它，新路由会独立重启。Shares a ceremony, restarting independently when an old route cancels it. */
  async #stepUp(signal: AbortSignal): Promise<string> {
    const current = this.#inFlight;
    if (current) {
      try {
        return await waitForSharedCeremony(current.promise, signal);
      } catch (error) {
        if (current.signal === signal || signal.aborted) throw error;
        if (this.#inFlight === current) this.#inFlight = undefined;
        return this.#stepUp(signal);
      }
    }
    const flight = { signal, promise: this.#performStepUp(signal) };
    this.#inFlight = flight;
    try {
      return await flight.promise;
    } finally {
      if (this.#inFlight === flight) this.#inFlight = undefined;
    }
  }

  /** 启动并完成与当前页面绑定的 assertion ceremony。Starts and completes the assertion ceremony bound to this page. */
  async #performStepUp(signal: AbortSignal): Promise<string> {
    const browserCsrf = await this.#ports.readBrowserCsrf(signal);
    const transaction = await this.#api.startAuthentication({ purpose: "step_up" }, browserCsrf, signal);
    const credential = await (this.#ports.getAssertion ?? getPasskey)(transaction.public_key, signal);
    const result = await this.#api.completeAuthentication(transaction.transaction_id, credential, {
      csrfToken: transaction.csrf_token,
      idempotencyKey: createIdempotencyKey(),
      signal,
    });
    this.#ports.rememberSessionCsrf(result.csrf_token);
    this.#generation += 1;
    return result.csrf_token;
  }
}

/** 仅识别服务端结构化错误码，不把普通 403 误当作 ceremony 提示。Recognizes the structured server code, never a generic 403. */
export function isReauthenticationRequired(error: unknown): boolean {
  return error instanceof ApiError && error.problem?.error_code === "reauthentication_required";
}

/** 精确识别 cookie 轮换后的旧 CSRF，允许跨标签页恢复。Recognizes stale CSRF after cookie rotation so another tab can recover. */
export function isCsrfValidationFailed(error: unknown): boolean {
  return error instanceof ApiError
    && error.problem?.error_code === "invalid_request"
    && error.problem.title === "CSRF validation failed";
}

/** 为每次初试或重试现场创建新幂等键。Creates a fresh idempotency key at each initial or retry attempt. */
function requestControls(csrfToken: string, signal: AbortSignal): HighRiskRequestControls {
  return { csrfToken, idempotencyKey: createIdempotencyKey(), signal };
}

/** 让等待者可独立取消，但不中断其他调用者共享的 ceremony。Lets a waiter cancel independently without aborting the shared ceremony. */
function waitForSharedCeremony<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}
