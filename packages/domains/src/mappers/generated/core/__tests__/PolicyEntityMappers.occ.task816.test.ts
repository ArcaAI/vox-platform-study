/**
 * TASK-816 Phase 2 / D-23 — the two policy mappers must strip the OCC token.
 *
 * `HarnessPolicy` and `PipelinePolicy` are both OCC-WRITTEN models: their services call
 * `repository.updateWithVersion(...)` on versioned PATCH routes (`harness-policy.service.ts:705`,
 * `pipeline-policy.service.ts:206,338`). `03-domain-layer.md` §Adding a New Domain Model makes the
 * mapper-level strip mandatory for exactly that class of model — "the mapper MUST carry
 * `FIELDS_NOT_WRITABLE = ['version']` + `stripNonWritableFields` if the model is OCC-written".
 * Neither mapper carried it.
 *
 * It is not exploitable TODAY, and that is the point: `Repository.updateWithVersion` destructures
 * `version` out of `changes` defensively (`packages/domains/src/common/repository.ts:216-219`), and
 * its own comment calls that "defense in depth ON TOP OF the mapper `$toPersistence` handler" — a
 * second layer describing itself as second while the first was missing. Any write path that does
 * not go through `updateWithVersion` (a plain `update`, a future bulk path) would leak `_version`
 * straight into a Prisma update and silently break optimistic concurrency for these two models.
 *
 * These tests pin the mapper layer directly, so the guarantee survives a change to the repository.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { HarnessPolicyEntityMapper } from '../HarnessPolicyEntityMapper';
import { PipelinePolicyEntityMapper } from '../PipelinePolicyEntityMapper';
import { HarnessPolicy } from '../../../../models/generated/core/HarnessPolicyModel';
import { PipelinePolicy } from '../../../../models/generated/core/PipelinePolicyModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';
import { PipelinePolicyScope } from '../../../../enums/generated/PipelinePolicyScope';

const auditFields = {
  resourceStatus: ResourceStatusType.ENABLED,
  resourceStatusUpdatedAt: null,
  resourceStatusUpdatedBy: null,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  metaData: null,
};

const harnessRow = (version = 7): HarnessPolicy =>
  new HarnessPolicy({
    id: 'hp-1',
    tenantId: 't-1',
    entityFaithfulnessThreshold: 1,
    coverageThreshold: 0.8,
    citationPresenceThreshold: 1,
    numericDoseThreshold: 1,
    groundednessThreshold: 0.8,
    safetyEnabled: true,
    phiEnabled: true,
    phiFailClosed: true,
    textProvider: null,
    textModel: null,
    maxRegen: 2,
    gateSlaSeconds: 86_400,
    gateEscalationSeconds: 43_200,
    toolAllowlist: null,
    optimisticDeliveryEnabled: null,
    atomicFactEnabled: null,
    retrievalEnabled: null,
    warmStartEnabled: null,
    nerPriorsEnabled: null,
    maxEditReruns: null,
    regenFeedbackEnabled: null,
    mcpToolsEnabled: null,
    version,
    ...auditFields,
  } as unknown as HarnessPolicy);

const pipelineRow = (version = 5): PipelinePolicy =>
  new PipelinePolicy({
    id: 'pp-1',
    tenantId: 't-1',
    scope: PipelinePolicyScope.TENANT,
    scopeId: null,
    autoSummaryEnabled: true,
    autoNerEnabled: null,
    harnessEnabled: null,
    dnaStyleEnabled: null,
    dnaRedactionEnabled: null,
    version,
    ...auditFields,
  } as unknown as PipelinePolicy);

describe('D-23 — HarnessPolicyEntityMapper strips the OCC token from every write path', () => {
  const mapper = new HarnessPolicyEntityMapper();

  it('still carries `version` on the READ path (the DB owns it, the entity must see it)', () => {
    expect(mapper.toDomainEntity(harnessRow(7)).version).toBe(7);
  });

  it('toPersistence (full insert) does not write `version`', () => {
    const persisted = mapper.toPersistence(mapper.toDomainEntity(harnessRow(1)));
    expect(persisted).not.toHaveProperty('version');
    // …while still carrying the row's real columns, so the strip is surgical.
    expect(persisted.coverageThreshold).toBe(0.8);
  });

  it('toPersistenceChanges never contains `version`, even when the change set holds it', () => {
    const entity = mapper.toDomainEntity(harnessRow());
    (entity as any)._changes = { coverageThreshold: 0.95, version: 99 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).toMatchObject({ coverageThreshold: 0.95 });
  });
});

describe('D-23 — PipelinePolicyEntityMapper strips the OCC token from every write path', () => {
  const mapper = new PipelinePolicyEntityMapper();

  it('still carries `version` on the READ path', () => {
    expect(mapper.toDomainEntity(pipelineRow(5)).version).toBe(5);
  });

  it('toPersistence (full insert) does not write `version`', () => {
    const persisted = mapper.toPersistence(mapper.toDomainEntity(pipelineRow(1)));
    expect(persisted).not.toHaveProperty('version');
    expect(persisted.autoSummaryEnabled).toBe(true);
    // The scope discriminator is what makes this table polymorphic — it must survive the strip.
    expect(persisted.scope).toBe(PipelinePolicyScope.TENANT);
  });

  it('toPersistenceChanges never contains `version`, even when the change set holds it', () => {
    const entity = mapper.toDomainEntity(pipelineRow());
    (entity as any)._changes = { autoSummaryEnabled: false, version: 42 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).toMatchObject({ autoSummaryEnabled: false });
  });
});
