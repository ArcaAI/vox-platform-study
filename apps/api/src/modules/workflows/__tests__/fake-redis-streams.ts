/**
 * TASK-1038 — an in-memory Redis Streams server for the run-delivery tests.
 *
 * What it models, because each property is something a test below depends on:
 *
 * - **One connection = one command at a time.** A real ioredis connection pipelines commands
 *   over one socket and Redis answers them in order, so a blocking `XREAD BLOCK 15000` parks
 *   every command queued behind it. That serialisation IS defect R-1, so the fake reproduces it
 *   (`FakeRedisConnection.run`): a fake that answered concurrently would hide the bug.
 * - **`XREAD … BLOCK` over many keys** returns as soon as ANY named key has an entry after its
 *   cursor, with the entries of every key that has some — the multiplexed read's contract.
 * - **`CLIENT ID` / `CLIENT UNBLOCK`** — a parked read on one connection can be released from
 *   another, exactly as the hub's wake-up does.
 * - **`XRANGE` (oldest retained), a MAXLEN-style trim, `EXPIRE … NX`.**
 */
import { compareStreamIds } from '../workflow-run-event';

type Entry = [string, string[]];

export class FakeRedisServer {
  readonly streams = new Map<string, Entry[]>();
  readonly ttls = new Map<string, number>();
  readonly connections: FakeRedisConnection[] = [];
  private sequence = 0;
  private nextClientId = 100;
  private readonly appendListeners = new Set<() => void>();

  append(key: string, fields: string[]): string {
    this.sequence += 1;
    const id = `${this.sequence}-0`;
    const entries = this.streams.get(key) ?? [];
    entries.push([id, fields]);
    this.streams.set(key, entries);
    for (const listener of [...this.appendListeners]) listener();
    return id;
  }

  appendEnvelope(key: string, envelope: Record<string, unknown>): string {
    return this.append(key, ['data', JSON.stringify(envelope)]);
  }

  trimThrough(key: string, throughId: string): void {
    this.streams.set(
      key,
      (this.streams.get(key) ?? []).filter(([id]) => compareStreamIds(id, throughId) > 0),
    );
  }

  connection(): FakeRedisConnection {
    const connection = new FakeRedisConnection(this, this.nextClientId++);
    this.connections.push(connection);
    return connection;
  }

  /** @internal */
  onAppend(listener: () => void): () => void {
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  /** @internal */
  unblockClient(clientId: number): number {
    const target = this.connections.find((connection) => connection.clientId === clientId);
    return target?.releaseBlock() ? 1 : 0;
  }

  /** Total commands issued across every connection — the "is anything polling?" probe. */
  get commandCount(): number {
    return this.connections.reduce((sum, connection) => sum + connection.commands.length, 0);
  }
}

export class FakeRedisConnection {
  readonly commands: string[] = [];
  /** Queue a one-shot failure for the next `XREAD` on this connection. */
  failNextXread: Error | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private release: (() => void) | null = null;

  constructor(
    private readonly server: FakeRedisServer,
    readonly clientId: number,
  ) {}

  /** One command at a time, in order — what a single socket does. */
  private run<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.commands.push(name);
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** @internal — `CLIENT UNBLOCK` from another connection. */
  releaseBlock(): boolean {
    if (!this.release) return false;
    const release = this.release;
    this.release = null;
    release();
    return true;
  }

  xread(...args: (string | number)[]): Promise<[string, Entry[]][] | null> {
    return this.run('xread', async () => {
      if (this.failNextXread) {
        const error = this.failNextXread;
        this.failNextXread = null;
        throw error;
      }
      let count = Infinity;
      let blockMs: number | null = null;
      let index = 0;
      while (index < args.length && String(args[index]).toUpperCase() !== 'STREAMS') {
        const word = String(args[index]).toUpperCase();
        if (word === 'COUNT') count = Number(args[index + 1]);
        if (word === 'BLOCK') blockMs = Number(args[index + 1]);
        index += 2;
      }
      const rest = args.slice(index + 1).map(String);
      const keys = rest.slice(0, rest.length / 2);
      const ids = rest.slice(rest.length / 2);

      const collect = (): [string, Entry[]][] => {
        const out: [string, Entry[]][] = [];
        keys.forEach((key, i) => {
          const after = (this.server.streams.get(key) ?? []).filter(([id]) => compareStreamIds(id, ids[i]) > 0).slice(0, count);
          if (after.length > 0) out.push([key, after]);
        });
        return out;
      };

      const ready = collect();
      if (ready.length > 0 || blockMs === null) return ready.length > 0 ? ready : null;

      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe();
          this.release = null;
          resolve();
        };
        const timer = blockMs === 0 ? undefined : setTimeout(finish, blockMs as number);
        const unsubscribe = this.server.onAppend(() => {
          if (collect().length > 0) finish();
        });
        this.release = finish;
      });
      const after = collect();
      return after.length > 0 ? after : null;
    });
  }

  xrange(key: string, _min: string, _max: string, _countWord?: string, count?: number): Promise<Entry[]> {
    return this.run('xrange', async () => (this.server.streams.get(key) ?? []).slice(0, count ?? Infinity));
  }

  expire(key: string, seconds: number, mode?: string): Promise<number> {
    return this.run('expire', async () => {
      if (!this.server.streams.has(key)) return 0;
      if (mode === 'NX' && this.server.ttls.has(key)) return 0;
      this.server.ttls.set(key, Number(seconds));
      return 1;
    });
  }

  client(subcommand: string, clientId?: number | string): Promise<unknown> {
    return this.run(`client ${subcommand}`, async () => {
      if (subcommand.toUpperCase() === 'ID') return this.clientId;
      if (subcommand.toUpperCase() === 'UNBLOCK') return this.server.unblockClient(Number(clientId));
      throw new Error(`unsupported CLIENT ${subcommand}`);
    });
  }

  async quit(): Promise<void> {
    this.releaseBlock();
  }
}
