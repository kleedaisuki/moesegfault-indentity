import { PageLifecycle } from "./page-lifecycle";
import { ApiError, createIdempotencyKey, IdentityApiClient } from "./api/client";
import type { Account, Identifier, PasswordAuthenticationInput, PasswordSessionResult, RegistrationResult, RegistrationStart } from "./api/types";
import { normalizeMobileInput } from "@moesegfault/frontend-shared";
import { currentTransaction } from "./transaction";
import type { AppRoute } from "./router";
import { createPasskey, getPasskey, isWebAuthnAvailable } from "./webauthn/ceremony";
import type { Locale, MessageKey } from "./i18n";
import { translate } from "./i18n";
import { el, errorMessage, field, replace, setButtonBusy, statePanel } from "./ui/dom";
import { icon, iconLabel } from "./ui/icons";
import { pageHeading } from "./ui/shell";
import { InlineStepUpCoordinator } from "./step-up";
import { authRouteHref, resolveAccountReturnUri, validateAccountReturnUri } from "./environment";
import { avatarFilePicker } from "./ui/file-picker";
import { createRegistrationEmailVerifier } from "./registration-email";
import { failureReceipt, type SupportOperation } from "./support-receipt";
import { supportDetails } from "./ui/support-details";

/** 只驻留于当前页面 Realm 的 CSRF capability。CSRF capability held only in this page realm. */
let sessionCsrfToken: string | undefined;

/** 登录页面渲染所需的本地化上下文。Localized context required to render login pages. */
export interface PageContext { locale: Locale }

/** 渲染登录站公开路由；账号管理始终位于 account 子域。Renders public login routes; account management always lives on the account subdomain. */
export async function renderPage(route: AppRoute, main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, context: PageContext): Promise<void> {
  const lifecycle = context instanceof PageLifecycle ? context : new PageLifecycle(context.locale);
  lifecycle.bind(signal);
  if (signal.aborted) return;
  const t = (key: MessageKey) => translate(lifecycle.locale, key);
  const accountManagement = route === "/passkey/enroll" || route === "/recovery-codes/rotate";
  replace(main, statePanel("loading", "…", t("signingIn")), accountManagement && accountReturnLink(t));
  try {
    if (route === "/register") renderRegister(main, api, signal, t, lifecycle);
    else if (route === "/recovery") renderRecovery(main, api, signal, t, lifecycle);
    else if (route === "/passkey/enroll") await renderPasskeyEnrollment(main, api, signal, t);
    else if (route === "/recovery-codes/rotate") await renderRecoveryCodeRotation(main, api, signal, t);
    else renderLogin(main, api, signal, t, validateAccountReturnUri(location), lifecycle);
  } catch (error) {
    if (!signal.aborted) replace(main, statePanel("error", t("loginFailed"), errorMessage(error)), accountManagement && accountReturnLink(t));
  }
}

