import { IdentityApiClient, ApiError } from "./api/client";
import type { MessageKey } from "./i18n";
import type { RegistrationEmailAuthorizationContext } from "./api/types";
import { el, field, replace, statePanel } from "./ui/dom";

/** In-memory proof for one mailbox; verification alone never creates an account. */
export interface VerifiedRegistrationEmail { email: string; token: string; expiresAt: string; csrfToken: string; }

/** Inline email controls owned by the full registration form, never a separate wizard page. */
export interface RegistrationEmailVerifier {
  element: HTMLElement;
  /** Updates copy without replacing controls, proof, pending challenge, or timers. */
  relocalize(t: (key: MessageKey) => string): void;
  /** Returns a valid proof for the displayed mailbox, otherwise invalidates only email state. */
  verified(): VerifiedRegistrationEmail | undefined;
  /** Starts verification or focuses a pending challenge without replacing the form. */
  requestVerification(): Promise<void>;
  /** Locks mailbox changes together with final account creation. */
  setDisabled(disabled: boolean): void;
}

/** Supplies current page-realm OAuth context without persisting or synthesizing it. */
export interface RegistrationEmailVerifierOptions {
  /** Keeps cosmetic rebuilds out of unresolved server mutations. */
  hold?: () => () => void;
  /** Reads the pending OAuth handle; omit for standalone registration. */
  authorizationTransactionId?: () => string | undefined;
}

