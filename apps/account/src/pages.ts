import {
  AvatarImageError,
  processAvatarImage,
  normalizeMobileInput,
  type ProcessedAvatar,
  type ProcessedAvatarMetadata,
} from "@moesegfault/frontend-shared";
import { ApiError, AccountApiClient } from "./api/client";
import { apiErrorMessage } from "./api/error-message";
import type { Account, AccountPreferences, Contact, Credential, MutationProof, SecuritySummary, Session } from "./api/types";
import { type Locale, type MessageKey } from "./i18n";
import type { Route } from "./router";
import { resolveRoute } from "./router";
import { busy, el, formatTime, icon, replace } from "./ui/dom";
import { resolveAccountOrigin, resolveLoginOrigin } from "./environment";
import { renderSubscriptions } from "./ui/subscriptions";
import { localeOptions } from "./ui/locale-select";
import { hasUnsavedChanges, trackFormDraft } from "./draft";
import { isValidNewPassword } from "./password-policy";
import { readProfileInput } from "./profile-input";
import { createProfileOperations, type ProfileOperations } from "./profile-operations";

/** 头像准备函数，允许 UI 测试替换浏览器 Canvas。Avatar preparer replaceable by UI tests without browser Canvas. */
export type AvatarPreparer = (input: Blob) => Promise<ProcessedAvatar>;

/** 页面渲染所需的会话态；CSRF 只驻留内存。In-memory page session; CSRF never leaves memory. */
export interface PageContext { api: AccountApiClient; account: Account; preferences: AccountPreferences; csrfToken: string; locale: Locale; t: (key: MessageKey) => string; signal: AbortSignal; refresh(feedback?: RefreshFeedback): Promise<void>; prepareAvatar?: AvatarPreparer; profileOperations?: ProfileOperations; }

/** A completed profile mutation may acknowledge success only on its fresh canonical render. */
export type RefreshFeedback = "profile-saved" | "avatar-saved" | "profile-partial-details" | "profile-partial-preferences";

/** 渲染一级账号页面。Renders one top-level Account page. */
export async function renderPage(route: Route, main: HTMLElement, context: PageContext): Promise<void> {
  replace(main, status(context.t("loading")));
  if (route === "/") renderOverview(main, context);
  if (route === "/profile") await renderProfile(main, context);
  if (route === "/security") await renderSecurity(main, context);
  if (route === "/sessions") await renderSessions(main, context);
  if (route === "/apps") await renderApps(main, context);
  if (route === "/subscriptions") renderSubscriptions(main, context);
}

/** 总览将最常用动作提升为卡片。Overview promotes common actions into cards. */
function renderOverview(main: HTMLElement, c: PageContext): void {
  replace(main,
    heading(`${c.t("hello")}，${c.account.profile.display_name}`, c.t("subtitle")),
    el("section", { className: "hero-card moe-glass" },
      el("div", { className: "hero-avatar-wrap" }, avatar(c.account), el("span", { className: "sparkle" }, icon("sparkle"))),
      el("div", {}, el("p", { className: "eyebrow" }, `@${username(c.account)}`), el("h2", { attrs: { dir: "auto" } }, c.account.profile.display_name), el("p", { className: "muted", attrs: { dir: "auto" } }, c.account.profile.bio || c.t("editProfile"))),
      el("a", { className: "button primary", attrs: { href: "/profile" }, dataset: { route: "/profile" } }, icon("user"), c.t("editProfile")),
    ),
    el("div", { className: "quick-grid" },
      quick("shield", c.t("security"), c.t("securityScore"), "/security"), quick("devices", c.t("sessions"), c.t("devicesIntro"), "/sessions"), quick("apps", c.t("apps"), c.t("connectedIntro"), "/apps"), quick("apps", c.t("subscriptions"), c.t("subscriptionsIntro"), "/subscriptions"),
    ),
  );
}

