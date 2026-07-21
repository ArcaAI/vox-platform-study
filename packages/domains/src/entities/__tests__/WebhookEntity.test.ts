/**
 * WebhookEntity.validate() Unit Tests
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `webhook.prisma`):
 *   - name: required, non-empty trimmed, <= 255 chars
 *   - url: required, non-empty trimmed, <= 2048 chars, parseable via `new URL(...)`
 *   - resourceTypeName: required, non-empty trimmed, <= 100 chars
 *   - hashedSecret: optional; <= 255 chars when present
 *   - resourceId: optional; non-empty trimmed when present
 *   - subscriptionMetadata: track-only (no structural validation per ticket policy)
 */

import { describe, it, expect } from 'vitest';
import { WebhookEntity, IWebhookEntity } from '../generated/core/WebhookEntity';
import { ResourceStatusType } from '../../enums';

function createValidInit(overrides: Partial<IWebhookEntity> = {}): IWebhookEntity {
  return {
    id: 'webhook-test-id',
    tenantId: '50000000-0000-0000-0000-000000000000',
    name: 'consultation-completed',
    url: 'https://example.com/hooks/consultation',
    hashedSecret: 'sha256:deadbeef',
    resourceTypeName: 'Consultation',
    resourceId: null,
    subscriptionMetadata: null,
    WebhookRunHistorys: null,
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
  } as IWebhookEntity;
}

describe('WebhookEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new WebhookEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new WebhookEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it.each([
      'http://localhost:3000/hook',
      'https://example.com/path?query=1',
      'https://sub.domain.example.com/deep/path',
    ])('should accept valid url %s', (url) => {
      const entity = new WebhookEntity(createValidInit({ url }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('name', () => {
    it('should throw when name is empty', () => {
      const entity = new WebhookEntity(createValidInit({ name: '' }));

      expect(() => entity.validate()).toThrow('Webhook name is required');
    });

    it('should throw when name is whitespace only', () => {
      const entity = new WebhookEntity(createValidInit({ name: '   ' }));

      expect(() => entity.validate()).toThrow('Webhook name is required');
    });

    it('should throw when name exceeds 255 characters', () => {
      const entity = new WebhookEntity(createValidInit({ name: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Webhook name must not exceed 255 characters');
    });
  });

  describe('url', () => {
    it('should throw when url is empty', () => {
      const entity = new WebhookEntity(createValidInit({ url: '' }));

      expect(() => entity.validate()).toThrow('Webhook url is required');
    });

    it('should throw when url is whitespace only', () => {
      const entity = new WebhookEntity(createValidInit({ url: '   ' }));

      expect(() => entity.validate()).toThrow('Webhook url is required');
    });

    it('should throw when url exceeds 2048 characters', () => {
      const longUrl = 'https://example.com/' + 'x'.repeat(2050);
      const entity = new WebhookEntity(createValidInit({ url: longUrl }));

      expect(() => entity.validate()).toThrow('Webhook url must not exceed 2048 characters');
    });

    it.each([
      ['no scheme', 'example.com/path'],
      ['garbage', 'not a url'],
      ['only scheme', 'https://'],
    ])('should throw when url is unparseable (%s)', (_label, url) => {
      const entity = new WebhookEntity(createValidInit({ url }));

      expect(() => entity.validate()).toThrow('Webhook url is not a valid URL');
    });
  });

  describe('resourceTypeName', () => {
    it('should throw when resourceTypeName is empty', () => {
      const entity = new WebhookEntity(createValidInit({ resourceTypeName: '' }));

      expect(() => entity.validate()).toThrow('Webhook resourceTypeName is required');
    });

    it('should throw when resourceTypeName is whitespace only', () => {
      const entity = new WebhookEntity(createValidInit({ resourceTypeName: '   ' }));

      expect(() => entity.validate()).toThrow('Webhook resourceTypeName is required');
    });

    it('should throw when resourceTypeName exceeds 100 characters', () => {
      const entity = new WebhookEntity(
        createValidInit({ resourceTypeName: 'x'.repeat(101) }),
      );

      expect(() => entity.validate()).toThrow(
        'Webhook resourceTypeName must not exceed 100 characters',
      );
    });
  });

  describe('hashedSecret', () => {
    it('should accept null hashedSecret', () => {
      const entity = new WebhookEntity(createValidInit({ hashedSecret: null }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when hashedSecret exceeds 255 characters', () => {
      const entity = new WebhookEntity(
        createValidInit({ hashedSecret: 'x'.repeat(256) }),
      );

      expect(() => entity.validate()).toThrow(
        'Webhook hashedSecret must not exceed 255 characters',
      );
    });
  });

  describe('resourceId', () => {
    it('should throw when resourceId is whitespace only (present-but-blank)', () => {
      const entity = new WebhookEntity(createValidInit({ resourceId: '   ' }));

      expect(() => entity.validate()).toThrow('Webhook resourceId must not be blank');
    });
  });
});
