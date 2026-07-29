/**
 * @arcaai/vox - Prompt Template Types Tests
 *
 * Tests that prompt types are properly defined and exported,
 * matching the WS-2 backend DTOs.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import type {
  PromptTemplate,
  PromptTemplateCategory,
  PromptVariable,
  PromptVersion,
  CreatePromptInput,
  UpdatePromptInput,
  PromptListFilters,
  AssignDepartmentPromptInput,
} from '../prompt';

// =============================================================================
// Helper factories
// =============================================================================

function makePromptTemplate(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'prompt-001',
    name: 'SOAP Summary Prompt',
    category: 'SUMMARY',
    content: 'Generate a SOAP summary for the following consultation...',
    currentVersionNumber: 1,
    tags: [],
    createdAt: '2026-02-18T10:00:00Z',
    updatedAt: '2026-02-18T10:00:00Z',
    ...overrides,
  };
}

function makePromptVersion(overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: 'version-001',
    promptTemplateId: 'prompt-001',
    versionNumber: 1,
    content: 'Generate a SOAP summary...',
    createdAt: '2026-02-18T10:00:00Z',
    ...overrides,
  };
}

// =============================================================================
// PromptTemplate
// =============================================================================

describe('Prompt Template types', () => {
  describe('PromptTemplate interface', () => {
    it('should accept a valid template with required fields', () => {
      const template = makePromptTemplate();
      expect(template.id).toBe('prompt-001');
      expect(template.name).toBe('SOAP Summary Prompt');
      expect(template.category).toBe('SUMMARY');
      expect(template.content).toBeDefined();
      expect(template.currentVersionNumber).toBe(1);
    });

    it('should accept all optional fields', () => {
      const template = makePromptTemplate({
        description: 'A SOAP-formatted summary prompt',
        departmentId: 'dept-001',
        variables: [
          { name: 'patient_name', type: 'string', required: true },
          { name: 'include_vitals', type: 'boolean', required: false, default: true },
        ],
        tags: ['soap', 'summary'],
      });
      expect(template.description).toBe('A SOAP-formatted summary prompt');
      expect(template.departmentId).toBe('dept-001');
      expect(template.variables).toHaveLength(2);
      expect(template.tags).toHaveLength(2);
    });

    it('should accept all valid categories', () => {
      const categories: PromptTemplateCategory[] = ['SYSTEM', 'SUMMARY', 'DNA_ANALYSIS', 'CUSTOM'];
      categories.forEach((category) => {
        const template = makePromptTemplate({ category });
        expect(template.category).toBe(category);
      });
    });
  });

  // ===========================================================================
  // PromptVariable
  // ===========================================================================

  describe('PromptVariable interface', () => {
    it('should accept all variable types', () => {
      const variables: PromptVariable[] = [
        { name: 'name', type: 'string', required: true },
        { name: 'age', type: 'number', required: false },
        { name: 'active', type: 'boolean', required: false, default: true },
        { name: 'metadata', type: 'json', required: false, description: 'Extra data' },
      ];
      expect(variables).toHaveLength(4);
      expect(variables[0]!.type).toBe('string');
      expect(variables[2]!.default).toBe(true);
      expect(variables[3]!.description).toBe('Extra data');
    });
  });

  // ===========================================================================
  // PromptVersion
  // ===========================================================================

  describe('PromptVersion interface', () => {
    it('should accept required fields', () => {
      const version = makePromptVersion();
      expect(version.promptTemplateId).toBe('prompt-001');
      expect(version.versionNumber).toBe(1);
    });

    it('should accept optional change metadata', () => {
      const version = makePromptVersion({
        variables: [{ name: 'x', type: 'string', required: true }],
        changeReason: 'Improved formatting',
        changedBy: 'admin-001',
      });
      expect(version.changeReason).toBe('Improved formatting');
      expect(version.variables).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Input types
  // ===========================================================================

  describe('CreatePromptInput', () => {
    it('should accept required creation fields', () => {
      const input: CreatePromptInput = {
        name: 'New Prompt',
        category: 'CUSTOM',
        content: 'You are a helpful assistant...',
      };
      expect(input.name).toBe('New Prompt');
      expect(input.category).toBe('CUSTOM');
    });

    it('should accept optional fields', () => {
      const input: CreatePromptInput = {
        name: 'New Prompt',
        category: 'SUMMARY',
        content: 'Summarize...',
        description: 'A summary prompt',
        departmentId: 'dept-001',
        variables: [],
        tags: ['custom'],
      };
      expect(input.description).toBe('A summary prompt');
      expect(input.tags).toHaveLength(1);
    });
  });

  describe('UpdatePromptInput', () => {
    it('should accept partial update fields', () => {
      const input: UpdatePromptInput = {
        content: 'Updated content',
        changeReason: 'Improved accuracy',
      };
      expect(input.content).toBe('Updated content');
      expect(input.changeReason).toBe('Improved accuracy');
    });
  });

  describe('PromptListFilters', () => {
    it('should accept all filter options', () => {
      const filters: PromptListFilters = {
        category: 'SUMMARY',
        departmentId: 'dept-001',
        tags: ['soap'],
        search: 'summary',
        page: 1,
        limit: 20,
      };
      expect(filters.category).toBe('SUMMARY');
      expect(filters.page).toBe(1);
    });

    it('should accept empty filters', () => {
      const filters: PromptListFilters = {};
      expect(filters.category).toBeUndefined();
    });
  });

  describe('AssignDepartmentPromptInput', () => {
    it('should accept assignment fields incl. the OCC expectedVersion', () => {
      const input: AssignDepartmentPromptInput = {
        departmentId: 'dept-001',
        promptTemplateId: 'prompt-001',
        field: 'newPatientPromptId',
        expectedVersion: 1,
      };
      expect(input.field).toBe('newPatientPromptId');
      expect(input.expectedVersion).toBe(1);
    });
  });
});