/** Route-local credential drafts exist only until real navigation/unload. */
interface LoginDraft { login: string; password: string; message: HTMLElement; }
/** Explicit registration fields; capabilities and avatar resources keep their own owners. */
interface RegistrationDraft {
  display_name: string; username: string; status_message: string; favorite_character: string;
  interests: string; calling_code: string; mobile: string; password: string; password_confirm: string;
}
/** Reads only an explicitly named form control, never serializes DOM or browser storage. */
function draftValue(form: HTMLFormElement, name: string): string {
  return (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
}
/** Restores explicitly declared draft fields; file/capability controls are never synthesized. */
function restoreDraft(form: HTMLFormElement, draft: object | undefined): void {
  for (const [name, value] of Object.entries(draft ?? {})) {
    const input = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    if (input) input.value = value as string;
  }
}

/** 呈现密码为默认、Passkey 为平等可选项的登录页。Renders password-first login with passkey as an equal option. */
function renderLogin(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, t: (key: MessageKey) => string, returnUri: string | undefined, lifecycle: PageLifecycle, draft?: LoginDraft): void {
  const message = draft?.message ?? el("div", { className: "inline-state", attrs: { "aria-live": "polite" } });
  const submit = el("button", { className: "button button--primary button--wide", attrs: { type: "submit" } }, iconLabel("lock", t("signInPassword")));
  const form = el("form", { className: "auth-form" },
    field(t("identity"), "login", { required: true, autocomplete: "username", icon: "mail" }),
    field(t("password"), "password", { required: true, autocomplete: "current-password", type: "password", icon: "lock" }),
    el("div", { className: "form-meta" }, el("a", { attrs: { href: authRouteHref("/recovery", location) } }, t("recovery"))), submit,
  );
  restoreDraft(form, draft);
  lifecycle.present(() => {
    if (signal.aborted) return;
    renderLogin(main, api, signal, t, returnUri, lifecycle, { login: draftValue(form, "login"), password: draftValue(form, "password"), message });
  });
  let authenticating = false;
  /** A single authentication owner prevents competing session/CSRF rotations. */
  const setAuthenticationBusy = (button: HTMLButtonElement, busy: boolean, label?: string): void => {
    authenticating = busy;
    setButtonBusy(button, busy, label);
    submit.disabled = busy;
    passkey.disabled = busy || !isWebAuthnAvailable();
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (authenticating || signal.aborted) return;
    message.replaceChildren();
    const release = lifecycle.hold();
    setAuthenticationBusy(submit, true, t("signingIn"));
    let operation: SupportOperation = "browser_context";
    try {
      const data = new FormData(form);
      const csrf = await requireBrowserCsrf(api, signal);
      operation = "password_authentication";
      const result = await api.authenticateWithPassword({ login: String(data.get("login") ?? "").trim(), password: String(data.get("password") ?? ""), ...(currentTransaction() ? { authorization_transaction_id: currentTransaction() } : {}) }, csrf, signal);
      if (signal.aborted) return;
      operation = "oauth_resume";
      lifecycle.present(() => {});
      finishAuthentication(main, result, t, returnUri);
    } catch (error) { if (!signal.aborted) replace(message, loginFailurePanel(error, operation, t)); setAuthenticationBusy(submit, false); } finally { release(); }
  });

  const passkey = el("button", { className: "button button--secondary button--wide", attrs: { type: "button", disabled: !isWebAuthnAvailable() } }, iconLabel("key", t("usePasskey")));
  const cancelPasskey = el("button", { className: "button button--secondary button--wide", attrs: { type: "button", hidden: true } }, t("cancelPasskey"));
  /** Only the current native chooser may be cancelled; server completion is not reversible here. */
  let currentPasskey: { cancel(): void } | undefined;
  cancelPasskey.addEventListener("click", () => currentPasskey?.cancel());
  passkey.addEventListener("click", async () => {
    if (authenticating || signal.aborted) return;
    message.replaceChildren();
    const release = lifecycle.hold();
    const attempt = new AbortController();
    let live = true;
    let waitingForDevice = false;
    /** Release immediately on cancellation, even if the platform ignores AbortSignal forever. */
    const dispose = (): void => { live = false; signal.removeEventListener("abort", onRouteAbort); release(); };
    const onRouteAbort = (): void => { attempt.abort(); dispose(); };
    signal.addEventListener("abort", onRouteAbort, { once: true });
    currentPasskey = { cancel() {
      if (!live || !waitingForDevice || signal.aborted) return;
      waitingForDevice = false; currentPasskey = undefined;
      attempt.abort(); cancelPasskey.hidden = true;
      setAuthenticationBusy(passkey, false);
      replace(message, statePanel("info", t("passkeyCancelled"), t("passwordFallbackReady")));
      dispose();
      main.querySelector<HTMLInputElement>('[name="password"]')?.focus({ preventScroll: true });
    } };
    setAuthenticationBusy(passkey, true, t("waitingPasskey"));
    let operation: SupportOperation = "browser_context";
    try {
      const csrf = await requireBrowserCsrf(api, attempt.signal);
      if (!live || signal.aborted) return;
      operation = "passkey_start";
      const transaction = await api.startAuthentication({ purpose: "login", ...(currentTransaction() ? { authorization_transaction_id: currentTransaction() } : {}) }, csrf, attempt.signal);
      if (!live || signal.aborted) return;
      operation = "passkey_completion";
      waitingForDevice = true; cancelPasskey.hidden = false;
      const credential = await getPasskey(transaction.public_key, attempt.signal);
      if (!live || signal.aborted) return;
      waitingForDevice = false; cancelPasskey.hidden = true;
      const result = await api.completeAuthentication(transaction.transaction_id, credential, { csrfToken: transaction.csrf_token, idempotencyKey: createIdempotencyKey(), signal: attempt.signal });
      if (!live || signal.aborted) return;
      operation = "oauth_resume";
      lifecycle.present(() => {});
      finishAuthentication(main, result, t, returnUri);
    } catch (error) {
      if (live && !signal.aborted) {
        replace(message, loginFailurePanel(error, operation, t));
        setAuthenticationBusy(passkey, false);
      }
    } finally {
      if (live) { currentPasskey = undefined; cancelPasskey.hidden = true; }
      dispose();
    }
  });

  replace(main, pageHeading("IDENTITY_GATEWAY", t("welcome"), t("welcomeIntro")),
    el("section", { className: "moe-glass auth-card", attrs: { "aria-labelledby": "login-options" } },
      el("div", { className: "card-sparkle", attrs: { "aria-hidden": "true" } }, icon("star")),
      el("h2", { className: "visually-hidden", attrs: { id: "login-options" } }, t("login")), form, divider(t("divider")), passkey, cancelPasskey,
      !isWebAuthnAvailable() && el("p", { className: "hint hint--warning" }, t("passkeyUnavailable")), message),
    el("p", { className: "switcher" }, t("noAccount"), " ", el("a", { attrs: { href: authRouteHref("/register", location) } }, t("create"))), accountCenterNote(t));
}

