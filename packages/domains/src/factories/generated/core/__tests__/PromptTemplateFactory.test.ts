/**
 * PromptTemplateFactory Unit Tests
 *
 * Tests for the PromptTemplateFactory that creates PromptTemplate entities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptTemplateFactory } from '../PromptTemplateFactory';

// TASK-305 A.6: tenantId is now required at the factory layer.
const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

vi.mock('../../../../utils', () => ({
  generateId: vi.fn(() => 'generated-uuid-7'),
}));

describe('PromptTemplateFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create entity with generated UUID7 id', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({ tenantId: TEST_TENANT_ID });
    expect(entity.id).toBe('generated-uuid-7');
  });

  it('should set default values for optional fields', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({ tenantId: TEST_TENANT_ID });
    expect(entity.name).toBeNull();
    expect(entity.description).toBeNull();
    expect(entity.content).toBeNull();
    expect(entity.category).toBeNull();
    expect(entity.variables).toBeNull();
    expect(entity.departmentId).toBeNull();
  });

  it('should default tags to empty array', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({ tenantId: TEST_TENANT_ID });
    expect(entity.tags).toEqual([]);
  });

  it('should default currentVersionNumber to 1', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({ tenantId: TEST_TENANT_ID });
    expect(entity.currentVersionNumber).toBe(1);
  });

  it('should not overwrite provided values', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({
      tenantId: TEST_TENANT_ID,
      name: 'custom-name',
      description: 'custom-desc',
      content: 'custom-content',
      category: 'custom-category',
      variables: { key: 'value' },
      departmentId: 'dept-123',
      tags: ['tag1', 'tag2'],
      currentVersionNumber: 5,
    });
    expect(entity.name).toBe('custom-name');
    expect(entity.description).toBe('custom-desc');
    expect(entity.content).toBe('custom-content');
    expect(entity.category).toBe('custom-category');
    expect(entity.variables).toEqual({ key: 'value' });
    expect(entity.departmentId).toBe('dept-123');
    expect(entity.tags).toEqual(['tag1', 'tag2']);
    expect(entity.currentVersionNumber).toBe(5);
  });

  it('should set timestamps', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({ tenantId: TEST_TENANT_ID });
    expect(entity.createdAt).toBeInstanceOf(Date);
    expect(entity.updatedAt).toBeInstanceOf(Date);
  });

  it('should set tenantId when provided', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({ tenantId: 'tenant-123' });
    expect(entity.tenantId).toBe('tenant-123');
  });

  it('should default createdBy and updatedBy to null', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({ tenantId: TEST_TENANT_ID });
    expect(entity.createdBy).toBeNull();
    expect(entity.updatedBy).toBeNull();
  });

  it('should create entity that passes validation', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({ tenantId: TEST_TENANT_ID });
    expect(() => entity.validate()).not.toThrow();
  });

  it('should use provided createdAt and updatedAt when supplied', () => {
    const customDate = new Date('2025-01-15T00:00:00.000Z');
    const entity = PromptTemplateFactory.CreatePromptTemplate({
      tenantId: TEST_TENANT_ID,
      createdAt: customDate,
      updatedAt: customDate,
    });
    expect(entity.createdAt).toBe(customDate);
    expect(entity.updatedAt).toBe(customDate);
  });

  // ─── TASK-294 DEF-C1: scope + ownerUserId defaults ────────────────────

  it('should default scope to TENANT_DEFAULT and ownerUserId to null', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({ tenantId: TEST_TENANT_ID });
    expect(entity.scope).toBe('TENANT_DEFAULT');
    expect(entity.ownerUserId).toBeNull();
  });

  it('should honor explicit USER_PERSONAL scope with ownerUserId', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({
      tenantId: TEST_TENANT_ID,
      scope: 'USER_PERSONAL',
      ownerUserId: 'user-7',
    });
    expect(entity.scope).toBe('USER_PERSONAL');
    expect(entity.ownerUserId).toBe('user-7');
  });

  it('should honor explicit DEPARTMENT_DEFAULT scope', () => {
    const entity = PromptTemplateFactory.CreatePromptTemplate({
      tenantId: TEST_TENANT_ID,
      scope: 'DEPARTMENT_DEFAULT',
    });
    expect(entity.scope).toBe('DEPARTMENT_DEFAULT');
  });
});
