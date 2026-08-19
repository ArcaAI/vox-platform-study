/**
 * TASK-717 Task 6 — wires the reusable conformance suite against the Task 5
 * SMR reference implementation's envelope recipe.
 *
 * `assertAsyncConformance` (`@arcaai/async-contract`) cannot import Python
 * directly, so — following this directory's existing convention of
 * exercising a service's WIRE CONTRACT rather than a live network call
 * (`text.contract.test.ts`, `stt.contract.test.ts` mock the peer's
 * responses instead of calling it) — this test drives an in-memory producer
 * that reproduces the EXACT recipe `apps/text/src/text/services/
 * task_manager.py`'s `_encode_chunk_data`/`_decode_chunk_data` implement:
 *   - `type`:            `smr.stream.<chunk.type>`
 *   - `idempotencyKey`:  `AsyncIdempotencyKey.textChunk(taskId, sequence)`
 *     (`text:task:<taskId>:chunk:<sequence>`, matching `AsyncIdempotencyKey.
 *     textChunk` in `packages/async-contract/src/idempotency.ts` and
 *     `AsyncIdempotencyKey.text_chunk` in `packages/py-async-contract/src/
 *     hope_async_contract/idempotency.py` — the SAME recipe on both sides,
 *     proven by `test_parity.py`)
 *   - resume tokens:     `encodeResumeToken('redis-stream', <redis msg id>)`
 *     (`stream.py`'s SSE `id:` field)
 *
 * A green run here means: if a Python producer follows this documented
 * recipe (as Task 5 does), it conforms to the async envelope contract. This
 * is the artifact TASK-722 (exposure SSE) and TASK-727 (webhook channel)
 * import and run against their OWN producer — see `async-contract.md`.
 */
