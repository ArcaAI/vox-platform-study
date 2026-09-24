/**
 * ModelResidencyPolicy entity/factory behavior (TASK-1005 §5.2)
 *
 * Locks the three things that are easy to get wrong on this model:
 *  - the factory generates a UUIDv7 id and applies defaults that MIRROR the
 *    Prisma column defaults (`class: ON_DEMAND`, `priority: 0`,
 *    `maxInstances: 1`) rather than leaving them undefined;
 *  - every setter routes through `setProperty`, so `repository.update`
 *    persists only `entity.changes`;
 *  - `validate()` enforces the structural invariants the database cannot:
 *    `service` is one of the fixed workload vocabulary, `class` is a real
 *    enum member, `idleTtlSeconds` is non-negative when set, `priority` is an
 *    integer, and `maxInstances` is at least 1.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { ModelResidencyPolicyFactory } from '../../../../factories/generated/core/ModelResidencyPolicyFactory';
import { ModelResidencyClass } from '../../../../enums/generated/ModelResidencyClass';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const create = (overrides: Record<string, unknown> = {}) =>
  ModelResidencyPolicyFactory.CreateModelResidencyPolicy({
    tenantId: '00000000-0000-0000-0000-000000000000',
    aiModelId: 'model-1',
    service: 'stt',
    ...overrides,
  } as any);

describe('ModelResidencyPolicyEntity', () => {
  it('factory generates a UUIDv7 id and starts with no tracked changes', () => {
    const entity = create();
    expect(entity.id).toMatch(UUID_V7);
    expect(entity.tenantId).toBe('00000000-0000-0000-0000-000000000000');
    expect(entity.aiModelId).toBe('model-1');
    expect(entity.service).toBe('stt');
    expect(entity.hasChanges).toBe(false);
  });

  it('factory defaults mirror the Prisma column defaults', () => {
    const entity = create();
    expect(entity.class).toBe(ModelResidencyClass.ON_DEMAND);
    expect(entity.priority).toBe(0);
    expect(entity.maxInstances).toBe(1);
    expect(entity.idleTtlSeconds).toBeNull();
    expect(entity.preferredDevice).toBeNull();
  });

  it('setters route through setProperty (change-tracked)', () => {
    const entity = create();
    entity.class = ModelResidencyClass.PINNED;
    entity.priority = 10;
    entity.idleTtlSeconds = 900;
    entity.maxInstances = 3;
    entity.preferredDevice = 'cuda:0';

    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toMatchObject({
      class: ModelResidencyClass.PINNED,
      priority: 10,
      idleTtlSeconds: 900,
      maxInstances: 3,
      preferredDevice: 'cuda:0',
    });
  });

  describe('validate()', () => {
    it('accepts a well-formed policy for every service in the fixed vocabulary', () => {
      for (const service of ['stt', 'stt-worker', 'nlp', 'lm-studio', 'text']) {
        expect(() => create({ service }).validate()).not.toThrow();
      }
    });

    it('rejects a policy with no model reference', () => {
      expect(() => create({ aiModelId: '' }).validate()).toThrow(/must name a model/i);
    });

    it('rejects an unknown service', () => {
      expect(() => create({ service: 'harness' }).validate()).toThrow(/unknown residency service/i);
    });

    it('rejects an unknown residency class', () => {
      expect(() => create({ class: 'BOGUS' as ModelResidencyClass }).validate()).toThrow(/unknown residency class/i);
    });

    it('rejects a negative idleTtlSeconds', () => {
      expect(() => create({ idleTtlSeconds: -1 }).validate()).toThrow(/idleTtlSeconds/);
    });

    it('accepts idleTtlSeconds of zero and null', () => {
      expect(() => create({ idleTtlSeconds: 0 }).validate()).not.toThrow();
      expect(() => create({ idleTtlSeconds: null }).validate()).not.toThrow();
    });

    it('rejects a non-integer priority', () => {
      expect(() => create({ priority: 1.5 }).validate()).toThrow(/priority/);
    });

    it('rejects maxInstances below 1', () => {
      expect(() => create({ maxInstances: 0 }).validate()).toThrow(/maxInstances/);
    });

    it('accepts the plain factory output unmodified', () => {
      expect(() => create().validate()).not.toThrow();
    });
  });
});