/** 资料、头像、联系方式统一成一个编辑心智模型。Profile, avatar and contacts share one editing model. */
async function renderProfile(main: HTMLElement, c: PageContext): Promise<void> {
  const contacts = await c.api.listContacts(c.signal);
  if (c.signal.aborted) return;
  const operations = c.profileOperations ?? createProfileOperations(main, c.signal);
  c = { ...c, profileOperations: operations };
  const avatarInput = el("input", { attrs: { type: "file", accept: "image/avif,image/png,image/jpeg,image/webp", hidden: true } });
  const avatarPreview = avatar(c.account);
  const avatarMessage = el("span", { className: "inline-message avatar-message", attrs: { "aria-live": "polite" } });
  const avatarDetails = el("p", { className: "avatar-details muted", attrs: { hidden: true } });
  const avatarButton = button(c.t("upload"), "quiet");
  const confirmAvatar = button(c.t("avatarConfirm"), "primary");
  const cancelAvatar = button(c.t("avatarCancel"), "quiet");
  const preparedActions = el("div", { className: "button-row avatar-prepared-actions", attrs: { hidden: true } }, confirmAvatar, cancelAvatar);
  const currentAvatarUrl = c.account.profile.avatar_url || "/icons/logo.svg";
  const prepare = c.prepareAvatar ?? processAvatarImage;
  let prepared: ProcessedAvatar | undefined;
  let selectionRevision = 0;

  /** 释放本地预览并恢复服务端头像。Releases the local preview and restores the server avatar. */
  const discardPrepared = (clearMessage = true): void => {
    prepared?.dispose();
    prepared = undefined;
    avatarPreview.src = currentAvatarUrl;
    avatarDetails.hidden = true;
    avatarDetails.textContent = "";
    preparedActions.hidden = true;
    avatarButton.textContent = c.t("upload");
    mutationBusy(avatarButton, false, c);
    if (clearMessage) avatarMessage.textContent = "";
  };
  const removeAvatar = c.account.profile.avatar_url
    ? actionButton(c.t("remove"), async (btn) => {
      selectionRevision += 1;
      discardPrepared();
      await c.api.deleteAvatar(proof(c));
      if (!c.signal.aborted) await c.refresh("avatar-saved");
      mutationBusy(btn, false, c);
    }, "danger", c)
    : null;

  avatarButton.addEventListener("click", () => { if (!c.profileOperations?.pending && !c.signal.aborted) avatarInput.click(); });
  avatarInput.addEventListener("change", async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    const release = beginProfileOperation(c);
    if (!release) { avatarInput.value = ""; return; }
    const revision = ++selectionRevision;
    discardPrepared(false);
    avatarMessage.textContent = c.t("avatarPreparing");
    mutationBusy(avatarButton, true, c);
    try {
      const next = await prepare(file);
      if (c.signal.aborted || revision !== selectionRevision) { next.dispose(); return; }
      prepared = next;
      avatarPreview.src = next.previewUrl;
      avatarDetails.textContent = formatAvatarOutput(next.metadata, c.locale);
      avatarDetails.hidden = false;
      preparedActions.hidden = false;
      avatarButton.textContent = c.t("avatarReselect");
      avatarMessage.textContent = c.t("avatarPrepared");
    } catch (error) {
      if (!c.signal.aborted && revision === selectionRevision) avatarMessage.textContent = avatarPreparationError(error, c.t);
    } finally {
      avatarInput.value = "";
      if (revision === selectionRevision) mutationBusy(avatarButton, false, c);
      release();
    }
  });
  cancelAvatar.addEventListener("click", () => { if (c.profileOperations?.pending || c.signal.aborted) return; selectionRevision += 1; discardPrepared(); });
  confirmAvatar.addEventListener("click", async () => {
    const uploading = prepared;
    if (!uploading) return;
    const release = beginProfileOperation(c);
    if (!release) return;
    mutationBusy(confirmAvatar, true, c); mutationBusy(avatarButton, true, c); mutationBusy(cancelAvatar, true, c); if (removeAvatar) mutationBusy(removeAvatar, true, c);
    try {
      await c.api.uploadAvatar(uploading.file, proof(c));
      if (c.signal.aborted) return;
      if (prepared === uploading) discardPrepared(false);
      avatarMessage.textContent = c.t("saved");
      await c.refresh("avatar-saved");
    } catch (error) {
      if (!c.signal.aborted) avatarMessage.textContent = errorText(error, c.t("unexpectedError"), c.t("networkUnavailable"));
    } finally {
      mutationBusy(confirmAvatar, false, c); mutationBusy(avatarButton, false, c); mutationBusy(cancelAvatar, false, c); if (removeAvatar) mutationBusy(removeAvatar, false, c);
      release();
    }
  });
  c.signal.addEventListener("abort", () => { selectionRevision += 1; discardPrepared(); }, { once: true });
  const profileForm = el("form", { className: "card form-card moe-glass" },
    el("h2", {}, c.t("editProfile")), inputField(c.t("displayName"), "display_name", c.account.profile.display_name, { required: true, autocomplete: "name", dir: "auto" }),
    textAreaField(c.t("bio"), "bio", c.account.profile.bio ?? ""),
    inputField(c.t("statusMessage"), "status_message", c.account.profile.status_message ?? "", { dir: "auto" }),
    inputField(c.t("pronouns"), "pronouns", c.account.profile.pronouns ?? ""),
    inputField(c.t("favoriteCharacter"), "favorite_character", c.account.profile.favorite_character ?? "", { dir: "auto" }),
    inputField(c.t("interests"), "interests", c.account.profile.interests?.join(", ") ?? "", { placeholder: "Touhou, Vocaloid, Rust" }),
    textAreaField(c.t("links"), "links", c.account.profile.links?.join("\n") ?? ""),
    selectField(c.t("visibility"), "profile_visibility", [["private", c.t("private")], ["members", c.t("members")], ["public", c.t("public")]], c.account.profile.profile_visibility ?? "members"),
    localeSelectField(c.t("locale"), c.preferences.locale),
    inputField(c.t("timezone"), "timezone", c.preferences.timezone, { required: true, placeholder: "Asia/Shanghai" }),
    el("div", { className: "form-actions" }, button(c.t("save"), "primary", "submit"), el("span", { className: "inline-message", attrs: { "aria-live": "polite" } })),
  );
  const acceptProfileDraft = trackFormDraft(profileForm);
  let saveState: "idle" | "pending" | "completed" = "idle";
  profileForm.addEventListener("input", (event) => (event.target as HTMLElement | null)?.removeAttribute("aria-invalid"));
  profileForm.addEventListener("change", (event) => (event.target as HTMLElement | null)?.removeAttribute("aria-invalid"));
  profileForm.addEventListener("submit", async (event) => {
    event.preventDefault(); const submit = profileForm.querySelector<HTMLButtonElement>("[type=submit]")!; const message = profileForm.querySelector<HTMLElement>(".inline-message")!;
    if (saveState !== "idle" || c.signal.aborted || c.profileOperations?.pending) return;
    const data = new FormData(profileForm);
    const input = readProfileInput(data);
    if (!input.valid) {
      message.setAttribute("role", "alert");
      message.textContent = c.t(input.issue.message).replace("{limit}", String(input.issue.limit ?? "")).replace("{item}", String(input.issue.item ?? ""));
      const field = profileForm.elements.namedItem(input.issue.field) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      field.setAttribute("aria-invalid", "true"); field.focus(); return;
    }
    for (const field of profileForm.querySelectorAll('[aria-invalid="true"]')) field.removeAttribute("aria-invalid");
    const release = beginProfileOperation(c);
    if (!release) return;
    message.setAttribute("role", "status"); message.textContent = "";
    saveState = "pending";
    mutationBusy(submit, true, c);
    let confirmed = 0;
    try {
      // A rejected sibling must not release ownership while another write can still commit.
      const [details, preferences] = await Promise.allSettled([
        c.api.updateMe(input.profile, proof(c)),
        c.api.updatePreferences(input.preferences, proof(c)),
      ]);
      if (c.signal.aborted) return;
      const accepted = [...(details.status === "fulfilled" ? Object.keys(input.profile) : []), ...(preferences.status === "fulfilled" ? ["locale", "timezone"] : [])];
      confirmed = Number(details.status === "fulfilled") + Number(preferences.status === "fulfilled");
      if (!confirmed) {
        saveState = "idle"; message.setAttribute("role", "alert");
        message.textContent = `${c.t("profileSaveUnconfirmed")} ${errorText(details.status === "rejected" ? details.reason : undefined, c.t("unexpectedError"), c.t("networkUnavailable"))}`;
        return;
      }
      acceptProfileDraft(data, accepted);
      saveState = "completed";
      const newerEdits = hasUnsavedChanges(main);
      message.textContent = c.t(confirmed === 1 ? "loading" : newerEdits ? "savedWithNewChanges" : "saved");
      // The coordinator refreshes canonical session data and rehydrates newer edits into a fresh form.
      await c.refresh(confirmed === 2 ? "profile-saved" : details.status === "fulfilled" ? "profile-partial-details" : "profile-partial-preferences");
      if (!c.signal.aborted) {
        saveState = "idle";
        if (confirmed === 1) { message.setAttribute("role", "alert"); message.textContent = c.t(details.status === "fulfilled" ? "profilePartialDetails" : "profilePartialPreferences"); }
      }
    } catch (error) {
      if (!c.signal.aborted) {
        message.setAttribute("role", "alert");
        message.textContent = confirmed ? c.t(confirmed === 2 ? "profileSavedRefreshFailed" : "profilePartialRefreshFailed") : errorText(error, c.t("unexpectedError"), c.t("networkUnavailable"));
        if (!confirmed) saveState = "idle";
      }
    } finally { if (!c.signal.aborted && saveState === "idle") mutationBusy(submit, false, c); release(); }
  });
  replace(main, heading(c.t("profile"), `@${username(c.account)}`),
    el("section", { className: "card avatar-card moe-glass" }, avatarPreview, el("div", { className: "avatar-controls" }, el("h2", {}, c.t("avatar")), el("p", { className: "muted" }, c.t("avatarFormats")), avatarDetails, el("div", { className: "button-row" }, avatarInput, avatarButton, removeAvatar), preparedActions, avatarMessage)),
    profileForm, contactsPanel(contacts, c));
  operations.register(main);
}

