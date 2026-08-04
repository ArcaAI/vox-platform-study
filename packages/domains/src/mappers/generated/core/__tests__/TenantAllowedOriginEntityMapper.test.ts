/**
 * TenantAllowedOriginEntityMapper — round-trip tests (TASK-610).
 *
 * Mirrors the `AiTaskDefaultEntityMapper` / `AiProviderConnectionEntityMapper`
 * version-round-trip suite:
 *  - `version` is carried DB row → entity (read),
 *  - `version` is stripped from BOTH write paths (`FIELDS_NOT_WRITABLE`) —
 *    the model is OCC-written via a versioned admin PATCH route, so a leak
 *    here would silently break optimistic concurrency,
 *  - core fields round-trip intact.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { TenantAllowedOriginEntityMapper } from '../TenantAllowedOriginEntityMapper';
import { TenantAllowedOrigin } from '../../../../models/generated/core/TenantAllowedOriginModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';

const sampleRow = (overrides: Partial<TenantAllowedOrigin> = {}): TenantAllowedOrigin =>
  new TenantAllowedOrigin({
    id: 'tao-1',
    tenantId: 't-1',
    origin: 'https://arcaai-u2204.bcmch.org',
    label: 'BCMCH production',
    description: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 3,
    metaData: null,
    ...overrides,
  } as TenantAllowedOrigin);

describe('TenantAllowedOriginEntityMapper', () => {
  const mapper = new TenantAllowedOriginEntityMapper();

  it('toDomainEntity carries the core fields + `version` from the database row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.tenantId).toBe('t-1');
    expect(entity.origin).toBe('https://arcaai-u2204.bcmch.org');
    expect(entity.label).toBe('BCMCH production');
    expect(entity.version).toBe(3);
  });

  it('round-trips core fields through entity → persistence', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    const persisted = mapper.toPersistence(entity);
    expect(persisted.origin).toBe('https://arcaai-u2204.bcmch.org');
    expect(persisted.label).toBe('BCMCH production');
    expect(persisted.tenantId).toBe('t-1');
  });

  it('toPersistence (full insert path) does not write `version`', () => {
    const entity = mapper.toDomainEntity(sampleRow({ version: 1 }));
    const persisted = mapper.toPersistence(entity);
    expect(persisted).not.toHaveProperty('version');
  });

  it('toPersistenceChanges never contains `version`, even if the change set has it', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    // simulate a buggy caller poking the internal change set
    (entity as any)._changes = { label: 'renamed', version: 99 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).toMatchObject({ label: 'renamed' });
  });
});
