/**
 * A scriptable `EventSource` for run-stream tests (TASK-1039). `emit` dispatches a NAMED event the
 * way the browser does (`type` = the SSE `event:` name, `lastEventId` = the frame's `id:`).
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }

  onopen: (() => void) | null = null;
  onmessage: ((event: Event) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (event: Event) => void>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: Event) => void): void {
    this.listeners.set(name, listener);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  emit(name: string, payload: unknown, lastEventId = ''): void {
    const event = Object.assign(new Event(name), { data: JSON.stringify(payload), lastEventId });
    this.listeners.get(name)?.(event);
  }

  /** A protocol-v2 envelope as the gateway sends it. */
  emitV2(type: string, seq: number, data: Record<string, unknown>, nodeId?: string): void {
    this.emit(type, { seq, runId: 'run-1', type, ts: '2026-10-04T10:00:00.000Z', ...(nodeId ? { nodeId } : {}), data }, String(seq));
  }

  drop(): void {
    this.onerror?.();
  }
}
