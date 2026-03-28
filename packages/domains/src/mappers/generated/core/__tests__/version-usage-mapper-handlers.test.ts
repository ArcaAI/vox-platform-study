import { describe, it, expect } from 'vitest';
import { ContextItemVersionEntityMapper } from '../ContextItemVersionEntityMapper';
import { PromptVersionEntityMapper } from '../PromptVersionEntityMapper';
import { DnaWritingStyleVersionEntityMapper } from '../DnaWritingStyleVersionEntityMapper';
import { DnaUsageRecordEntityMapper } from '../DnaUsageRecordEntityMapper';
import { PromptUsageRecordEntityMapper } from '../PromptUsageRecordEntityMapper';
import { ContextItemVersionEntity } from '../../../../entities/generated/core/ContextItemVersionEntity';
import { PromptVersionEntity } from '../../../../entities/generated/core/PromptVersionEntity';
import { DnaWritingStyleVersionEntity } from '../../../../entities/generated/core/DnaWritingStyleVersionEntity';
import { DnaUsageRecordEntity } from '../../../../entities/generated/core/DnaUsageRecordEntity';
import { PromptUsageRecordEntity } from '../../../../entities/generated/core/PromptUsageRecordEntity';

const FIELDS_NOT_IN_PRISMA = ['createdBy', 'updatedBy', 'updatedAt', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'] as const;

function createPromptVersionEntity(overrides: Partial<ConstructorParameters<typeof PromptVersionEntity>[0]> = {}) {
  return new PromptVersionEntity({
    id: overrides.id ?? 'pv-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    promptTemplateId: overrides.promptTemplateId ?? 'pt-1',
    versionNumber: overrides.versionNumber ?? 1,
    content: overrides.content ?? 'Test content',
    variables: overrides.variables ?? null,
    changeReason: overrides.changeReason ?? 'Initial',
    changedBy: overrides.changedBy ?? 'user-1',
    createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-18T10:00:00Z'),
    createdBy: overrides.createdBy ?? 'user-1',
    updatedBy: overrides.updatedBy ?? 'user-1',
  });
}

describe('Version/Usage Mapper Handlers — exclude fields not in Prisma schema', () => {
  describe('ContextItemVersionEntityMapper', () => {
    function createContextItemVersionEntity(overrides: Partial<ConstructorParameters<typeof ContextItemVersionEntity>[0]> = {}) {
      return new ContextItemVersionEntity({
        id: overrides.id ?? 'civ-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        contextItemId: overrides.contextItemId ?? 'ci-1',
        versionNumber: overrides.versionNumber ?? 1,
        content: overrides.content ?? 'Test content',
        contentDiff: overrides.contentDiff ?? null,
        changeReason: overrides.changeReason ?? 'user_edit',
        changeSummary: overrides.changeSummary ?? 'Initial version',
        changedBy: overrides.changedBy ?? 'user-1',
        changeSource: overrides.changeSource ?? 'manual',
        fieldChanges: overrides.fieldChanges ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-02-18T10:00:00Z'),
        createdBy: overrides.createdBy ?? 'user-1',
        updatedBy: overrides.updatedBy ?? 'user-1',
      });
    }

    it('should exclude fields not in Prisma schema from toPersistence output', () => {
      const entity = createContextItemVersionEntity();
      const mapper = new ContextItemVersionEntityMapper();
      const result = mapper.toPersistence(entity);

      for (const field of FIELDS_NOT_IN_PRISMA) {
        expect(result).not.toHaveProperty(field);
      }
      expect(result.id).toBe('civ-1');
      expect(result.contextItemId).toBe('ci-1');
      expect(result.content).toBe('Test content');
    });

    it('should exclude fields not in Prisma schema from toPersistenceChanges output', () => {
      const entity = createContextItemVersionEntity();
      entity.content = 'Modified content';
      const mapper = new ContextItemVersionEntityMapper();
      const result = mapper.toPersistenceChanges(entity);

      for (const field of FIELDS_NOT_IN_PRISMA) {
        expect(result).not.toHaveProperty(field);
      }
    });

    it('toDomainEntity round-trip should preserve data integrity', () => {
      const entity = createContextItemVersionEntity({
        id: 'civ-rt',
        versionNumber: 3,
        content: 'Round-trip content',
      });

      const mapper = new ContextItemVersionEntityMapper();
      const persisted = mapper.toPersistence(entity);
      const restored = mapper.toDomainEntity(persisted);

      expect(restored.id).toBe('civ-rt');
      expect(restored.versionNumber).toBe(3);
      expect(restored.content).toBe('Round-trip content');
      expect(restored.contextItemId).toBe('ci-1');
    });
  });

  describe('PromptVersionEntityMapper', () => {
    it('should exclude createdBy, updatedBy, updatedAt from toPersistence output', () => {
      const entity = createPromptVersionEntity();
      const mapper = new PromptVersionEntityMapper();
      const result = mapper.toPersistence(entity);

      for (const field of FIELDS_NOT_IN_PRISMA) {
        expect(result).not.toHaveProperty(field);
      }
      expect(result.id).toBe('pv-1');
      expect(result.tenantId).toBe('tenant-1');
      expect(result.content).toBe('Test content');
      expect(result.createdAt).toBeDefined();
    });

    it('should exclude createdBy, updatedBy, updatedAt from toPersistenceChanges output', () => {
      const entity = createPromptVersionEntity();
      entity.content = 'Modified content';
      const mapper = new PromptVersionEntityMapper();
      const result = mapper.toPersistenceChanges(entity);

      for (const field of FIELDS_NOT_IN_PRISMA) {
        expect(result).not.toHaveProperty(field);
      }
    });

    it('should preserve all Prisma-valid fields', () => {
      const entity = createPromptVersionEntity({
        id: 'pv-2',
        versionNumber: 3,
        content: 'Updated content',
        variables: { format: 'SOAP' },
        changeReason: 'Bug fix',
        changedBy: 'user-2',
      });

      const mapper = new PromptVersionEntityMapper();
      const result = mapper.toPersistence(entity);

      expect(result.promptTemplateId).toBe('pt-1');
      expect(result.versionNumber).toBe(3);
      expect(result.changeReason).toBe('Bug fix');
      expect(result.changedBy).toBe('user-2');
    });

    it('toDomainEntity round-trip should preserve data integrity', () => {
      const entity = createPromptVersionEntity({
        id: 'pv-rt',
        versionNumber: 5,
        content: 'Round-trip content',
        variables: { key: 'value' },
      });

      const mapper = new PromptVersionEntityMapper();
      const persisted = mapper.toPersistence(entity);
      const restored = mapper.toDomainEntity(persisted);

      expect(restored.id).toBe('pv-rt');
      expect(restored.versionNumber).toBe(5);
      expect(restored.content).toBe('Round-trip content');
      expect(restored.promptTemplateId).toBe('pt-1');
    });
  });

  describe('DnaWritingStyleVersionEntityMapper', () => {
    const createDnaVersionEntity = (overrides: Partial<ConstructorParameters<typeof DnaWritingStyleVersionEntity>[0]> = {}) =>
      new DnaWritingStyleVersionEntity({
        id: overrides.id ?? 'dv-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        dnaReportId: overrides.dnaReportId ?? 'dr-1',
        versionNumber: overrides.versionNumber ?? 1,
        reportData: overrides.reportData ?? { formality: 'high' },
        styleText: overrides.styleText ?? 'Formal tone',
        changeReason: overrides.changeReason ?? 'Initial',
        changedBy: overrides.changedBy ?? 'user-1',
        createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-02-18T10:00:00Z'),
        createdBy: overrides.createdBy ?? 'user-1',
        updatedBy: overrides.updatedBy ?? 'user-1',
      });

    it('should exclude createdBy, updatedBy, updatedAt from toPersistence output', () => {
      const entity = createDnaVersionEntity();
      const mapper = new DnaWritingStyleVersionEntityMapper();
      const result = mapper.toPersistence(entity);

      for (const field of FIELDS_NOT_IN_PRISMA) {
        expect(result).not.toHaveProperty(field);
      }
      expect(result.id).toBe('dv-1');
      expect(result.tenantId).toBe('tenant-1');
      expect(result.reportData).toEqual({ formality: 'high' });
      expect(result.createdAt).toBeDefined();
    });

    it('should exclude createdBy, updatedBy, updatedAt from toPersistenceChanges output', () => {
      const entity = createDnaVersionEntity();
      entity.styleText = 'Modified tone';
      const mapper = new DnaWritingStyleVersionEntityMapper();
      const result = mapper.toPersistenceChanges(entity);

      for (const field of FIELDS_NOT_IN_PRISMA) {
        expect(result).not.toHaveProperty(field);
      }
    });

    it('toDomainEntity round-trip should preserve data integrity', () => {
      const entity = createDnaVersionEntity({ id: 'dv-rt', versionNumber: 3 });
      const mapper = new DnaWritingStyleVersionEntityMapper();
      const persisted = mapper.toPersistence(entity);
      const restored = mapper.toDomainEntity(persisted);

      expect(restored.id).toBe('dv-rt');
      expect(restored.versionNumber).toBe(3);
      expect(restored.dnaReportId).toBe('dr-1');
    });
  });

  describe('DnaUsageRecordEntityMapper', () => {
    const createDnaUsageEntity = (overrides: Partial<ConstructorParameters<typeof DnaUsageRecordEntity>[0]> = {}) =>
      new DnaUsageRecordEntity({
        id: overrides.id ?? 'du-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        doctorId: overrides.doctorId ?? 'doc-1',
        dnaReportId: overrides.dnaReportId ?? 'dr-1',
        dnaVersionNumber: overrides.dnaVersionNumber ?? 1,
        consultationId: overrides.consultationId ?? 'consult-1',
        departmentId: overrides.departmentId ?? 'dept-1',
        createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-02-18T10:00:00Z'),
        createdBy: overrides.createdBy ?? 'user-1',
        updatedBy: overrides.updatedBy ?? 'user-1',
      });

    it('should exclude createdBy, updatedBy, updatedAt from toPersistence output', () => {
      const entity = createDnaUsageEntity();
      const mapper = new DnaUsageRecordEntityMapper();
      const result = mapper.toPersistence(entity);

      for (const field of FIELDS_NOT_IN_PRISMA) {
        expect(result).not.toHaveProperty(field);
      }
      expect(result.id).toBe('du-1');
      expect(result.tenantId).toBe('tenant-1');
      expect(result.doctorId).toBe('doc-1');
      expect(result.createdAt).toBeDefined();
    });

    it('should exclude createdBy, updatedBy, updatedAt from toPersistenceChanges output', () => {
      const entity = createDnaUsageEntity();
      entity.consultationId = 'consult-changed';
      const mapper = new DnaUsageRecordEntityMapper();
      const result = mapper.toPersistenceChanges(entity);

      for (const field of FIELDS_NOT_IN_PRISMA) {
        expect(result).not.toHaveProperty(field);
      }
    });

    it('toDomainEntity round-trip should preserve data integrity', () => {
      const entity = createDnaUsageEntity({ id: 'du-rt', dnaVersionNumber: 7 });
      const mapper = new DnaUsageRecordEntityMapper();
      const persisted = mapper.toPersistence(entity);
      const restored = mapper.toDomainEntity(persisted);

      expect(restored.id).toBe('du-rt');
      expect(restored.dnaVersionNumber).toBe(7);
      expect(restored.doctorId).toBe('doc-1');
    });
  });

  describe('PromptUsageRecordEntityMapper', () => {
    const createPromptUsageEntity = (overrides: Partial<ConstructorParameters<typeof PromptUsageRecordEntity>[0]> = {}) =>
      new PromptUsageRecordEntity({
        id: overrides.id ?? 'pu-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        promptTemplateId: overrides.promptTemplateId ?? 'pt-1',
        promptVersionNumber: overrides.promptVersionNumber ?? 1,
        consultationId: overrides.consultationId ?? 'consult-1',
        doctorId: overrides.doctorId ?? 'doc-1',
        departmentId: overrides.departmentId ?? 'dept-1',
        createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-02-18T10:00:00Z'),
        createdBy: overrides.createdBy ?? 'user-1',
        updatedBy: overrides.updatedBy ?? 'user-1',
      });

    it('should exclude createdBy, updatedBy, updatedAt from toPersistence output', () => {
      const entity = createPromptUsageEntity();
      const mapper = new PromptUsageRecordEntityMapper();
      const result = mapper.toPersistence(entity);

      for (const field of FIELDS_NOT_IN_PRISMA) {
        expect(result).not.toHaveProperty(field);
      }
      expect(result.id).toBe('pu-1');
      expect(result.tenantId).toBe('tenant-1');
      expect(result.promptTemplateId).toBe('pt-1');
      expect(result.createdAt).toBeDefined();
    });

    it('should exclude createdBy, updatedBy, updatedAt from toPersistenceChanges output', () => {
      const entity = createPromptUsageEntity();
      entity.consultationId = 'consult-changed';
      const mapper = new PromptUsageRecordEntityMapper();
      const result = mapper.toPersistenceChanges(entity);

      for (const field of FIELDS_NOT_IN_PRISMA) {
        expect(result).not.toHaveProperty(field);
      }
    });

    it('toDomainEntity round-trip should preserve data integrity', () => {
      const entity = createPromptUsageEntity({ id: 'pu-rt', promptVersionNumber: 4 });
      const mapper = new PromptUsageRecordEntityMapper();
      const persisted = mapper.toPersistence(entity);
      const restored = mapper.toDomainEntity(persisted);

      expect(restored.id).toBe('pu-rt');
      expect(restored.promptVersionNumber).toBe(4);
      expect(restored.promptTemplateId).toBe('pt-1');
    });
  });
});
