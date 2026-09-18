/**
 * TASK-986 W1 — `UpdateTenantRequest.key` must refuse a reserved key shape.
 *
 * `CreateTenantRequest.key` has carried `NotReservedTenantKeyConstraint` since
 * DEF-ADM-001, but the UPDATE DTO did not: a PATCH could therefore MINT a
 * `__GLOBAL__`-keyed impostor row (or, on the reserved rows themselves, rename
 * the key the lifecycle guard used to depend on).
 */
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTenantRequest } from '../dto/updateTenant.request';

describe('UpdateTenantRequest validation', () => {
  it('is valid when key is omitted', async () => {
    const dto = plainToInstance(UpdateTenantRequest, { name: 'Acme Health', expectedVersion: 3 });

    const errors = await validate(dto);

    expect(errors.filter((e) => e.property === 'key')).toHaveLength(0);
  });

  it('is valid for an ordinary key', async () => {
    const dto = plainToInstance(UpdateTenantRequest, { key: 'acme-health', expectedVersion: 3 });

    const errors = await validate(dto);

    expect(errors.filter((e) => e.property === 'key')).toHaveLength(0);
  });

  it.each(['__GLOBAL__', '__SYSTEM__', '__anything__'])('rejects the reserved key shape %s', async (key) => {
    const dto = plainToInstance(UpdateTenantRequest, { key, expectedVersion: 3 });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'key')).toBe(true);
  });
});
