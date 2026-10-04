import { createHash } from 'node:crypto';
import { RUN_APPEND_LUA, RUN_EVENTS_KEY, RUN_SEQ_KEY, buildRunAppend, type RunAppendInput, type RunError, type RunStatus } from '@arcaai/async-contract';

/**
 * TASK-1038 OD-26 — the agent run's STATE, held in Redis.
 *
 * ## Why Redis and not `WorkflowRun` (the persistence decision)
 *
 * The run read model (`WorkflowRun`, `workflow-run.prisma`) cannot hold an agent run without a
 * schema change: `workflowVersionId` / `workflowSlug` / `workflowVersionNumber` / `definitionName`
 * are NOT NULL and name a WORKFLOW, and there is no `kind` column, so an agent row written there
 * would masquerade as a workflow run in every runs list and collide with a workflow of the same
 * slug on `GET /workflows/{slug}/runs/{runId}`. The schema proposal (a `kind` column + nullable
 * workflow identity + `agentSlug` / `agentVersionId`) is written up in
 * `docs/implementation/TASK-1038-Run-Integrity-And-Delivery-Plane/sql/agent-run-read-model.sql`.
 * Until it lands, this store is the agent run's record: one JSON document per run, kept for
 * `workflowRuns.resultRetentionDays` (the A2 retention setting), plus the run's v2 event stream
 * appended through the ONE sequencer (`RUN_APPEND_LUA`).
 *
 * Every key carries the tenant id (`agent:run:<tenantId>:<runId>`), so a lookup with another
 * tenant's id is simply a miss — the 404-over-403 posture falls out of the key, not a check.
 */

/** The narrow slice of `IRedisCacheService` the store uses (a fake implements it in tests). */
export interface AgentRunRedis {
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  isConnected(): boolean;
}

export type AgentRunTask = 'TEXT_GENERATION' | 'NAMED_ENTITY_RECOGNITION';

export interface AgentRunState {
  runId: string;
  tenantId: string;
  slug: string;
  agentVersionId: string;
  versionNumber: number;
  task: AgentRunTask;
  status: RunStatus;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** The agent's output (`{ text }` / `{ entities }`) once COMPLETED; `null` otherwise. */
  output: Record<string, unknown> | null;
  /** The PUBLIC error of a FAILED / TIMED_OUT run (fixed label, no detail). */
  error: RunError | null;
  /** sha-256 of the canonical request body, when the run was started with an `Idempotency-Key`. */
  bodyHash: string | null;
}

export const AGENT_RUN_KEY = (tenantId: string, runId: string): string => `agent:run:${tenantId}:${runId}`;
export const AGENT_RUN_IDEMPOTENCY_KEY = (tenantId: string, slug: string, keyHash: string): string => `agent:run:idem:${tenantId}:${slug}:${keyHash}`;

/** `SET key value EX ttl NX`, returning the value that is there afterwards (ours or the prior one). */
const CLAIM_LUA = [
  "local prior = redis.call('GET', KEYS[1])",
  'if prior then return prior end',
  "redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))",
  'return ARGV[1]',
].join('\n');

/** `SET key value EX ttl` — the plain write, through EVAL so the store needs one Redis verb. */
const WRITE_LUA = "redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2])) return 1";

/**
 * Compare-and-set on the run document: write `ARGV[1]` only while the stored run is still
 * RUNNING. This is what makes cancel and completion race safely — whichever lands first decides
 * the terminal status, and the loser writes nothing. Returns 1 on write, 0 otherwise.
 */
const TRANSITION_LUA = [
  "local prior = redis.call('GET', KEYS[1])",
  'if not prior then return 0 end',
  'local decoded = cjson.decode(prior)',
  "if decoded['status'] ~= 'RUNNING' then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))",
  'return 1',
].join('\n');

/** The oldest retained entry's field list (`XRANGE … COUNT 1`), for the resume plan's `oldestSeq`. */
const OLDEST_LUA = "local rows = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', 1) if #rows == 0 then return nil end return rows[1]";

/** `XREVRANGE … COUNT n` — a page back from the tail, to find the id of the entry with a given seq. */
const TAIL_PAGE_LUA = "return redis.call('XREVRANGE', KEYS[1], ARGV[1], '-', 'COUNT', tonumber(ARGV[2]))";

const SCAN_PAGE = 200;

function fieldValue(fields: readonly string[], name: string): string | undefined {
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === name) return fields[i + 1];
  return undefined;
}

export class AgentRunStoreUnavailableError extends Error {
  constructor() {
    super('The agent run store (Redis) is not available.');
  }
}

export class AgentRunStore {
  constructor(private readonly redis: AgentRunRedis | undefined) {}

  available(): boolean {
    return this.redis?.isConnected() ?? false;
  }

  private client(): AgentRunRedis {
    if (!this.redis || !this.redis.isConnected()) throw new AgentRunStoreUnavailableError();
    return this.redis;
  }

  async get(tenantId: string, runId: string): Promise<AgentRunState | null> {
    const raw = await this.client().get(AGENT_RUN_KEY(tenantId, runId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AgentRunState;
    } catch {
      return null;
    }
  }

  async create(state: AgentRunState, ttlSeconds: number): Promise<void> {
    await this.client().eval(WRITE_LUA, 1, AGENT_RUN_KEY(state.tenantId, state.runId), JSON.stringify(state), ttlSeconds);
  }

  /** Write `next` only while the stored run is RUNNING. `true` when this call decided the transition. */
  async transition(next: AgentRunState, ttlSeconds: number): Promise<boolean> {
    const reply = await this.client().eval(TRANSITION_LUA, 1, AGENT_RUN_KEY(next.tenantId, next.runId), JSON.stringify(next), ttlSeconds);
    return reply === 1 || reply === '1';
  }

  /**
   * Claim an `Idempotency-Key` for `runId`. Returns the run id + body hash that OWN the key —
   * ours when the claim won, the earlier caller's otherwise.
   */
  async claimIdempotencyKey(
    tenantId: string,
    slug: string,
    idempotencyKey: string,
    claim: { runId: string; bodyHash: string },
    ttlSeconds: number,
  ): Promise<{ runId: string; bodyHash: string }> {
    const keyHash = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
    const reply = await this.client().eval(CLAIM_LUA, 1, AGENT_RUN_IDEMPOTENCY_KEY(tenantId, slug, keyHash), JSON.stringify(claim), ttlSeconds);
    if (typeof reply !== 'string') throw new AgentRunStoreUnavailableError();
    return JSON.parse(reply) as { runId: string; bodyHash: string };
  }

  /**
   * Append ONE v2 event through the run sequencer (`RUN_APPEND_LUA`). Best effort, like every
   * producer of the run stream (protocol-v2 §6.1): the stream mirrors the run, it is not the
   * record — `RUN_STREAM_CLOSED` and a transport failure are swallowed by the cache client.
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
 * deliveries of one key compute the same id even when Redis forgot the claim. Same derivation as
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