/** 呈现包含社区资料、密码与可选 Passkey 的注册页。Renders registration with community profile, password, and optional passkey. */
function renderRegister(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, t: (key: MessageKey) => string, lifecycle: PageLifecycle, retained?: {
  draft: RegistrationDraft; message: HTMLElement; email: ReturnType<typeof createRegistrationEmailVerifier>; avatar: ReturnType<typeof avatarFilePicker>;
}): void {
  const message = retained?.message ?? el("div", { className: "inline-state", attrs: { "aria-live": "polite" } });
  const emailVerifier = retained?.email ?? createRegistrationEmailVerifier(api, signal, t, { authorizationTransactionId: currentTransaction, hold: () => lifecycle.hold() });
  emailVerifier.relocalize(t);
  const passwordButton = el("button", { className: "button button--primary", attrs: { type: "submit", value: "password", name: "method" } }, iconLabel("lock", t("registerPassword")));
  const passkeyButton = el("button", { className: "button button--secondary", attrs: { type: "submit", value: "passkey", name: "method", formnovalidate: true, disabled: !isWebAuthnAvailable() } }, iconLabel("key", t("registerPasskey")));
  const avatarCopy = {
    label: t("avatar"), choose: t("chooseAvatar"), empty: t("noAvatarSelected"),
    processing: t("avatarProcessing"), ready: t("avatarReady"), failed: t("avatarProcessingFailed"),
    previewAlt: t("avatarPreviewAlt"),
    change: t("changeAvatar"), remove: t("removeAvatar"),
  };
  const avatarPicker = retained?.avatar ?? avatarFilePicker(avatarCopy, { signal });
  avatarPicker.relocalize(avatarCopy);
  const callingCode = el("select", { attrs: { name: "calling_code", "aria-label": t("countryCode") } },
    ...[["+86", "🇨🇳 +86"], ["+81", "🇯🇵 +81"], ["+1", "🇺🇸/🇨🇦 +1"], ["+44", "🇬🇧 +44"], ["+65", "🇸🇬 +65"], ["+852", "🇭🇰 +852"]].map(([value, label]) => el("option", { attrs: { value } }, label)));
  const form = el("form", { className: "moe-glass auth-card register-form" },
    el("div", { className: "field-grid" }, field(t("displayName"), "display_name", { required: true, autocomplete: "name", placeholder: "Klee ✦", icon: "user" }), field(t("username"), "username", { required: true, autocomplete: "username", placeholder: "klee", icon: "user", pattern: "[a-zA-Z0-9_]{3,32}" })),
    emailVerifier.element,
    avatarPicker, el("p", { className: "hint" }, t("addAvatar")),
    el("div", { className: "field-grid" }, field(t("statusLabel"), "status_message", { placeholder: t("statusPlaceholder"), icon: "star" }), field(t("oshiLabel"), "favorite_character", { placeholder: "Klee", icon: "star" })),
    field(t("interestsLabel"), "interests", { placeholder: "ACG, Linux, VOCALOID", icon: "star" }),
    el("div", { className: "field" }, el("label", { className: "field__label", attrs: { for: "signup-mobile" } }, t("mobile")), el("span", { className: "phone-field" }, callingCode, el("input", { attrs: { id: "signup-mobile", name: "mobile", type: "tel", autocomplete: "tel-national", inputmode: "tel", placeholder: "138 0000 0000", "aria-describedby": "signup-phone-hint" } }))), el("p", { className: "hint", attrs: { id: "signup-phone-hint" } }, t("phoneHint")),
    el("div", { className: "field-grid" }, field(t("password"), "password", { autocomplete: "new-password", type: "password", minlength: "15", icon: "lock" }), field(t("passwordAgain"), "password_confirm", { autocomplete: "new-password", type: "password", minlength: "15", icon: "lock" })), el("p", { className: "hint" }, t("passwordHint")),
    el("fieldset", { className: "method-picker" }, el("legend", {}, t("methodTitle")), el("p", { className: "hint" }, t("passkeyOptional")), el("div", { className: "button-pair" }, passwordButton, passkeyButton)), message, el("p", { className: "terms" }, t("terms")));
  restoreDraft(form, retained?.draft);
  const mobileField = form.querySelector<HTMLInputElement>('[name="mobile"]')!;
  mobileField.addEventListener("input", () => mobileField.removeAttribute("aria-invalid"));
  callingCode.addEventListener("change", () => mobileField.removeAttribute("aria-invalid"));
  lifecycle.present(() => {
    if (signal.aborted) return;
    const draft: RegistrationDraft = {
      display_name: draftValue(form, "display_name"), username: draftValue(form, "username"),
      status_message: draftValue(form, "status_message"), favorite_character: draftValue(form, "favorite_character"),
      interests: draftValue(form, "interests"), calling_code: draftValue(form, "calling_code"), mobile: draftValue(form, "mobile"),
      password: draftValue(form, "password"), password_confirm: draftValue(form, "password_confirm"),
    };
    renderRegister(main, api, signal, t, lifecycle, { draft, message, email: emailVerifier, avatar: avatarPicker });
  });
  let registering = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (registering || signal.aborted) return;
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null; const method = submitter?.value === "passkey" ? "passkey" : "password";
    // Password drafts must not constrain the independent Passkey method. Its
    // submitter skips native whole-form validation, so validate shared fields here.
    if (method === "passkey") {
      const fields = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select"));
      if (!fields.filter(input => !["password", "password_confirm"].includes(input.name)).every(input => input.reportValidity())) return;
    }
    const data = new FormData(form); const password = String(data.get("password") ?? "");
    if (method === "password" && [...password].length < 15) { replace(message, statePanel("error", t("registerFailed"), t("passwordHint"))); return; }
    if (method === "password" && password !== String(data.get("password_confirm") ?? "")) { replace(message, statePanel("error", t("registerFailed"), t("mismatch"))); return; }
    // Reject optional bad mobile before email confirmation or consuming its single-use proof.
    const mobileResult = normalizeMobileInput(String(data.get("calling_code")), String(data.get("mobile") ?? ""));
    if (mobileResult.kind === "invalid") {
      const key = ({ invalid: "mobileInvalid", "country-mismatch": "mobileCountryMismatch", "international-prefix": "mobileInternationalPrefix" } as const)[mobileResult.reason];
      replace(message, statePanel("error", t("registerFailed"), t(key)));
      mobileField.setAttribute("aria-invalid", "true"); mobileField.focus(); return;
    }
    const mobile = mobileResult.kind === "valid" ? mobileResult.mobile : undefined;
    // The submit owns its entire continuation, including mailbox confirmation.
    // A verifier's nested release must not relocalize the form before this owner
    // can consume its proof and lock final account creation.
    registering = true;
    const release = lifecycle.hold();
    let accountCreated = false;
    passwordButton.disabled = true; passkeyButton.disabled = true;
    try {
      let verifiedEmail = emailVerifier.verified();
      if (!verifiedEmail) {
        replace(message, statePanel("info", t("verifyEmailTitle"), t("signupVerifyBeforeCreate")));
        await emailVerifier.requestVerification();
        verifiedEmail = emailVerifier.verified();
        if (!verifiedEmail) return;
      }
      if (signal.aborted) return;
      rememberCsrf(verifiedEmail.csrfToken);
      message.replaceChildren();
      setButtonBusy(submitter ?? passwordButton, true, method === "passkey" ? t("waitingPasskey") : t("registering"));
      avatarPicker.setDisabled(true);
      emailVerifier.setDisabled(true);
      const avatar = await avatarPicker.processedFile();
      if (signal.aborted) return;
      const profile = { ...(optionalString(data, "status_message") ? { status_message: optionalString(data, "status_message") } : {}), ...(optionalString(data, "favorite_character") ? { favorite_character: optionalString(data, "favorite_character") } : {}), ...(optionalString(data, "interests") ? { interests: optionalString(data, "interests")?.split(",").map((value) => value.trim()).filter(Boolean) } : {}) };
      const common = { username: String(data.get("username") ?? "").trim(), display_name: String(data.get("display_name") ?? "").trim(), email: verifiedEmail.email, email_verification_token: verifiedEmail.token, locale: lifecycle.locale, ...(mobile ? { mobile } : {}), ...(Object.keys(profile).length ? { profile } : {}) };
      if (method === "password") {
        // Internal Login routing preserves this page-realm handle without putting it back in URLs.
        // Passkey registration has a separate contract and does not accept this optional field.
        const authorizationTransactionId = currentTransaction();
        const result = await api.registerWithPassword({ ...common, password, ...(authorizationTransactionId ? { authorization_transaction_id: authorizationTransactionId } : {}) }, await requireBrowserCsrf(api, signal), signal);
        accountCreated = true;
        if (signal.aborted) return;
        rememberCsrf(result.csrf_token);
        lifecycle.present(() => {});
        replace(main, statePanel("loading", t("registering"), t("avatarProcessing")));
        const avatarOk = await uploadOptionalAvatar(api, avatar, result.csrf_token, signal);
        avatarPicker.dispose();
        if (!signal.aborted) finishAuthentication(main, result, t);
        if (!avatarOk && !signal.aborted) main.append(statePanel("info", t("success"), t("avatarUploadFailed")));
        return;
      }
      const input: RegistrationStart = { ...common, authenticator_label: browserPasskeyLabel(t) };
      const transaction = await api.startRegistration(input, await requireBrowserCsrf(api, signal), signal); const credential = await createPasskey(transaction.public_key, signal);
      const result = await api.completeRegistration(transaction.transaction_id, credential, { csrfToken: transaction.csrf_token, idempotencyKey: createIdempotencyKey(), signal });
      accountCreated = true;
      if (signal.aborted) return;
      // Recovery codes must remain visible before secondary avatar uploads.
      rememberCsrf(result.csrf_token);
      lifecycle.present(result.recovery_codes?.length ? () => finishRegistration(main, result, t) : () => {});
      finishRegistration(main, result, t);
      const avatarOk = await uploadOptionalAvatar(api, avatar, result.csrf_token, signal);
      avatarPicker.dispose();
      if (result.recovery_codes?.length) lifecycle.present(() => {
        finishRegistration(main, result, t);
        if (!avatarOk) main.append(statePanel("info", t("success"), t("avatarUploadFailed")));
      });
      if (!avatarOk && !signal.aborted) main.append(statePanel("info", t("success"), t("avatarUploadFailed")));
    } catch (error) {
      if (!signal.aborted) replace(message, statePanel("error", t("registerFailed"), errorMessage(error)));
    } finally {
      // Early mailbox-only returns and failures release the same submit owner.
      // Successful creation stays terminal; it must never enable another signup.
      if (!accountCreated) {
        registering = false;
        setButtonBusy(submitter ?? passwordButton, false);
        passwordButton.disabled = false; passkeyButton.disabled = !isWebAuthnAvailable();
        avatarPicker.setDisabled(false); emailVerifier.setDisabled(false);
      }
      release();
    }
  });
  replace(main, pageHeading("CREATE_PRINCIPAL", t("newTitle"), t("newIntro")), form, el("p", { className: "switcher" }, t("haveAccount"), " ", el("a", { attrs: { href: authRouteHref("/login", location) } }, t("login"))));
}

