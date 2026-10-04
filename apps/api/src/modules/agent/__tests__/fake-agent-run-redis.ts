import { RUN_APPEND_LUA } from '@arcaai/async-contract';
import type { AgentRunRedis } from '../agent-run.events';

/**
 * An in-memory stand-in for the Redis the agent run EVENT STREAM EVALs against. It does not run
 * Lua: it recognises each of the stream's scripts and reproduces its semantics — including the run
 * sequencer's (`RUN_APPEND_LUA`: INCR + XADD, dedupe, terminal retention, closed-stream refusal),
 * so a test sees the same stored entries a real Redis would hold. Any other script — e.g. a write
 * of run STATE, which lives in Postgres since lane B6a — is refused loudly.
 */
export class FakeAgentRunRedis implements AgentRunRedis {
  connected = true;
  readonly strings = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  readonly streams = new Map<string, Array<[string, string[]]>>();
  readonly hashes = new Map<string, Map<string, string>>();
  private nextId = 1;

  isConnected(): boolean {
    return this.connected;
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);
    if (script === RUN_APPEND_LUA) return this.append(keys, argv);
    if (script.includes("'XRANGE'")) {
      const rows = this.streams.get(keys[0]) ?? [];
      return rows.length === 0 ? null : rows[0];
    }
    if (script.includes("'XREVRANGE'")) {
      const rows = [...(this.streams.get(keys[0]) ?? [])].reverse();
      const end = argv[0];
      const count = Number(argv[1]);
      const filtered = end === '+' ? rows : rows.filter(([id]) => compareIds(id, end.slice(1)) < 0);
      return filtered.slice(0, count);
    }
    if (script.includes("'EXPIRE'")) {
      // EXPIRE … NX on every key: only a key without a TTL gets one.
      for (const key of keys) if (!this.ttls.has(key)) this.ttls.set(key, Number(argv[0]));
      return 1;
    }
    throw new Error(`FakeAgentRunRedis: unrecognised script ${script.slice(0, 40)}`);
  }

  /** The stored entries of a run, as field maps. */
  entries(eventsKey: string): Array<Record<string, string>> {
    return (this.streams.get(eventsKey) ?? []).map(([, fields]) => {
      const out: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]] = fields[i + 1];
      return out;
    });
  }

  private append(keys: string[], argv: string[]): unknown {
    const [seqKey, eventsKey, dedupeKey] = keys;
    const dedupe = argv[2];
    if (dedupe !== '') {
      const prior = this.hashes.get(dedupeKey)?.get(dedupe);
      if (prior) {
        const [seq, id] = prior.split(' ');
        return [Number(seq), id, 1];
      }
    }
    if (this.ttls.has(eventsKey)) throw new Error('RUN_STREAM_CLOSED');
    const seq = Number(this.strings.get(seqKey) ?? '0') + 1;
    this.strings.set(seqKey, String(seq));
    const id = `${this.nextId++}-0`;
    const rows = this.streams.get(eventsKey) ?? [];
    rows.push([id, ['seq', String(seq), ...argv.slice(3)]]);
    this.streams.set(eventsKey, rows);
    if (dedupe !== '') {
      const hash = this.hashes.get(dedupeKey) ?? new Map<string, string>();
      hash.set(dedupe, `${seq} ${id}`);
      this.hashes.set(dedupeKey, hash);
    }
    const ttl = Number(argv[1]);
    if (ttl > 0) for (const key of keys) this.ttls.set(key, ttl);
    return [seq, id, 0];
  }
}

function compareIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am !== bm ? am - bm : as - bs;
}
