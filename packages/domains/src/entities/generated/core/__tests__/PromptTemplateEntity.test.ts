/**
 * PromptTemplateEntity Unit Tests
 *
 * Tests for the PromptTemplateEntity that handles prompt template management.
 */

import { describe, it, expect } from 'vitest';
import { PromptTemplateEntity } from '../PromptTemplateEntity';
import type { IPromptTemplateEntity } from '../PromptTemplateEntity';
import { ResourceStatusType } from '../../../../enums';

const createEntity = (overrides: Partial<IPromptTemplateEntity> = {}) =>
  new PromptTemplateEntity({
    id: 'test-id',
    tenantId: 'test-tenant',
    name: 'Test Template',
    description: 'Test description',
    content: 'Hello {{name}}',
    category: 'SYSTEM',
    variables: { name: 'string' },
    currentVersionNumber: 1,
    departmentId: 'dept-1',
    scope: 'TENANT_DEFAULT',
    ownerUserId: null,
    tags: ['tag1'],
    Versions: null,
    Department: null,
    Owner: null,
    createdBy: 'user-1',
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: null,
    version: 1,
    ...overrides,
  });

describe('PromptTemplateEntity', () => {
  it('should accept all fields in constructor', () => {
    const entity = createEntity();
    expect(entity.id).toBe('test-id');
    expect(entity.tenantId).toBe('test-tenant');
    expect(entity.name).toBe('Test Template');
    expect(entity.description).toBe('Test description');
    expect(entity.content).toBe('Hello {{name}}');
    expect(entity.category).toBe('SYSTEM');
    expect(entity.variables).toEqual({ name: 'string' });
    expect(entity.currentVersionNumber).toBe(1);
    expect(entity.departmentId).toBe('dept-1');
    expect(entity.tags).toEqual(['tag1']);
    expect(entity.Versions).toBeNull();
    expect(entity.Department).toBeNull();
  });

  it('should track changes when fields are modified via setters', () => {
    const entity = createEntity();
    entity.name = 'New Name';
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.name).toBe('New Name');
  });

  it('isActive should return true when resourceStatus is ENABLED', () => {
    const entity = createEntity({ resourceStatus: ResourceStatusType.ENABLED });
    expect(entity.isActive()).toBe(true);
  });

  it('isActive should return false when resourceStatus is not ENABLED', () => {
    const entity = createEntity({ resourceStatus: ResourceStatusType.DISABLED });
    expect(entity.isActive()).toBe(false);
  });

  it('incrementVersion should increment currentVersionNumber by 1', () => {
    const entity = createEntity({ currentVersionNumber: 5 });
    entity.incrementVersion();
    expect(entity.currentVersionNumber).toBe(6);
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.currentVersionNumber).toBe(6);
  });

  it('should have hasChanges false when no fields are modified', () => {
    const entity = createEntity();
    expect(entity.hasChanges).toBe(false);
  });

  it('should accept null values for all optional fields', () => {
    const entity = createEntity({
      name: null,
      description: null,
      content: null,
      category: null,
      variables: null,
      currentVersionNumber: null,
      departmentId: null,
      Versions: null,
      Department: null,
      tags: null,
    });
    expect(entity.name).toBeNull();
    expect(entity.description).toBeNull();
    expect(entity.content).toBeNull();
    expect(entity.category).toBeNull();
    expect(entity.variables).toBeNull();
    expect(entity.currentVersionNumber).toBeNull();
    expect(entity.departmentId).toBeNull();
    expect(entity.Versions).toBeNull();
    expect(entity.Department).toBeNull();
    // BaseTaggedEntity normalizes tags: null to []
    expect(entity.tags).toEqual([]);
  });

  it('isActive should return false when resourceStatus is ARCHIVED', () => {
    const entity = createEntity({ resourceStatus: ResourceStatusType.ARCHIVED });
    expect(entity.isActive()).toBe(false);
  });

  it('isActive should return false when resourceStatus is DELETED', () => {
    const entity = createEntity({ resourceStatus: ResourceStatusType.DELETED });
    expect(entity.isActive()).toBe(false);
  });

  it('incrementVersion should handle null currentVersionNumber', () => {
    const entity = createEntity({ currentVersionNumber: null });
    entity.incrementVersion();
    expect(entity.currentVersionNumber).toBe(1);
  });

  it('should handle empty tags array', () => {
    const entity = createEntity({ tags: [] });
    expect(entity.tags).toEqual([]);
  });

  it('should handle empty string for name', () => {
    const entity = createEntity({ name: '' });
    expect(entity.name).toBe('');
  });

  // ─── Scope + ownerUserId ─────────────────────────────

  it('should default scope to TENANT_DEFAULT when omitted', () => {
    const entity = createEntity({ scope: undefined, ownerUserId: undefined });
    expect(entity.scope).toBe('TENANT_DEFAULT');
    expect(entity.ownerUserId).toBeNull();
  });

  it('should accept USER_PERSONAL scope with ownerUserId in constructor', () => {
    const entity = createEntity({ scope: 'USER_PERSONAL', ownerUserId: 'user-42' });
    expect(entity.scope).toBe('USER_PERSONAL');
    expect(entity.ownerUserId).toBe('user-42');
  });

  it('should accept DEPARTMENT_DEFAULT scope in constructor', () => {
    const entity = createEntity({ scope: 'DEPARTMENT_DEFAULT' });
    expect(entity.scope).toBe('DEPARTMENT_DEFAULT');
  });

  it('should track scope change via setter', () => {
    const entity = createEntity();
    entity.scope = 'USER_PERSONAL';
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.scope).toBe('USER_PERSONAL');
  });

  it('should track ownerUserId change via setter', () => {
    const entity = createEntity();
    entity.ownerUserId = 'user-99';
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.ownerUserId).toBe('user-99');
  });

  // ─── Prompt quality/score test fields ────────────────────

  it('should accept lastTestScore/lastTestOutput/lastTestAt in constructor', () => {
    const testedAt = new Date('2026-06-01T09:00:00.000Z');
    const entity = createEntity({ lastTestScore: 0.87, lastTestOutput: 'Generated text', lastTestAt: testedAt });
    expect(entity.lastTestScore).toBe(0.87);
    expect(entity.lastTestOutput).toBe('Generated text');
    expect(entity.lastTestAt).toBe(testedAt);
  });

  it('should default the test fields to null when omitted', () => {
    const entity = createEntity({ lastTestScore: undefined, lastTestOutput: undefined, lastTestAt: undefined });
    expect(entity.lastTestScore ?? null).toBeNull();
    expect(entity.lastTestOutput ?? null).toBeNull();
    expect(entity.lastTestAt ?? null).toBeNull();
  });

  it('should track lastTestScore change via setter (setProperty)', () => {
    const entity = createEntity();
    entity.lastTestScore = 0.5;
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.lastTestScore).toBe(0.5);
  });

  it('should track lastTestOutput change via setter (setProperty)', () => {
    const entity = createEntity();
    entity.lastTestOutput = 'New output';
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.lastTestOutput).toBe('New output');
  });

  it('should track lastTestAt change via setter (setProperty)', () => {
    const entity = createEntity();
    const at = new Date('2026-06-02T00:00:00.000Z');
    entity.lastTestAt = at;
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.lastTestAt).toBe(at);
  });
});