/** 呈现恢复代码加新 Passkey 流程。Renders recovery-code plus new-passkey flow. */
function renderRecovery(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, t: (key: MessageKey) => string, lifecycle: PageLifecycle, draft?: { recovery_code: string; authenticator_label: string }): void {
  const message = el("div", { attrs: { "aria-live": "polite" } }); const submit = el("button", { className: "button button--primary button--wide", attrs: { type: "submit" } }, iconLabel("key", t("recover")));
  const form = el("form", { className: "moe-glass auth-card auth-form" }, field(t("recoveryCode"), "recovery_code", { required: true, autocomplete: "off", placeholder: "msf_rc_…", icon: "lock" }), field(t("newPasskeyLabel"), "authenticator_label", { required: true, placeholder: browserPasskeyLabel(t), icon: "key" }), submit, message);
  restoreDraft(form, draft);
  lifecycle.present(() => { if (!signal.aborted) renderRecovery(main, api, signal, t, lifecycle, { recovery_code: draftValue(form, "recovery_code"), authenticator_label: draftValue(form, "authenticator_label") }); });
  let recovering = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (recovering || signal.aborted) return;
    recovering = true; const release = lifecycle.hold(); setButtonBusy(submit, true, t("waitingPasskey"));
    const data = new FormData(form);
    let startingRecovery = false;
    try {
      const csrf = await requireBrowserCsrf(api, signal);
      startingRecovery = true;
      const started = await api.startRecovery({ recovery_code: String(data.get("recovery_code") ?? ""), authenticator_label: String(data.get("authenticator_label") ?? "") }, csrf, signal);
      startingRecovery = false;
      const credential = await createPasskey(started.public_key, signal);
      const result = await api.completeRecovery(started.transaction_id, started.csrf_token, credential, signal);
      if (signal.aborted) return;
      rememberCsrf(result.csrf_token);
      const show = () => replace(main, pageHeading("RECOVERY_COMPLETE", t("success"), t("signedIn")), recoveryCodePanel(result.recovery_codes, t));
      lifecycle.present(show); show();
    } catch (error) {
      recovering = false;
      const invalidMaterial = startingRecovery && hasProblemCode(error, 400, "invalid_transaction");
      if (!signal.aborted) replace(message, statePanel("error", t("recoveryFailed"), invalidMaterial ? t("recoveryMaterialInvalid") : errorMessage(error)));
      setButtonBusy(submit, false);
    } finally { release(); }
  });
  replace(main, pageHeading("RECOVERY_LINK", t("recovery"), t("recoveryIntro")), form, el("p", { className: "switcher" }, el("a", { attrs: { href: authRouteHref("/login", location) } }, t("back"))));
}

