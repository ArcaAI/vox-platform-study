/**
 * The per-run rewrite of a FOLLOW-LATEST trigger's frozen context schema.
 *
 * The compiled artifact carries ONE answer, frozen at publish. That is right for a PINNED
 * trigger and wrong for a follow-latest one, whose whole promise — the one the studio's
 * "Follow latest (currently vN)" option makes — is that a republish of the SCHEMA changes what
 * the trigger accepts. The gateway keeps that promise here, once, in the only window where it
 * can be kept without a database read inside the interpreter: the per-run claim-checked config
 * it mints immediately before dispatch.
 *
 * Everything below is about that one rewrite. `interpreter_core_trigger` is untouched and still
 * validates `resolved` and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { effectiveTriggerConfig, triggerContextBinding } from '../effective-trigger-schema';

/** The kind declaration shape `payloadSchemaFromDefinition` and its two siblings derive from. */
function definition(kinds: Array<{ key: string; identity?: string; department?: string }>): Record<string, unknown> {
  return {
    kinds: kinds.map((kind) => ({
      key: kind.key,
      label: kind.key,
      primitive: 'STRUCTURED',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      fields: { type: 'object', properties: { note: { type: 'string' } } },
      ...(kind.identity ? { userIdentity: { field: kind.identity } } : {}),
      ...(kind.department ? { department: { field: kind.department, by: 'code' } } : {}),
    })),
  };
}

function compiled(contextSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    formatVersion: 1,
    slug: 'consultation-default',
    stages: [
      {
        index: 0,
        nodes: [{ nodeId: 'n_trigger', type: 'core.trigger', activity: 'interpreter.core_trigger', config: contextSchema ? { contextSchema } : {} }],
      },
      { index: 1, nodes: [{ nodeId: 'n_agent', type: 'core.agent', activity: 'interpreter.core_agent', config: {} }] },
    ],
    policyBindings: { contextSchemaRefs: [{ nodeId: 'n_trigger', schemaId: 'schema-1', versionNumber: 1, versionId: 'v1' }] },
    checksum: 'abc',
  };
}

const FROZEN_V1 = { type: 'object', additionalProperties: false, properties: { encounter: { type: 'object' } } };

describe('triggerContextBinding', () => {
  it('reads the schema id and the follow-latest flag off the compiled trigger node', () => {
    expect(triggerContextBinding(compiled({ contextSchemaId: 'schema-1', resolved: FROZEN_V1, followsLatest: true }))).toEqual({
      followsLatest: true,
      schemaId: 'schema-1',
    });
  });

  it('reads an absent flag as PINNED — an artifact compiled before the field existed is not "unknown"', () => {
    expect(triggerContextBinding(compiled({ contextSchemaId: 'schema-1', versionNumber: 1, resolved: FROZEN_V1 }))).toEqual({
      followsLatest: false,
      schemaId: 'schema-1',
    });
  });

  it('answers a null schema id for an inline or unbound trigger, and for bytes that are not a compiled config', () => {
    expect(triggerContextBinding(compiled({ inline: FROZEN_V1 }))).toEqual({ followsLatest: false, schemaId: null });
    expect(triggerContextBinding(compiled(undefined))).toEqual({ followsLatest: false, schemaId: null });
    expect(triggerContextBinding(null)).toEqual({ followsLatest: false, schemaId: null });
    expect(triggerContextBinding('not a config')).toEqual({ followsLatest: false, schemaId: null });
  });
});

describe('effectiveTriggerConfig — a PINNED trigger is never rewritten', () => {
  const pinned = compiled({ contextSchemaId: 'schema-1', versionNumber: 1, resolved: FROZEN_V1 });

  it('returns the compiled bytes UNCHANGED, by identity, even when a newer pin exists', () => {
    const result = effectiveTriggerConfig(pinned, { versionNumber: 4, definition: definition([{ key: 'encounter' }, { key: 'referral' }]) });

    expect(result.rewritten).toBe(false);
    expect(result.config).toBe(pinned);
    expect(result.effectiveVersionNumber).toBeNull();
  });

  it('returns the compiled bytes unchanged when there is no pin to follow', () => {
    expect(effectiveTriggerConfig(pinned, null).config).toBe(pinned);
  });
});

