/**
 * TASK-958 D-8 — `maxAiProviderConnections` must be SETTABLE by an admin.
 *
 * The cap is worthless unless somebody can write a number into it, and under
 * the strict global ValidationPipe (`whitelist + forbidNonWhitelisted +
 * forbidUnknownValues`) a field that is not DECLARED on the request DTO does
 * not merely get ignored — the whole request is rejected. So "an admin can set
 * the cap" is a property of these two DTOs, not of the service behind them.
 *
 * Validation mirrors every sibling quantity limit exactly: `@IsOptional()
 * @IsInt() @Min(0)`. The negative case is the one that matters — a `-1`
 * ceiling would make `assertQuantityQuota` refuse the tenant's FIRST
 * connection, which reads as "provider connections are broken" rather than as
 * "somebody typed a bad number".
 */
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdatePlanEntitlementRequest } from '../plan-entitlement.dto';
import { UpsertTenantEntitlementRequest } from '../tenant-entitlement.dto';

describe('UpdatePlanEntitlementRequest — maxAiProviderConnections (D-8)', () => {
  it('accepts a positive integer ceiling', async () => {
    const dto = plainToInstance(UpdatePlanEntitlementRequest, { maxAiProviderConnections: 2, expectedVersion: 1 });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.maxAiProviderConnections).toBe(2);
  });

  it('rejects a negative ceiling', async () => {
    const dto = plainToInstance(UpdatePlanEntitlementRequest, { maxAiProviderConnections: -1, expectedVersion: 1 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxAiProviderConnections')).toBe(true);
  });

  it('rejects a non-integer ceiling', async () => {
    const dto = plainToInstance(UpdatePlanEntitlementRequest, { maxAiProviderConnections: 1.5, expectedVersion: 1 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxAiProviderConnections')).toBe(true);
  });

  it('accepts the field being absent (only supplied fields change)', async () => {
    const dto = plainToInstance(UpdatePlanEntitlementRequest, { expectedVersion: 1 });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});

describe('UpsertTenantEntitlementRequest — maxAiProviderConnections (D-8)', () => {
  it('accepts a positive integer override', async () => {
    const dto = plainToInstance(UpsertTenantEntitlementRequest, { maxAiProviderConnections: 2 });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.maxAiProviderConnections).toBe(2);
  });

  it('rejects a negative override', async () => {
    const dto = plainToInstance(UpsertTenantEntitlementRequest, { maxAiProviderConnections: -1 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxAiProviderConnections')).toBe(true);
  });
});