/** 为账号中心执行单一的 Passkey 登记仪式，不承载管理列表。Performs one passkey enrollment ceremony without hosting management UI. */
async function renderPasskeyEnrollment(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, t: (key: MessageKey) => string): Promise<void> {
  const session = await api.getPrincipal(signal);
  if (signal.aborted) return;
  rememberCsrf(session.csrf_token);
  const expectedPrincipalId = session.account.principal_id;
  const confirmationIdentity = session.account.identifiers.find(identifier => identifier.kind === "username")?.value
    ?? session.account.identifiers.find(identifier => identifier.kind === "email" && identifier.is_primary)?.value;
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const submit = el("button", { className: "button button--primary button--wide", attrs: { type: "submit", disabled: !isWebAuthnAvailable() } }, iconLabel("key", t("enroll")));
  const labelField = field(t("passkeyName"), "label", { required: true, value: browserPasskeyLabel(t), icon: "key" });
  const passwordMessage = el("div", { attrs: { "aria-live": "polite" } });
  const passwordSubmit = el("button", { className: "button button--secondary button--wide", attrs: { type: "submit" } }, iconLabel("lock", t("reauthWithPassword")));
  const passwordForm = el("form", { className: "password-fallback auth-form" },
    field(t("reauthIdentity"), "login", { required: true, autocomplete: "username", icon: "user", value: confirmationIdentity, readonly: Boolean(confirmationIdentity) }),
    field(t("reauthPassword"), "password", { required: true, autocomplete: "current-password", type: "password", icon: "lock" }), passwordSubmit, passwordMessage);
  const fallback = el("details", { className: "password-fallback-wrap" }, el("summary", {}, t("passwordReauthTitle")), el("p", { className: "hint" }, t("passwordReauthIntro")), passwordForm);
  const form = el("form", { className: "moe-glass auth-card auth-form" }, labelField, submit, message);
  let enrolling = false;
  /** Both entry forms share one session/ceremony owner, including synthetic repeated submit events. */
  const begin = (button: HTMLButtonElement, label: string): boolean => {
    if (enrolling || signal.aborted) return false;
    enrolling = true; setButtonBusy(button, true, label);
    submit.disabled = true; passwordSubmit.disabled = true;
    return true;
  };
  /** Release both forms after the owning attempt settles; route-aborted controls are detached. */
  const finish = (button: HTMLButtonElement): void => {
    enrolling = false; setButtonBusy(button, false);
    submit.disabled = !isWebAuthnAvailable(); passwordSubmit.disabled = false;
  };
  const complete = async (transaction: Awaited<ReturnType<IdentityApiClient["startAuthenticatorRegistration"]>>, label: string) => {
    if (signal.aborted) return;
    const credential = await createPasskey(transaction.public_key, signal);
    if (signal.aborted) return;
    const completed = await api.completeAuthenticatorRegistration(transaction.transaction_id, credential, { csrfToken: transaction.csrf_token, idempotencyKey: createIdempotencyKey(), signal });
    if (signal.aborted) return;
    rememberCsrf(completed.csrf_token); replace(main, statePanel("success", t("enrolled"), label, accountReturnLink(t)));
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (!begin(submit, t("waitingPasskey"))) return;
    try {
      const label = String(new FormData(form).get("label") ?? "").trim();
      const authenticators = await api.listAuthenticators(signal);
      if (signal.aborted) return;
      if (!authenticators.items.some(authenticator => !authenticator.revoked_at)) {
        // First-key enrollment accepts recent password authentication on the server.
        // Never request an assertion from a user whose account has no active key.
        const current = await api.getPrincipal(signal);
        if (signal.aborted) return;
        if (current.account.principal_id !== expectedPrincipalId) throw new ManagementAccountChangedError();
        rememberCsrf(current.csrf_token);
        let transaction: Awaited<ReturnType<IdentityApiClient["startAuthenticatorRegistration"]>>;
        try {
          transaction = await api.startAuthenticatorRegistration(label, { csrfToken: current.csrf_token, idempotencyKey: createIdempotencyKey(), signal });
        } catch (error) {
          if (signal.aborted) return;
          if (!hasProblemCode(error, 403, "reauthentication_required")) throw error;
          fallback.open = true;
          replace(message, statePanel("info", t("passwordReauthTitle"), t("firstPasskeyConfirmation")));
          const login = passwordForm.querySelector<HTMLInputElement>('[name="login"]')!;
          (login.value ? passwordForm.querySelector<HTMLInputElement>('[name="password"]') : login)?.focus({ preventScroll: true });
          return;
        }
        await complete(transaction, label);
        return;
      }
      const transaction = await stepUpCoordinator(api, expectedPrincipalId).execute((controls) => api.startAuthenticatorRegistration(label, controls), { signal, onStepUpRequired: () => replace(message, statePanel("info", t("stepUp"), t("waitingPasskey"))) });
      await complete(transaction, label);
    } catch (error) { if (!signal.aborted) replace(message, statePanel("error", t("enrollFailed"), managementErrorMessage(error, t))); }
    finally { finish(submit); }
  });
  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault(); if (!begin(passwordSubmit, t("signingIn"))) return;
    try {
      const data = new FormData(passwordForm); const label = labelField.querySelector<HTMLInputElement>("input[name='label']")?.value.trim() ?? "";
      const browserCsrf = (await api.getBrowserContext(signal)).csrf_token;
      if (signal.aborted) return;
      const started = await reauthenticateAndStartEnrollment(api, { login: String(data.get("login") ?? "").trim(), password: String(data.get("password") ?? "") }, label, browserCsrf, signal, expectedPrincipalId);
      if (signal.aborted) return;
      rememberCsrf(started.csrfToken); await complete(started.transaction, label);
    } catch (error) { if (!signal.aborted) replace(passwordMessage, statePanel("error", t("enrollFailed"), managementErrorMessage(error, t))); }
    finally { finish(passwordSubmit); }
  });
  replace(main, pageHeading("PASSKEY_ENROLLMENT", t("enrollTitle"), t("enrollIntro")), form, fallback, accountReturnLink(t));
}