describe('effectiveTriggerConfig — a FOLLOW-LATEST trigger takes the tenant pin at dispatch', () => {
  const latest = compiled({ contextSchemaId: 'schema-1', resolved: FROZEN_V1, followsLatest: true });

  it("replaces `resolved` with the pin's derived payload schema and stamps the effective version", () => {
    const result = effectiveTriggerConfig(latest, { versionNumber: 4, definition: definition([{ key: 'encounter' }, { key: 'referral' }]) });

    expect(result.rewritten).toBe(true);
    expect(result.effectiveVersionNumber).toBe(4);

    const trigger = (result.config as { stages: Array<{ nodes: Array<{ nodeId: string; config: Record<string, unknown> }> }> }).stages
      .flatMap((stage) => stage.nodes)
      .find((node) => node.nodeId === 'n_trigger')!;
    const contextSchema = trigger.config.contextSchema as Record<string, unknown>;

    expect(Object.keys((contextSchema.resolved as { properties: Record<string, unknown> }).properties)).toEqual(['encounter', 'referral']);
    expect(contextSchema.effectiveVersionNumber).toBe(4);
    expect(contextSchema.followsLatest).toBe(true);
    // The authored reference is what a re-publish re-resolves — it is never rewritten.
    expect(contextSchema.contextSchemaId).toBe('schema-1');
  });

  it('re-derives userIdentity and openBindings from the SAME pin, so all three facts describe one version', () => {
    const result = effectiveTriggerConfig(latest, {
      versionNumber: 4,
      definition: definition([{ key: 'encounter', identity: 'doctor_id', department: 'department_code' }]),
    });

    const trigger = (result.config as { stages: Array<{ nodes: Array<{ nodeId: string; config: Record<string, unknown> }> }> }).stages
      .flatMap((stage) => stage.nodes)
      .find((node) => node.nodeId === 'n_trigger')!;
    const contextSchema = trigger.config.contextSchema as Record<string, unknown>;

    expect(contextSchema.userIdentity).toEqual({ kindKey: 'encounter', field: 'doctor_id' });
    expect(contextSchema.openBindings).toMatchObject({
      userIdentity: { kindKey: 'encounter', field: 'doctor_id' },
      department: { kindKey: 'encounter', field: 'department_code', by: 'code' },
    });
  });

  it('DROPS a stale userIdentity/openBindings the artifact froze when the pin declares none', () => {
    const withMarkers = compiled({
      contextSchemaId: 'schema-1',
      resolved: FROZEN_V1,
      followsLatest: true,
      userIdentity: { kindKey: 'encounter', field: 'doctor_id' },
      openBindings: { userIdentity: { kindKey: 'encounter', field: 'doctor_id' } },
    });

    const result = effectiveTriggerConfig(withMarkers, { versionNumber: 4, definition: definition([{ key: 'encounter' }]) });
    const trigger = (result.config as { stages: Array<{ nodes: Array<{ nodeId: string; config: Record<string, unknown> }> }> }).stages
      .flatMap((stage) => stage.nodes)
      .find((node) => node.nodeId === 'n_trigger')!;
    const contextSchema = trigger.config.contextSchema as Record<string, unknown>;

    expect(contextSchema).not.toHaveProperty('userIdentity');
    expect(contextSchema).not.toHaveProperty('openBindings');
  });

  it('leaves the compiled bytes alone when the pin cannot be resolved — a dispatch never fails on this', () => {
    const result = effectiveTriggerConfig(latest, null);

    expect(result.rewritten).toBe(false);
    expect(result.config).toBe(latest);
  });

  it('touches nothing but the trigger node', () => {
    const result = effectiveTriggerConfig(latest, { versionNumber: 4, definition: definition([{ key: 'encounter' }]) });
    const view = result.config as { stages: Array<{ nodes: Array<{ nodeId: string }> }>; policyBindings: unknown; checksum: string };

    expect(view.stages[1]).toEqual((latest as typeof view).stages[1]);
    expect(view.policyBindings).toEqual((latest as typeof view).policyBindings);
    expect(view.checksum).toBe('abc');
  });
});

describe('effectiveTriggerConfig — the schema the caller is measured against', () => {
  it('reports the effective resolved schema so ONE derivation serves both the pre-dispatch check and the run', () => {
    const latest = compiled({ contextSchemaId: 'schema-1', resolved: FROZEN_V1, followsLatest: true });
    const result = effectiveTriggerConfig(latest, { versionNumber: 4, definition: definition([{ key: 'encounter' }, { key: 'referral' }]) });

    expect(Object.keys((result.resolved as { properties: Record<string, unknown> }).properties)).toEqual(['encounter', 'referral']);
  });

  it('reports the FROZEN schema for a pinned trigger', () => {
    const pinned = compiled({ contextSchemaId: 'schema-1', versionNumber: 1, resolved: FROZEN_V1 });

    expect(effectiveTriggerConfig(pinned, { versionNumber: 4, definition: definition([{ key: 'referral' }]) }).resolved).toEqual(FROZEN_V1);
  });

  it('reports a null resolved schema when the trigger froze none — the caller has nothing to check against', () => {
    expect(effectiveTriggerConfig(compiled(undefined), null).resolved).toBeNull();
  });
});
