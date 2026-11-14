import {
  getNativeControllerStatus,
  initialNativeControllerModel,
  listenForNativeController,
  reduceNativeController,
  type NativeControllerEvent,
  type NativeControllerModel,
  type NativeControllerStatus,
} from "./nativeController";

export interface NativeControllerDeps {
  listen: (callback: (event: NativeControllerEvent) => void) => Promise<() => void>;
  getStatus: () => Promise<NativeControllerStatus>;
  now: () => number;
}

const defaultDeps: NativeControllerDeps = {
  listen: listenForNativeController,
  getStatus: getNativeControllerStatus,
  now: () => performance.now(),
};

/**
 * The single process-wide subscription to native controller events. Any number of
 * consumers (navigation hook, diagnostics) share one Tauri listener through
 * `acquire()`; the listener is removed when the last consumer releases. This is what
 * keeps listeners from multiplying when screens mount and unmount.
 */
export class NativeControllerStore {
  private model: NativeControllerModel = initialNativeControllerModel;
  private readonly subscribers = new Set<() => void>();
  private refs = 0;
  private generation = 0;
  private unlisten: (() => void) | null = null;

  constructor(private readonly deps: NativeControllerDeps = defaultDeps) {}

  getModel = (): NativeControllerModel => this.model;

  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => { this.subscribers.delete(callback); };
  };

  /** Number of live Tauri listeners owned by this store: 0 or 1. Exposed for leak tests. */
  get listenerCount(): number {
    return this.unlisten ? 1 : 0;
  }

  acquire(): () => void {
    this.refs += 1;
    if (this.refs === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs -= 1;
      if (this.refs === 0) this.stop();
    };
  }

  /** Re-reads the native status, e.g. when the window regains focus after a missed event. */
  async reconcile(): Promise<void> {
    const generation = this.generation;
    try {
      const status = await this.deps.getStatus();
      if (generation !== this.generation) return;
      this.applyStatus(status);
    } catch {
      // Status is best effort; events remain the source of truth.
    }
  }

  private start(): void {
    const generation = ++this.generation;
    this.deps.listen((event) => {
      if (generation === this.generation) this.apply(event);
    }).then((stop) => {
      // acquire/release may have raced the async listen: never keep a stale listener.
      if (generation !== this.generation || this.refs === 0) stop();
      else this.unlisten = stop;
    }).catch(() => {
      if (generation === this.generation) {
        this.apply({ kind: "unavailable", reason: "listen failed" });
      }
    });
    // Events fired before the listener attached are lost, so seed from the status snapshot.
    void this.reconcile();
  }

  private stop(): void {
    this.generation += 1;
    this.unlisten?.();
    this.unlisten = null;
    this.model = initialNativeControllerModel;
    this.emit();
  }

  private applyStatus(status: NativeControllerStatus): void {
    // Not Windows (or no native layer): stay quiet and let the Gamepad API path run.
    if (!status.supported) return;
    if (!status.running) {
      if (status.lastError) this.apply({ kind: "unavailable", reason: status.lastError });
      return;
    }
    const known = new Set(this.model.pads.map((pad) => pad.device));
    for (const pad of status.pads) {
      if (!known.has(pad.device)) {
        this.apply({ kind: "connected", device: pad.device, revision: pad.revision, transport: pad.transport });
      }
    }
    // A pad we track but the native layer no longer lists was lost while no event reached us.
    const live = new Set(status.pads.map((pad) => pad.device));
    for (const pad of this.model.pads) {
      if (!live.has(pad.device)) this.apply({ kind: "disconnected", device: pad.device });
    }
  }

  private apply(event: NativeControllerEvent): void {
    const next = reduceNativeController(this.model, event, this.deps.now());
    if (next === this.model) return;
    this.model = next;
    this.emit();
  }

  private emit(): void {
    for (const callback of [...this.subscribers]) callback();
  }
}

export const nativeControllerStore = new NativeControllerStore();
