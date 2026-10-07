import "./styles.css";
import { AccountApiClient, ApiError } from "./api/client";
import { apiErrorMessage } from "./api/error-message";
import { accountLoginUrl, accountRegistrationUrl, resolveIdentityOrigin, resolveLoginOrigin } from "./environment";
import { normalizeLocale, translator, type Locale } from "./i18n";
import { applyTheme, isInAppBrowser, readPreferences, safeStorage, writePreference, type Theme } from "./preferences";
import { renderPage, type RefreshFeedback } from "./pages";
import { installRouter, resolveRoute, type NavigationDraftPolicy } from "./router";
import { el, icon, replace } from "./ui/dom";
import { createShell } from "./ui/shell";
import { localeOptions } from "./ui/locale-select";
import { createAnonymousLanding } from "./ui/anonymous-landing";
import { signOutCurrentSession } from "./sign-out";
import { authenticatedSession, type AccountSession } from "./session";
import { captureProfileDraft, captureProfileValues, profileChangesSince, hasUnsavedChanges, installDraftExitWarning, restoreProfileDraft, type ProfileDraft } from "./draft";
import { DraftDiscardDialog, type DraftExitIntent } from "./ui/draft-dialog";
import { createProfileOperations, type ProfileOperations } from "./profile-operations";

const mount = document.querySelector<HTMLElement>("#app");
if (!mount) throw new Error("Missing #app mount point");
const media = matchMedia("(prefers-color-scheme: dark)");
const storage = safeStorage(() => window.localStorage);
const preferences = readPreferences(storage, navigator.language);
let locale = preferences.locale;
let theme = preferences.theme;
let t = translator(locale);
applyTheme(theme, document.documentElement, media);
document.documentElement.lang = locale;

const shell = createShell(t, isInAppBrowser(navigator.userAgent), signOut);
const discardDialog = new DraftDiscardDialog(shell.root, (key) => t(key));
shell.root.dataset.session = "pending";
let session: AccountSession = { status: "pending" };
let active: AbortController | undefined;
/** Header locale writes share Profile command ownership, without introducing a route-global mutation framework. */
let activeProfileOperations: ProfileOperations | undefined;
/** A token owns pending header controls across theme updates and delayed abort/error continuations. */
let localeRequest: symbol | undefined;
let localeRequestSaving = false;
let localeFeedback: "localeChangeBusy" | "localeChangeFailed" | "localeReadbackFailed" | undefined;
/** Route-owned profile values survive native history and failed refreshes, never document reloads. */
let pendingProfileDraft: { principalId: string; route: "/profile"; values: ProfileDraft } | undefined;
const api = new AccountApiClient(resolveIdentityOrigin(location, import.meta.env.VITE_IDENTITY_API_ORIGIN), undefined, becomeAnonymous);
shell.setSession(session);
mount.append(shell.root);
installPreferenceControls();

/** 路由切换时取消旧请求，防止过期页面回写。Cancels stale requests on navigation to prevent old pages writing back. */
async function renderCurrent(reloadSession = false, draftPolicy: NavigationDraftPolicy = "preserve", feedback?: RefreshFeedback): Promise<boolean> {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const headerFocus = focused && shell.controls.some((controls) => controls.contains(focused)) ? focused : undefined;
  const feedbackPrincipal = feedback && session.status === "authenticated" ? session.account.principal_id : undefined;
  if (draftPolicy === "preserve") rememberProfileDraft();
  active?.abort(); active = new AbortController(); const signal = active.signal;
  const route = resolveRoute(location.pathname); shell.setRoute(route);
  activeProfileOperations = route === "/profile" ? createProfileOperations(shell.main, signal) : undefined;
  // A retained history draft must be checked against fresh account identity and CSRF state.
  if (route === pendingProfileDraft?.route) reloadSession = true;
  updateTitle();
  if (session.status === "anonymous") { renderAnonymous(); return true; }
  replace(shell.main, el("div", { className: "loading", attrs: { role: "status" } }, icon("sparkle"), t("loading")));
  let sessionReloaded = false;
  try {
    if (session.status === "pending" || reloadSession) {
      const [envelope, loadedPreferences] = await Promise.all([api.getMe(signal), api.getPreferences(signal)]);
      if (signal.aborted) return false;
      session = authenticatedSession(envelope, { ...loadedPreferences, locale: normalizeLocale(loadedPreferences.locale) });
      sessionReloaded = true;
      applyLocale(normalizeLocale(loadedPreferences.locale));
      shell.setSession(session);
      shell.root.dataset.session = "authenticated";
    }
    if (session.status !== "authenticated") return false;
    if (pendingProfileDraft?.principalId !== session.account.principal_id) pendingProfileDraft = undefined;
    await renderPage(route, shell.main, { api, account: session.account, preferences: session.preferences, csrfToken: session.csrfToken, locale, t, signal, profileOperations: activeProfileOperations, refresh: async (nextFeedback) => { if (!signal.aborted) await refreshCurrent(nextFeedback); } });
    if (!signal.aborted && route === pendingProfileDraft?.route) {
      restoreProfileDraft(shell.main, pendingProfileDraft.values);
      pendingProfileDraft = undefined;
    }
    if (!signal.aborted && feedback && route === "/profile" && session.account.principal_id === feedbackPrincipal) {
      const message = shell.main.querySelector<HTMLElement>(feedback === "avatar-saved" ? ".avatar-card .inline-message" : ".form-card .inline-message");
      if (message) {
        const partial = feedback === "profile-partial-details" || feedback === "profile-partial-preferences";
        message.setAttribute("role", partial ? "alert" : "status");
        message.textContent = t(feedback === "profile-partial-details" ? "profilePartialDetails" : feedback === "profile-partial-preferences" ? "profilePartialPreferences" : feedback === "profile-saved" && hasUnsavedChanges(shell.main) ? "savedWithNewChanges" : "saved");
      }
    }
    if (!signal.aborted) {
      if (sessionReloaded) { localeFeedback = undefined; installPreferenceControls(); }
      (headerFocus?.isConnected && !headerFocus.hidden ? headerFocus : shell.main).focus({ preventScroll: true });
    }
    return !signal.aborted;
  } catch (error) {
    if (!signal.aborted) {
      renderFailure(error);
      if (session.status === "authenticated" && session.account.principal_id === feedbackPrincipal && (feedback === "profile-partial-details" || feedback === "profile-partial-preferences")) {
        shell.main.querySelector(".failure")?.append(el("p", {}, t("profilePartialRefreshFailed")));
      }
    }
    return false;
  }
}

