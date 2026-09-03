/**
 * `DocumentTemplate*` mapper round-trip tests.
 *
 * Mirrors the `TenantAllowedOriginEntityMapper` / `AiTaskDefaultEntityMapper`
 * suite, and exists because D-23 recorded two OCC-written models
 * (`HarnessPolicy`, `PipelinePolicy`) whose mappers are MISSING the
 * `FIELDS_NOT_WRITABLE = ['version']` guard. A missing strip does not fail
 * loudly: the compare-and-set keeps returning rows, it just stops meaning
 * anything. These assertions are the only thing that makes that visible.
 *
 * The VERSION mapper additionally needs the double strip
 * (`ConsultationContextSchemaVersionEntityMapper`): the immutable table has no
 * `updatedAt`/`updatedBy`/`resourceStatus*` columns at all, so leaving them on
 * the persistence object is a Prisma validation error on every insert.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { DocumentTemplateEntityMapper } from '../DocumentTemplateEntityMapper';
import { DocumentTemplateVersionEntityMapper } from '../DocumentTemplateVersionEntityMapper';
import { DocumentTemplate } from '../../../../models/generated/core/DocumentTemplateModel';
import { DocumentTemplateVersion } from '../../../../models/generated/core/DocumentTemplateVersionModel';
import { DocumentTemplateStatus } from '../../../../enums/generated/DocumentTemplateStatus';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';

const templateRow = (overrides: Partial<DocumentTemplate> = {}): DocumentTemplate =>
  new DocumentTemplate({
    id: 'dt-1',
    tenantId: 't-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    status: DocumentTemplateStatus.PUBLISHED,
    pinnedVersionNumber: 2,
    isDefault: true,
    sourceTemplateSlug: null,
    templateLocked: false,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 3,
    metaData: null,
    ...overrides,
  } as DocumentTemplate);

const versionRow = (overrides: Partial<DocumentTemplateVersion> = {}): DocumentTemplateVersion =>
  new DocumentTemplateVersion({
    id: 'dtv-1',
    tenantId: 't-1',
    templateId: 'dt-1',
    versionNumber: 2,
    shape: { schemaVersion: '1.0', title: 'Discharge Summary', sections: [] } as any,
    compiled: { compilerVersion: '1.0.0' } as any,
    compilerVersion: '1.0.0',
    checksum: 'abc123',
    changeReason: 'added a follow-up section',
    createdBy: null,
    createdAt: new Date(),
    version: 1,
    metaData: null,
    ...overrides,
  } as DocumentTemplateVersion);

describe('DocumentTemplateEntityMapper (mutable head, OCC-written)', () => {
  const mapper = new DocumentTemplateEntityMapper();

  it('toDomainEntity carries the core fields + `version` from the database row', () => {
    const entity = mapper.toDomainEntity(templateRow());
    expect(entity.tenantId).toBe('t-1');
    expect(entity.slug).toBe('discharge_summary');
    expect(entity.pinnedVersionNumber).toBe(2);
    expect(entity.isDefault).toBe(true);
    expect(entity.version).toBe(3);
  });

  it('round-trips core fields through entity → persistence', () => {
    const persisted = mapper.toPersistence(mapper.toDomainEntity(templateRow()));
    expect(persisted.slug).toBe('discharge_summary');
    expect(persisted.name).toBe('Discharge Summary');
    expect(persisted.tenantId).toBe('t-1');
    expect(persisted.status).toBe(DocumentTemplateStatus.PUBLISHED);
  });

  it('toPersistence (full insert path) does not write `version`', () => {
    const persisted = mapper.toPersistence(mapper.toDomainEntity(templateRow({ version: 1 } as any)));
    expect(persisted).not.toHaveProperty('version');
  });

  it('toPersistenceChanges (OCC update path) does not write `version`', () => {
    const entity = mapper.toDomainEntity(templateRow());
    // A realistic publish: the pin moves and the status flips.
    entity.pinnedVersionNumber = 3;
    entity.status = DocumentTemplateStatus.APPROVED;
    const changes = mapper.toPersistenceChanges(entity);
    expect(changes.pinnedVersionNumber).toBe(3);
    expect(changes.status).toBe(DocumentTemplateStatus.APPROVED);
    // The whole point: `updateWithVersion` owns `_version`. If the mapper
    // leaks it into the update payload, the compare-and-set is decorative.
    expect(changes).not.toHaveProperty('version');
  });
});

describe('DocumentTemplateVersionEntityMapper (immutable snapshot)', () => {
  const mapper = new DocumentTemplateVersionEntityMapper();

  it('round-trips the shape, the compiled artifacts and the checksum', () => {
    const entity = mapper.toDomainEntity(versionRow());
    expect(entity.templateId).toBe('dt-1');
    expect(entity.versionNumber).toBe(2);
    expect(entity.checksum).toBe('abc123');
    expect(entity.compilerVersion).toBe('1.0.0');
    expect((entity.shape as any).title).toBe('Discharge Summary');

    const persisted = mapper.toPersistence(entity);
    expect(persisted.shape).toEqual({ schemaVersion: '1.0', title: 'Discharge Summary', sections: [] });
    expect(persisted.compiled).toEqual({ compilerVersion: '1.0.0' });
    expect(persisted.checksum).toBe('abc123');
  });

  it('strips every column the immutable table does not have', () => {
    const persisted = mapper.toPersistence(mapper.toDomainEntity(versionRow()));
    for (const absent of ['updatedAt', 'updatedBy', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy']) {
      expect(persisted, `\`${absent}\` has no column on DocumentTemplateVersion — leaving it on the insert is a Prisma validation error`).not.toHaveProperty(
        absent,
      );
    }
  });

  it('does not write `version` on either path', () => {
    const entity = mapper.toDomainEntity(versionRow());
    expect(mapper.toPersistence(entity)).not.toHaveProperty('version');
    entity.changeReason = 'anything';
    expect(mapper.toPersistenceChanges(entity)).not.toHaveProperty('version');
  });
});
