/**
 * PromptManagementDtoMapper Unit Tests
 *
 * Tests entity-to-response mapping with real-like entity structures.
 * No mocks needed — pure function testing.
 */

import { describe, it, expect } from 'vitest';
import { PromptManagementDtoMapper } from '../prompt-management.dto.mapper';

describe('PromptManagementDtoMapper', () => {
  describe('toTemplateResponse', () => {
    it('should map all fields correctly with populated entity', () => {
      const entity = {
        id: 'tpl-1',
        name: 'SOAP Summary',
        description: 'A SOAP note prompt',
        content: 'You are a clinical assistant.',
        category: 'SUMMARY',
        // Scope is surfaced for the doctor UI.
        scope: 'USER_PERSONAL',
        variables: { format: 'SOAP' },
        currentVersionNumber: 3,
        departmentId: 'dept-1',
        tags: ['clinical', 'soap'],
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T12:00:00Z'),
      };

      const result = PromptManagementDtoMapper.toTemplateResponse(entity as any);

      expect(result.id).toBe('tpl-1');
      expect(result.name).toBe('SOAP Summary');
      expect(result.description).toBe('A SOAP note prompt');
      expect(result.content).toBe('You are a clinical assistant.');
      expect(result.category).toBe('SUMMARY');
      expect(result.scope).toBe('USER_PERSONAL');
      expect(result.variables).toEqual({ format: 'SOAP' });
      expect(result.currentVersionNumber).toBe(3);
      expect(result.departmentId).toBe('dept-1');
      expect(result.tags).toEqual(['clinical', 'soap']);
      expect(result.createdAt).toBe('2026-02-18T10:00:00.000Z');
      expect(result.updatedAt).toBe('2026-02-18T12:00:00.000Z');
    });

    // Status maps through; pre-migration rows default DRAFT.
    it('should map status when present and default to DRAFT when absent', async () => {
      const withStatus = PromptManagementDtoMapper.toTemplateResponse({
        id: 'tpl-s',
        name: 'Published',
        content: 'x',
        category: 'SYSTEM',
        status: 'PUBLISHED',
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      } as never);
      expect(withStatus.status).toBe('PUBLISHED');

      const withoutStatus = PromptManagementDtoMapper.toTemplateResponse({
        id: 'tpl-d',
        name: 'Draft',
        content: 'x',
        category: 'SYSTEM',
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      } as never);
      expect(withoutStatus.status).toBe('DRAFT');
    });

    it('should handle null/undefined fields with fallback defaults', () => {
      const entity = {
        id: 'tpl-2',
        name: null,
        description: null,
        content: null,
        category: null,
        variables: null,
        currentVersionNumber: null,
        departmentId: null,
        tags: null,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = PromptManagementDtoMapper.toTemplateResponse(entity as any);

      expect(result.name).toBe('');
      expect(result.description).toBeUndefined();
      expect(result.content).toBe('');
      expect(result.category).toBe('');
      expect(result.variables).toBeUndefined();
      expect(result.currentVersionNumber).toBe(1);
      expect(result.departmentId).toBeUndefined();
      expect(result.tags).toBeUndefined();
    });

    it('should convert date fields to ISO string', () => {
      const entity = {
        id: 'tpl-3',
        name: 'Test',
        content: 'Content',
        category: 'SYSTEM',
        createdAt: new Date('2026-02-18T14:30:45.123Z'),
        updatedAt: new Date('2026-02-18T15:45:00.999Z'),
      };

      const result = PromptManagementDtoMapper.toTemplateResponse(entity as any);

      expect(result.createdAt).toBe('2026-02-18T14:30:45.123Z');
      expect(result.updatedAt).toBe('2026-02-18T15:45:00.999Z');
    });

    it('should use empty string defaults for required string fields', () => {
      const entity = {
        id: 'tpl-4',
        name: undefined,
        content: undefined,
        category: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = PromptManagementDtoMapper.toTemplateResponse(entity as any);

      expect(result.name).toBe('');
      expect(result.content).toBe('');
      expect(result.category).toBe('');
    });

    it('should use undefined for optional fields when null', () => {
      const entity = {
        id: 'tpl-5',
        name: 'x',
        content: 'x',
        category: 'x',
        description: null,
        variables: null,
        departmentId: null,
        tags: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = PromptManagementDtoMapper.toTemplateResponse(entity as any);

      expect(result.description).toBeUndefined();
      expect(result.variables).toBeUndefined();
      expect(result.departmentId).toBeUndefined();
      expect(result.tags).toBeUndefined();
    });

    it('should handle entity with all null optional fields', () => {
      const entity = {
        id: 'tpl-minimal',
        name: 'Minimal',
        content: 'Minimal content',
        category: 'CUSTOM',
        description: null,
        variables: null,
        departmentId: null,
        tags: null,
        currentVersionNumber: null,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = PromptManagementDtoMapper.toTemplateResponse(entity as any);

      expect(result.id).toBe('tpl-minimal');
      expect(result.name).toBe('Minimal');
      expect(result.content).toBe('Minimal content');
      expect(result.description).toBeUndefined();
      expect(result.variables).toBeUndefined();
      expect(result.departmentId).toBeUndefined();
      expect(result.tags).toBeUndefined();
      expect(result.currentVersionNumber).toBe(1);
    });

    it('should handle entity with empty arrays for tags', () => {
      const entity = {
        id: 'tpl-6',
        name: 'Empty Tags',
        content: 'Content',
        category: 'SYSTEM',
        tags: [],
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = PromptManagementDtoMapper.toTemplateResponse(entity as any);

      expect(result.tags).toEqual([]);
    });

    // Agent Jobs surfaces the last prompt-test outcome. Score +
    // timestamp map through; the vault-encrypted lastTestOutput must NOT.
    it('should map lastTestScore/lastTestAt and never expose lastTestOutput', () => {
      const entity = {
        id: 'tpl-tested',
        name: 'Tested',
        content: 'x',
        category: 'SUMMARY',
        lastTestScore: 87,
        lastTestOutput: 'vault:v1:SECRET',
        lastTestAt: new Date('2026-07-01T08:30:00Z'),
        createdAt: new Date('2026-06-01T10:00:00Z'),
        updatedAt: new Date('2026-06-01T10:00:00Z'),
      };

      const result = PromptManagementDtoMapper.toTemplateResponse(entity as any);

      expect(result.lastTestScore).toBe(87);
      expect(result.lastTestAt).toBe('2026-07-01T08:30:00.000Z');
      expect((result as Record<string, unknown>).lastTestOutput).toBeUndefined();
    });

    it('should map absent lastTest fields to undefined (never-tested templates)', () => {
      const entity = {
        id: 'tpl-untested',
        name: 'Untested',
        content: 'x',
        category: 'SUMMARY',
        lastTestScore: null,
        lastTestAt: null,
        createdAt: new Date('2026-06-01T10:00:00Z'),
        updatedAt: new Date('2026-06-01T10:00:00Z'),
      };

      const result = PromptManagementDtoMapper.toTemplateResponse(entity as any);

      expect(result.lastTestScore).toBeUndefined();
      expect(result.lastTestAt).toBeUndefined();
    });

    it('should handle entity with complex JSON in variables', () => {
      const complexVariables = {
        nested: { a: 1, b: { c: [1, 2, 3], d: true } },
        array: [{ x: 'y' }, { z: 0 }],
        specialChars: '{"quoted":"value"}',
      };

      const entity = {
        id: 'tpl-7',
        name: 'Complex',
        content: 'Content',
        category: 'SYSTEM',
        variables: complexVariables,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = PromptManagementDtoMapper.toTemplateResponse(entity as any);

      expect(result.variables).toEqual(complexVariables);
    });
  });

  describe('toVersionResponse', () => {
    it('should map version response correctly', () => {
      const entity = {
        id: 'ver-1',
        promptTemplateId: 'tpl-1',
        versionNumber: 2,
        content: 'Updated prompt content',
        variables: { format: 'SOAP' },
        changeReason: 'Improved clarity',
        changedBy: 'user-1',
        createdAt: new Date('2026-02-18T11:00:00Z'),
      };

      const result = PromptManagementDtoMapper.toVersionResponse(entity as any);

      expect(result.id).toBe('ver-1');
      expect(result.promptTemplateId).toBe('tpl-1');
      expect(result.versionNumber).toBe(2);
      expect(result.content).toBe('Updated prompt content');
      expect(result.variables).toEqual({ format: 'SOAP' });
      expect(result.changeReason).toBe('Improved clarity');
      expect(result.changedBy).toBe('user-1');
      expect(result.createdAt).toBe('2026-02-18T11:00:00.000Z');
    });

    it('should handle null/undefined version fields with defaults', () => {
      const entity = {
        id: 'ver-2',
        promptTemplateId: null,
        versionNumber: null,
        content: null,
        variables: null,
        changeReason: null,
        changedBy: null,
        createdAt: new Date('2026-02-18T11:00:00Z'),
      };

      const result = PromptManagementDtoMapper.toVersionResponse(entity as any);

      expect(result.promptTemplateId).toBe('');
      expect(result.versionNumber).toBe(0);
      expect(result.content).toBe('');
      expect(result.variables).toBeUndefined();
      expect(result.changeReason).toBeUndefined();
      expect(result.changedBy).toBeUndefined();
    });

    it('should convert version createdAt to ISO string', () => {
      const entity = {
        id: 'ver-3',
        promptTemplateId: 'tpl-1',
        versionNumber: 1,
        content: 'Content',
        createdAt: new Date('2026-02-18T09:15:30.500Z'),
      };

      const result = PromptManagementDtoMapper.toVersionResponse(entity as any);

      expect(result.createdAt).toBe('2026-02-18T09:15:30.500Z');
    });

    it('should handle version with complex JSON in variables', () => {
      const complexVars = { deep: { nested: { value: 42 } }, list: [1, 2, 3] };

      const entity = {
        id: 'ver-4',
        promptTemplateId: 'tpl-1',
        versionNumber: 1,
        content: 'Content',
        variables: complexVars,
        createdAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = PromptManagementDtoMapper.toVersionResponse(entity as any);

      expect(result.variables).toEqual(complexVars);
    });
  });
});
