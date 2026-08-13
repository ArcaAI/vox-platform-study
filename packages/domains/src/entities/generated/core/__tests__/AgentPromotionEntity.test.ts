/**
 * AgentPromotionEntity + AgentPromotionFactory unit tests — the
 * immutable, WORM record of one agent promotion between two tenants.
 *
 * The invariant that earns its own suite is `tenantId === toTenantId`: the
 * promotion record is the TARGET tenant's lineage, and the tenant-scope Prisma
 * extension filters on `tenantId`. If the two columns could diverge, a row
 * would be readable by one tenant while claiming to describe another's agent.
 */
import { describe, it, expect } from 'vitest';
import { AgentPromotionFactory } from '../../../../factories/generated/core/AgentPromotionFactory';

const baseProps = {
  tenantId: 'tenant-target',
  fromTenantId: 'tenant-source',
  toTenantId: 'tenant-target',
  agentVersionId: 'srcver-1',
  sourceAgentId: 'srcagent-1',
  targetAgentId: 'tgtagent-1',
  configSnapshot: {
    role: 'PRIMARY',
    subscribedKinds: null,
    writeScope: null,
    goal: null,
    guardrailProfile: null,
    alwaysActions: null,
    neverActions: null,
  },
  checksum: 'a'.repeat(64),
};

describe('AgentPromotionFactory', () => {
  it('generates a UUIDv7 id and carries the promotion verbatim', () => {
    const promotion = AgentPromotionFactory.CreateAgentPromotion(baseProps);
    expect(promotion.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(promotion.fromTenantId).toBe('tenant-source');
    expect(promotion.toTenantId).toBe('tenant-target');
    expect(promotion.agentVersionId).toBe('srcver-1');
    expect(promotion.sourceAgentId).toBe('srcagent-1');
    expect(promotion.targetAgentId).toBe('tgtagent-1');
    expect(promotion.configSnapshot).toEqual(baseProps.configSnapshot);
    expect(promotion.checksum).toBe(baseProps.checksum);
  });

  it('defaults every optional attestation column to null', () => {
    const promotion = AgentPromotionFactory.CreateAgentPromotion(baseProps);
    expect(promotion.targetAgentVersionId).toBeNull();
    expect(promotion.evalRunId).toBeNull();
    expect(promotion.sourceEvalRunId).toBeNull();
    expect(promotion.warnings).toBeNull();
    expect(promotion.promotedBy).toBeNull();
  });

  it('defaults updatedBy to null (immutable row — never updated after insert)', () => {
    const promotion = AgentPromotionFactory.CreateAgentPromotion(baseProps);
    expect(promotion.updatedBy).toBeNull();
  });

  it('defaults tenantId to toTenantId when the caller omits it', () => {
    // The two can never disagree, so the factory derives rather than demands —
    // a caller cannot get it wrong by supplying only one.
    const promotion = AgentPromotionFactory.CreateAgentPromotion({
      ...baseProps,
      tenantId: undefined,
    });
    expect(promotion.tenantId).toBe('tenant-target');
  });
});

describe('AgentPromotionEntity.validate', () => {
  it('passes for a well-formed promotion', () => {
    const promotion = AgentPromotionFactory.CreateAgentPromotion(baseProps);
    expect(() => promotion.validate()).not.toThrow();
  });

  it('rejects a tenantId that is not the target tenant', () => {
    // The load-bearing invariant: the row is the TARGET's lineage and is read
    // under the target's tenant scope.
    const promotion = AgentPromotionFactory.CreateAgentPromotion({ ...baseProps, tenantId: 'tenant-source' });
    expect(() => promotion.validate()).toThrow(/tenantId must equal toTenantId/i);
  });

  it('rejects a promotion whose source and target tenants are the same', () => {
    // Promotion is a CROSS-tenant move. Same-tenant copying is `clone()`, which
    // has entirely different template semantics.
    const promotion = AgentPromotionFactory.CreateAgentPromotion({
      ...baseProps,
      fromTenantId: 'tenant-target',
    });
    expect(() => promotion.validate()).toThrow(/same tenant/i);
  });

  it('rejects a missing fromTenantId', () => {
    const promotion = AgentPromotionFactory.CreateAgentPromotion({ ...baseProps, fromTenantId: '' });
    expect(() => promotion.validate()).toThrow(/fromTenantId/i);
  });

  it('rejects a missing agentVersionId', () => {
    const promotion = AgentPromotionFactory.CreateAgentPromotion({ ...baseProps, agentVersionId: '' });
    expect(() => promotion.validate()).toThrow(/agentVersionId/i);
  });

  it('rejects a missing sourceAgentId', () => {
    const promotion = AgentPromotionFactory.CreateAgentPromotion({ ...baseProps, sourceAgentId: '' });
    expect(() => promotion.validate()).toThrow(/sourceAgentId/i);
  });

  it('rejects a missing targetAgentId', () => {
    const promotion = AgentPromotionFactory.CreateAgentPromotion({ ...baseProps, targetAgentId: '' });
    expect(() => promotion.validate()).toThrow(/targetAgentId/i);
  });

  it('rejects a configSnapshot that is not a JSON object', () => {
    const promotion = AgentPromotionFactory.CreateAgentPromotion({
      ...baseProps,
      configSnapshot: ['not', 'an', 'object'],
    });
    expect(() => promotion.validate()).toThrow(/configSnapshot/i);
  });

  it('rejects a missing checksum', () => {
    const promotion = AgentPromotionFactory.CreateAgentPromotion({ ...baseProps, checksum: '   ' });
    expect(() => promotion.validate()).toThrow(/checksum/i);
  });
});
