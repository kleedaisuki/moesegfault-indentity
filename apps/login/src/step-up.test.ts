import { describe, expect, it, vi } from "vitest";
import { ApiError, IdentityApiClient } from "./api/client";
import type {
  AuthenticationResult,
  CeremonyTransaction,
  ProblemDetails,
  PublicKeyCredentialJson,
  PublicKeyCredentialRequestOptionsJson,
} from "./api/types";
import { InlineStepUpCoordinator, isReauthenticationRequired } from "./step-up";
import type { HighRiskRequestControls } from "./step-up";

const REQUEST_OPTIONS: PublicKeyCredentialRequestOptionsJson = {
  challenge: "challenge",
  rp_id: "login.moesegfault.dev",
  user_verification: "required",
};

const CREDENTIAL = {
  id: "credential",
  raw_id: "credential",
  type: "public-key",
  authenticator_attachment: "platform",
  client_extension_results: {},
  response: {
    client_data_json: "client-data",
    authenticator_data: "authenticator-data",
    signature: "signature",
    user_handle: "user",
  },
} satisfies PublicKeyCredentialJson;

/** 创建后端指定的再认证问题。Creates the server-defined reauthentication problem. */
function reauthenticationRequired(): ApiError {
  const problem: ProblemDetails = {
    type: "https://identity.moesegfault.dev/problems/reauthentication_required",
    title: "Recent Passkey authentication is required",
    status: 403,
    error_code: "reauthentication_required",
  };
  return new ApiError(403, problem);
}

/** 创建 session cookie 已轮换时的精确 CSRF 问题。Creates the exact CSRF problem emitted after session-cookie rotation. */
function csrfValidationFailed(): ApiError {
  return new ApiError(403, {
    type: "https://identity.moesegfault.dev/problems/invalid_request",
    title: "CSRF validation failed",
    status: 403,
    error_code: "invalid_request",
  });
}

/** 构造只暴露协调器所需方法的 API 替身。Builds an API double exposing only coordinator methods. */
function apiDouble() {
  const transaction: CeremonyTransaction<PublicKeyCredentialRequestOptionsJson> = {
    transaction_id: "tx-step-up",
    csrf_token: "csrf-transaction",
    expires_at: "2026-09-13T08:00:00Z",
    public_key: REQUEST_OPTIONS,
  };
  const result = { csrf_token: "csrf-replacement" } as AuthenticationResult;
  return {
    startAuthentication: vi.fn(async () => transaction),
    completeAuthentication: vi.fn(async () => result),
  };
}