/** 联系方式卡片允许跨国手机号并显式展示验证状态。Contact card supports international numbers and explicit verification state. */
function contactsPanel(contacts: Contact[], c: PageContext): HTMLElement {
  const rows = contacts.map((contact) => el("article", { className: "entity-row" },
    icon(contact.kind === "email" ? "mail" : "phone"),
    el("div", {}, el("strong", {}, contact.value), el("div", { className: "badge-row" },
      badge(contact.verification_state === "verified" ? c.t("verified") : c.t("pending"), contact.verification_state === "verified" ? "good" : "warm"),
      contact.is_primary ? badge(c.t("primary"), "accent") : null,
    ), contact.kind === "mobile" && contact.verification_state !== "verified" ? el("p", { className: "muted" }, c.t("mobileVerificationUnavailable")) : null),
    el("div", { className: "row-actions" },
      // The paired backend supports email delivery only; do not offer a permanently failing SMS action.
      contact.kind === "email" && contact.verification_state !== "verified" ? verificationButton(contact, c) : null,
      !contact.is_primary && contact.verification_state === "verified" ? actionButton(c.t("makePrimary"), async (btn) => { await c.api.makePrimary(contact.contact_id, proof(c)); if (!c.signal.aborted) await c.refresh(); mutationBusy(btn, false, c); }, "quiet", c) : null,
      actionButton(c.t("remove"), async (btn) => { await c.api.deleteContact(contact.contact_id, proof(c)); if (!c.signal.aborted) await c.refresh(); mutationBusy(btn, false, c); }, "danger", c),
    ),
  ));
  const list = el("div", { className: "entity-list" }, ...rows);
  const mobileNotice = el("p", { className: "muted", attrs: { id: "mobile-verification-note", hidden: true } }, c.t("mobileVerificationUnavailable"));
  const mobileHint = el("p", { className: "muted", attrs: { id: "mobile-format-note", hidden: true } }, c.t("mobileHint"));
  const form = el("form", { className: "contact-form" },
    selectField(c.t("contacts"), "kind", [["email", c.t("email")], ["mobile", c.t("mobile")]], "email"),
    selectField(c.t("countryRegion"), "calling_code", [["+86", `+86 ${c.t("mainlandChina")}`], ["+81", `+81 ${c.t("japan")}`], ["+65", `+65 ${c.t("singapore")}`], ["+1", `+1 ${c.t("usCanada")}`], ["+44", `+44 ${c.t("unitedKingdom")}`], ["+852", `+852 ${c.t("hongKong")}`]], "+86"),
    inputField(c.t("value"), "value", "", { required: true, autocomplete: "email" }), mobileHint, mobileNotice, button(c.t("add"), "primary", "submit"), el("span", { className: "inline-message" }),
  );
  const codeField = form.querySelector<HTMLElement>("[name=calling_code]")!.closest("label")!;
  const kind = form.querySelector<HTMLSelectElement>("[name=kind]")!;
  const value = form.querySelector<HTMLInputElement>("[name=value]")!;
  const syncKind = () => {
    const mobile = kind.value === "mobile";
    codeField.hidden = !mobile; mobileNotice.hidden = !mobile; mobileHint.hidden = !mobile;
    const input = form.querySelector<HTMLInputElement>("[name=value]")!;
    input.type = mobile ? "tel" : "email"; input.autocomplete = mobile ? "tel-national" : "email";
    input.removeAttribute("aria-invalid");
    if (mobile) input.setAttribute("aria-describedby", `${mobileHint.id} ${mobileNotice.id}`);
    else input.removeAttribute("aria-describedby");
  };
  kind.addEventListener("change", syncKind); syncKind();
  value.addEventListener("input", () => value.removeAttribute("aria-invalid"));
  form.querySelector("[name=calling_code]")!.addEventListener("change", () => value.removeAttribute("aria-invalid"));
  const submit = form.querySelector<HTMLButtonElement>("[type=submit]")!;
  const message = form.querySelector<HTMLElement>(".inline-message")!;
  message.setAttribute("role", "alert");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled || c.signal.aborted) return;
    const data = new FormData(form);
    const contactKind = String(data.get("kind")) as "email" | "mobile";
    const raw = String(data.get("value")).trim();
    const mobile = normalizeMobileInput(String(data.get("calling_code")), raw);
    if (contactKind === "mobile" && mobile.kind !== "valid") {
      const key = mobile.kind === "empty" ? "mobileInvalid" : ({ invalid: "mobileInvalid", "country-mismatch": "mobileCountryMismatch", "international-prefix": "mobileInternationalPrefix" } as const)[mobile.reason];
      message.textContent = c.t(key);
      value.setAttribute("aria-invalid", "true"); value.focus(); return;
    }
    const release = beginProfileOperation(c);
    if (!release) return;
    mutationBusy(submit, true, c);
    message.textContent = "";
    try {
      await c.api.addContact(contactKind === "mobile" && mobile.kind === "valid"
        ? { kind: contactKind, mobile: mobile.mobile }
        : { kind: "email", email: raw }, proof(c));
      if (!c.signal.aborted) await c.refresh();
    } catch (error) {
      if (!c.signal.aborted) message.textContent = errorText(error, c.t("unexpectedError"), c.t("networkUnavailable"));
    } finally { mutationBusy(submit, false, c); release(); }
  });
  return el("section", { className: "card moe-glass" }, el("h2", {}, c.t("contacts")), list, form);
}

