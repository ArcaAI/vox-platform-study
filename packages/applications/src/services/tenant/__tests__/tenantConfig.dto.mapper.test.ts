/**
 * TenantConfigDtoMapper Unit Tests (TASK-393)
 *
 * The mapper turns tenant-scoped `GlobalSetting` entities into the standalone
 * `TenantConfigResponse` DTO, replacing the fragile
 * `GlobalSettingDtoMapper.ToPaginatedResponse(...) as PaginatedTenantConfigResponse`
 * superset cast.
 *
 * These tests exercise the real mapper against entity-shaped inputs (no
 * `AutoClassMapper` mock is needed — the mapper constructs the DTO explicitly,
 * field-by-field). They lock in:
 *   - the full response shape,
 *   - that the tenant-facing fields the old cast dropped (`tenantId`,
 *     `defaultValue`, `locked`) now flow through, and
 *   - pagination metadata across a representative row set.
 */

import { describe, it, expect } from 'vitest';
import { ResourceStatusType, ValueType } from '@arcaai/domains';
import { TenantConfigDtoMapper } from '../tenantConfig.dto.mapper';
import { TenantConfigResponse, PaginatedTenantConfigResponse } from '../dto';
import { FetchResponse } from '../../../common';

/**
 * The public getter surface of a tenant-scoped `GlobalSettingEntity` that the
 * mapper reads. A plain object is a faithful stand-in because the mapper only
 * touches these accessors (it never calls `toObject()` / reflection).
 */
interface GlobalSettingEntityShape {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  resourceStatus: ResourceStatusType;
  resourceStatusUpdatedAt: Date | null;
  resourceStatusUpdatedBy: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  name: string;
  description?: string | null;
  key: string;
  defaultValue?: string | null;
  value: string;
  dataType: ValueType;
  namespace?: string | null;
  tenantId: string;
  locked: boolean;
  version: number;
}

const FIXED_DATE = new Date('2026-06-01T09:30:00.000Z');

function makeEntity(overrides: Partial<GlobalSettingEntityShape> = {}): GlobalSettingEntityShape {
  return {
    id: 'id' in overrides ? overrides.id! : 'cfg-1',
    createdAt: 'createdAt' in overrides ? overrides.createdAt! : FIXED_DATE,
    updatedAt: 'updatedAt' in overrides ? overrides.updatedAt! : FIXED_DATE,
    resourceStatus: 'resourceStatus' in overrides ? overrides.resourceStatus! : ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: 'resourceStatusUpdatedAt' in overrides ? overrides.resourceStatusUpdatedAt! : null,
    resourceStatusUpdatedBy: 'resourceStatusUpdatedBy' in overrides ? overrides.resourceStatusUpdatedBy! : null,
    createdBy: 'createdBy' in overrides ? overrides.createdBy! : 'user-1',
    updatedBy: 'updatedBy' in overrides ? overrides.updatedBy! : 'user-2',
    name: 'name' in overrides ? overrides.name! : 'Default STT Model',
    description: 'description' in overrides ? overrides.description : 'The STT model used by default',
    key: 'key' in overrides ? overrides.key! : 'audio.stt.default_model',
    defaultValue: 'defaultValue' in overrides ? overrides.defaultValue : 'whisper-base',
    value: 'value' in overrides ? overrides.value! : 'whisper-large-v3',
    dataType: 'dataType' in overrides ? overrides.dataType! : ValueType.String,
    namespace: 'namespace' in overrides ? overrides.namespace : 'stt',
    tenantId: 'tenantId' in overrides ? overrides.tenantId! : 'tenant-1',
    locked: 'locked' in overrides ? overrides.locked! : false,
    version: 'version' in overrides ? overrides.version! : 7,
  };
}

const toResponse = (entity: GlobalSettingEntityShape): TenantConfigResponse =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TenantConfigDtoMapper.ToResponse(entity as any);

