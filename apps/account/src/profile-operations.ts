/** Mutating controls share page ownership; editable profile text/select fields deliberately do not. */
type MutationControl = HTMLButtonElement | HTMLInputElement;

/** Profile-local leases serialize commands/preparation through canonical refresh, not backend transactions. */
export interface ProfileOperations {
  readonly pending: boolean;
  acquire(): (() => void) | undefined;
  register(root: HTMLElement): void;
  setDisabled(control: MutationControl, disabled: boolean): void;
}

/**
 * Projects explicit local disabled intent through one shared lock, never restoring stale snapshots.
 * Detached controls are not re-enabled, and abort permanently closes this rendered page's owner.
 */
export function createProfileOperations(root: HTMLElement, signal: AbortSignal): ProfileOperations {
  const desired = new Map<MutationControl, boolean>();
  let held = false;
  let closed = signal.aborted;
  const project = (control: MutationControl, initial = false) => {
    if (closed || held || desired.get(control)) control.disabled = true;
    else if (initial || root.contains(control)) control.disabled = false;
  };
  const registerControl = (control: MutationControl) => {
    if (desired.has(control)) return;
    desired.set(control, control.disabled);
    project(control, true);
  };
  signal.addEventListener("abort", () => { closed = true; for (const control of desired.keys()) project(control); }, { once: true });
  return {
    get pending() { return held || closed; },
    acquire() {
      if (held || closed) return undefined;
      held = true;
      for (const control of desired.keys()) project(control);
      let released = false;
      return () => {
        if (released) return;
        released = true; held = false;
        for (const control of desired.keys()) project(control);
      };
    },
    register(section) {
      for (const control of section.querySelectorAll<MutationControl>('button, input[type="file"]')) registerControl(control);
    },
    setDisabled(control, disabled) {
      registerControl(control); desired.set(control, disabled); project(control);
    },
  };
}
