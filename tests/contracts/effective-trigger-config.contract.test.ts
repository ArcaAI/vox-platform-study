/**
 * TASK-982 §3.4.4 — the per-run trigger `contextSchema` block, producer half.
 *
 * The gateway writes this block immediately before dispatch and the harness's
 * `interpreter.core_trigger` validates a run payload against its `resolved` and nothing else.
 * Both halves read the SAME committed fixture — `effective-trigger-config.fixture.json` — so a
 * shape change on either side fails the other; the Python half is
 * `apps/harness/src/harness/tests/unit/temporal/interpreter/test_task982_effective_trigger_config.py`.
 *
 * This file asserts the PRODUCER side twice over:
 *
 *   1. `effectiveTriggerConfig` actually emits each fixture block — the pinned one unchanged, the
 *      follow-latest one rewritten from a pin;
 *   2. the `accepts` / `refuses` payloads really are accepted and refused by `resolved`, using
 *      the same subset validator the platform validates every schema-bound payload with. The
 *      Python half then proves the interpreter agrees, which is the whole point of the fixture:
 *      one file, two runtimes, no room for the two to drift about what a run will be checked
 *      against.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonSchemaValueProblems } from '../../packages/json-schema-subset/src/json-schema-subset';
import { effectiveTriggerConfig } from '../../packages/applications/src/services/workflow-exposure/effective-trigger-schema';

interface FixtureCase {
  contextSchema: Record<string, unknown>;
  accepts: Record<string, unknown>[];
  refuses: Record<string, unknown>[];
}

/**
 * The server's own run envelope — stripped before validation, exactly as `_authored_context`
 * does. A MIRROR of `RESERVED_RUN_IDENTITY_KEYS` in
 * `apps/harness/src/harness/temporal/interpreter/models.py`; the Python half of this fixture
 * imports the real tuple, so a divergence fails there.
 */
const RESERVED_RUN_IDENTITY_KEYS = ['consultationId', 'externalPatientId', 'userId', 'jobId', 'sessionId'];

const fixture = JSON.parse(readFileSync(join(__dirname, 'effective-trigger-config.fixture.json'), 'utf-8')) as Record<string, FixtureCase | string>;
const cases = Object.entries(fixture).filter((entry): entry is [string, FixtureCase] => typeof entry[1] === 'object');

function authoredContext(runPayload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(runPayload).filter(([key]) => !RESERVED_RUN_IDENTITY_KEYS.includes(key)));
}

/** A compiled artifact whose trigger carries `block`. */
function compiledWith(block: Record<string, unknown>): Record<string, unknown> {
  return {
    formatVersion: 1,
    stages: [
      { index: 0, nodes: [{ nodeId: 'n_trigger', type: 'core.trigger', activity: 'interpreter.core_trigger', config: { contextSchema: block } }] },
    ],
    checksum: 'fixture',
  };
}

function triggerBlockOf(config: unknown): Record<string, unknown> {
  const stages = (config as { stages: Array<{ nodes: Array<{ nodeId: string; config: Record<string, unknown> }> }> }).stages;
  return stages.flatMap((stage) => stage.nodes).find((node) => node.nodeId === 'n_trigger')!.config.contextSchema as Record<string, unknown>;
}

/** The v4 definition the follow-latest cases' `resolved` is derived from. */
const PIN_V4 = {
  versionNumber: 4,
  definition: {
    kinds: [
      { key: 'encounter', primitive: 'STRUCTURED', fields: { type: 'object', properties: { chief_complaint: { type: 'string' } } } },
      { key: 'referral', primitive: 'STRUCTURED', fields: { type: 'object', properties: { reason: { type: 'string' } } } },
    ],
  },
};

describe('the fixture is the shape the ticket pinned', () => {
  it('declares the pinned, the follow-latest and the reserved-key cases', () => {
    expect(cases.map(([name]) => name)).toEqual(
      expect.arrayContaining(['pinnedTriggerIsUnchanged', 'followsLatestCarriesTheTenantPin', 'reservedIdentityKeysAreNeverValidated']),
    );
  });

  it.each(cases)('%s: carries a `resolved` object, and `followsLatest` only when it is true', (_name, { contextSchema }) => {
    expect(contextSchema.resolved).toBeTypeOf('object');
    if ('followsLatest' in contextSchema) expect(contextSchema.followsLatest).toBe(true);
    // `effectiveVersionNumber` is a PER-RUN field and belongs only to a rewritten block.
    if ('effectiveVersionNumber' in contextSchema) expect(contextSchema.followsLatest).toBe(true);
  });
});

describe('effectiveTriggerConfig emits these blocks', () => {
  it('leaves the PINNED block byte-identical, even with a newer pin in hand', () => {
    const block = (fixture.pinnedTriggerIsUnchanged as FixtureCase).contextSchema;

    const result = effectiveTriggerConfig(compiledWith(block), PIN_V4);

    expect(result.rewritten).toBe(false);
    expect(triggerBlockOf(result.config)).toEqual(block);
  });

  it('rewrites the FOLLOW-LATEST block from the tenant pin, down to `effectiveVersionNumber`', () => {
    const expected = (fixture.followsLatestCarriesTheTenantPin as FixtureCase).contextSchema;
    // The artifact as PUBLISHED: frozen against v1, with no per-run fields yet.
    const published = {
      contextSchemaId: expected.contextSchemaId,
      followsLatest: true,
      resolved: { type: 'object', additionalProperties: false, properties: { encounter: { type: 'object' } } },
    };

    const result = effectiveTriggerConfig(compiledWith(published), {
      versionNumber: PIN_V4.versionNumber,
      definition: {
        kinds: [
          ...PIN_V4.definition.kinds.map((kind) =>
            kind.key === 'encounter' ? { ...kind, userIdentity: { field: 'doctor_id' }, department: { field: 'department_code', by: 'code' } } : kind,
          ),
        ],
      },
    });

    expect(result.rewritten).toBe(true);
    expect(triggerBlockOf(result.config)).toEqual(expected);
  });
});

describe('the fixture payloads really are accepted and refused by `resolved`', () => {
  it.each(cases)('%s: every `accepts` payload validates', (_name, { contextSchema, accepts }) => {
    for (const payload of accepts) {
      expect(jsonSchemaValueProblems(contextSchema.resolved, authoredContext(payload))).toEqual([]);
    }
  });

  it.each(cases)('%s: every `refuses` payload does not', (_name, { contextSchema, refuses }) => {
    for (const payload of refuses) {
      expect(jsonSchemaValueProblems(contextSchema.resolved, authoredContext(payload)).length).toBeGreaterThan(0);
    }
  });
});