/** 安全中心把密码与 Passkey 视为并列登录方式。Security treats passwords and passkeys as peer sign-in methods. */
async function renderSecurity(main: HTMLElement, c: PageContext): Promise<void> {
  const [security, credentials] = await Promise.all([c.api.getSecurity(c.signal), c.api.listCredentials(c.signal)]); if (c.signal.aborted) return;
  const loginUrl = loginManagementUrl("passkeys");
  replace(main, heading(c.t("security"), c.t(securityAttention(security) ? "danger" : "secure")),
    el("div", { className: "security-grid" },
      securityCard("key", c.t("passkeys"), `${security.passkey_count}`, el("a", { className: "button primary", attrs: { href: loginUrl } }, c.t("manageAtLogin"))),
      passwordCard(security, c),
      securityCard("shield", c.t("twoFactor"), security.mfa_methods.length > 1 ? c.t("enabled") : c.t("comingSoon"), el("span", { className: "badge warm" }, c.t("technicalMethods"))),
      securityCard("sparkle", c.t("recovery"), security.recovery_ready ? c.t("enabled") : c.t("disabled"), el("a", { className: "button quiet", attrs: { href: loginManagementUrl("recovery") } }, c.t("manageAtLogin"))),
    ),
    el("section", { className: "card moe-glass" }, el("h2", {}, c.t("passkeys")), ...credentials.items.map((credential) => passkeyRow(credential, c))),
  );
}

