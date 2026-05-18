/**
 * MediaEntity.validate() Unit Tests — TASK-261 (Tier 3)
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `media.prisma`):
 *   - name: non-empty trimmed, <= 255 chars
 *   - uri: non-empty trimmed, <= 2048 chars
 *   - extension: non-empty trimmed, <= 32 chars
 *   - mimeType: non-empty trimmed, <= 255 chars
 *   - size: must be a non-negative finite integer
 *   - hash: non-empty trimmed, <= 255 chars
 *   - bucketId: optional; non-empty trimmed when present
 */

import { describe, it, expect } from 'vitest';
import { MediaEntity, IMediaEntity } from '../generated/core/MediaEntity';
import { ResourceStatusType } from '../../enums';

function createValidInit(overrides: Partial<IMediaEntity> = {}): IMediaEntity {
  return {
    id: 'media-test-id',
    tenantId: '50000000-0000-0000-0000-000000000000',
    name: 'profile.png',
    uri: 's3://bucket/profile.png',
    extension: 'png',
    mimeType: 'image/png',
    size: 1024,
    hash: 'abc123',
    bucketId: null,
    UserMedias: null,
    Tenant: null,
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
  } as IMediaEntity;
}

describe('MediaEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new MediaEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new MediaEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it('should accept size = 0 (zero-byte placeholder)', () => {
      const entity = new MediaEntity(createValidInit({ size: 0 }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('name', () => {
    it('should throw when name is empty', () => {
      const entity = new MediaEntity(createValidInit({ name: '' }));

      expect(() => entity.validate()).toThrow('Media name is required');
    });

    it('should throw when name is whitespace only', () => {
      const entity = new MediaEntity(createValidInit({ name: '   ' }));

      expect(() => entity.validate()).toThrow('Media name is required');
    });

    it('should throw when name exceeds 255 characters', () => {
      const entity = new MediaEntity(createValidInit({ name: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Media name must not exceed 255 characters');
    });
  });

  describe('uri', () => {
    it('should throw when uri is empty', () => {
      const entity = new MediaEntity(createValidInit({ uri: '' }));

      expect(() => entity.validate()).toThrow('Media uri is required');
    });

    it('should throw when uri is whitespace only', () => {
      const entity = new MediaEntity(createValidInit({ uri: '   ' }));

      expect(() => entity.validate()).toThrow('Media uri is required');
    });

    it('should throw when uri exceeds 2048 characters', () => {
      const entity = new MediaEntity(createValidInit({ uri: 'x'.repeat(2049) }));

      expect(() => entity.validate()).toThrow('Media uri must not exceed 2048 characters');
    });
  });

  describe('extension', () => {
    it('should throw when extension is empty', () => {
      const entity = new MediaEntity(createValidInit({ extension: '' }));

      expect(() => entity.validate()).toThrow('Media extension is required');
    });

    it('should throw when extension exceeds 32 characters', () => {
      const entity = new MediaEntity(createValidInit({ extension: 'x'.repeat(33) }));

      expect(() => entity.validate()).toThrow('Media extension must not exceed 32 characters');
    });
  });

  describe('mimeType', () => {
    it('should throw when mimeType is empty', () => {
      const entity = new MediaEntity(createValidInit({ mimeType: '' }));

      expect(() => entity.validate()).toThrow('Media mimeType is required');
    });

    it('should throw when mimeType exceeds 255 characters', () => {
      const entity = new MediaEntity(createValidInit({ mimeType: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Media mimeType must not exceed 255 characters');
    });
  });

  describe('size', () => {
    it('should throw when size is negative', () => {
      const entity = new MediaEntity(createValidInit({ size: -1 }));

      expect(() => entity.validate()).toThrow('Media size must be a non-negative number');
    });

    it('should throw when size is not a finite number', () => {
      const entity = new MediaEntity(
        createValidInit({ size: Number.NaN as unknown as number }),
      );

      expect(() => entity.validate()).toThrow('Media size must be a non-negative number');
    });

    it('should throw when size is not an integer', () => {
      const entity = new MediaEntity(createValidInit({ size: 1.5 }));

      expect(() => entity.validate()).toThrow('Media size must be a non-negative number');
    });
  });

  describe('hash', () => {
    it('should throw when hash is empty', () => {
      const entity = new MediaEntity(createValidInit({ hash: '' }));

      expect(() => entity.validate()).toThrow('Media hash is required');
    });

    it('should throw when hash exceeds 255 characters', () => {
      const entity = new MediaEntity(createValidInit({ hash: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Media hash must not exceed 255 characters');
    });
  });

  describe('bucketId', () => {
    it('should accept null bucketId', () => {
      const entity = new MediaEntity(createValidInit({ bucketId: null }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should accept undefined bucketId', () => {
      const entity = new MediaEntity(createValidInit({ bucketId: undefined }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when bucketId is whitespace only (present-but-blank)', () => {
      const entity = new MediaEntity(createValidInit({ bucketId: '   ' }));

      expect(() => entity.validate()).toThrow('Media bucketId must not be blank');
    });
  });
});
