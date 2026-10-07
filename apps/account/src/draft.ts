/** In-memory baselines belong to rendered forms and disappear when those forms are collected. */
const baselines = new WeakMap<HTMLFormElement, string>();

/** Changed profile text/select values only; never retains DOM nodes or authentication state. */
export type ProfileDraft = ReadonlyMap<string, string>;

/** Captures all registered text/select values for a consent snapshot without changing saved baselines. */
export function captureProfileValues(root: HTMLElement): ProfileDraft | undefined {
  for (const form of root.querySelectorAll("form")) {
    if (baselines.has(form)) return new Map(editableProfileFields(form).map((field) => [field.name, field.value]));
  }
  return undefined;
}

/** Keeps only edits made after explicit discard consent; original approved values are not resurrected. */
export function profileChangesSince(values: ProfileDraft, approved: ProfileDraft): ProfileDraft {
  return new Map(Array.from(values).filter(([name, value]) => approved.get(name) !== value));
}

/** Captures only fields differing from the rendered baseline, preserving fresh server values elsewhere. */
export function captureProfileDraft(root: HTMLElement): ProfileDraft | undefined {
  for (const form of root.querySelectorAll("form")) {
    const baseline = baselines.get(form);
    if (baseline === undefined) continue;
    const saved = new Map<string, string>(JSON.parse(baseline));
    const changed = new Map<string, string>();
    for (const field of editableProfileFields(form)) {
      if (saved.get(field.name) !== field.value) changed.set(field.name, field.value);
    }
    return changed;
  }
  return undefined;
}

/** Rehydrates a fresh registered form without accepting the draft as its server-backed baseline. */
export function restoreProfileDraft(root: HTMLElement, draft: ProfileDraft): void {
  for (const form of root.querySelectorAll("form")) {
    if (!baselines.has(form)) continue;
    for (const field of editableProfileFields(form)) {
      const value = draft.get(field.name);
      if (value !== undefined) field.value = value;
    }
  }
}

/** Profile preservation excludes hidden values, credentials, uploads, and non-text controls. */
function editableProfileFields(form: HTMLFormElement): (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[] {
  return Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"))
    .filter((field) => Boolean(field.name) && !field.disabled && (field.tagName !== "INPUT" || ["text", "email", "url", "tel", "search"].includes(field.type)));
}

/** Tracks a non-sensitive form; optional field names acknowledge only the write groups confirmed saved. */
export function trackFormDraft(form: HTMLFormElement): (submitted: FormData, fields?: Iterable<string>) => void {
  baselines.set(form, snapshot(new FormData(form)));
  return (submitted, fields) => {
    if (fields === undefined) { baselines.set(form, snapshot(submitted)); return; }
    const accepted = new Set(fields);
    const baseline = new Map<string, FormDataEntryValue>(JSON.parse(baselines.get(form)!));
    for (const [name, value] of submitted) if (accepted.has(name)) baseline.set(name, value);
    baselines.set(form, JSON.stringify(Array.from(baseline.entries())));
  };
}

/** Compares live values rather than input events, including autofill and reverting an edit. */
export function hasUnsavedChanges(root: HTMLElement): boolean {
  return Array.from(root.querySelectorAll("form")).some((form) => {
    const baseline = baselines.get(form);
    return baseline !== undefined && baseline !== snapshot(new FormData(form));
  });
}

/** Only registered text/select profile fields are tracked; no data is persisted to storage. */
function snapshot(data: FormData): string {
  return JSON.stringify(Array.from(data.entries()));
}

/** Uses the browser's native warning for document exits; no draft values leave memory. */
export function installDraftExitWarning(root: HTMLElement, hasPendingDraft: () => boolean = () => false): () => void {
  const warn = (event: BeforeUnloadEvent) => {
    if (!hasUnsavedChanges(root) && !hasPendingDraft()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", warn);
  return () => window.removeEventListener("beforeunload", warn);
}