/**
 * Refreshes authentication and starts enrollment only for the expected account when supplied.
 * The optional final argument preserves legacy callers; the enrollment UI always binds its principal.
 */
export async function reauthenticateAndStartEnrollment(api: IdentityApiClient, authentication: PasswordAuthenticationInput, label: string, browserCsrf: string, signal: AbortSignal, expectedPrincipalId?: string) {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const session = await api.authenticateWithPassword(authentication, browserCsrf, signal);
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
  if (expectedPrincipalId !== undefined && session.account?.principal_id !== expectedPrincipalId) throw new ManagementAccountChangedError();
  const transaction = await api.startAuthenticatorRegistration(label, { csrfToken: session.csrf_token, idempotencyKey: createIdempotencyKey(), signal });
  return { csrfToken: session.csrf_token, transaction };
}

/** Management intent must not silently move to another account after shared-session changes. */
class ManagementAccountChangedError extends Error {
  /** Stable local failure: authentication may have succeeded, but management ownership did not. */
  constructor() { super("The signed-in account changed. Return to Account Center and reopen this page."); }
}

/** Localize the ownership boundary without interpreting server prose. */
function managementErrorMessage(error: unknown, t: (key: MessageKey) => string): string {
  return error instanceof ManagementAccountChangedError ? t("managementAccountChanged") : errorMessage(error);
}