/** Canonical authenticated preference wins; anonymous bootstrap uses the same non-sensitive local fallback. */
function applyLocale(next: Locale): void {
  locale = next; t = translator(locale); document.documentElement.lang = locale;
  writePreference(storage, "locale", locale);
  shell.relocalize((key) => t(key)); installPreferenceControls(); updateTitle();
}

/** Re-evaluates the route title after an authoritative locale change without navigating. */
function updateTitle(): void {
  const route = resolveRoute(location.pathname);
  document.title = `${t(route === "/" ? "overview" : route.slice(1) as "profile" | "security" | "sessions" | "apps" | "subscriptions")} · moeSegFault`;
}

/** 从服务重新读取账号与 CSRF token 后刷新页面。Reloads account and CSRF state before rerendering. */
async function refreshCurrent(feedback?: RefreshFeedback): Promise<void> {
  await renderCurrent(true, "preserve", feedback);
}

/** The rendered registered form identifies its route even after popstate has changed the URL. */
function rememberProfileDraft(): void {
  if (session.status !== "authenticated") return;
  const values = captureProfileDraft(shell.main);
  if (values !== undefined) pendingProfileDraft = values.size ? { principalId: session.account.principal_id, route: "/profile", values } : undefined;
}

/** 任意 401 都原子地清空鉴权态并渲染匿名外壳。Any 401 atomically clears authenticated state and renders the anonymous shell. */
function becomeAnonymous(): void {
  activeProfileOperations = undefined;
  pendingProfileDraft = undefined;
  localeFeedback = undefined;
  session = { status: "anonymous" };
  active?.abort();
  // Anonymous preference actions need their own live scope after authenticated consent is cancelled.
  active = new AbortController();
  installPreferenceControls();
  shell.setSession(session);
  shell.root.dataset.session = "anonymous";
  renderAnonymous();
}

/** 保留当前深链接并渲染独立的匿名宣传页。Renders the dedicated anonymous landing page while preserving the current deep link. */
function renderAnonymous(): void {
  const route = resolveRoute(location.pathname);
  document.title = `${t("landingPageTitle")} · moeSegFault`;
  replace(shell.main, createAnonymousLanding(t, { signInHref: loginUrl(route), registerHref: accountRegistrationUrl(location) }));
  shell.main.focus({ preventScroll: true });
}

/** 失败页面区分未登录与可重试故障。Failure UI distinguishes unauthenticated and retryable states. */
function renderFailure(error: unknown): void {
  const unauthenticated = error instanceof ApiError && error.status === 401;
  if (unauthenticated) { becomeAnonymous(); return; }
  rememberProfileDraft();
  replace(shell.main, el("section", { className: "failure card moe-glass", attrs: { role: "alert" } }, icon("shield"), el("h1", {}, t("errorTitle")), el("p", {}, failureMessage(error)), retryButton()));
}

