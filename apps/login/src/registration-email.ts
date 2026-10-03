import { IdentityApiClient, ApiError } from "./api/client";
import type { MessageKey } from "./i18n";
import { el, field, replace, statePanel } from "./ui/dom";

/** In-memory proof for one mailbox; verification alone never creates an account. */
export interface VerifiedRegistrationEmail { email: string; token: string; expiresAt: string; csrfToken: string; }

/** Inline email controls owned by the full registration form, never a separate wizard page. */
export interface RegistrationEmailVerifier {
  element: HTMLElement;
  /** Returns a valid proof for the displayed mailbox, otherwise invalidates only email state. */
  verified(): VerifiedRegistrationEmail | undefined;
  /** Starts verification or focuses a pending challenge without replacing the form. */
  requestVerification(): Promise<void>;
  /** Locks mailbox changes together with final account creation. */
  setDisabled(disabled: boolean): void;
}

/** Creates form-safe mailbox verification; profile/password/avatar nodes stay untouched. */
export function createRegistrationEmailVerifier(api: IdentityApiClient, signal: AbortSignal,
  t: (key: MessageKey) => string): RegistrationEmailVerifier {
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
  let resendAt = 0;
  let cooldown: ReturnType<typeof setTimeout> | undefined;

  /** One projection prevents cooldown timers from unlocking an in-flight operation. */
  const sync = (): void => {
    emailInput.readOnly = Boolean(transaction || proof || busy);
    emailInput.disabled = locked;
    codeInput.disabled = locked || !transaction || Boolean(proof);
    codePanel.hidden = !transaction || Boolean(proof);
    change.hidden = !transaction && !proof;
    change.disabled = locked || Boolean(busy);
    send.hidden = Boolean(proof);
    send.disabled = locked || Boolean(busy) || resendAt > Date.now();
    send.textContent = busy === "sending" ? t("sendingCode") : transaction ? t("resendCode") : t("sendSignupCode");
    confirm.disabled = locked || Boolean(busy);
    confirm.textContent = busy === "confirming" ? t("verifyingCode") : t("confirmEmail");
  };
  const waitToResend = (until: number): void => {
    clearTimeout(cooldown); resendAt = until;
    cooldown = setTimeout(sync, Math.max(0, until - Date.now()));
  };
  const showError = (error: unknown, title: MessageKey): void => {
    const code = error instanceof ApiError ? error.problem?.error_code : undefined;
    const key = code === "verification_failed" ? "signupWrongCode" : code === "invalid_transaction" ? "signupCodeExpired" : code === "rate_limited" ? "signupRateLimited" : undefined;
    const message = key ? t(key) : error instanceof ApiError ? error.problem?.detail ?? error.message : t(title);
    replace(status, statePanel("error", t(title), message));
  };
  const sendCode = async (): Promise<void> => {
    if (locked || busy || signal.aborted || resendAt > Date.now() || !emailInput.reportValidity()) return;
    busy = "sending"; sync();
    try {
      const nextDestination = emailInput.value.trim();
      csrfToken = (await api.getBrowserContext(signal)).csrf_token;
      const next = await api.startRegistrationEmail(nextDestination, csrfToken, signal);
      if (signal.aborted) return;
      destination = nextDestination; transaction = next; proof = undefined; codeInput.value = "";
      replace(status, statePanel("info", t("codeSent"), `${next.delivery_hint} · ${t("signupCodeHint")}`));
      waitToResend(Date.parse(next.resend_after));
    } catch (error) {
      if (!signal.aborted) { showError(error, "codeSendFailed"); waitToResend(Date.now() + 60_000); }
    } finally { busy = undefined; sync(); }
    if (transaction && !signal.aborted) codeInput.focus();
  };
  const confirmCode = async (): Promise<void> => {
    if (!transaction || locked || busy || signal.aborted || !codeInput.reportValidity()) return;
    busy = "confirming"; sync();
    try {
      const result = await api.completeRegistrationEmail(transaction.transaction_id, codeInput.value.trim(), csrfToken, signal);
      if (signal.aborted) return;
      proof = { email: destination, token: result.email_verification_token, expiresAt: result.expires_at, csrfToken };
      replace(status, statePanel("success", t("emailVerified"), t("signupEmailVerified")));
    } catch (error) { if (!signal.aborted) showError(error, "codeInvalid"); }
    finally { busy = undefined; sync(); }
  };
  send.addEventListener("click", () => { void sendCode(); });
  confirm.addEventListener("click", () => { void confirmCode(); });
  codeInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void confirmCode(); } });
  change.addEventListener("click", () => {
    proof = undefined; transaction = undefined; codeInput.value = ""; status.replaceChildren(); sync(); emailInput.focus();
  });
  signal.addEventListener("abort", () => { clearTimeout(cooldown); proof = undefined; }, { once: true });
  sync();
  return {
    element,
    verified: () => {
      if (proof && (Date.parse(proof.expiresAt) <= Date.now() || proof.email !== emailInput.value.trim())) {
        proof = undefined; transaction = undefined;
        replace(status, statePanel("info", t("verifyEmailTitle"), t("signupProofExpired"))); sync();
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