/** 执行恢复代码轮换并只在本页展示一次结果。Rotates recovery codes and shows the result only on this page. */
async function renderRecoveryCodeRotation(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, t: (key: MessageKey) => string): Promise<void> {
  const session = await api.getPrincipal(signal);
  if (signal.aborted) return;
  const expectedPrincipalId = session.account.principal_id;
  rememberCsrf(session.csrf_token);
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const button = el("button", { className: "button button--primary button--wide", attrs: { type: "button" } }, iconLabel("lock", t("rotate")));
  let rotating = false;
  button.addEventListener("click", async () => {
    if (rotating || signal.aborted) return;
    rotating = true; setButtonBusy(button, true, t("waitingPasskey"));
    try {
      // An empty registered-key set cannot satisfy the server's recent-Passkey policy.
      // Read failure is not evidence of emptiness; let it retain its ordinary error.
      const current = await api.getPrincipal(signal);
      if (signal.aborted) return;
      if (current.account.principal_id !== expectedPrincipalId) throw new ManagementAccountChangedError();
      const authenticators = await api.listAuthenticators(signal);
      if (signal.aborted) return;
      if (!authenticators.items.some(authenticator => !authenticator.revoked_at)) {
        const enrollLink = el("a", { className: "button button--secondary", attrs: { href: authRouteHref("/passkey/enroll", location) } }, t("enroll"));
        replace(message, statePanel("info", t("recoveryNeedsPasskeyTitle"), t("recoveryNeedsPasskey"), enrollLink));
        return;
      }
      const result = await stepUpCoordinator(api, expectedPrincipalId).execute((controls) => api.rotateRecoveryCodes(controls), { signal, onStepUpRequired: () => replace(message, statePanel("info", t("stepUp"), t("waitingPasskey"))) });
      if (signal.aborted) return;
      replace(main, pageHeading("RECOVERY_CODES", t("success"), t("codesIntro")), recoveryCodePanel(result.recovery_codes, t, undefined, false), accountReturnLink(t));
    } catch (error) { if (!signal.aborted) replace(message, statePanel("error", t("recoveryFailed"), managementErrorMessage(error, t))); }
    finally { rotating = false; setButtonBusy(button, false); }
  });
  replace(main, pageHeading("RECOVERY_ROTATION", t("rotateTitle"), t("rotateIntro")), el("section", { className: "moe-glass auth-card" }, button, message), accountReturnLink(t));
}