/** 密码可选；近期认证不足时沿用安全操作的 Login 回跳。Password is optional; recent-auth failures use the shared Login return flow. */
function passwordCard(security: SecuritySummary, c: PageContext): HTMLElement {
  const save = button(security.password ? c.t("save") : c.t("add"), "quiet", "submit");
  const remove = security.password ? button(c.t("remove"), "danger") : undefined;
  const message = el("span", { className: "inline-message", attrs: { "aria-live": "polite", role: "status" } });
  const form = el("form", { className: "password-form" },
    security.password ? inputField(c.t("currentPassword"), "current_password", "", { required: true, type: "password", autocomplete: "current-password" }) : null,
    inputField(c.t("newPassword"), "password", "", { required: true, type: "password", autocomplete: "new-password", "aria-describedby": "password-policy" }),
    el("p", { className: "muted", attrs: { id: "password-policy" } }, c.t("passwordPolicy")),
    save, remove, message,
  );
  const fields = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="password"]'));
  const next = form.querySelector<HTMLInputElement>('[name="password"]')!;
  let operation: "idle" | "pending" | "completed" = "idle";

  /** One owner serializes set/remove; completed mutations are never replayed after refresh failure. */
  async function mutate(kind: "set" | "remove"): Promise<void> {
    if (operation !== "idle" || c.signal.aborted) return;
    if (kind === "set" && !validate()) return;
    const password = next.value;
    const current = form.querySelector<HTMLInputElement>('[name="current_password"]')?.value ?? "";
    operation = "pending";
    lock(true);
    message.replaceChildren();
    try {
      if (kind === "set") await c.api.setPassword(password, proof(c), current);
      else await c.api.deletePassword(proof(c));
      if (c.signal.aborted) return;
      operation = "completed";
      clearSecrets();
      message.setAttribute("role", "status");
      message.textContent = c.t(kind === "set" ? "passwordUpdated" : "passwordRemoved");
      await c.refresh();
    } catch (error) {
      if (c.signal.aborted) return;
      message.setAttribute("role", "alert");
      if (operation === "completed") message.textContent = c.t("passwordRefreshFailed");
      else { operation = "idle"; presentFailure(error); }
    } finally {
      settleBusy();
      if (operation === "idle" && !c.signal.aborted) lock(false);
    }
  }

  /** Native required-field validation remains; length is counted in scalars, not HTML UTF-16 units. */
  function validate(): boolean {
    const valid = isValidNewPassword(next.value);
    next.setCustomValidity(valid ? "" : c.t("passwordPolicy"));
    next.setAttribute("aria-invalid", String(!valid));
    if (!valid) { message.setAttribute("role", "alert"); message.textContent = c.t("passwordPolicy"); }
    return form.reportValidity();
  }

  /** Shared error presentation preserves recent-auth and last-authenticator backend policy. */
  function presentFailure(error: unknown): void {
    const presentation = mutationErrorPresentation(error, c.t, location);
    message.replaceChildren(presentation.message);
    if (presentation.actionHref) message.append(el("a", { className: "button quiet", attrs: { href: presentation.actionHref } }, presentation.actionLabel));
  }

  /** Credentials stay local to this form and are cleared after commit or route abort. */
  function clearSecrets(): void { for (const field of fields) field.value = ""; }

  /** Disables both conflicting actions and credential editing while their shared owner runs. */
  function lock(pending: boolean): void {
    form.setAttribute("aria-busy", String(pending));
    for (const control of [save, remove]) if (control) busy(control, pending);
    for (const field of fields) field.disabled = pending;
  }

  /** Completion and abandonment are not pending, even when their obsolete controls stay locked. */
  function settleBusy(): void {
    form.setAttribute("aria-busy", "false");
    for (const control of [save, remove]) if (control) control.setAttribute("aria-busy", "false");
  }

  next.addEventListener("input", () => { next.setCustomValidity(""); next.removeAttribute("aria-invalid"); });
  c.signal.addEventListener("abort", () => { operation = "completed"; clearSecrets(); lock(true); settleBusy(); }, { once: true });
  remove?.addEventListener("click", () => void mutate("remove"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await mutate("set");
  });
  return securityCard("shield", c.t("password"), security.password ? c.t("enabled") : c.t("disabled"), form);
}

/** 会话页面支持逐个退出但保留当前上下文。Sessions can be revoked individually while preserving the current context. */
async function renderSessions(main: HTMLElement, c: PageContext): Promise<void> {
  const sessions = await c.api.listSessions(c.signal); if (c.signal.aborted) return;
  const rows = sessions.items.map((session) => sessionRow(session, c));
  replace(main, heading(c.t("sessions"), c.t("devicesIntro")), el("section", { className: "card moe-glass" }, ...(rows.length ? rows : [empty(c.t("noSessions"))])));
}

/** Retained revoked sessions are history, not actionable devices; Identity remains authoritative. */
function sessionRow(session: Session, c: PageContext): HTMLElement {
  let control: HTMLElement;
  if (session.revoked_at) control = el("span", { className: "badge good", attrs: { role: "status" } }, c.t("signedOut"));
  else if (session.is_current) control = badge(c.t("current"), "accent");
  else control = actionButton(c.t("revoke"), async (btn) => {
    await c.api.revokeSession(session.session_id, proof(c));
    await c.refresh();
    busy(btn, false);
  }, "danger", c);
  const method = session.authentication_method === "password" ? "password" : session.authentication_method === "passkey" ? "passkeys" : "federated";
  return el("article", { className: "entity-row" }, icon("devices"),
    el("div", {}, el("strong", {}, c.t(method)),
      el("p", { className: "muted" }, [session.amr.join(" + "), formatTime(session.last_seen_at, c.locale)].join(" · ")),
      session.revoked_at ? el("p", { className: "muted" }, `${c.t("signedOut")} · ${formatTime(session.revoked_at, c.locale)}`) : null),
    control);
}

