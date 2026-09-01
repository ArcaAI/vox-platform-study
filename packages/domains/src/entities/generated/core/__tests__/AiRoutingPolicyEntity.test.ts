/**
 * AiRoutingPolicy entity/factory behavior (TASK-818 §3A.3).
 *
 * Locks the three things that are easy to get wrong on this model:
 *  - the factory generates a UUIDv7 id and applies the §3A.3/§3A.4 defaults
 *    (STRICT explicit-provider mode, PRIORITY strategy, DRAFT status,
 *    kill-switch OFF) rather than leaving them undefined;
 *  - every setter routes through `setProperty`, so `repository.update`
 *    persists only `entity.changes`;
 *  - `policyVersion` (the AUTHORED, supersede-only revision) and `_version`
 *    (the database-owned OCC counter) are INDEPENDENT. Conflating them is the
 *    specific defect this suite exists to prevent.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { AiRoutingPolicyFactory } from '../../../../factories/generated/core/AiRoutingPolicyFactory';
import { AiRoutingPolicyStatus } from '../../../../enums/generated/AiRoutingPolicyStatus';
import { AiRoutingStrategy } from '../../../../enums/generated/AiRoutingStrategy';
import { AiExplicitProviderMode } from '../../../../enums/generated/AiExplicitProviderMode';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const create = (overrides: Record<string, unknown> = {}) =>
  AiRoutingPolicyFactory.CreateAiRoutingPolicy({
    tenantId: 't-1',
    taskKey: 'text.finalize',
    candidatesJson: [{ rank: 0, weight: 100, connectionRef: 'vllm-inhouse', model: 'qwen3-32b-med' }],
    ...overrides,
  } as any);

describe('AiRoutingPolicyEntity', () => {
  it('factory generates a UUIDv7 id and starts with no tracked changes', () => {
    const entity = create();
    expect(entity.id).toMatch(UUID_V7);
    expect(entity.tenantId).toBe('t-1');
    expect(entity.hasChanges).toBe(false);
  });

  it('factory defaults match the §3A.3/§3A.4 platform posture', () => {
    const entity = create();
    // A policy is authored before it is served.
    expect(entity.status).toBe(AiRoutingPolicyStatus.DRAFT);
    expect(entity.strategy).toBe(AiRoutingStrategy.PRIORITY);
    // §3A.4 — a named provider that is down is an ERROR, never a silent
    // substitution. This default deliberately inverts the industry default.
    expect(entity.explicitProviderMode).toBe(AiExplicitProviderMode.STRICT);
    // Kill-switches default OFF.
    expect(entity.killSwitch).toBe(false);
    expect(entity.priority).toBe(0);
    // First DRAFT: no lineage yet, not activated.
    expect(entity.policyVersion).toBe(1);
    expect(entity.supersedesVersion).toBeNull();
    expect(entity.activatedAt).toBeNull();
    // Optional nested structures are absent, not invented.
    expect(entity.matchJson).toBeNull();
    expect(entity.fallbackJson).toBeNull();
    expect(entity.healthJson).toBeNull();
    expect(entity.affinityJson).toBeNull();
    expect(entity.maxConcurrentStreams).toBeNull();
  });

  it('setters route through setProperty (change-tracked)', () => {
    const entity = create();
    entity.status = AiRoutingPolicyStatus.ACTIVE;
    entity.strategy = AiRoutingStrategy.WEIGHTED;
    entity.killSwitch = true;
    entity.maxConcurrentStreams = 8;

    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toMatchObject({
      status: AiRoutingPolicyStatus.ACTIVE,
      strategy: AiRoutingStrategy.WEIGHTED,
      killSwitch: true,
      maxConcurrentStreams: 8,
    });
  });

  it('policyVersion and _version are independent counters', () => {
    const entity = create({ policyVersion: 6 });
    const occBefore = entity.version;

    // Authoring a new revision moves the AUTHORED version only. `_version` is
    // owned by the database and is bumped by `updateWithVersion`, never here.
    entity.policyVersion = 7;
    entity.supersedesVersion = 6;

    expect(entity.policyVersion).toBe(7);
    expect(entity.version).toBe(occBefore);
    expect(entity.changes).not.toHaveProperty('version');
    expect(entity.changes).toMatchObject({ policyVersion: 7, supersedesVersion: 6 });
  });

  it('validate() rejects a configuration that cannot route', () => {
    expect(() => create({ taskKey: '   ' }).validate()).toThrow(/task key/i);
    expect(() => create({ policyVersion: 0 }).validate()).toThrow(/policy version/i);
    // TASK-844 — the invariant moved with the grain. It used to be "at least
    // one entry in `candidatesJson`"; now the ROW is the candidate, so it is
    // "this configuration must name a model".
    expect(() => create({ candidatesJson: [] }).validate()).toThrow(/must name a model/i);
    expect(() => create().validate()).not.toThrow();
  });

  describe('TASK-844 — the provider-configuration binding', () => {
    it('accepts a row bound by the catalogue FK', () => {
      expect(() => create({ candidatesJson: null, modelId: 'model-1' }).validate()).not.toThrow();
    });

    it('accepts a row bound by a provider-side model id', () => {
      // An Azure deployment or a GGUF id the catalogue does not carry.
      expect(() => create({ candidatesJson: null, modelRef: 'gpt-4o-eu-prod' }).validate()).not.toThrow();
    });

    it('still accepts a pre-844 revision carrying only a candidate chain', () => {
      // Refusing these would make historical revisions unreadable rather than
      // merely deprecated.
      expect(() => create({ modelId: null, modelRef: null }).validate()).not.toThrow();
    });

    it('rejects a row that names nothing at all', () => {
      expect(() => create({ candidatesJson: null, modelId: null, modelRef: null }).validate()).toThrow(/must name a model/i);
    });

    it('never elects on construction — that is setDefault, in a transaction', () => {
      // A factory that defaulted `isDefault: true` would make every create race
      // the partial unique index.
      expect(create().isDefault).toBe(false);
      expect(create().enabled).toBe(true);
    });

    it('invents no residency class and assumes no BAA coverage', () => {
      // Both are read by the §3A.4 fallback gates; guessing `baaCovered: true`
      // for a candidate whose author did not say so is the silent PHI
      // redirection those gates exist to prevent.
      expect(create().residency).toBeNull();
      expect(create().baaCovered).toBeNull();
    });

    it('routes the new setters through setProperty so only changes persist', () => {
      const entity = create();
      entity.isDefault = true;
      entity.modelId = 'model-2';
      entity.enabled = false;
      expect(entity.changes).toMatchObject({ isDefault: true, modelId: 'model-2', enabled: false });
    });
  });
});
