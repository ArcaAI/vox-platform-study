/**
 * TASK-974 §9.2 (design D-5) — the two DNA operations, their key recipe, and the
 * two dimensions they stamp.
 *
 * The DNA plane spends real money — an LLM call per report, and an ingest API
 * that decides whether one happens — and recorded NOTHING in the usage ledger
 * before this ticket. Everything here is a ROLLUP DIMENSION, and the failure
 * mode of a wrong one is silent: a misspelled operation lands under a facet no
 * invoice sums, a random idempotency key bills every retry, and an
 * un-allow-listed attribute is rejected at emission, dropping the whole batch.
 */
import { describe, expect, it } from 'vitest';

import { UsageIdempotencyKey } from '../idempotency-keys';
import { USAGE_ATTRIBUTE_KEYS, USAGE_CREDENTIAL_CLASSES, USAGE_ORIGINS, validateUsageAttributes } from '../usage-attributes';
import { KNOWN_PROVIDERS, SELF_HOSTED_PROVIDER_IDS, USAGE_OPERATIONS, isUsageOperation, validateProviderId } from '../vocabulary';

describe('the two DNA operations join the closed list', () => {
  it('admits `dna.analyze` and `dna.ingest` under their exact spellings', () => {
    expect(USAGE_OPERATIONS).toContain('dna.analyze');
    expect(USAGE_OPERATIONS).toContain('dna.ingest');
    expect(isUsageOperation('dna.analyze')).toBe(true);
    expect(isUsageOperation('dna.ingest')).toBe(true);
  });

  it('refuses the near-misses that would fork a rollup dimension', () => {
    // A typo does not fail loudly — it lands under an operation nothing sums.
    expect(isUsageOperation('dna_analyze')).toBe(false);
    expect(isUsageOperation('dna.Analyze')).toBe(false);
    expect(isUsageOperation('dna.analyse')).toBe(false);
    expect(isUsageOperation('dna.ingest ')).toBe(false);
  });

  it('keeps the list closed — fifteen operations, no more', () => {
    expect(new Set(USAGE_OPERATIONS).size).toBe(USAGE_OPERATIONS.length);
    expect(USAGE_OPERATIONS).toHaveLength(15);
  });
});

describe('the ingest row names the platform workload that accepted it', () => {
  it('carries `hope-api` in the canonical vocabulary', () => {
    // `dna.ingest` records an API call the GATEWAY accepted, not a model a
    // vendor ran. Reusing an inference connection id (`built-in`) would mix
    // these REQUEST/CHARACTER rows into that connection's token rollup.
    expect(KNOWN_PROVIDERS).toContain('hope-api');
    expect(validateProviderId('hope-api')).toEqual([]);
  });

  it('classifies it as the platform`s own hardware, like `harness`', () => {
    // Stamped explicitly by the emitter, but a future DERIVATION must not
    // classify the platform's own gateway as somebody's cloud vendor — the
    // `tei-embed` defect the vocabulary header records.
    expect(SELF_HOSTED_PROVIDER_IDS.has('hope-api')).toBe(true);
  });
});

describe('the ingest idempotency recipe is derived from the job, never from chance', () => {
  it('derives the base key from the job id', () => {
    expect(UsageIdempotencyKey.dnaIngest('job-42')).toBe('dna-ingest:job-42');
  });

  it('is stable across retries of the same enqueue', () => {
    expect(UsageIdempotencyKey.dnaIngest('job-42')).toBe(UsageIdempotencyKey.dnaIngest('job-42'));
  });

  it('refuses a blank job id rather than collapsing every ingest onto one key', () => {
    expect(() => UsageIdempotencyKey.dnaIngest('')).toThrow(/jobId/);
    expect(() => UsageIdempotencyKey.dnaIngest('   ')).toThrow(/jobId/);
  });

  it('appends the unit exactly as every other recipe does', () => {
    expect(UsageIdempotencyKey.forUnit(UsageIdempotencyKey.dnaIngest('job-42'), 'REQUEST' as never)).toBe('dna-ingest:job-42:REQUEST');
  });
});

describe('the two dimensions the DNA rows stamp', () => {
  it('allow-lists `origin` and `credentialClass`', () => {
    expect(USAGE_ATTRIBUTE_KEYS).toHaveProperty('origin', 'string');
    expect(USAGE_ATTRIBUTE_KEYS).toHaveProperty('credentialClass', 'string');
  });

  it('accepts every declared origin and every credential class', () => {
    for (const origin of USAGE_ORIGINS) expect(validateUsageAttributes({ origin })).toEqual([]);
    for (const credentialClass of USAGE_CREDENTIAL_CLASSES) expect(validateUsageAttributes({ credentialClass })).toEqual([]);
  });

  it('closes both vocabularies — a near-miss is refused, not recorded', () => {
    // Both are facets a support answer groups by ("which surface asked",
    // "which credential class"), so a plausible misspelling that passed the
    // shape check would fork the facet silently.
    expect(validateUsageAttributes({ origin: 'ingestion' })).toHaveLength(1);
    expect(validateUsageAttributes({ credentialClass: 'apikey' })).toHaveLength(1);
    expect(validateUsageAttributes({ credentialClass: 'JWT' })).toHaveLength(1);
  });

  it('names the permitted values when it refuses one', () => {
    expect(validateUsageAttributes({ origin: 'ingestion' })[0]).toContain('generate, ingest, scheduler');
  });
});
