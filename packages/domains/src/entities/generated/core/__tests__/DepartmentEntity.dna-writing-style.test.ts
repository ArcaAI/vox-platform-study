/**
 * DepartmentEntity.dnaWritingStylePromptId
 *
 * TDD verification that the per-department default DNA writing-style prompt slot
 * is exposed through the entity + factory layers, mirroring the existing prompt
 * config fields (preSummaryPromptId, etc.).
 */
import { describe, it, expect } from 'vitest';
import { DepartmentEntity } from '../DepartmentEntity';
import { DepartmentFactory } from '../../../../factories/generated/core/DepartmentFactory';

describe('DepartmentEntity — dnaWritingStylePromptId (TASK-387 #7)', () => {
  it('accepts dnaWritingStylePromptId in the constructor', () => {
    const entity = new DepartmentEntity({
      id: 'dept-001',
      tenantId: 'tenant-001',
      code: 'CARD',
      name: 'Cardiology',
      dnaWritingStylePromptId: 'prompt_dna_card',
      createdBy: 'user-001',
      updatedBy: 'user-001',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(entity.dnaWritingStylePromptId).toBe('prompt_dna_card');
  });

  it('defaults to undefined when not provided', () => {
    const entity = new DepartmentEntity({
      id: 'dept-002',
      tenantId: 'tenant-001',
      code: 'GEN',
      name: 'General Practice',
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(entity.dnaWritingStylePromptId).toBeUndefined();
  });

  it('tracks a change when set via the setter', () => {
    const entity = new DepartmentEntity({
      id: 'dept-003',
      tenantId: 'tenant-001',
      code: 'RAD',
      name: 'Radiology',
      dnaWritingStylePromptId: null,
      createdBy: 'user-001',
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    entity.dnaWritingStylePromptId = 'prompt_dna_rad';

    expect(entity.dnaWritingStylePromptId).toBe('prompt_dna_rad');
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toHaveProperty('dnaWritingStylePromptId', 'prompt_dna_rad');
  });

  it('accepts null (unset the default)', () => {
    const entity = new DepartmentEntity({
      id: 'dept-004',
      tenantId: 'tenant-001',
      code: 'LAB',
      name: 'Laboratory',
      dnaWritingStylePromptId: null,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(entity.dnaWritingStylePromptId).toBeNull();
  });
});

describe('DepartmentFactory — dnaWritingStylePromptId (TASK-387 #7)', () => {
  it('creates a department carrying the DNA writing-style prompt id', () => {
    const entity = DepartmentFactory.CreateDepartment({
      tenantId: 'tenant-001',
      code: 'ER',
      name: 'Emergency',
      dnaWritingStylePromptId: 'prompt_dna_er',
    });

    expect(entity.id).toBeDefined();
    expect(entity.dnaWritingStylePromptId).toBe('prompt_dna_er');
  });

  it('defaults dnaWritingStylePromptId to null when not provided', () => {
    const entity = DepartmentFactory.CreateDepartment({
      tenantId: 'tenant-001',
      code: 'GEN',
      name: 'General Practice',
    });

    expect(entity.dnaWritingStylePromptId).toBeNull();
  });
});