/** Localizes the client's stable transport failure without replacing other API Problem Details. */
function failureMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return t("unexpectedError");
  return apiErrorMessage(error, t("networkUnavailable"));
}

/** 重试按钮。Retry button. */
function retryButton(): HTMLButtonElement { const button = el("button", { className: "button primary" }, t("retry")); button.addEventListener("click", () => void refreshCurrent()); return button; }

/** 顶栏中的语言和主题偏好只保存非敏感数据。Header controls persist only non-sensitive language and theme preferences. */
function installPreferenceControls(): void {
  for (const target of shell.controls) {
    let language = target.querySelector<HTMLSelectElement>(".compact-select");
    let themeButton = target.querySelector<HTMLButtonElement>(".icon-button");
    if (!language || !themeButton) {
      const select = el("select", { className: "compact-select" }, ...localeOptions(locale));
      select.addEventListener("change", () => { const next = normalizeLocale(select.value); select.value = locale; void changeInterfaceLocale(next, select); });
      language = select;
      themeButton = el("button", { className: "icon-button", attrs: { type: "button" } });
      themeButton.addEventListener("click", () => { const order: Theme[] = ["system", "light", "dark"]; theme = order[(order.indexOf(theme) + 1) % order.length] ?? "system"; writePreference(storage, "theme", theme); applyTheme(theme, document.documentElement, media); installPreferenceControls(); });
      const readLatest = el("button", { className: "button quiet locale-read-latest", attrs: { type: "button" } });
      readLatest.addEventListener("click", () => void readLatestLocaleState(readLatest));
      target.replaceChildren(language, themeButton, el("span", { className: "inline-message locale-feedback" }), readLatest);
    }
    language.value = locale; language.disabled = localeRequestSaving; language.setAttribute("aria-label", t("language"));
    themeButton.title = t("appearance"); themeButton.setAttribute("aria-label", t("appearance")); themeButton.replaceChildren(icon(theme === "dark" ? "moon" : "palette"));
    const feedback = target.querySelector<HTMLElement>(".locale-feedback")!;
    feedback.hidden = !localeFeedback; feedback.setAttribute("role", localeFeedback === "localeChangeBusy" ? "status" : "alert"); feedback.textContent = localeFeedback ? t(localeFeedback) : "";
    const readLatest = target.querySelector<HTMLButtonElement>(".locale-read-latest")!;
    readLatest.hidden = localeFeedback !== "localeChangeFailed" && localeFeedback !== "localeReadbackFailed";
    readLatest.disabled = localeRequestSaving; readLatest.textContent = t("readLatestState");
    readLatest.setAttribute("aria-busy", String(localeRequestSaving));
  }
}

/** Reads canonical state without replaying an uncertain write or discarding any profile edits. */
async function readLatestLocaleState(invoker: HTMLButtonElement): Promise<void> {
  if (localeRequest || !active || active.signal.aborted || session.status !== "authenticated" || localeChangeBlocked()) return;
  const principal = session.account.principal_id;
  const release = activeProfileOperations?.acquire();
  if (activeProfileOperations && !release) return;
  const request = Symbol("locale-read"); localeRequest = request; localeRequestSaving = true; installPreferenceControls();
  const finish = () => {
    if (localeRequest !== request) return;
    localeRequest = undefined; localeRequestSaving = false; installPreferenceControls();
  };
  // renderCurrent captures every live draft before replacing the old scope. Bind
  // cancellation to the new read scope, not the scope intentionally aborted here.
  const reading = renderCurrent(true);
  const readOwner = active;
  readOwner.signal.addEventListener("abort", finish, { once: true });
  try {
    const rendered = await reading;
    if (readOwner !== active || readOwner.signal.aborted || session.status !== "authenticated" || session.account.principal_id !== principal) return;
    finish();
    if (rendered && invoker.hidden) invoker.parentElement?.querySelector<HTMLSelectElement>(".compact-select")?.focus({ preventScroll: true });
    else if (invoker.isConnected) invoker.focus({ preventScroll: true });
  } finally {
    readOwner.signal.removeEventListener("abort", finish); release?.(); finish();
  }
}

/** Rejects language rerenders during admitted commands instead of aborting their local owners. */
function localeChangeBlocked(): boolean {
  return Boolean(activeProfileOperations?.pending || shell.main.querySelector('[aria-busy="true"]'));
}

