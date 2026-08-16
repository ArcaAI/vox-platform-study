import { describe, it, expect } from 'vitest';

import { ASYNC_ENVELOPE_SCHEMA_VERSION } from '../../envelope';
import { encodeResumeToken, decodeResumeToken } from '../../resume-token';
import { assertAsyncConformance, type AsyncProducerUnderTest } from '../index';

/** Deterministic 0-59 hash so two productions of the same logical event get the same occurredAt. */
function hashSeconds(value: string): number {
  let hash = 0;
  for (const ch of value) hash = (hash * 31 + ch.charCodeAt(0)) % 60;
  return hash;
}

function testUuidV7(counter: number): string {
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-7000-8000-${hex}`;
}

/** An in-memory, well-behaved, resumable producer — the self-test double for the suite. */
class FakeResumableProducer implements AsyncProducerUnderTest {
  resumable = true;
  private readonly log: Array<{ token: string; envelope: Record<string, unknown> }> = [];
  private counter = 0;

  async produce(input: { type: string; payload: unknown; correlationId: string }): Promise<unknown> {
    const occurredAt = new Date(Date.UTC(2026, 0, 1, 0, 0, hashSeconds(input.correlationId))).toISOString();
    const envelope = {
      schemaVersion: ASYNC_ENVELOPE_SCHEMA_VERSION,
      id: testUuidV7(this.counter),
      tenantId: '00000000-0000-0000-0000-000000000000',
      type: input.type,
      occurredAt,
      correlationId: input.correlationId,
      causationId: null,
      idempotencyKey: `${input.type}:${input.correlationId}`,
      payload: input.payload,
    };
    const token = encodeResumeToken('in-memory', String(this.counter));
    this.log.push({ token, envelope });
    this.counter += 1;
    return envelope;
  }

  async replay(token: string): Promise<unknown[]> {
    const decoded = decodeResumeToken(token);
    if (!decoded) return [];
    const fromIndex = Number(decoded.cursor);
    return this.log.filter((_, i) => i > fromIndex).map((entry) => entry.envelope);
  }

  resumeTokenOf(produced: unknown): string | undefined {
    return this.log.find((entry) => entry.envelope === produced)?.token;
  }
}

/** A non-resumable producer that correctly declines to implement replay(). */
class FakeNonResumableProducer implements AsyncProducerUnderTest {
  resumable = false;
  private counter = 0;

  async produce(input: { type: string; payload: unknown; correlationId: string }): Promise<unknown> {
    this.counter += 1;
    return {
      schemaVersion: ASYNC_ENVELOPE_SCHEMA_VERSION,
      id: testUuidV7(this.counter),
      tenantId: '00000000-0000-0000-0000-000000000000',
      type: input.type,
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, hashSeconds(input.correlationId))).toISOString(),
      correlationId: input.correlationId,
      causationId: null,
      idempotencyKey: `${input.type}:${input.correlationId}`,
      payload: input.payload,
    };
  }
}

class BadProducer implements AsyncProducerUnderTest {
  resumable = false;

  async produce(): Promise<unknown> {
    return { not: 'an envelope' };
  }
}

describe('assertAsyncConformance', () => {
  it('passes against a well-behaved resumable producer', async () => {
    const problems = await assertAsyncConformance(new FakeResumableProducer());
    expect(problems).toEqual([]);
  }, 20000);

  it('passes against a well-behaved non-resumable producer', async () => {
    const problems = await assertAsyncConformance(new FakeNonResumableProducer());
    expect(problems).toEqual([]);
  }, 20000);

  it('reports problems for a producer emitting non-conforming envelopes, never throws', async () => {
    const problems = await assertAsyncConformance(new BadProducer());
    expect(problems.length).toBeGreaterThan(0);
  }, 20000);

  it('flags a resumable producer that declares resumable but has no replay()', async () => {
    class MisdeclaredProducer extends FakeNonResumableProducer {
      resumable = true;
    }
    const problems = await assertAsyncConformance(new MisdeclaredProducer());
    expect(problems).toContain('resumable producer must implement replay()');
  }, 20000);
});
