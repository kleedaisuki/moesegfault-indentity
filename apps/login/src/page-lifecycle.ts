import type { Locale } from "./i18n";

/** Owns one route lifetime. Cosmetic relocalization never aborts or replays work. */
export class PageLifecycle {
  /** Current display language, read by event handlers when projecting results. */
  locale: Locale;
  /** Projection owned exclusively by this route, never a later route sharing main. */
  private renderer?: () => void;
  /** Coalesces requested language changes while an operation is unresolved. */
  private pending = false;
  /** Number of unresolved operations whose current UI must not be reconstructed. */
  private operations = 0;
  /** Terminal ownership flag: late operation completions cannot revive a route. */
  private disposed = false;
  /** The single navigation lifetime bound by renderPage, including external callers. */
  private signal?: AbortSignal;
  /** Stable listener identity permits explicit disposal to detach the abort listener. */
  private readonly onAbort = (): void => { this.dispose(); };

  /** Creates an unbound route owner; renderPage binds its actual navigation signal. */
  constructor(locale: Locale) { this.locale = locale; }

  /** Binds this owner to exactly one route lifetime; an aborted signal disposes immediately. */
  bind(signal: AbortSignal): void {
    if (this.disposed || this.signal === signal) return;
    if (this.signal) throw new Error("A PageLifecycle cannot own multiple route lifetimes");
    this.signal = signal;
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.dispose();
  }

  /** Drops all projection ownership permanently; safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = false;
    this.renderer = undefined;
    this.signal?.removeEventListener("abort", this.onAbort);
  }

  /** Installs the current form or terminal-result projection without running it. */
  present(renderer: () => void): void { if (!this.disposed) this.renderer = renderer; }

  /** Defers a cosmetic rebuild until all active operations have settled. */
  relocalize(locale: Locale): void {
    if (this.disposed) return;
    this.locale = locale;
    this.pending = true;
    this.flush();
  }

  /** Acquires a route-local operation owner; release is idempotent, even after disposal. */
  hold(): () => void {
    if (this.disposed) return () => {};
    this.operations += 1;
    let released = false;
    return () => { if (released) return; released = true; this.operations -= 1; this.flush(); };
  }

  /** Projects the latest language only while this route still owns its render target. */
  private flush(): void {
    if (this.disposed || this.operations || !this.pending || !this.renderer) return;
    this.pending = false;
    this.renderer();
  }
}