/** Persists authenticated language in place; consent discards only approved drafts, not later edits. */
async function changeInterfaceLocale(next: Locale, invoker: HTMLSelectElement): Promise<void> {
  const owner = active;
  if (next === locale || !owner || owner.signal.aborted || localeRequest) return;
  if (localeChangeBlocked()) { localeFeedback = "localeChangeBusy"; installPreferenceControls(); return; }
  const request = Symbol("locale"); localeRequest = request; localeFeedback = undefined; installPreferenceControls();
  const principal = session.status === "authenticated" ? session.account.principal_id : undefined;
  let release: (() => void) | undefined;
  const finish = () => {
    if (localeRequest !== request) return;
    localeRequest = undefined; localeRequestSaving = false; shell.main.inert = false; installPreferenceControls();
    if (owner === active && !owner.signal.aborted && (document.activeElement === document.body || document.activeElement === shell.main)) invoker.focus({ preventScroll: true });
  };
  owner.signal.addEventListener("abort", finish, { once: true });
  try {
    if (!await canDiscardDraft("language") || owner !== active || owner.signal.aborted) return;
    if (localeChangeBlocked()) { localeFeedback = "localeChangeBusy"; return; }
    release = activeProfileOperations?.acquire();
    if (activeProfileOperations && !release) { localeFeedback = "localeChangeBusy"; return; }
    localeRequestSaving = true; installPreferenceControls();
    const approved = captureProfileValues(shell.main);
    if (session.status === "authenticated") {
      if (session.account.principal_id !== principal) return;
      if (!activeProfileOperations) shell.main.inert = true;
      const updated = await api.updatePreferences({ locale: next }, { csrfToken: session.csrfToken, signal: owner.signal });
      if (owner !== active || owner.signal.aborted || session.status !== "authenticated" || session.account.principal_id !== principal) return;
      session = { ...session, preferences: { ...updated, locale: normalizeLocale(updated.locale) } };
      applyLocale(session.preferences.locale);
    } else applyLocale(next);
    const live = captureProfileValues(shell.main);
    const later = approved && live ? profileChangesSince(live, approved) : undefined;
    pendingProfileDraft = principal && later?.size ? { principalId: principal, route: "/profile", values: later } : undefined;
    const reloading = renderCurrent(session.status === "authenticated", "discard-visible");
    const readOwner = active;
    const rendered = await reloading;
    if (!rendered && readOwner === active && !readOwner?.signal.aborted && session.status === "authenticated" && session.account.principal_id === principal) { localeFeedback = "localeReadbackFailed"; installPreferenceControls(); }
    if (readOwner === active && invoker.isConnected && document.activeElement === shell.main) invoker.focus({ preventScroll: true });
  } catch {
    if (owner === active && !owner.signal.aborted) localeFeedback = "localeChangeFailed";
  } finally {
    owner.signal.removeEventListener("abort", finish); release?.(); finish();
  }
}

/** 登录页使用同环境 origin 并保留已规范化的深链接。Keeps the Login origin paired and preserves a normalized deep link. */
export function loginUrl(route: ReturnType<typeof resolveRoute> = resolveRoute(location.pathname)): string {
  return accountLoginUrl(location, route);
}

/** Confirms draft discard before revoking this session and navigating to the paired Login page. */
async function signOut(): Promise<void> {
  const owner = active;
  if (session.status !== "authenticated" || !await canDiscardDraft("sign-out") || session.status !== "authenticated") return;
  if (!owner || owner !== active || owner.signal.aborted) return;
  const csrfToken = session.csrfToken;
  try {
    await signOutCurrentSession(api, csrfToken);
    becomeAnonymous();
    location.assign(new URL("/login", resolveLoginOrigin(location)).href);
  } catch (error) {
    renderFailure(error);
  }
}

/** Shares the localized discard decision across in-place locale changes and sign-out, including hidden drafts. */
async function canDiscardDraft(intent: DraftExitIntent): Promise<boolean> {
  if (!active || active.signal.aborted) return false;
  const owner = active;
  const principal = session.status === "authenticated" ? session.account.principal_id : undefined;
  const dirty = Boolean(pendingProfileDraft) || hasUnsavedChanges(shell.main);
  const approved = !dirty || await discardDialog.request(intent, owner.signal);
  return approved && owner === active && !owner.signal.aborted && (session.status === "authenticated" ? session.account.principal_id : undefined) === principal;
}

/** Hidden history drafts do not interrupt unrelated route links; an explicit discard is final. */
async function canLeaveRoute(): Promise<boolean> {
  const owner = active;
  const visibleDraft = hasUnsavedChanges(shell.main) || (resolveRoute(location.pathname) === "/profile" && Boolean(pendingProfileDraft));
  if (visibleDraft && !await canDiscardDraft("leave")) return false;
  if (!owner || owner !== active || owner.signal.aborted) return false;
  if (visibleDraft) pendingProfileDraft = undefined;
  return true;
}

installRouter((draftPolicy) => void renderCurrent(false, draftPolicy), canLeaveRoute);
installDraftExitWarning(shell.main, () => Boolean(pendingProfileDraft));
media.addEventListener("change", () => { if (theme === "system") applyTheme(theme, document.documentElement, media); });
void renderCurrent();
