import { ApiError, createIdempotencyKey, IdentityApiClient } from "./api/client";
import type { AccountSessionEnvelope, DeviceAuthorization, DeviceDecision } from "./api/types";
import { deviceUserCode } from "./environment";
import { translate, type MessageKey } from "./i18n";
import { PageLifecycle } from "./page-lifecycle";
import { el, errorMessage, field, replace, statePanel } from "./ui/dom";
import { pageHeading } from "./ui/shell";

/** The public code identifies intent; only a separate explicit decision grants access. */
export async function renderDeviceAuthorization(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, lifecycle: PageLifecycle): Promise<void> {
  const t = (key: MessageKey): string => translate(lifecycle.locale, key);
  let code = deviceUserCode(location) ?? "";
  let stage: "entry" | "signin" | "confirmation" | "approved" | "denied" = "entry";
  let session: AccountSessionEnvelope | undefined;
  let request: DeviceAuthorization | undefined;
  let expiresAt = 0;
  let busy = false;
  let failure: unknown;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener("abort", () => clearTimeout(expiryTimer), { once: true });

  const controls = (csrfToken: string) => ({ csrfToken, idempotencyKey: createIdempotencyKey(), signal });
  const showFailure = (): HTMLElement | undefined => {
    if (!failure) return undefined;
    const detail = failure instanceof ApiError && failure.problem?.error_code === "expired_token"
      ? t("deviceExpired") : errorMessage(failure);
    const panel = statePanel("error", t("deviceFailed"), detail);
    if (failure instanceof ApiError && failure.correlationId) panel.append(el("code", {}, failure.correlationId));
    return panel;
  };

  const project = (): void => {
    if (signal.aborted) return;
    lifecycle.present(project);
    const heading = pageHeading("DEVICE_AUTHORIZATION", t("deviceTitle"), t("deviceIntro"));
    if (stage === "approved" || stage === "denied") {
      replace(main, heading, statePanel(stage === "approved" ? "success" : "info", t(stage === "approved" ? "deviceApproved" : "deviceDenied"), t("deviceReturn")));
      return;
    }
    if (stage === "signin") {
      const href = `/login?${new URLSearchParams({ device_user_code: code })}`;
      replace(main, heading, statePanel("info", t("deviceSignIn"), t("deviceSignInIntro"), el("a", { className: "button button--primary", attrs: { href } }, t("login"))), showFailure());
      return;
    }
    if (stage === "confirmation" && request && session) {
      const expired = Date.now() >= expiresAt;
      const approve = el("button", { className: "button button--primary", attrs: { type: "button", disabled: busy || expired } }, t("deviceApprove"));
      const deny = el("button", { className: "button button--secondary", attrs: { type: "button", disabled: busy || expired } }, t("deviceDeny"));
      approve.addEventListener("click", () => { void decide("approve"); });
      deny.addEventListener("click", () => { void decide("deny"); });
      const accountIdentifier = session.account.identifiers.find(identifier => identifier.kind === "username")
        ?? session.account.identifiers.find(identifier => identifier.kind === "email" && identifier.is_primary);
      const details = el("dl", { className: "device-details" },
        el("dt", {}, t("deviceApplication")), el("dd", {}, request.client_name, el("small", {}, request.client_id)),
        el("dt", {}, t("deviceAccount")), el("dd", {}, session.account.profile.display_name, accountIdentifier && el("small", {}, accountIdentifier.value)),
        el("dt", {}, t("deviceCode")), el("dd", {}, el("code", { className: "device-code" }, request.user_code)),
        el("dt", {}, t("deviceScope")), el("dd", {}, request.scope),
        el("dt", {}, t("deviceExpires")), el("dd", {}, new Intl.DateTimeFormat(lifecycle.locale, { timeStyle: "short" }).format(expiresAt)));
      replace(main, heading, el("section", { className: "moe-glass auth-card" },
        el("h2", {}, t("deviceReview")), details, el("p", { className: "hint hint--warning" }, t("deviceWarning")),
        expired && statePanel("info", t("deviceExpired"), t("deviceRestart")),
        el("div", { className: "button-pair" }, approve, deny),
        busy && el("p", { className: "hint", attrs: { role: "status" } }, t("deviceDeciding")), showFailure()));
      return;
    }
    const input = field(t("deviceCode"), "user_code", { required: true, autocomplete: "one-time-code", value: code, placeholder: "ABCD-EFGH" });
    const control = input.querySelector("input")!;
    control.disabled = busy;
    control.autocapitalize = "characters";
    control.spellcheck = false;
    control.addEventListener("input", () => { code = control.value; });
    const form = el("form", { className: "moe-glass auth-card auth-form" }, input,
      el("button", { className: "button button--primary button--wide", attrs: { type: "submit", disabled: busy } }, t(busy ? "deviceLoading" : "deviceContinue")), showFailure());
    form.addEventListener("submit", event => { event.preventDefault(); void lookup(); });
    replace(main, heading, form);
  };

  const lookup = async (): Promise<void> => {
    if (busy || signal.aborted) return;
    code = code.trim();
    if (!code) return;
    busy = true; failure = undefined;
    const release = lifecycle.hold();
    project();
    try {
      session = await api.getPrincipal(signal);
      if (signal.aborted) return;
      request = await api.lookupDeviceAuthorization(code, controls(session.csrf_token));
      if (signal.aborted) return;
      code = request.user_code;
      stage = "confirmation";
      expiresAt = Date.now() + request.expires_in * 1000;
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(project, request.expires_in * 1000);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) stage = "signin";
      else failure = error;
    } finally {
      busy = false; project(); release();
    }
  };

  const decide = async (decision: DeviceDecision): Promise<void> => {
    if (busy || signal.aborted || !session || Date.now() >= expiresAt) return;
    busy = true; failure = undefined;
    const release = lifecycle.hold();
    project();
    try {
      // A shared session may change in another tab after this account was displayed.
      const current = await api.getPrincipal(signal);
      if (signal.aborted) return;
      if (current.account.principal_id !== session.account.principal_id) {
        stage = "entry"; request = undefined;
        throw new Error(t("deviceAccountChanged"));
      }
      const result = await api.decideDeviceAuthorization(code, decision, controls(current.csrf_token));
      if (signal.aborted) return;
      stage = result.state;
      clearTimeout(expiryTimer);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) stage = "signin";
      if (error instanceof ApiError && error.problem?.error_code === "expired_token") expiresAt = Date.now();
      failure = error;
    } finally {
      busy = false; project(); release();
    }
  };

  project();
  if (code) await lookup();
}