describe("InlineStepUpCoordinator", () => {
  it("performs inline assertion, rotates in-memory CSRF, and retries with a fresh key", async () => {
    let sessionCsrf = "csrf-old";
    const api = apiDouble();
    const getAssertion = vi.fn(async () => CREDENTIAL);
    const operation = vi.fn(async (_controls: HighRiskRequestControls) => {
      if (operation.mock.calls.length === 1) throw reauthenticationRequired();
      return "completed";
    });
    const coordinator = new InlineStepUpCoordinator(api as unknown as IdentityApiClient, {
      readSessionCsrf: async () => sessionCsrf,
      refreshSessionCsrf: async () => sessionCsrf,
      readBrowserCsrf: async () => "csrf-browser",
      rememberSessionCsrf: (token) => { sessionCsrf = token; },
      getAssertion,
    });
    const onStepUpRequired = vi.fn();

    await expect(coordinator.execute(operation, {
      signal: new AbortController().signal,
      onStepUpRequired,
    })).resolves.toBe("completed");

    expect(onStepUpRequired).toHaveBeenCalledOnce();
    expect(api.startAuthentication).toHaveBeenCalledWith(
      { purpose: "step_up" },
      "csrf-browser",
      expect.any(AbortSignal),
    );
    expect(getAssertion).toHaveBeenCalledWith(REQUEST_OPTIONS, expect.any(AbortSignal));
    expect(api.completeAuthentication).toHaveBeenCalledWith(
      "tx-step-up",
      CREDENTIAL,
      expect.objectContaining({ csrfToken: "csrf-transaction", signal: expect.any(AbortSignal) }),
    );
    expect(sessionCsrf).toBe("csrf-replacement");
    const [firstControls] = operation.mock.calls[0] ?? [];
    const [retryControls] = operation.mock.calls[1] ?? [];
    expect(firstControls).toMatchObject({ csrfToken: "csrf-old" });
    expect(retryControls).toMatchObject({ csrfToken: "csrf-replacement" });
    expect(retryControls?.idempotencyKey).not.toBe(firstControls?.idempotencyKey);
  });

  it("does not turn an unrelated forbidden response into a passkey prompt", async () => {
    const api = apiDouble();
    const forbidden = new ApiError(403, {
      type: "https://identity.moesegfault.dev/problems/invalid_request",
      title: "CSRF validation failed",
      status: 403,
      error_code: "invalid_request",
    });
    const coordinator = new InlineStepUpCoordinator(api as unknown as IdentityApiClient, {
      readSessionCsrf: async () => "csrf-old",
      refreshSessionCsrf: async () => "csrf-refreshed",
      readBrowserCsrf: async () => "csrf-browser",
      rememberSessionCsrf: vi.fn(),
      getAssertion: vi.fn(async () => CREDENTIAL),
    });

    await expect(coordinator.execute(async () => { throw forbidden; }, {
      signal: new AbortController().signal,
    })).rejects.toBe(forbidden);

    expect(api.startAuthentication).not.toHaveBeenCalled();
    expect(isReauthenticationRequired(forbidden)).toBe(false);
  });

  it("retries only once when recent authentication is still rejected", async () => {
    const api = apiDouble();
    const operation = vi.fn(async (_controls: HighRiskRequestControls) => { throw reauthenticationRequired(); });
    const coordinator = new InlineStepUpCoordinator(api as unknown as IdentityApiClient, {
      readSessionCsrf: async () => "csrf-old",
      refreshSessionCsrf: async () => "csrf-refreshed",
      readBrowserCsrf: async () => "csrf-browser",
      rememberSessionCsrf: vi.fn(),
      getAssertion: vi.fn(async () => CREDENTIAL),
    });

    await expect(coordinator.execute(operation, {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ status: 403 });

    expect(operation).toHaveBeenCalledTimes(2);
    expect(api.startAuthentication).toHaveBeenCalledOnce();
  });

  it("shares one ceremony across concurrent high-risk operations", async () => {
    let sessionCsrf = "csrf-old";
    const api = apiDouble();
    const coordinator = new InlineStepUpCoordinator(api as unknown as IdentityApiClient, {
      readSessionCsrf: async () => sessionCsrf,
      refreshSessionCsrf: async () => sessionCsrf,
      readBrowserCsrf: async () => "csrf-browser",
      rememberSessionCsrf: (token) => { sessionCsrf = token; },
      getAssertion: vi.fn(async () => CREDENTIAL),
    });
    const first = vi.fn(async (controls: HighRiskRequestControls) => {
      if (first.mock.calls.length === 1) throw reauthenticationRequired();
      return controls.csrfToken;
    });
    const second = vi.fn(async (controls: HighRiskRequestControls) => {
      if (second.mock.calls.length === 1) throw reauthenticationRequired();
      return controls.csrfToken;
    });
    const signal = new AbortController().signal;

    await expect(Promise.all([
      coordinator.execute(first, { signal }),
      coordinator.execute(second, { signal }),
    ])).resolves.toEqual(["csrf-replacement", "csrf-replacement"]);

    expect(api.startAuthentication).toHaveBeenCalledOnce();
    expect(api.completeAuthentication).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("refreshes stale per-tab CSRF after another tab rotates the shared cookie", async () => {
    const api = apiDouble();
    const operation = vi.fn(async (controls: HighRiskRequestControls) => {
      if (operation.mock.calls.length === 1) throw csrfValidationFailed();
      return controls.csrfToken;
    });
    const refreshSessionCsrf = vi.fn(async () => "csrf-from-current-cookie");
    const coordinator = new InlineStepUpCoordinator(api as unknown as IdentityApiClient, {
      readSessionCsrf: async () => "csrf-from-old-cookie",
      refreshSessionCsrf,
      readBrowserCsrf: async () => "csrf-browser",
      rememberSessionCsrf: vi.fn(),
      getAssertion: vi.fn(async () => CREDENTIAL),
    });

    await expect(coordinator.execute(operation, {
      signal: new AbortController().signal,
    })).resolves.toBe("csrf-from-current-cookie");

    expect(refreshSessionCsrf).toHaveBeenCalledOnce();
    expect(api.startAuthentication).not.toHaveBeenCalled();
    const [firstControls] = operation.mock.calls[0] ?? [];
    const [retryControls] = operation.mock.calls[1] ?? [];
    expect(retryControls?.idempotencyKey).not.toBe(firstControls?.idempotencyKey);
  });

  it("restarts a ceremony when an old route aborts the shared attempt", async () => {
    let sessionCsrf = "csrf-old";
    const firstRoute = new AbortController();
    const secondRoute = new AbortController();
    const thirdRoute = new AbortController();
    const abandonedWaiterRoute = new AbortController();
    const api = apiDouble();
    const getAssertion = vi.fn(async (_options: PublicKeyCredentialRequestOptionsJson, signal?: AbortSignal) => {
      if (getAssertion.mock.calls.length > 1) return CREDENTIAL;
      return new Promise<PublicKeyCredentialJson>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    const coordinator = new InlineStepUpCoordinator(api as unknown as IdentityApiClient, {
      readSessionCsrf: async () => sessionCsrf,
      refreshSessionCsrf: async () => sessionCsrf,
      readBrowserCsrf: async () => "csrf-browser",
      rememberSessionCsrf: (token) => { sessionCsrf = token; },
      getAssertion,
    });
    const first = vi.fn(async (controls: HighRiskRequestControls) => {
      if (first.mock.calls.length === 1) throw reauthenticationRequired();
      return controls.csrfToken;
    });
    const second = vi.fn(async (controls: HighRiskRequestControls) => {
      if (second.mock.calls.length === 1) throw reauthenticationRequired();
      return controls.csrfToken;
    });
    const third = vi.fn(async (controls: HighRiskRequestControls) => {
      if (third.mock.calls.length === 1) throw reauthenticationRequired();
      return controls.csrfToken;
    });
    const abandonedWaiter = vi.fn(async (controls: HighRiskRequestControls) => {
      if (abandonedWaiter.mock.calls.length === 1) throw reauthenticationRequired();
      return controls.csrfToken;
    });

    const abandoned = coordinator.execute(first, { signal: firstRoute.signal }).catch((error: unknown) => error);
    const active = coordinator.execute(second, { signal: secondRoute.signal });
    const alsoActive = coordinator.execute(third, { signal: thirdRoute.signal });
    const abandonedWhileWaiting = coordinator.execute(abandonedWaiter, { signal: abandonedWaiterRoute.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(getAssertion).toHaveBeenCalledOnce());
    abandonedWaiterRoute.abort();
    await expect(abandonedWhileWaiting).resolves.toMatchObject({ name: "AbortError" });
    firstRoute.abort();

    await expect(abandoned).resolves.toMatchObject({ name: "AbortError" });
    await expect(active).resolves.toBe("csrf-replacement");
    await expect(alsoActive).resolves.toBe("csrf-replacement");
    expect(api.startAuthentication).toHaveBeenCalledTimes(2);
    expect(getAssertion).toHaveBeenCalledTimes(2);
    expect(abandonedWaiter).toHaveBeenCalledOnce();
  });
});