/** 创建一次性恢复代码的复制和下载界面。Creates copy and download controls for one-time recovery codes. */
function recoveryCodePanel(codes: string[], t: (key: MessageKey) => string, nextUri?: string, showProceed = true): HTMLElement {
  const text = codes.join("\n");
  const copy = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("copyCodes"));
  copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text); copy.textContent = t("copied"); } catch { window.prompt(t("copyCodes"), text); } });
  const download = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("downloadCodes"));
  download.addEventListener("click", () => { const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain;charset=utf-8" })); const anchor = el("a", { attrs: { href: url, download: "moesegfault-recovery-codes.txt" } }); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); });
  const proceed = nextUri
    ? el("button", { className: "button button--primary", attrs: { type: "button" }, on: { click: () => navigateToHttpUrl(nextUri) } }, t("continueAccount"))
    : accountLink(t);
  return el("section", { className: "moe-glass auth-card recovery-codes", attrs: { "aria-labelledby": "recovery-code-title" } }, el("h2", { attrs: { id: "recovery-code-title" } }, t("codesTitle")), el("p", { className: "hint" }, t("codesIntro")), el("ul", {}, ...codes.map((code) => el("li", {}, el("code", {}, code)))), el("div", { className: "button-pair" }, copy, download), showProceed && proceed);
}

/** 选择注册创建的主邮箱，不将手机或 username 误作验证目标。Selects the primary registration email without mistaking mobile or username identifiers. */
export function registrationEmailIdentifier(account: Account): Identifier | undefined {
  const emails = account.identifiers.filter((identifier) => identifier.kind === "email");
  return emails.find((identifier) => identifier.is_primary) ?? emails[0];
}

/** 邮箱验证完成的逻辑操作标识。Logical operation identity for an email-verification completion. */
export interface ContactVerificationCompletionAttempt {
  transactionId: string;
  code: string;
  idempotencyKey: string;
}

/**
 * 为相同事务和验证码复用幂等键，使响应丢失后可安全回放。
 * Reuses an idempotency key for the same transaction and code so a lost response can be replayed safely.
 */
export function contactVerificationCompletionAttempt(previous: ContactVerificationCompletionAttempt | undefined, transactionId: string, code: string, createKey: () => string = createIdempotencyKey): ContactVerificationCompletionAttempt {
  if (previous?.transactionId === transactionId && previous.code === code) return previous;
  return { transactionId, code, idempotencyKey: createKey() };
}

/** Share ceremonies only within the same API client and immutable account owner. */
const stepUpCoordinators = new WeakMap<IdentityApiClient, Map<string, InlineStepUpCoordinator>>();
/** Bind management reads, stale-CSRF recovery, and completed assertions to immutable account intent. */
function stepUpCoordinator(api: IdentityApiClient, expectedPrincipalId: string): InlineStepUpCoordinator {
  let owners = stepUpCoordinators.get(api);
  if (!owners) { owners = new Map(); stepUpCoordinators.set(api, owners); }
  const owner = expectedPrincipalId;
  const existing = owners.get(owner); if (existing) return existing;
  const verifyPrincipal = (account: Account): void => {
    if (account?.principal_id !== expectedPrincipalId) throw new ManagementAccountChangedError();
  };
  const readSession = async (signal: AbortSignal) => {
    const current = await api.getPrincipal(signal);
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    verifyPrincipal(current.account);
    rememberCsrf(current.csrf_token); return current.csrf_token;
  };
  const coordinator = new InlineStepUpCoordinator(api, {
    readSessionCsrf: readSession,
    refreshSessionCsrf: readSession,
    readBrowserCsrf: async (signal) => (await api.getBrowserContext(signal)).csrf_token,
    rememberSessionCsrf: rememberCsrf,
    validateSessionResult: result => verifyPrincipal(result.account),
  });
  owners.set(owner, coordinator); return coordinator;
}

function finishAuthentication(main: HTMLElement, result: PasswordSessionResult, t: (key: MessageKey) => string, returnUri?: string): void {
  rememberCsrf(result.csrf_token);
  const destination = postAuthenticationDestination(result, returnUri);
  if (destination) { navigateToHttpUrl(destination); return; }
  replace(main, statePanel("success", t("success"), t("signedIn"), accountLink(t)));
}

/** OAuth 恢复始终优先于 Account 回跳。OAuth transaction resumption always takes precedence over an Account return URI. */
export function postAuthenticationDestination(result: Pick<PasswordSessionResult, "authorization_resume_uri">, returnUri?: string): string | undefined {
  return result.authorization_resume_uri ?? returnUri;
}
function finishRegistration(main: HTMLElement, result: RegistrationResult, t: (key: MessageKey) => string): void {
  rememberCsrf(result.csrf_token);
  if (result.recovery_codes?.length) { replace(main, pageHeading("ACCOUNT_CREATED", t("success"), t("signedIn")), recoveryCodePanel(result.recovery_codes, t, result.next_uri)); return; }
  if (result.next_uri) { navigateToHttpUrl(result.next_uri); return; }
  replace(main, statePanel("success", t("success"), t("signedIn"), accountLink(t)));
}
/** Offer explicit secondary navigation without starting or implying cancellation of a credential mutation. */
function accountReturnLink(t: (key: MessageKey) => string): HTMLAnchorElement {
  return el("a", { className: "button button--secondary", attrs: { href: resolveAccountReturnUri(location) } }, iconLabel("external", t("continueAccount")));
}
function accountLink(t: (key: MessageKey) => string): HTMLAnchorElement { return el("a", { className: "button button--primary", attrs: { href: resolveAccountReturnUri(location) } }, iconLabel("external", t("accountLink"))); }
function accountCenterNote(t: (key: MessageKey) => string): HTMLElement { return el("aside", { className: "account-note" }, icon("external"), el("div", {}, el("a", { attrs: { href: resolveAccountReturnUri(location) } }, t("accountLink")), el("p", {}, t("accountHint")))); }
function divider(label: string): HTMLElement { return el("div", { className: "divider", attrs: { role: "separator" } }, el("span", {}, label)); }
function optionalString(data: FormData, name: string): string | undefined { const value = String(data.get(name) ?? "").trim(); return value || undefined; }
function browserPasskeyLabel(t: (key: MessageKey) => string): string { return /Android|iPhone|iPad/i.test(navigator.userAgent) ? t("mobileDevice") : t("desktopDevice"); }
/** 次要头像上传绝不把已创建账号降格成注册失败。Secondary avatar upload never turns a created account into a failed registration. */
export async function uploadOptionalAvatar(api: IdentityApiClient, avatar: File | undefined, csrfToken: string, signal: AbortSignal): Promise<boolean> { if (!avatar) return true; try { await api.uploadAvatar(avatar, csrfToken, signal); return true; } catch { return false; } }
function rememberCsrf(token: string): void { sessionCsrfToken = token; }
async function requireBrowserCsrf(api: IdentityApiClient, signal: AbortSignal): Promise<string> { if (!sessionCsrfToken) rememberCsrf((await api.getBrowserContext(signal)).csrf_token); return sessionCsrfToken as string; }
function navigateToHttpUrl(value: string): void { const url = new URL(value, location.href); if (url.protocol !== "https:" && url.protocol !== "http:") throw new ApiError(0, { type: "urn:moesegfault:problem:invalid_navigation", title: "Invalid navigation", status: 0 }); location.assign(url.href); }

/** Localize only password credential rejection; retain all other errors and the separate receipt. */
function loginFailurePanel(error: unknown, operation: SupportOperation, t: (key: MessageKey) => string): HTMLElement {
  const receipt = failureReceipt(error, operation, location.hostname,
    typeof __LOGIN_BUILD_REVISION__ === "string" ? __LOGIN_BUILD_REVISION__ : "unknown");
  return statePanel("error", t("loginFailed"), passwordCredentialRejection(error, operation) ? t("passwordCredentialsRejected") : errorMessage(error), supportDetails(receipt, {
    summary: t("supportSummary"), privacy: t("supportPrivacy"), copy: t("supportCopy"),
    copied: t("supportCopied"), failed: t("supportCopyFailed"),
  }));
}

/** Recognize the stable password boundary without interpreting account existence or server prose. */
function passwordCredentialRejection(error: unknown, operation: SupportOperation): boolean {
  return operation === "password_authentication" && hasProblemCode(error, 401, "authentication_failed");
}

/** Match stable wire codes and status; an explicit code overrides legacy/current type fallbacks. */
function hasProblemCode(error: unknown, status: number, code: string): boolean {
  if (!(error instanceof ApiError) || error.status !== status) return false;
  if (error.problem?.error_code !== undefined) return error.problem.error_code === code;
  return error.type === `https://identity.moesegfault.dev/problems/${code}`
    || error.type === `urn:moesegfault:problem:${code}`;
}
