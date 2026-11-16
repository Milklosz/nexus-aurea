import {
  getNativeControllerStatus,
  initialNativeControllerModel,
  listenForNativeController,
  reduceNativeController,
  setControllerHomeEnabled,
  disabledNativeControllerStatus,
  type NativeControllerEvent,
  type NativeControllerModel,
  type NativeControllerStatus,
} from "./nativeController";

export interface NativeControllerDeps {
  listen: (callback: (event: NativeControllerEvent) => void) => Promise<() => void>;
  getStatus: () => Promise<NativeControllerStatus>;
  setHomeEnabled: (enabled: boolean) => Promise<NativeControllerStatus>;
  now: () => number;
}

const defaultDeps: NativeControllerDeps = {
  listen: listenForNativeController,
  getStatus: getNativeControllerStatus,
  setHomeEnabled: setControllerHomeEnabled,
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
  private status: NativeControllerStatus = disabledNativeControllerStatus;
  private statusKnown = false;
  private statusReadEpoch = 0;
  private statusRequest: { generation: number; promise: Promise<void> } | null = null;
  private readonly subscribers = new Set<() => void>();
  private refs = 0;
  private generation = 0;
  /** Counts every applied event, so a status reply that raced an event can be recognised. */
  private eventSeq = 0;
  private unlisten: (() => void) | null = null;

  constructor(private readonly deps: NativeControllerDeps = defaultDeps) {}

  getModel = (): NativeControllerModel => this.model;
  getStatusSnapshot = (): NativeControllerStatus => this.status;
  getStatusKnown = (): boolean => this.statusKnown;
  getStatusReadInFlight = (): boolean => this.statusRequest?.generation === this.generation;

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
  reconcile(): Promise<void> {
    const generation = this.generation;
    if (this.statusRequest?.generation === generation) return this.statusRequest.promise;
    const request = this.readStatus(generation, ++this.statusReadEpoch);
    this.statusRequest = { generation, promise: request };
    void request.then(() => {
      if (this.statusRequest?.promise === request) this.statusRequest = null;
    });
    return request;
  }

  /**
   * Invalidates a status reply after a caller timeout, but does not cancel the native invoke.
   * Keep its singleflight reservation until it settles to avoid spawning unbounded IPC reads;
   * if it never returns, restarting VELORA is required to release that reservation.
   */
  invalidateStatusRead(): void {
    this.statusReadEpoch += 1;
    this.statusKnown = false;
    this.emit();
  }

  private async readStatus(generation: number, epoch: number): Promise<void> {
    // A status taken before an event but delivered after it would undo that event (a disconnected
    // pad coming back as a ghost). If any event arrived while the reply was in flight, ask again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const seq = this.eventSeq;
      try {
        const status = await this.deps.getStatus();
        if (generation !== this.generation || epoch !== this.statusReadEpoch) return;
        if (seq !== this.eventSeq) continue;
        this.applyStatus(status);
        return;
      } catch {
        // Status is best effort; events remain the source of truth.
        if (generation === this.generation && epoch === this.statusReadEpoch) {
          this.statusKnown = false;
          this.emit();
        }
        return;
      }
    }
    if (generation === this.generation && epoch === this.statusReadEpoch) {
      this.statusKnown = false;
      this.emit();
    }
  }

  /** Changes session-only Home policy and publishes the authoritative native reply. */
  async setHomeEnabled(enabled: boolean): Promise<NativeControllerStatus> {
    const generation = this.generation;
    const status = await this.deps.setHomeEnabled(enabled);
    if (generation === this.generation) {
      // A status snapshot already in flight predates this explicit policy change.
      this.statusReadEpoch += 1;
      this.status = status;
      this.statusKnown = true;
      this.emit();
    }
    return status;
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
    this.status = disabledNativeControllerStatus;
    this.statusKnown = false;
    this.statusReadEpoch += 1;
    this.emit();
  }

  private applyStatus(status: NativeControllerStatus): void {
    this.status = status;
    this.statusKnown = true;
    // Not Windows (or no native layer): stay quiet and let the Gamepad API path run.
    if (!status.supported) {
      this.model = initialNativeControllerModel;
      this.emit();
      return;
    }
    if (!status.running) {
      if (status.lastError) this.apply({ kind: "unavailable", reason: status.lastError });
      else {
        this.model = initialNativeControllerModel;
        this.emit();
      }
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
    this.emit();
  }

  private apply(event: NativeControllerEvent): void {
    this.eventSeq += 1;
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