/** 已连接应用清楚列出 scope 与最后使用时间。Connected apps expose scopes and last use. */
async function renderApps(main: HTMLElement, c: PageContext): Promise<void> {
  const apps = await c.api.listConnectedApps(c.signal); if (c.signal.aborted) return;
  replace(main, heading(c.t("apps"), c.t("connectedIntro")), el("div", { className: "app-grid" }, ...(apps.items.length ? apps.items.map((app) => el("article", { className: "card app-card moe-glass" }, app.logo_url ? el("img", { className: "app-logo", attrs: { src: app.logo_url, alt: "" } }) : icon("apps"), el("h2", {}, app.display_name), el("p", { className: "muted" }, `${c.t("permissions")}: ${app.scopes.join(" · ")}`), el("p", { className: "muted" }, formatTime(app.last_used_at ?? app.granted_at, c.locale)), actionButton(c.t("disconnect"), async (btn) => { await c.api.revokeConnectedApp(app.authorization_id, proof(c)); await c.refresh(); busy(btn, false); }, "danger", c))) : [empty(c.t("noApps"))])));
}

/** 页面标题。Page heading. */
function heading(title: string, intro: string): HTMLElement { return el("header", { className: "page-heading" }, el("p", { className: "eyebrow" }, "MOESEGFAULT"), el("h1", {}, title), el("p", { className: "lede" }, intro)); }
/** 快捷入口。Quick entry. */
function quick(iconName: string, title: string, text: string, href: Route): HTMLElement { return el("a", { className: "quick-card moe-glass", attrs: { href }, dataset: { route: href } }, icon(iconName), el("div", {}, el("h2", {}, title), el("p", {}, text)), icon("chevron")); }
/** 用户头像，缺省使用品牌而非远程占位服务。User avatar with a local brand fallback. */
function avatar(account: Account): HTMLImageElement { return el("img", { className: "avatar", attrs: { src: account.profile.avatar_url || "/icons/logo.svg", alt: account.profile.display_name } }); }
/** 普通输入字段。Ordinary input field. */
function inputField(label: string, name: string, value: string, attrs: Record<string, string | boolean> = {}): HTMLLabelElement { return el("label", { className: "field" }, el("span", {}, label), el("input", { attrs: { name, value, ...attrs } })); }
/** Preserves line-separated values; length limits are opt-in to match each API field. */
function textAreaField(label: string, name: string, value: string): HTMLLabelElement { const area = el("textarea", { attrs: { name, rows: "4" } }, value); return el("label", { className: "field" }, el("span", {}, label), area); }
/** 选择字段。Select field. */
function selectField(label: string, name: string, options: ReadonlyArray<readonly [string, string]>, selected: string): HTMLLabelElement { return el("label", { className: "field" }, el("span", {}, label), el("select", { attrs: { name } }, ...options.map(([value, text]) => el("option", { attrs: { value, selected: value === selected } }, text)))); }
/** 使用共享自称元数据的语言字段。Locale field backed by shared autonym metadata. */
function localeSelectField(label: string, selected: Locale): HTMLLabelElement { const select = el("select", { attrs: { name: "locale" } }, ...localeOptions(selected)); select.value = selected; return el("label", { className: "field" }, el("span", {}, label), select); }
/** 一致按钮。Consistent button. */
function button(text: string, tone: "primary" | "quiet" | "danger", type: "button" | "submit" = "button"): HTMLButtonElement { return el("button", { className: `button ${tone}`, attrs: { type } }, text); }
/** 异步 mutation 按钮；近期认证不足时统一展示 Login 动作。Async mutation button with shared recent-auth recovery UX. */
function actionButton(text: string, action: (button: HTMLButtonElement) => Promise<void>, tone: "primary" | "quiet" | "danger", c: PageContext): HTMLButtonElement {
  const result = button(text, tone); let feedback: HTMLElement | undefined;
  result.addEventListener("click", async () => {
    const release = beginProfileOperation(c);
    if (!release) return;
    feedback?.remove(); mutationBusy(result, true, c);
    try { await action(result); }
    catch (error) {
      if (c.signal.aborted) return;
      const presentation = mutationErrorPresentation(error, c.t, location);
      feedback = el("span", { className: "inline-message mutation-feedback", attrs: { role: "alert" } }, presentation.message,
        presentation.actionHref ? el("a", { className: "button quiet", attrs: { href: presentation.actionHref } }, presentation.actionLabel) : null);
      result.insertAdjacentElement("afterend", feedback); mutationBusy(result, false, c);
    } finally { release(); }
  });
  return result;
}

/** Other routes have no shared owner; Profile commands and preparation acquire the same page-local lease. */
function beginProfileOperation(c: PageContext): (() => void) | undefined {
  if (c.signal.aborted) return undefined;
  return c.profileOperations ? c.profileOperations.acquire() : () => {};
}

