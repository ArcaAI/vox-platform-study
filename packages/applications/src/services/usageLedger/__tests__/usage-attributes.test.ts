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

import {
  BYTE_SOURCES,
  COMPUTE_DEVICES,
  GUARDRAIL_DISPOSITIONS,
  STORAGE_CLASSES,
  USAGE_ATTRIBUTE_KEYS,
  USAGE_LEGS,
  USAGE_TRIGGERS,
  validateUsageAttributes,
  withUsageAttributes,
  withUsageTrigger,
} from '../usage-attributes';

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
        device: 'cuda',
        leg: 'primary',
        storageClass: 'claim-check',
        activityType: 'execute_node',
        byteSource: 'wire',
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
        // TASK-959 W0 (§10.2).
        'activityType',
        'byteSource',
        'device',
        'leg',
        'storageClass',
        // TASK-957 F-8 — node identity on the workflow lane.
        'nodeId',
        'workflowVersionId',
        // TASK-974 §9.2 — the DNA plane's two dimensions, both closed
        // vocabularies (see `dna-vocabulary.task974.test.ts`).
        'origin',
        'credentialClass',
      ].sort(),
    );
  });
});

/**
 * TASK-959 W0 — the five compute/network/storage dimensions (§10.2).
 *
 * Four of them are CLOSED vocabularies, and the validator enforces membership,
 * not merely shape. That is a deliberate step past what `trigger` and
 * `guardrail` get: `device` DECIDES THE UNIT (`cuda`/`mps` → `GPU_SECOND`,
 * `cpu` → `CPU_SECOND`), so a fifth spelling arriving from a mis-set
 * `metering.compute.deviceByProvider` entry would not fork a facet — it would
 * fork the price. `activityType` stays shape-only: it is the Temporal activity
 * name, an open set the worker owns.
 */
describe('compute / network / storage dimensions (TASK-959 §10.2)', () => {
  it('freezes the three device values — they decide which unit a row is denominated in', () => {
    expect([...COMPUTE_DEVICES].sort()).toEqual(['cpu', 'cuda', 'mps'].sort());
    for (const device of COMPUTE_DEVICES) expect(validateUsageAttributes({ device })).toEqual([]);
  });

  it('freezes the three funding-leg values (§6.2 — a failed attempt is its own leg)', () => {
    expect([...USAGE_LEGS].sort()).toEqual(['failed', 'fallback', 'primary'].sort());
    for (const leg of USAGE_LEGS) expect(validateUsageAttributes({ leg })).toEqual([]);
  });

  it('freezes the three storage classes the nightly snapshot reports (§5.2)', () => {
    expect([...STORAGE_CLASSES].sort()).toEqual(['claim-check', 'media', 'text'].sort());
    for (const storageClass of STORAGE_CLASSES) expect(validateUsageAttributes({ storageClass })).toEqual([]);
  });

  it('freezes the two byte sources — `app` says the figure is a proxy, not the wire (§4.2)', () => {
    expect([...BYTE_SOURCES].sort()).toEqual(['app', 'wire'].sort());
    for (const byteSource of BYTE_SOURCES) expect(validateUsageAttributes({ byteSource })).toEqual([]);
  });

  it('REJECTS an out-of-vocabulary value for each closed key', () => {
    // `gpu` is the plausible wrong spelling of `cuda`, and it is the dangerous
    // one: silently accepted, it becomes a rollup facet that no unit mapping
    // recognises, so the row is metered and never priced.
    expect(validateUsageAttributes({ device: 'gpu' })).toHaveLength(1);
    expect(validateUsageAttributes({ device: 'gpu' })[0]).toMatch(/device/);
    expect(validateUsageAttributes({ device: 'CUDA' })).toHaveLength(1);
    expect(validateUsageAttributes({ leg: 'retry' })).toHaveLength(1);
    expect(validateUsageAttributes({ storageClass: 'audio' })).toHaveLength(1);
    expect(validateUsageAttributes({ byteSource: 'proxy' })).toHaveLength(1);
  });

  it('names the permitted values in the violation, so an emitter is fixed in one pass', () => {
    expect(validateUsageAttributes({ device: 'gpu' })[0]).toMatch(/cuda/);
  });

  it('leaves `activityType` shape-checked only — the Temporal activity set is open', () => {
    expect(validateUsageAttributes({ activityType: 'execute_node' })).toEqual([]);
    expect(validateUsageAttributes({ activityType: 'emit_run_event' })).toEqual([]);
    // Still a DIMENSION, never a description.
    expect(validateUsageAttributes({ activityType: 'ran the node twice' })).toHaveLength(1);
  });

  it('still rejects a non-string for a closed key before it reaches the vocabulary check', () => {
    expect(validateUsageAttributes({ device: 3 })).toHaveLength(1);
    expect(validateUsageAttributes({ leg: true })).toHaveLength(1);
  });

  it('permits an explicit null for a closed key (the dimension does not apply)', () => {
    expect(validateUsageAttributes({ device: null, leg: null, storageClass: null, byteSource: null })).toEqual([]);
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

describe('withUsageAttributes — the general form L14 stamps `guardrail` through', () => {
  it('merges without disturbing what the builder set', () => {
    const batch = { common: { tenantId: 't1', attributesJson: { interrupted: true, trigger: 'CONSULTATION' } }, units: [] } as never;
    expect(withUsageAttributes(batch, { guardrail: 'opted_out' }).common.attributesJson).toEqual({
      interrupted: true,
      trigger: 'CONSULTATION',
      guardrail: 'opted_out',
    });
  });

  it('passes a null batch through', () => {
    expect(withUsageAttributes(null, { guardrail: 'screened' })).toBeNull();
  });
});
