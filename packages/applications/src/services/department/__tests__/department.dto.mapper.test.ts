import { describe, it, expect } from 'vitest';
import { DepartmentDtoMapper } from '../department.dto.mapper';

const createMockEntity = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'dept-1',
  code: 'code' in overrides ? overrides.code : 'CARD',
  name: 'name' in overrides ? overrides.name : 'Cardiology',
  description: 'description' in overrides ? overrides.description : 'Heart department',
  parentDepartmentId: 'parentDepartmentId' in overrides ? overrides.parentDepartmentId : null,
  isRootDepartment: overrides.isRootDepartment ?? true,
  createdAt: overrides.createdAt ?? new Date('2026-01-15T10:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-02-18T12:00:00Z'),
  defaultSummaryTemplate: 'defaultSummaryTemplate' in overrides ? overrides.defaultSummaryTemplate : null,
  preSummaryPromptId: 'preSummaryPromptId' in overrides ? overrides.preSummaryPromptId : null,
  newPatientPromptId: 'newPatientPromptId' in overrides ? overrides.newPatientPromptId : null,
  revisitPromptId: 'revisitPromptId' in overrides ? overrides.revisitPromptId : null,
  promptConfig: 'promptConfig' in overrides ? overrides.promptConfig : null,
});

describe('DepartmentDtoMapper', () => {
  describe('toResponse', () => {
    it('should map all base fields from entity', () => {
      const entity = createMockEntity();

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result.id).toBe('dept-1');
      expect(result.code).toBe('CARD');
      expect(result.name).toBe('Cardiology');
      expect(result.description).toBe('Heart department');
      expect(result.isRootDepartment).toBe(true);
      expect(result.createdAt).toBe('2026-01-15T10:00:00.000Z');
      expect(result.updatedAt).toBe('2026-02-18T12:00:00.000Z');
    });

    it('should map prompt fields when present', () => {
      const entity = createMockEntity({
        preSummaryPromptId: 'pre-summary-abc',
        defaultSummaryTemplate: 'template-xyz',
        newPatientPromptId: 'prompt-new-1',
        revisitPromptId: 'prompt-rev-1',
        promptConfig: { version: 3, tags: ['cardio'] },
      });

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result.preSummaryPromptId).toBe('pre-summary-abc');
      expect(result.defaultSummaryTemplate).toBe('template-xyz');
      expect(result.newPatientPromptId).toBe('prompt-new-1');
      expect(result.revisitPromptId).toBe('prompt-rev-1');
      expect(result.promptConfig).toEqual({ version: 3, tags: ['cardio'] });
    });

    it('should convert null prompt fields to undefined', () => {
      const entity = createMockEntity({
        preSummaryPromptId: null,
        defaultSummaryTemplate: null,
        newPatientPromptId: null,
        revisitPromptId: null,
        promptConfig: null,
      });

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result.preSummaryPromptId).toBeUndefined();
      expect(result.defaultSummaryTemplate).toBeUndefined();
      expect(result.newPatientPromptId).toBeUndefined();
      expect(result.revisitPromptId).toBeUndefined();
      expect(result.promptConfig).toBeUndefined();
    });

    it('should convert null base fields to undefined', () => {
      const entity = createMockEntity({
        code: null,
        name: null,
        description: null,
        parentDepartmentId: null,
      });

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result.code).toBeUndefined();
      expect(result.name).toBeUndefined();
      expect(result.description).toBeUndefined();
      expect(result.parentDepartmentId).toBeUndefined();
    });

    it('should preserve parentDepartmentId when set', () => {
      const entity = createMockEntity({
        parentDepartmentId: 'parent-dept-1',
        isRootDepartment: false,
      });

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result.parentDepartmentId).toBe('parent-dept-1');
      expect(result.isRootDepartment).toBe(false);
    });

    it('should handle promptConfig with nested objects', () => {
      const config = {
        llm: { provider: 'openai', model: 'gpt-4o' },
        settings: { temperature: 0.7, maxTokens: 4096 },
      };
      const entity = createMockEntity({ promptConfig: config });

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result.promptConfig).toEqual(config);
      expect(result.promptConfig!.llm).toEqual({ provider: 'openai', model: 'gpt-4o' });
    });

    it('should handle empty promptConfig object', () => {
      const entity = createMockEntity({ promptConfig: {} });

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result.promptConfig).toEqual({});
    });

    it('should produce ISO 8601 date strings', () => {
      const entity = createMockEntity({
        createdAt: new Date('2026-06-15T08:30:00.123Z'),
        updatedAt: new Date('2026-06-15T09:45:30.456Z'),
      });

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should map a department with all prompt fields populated', () => {
      const entity = createMockEntity({
        id: 'dept-full',
        code: 'RAD',
        name: 'Radiology',
        description: 'Imaging department',
        parentDepartmentId: 'dept-parent',
        isRootDepartment: false,
        preSummaryPromptId: 'pre-1',
        defaultSummaryTemplate: 'tmpl-1',
        newPatientPromptId: 'np-1',
        revisitPromptId: 'rv-1',
        promptConfig: { active: true },
      });

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result).toEqual({
        id: 'dept-full',
        code: 'RAD',
        name: 'Radiology',
        description: 'Imaging department',
        parentDepartmentId: 'dept-parent',
        isRootDepartment: false,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        preSummaryPromptId: 'pre-1',
        defaultSummaryTemplate: 'tmpl-1',
        newPatientPromptId: 'np-1',
        revisitPromptId: 'rv-1',
        promptConfig: { active: true },
      });
    });

    it('should NOT include defaultDnaStyleId in response', () => {
      const entity = createMockEntity();

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result).not.toHaveProperty('defaultDnaStyleId');
    });

    it('should map preSummaryPromptId when present', () => {
      const entity = createMockEntity({
        preSummaryPromptId: 'pre-summary-prompt-123',
      });

      const result = DepartmentDtoMapper.toResponse(entity as any);

      expect(result.preSummaryPromptId).toBe('pre-summary-prompt-123');
    });
  });
});