/** Local disabled intent remains authoritative under the Profile lock, including terminal Save state. */
function mutationBusy(control: HTMLButtonElement, pending: boolean, c: PageContext): void {
  if (!c.profileOperations) { busy(control, pending); return; }
  control.setAttribute("aria-busy", String(pending));
  c.profileOperations.setDisabled(control, pending);
}
/** 状态徽章。Status badge. */
function badge(text: string, tone: "good" | "warm" | "accent"): HTMLElement { return el("span", { className: `badge ${tone}` }, text); }
/** 空状态。Empty state. */
function empty(text: string): HTMLElement { return el("div", { className: "empty" }, icon("sparkle"), el("p", {}, text)); }
/** 加载状态。Loading status. */
function status(text: string): HTMLElement { return el("div", { className: "loading", attrs: { role: "status" } }, icon("sparkle"), text); }
/** 生成 mutation proof。Constructs a mutation proof. */
function proof(c: PageContext): MutationProof { return { csrfToken: c.csrfToken, signal: c.signal }; }
/** 用本地数字格式展示最终上传尺寸与体积。Formats final upload dimensions and bytes with locale-aware digits. */
export function formatAvatarOutput(metadata: Pick<ProcessedAvatarMetadata, "edge" | "outputBytes" | "mediaType">, locale: Locale): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const bytes = metadata.outputBytes;
  const [value, unit] = bytes >= 1024 * 1024
    ? [bytes / (1024 * 1024), "MiB"]
    : bytes >= 1024
      ? [bytes / 1024, "KiB"]
      : [bytes, "B"];
  const encoding = metadata.mediaType === "image/webp" ? "WebP" : "PNG";
  return `${number.format(metadata.edge)} × ${number.format(metadata.edge)} px · ${number.format(value)} ${unit} · ${encoding}`;
}
/** 将共享处理错误映射为本地化界面文案。Maps shared processing failures to localized UI copy. */
export function avatarPreparationError(error: unknown, t: (key: MessageKey) => string): string {
  if (!(error instanceof AvatarImageError)) return t("avatarProcessingFailed");
  if (error.code === "INPUT_TOO_LARGE") return t("avatarTooLarge");
  if (error.code === "UNSUPPORTED_TYPE") return t("avatarInvalidType");
  if (error.code === "EMPTY_INPUT") return t("avatarEmpty");
  return t("avatarProcessingFailed");
}
/** Preserves legacy error text and support IDs; optional network wording localizes known transport failures. */
export function errorText(error: unknown, fallback = "", networkMessage?: string): string { if (error instanceof ApiError) return `${apiErrorMessage(error, networkMessage)}${error.correlationId ? ` · ID ${error.correlationId}` : ""}`; return error instanceof Error ? error.message : fallback; }
/** 安全摘要是否需要注意。Whether a security summary needs attention. */
export function securityAttention(value: SecuritySummary): boolean { return value.passkey_count + Number(value.password) === 0 || !value.recovery_ready; }
/** 由 Login origin 完成 WebAuthn，Account 不跨 RP 调用 ceremony。Routes WebAuthn through the Login origin instead of crossing RP boundaries. */
export function loginManagementUrl(section: "passkeys" | "recovery"): string { const path = section === "passkeys" ? "/passkey/enroll" : "/recovery-codes/rotate"; return `${resolveLoginOrigin(location)}${path}?return_uri=${encodeURIComponent(`${resolveAccountOrigin(location)}/security`)}`; }

/** 为当前 Account 页生成严格的同环境再认证地址。Builds a strict same-environment reauthentication URL for the current Account page. */
export function reauthenticationUrl(current: Pick<Location, "hostname" | "pathname">): string {
  const login = new URL("/login", resolveLoginOrigin(current));
  login.searchParams.set("return_uri", `${resolveAccountOrigin(current)}${resolveRoute(current.pathname)}`);
  return login.href;
}

/** mutation 错误的可测试展示模型。Testable presentation model for mutation errors. */
export function mutationErrorPresentation(error: unknown, t: (key: MessageKey) => string, current: Pick<Location, "hostname" | "pathname">): { message: string; actionHref?: string; actionLabel?: string } {
  if (error instanceof ApiError && error.problem?.error_code === "reauthentication_required") {
    return { message: t("reauthenticationBody"), actionHref: reauthenticationUrl(current), actionLabel: t("reauthenticate") };
  }
  return { message: errorText(error, t("unexpectedError"), t("networkUnavailable")) };
}
/** 安全卡片。Security card. */
function securityCard(iconName: string, title: string, value: string, child: HTMLElement): HTMLElement { return el("article", { className: "card security-card moe-glass" }, icon(iconName), el("div", {}, el("h2", {}, title), el("strong", { className: "security-value" }, value)), child); }

/** Passkey 行提供本地管理动作；只有登记 ceremony 回到 Login。Passkey rows manage metadata locally; only enrollment returns to Login. */
function passkeyRow(credential: Credential, c: PageContext): HTMLElement {
  const actions = el("div", { className: "row-actions" });
  const rename = button(c.t("rename"), "quiet");
  rename.addEventListener("click", () => {
    const form = el("form", { className: "verification-form" }, inputField(c.t("passkeyLabel"), "label", credential.label, { required: true, maxlength: "80" }), buttonElement(c.t("save")), el("span", { className: "inline-message" }));
    form.addEventListener("submit", async (event) => { event.preventDefault(); const submit = form.querySelector<HTMLButtonElement>("button")!; busy(submit, true); try { await c.api.renameCredential(credential.authenticator_id, String(new FormData(form).get("label")), proof(c)); await c.refresh(); } catch (error) { form.querySelector<HTMLElement>(".inline-message")!.textContent = errorText(error, c.t("unexpectedError"), c.t("networkUnavailable")); busy(submit, false); } });
    actions.replaceWith(form);
  });
  actions.append(rename, actionButton(c.t("revoke"), async (btn) => { await c.api.revokeCredential(credential.authenticator_id, proof(c)); await c.refresh(); busy(btn, false); }, "danger", c));
  return el("article", { className: "entity-row" }, icon("key"), el("div", {}, el("strong", { attrs: { dir: "auto" } }, credential.label), el("p", { className: "muted" }, formatTime(credential.last_used_at, c.locale)), credential.is_current ? badge(c.t("current"), "accent") : null), actions);
}

