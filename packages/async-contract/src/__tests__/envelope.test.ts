import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { ASYNC_ENVELOPE_SCHEMA_VERSION, asyncEnvelopeProblems, parseAsyncEnvelope } from '../envelope';

// __dirname (not import.meta.url) — this test file compiles to CommonJS (tsconfig.json has
// no "type": "module"), and `import.meta` is not allowed in CJS output (TS1470).
const EXAMPLES_DIR = join(__dirname, 'examples');

function loadExample(name: string): unknown {
  return JSON.parse(readFileSync(join(EXAMPLES_DIR, `${name}.json`), 'utf8'));
}

const VALID_INLINE = loadExample('inline-payload');
const VALID_CLAIM_CHECK = loadExample('claim-check-payload');
const INVALID_BOTH = loadExample('invalid-both');

describe('asyncEnvelopeProblems — the hand-rolled TS validator', () => {
  it('accepts a well-formed envelope with an inline payload', () => {
    expect(asyncEnvelopeProblems(VALID_INLINE)).toEqual([]);
  });

  it('accepts a well-formed envelope with a payloadRef claim check', () => {
    expect(asyncEnvelopeProblems(VALID_CLAIM_CHECK)).toEqual([]);
  });

  it('rejects an envelope carrying BOTH payload and payloadRef', () => {
    const problems = asyncEnvelopeProblems(INVALID_BOTH);
    expect(problems.join(' ')).toMatch(/exactly one of payload or payloadRef/);
  });

  it('rejects an envelope carrying NEITHER payload nor payloadRef', () => {
    const { payload: _payload, ...withoutPayload } = VALID_INLINE as Record<string, unknown>;
    const problems = asyncEnvelopeProblems(withoutPayload);
    expect(problems.join(' ')).toMatch(/exactly one of payload or payloadRef/);
  });

  it('rejects an unknown schemaVersion rather than best-effort parsing', () => {
    const problems = asyncEnvelopeProblems({ ...(VALID_INLINE as Record<string, unknown>), schemaVersion: 2 });
    expect(problems.join(' ')).toMatch(/schemaVersion must be 1/);
  });

  it('rejects a non-UUID id', () => {
    const problems = asyncEnvelopeProblems({ ...(VALID_INLINE as Record<string, unknown>), id: 'not-a-uuid' });
    expect(problems.join(' ')).toMatch(/id must be a UUID string/);
  });

  it('rejects a non-UUID tenantId', () => {
    const problems = asyncEnvelopeProblems({ ...(VALID_INLINE as Record<string, unknown>), tenantId: '' });
    expect(problems.join(' ')).toMatch(/tenantId must be a UUID string/);
  });

  it('rejects a type that is not lowercase dotted', () => {
    const problems = asyncEnvelopeProblems({ ...(VALID_INLINE as Record<string, unknown>), type: 'Not.Valid' });
    expect(problems.join(' ')).toMatch(/type must be/);
  });

  it('rejects a type with only one segment (no dot)', () => {
    const problems = asyncEnvelopeProblems({ ...(VALID_INLINE as Record<string, unknown>), type: 'nodot' });
    expect(problems.join(' ')).toMatch(/type must be/);
  });

  it('rejects a non-ISO-8601 occurredAt', () => {
    const problems = asyncEnvelopeProblems({ ...(VALID_INLINE as Record<string, unknown>), occurredAt: 'yesterday' });
    expect(problems.join(' ')).toMatch(/occurredAt must be/);
  });

  it('accepts a null causationId', () => {
    expect(asyncEnvelopeProblems({ ...(VALID_INLINE as Record<string, unknown>), causationId: null })).toEqual([]);
  });

  it('rejects a non-UUID, non-null causationId', () => {
    const problems = asyncEnvelopeProblems({ ...(VALID_INLINE as Record<string, unknown>), causationId: 'nope' });
    expect(problems.join(' ')).toMatch(/causationId must be a UUID string or null/);
  });

  it('rejects a malformed idempotencyKey', () => {
    const problems = asyncEnvelopeProblems({ ...(VALID_INLINE as Record<string, unknown>), idempotencyKey: '' });
    expect(problems.join(' ')).toMatch(/idempotencyKey/);
  });

  it('rejects an unexpected top-level property (additionalProperties: false)', () => {
    const problems = asyncEnvelopeProblems({ ...(VALID_INLINE as Record<string, unknown>), traceparent: '00-...' });
    expect(problems.join(' ')).toMatch(/unexpected property 'traceparent'/);
  });

  it('rejects a non-object value', () => {
    expect(asyncEnvelopeProblems('not-an-object')).toEqual(['envelope must be a JSON object']);
    expect(asyncEnvelopeProblems(null)).toEqual(['envelope must be a JSON object']);
    expect(asyncEnvelopeProblems([1, 2, 3])).toEqual(['envelope must be a JSON object']);
  });
});

describe('parseAsyncEnvelope — refuse-if-unknown', () => {
  it('returns the value, typed, when it conforms', () => {
    expect(parseAsyncEnvelope(VALID_INLINE)).toEqual(VALID_INLINE);
  });

  it('returns null for an unknown schemaVersion', () => {
    expect(parseAsyncEnvelope({ ...(VALID_INLINE as Record<string, unknown>), schemaVersion: 999 })).toBeNull();
  });

  it('returns null for any other conformance problem', () => {
    expect(parseAsyncEnvelope({ not: 'an envelope' })).toBeNull();
  });
});

describe('ASYNC_ENVELOPE_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(ASYNC_ENVELOPE_SCHEMA_VERSION).toBe(1);
  });
});

describe('parity — the TS validator agrees with schema/async-envelope.v1.json on the shared example corpus', () => {
  // Ground truth for each fixture's validity against schema/async-envelope.v1.json was
  // established independently, OUTSIDE this test suite, by validating the schema itself
  // against the draft 2020-12 metaschema and then validating each fixture with Python's
  // `jsonschema.Draft202012Validator` (no shared code path with `asyncEnvelopeProblems`).
  // This package stays dependency-free (no ajv/zod — see the module docstring in
  // ../envelope.ts), so the parity check here asserts the hand-rolled TS validator's
  // verdict against that externally-established ground truth rather than re-deriving it
  // with a second in-process JSON Schema engine. `hope_async_contract`'s own parity test
  // (packages/py-async-contract/tests/test_parity.py) round-trips the SAME fixtures through
  // pydantic's generated schema, so both language packages are checked against one artifact.
  const cases: Array<{ name: string; value: unknown; schemaValid: boolean }> = [
    { name: 'inline-payload', value: VALID_INLINE, schemaValid: true },
    { name: 'claim-check-payload', value: VALID_CLAIM_CHECK, schemaValid: true },
    { name: 'invalid-both', value: INVALID_BOTH, schemaValid: false },
  ];

  it.each(cases)('$name: asyncEnvelopeProblems agrees with the schema ($schemaValid)', ({ value, schemaValid }) => {
    const tsValid = asyncEnvelopeProblems(value).length === 0;
    expect(tsValid).toBe(schemaValid);
  });
});
