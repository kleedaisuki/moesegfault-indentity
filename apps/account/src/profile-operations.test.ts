// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createProfileOperations } from "./profile-operations";

describe("Profile operation projection", () => {
  it("locks mutating controls but not text and preserves explicit terminal disabled intent", () => {
    const root = document.createElement("main");
    root.innerHTML = '<input name="display_name"><select><option>en</option></select><button>Save</button><button disabled>Terminal</button><input type="file">';
    const abort = new AbortController(); const owner = createProfileOperations(root, abort.signal); owner.register(root);
    const [save, terminal] = Array.from(root.querySelectorAll("button"));
    const release = owner.acquire()!;
    expect(owner.acquire()).toBeUndefined();
    expect(save!.disabled && terminal!.disabled && root.querySelector<HTMLInputElement>('[type="file"]')!.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
    expect(root.querySelector("select")!.disabled).toBe(false);
    owner.setDisabled(save!, true); owner.setDisabled(terminal!, false);
    expect(terminal!.disabled).toBe(true);
    release();
    expect(save!.disabled).toBe(true); expect(terminal!.disabled).toBe(false);
  });

  it("registers dynamic verifier buttons while held and never restores detached or aborted controls", () => {
    const root = document.createElement("main"); root.innerHTML = '<button>Old</button>';
    const abort = new AbortController(); const owner = createProfileOperations(root, abort.signal); owner.register(root);
    const old = root.querySelector("button")!; const release = owner.acquire()!;
    const form = document.createElement("form"); form.innerHTML = '<button>Confirm</button><button>Resend</button>';
    owner.register(form); root.append(form); old.remove();
    expect(Array.from(form.querySelectorAll("button"), (button) => button.disabled)).toEqual([true, true]);
    release();
    expect(old.disabled).toBe(true);
    expect(Array.from(form.querySelectorAll("button"), (button) => button.disabled)).toEqual([false, false]);
    const nextRelease = owner.acquire()!; abort.abort(); owner.setDisabled(old, false); nextRelease();
    expect(old.disabled).toBe(true);
    expect(Array.from(form.querySelectorAll("button"), (button) => button.disabled)).toEqual([true, true]);
    expect(owner.acquire()).toBeUndefined();
  });

  it("makes releases idempotent instead of letting an old release unlock a later operation", () => {
    const root = document.createElement("main"); root.innerHTML = '<button>Save</button>';
    const owner = createProfileOperations(root, new AbortController().signal); owner.register(root);
    const first = owner.acquire()!; first();
    const second = owner.acquire()!; first();
    expect(owner.pending).toBe(true); expect(root.querySelector("button")!.disabled).toBe(true);
    second(); expect(owner.pending).toBe(false);
  });
});