describe('TenantConfigDtoMapper', () => {
  describe('ToResponse — shape', () => {
    it('maps every tenant-config field from the entity', () => {
      const result = toResponse(makeEntity());

      expect(result).toBeInstanceOf(TenantConfigResponse);
      expect(result.id).toBe('cfg-1');
      expect(result.name).toBe('Default STT Model');
      expect(result.description).toBe('The STT model used by default');
      expect(result.key).toBe('audio.stt.default_model');
      expect(result.defaultValue).toBe('whisper-base');
      expect(result.value).toBe('whisper-large-v3');
      expect(result.dataType).toBe(ValueType.String);
      expect(result.namespace).toBe('stt');
      expect(result.tenantId).toBe('tenant-1');
      expect(result.locked).toBe(false);
      expect(result.version).toBe(7);
    });

    it('maps base audit fields and normalises timestamps to ISO strings', () => {
      const result = toResponse(makeEntity());

      expect(result.createdAt).toBe(FIXED_DATE.toISOString());
      expect(result.updatedAt).toBe(FIXED_DATE.toISOString());
      expect(result.resourceStatus).toBe(ResourceStatusType.ENABLED);
      expect(result.createdBy).toBe('user-1');
      expect(result.updatedBy).toBe('user-2');
      expect(result.projectId).toBeNull();
    });

    it('coalesces a null resourceStatusUpdatedBy to an empty string', () => {
      const result = toResponse(makeEntity({ resourceStatusUpdatedBy: null }));

      expect(result.resourceStatusUpdatedBy).toBe('');
    });

    it('leaves tenantCode unset — a GlobalSetting row does not carry the tenant code', () => {
      const result = toResponse(makeEntity());

      expect(result.tenantCode).toBeUndefined();
    });

    // Decoupling regression: these three fields were silently dropped by the old
    // `... as PaginatedTenantConfigResponse` superset cast (they are absent from
    // `GlobalSettingResponse`). The explicit mapper must surface them.
    it('surfaces tenantId, defaultValue and locked that the old superset cast dropped', () => {
      const result = toResponse(makeEntity({ tenantId: 'tenant-42', defaultValue: 'en', locked: true }));

      expect(result.tenantId).toBe('tenant-42');
      expect(result.defaultValue).toBe('en');
      expect(result.locked).toBe(true);
    });

    it('maps the locked flag when true', () => {
      expect(toResponse(makeEntity({ locked: true })).locked).toBe(true);
    });

    it('preserves a null description / namespace / defaultValue', () => {
      const result = toResponse(makeEntity({ description: null, namespace: null, defaultValue: null }));

      expect(result.description).toBeNull();
      expect(result.namespace).toBeNull();
      expect(result.defaultValue).toBeNull();
    });

    it.each([ValueType.String, ValueType.Integer, ValueType.Boolean, ValueType.Json])(
      'preserves the %s data type and its raw string value',
      (dataType) => {
        const result = toResponse(makeEntity({ dataType, value: 'raw' }));

        expect(result.dataType).toBe(dataType);
        expect(result.value).toBe('raw');
      },
    );

    it('does not mutate the source entity', () => {
      const entity = makeEntity();
      const snapshot = { ...entity };

      toResponse(entity);

      expect(entity).toEqual(snapshot);
    });

    it('produces JSON without a locked-only foreign shape (is a TenantConfigResponse)', () => {
      const parsed = JSON.parse(JSON.stringify(toResponse(makeEntity({ locked: true }))));

      expect(parsed.key).toBe('audio.stt.default_model');
      expect(parsed.tenantId).toBe('tenant-1');
      expect(parsed.locked).toBe(true);
      expect(parsed.version).toBe(7);
    });
  });

  describe('ToPaginatedResponse — representative row set', () => {
    const rows = [
      makeEntity({ id: 'cfg-1', key: 'audio.stt.default_model', value: 'whisper-large-v3', locked: true, version: 3 }),
      makeEntity({ id: 'cfg-2', key: 'default-language', value: 'en', namespace: 'general', dataType: ValueType.String, locked: false, version: 1 }),
      makeEntity({ id: 'cfg-3', key: 'features.code-switching', value: 'true', namespace: 'feature-flags', dataType: ValueType.Boolean, defaultValue: 'false', version: 9 }),
    ];

    it('maps each row and preserves pagination metadata', () => {
      const fetch = new FetchResponse({ data: rows as any, count: 42, limit: 20, page: 2 });

      const result = TenantConfigDtoMapper.ToPaginatedResponse(fetch);

      expect(result).toBeInstanceOf(PaginatedTenantConfigResponse);
      expect(result.count).toBe(42);
      expect(result.limit).toBe(20);
      expect(result.page).toBe(2);
      expect(result.data).toHaveLength(3);
      result.data.forEach((row) => expect(row).toBeInstanceOf(TenantConfigResponse));
    });

    it('maps row fields in order', () => {
      const fetch = new FetchResponse({ data: rows as any, count: 3, limit: 20, page: 1 });

      const result = TenantConfigDtoMapper.ToPaginatedResponse(fetch);

      expect(result.data[0].key).toBe('audio.stt.default_model');
      expect(result.data[0].locked).toBe(true);
      expect(result.data[1].key).toBe('default-language');
      expect(result.data[2].key).toBe('features.code-switching');
      expect(result.data[2].dataType).toBe(ValueType.Boolean);
      expect(result.data[2].defaultValue).toBe('false');
    });

    it('handles an empty row set', () => {
      const fetch = new FetchResponse({ data: [], count: 0, limit: 20, page: 1 });

      const result = TenantConfigDtoMapper.ToPaginatedResponse(fetch);

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });
  });
});
