/**
 * TagEntity.validate() Unit Tests — TASK-261 (Tier 3)
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `tag.prisma`):
 *   - tagValue: required, non-empty trimmed, <= 255 chars
 *   - tagKey: optional; <= 100 chars when present
 *   - resourceTypeName: optional; <= 100 chars when present
 *   - resourceId: optional; non-empty trimmed when present
 *   - description: optional; <= 1000 chars when present
 *   - color: optional; <= 32 chars when present
 *   - icon: optional; <= 255 chars when present
 */

import { describe, it, expect } from 'vitest';
import { TagEntity, ITagEntity } from '../generated/core/TagEntity';
import { ResourceStatusType } from '../../enums';

function createValidInit(overrides: Partial<ITagEntity> = {}): ITagEntity {
  return {
    id: 'tag-test-id',
    tenantId: '50000000-0000-0000-0000-000000000000',
    resourceTypeName: 'Media',
    resourceId: 'media-1',
    tagKey: 'category',
    tagValue: 'photo',
    description: null,
    color: '#ff0000',
    icon: 'photo',
    Tenant: null,
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
  } as ITagEntity;
}

describe('TagEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new TagEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new TagEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it('should not throw when only tagValue is supplied (all optionals null)', () => {
      const entity = new TagEntity(
        createValidInit({
          resourceTypeName: null,
          resourceId: null,
          tagKey: null,
          description: null,
          color: null,
          icon: null,
        }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('tagValue', () => {
    it('should throw when tagValue is empty', () => {
      const entity = new TagEntity(createValidInit({ tagValue: '' }));

      expect(() => entity.validate()).toThrow('Tag tagValue is required');
    });

    it('should throw when tagValue is whitespace only', () => {
      const entity = new TagEntity(createValidInit({ tagValue: '   ' }));

      expect(() => entity.validate()).toThrow('Tag tagValue is required');
    });

    it('should throw when tagValue exceeds 255 characters', () => {
      const entity = new TagEntity(createValidInit({ tagValue: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Tag tagValue must not exceed 255 characters');
    });
  });

  describe('tagKey', () => {
    it('should throw when tagKey exceeds 100 characters', () => {
      const entity = new TagEntity(createValidInit({ tagKey: 'x'.repeat(101) }));

      expect(() => entity.validate()).toThrow('Tag tagKey must not exceed 100 characters');
    });

    it('should accept null tagKey', () => {
      const entity = new TagEntity(createValidInit({ tagKey: null }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('resourceTypeName', () => {
    it('should throw when resourceTypeName exceeds 100 characters', () => {
      const entity = new TagEntity(
        createValidInit({ resourceTypeName: 'x'.repeat(101) }),
      );

      expect(() => entity.validate()).toThrow(
        'Tag resourceTypeName must not exceed 100 characters',
      );
    });
  });

  describe('resourceId', () => {
    it('should throw when resourceId is whitespace only (present-but-blank)', () => {
      const entity = new TagEntity(createValidInit({ resourceId: '   ' }));

      expect(() => entity.validate()).toThrow('Tag resourceId must not be blank');
    });
  });

  describe('description', () => {
    it('should throw when description exceeds 1000 characters', () => {
      const entity = new TagEntity(
        createValidInit({ description: 'x'.repeat(1001) }),
      );

      expect(() => entity.validate()).toThrow(
        'Tag description must not exceed 1000 characters',
      );
    });
  });

  describe('color', () => {
    it('should throw when color exceeds 32 characters', () => {
      const entity = new TagEntity(createValidInit({ color: 'x'.repeat(33) }));

      expect(() => entity.validate()).toThrow('Tag color must not exceed 32 characters');
    });
  });

  describe('icon', () => {
    it('should throw when icon exceeds 255 characters', () => {
      const entity = new TagEntity(createValidInit({ icon: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Tag icon must not exceed 255 characters');
    });
  });
});