import { describe, it, expect } from 'vitest';
// Relative source import, not the bare `@arcaai/async-contract` specifier: this
// top-level `tests/` tree has no `package.json` of its own and the root
// workspace does not declare the package as a dependency (only `resolve.alias`
// entries in `vitest.config.ts` are resolvable as bare specifiers here) — same
// reason `ai-model-providers.contract.test.ts` imports the seed list by
// relative path rather than a package specifier.
import {
  assertAsyncConformance,
  AsyncIdempotencyKey,
  ASYNC_ENVELOPE_SCHEMA_VERSION,
  encodeResumeToken,
  decodeResumeToken,
  type AsyncProducerUnderTest,
} from '../../packages/async-contract/src/index';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** UUIDv7-shaped synthetic id — real production uses `uuid_extensions.uuid7()` (Python). */
function testUuidV7(counter: number): string {
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-7000-8000-${hex}`;
}

/**
 * Reproduces `TaskManager._encode_chunk_data` / the SSE `id:` field over an
 * in-memory Redis Stream stand-in — same shape as `_FakeRedis` in
 * `apps/text/src/text/tests/unit/test_async_envelope_task717.py`.
 */
class SmrStreamProducer implements AsyncProducerUnderTest {
  resumable = true;
  private readonly taskId = 'contract-test-task';
  private sequence = 0;
  private idCounter = 0;
  /** (resumeToken, envelope) in append order — mirrors the Redis Stream. */
  private readonly stream: Array<{ token: string; envelope: Record<string, unknown> }> = [];
  /**
   * `correlationId` -> the (sequence, occurredAt) it was FIRST assigned.
   *
   * A genuine at-least-once REDELIVERY of the same logical chunk write (the
   * conformance suite drives this by calling `produce()` twice with an
   * identical `correlationId`) must reuse the same `idempotencyKey` and
   * `occurredAt` (design doc §3.5's "derived from intent, never chance") —
   * it still appends a fresh Redis Stream entry (a new `id`/resume token),
   * exactly as a retried XADD would.
   */
  private readonly identity = new Map<string, { sequence: number; occurredAt: string }>();

  async produce(input: { type: string; payload: unknown; correlationId: string }): Promise<unknown> {
    let identity = this.identity.get(input.correlationId);
    if (!identity) {
      identity = { sequence: this.sequence, occurredAt: new Date().toISOString() };
      this.identity.set(input.correlationId, identity);
      this.sequence += 1;
    }

    const envelope = {
      schemaVersion: ASYNC_ENVELOPE_SCHEMA_VERSION,
      id: testUuidV7(this.idCounter),
      tenantId: SYSTEM_TENANT_ID,
      type: `smr.stream.${input.type}`,
      occurredAt: identity.occurredAt,
      correlationId: input.correlationId,
      causationId: null,
      idempotencyKey: AsyncIdempotencyKey.textChunk(this.taskId, identity.sequence),
      payload: input.payload,
    };
    const redisMsgId = `${this.idCounter + 1}-0`;
    const token = encodeResumeToken('redis-stream', redisMsgId);
    this.stream.push({ token, envelope });
    this.idCounter += 1;
    return envelope;
  }

  async replay(token: string): Promise<unknown[]> {
    const decoded = decodeResumeToken(token);
    if (!decoded) return [];
    const fromSeq = Number(decoded.cursor.split('-')[0]);
    return this.stream.filter((_entry, i) => i + 1 > fromSeq).map((entry) => entry.envelope);
  }

  resumeTokenOf(produced: unknown): string | undefined {
    return this.stream.find((entry) => entry.envelope === produced)?.token;
  }
}

describe('async envelope contract — SMR stream chunk producer (TASK-717 Task 5 recipe)', () => {
  it('conforms to the async envelope contract end to end', async () => {
    const problems = await assertAsyncConformance(new SmrStreamProducer());
    expect(problems).toEqual([]);
  }, 20000);

  it('types use the smr.stream.<chunk.type> grammar', async () => {
    const producer = new SmrStreamProducer();
    const produced = (await producer.produce({
      type: 'chunk',
      payload: { type: 'chunk', content: 'hello' },
      correlationId: 'req-1',
    })) as Record<string, unknown>;
    expect(produced.type).toBe('smr.stream.chunk');
  });

  it('idempotency keys follow AsyncIdempotencyKey.textChunk(taskId, sequence)', async () => {
    const producer = new SmrStreamProducer();
    const first = (await producer.produce({
      type: 'chunk',
      payload: {},
      correlationId: 'req-1',
    })) as Record<string, unknown>;
    const second = (await producer.produce({
      type: 'chunk',
      payload: {},
      correlationId: 'req-2',
    })) as Record<string, unknown>;
    expect(first.idempotencyKey).toBe('text:task:contract-test-task:chunk:0');
    expect(second.idempotencyKey).toBe('text:task:contract-test-task:chunk:1');
  });

  it('a redelivered chunk (same correlationId) reuses the same idempotencyKey and occurredAt', async () => {
    const producer = new SmrStreamProducer();
    const first = (await producer.produce({
      type: 'chunk',
      payload: {},
      correlationId: 'req-1',
    })) as Record<string, unknown>;
    const redelivered = (await producer.produce({
      type: 'chunk',
      payload: {},
      correlationId: 'req-1',
    })) as Record<string, unknown>;
    expect(redelivered.idempotencyKey).toBe(first.idempotencyKey);
    expect(redelivered.occurredAt).toBe(first.occurredAt);
    expect(redelivered.id).not.toBe(first.id);
  });

  it('resume tokens wrap a redis-stream cursor, decodable by both language packages', async () => {
    const producer = new SmrStreamProducer();
    await producer.produce({ type: 'chunk', payload: {}, correlationId: 'req-1' });
    const token = producer.resumeTokenOf(
      await producer.produce({ type: 'chunk', payload: {}, correlationId: 'req-1' })
    );
    expect(token).toBeDefined();
    expect(decodeResumeToken(token as string)).toEqual({ transport: 'redis-stream', cursor: '2-0' });
  });
});
