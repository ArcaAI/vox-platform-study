/**
 * DepartmentEntity — Prompt Configuration Fields (GAP-3)
 *
 * TDD verification that the prompt config fields in the Department
 * schema are correctly exposed through the entity and factory layers.
 *
 * Fields under test:
 *   - defaultSummaryTemplate
 *   - preSummaryPromptId
 *   - newPatientPromptId
 *   - revisitPromptId
 *   - promptConfig
 */

import { describe, it, expect } from 'vitest';
import { DepartmentEntity } from '../DepartmentEntity';
import { DepartmentFactory } from '../../../../factories/generated/core/DepartmentFactory';

describe('DepartmentEntity — prompt config fields', () => {
  it('should accept all prompt config fields in constructor', () => {
    const entity = new DepartmentEntity({
      id: 'dept-001',
      tenantId: 'tenant-001',
      code: 'CARD',
      name: 'Cardiology',
      preSummaryPromptId: 'prompt_pre_summary_card',
      defaultSummaryTemplate: 'SOAP',
      newPatientPromptId: 'prompt_card_new',
      revisitPromptId: 'prompt_card_revisit',
      promptConfig: {
        contextVariables: { ecgResults: true },
        abbreviationDensity: 'medium',
      },
      createdBy: 'user-001',
      updatedBy: 'user-001',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(entity.preSummaryPromptId).toBe('prompt_pre_summary_card');
    expect(entity.defaultSummaryTemplate).toBe('SOAP');
    expect(entity.newPatientPromptId).toBe('prompt_card_new');
    expect(entity.revisitPromptId).toBe('prompt_card_revisit');
    expect(entity.promptConfig).toEqual({
      contextVariables: { ecgResults: true },
      abbreviationDensity: 'medium',
    });
  });

  it('should default prompt config fields to null/undefined when not provided', () => {
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

    expect(entity.preSummaryPromptId).toBeUndefined();
    expect(entity.defaultSummaryTemplate).toBeUndefined();
    expect(entity.newPatientPromptId).toBeUndefined();
    expect(entity.revisitPromptId).toBeUndefined();
    expect(entity.promptConfig).toBeUndefined();
  });

  it('should track changes when prompt config fields are modified via setters', () => {
    const entity = new DepartmentEntity({
      id: 'dept-003',
      tenantId: 'tenant-001',
      code: 'RAD',
      name: 'Radiology',
      preSummaryPromptId: null,
      defaultSummaryTemplate: null,
      createdBy: 'user-001',
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    entity.preSummaryPromptId = 'prompt_pre_summary_rad';
    entity.defaultSummaryTemplate = 'Radiology-Report';

    expect(entity.preSummaryPromptId).toBe('prompt_pre_summary_rad');
    expect(entity.defaultSummaryTemplate).toBe('Radiology-Report');
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toHaveProperty('preSummaryPromptId', 'prompt_pre_summary_rad');
    expect(entity.changes).toHaveProperty('defaultSummaryTemplate', 'Radiology-Report');
  });

  it('should accept null values for all prompt config fields', () => {
    const entity = new DepartmentEntity({
      id: 'dept-004',
      tenantId: 'tenant-001',
      code: 'LAB',
      name: 'Laboratory',
      preSummaryPromptId: null,
      defaultSummaryTemplate: null,
      newPatientPromptId: null,
      revisitPromptId: null,
      promptConfig: null,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(entity.preSummaryPromptId).toBeNull();
    expect(entity.defaultSummaryTemplate).toBeNull();
    expect(entity.newPatientPromptId).toBeNull();
    expect(entity.revisitPromptId).toBeNull();
    expect(entity.promptConfig).toBeNull();
  });
});

describe('DepartmentFactory — prompt config fields', () => {
  it('should create department with prompt config fields', () => {
    const entity = DepartmentFactory.CreateDepartment({
      tenantId: 'tenant-001',
      code: 'ER',
      name: 'Emergency',
      preSummaryPromptId: 'prompt_pre_summary_er',
      defaultSummaryTemplate: 'ER-Triage',
      newPatientPromptId: 'prompt_er_triage',
      revisitPromptId: 'prompt_er_revisit',
      promptConfig: {
        contextVariables: { triageLevel: true, vitalSigns: true },
        abbreviationDensity: 'high',
      },
    });

    expect(entity.id).toBeDefined();
    expect(entity.preSummaryPromptId).toBe('prompt_pre_summary_er');
    expect(entity.defaultSummaryTemplate).toBe('ER-Triage');
    expect(entity.newPatientPromptId).toBe('prompt_er_triage');
    expect(entity.revisitPromptId).toBe('prompt_er_revisit');
    expect(entity.promptConfig).toEqual({
      contextVariables: { triageLevel: true, vitalSigns: true },
      abbreviationDensity: 'high',
    });
  });

  it('should default prompt config fields to null when not provided', () => {
    const entity = DepartmentFactory.CreateDepartment({
      tenantId: 'tenant-001',
      code: 'GEN',
      name: 'General Practice',
    });

    expect(entity.preSummaryPromptId).toBeNull();
    expect(entity.defaultSummaryTemplate).toBeNull();
    expect(entity.newPatientPromptId).toBeNull();
    expect(entity.revisitPromptId).toBeNull();
    expect(entity.promptConfig).toBeNull();
  });

  it('should preserve existing fields when adding prompt config', () => {
    const entity = DepartmentFactory.CreateDepartment({
      tenantId: 'tenant-001',
      code: 'CARD',
      name: 'Cardiology',
      description: 'Heart and vascular care',
      preSummaryPromptId: 'prompt_pre_summary_card',
    });

    expect(entity.code).toBe('CARD');
    expect(entity.name).toBe('Cardiology');
    expect(entity.description).toBe('Heart and vascular care');
    expect(entity.preSummaryPromptId).toBe('prompt_pre_summary_card');
  });
});
