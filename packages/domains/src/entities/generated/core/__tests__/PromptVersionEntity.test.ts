/**
 * PromptVersionEntity Unit Tests
 *
 * Tests for the PromptVersionEntity that handles prompt version snapshots.
 */

import { describe, it, expect } from 'vitest';
import { PromptVersionEntity } from '../PromptVersionEntity';
import type { IPromptVersionEntity } from '../PromptVersionEntity';
import { ResourceStatusType } from '../../../../enums';

const createEntity = (overrides: Partial<IPromptVersionEntity> = {}) =>
  new PromptVersionEntity({
    id: 'test-id',
    tenantId: 'test-tenant',
    promptTemplateId: 'template-1',
    versionNumber: 1,
    content: 'Version 1 content',
    variables: { key: 'value' },
    changeReason: 'Initial version',
    changedBy: 'user-1',
    PromptTemplate: null,
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

describe('PromptVersionEntity', () => {
  it('should accept all fields in constructor', () => {
    const entity = createEntity();
    expect(entity.id).toBe('test-id');
    expect(entity.tenantId).toBe('test-tenant');
    expect(entity.promptTemplateId).toBe('template-1');
    expect(entity.versionNumber).toBe(1);
    expect(entity.content).toBe('Version 1 content');
    expect(entity.variables).toEqual({ key: 'value' });
    expect(entity.changeReason).toBe('Initial version');
    expect(entity.changedBy).toBe('user-1');
    expect(entity.PromptTemplate).toBeNull();
  });

  it('should track changes when fields are modified via setters', () => {
    const entity = createEntity();
    entity.content = 'Updated content';
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.content).toBe('Updated content');
  });

  it('should have hasChanges false when no fields are modified', () => {
    const entity = createEntity();
    expect(entity.hasChanges).toBe(false);
  });

  it('should accept null values for all optional fields', () => {
    const entity = createEntity({
      promptTemplateId: null,
      versionNumber: null,
      content: null,
      variables: null,
      changeReason: null,
      changedBy: null,
      PromptTemplate: null,
    });
    expect(entity.promptTemplateId).toBeNull();
    expect(entity.versionNumber).toBeNull();
    expect(entity.content).toBeNull();
    expect(entity.variables).toBeNull();
    expect(entity.changeReason).toBeNull();
    expect(entity.changedBy).toBeNull();
    expect(entity.PromptTemplate).toBeNull();
  });

  it('should accept null for optional fields', () => {
    const entity = createEntity({ variables: null, changeReason: null, changedBy: null });
    expect(entity.variables).toBeNull();
    expect(entity.changeReason).toBeNull();
    expect(entity.changedBy).toBeNull();
  });
});