/** Creates form-safe mailbox verification; profile/password/avatar nodes stay untouched. */
export function createRegistrationEmailVerifier(api: IdentityApiClient, signal: AbortSignal,
  t: (key: MessageKey) => string, options: RegistrationEmailVerifierOptions = {}): RegistrationEmailVerifier {
  /** Server-side validation, not this projection, decides whether renewal is permitted. */
  const authorizationContext = (): RegistrationEmailAuthorizationContext => {
    const id = options.authorizationTransactionId?.();
    return id ? { authorization_transaction_id: id } : {};
  };
  const emailField = field(t("email"), "email", { required: true, type: "email", autocomplete: "email", icon: "mail" });
  const emailInput = emailField.querySelector<HTMLInputElement>("input")!;
  const send = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("sendSignupCode"));
  const change = el("button", { className: "button button--secondary", attrs: { type: "button", hidden: true } }, t("changeSignupEmail"));
  const codeField = field(t("verificationCode"), "code", { required: true, autocomplete: "one-time-code", pattern: "[0-9]{8}", minlength: "8", icon: "lock" });
  const codeInput = codeField.querySelector<HTMLInputElement>("input")!;
  codeInput.inputMode = "numeric"; codeInput.maxLength = 8;
  const confirm = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("confirmEmail"));
  const codePanel = el("div", { className: "registration-email__code", attrs: { hidden: true } }, codeField, confirm);
  const status = el("div", { className: "inline-state", attrs: { "aria-live": "polite" } });
  const element = el("section", { className: "registration-email", attrs: { "aria-label": t("email") } },
    el("div", { className: "registration-email__address" }, emailField, el("div", { className: "button-pair" }, send, change)),
    el("p", { className: "hint" }, t("signupEmailIntro")), codePanel, status);
  let transaction: Awaited<ReturnType<IdentityApiClient["startRegistrationEmail"]>> | undefined;
  let proof: VerifiedRegistrationEmail | undefined;
  let destination = "";
  let csrfToken = "";
  let busy: "sending" | "confirming" | undefined;
  let locked = false;
  // Expiry is terminal for this page's OAuth request; email retries must not revive it.
  let authorizationExpired = false;
  let resendAt = 0;
  let cooldown: ReturnType<typeof setTimeout> | undefined;

  /** One projection prevents cooldown timers from unlocking an in-flight operation. */
  const sync = (): void => {
    emailInput.readOnly = Boolean(transaction || proof || busy);
    emailInput.disabled = locked;
    codeInput.disabled = locked || authorizationExpired || !transaction || Boolean(proof);
    codePanel.hidden = !transaction || Boolean(proof);
    change.hidden = !transaction && !proof;
    change.disabled = locked || authorizationExpired || Boolean(busy);
    send.hidden = Boolean(proof);
    send.disabled = locked || authorizationExpired || Boolean(busy) || resendAt > Date.now();
    const sendLabel = transaction ? t("resendCode") : t("sendSignupCode");
    const secondsRemaining = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    send.textContent = busy === "sending" ? t("sendingCode") : secondsRemaining ? `${sendLabel} (${secondsRemaining}s)` : sendLabel;
    confirm.disabled = locked || authorizationExpired || Boolean(busy);
    confirm.textContent = busy === "confirming" ? t("verifyingCode") : t("confirmEmail");
  };
  /** Refreshes visible server-imposed cooldown without announcing every tick. */
  const tickCooldown = (): void => {
    sync();
    const remaining = resendAt - Date.now();
    if (remaining > 0 && !signal.aborted) cooldown = setTimeout(tickCooldown, Math.min(1000, remaining));
  };
  const waitToResend = (until: number): void => {
    clearTimeout(cooldown);
    resendAt = Number.isFinite(until) ? until : 0;
    tickCooldown();
  };
  let projectStatus: (() => void) | undefined;
  const showStatus = (kind: "error" | "info" | "success", title: MessageKey, detail: () => string): void => {
    projectStatus = () => replace(status, statePanel(kind, t(title), detail()));
    projectStatus();
  };
  const showError = (error: unknown, title: MessageKey): void => {
    const code = error instanceof ApiError ? error.problem?.error_code : undefined;
    if (code === "authorization_transaction_expired") {
      authorizationExpired = true;
      proof = undefined;
      showStatus("error", "signupAuthorizationExpiredTitle", () => t("signupAuthorizationExpired"));
      return;
    }
    if (error instanceof ApiError && error.status === 403 && code === "invalid_request") {
      showStatus("error", title, () => t("signupContextChanged"));
      return;
    }
    const key = code === "verification_failed" ? "signupWrongCode" : code === "invalid_transaction" ? "signupCodeExpired" : code === "rate_limited" ? "signupRateLimited" : undefined;
    const message = key ? t(key) : error instanceof ApiError ? error.problem?.detail ?? error.message : t(title);
    showStatus("error", title, () => key ? t(key) : message);
  };
  const sendCode = async (): Promise<void> => {
    if (locked || authorizationExpired || busy || signal.aborted || resendAt > Date.now() || !emailInput.reportValidity()) return;
    const release = options.hold?.();
    busy = "sending"; sync();
    try {
      const nextDestination = emailInput.value.trim();
      csrfToken = (await api.getBrowserContext(signal)).csrf_token;
      const next = await api.startRegistrationEmail(nextDestination, csrfToken, signal, authorizationContext());
      if (signal.aborted) return;
      destination = nextDestination; transaction = next; proof = undefined; codeInput.value = "";
      showStatus("info", "codeSent", () => `${next.delivery_hint} · ${t("signupCodeHint")}`);
      waitToResend(Date.parse(next.resend_after));
    } catch (error) {
      if (!signal.aborted) {
        showError(error, "codeSendFailed");
        // Only an explicit rate limit justifies a new local cooldown; transient
        // delivery/network failures remain retryable under server authority.
        if (error instanceof ApiError && (error.status === 429 || error.problem?.error_code === "rate_limited")) waitToResend(Date.now() + 60_000);
      }
    } finally { busy = undefined; sync(); release?.(); }
    if (transaction && !signal.aborted) codeInput.focus();
  };
  const confirmCode = async (): Promise<void> => {
    if (!transaction || locked || authorizationExpired || busy || signal.aborted || !codeInput.reportValidity()) return;
    // An expired local challenge needs a resend, not a stale-CSRF mutation or a new account.
    if (Date.parse(transaction.expires_at) <= Date.now()) {
      showStatus("error", "codeInvalid", () => t("signupCodeExpired"));
      return;
    }
    const release = options.hold?.();
    busy = "confirming"; sync();
    try {
      // Browser context is shared across tabs. Refresh its CSRF capability without
      // resending mail, replacing the challenge, or automatically retrying a mutation.
      csrfToken = (await api.getBrowserContext(signal)).csrf_token;
      if (signal.aborted) return;
      const result = await api.completeRegistrationEmail(transaction.transaction_id, codeInput.value.trim(), csrfToken, signal, authorizationContext());
      if (signal.aborted) return;
      proof = { email: destination, token: result.email_verification_token, expiresAt: result.expires_at, csrfToken };
      showStatus("success", "emailVerified", () => t("signupEmailVerified"));
    } catch (error) { if (!signal.aborted) showError(error, "codeInvalid"); }
    finally { busy = undefined; sync(); release?.(); }
  };
  send.addEventListener("click", () => { void sendCode(); });
  confirm.addEventListener("click", () => { void confirmCode(); });
  codeInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void confirmCode(); } });
  change.addEventListener("click", () => {
    if (authorizationExpired) return;
    proof = undefined; transaction = undefined; codeInput.value = ""; projectStatus = undefined; status.replaceChildren(); sync(); emailInput.focus();
  });
  signal.addEventListener("abort", () => { clearTimeout(cooldown); proof = undefined; }, { once: true });
  sync();
  return {
    element,
    relocalize: (translate) => {
      t = translate;
      element.setAttribute("aria-label", t("email"));
      emailField.querySelector(".field__label")!.textContent = t("email");
      codeField.querySelector(".field__label")!.textContent = t("verificationCode");
      change.textContent = t("changeSignupEmail");
      element.querySelector(".hint")!.textContent = t("signupEmailIntro");
      if (proof && Date.parse(proof.expiresAt) <= Date.now()) {
        proof = undefined; transaction = undefined;
        showStatus("info", "verifyEmailTitle", () => t("signupProofExpired"));
      }
      projectStatus?.(); sync();
    },
    verified: () => {
      if (proof && (Date.parse(proof.expiresAt) <= Date.now() || proof.email !== emailInput.value.trim())) {
        proof = undefined; transaction = undefined;
        showStatus("info", "verifyEmailTitle", () => t("signupProofExpired")); sync();
      }
      return proof;
    },
    requestVerification: async () => {
      if (transaction && !proof) {
        if (/^[0-9]{8}$/.test(codeInput.value.trim())) await confirmCode();
        else codeInput.focus();
        return;
      }
      await sendCode();
    },
    setDisabled: (disabled) => { locked = disabled; sync(); },
  };
}
