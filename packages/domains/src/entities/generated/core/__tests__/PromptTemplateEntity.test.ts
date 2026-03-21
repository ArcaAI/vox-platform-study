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
        tags: ['tag1'],
        Versions: null,
        Department: null,
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
});