/**
 * 把发送、输入和重新发送验证码保留在当前联系方式行内。
 * Keeps code delivery, entry, and resend within the contact row.
 *
 * 首次发送失败时保留原按钮；事务过期或提交失败后，用户可直接重新发送而不必刷新页面。
 * The original button survives an initial delivery failure; after expiry or a failed
 * completion, users can resend without refreshing the page. Delivery and confirmation
 * share one operation owner because a successful resend invalidates the previous code.
 */
function verificationButton(contact: Contact, c: PageContext): HTMLButtonElement {
  let deliveryFeedback: HTMLElement | undefined;
  return actionButton(c.t("verify"), async (verifyButton) => {
    deliveryFeedback?.remove();
    let transaction: Awaited<ReturnType<AccountApiClient["startContactVerification"]>>;
    try {
      transaction = await c.api.startContactVerification(contact.contact_id, proof(c));
    } catch (error) {
      if (c.signal.aborted) return;
      deliveryFeedback = el("div", { className: "inline-message mutation-feedback" });
      setVerificationError(deliveryFeedback, error, c);
      verifyButton.insertAdjacentElement("afterend", deliveryFeedback);
      mutationBusy(verifyButton, false, c);
      return;
    }
    const form = el("form", { className: "verification-form" },
      inputField(`${c.t("verificationCode")} · ${transaction.delivery_hint}`, "code", "", { required: true, autocomplete: "one-time-code", inputmode: "numeric", minlength: "8", maxlength: "8", pattern: "[0-9]{8}" }),
      el("div", { className: "verification-actions" }, buttonElement(c.t("confirm")), button(c.t("resendCode"), "quiet")),
      el("div", { className: "inline-message success", attrs: { "aria-live": "polite", role: "status" } }, c.t("verificationSent")),
    );
    const code = form.querySelector<HTMLInputElement>("[name=code]")!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const resend = form.querySelector<HTMLButtonElement>('button[type="button"]')!;
    // Sending replaces the transaction; it must never overlap confirmation of the old code.
    let pending = false;
    const lock = (value: boolean) => {
      pending = value;
      mutationBusy(submit, value, c);
      mutationBusy(resend, value, c);
      code.readOnly = value || c.signal.aborted;
    };
    const message = form.querySelector<HTMLElement>(".inline-message")!;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending || c.signal.aborted) return;
      const release = beginProfileOperation(c);
      if (!release) return;
      lock(true);
      try {
        await c.api.completeContactVerification(contact.contact_id, transaction.transaction_id, code.value, proof(c));
        if (c.signal.aborted) return;
        setVerificationMessage(message, c.t("verificationComplete"), true);
        await c.refresh();
      } catch (error) {
        if (!c.signal.aborted) setVerificationError(message, error, c);
      } finally { lock(false); release(); }
    });
    resend.addEventListener("click", async () => {
      if (pending || c.signal.aborted) return;
      const release = beginProfileOperation(c);
      if (!release) return;
      lock(true);
      try {
        transaction = await c.api.startContactVerification(contact.contact_id, proof(c));
        if (c.signal.aborted) return;
        code.value = "";
        setVerificationMessage(message, c.t("verificationSent"), true);
        code.focus();
      } catch (error) {
        if (!c.signal.aborted) setVerificationError(message, error, c);
      } finally { lock(false); release(); }
    });
    if (c.signal.aborted) return;
    c.profileOperations?.register(form);
    verifyButton.replaceWith(form);
    code.focus();
  }, "quiet", c);
}

/**
 * Presents stable Problem Details codes as localized recovery steps, never server prose.
 * Support identifiers stay in closed native details; no destination or code is echoed.
 */
function setVerificationError(message: HTMLElement, error: unknown, c: PageContext): void {
  const apiError = error instanceof ApiError ? error : undefined;
  const problem = apiError?.problem;
  const typePrefix = "https://identity.moesegfault.dev/problems/";
  const code = problem?.error_code ?? (problem?.type?.startsWith(typePrefix) ? problem.type.slice(typePrefix.length) : undefined);
  const keys = new Map<string, MessageKey>([
    ["invalid_verification_code", "verificationWrongCode"],
    ["transaction_expired", "verificationExpired"],
    ["rate_limited", "verificationRateLimited"],
    ["service_unavailable", "verificationUnavailable"],
    ["authentication_required", "verificationSignIn"],
  ]);
  const key = (code && keys.get(code)) || (apiError?.status === 429 ? "verificationRateLimited"
    : apiError?.status === 401 ? "verificationSignIn"
    : apiError?.status === 0 || error instanceof TypeError ? "verificationNetwork" : "verificationRetry");
  setVerificationMessage(message, c.t(key), false);
  const correlation = apiError?.correlationId ?? problem?.correlation_id;
  if (correlation) message.append(el("details", {},
    el("summary", {}, c.t("verificationDiagnostics")), el("code", {}, `ID ${correlation}`)));
}

/** 更新验证码反馈的语义与视觉状态。Updates verification feedback semantics and visual state. */
function setVerificationMessage(message: HTMLElement, text: string, success: boolean): void {
  message.textContent = text;
  message.classList.toggle("success", success);
  message.setAttribute("role", success ? "status" : "alert");
}

/** 验证表单提交按钮。Verification form submit button. */
function buttonElement(text: string): HTMLButtonElement { return el("button", { className: "button primary", attrs: { type: "submit" } }, text); }

/** 从稳定标识符读取用户名。Reads the username from stable identifiers. */
function username(account: Account): string { return account.identifiers.find((identifier) => identifier.kind === "username")?.value ?? account.principal_id.slice(0, 8); }
