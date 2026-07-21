/**
 * WebhookRunHistoryEntity.validate() Unit Tests
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `webhook.prisma`):
 *   - status: required, must be a member of `Enums.WebhookRunStatus`
 *   - webhookId: required FK, non-empty trimmed
 *   - responeStatusCode: optional; integer in HTTP status range when present
 *   - response: track-only (Prisma `Json?`, no structural validation)
 */

import { describe, it, expect } from 'vitest';
import {
  WebhookRunHistoryEntity,
  IWebhookRunHistoryEntity,
} from '../generated/core/WebhookRunHistoryEntity';
import { ResourceStatusType, WebhookRunStatus } from '../../enums';

function createValidInit(
  overrides: Partial<IWebhookRunHistoryEntity> = {},
): IWebhookRunHistoryEntity {
  return {
    id: 'wrh-test-id',
    status: WebhookRunStatus.SUCCESS,
    response: null,
    responeStatusCode: 200,
    webhookId: 'webhook-1',
    Webhook: null,
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
  } as IWebhookRunHistoryEntity;
}

describe('WebhookRunHistoryEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new WebhookRunHistoryEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new WebhookRunHistoryEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it.each(Object.values(WebhookRunStatus))(
      'should accept status %s',
      (status) => {
        const entity = new WebhookRunHistoryEntity(createValidInit({ status }));

        expect(() => entity.validate()).not.toThrow();
      },
    );
  });

  describe('status', () => {
    it('should throw when status is undefined', () => {
      const entity = new WebhookRunHistoryEntity(
        createValidInit({ status: undefined as unknown as WebhookRunStatus }),
      );

      expect(() => entity.validate()).toThrow(
        'WebhookRunHistory status is required',
      );
    });

    it('should throw when status is not a member of WebhookRunStatus', () => {
      const entity = new WebhookRunHistoryEntity(
        createValidInit({
          status: 'NotAStatus' as unknown as WebhookRunStatus,
        }),
      );

      expect(() => entity.validate()).toThrow(
        'WebhookRunHistory status is invalid',
      );
    });
  });

  describe('webhookId', () => {
    it('should throw when webhookId is empty', () => {
      const entity = new WebhookRunHistoryEntity(createValidInit({ webhookId: '' }));

      expect(() => entity.validate()).toThrow(
        'WebhookRunHistory webhookId is required',
      );
    });

    it('should throw when webhookId is whitespace only', () => {
      const entity = new WebhookRunHistoryEntity(
        createValidInit({ webhookId: '   ' }),
      );

      expect(() => entity.validate()).toThrow(
        'WebhookRunHistory webhookId is required',
      );
    });
  });

  describe('responeStatusCode', () => {
    it('should accept null responeStatusCode', () => {
      const entity = new WebhookRunHistoryEntity(
        createValidInit({ responeStatusCode: null }),
      );

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when responeStatusCode is below 100', () => {
      const entity = new WebhookRunHistoryEntity(
        createValidInit({ responeStatusCode: 99 }),
      );

      expect(() => entity.validate()).toThrow(
        'WebhookRunHistory responeStatusCode must be a valid HTTP status code',
      );
    });

    it('should throw when responeStatusCode is above 599', () => {
      const entity = new WebhookRunHistoryEntity(
        createValidInit({ responeStatusCode: 600 }),
      );

      expect(() => entity.validate()).toThrow(
        'WebhookRunHistory responeStatusCode must be a valid HTTP status code',
      );
    });

    it('should throw when responeStatusCode is non-integer', () => {
      const entity = new WebhookRunHistoryEntity(
        createValidInit({ responeStatusCode: 200.5 }),
      );

      expect(() => entity.validate()).toThrow(
        'WebhookRunHistory responeStatusCode must be a valid HTTP status code',
      );
    });
  });
});
