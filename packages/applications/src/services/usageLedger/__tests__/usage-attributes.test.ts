/**
 * `attributesJson` allow-list enforcement (deliverable 5,
 * moved here from).
 *
 * The usage ledger is the ONE data plane in this platform that must stay
 * provably PHI-free: it is the only plane the billing pipeline reads, and D17
 * keeps that pipeline outside 45 CFR precisely because no PHI can
 * reach it. `attributesJson` is the only free-shaped column on the row, so it
 * is the only place PHI could get in — and an allow-list is the only control
 * that fails CLOSED against a key nobody thought to forbid.
 */

import { describe, expect, it } from 'vitest';

import { GUARDRAIL_DISPOSITIONS, USAGE_ATTRIBUTE_KEYS, USAGE_TRIGGERS, validateUsageAttributes, withUsageTrigger } from '../usage-attributes';

describe('validateUsageAttributes — the allow-list', () => {
  it('accepts the declared keys with enum-ish / id / scalar values', () => {
    expect(
      validateUsageAttributes({
        channelCount: 2,
        engine: 'whisper_cpp',
        pipelineId: '018f3c2a-1d3e-7b6a-9c4d-2f1e0a9b8c7d',
        languageMode: 'ml-en',
        serviceTier: 'batch',
        interrupted: true,
        streamKind: 'sse',
        cacheTtl: 'ephemeral_5m',
        endpointKind: 'anthropic.messages',
        contextBand: '128k+',
        trigger: 'AGENT_INVOCATION',
        guardrail: 'opted_out',
      }),
    ).toEqual([]);
  });

  it('accepts an absent / empty attribute bag', () => {
    expect(validateUsageAttributes(undefined)).toEqual([]);
    expect(validateUsageAttributes(null)).toEqual([]);
    expect(validateUsageAttributes({})).toEqual([]);
  });

  it('REJECTS a key that is not on the allow-list', () => {
    // The failing case that gives the allow-list its reason to exist: an
    // emitter reaches for a convenient extra field and PHI rides along.
    const violations = validateUsageAttributes({ chiefComplaint: 'chest pain radiating to left arm' });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/chiefComplaint/);
    expect(violations[0]).toMatch(/not allow-listed/i);
  });

  it('REJECTS free text even under an allow-listed key', () => {
    // A prose value is PHI-shaped regardless of which key carries it. Allowed
    // string values are enum members and opaque ids: no spaces, no punctuation
    // beyond `. _ -`, bounded length.
    const violations = validateUsageAttributes({ engine: 'patient reports chest pain' });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/engine/);
    expect(violations[0]).toMatch(/enum-ish|scalar|value/i);
  });

  it('REJECTS an over-long string even without spaces', () => {
    const violations = validateUsageAttributes({ pipelineId: 'a'.repeat(65) });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/pipelineId/);
  });

  it('REJECTS nested objects and arrays — a blob can hide anything', () => {
    expect(validateUsageAttributes({ engine: { name: 'whisper' } })).toHaveLength(1);
    expect(validateUsageAttributes({ engine: ['whisper'] })).toHaveLength(1);
  });

  it('REJECTS a non-finite or non-integer number', () => {
    expect(validateUsageAttributes({ channelCount: Number.NaN })).toHaveLength(1);
    expect(validateUsageAttributes({ channelCount: Number.POSITIVE_INFINITY })).toHaveLength(1);
    expect(validateUsageAttributes({ channelCount: 1.5 })).toHaveLength(1);
  });

  it('REJECTS a value whose type does not match the declared type of the key', () => {
    // `interrupted` is a flag; a string "true" would silently become truthy.
    expect(validateUsageAttributes({ interrupted: 'true' })).toHaveLength(1);
    expect(validateUsageAttributes({ channelCount: '2' })).toHaveLength(1);
  });

  it('REJECTS the attribute bag itself when it is not a plain object', () => {
    expect(validateUsageAttributes('engine=whisper')).toHaveLength(1);
    expect(validateUsageAttributes([{ engine: 'whisper' }])).toHaveLength(1);
  });

  it('reports EVERY violation, not just the first — an emitter fixes them in one pass', () => {
    expect(validateUsageAttributes({ noteText: 'x', channelCount: 'two' })).toHaveLength(2);
  });

  it('permits an explicit null value for an allow-listed key (absent, not free text)', () => {
    expect(validateUsageAttributes({ engine: null })).toEqual([]);
  });

  it('declares its allow-list as data so and the contract doc read the same list', () => {
    expect(Object.keys(USAGE_ATTRIBUTE_KEYS).sort()).toEqual(
      [
        'cacheTtl',
        'channelCount',
        'contextBand',
        'endpointKind',
        'engine',
        'guardrail',
        'interrupted',
        'languageMode',
        'pipelineId',
        'serviceTier',
        'streamKind',
        'trigger',
      ].sort(),
    );
  });
});

