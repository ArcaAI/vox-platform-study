import { createHash } from 'node:crypto';
import { RUN_APPEND_LUA, RUN_EVENTS_KEY, RUN_SEQ_KEY, buildRunAppend, type RunAppendInput } from '@arcaai/async-contract';

/**
 * TASK-1038 OD-26 — the agent run's EVENT STREAM, and nothing else, in Redis.
 *
 * The run's STATE and RESULT live in Postgres, in the run read model (`WorkflowRun`, `kind =
 * AGENT`; lane B6a). They used to live here too (`agent:run:<tenantId>:<runId>`, kept 30 days),
 * which was wrong twice over: Redis runs with persistence DISABLED on this platform (PHI posture),
 * so a restart lost every run and its result, and an agent's output — PHI — sat in Redis for the
 * whole result-retention window. What remains in Redis is what the protocol needs to be fast and
 * what may be lost without losing the run: the v2 event stream, appended through the ONE run
 * sequencer (`RUN_APPEND_LUA`, keys `wf:run:<runId>:{seq,events,dedupe}`) and closed with the
 * `workflowRuns.eventRetentionHours` TTL on the terminal event. A lost stream is answered with a
 * `run.resync` snapshot built from the Postgres row (protocol v2 §6.1: the stream mirrors the run,
 * it is not the record).
 *
 * Idempotency is not here either: an `Idempotency-Key` DERIVES the run id
 * (`deterministicAgentRunId`), and the row's unique key `(tenantId, sessionId, runId)` makes a
 * second start of the same key a unique violation in Postgres — durable, unlike a Redis claim.
 */

/** The narrow slice of `IRedisCacheService` the stream uses (a fake implements it in tests). */
export interface AgentRunRedis {
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  isConnected(): boolean;
}

/** The oldest retained entry's field list (`XRANGE … COUNT 1`), for the resume plan's `oldestSeq`. */
const OLDEST_LUA = "local rows = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', 1) if #rows == 0 then return nil end return rows[1]";

/** `XREVRANGE … COUNT n` — a page back from the tail, to find the id of the entry with a given seq. */
const TAIL_PAGE_LUA = "return redis.call('XREVRANGE', KEYS[1], ARGV[1], '-', 'COUNT', tonumber(ARGV[2]))";

const SCAN_PAGE = 200;

function fieldValue(fields: readonly string[], name: string): string | undefined {
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === name) return fields[i + 1];
  return undefined;
}

export class AgentRunEventsUnavailableError extends Error {
  constructor() {
    super('The agent run event stream (Redis) is not available.');
  }
}

export class AgentRunEventStream {
  constructor(private readonly redis: AgentRunRedis | undefined) {}

  available(): boolean {
    return this.redis?.isConnected() ?? false;
  }

  private client(): AgentRunRedis {
    if (!this.redis || !this.redis.isConnected()) throw new AgentRunEventsUnavailableError();
    return this.redis;
  }

  /**
   * Append ONE v2 event through the run sequencer (`RUN_APPEND_LUA`). Best effort, like every
   * producer of the run stream (protocol-v2 §6.1): the caller swallows a failure.
   */
  async append(input: RunAppendInput): Promise<void> {
    const command = buildRunAppend(input);
    await this.client().eval(RUN_APPEND_LUA, command.keys.length, ...command.keys, ...command.args);
  }

/** `GET wf:run:<runId>:seq` — the last assigned seq, `null` when the stream has no counter. */
  async lastSeq(runId: string): Promise<number | null> {
    const raw = await this.client().get(RUN_SEQ_KEY(runId));
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  /** The `seq` of the oldest retained entry, `null` when nothing is retained. */
  async oldestSeq(runId: string): Promise<number | null> {
    const reply = await this.client().eval(OLDEST_LUA, 1, RUN_EVENTS_KEY(runId));
    if (!Array.isArray(reply) || !Array.isArray(reply[1])) return null;
    const parsed = Number(fieldValue(reply[1] as string[], 'seq'));
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  /**
   * The stream id of the entry whose `seq === seq`, scanning back from the tail a page at a time
   * (resumes are near the tail; `RUN_STREAM_MAX_LEN` bounds the scan). `null` when not retained.
   */
  async entryIdForSeq(runId: string, seq: number): Promise<string | null> {
    let end = '+';
    for (;;) {
      const reply = await this.client().eval(TAIL_PAGE_LUA, 1, RUN_EVENTS_KEY(runId), end, SCAN_PAGE);
      const rows = Array.isArray(reply) ? (reply as [string, string[]][]) : [];
      if (rows.length === 0) return null;
      for (const [id, fields] of rows) {
        const entrySeq = Number(fieldValue(fields, 'seq'));
        if (entrySeq === seq) return id;
        if (Number.isSafeInteger(entrySeq) && entrySeq < seq) return null;
      }
      if (rows.length < SCAN_PAGE) return null;
      end = `(${rows[rows.length - 1][0]}`;
    }
  }
}

/**
 * The run id an `Idempotency-Key` addresses: a pure function of `(tenantId, slug, key)`, so two
 * deliveries of one key compute the same id — and collide on the run row's unique key. Same derivation as
 * the workflow exposure plane's `deterministicRunId` (length-prefixed SHA-256, RFC 9562 v8 UUID),
 * namespaced `agent:` so an agent and a workflow sharing a slug and a key never share a run id.
 */
export function deterministicAgentRunId(tenantId: string, slug: string, idempotencyKey: string): string {
  const hash = createHash('sha256');
  for (const part of [tenantId, `agent:${slug}`, idempotencyKey]) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  const digest = hash.digest();
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
