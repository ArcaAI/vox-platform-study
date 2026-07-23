/**
 * DepartmentAgentEntityMapper — round-trip tests (TASK-546).
 *
 * DepartmentAgent is OCC-written, so `_version` MUST be stripped from every
 * write path. Mirrors the AiTaskDefaultEntityMapper suite.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { DepartmentAgentEntityMapper } from '../DepartmentAgentEntityMapper';
import { DepartmentAgent } from '../../../../models/generated/core/DepartmentAgentModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';
import { DepartmentAgentDnaPolicy } from '../../../../enums/generated/DepartmentAgentDnaPolicy';

const sampleRow = (overrides: Partial<DepartmentAgent> = {}): DepartmentAgent =>
  new DepartmentAgent({
    id: 'da-1',
    tenantId: 't-1',
    departmentId: 'dept-1',
    name: 'Cardiology SOAP',
    slug: 'cardiology-soap',
    description: 'Default cardiology agent',
    promptTemplateId: 'tpl-1',
    pinnedVersionNumber: 3,
    dnaStylePolicy: DepartmentAgentDnaPolicy.INHERIT,
    harnessOverrides: { maxRegen: 2, nested: { list: [1, 2] } },
    goldenSetId: null,
    isDefault: true,
    sourceAgentTemplateSlug: null,
    templateLocked: false,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 5,
    metaData: null,
    tags: ['pinned'],
    ...overrides,
  } as DepartmentAgent);

describe('DepartmentAgentEntityMapper', () => {
  const mapper = new DepartmentAgentEntityMapper();

  it('toDomainEntity carries the core fields + `version` from the row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.tenantId).toBe('t-1');
    expect(entity.departmentId).toBe('dept-1');
    expect(entity.slug).toBe('cardiology-soap');
    expect(entity.promptTemplateId).toBe('tpl-1');
    expect(entity.pinnedVersionNumber).toBe(3);
    expect(entity.dnaStylePolicy).toBe(DepartmentAgentDnaPolicy.INHERIT);
    expect(entity.isDefault).toBe(true);
    expect(entity.version).toBe(5);
  });

  it('round-trips `harnessOverrides` (JsonB) intact through entity → persistence', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    const persisted = mapper.toPersistence(entity);
    expect(persisted.harnessOverrides).toEqual({ maxRegen: 2, nested: { list: [1, 2] } });
    expect(persisted.promptTemplateId).toBe('tpl-1');
    expect(persisted.pinnedVersionNumber).toBe(3);
  });

  it('toPersistence (full insert path) does not write `version`', () => {
    const entity = mapper.toDomainEntity(sampleRow({ version: 1 } as any));
    const persisted = mapper.toPersistence(entity);
    expect(persisted).not.toHaveProperty('version');
  });

  it('toPersistenceChanges never contains `version`, even if the change set has it', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    (entity as any)._changes = { pinnedVersionNumber: 4, version: 99 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).toMatchObject({ pinnedVersionNumber: 4 });
  });
});