/**
 * TASK-890 L11 (OD-E) — `trigger` is the metering-parity dimension: which
 * PRODUCT ACTIVITY caused this inference. It answers "the tenant's bill jumped
 * — was that clinicians consulting, or one engineer looping a prompt test?",
 * which no other column on the row can.
 */
describe('trigger — the activity dimension (TASK-890 OD-E)', () => {
  it('accepts every declared trigger value against the allow-list', () => {
    for (const trigger of USAGE_TRIGGERS) {
      expect(validateUsageAttributes({ trigger })).toEqual([]);
    }
  });

  it('freezes the vocabulary the four lanes stamp', () => {
    expect([...USAGE_TRIGGERS].sort()).toEqual(['AGENT_INVOCATION', 'AGENT_TEST', 'CONSULTATION', 'PROMPT_TEST', 'WORKFLOW_RUN'].sort());
  });

  it('rejects free text in `trigger` — it is a dimension, never a description', () => {
    expect(validateUsageAttributes({ trigger: 'x y' })).toHaveLength(1);
    expect(validateUsageAttributes({ trigger: 'x y' })[0]).toContain('trigger');
  });

  it('rejects a non-string `trigger`', () => {
    expect(validateUsageAttributes({ trigger: 3 })).toHaveLength(1);
  });
});

/** The `guardrail` disposition key L14 stamps (round 3, OD-R). L11 only declares it. */
describe('guardrail — the screening disposition (TASK-890 OD-R)', () => {
  it('accepts every declared disposition', () => {
    for (const disposition of GUARDRAIL_DISPOSITIONS) {
      expect(validateUsageAttributes({ guardrail: disposition })).toEqual([]);
    }
  });

  it('freezes the three-value vocabulary', () => {
    expect([...GUARDRAIL_DISPOSITIONS].sort()).toEqual(['opted_out', 'platform_off', 'screened'].sort());
  });
});

describe('withUsageTrigger — stamping an already-built batch', () => {
  const batch = {
    common: { tenantId: 't1', idempotencyKey: 'k', attributesJson: { interrupted: false } },
    units: [],
  } as never;

  it('adds the trigger without disturbing the attributes the builder already set', () => {
    const stamped = withUsageTrigger(batch, 'PROMPT_TEST');
    expect(stamped.common.attributesJson).toEqual({ interrupted: false, trigger: 'PROMPT_TEST' });
  });

  it('does not mutate the input batch (a caller may reuse it)', () => {
    withUsageTrigger(batch, 'PROMPT_TEST');
    expect((batch as { common: { attributesJson: unknown } }).common.attributesJson).toEqual({ interrupted: false });
  });

  it('passes a null batch through — "nothing consumed" stays "no rows"', () => {
    expect(withUsageTrigger(null, 'CONSULTATION')).toBeNull();
  });

  it('creates the attribute bag when the builder produced none', () => {
    const bare = { common: { tenantId: 't1', idempotencyKey: 'k' }, units: [] } as never;
    expect(withUsageTrigger(bare, 'WORKFLOW_RUN').common.attributesJson).toEqual({ trigger: 'WORKFLOW_RUN' });
  });
});
