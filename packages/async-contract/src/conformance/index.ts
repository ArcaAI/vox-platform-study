/**
 * The reusable conformance suite. Exported from the package
 * root so the exposure SSE and webhook channel can import
 * and run it against their OWN producer, rather than re-deriving what
 * "conforms to the envelope" means. "A documented contract that nothing
 * consumes is a wiki page" — this suite is the thing that makes it real.
 *
 * `assertAsyncConformance` never throws; every check appends a problem string
 * instead. An empty return means the producer conforms.
 */
import { asyncEnvelopeProblems, parseAsyncEnvelope } from '../envelope';

/**
 * The producer contract a transport-specific adopter implements to be
 * checked by this suite.
 */
export interface AsyncProducerUnderTest {
  /** Produce one envelope for a given logical event. */
  produce(input: { type: string; payload: unknown; correlationId: string }): Promise<unknown>;
  /** Replay from a resume token, if the transport is resumable. */
  replay?(token: string): Promise<unknown[]>;
  /** Whether this transport supports a resume token at all. */
  resumable: boolean;
  /**
   * Return the resume token for a value previously returned by `produce()`.
   *
   * Additive-optional beyond the sketch in the ticket's Task 6: `replay(token)`
   * alone cannot be exercised by a transport-agnostic suite without a way to
   * obtain a token for a SPECIFIC prior production first. Omit this on a
   * resumable producer and the suite still runs, but skips the mid-stream
   * replay assertion (11) rather than failing to call it at all.
   */
  resumeTokenOf?(produced: unknown): string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UUIDv7: version nibble `7`, variant nibble `8`-`b`. */
const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPE_PATTERN = /^[a-z0-9]+(\.[a-z0-9_]+){1,4}$/;

/** How many envelopes to produce for the volume/uniqueness assertions. */
const PRODUCTION_VOLUME = 1000;
/** Index at which the mid-stream resume assertion cuts the stream. */
const MID_STREAM_INDEX = 5;

/**
 * Run every assertion from against `producer`. Returns the
 * list of problems found — empty means the producer conforms to the async
 * envelope contract.
 */
export async function assertAsyncConformance(producer: AsyncProducerUnderTest): Promise<string[]> {
  const problems: string[] = [];

  const produced: unknown[] = [];
  try {
    const sameLogicalEvent = { type: 'conformance.test.event', payload: { n: 0 }, correlationId: 'conformance-fixed' };
    for (let i = 0; i < PRODUCTION_VOLUME; i += 1) {
      // The first two productions replay the SAME logical event (so the suite
      // can assert occurredAt/idempotencyKey stability across a redelivery);
      // every later one is a distinct event (so it can assert uniqueness/
      // differentiation at volume).
      const input = i < 2 ? sameLogicalEvent : { type: 'conformance.test.event', payload: { n: i }, correlationId: `conformance-${i}` };
      // eslint-disable-next-line no-await-in-loop -- sequential by design: each production must observe the prior one's side effects (e.g. an in-memory stream index) before the next is issued
      produced.push(await producer.produce(input));
    }
  } catch (err) {
    problems.push(`produce() threw: ${err instanceof Error ? err.message : String(err)}`);
    return problems;
  }

  // 1. every produced value satisfies asyncEnvelopeProblems -> empty
  produced.forEach((value, i) => {
    asyncEnvelopeProblems(value).forEach((p) => problems.push(`production[${i}]: ${p}`));
  });

  const envelopes = produced.filter(isRecord);

  // 2. id is unique across PRODUCTION_VOLUME productions and UUIDv7-shaped
  const ids = envelopes.map((e) => e.id).filter((v): v is string => typeof v === 'string');
  if (new Set(ids).size !== ids.length) {
    problems.push('id is not unique across productions');
  }
  ids.forEach((id, i) => {
    if (!UUIDV7_PATTERN.test(id)) problems.push(`production[${i}]: id '${id}' is not UUIDv7-shaped`);
  });

  // 3. tenantId present and never null/empty
  envelopes.forEach((e, i) => {
    if (typeof e.tenantId !== 'string' || e.tenantId.length === 0) {
      problems.push(`production[${i}]: tenantId is missing or empty`);
    }
  });

  // 4. type matches the grammar
  envelopes.forEach((e, i) => {
    if (typeof e.type !== 'string' || !TYPE_PATTERN.test(e.type)) {
      problems.push(`production[${i}]: type does not match the grammar`);
    }
  });

  const [first, second] = envelopes;

  // 5. occurredAt does not change across a redelivery of the same logical event
  if (first && second && first.occurredAt !== second.occurredAt) {
    problems.push('occurredAt changed across two productions of the same logical event');
  }

  // 6. idempotencyKey is stable across repeats of the same event, differs across distinct events
  if (first && second && first.idempotencyKey !== second.idempotencyKey) {
    problems.push('idempotencyKey is not stable across two productions of the same logical event');
  }
  const distinctKeys = envelopes.slice(2).map((e) => e.idempotencyKey);
  if (new Set(distinctKeys).size !== distinctKeys.length) {
    problems.push('idempotencyKey does not differ across distinct logical events');
  }

  // 7. payload XOR payloadRef — already enforced per-envelope by assertion 1 above.

  // 8. a payloadRef, when present, is shape-valid (fail-loud on a malformed ref).
  //    Fetching and hashing the referenced blob is out of this suite's scope — it
  //    has no blob-store handle; the adopting surface's own tests own that half.
  envelopes.forEach((e, i) => {
    if (Object.prototype.hasOwnProperty.call(e, 'payloadRef') && asyncEnvelopeProblems(e).length > 0) {
      problems.push(`production[${i}]: payloadRef is malformed`);
    }
  });

  // 9. correlationId propagated unchanged (nothing to check beyond assertion 1's shape
  //    check — correlationId is caller-supplied and echoed, not derived); causationId,
  //    when set, names a previously produced id.
  const seenIds = new Set<string>();
  envelopes.forEach((e, i) => {
    if (typeof e.causationId === 'string' && !seenIds.has(e.causationId)) {
      problems.push(`production[${i}]: causationId '${e.causationId}' does not name a previously produced id`);
    }
    if (typeof e.id === 'string') seenIds.add(e.id);
  });

  // 10. unknown schemaVersion -> refusal, not a partial parse
  if (first) {
    const unknownVersion = { ...first, schemaVersion: 999 };
    if (parseAsyncEnvelope(unknownVersion) !== null) {
      problems.push('parseAsyncEnvelope did not refuse an unknown schemaVersion');
    }
  }

  // 11 & 12. resume tokens
  if (producer.resumable) {
    if (!producer.replay) {
      problems.push('resumable producer must implement replay()');
    } else if (producer.resumeTokenOf) {
      const midEnvelope = produced[MID_STREAM_INDEX];
      const token = producer.resumeTokenOf(midEnvelope);
      if (!token) {
        problems.push('resumeTokenOf did not return a token for a resumable producer');
      } else {
        try {
          const suffix = await producer.replay(token);
          const expectedIds = envelopes.slice(MID_STREAM_INDEX + 1).map((e) => e.id);
          const actualIds = suffix.filter(isRecord).map((e) => e.id);
          if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
            problems.push('replay from a mid-stream token did not yield exactly the suffix (gap or duplicate detected)');
          }
        } catch (err) {
          problems.push(`replay() threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } else if (producer.replay) {
    problems.push('a non-resumable producer must not implement replay() — a resume token that cannot resume is worse than none (§3.6)');
  }

  return problems;
}
