/**
 * A minimal stand-in for the platform `WebSocket`, for the socket-lane tests.
 *
 * Deliberately a global stub rather than an injectable constructor on the public
 * options: the SDK reads `globalThis.WebSocket` precisely BECAUSE it will not take a
 * dependency, and a `webSocket?:` option existing only for tests would be a public
 * API shaped by the test suite. `vi.stubGlobal('WebSocket', FakeWebSocket)` exercises
 * the same lookup the shipped code performs.
 */

type Listener = (event: unknown) => void;

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  private static waiters: Array<(socket: FakeWebSocket) => void> = [];

  readonly url: string;
  closed = false;
  closeCode: number | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    // Resolve on a microtask so a test can `await FakeWebSocket.opened()` after the
    // generator has registered its listeners — the real socket also connects async.
    queueMicrotask(() => {
      for (const waiter of FakeWebSocket.waiters.splice(0)) waiter(this);
    });
  }

  /** The next socket to be constructed (or the most recent one, if it already was). */
  static opened(): Promise<FakeWebSocket> {
    const existing = FakeWebSocket.instances.at(-1);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => FakeWebSocket.waiters.push(resolve));
  }

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.waiters = [];
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }

  emitMessage(data: string): void {
    this.dispatch('message', { data });
  }

  emitClose(code = 1000): void {
    this.dispatch('close', { code });
  }

  emitError(): void {
    this.dispatch('error', {});
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}
