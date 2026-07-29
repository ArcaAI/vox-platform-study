/**
 * TenantEntity.validate() Unit Tests
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `tenant.prisma` + existing seed values
 * `__SYSTEM__`, `__GLOBAL__`, `ARCAAI`):
 *   - name: non-empty trimmed, <= 255 chars
 *   - key:  non-empty trimmed, <= 100 chars, matches /^[A-Z0-9_-]+$/i
 *   - description: optional, <= 1000 chars if present
 */

import { describe, it, expect } from 'vitest';
import { TenantEntity, ITenantEntity } from '../generated/core/TenantEntity';
import { ResourceStatusType } from '../../enums';

function createValidInit(overrides: Partial<ITenantEntity> = {}): ITenantEntity {
  return {
    id: 'tenant-test-id',
    name: 'Acme Corp',
    key: 'ACME',
    description: 'A test tenant',
    tags: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: 'user-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: 1,
    ...overrides,
  } as ITenantEntity;
}

describe('TenantEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new TenantEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new TenantEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it.each(['__SYSTEM__', '__GLOBAL__', 'ARCAAI'])('should accept seed-style key %s', (key) => {
      const entity = new TenantEntity(createValidInit({ key }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('name', () => {
    it('should throw when name is empty', () => {
      const entity = new TenantEntity(createValidInit({ name: '' }));

      expect(() => entity.validate()).toThrow('Tenant name is required');
    });

    it('should throw when name is whitespace only', () => {
      const entity = new TenantEntity(createValidInit({ name: '   ' }));

      expect(() => entity.validate()).toThrow('Tenant name is required');
    });

    it('should throw when name exceeds 255 characters', () => {
      const entity = new TenantEntity(createValidInit({ name: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('must not exceed 255 characters');
    });

    it('should accept name exactly 255 characters', () => {
      const entity = new TenantEntity(createValidInit({ name: 'x'.repeat(255) }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('key', () => {
    it('should throw when key is empty', () => {
      const entity = new TenantEntity(createValidInit({ key: '' }));

      expect(() => entity.validate()).toThrow('Tenant key is required');
    });

    it('should throw when key is whitespace only', () => {
      const entity = new TenantEntity(createValidInit({ key: '   ' }));

      expect(() => entity.validate()).toThrow('Tenant key is required');
    });

    it('should throw when key exceeds 100 characters', () => {
      const entity = new TenantEntity(createValidInit({ key: 'A'.repeat(101) }));

      expect(() => entity.validate()).toThrow('must not exceed 100 characters');
    });

    it('should accept key exactly 100 characters', () => {
      const entity = new TenantEntity(createValidInit({ key: 'A'.repeat(100) }));

      expect(() => entity.validate()).not.toThrow();
    });

    it.each([
      ['contains space', 'BAD KEY'],
      ['contains slash', 'bad/key'],
      ['contains dot', 'bad.key'],
      ['contains exclamation', 'BAD!'],
    ])('should throw when key %s', (_label, key) => {
      const entity = new TenantEntity(createValidInit({ key }));

      expect(() => entity.validate()).toThrow('Tenant key format is invalid');
    });
  });

  describe('description', () => {
    it('should accept null description', () => {
      const entity = new TenantEntity(createValidInit({ description: null }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should accept undefined description', () => {
      const entity = new TenantEntity(createValidInit({ description: undefined }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when description exceeds 1000 characters', () => {
      const entity = new TenantEntity(createValidInit({ description: 'x'.repeat(1001) }));

      expect(() => entity.validate()).toThrow('must not exceed 1000 characters');
    });

    it('should accept description exactly 1000 characters', () => {
      const entity = new TenantEntity(createValidInit({ description: 'x'.repeat(1000) }));

      expect(() => entity.validate()).not.toThrow();
    });
  });
});
