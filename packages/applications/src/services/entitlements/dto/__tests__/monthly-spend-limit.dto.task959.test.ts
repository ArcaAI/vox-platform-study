/**
 * TASK-959 FU-1 (TASK-957 F-4) — `monthlySpendLimitMicros` must be SETTABLE.
 *
 * F-4 put `assertSpendLimit` on the agent and workflow planes, and
 * `task-959-spend-limit.spec.ts` then recorded what that left behind: a tenant
 * can be REFUSED (402) by a ceiling it has no way to set, and a platform admin
 * has none either. The e2e spec has to write the column through the unscoped
 * platform client to construct its own fixture.
 *
 * Under the strict global pipe (`whitelist + forbidNonWhitelisted +
 * forbidUnknownValues`) an undeclared field does not get ignored — the whole
 * PUT is a 400. So "the ceiling can be set" is first a property of this DTO.
 *
 * Validation mirrors the five sibling `BigInt?` allowance columns exactly
 * (`@IsOptional() @IsInt() @Min(0)`, carried as a `number`). Two cases carry
 * the meaning:
 *   - `0` is ACCEPTED and is not the same as absent. "Spend nothing more this
 *     month" is a real, enforceable setting; `null` is the unlimited default.
 *   - a NEGATIVE ceiling is refused. `exceeded` is `overage >= limit`, so a
 *     `-1` would refuse the tenant's next call at zero usage and read as "the
 *     agent plane is down" rather than as a typo.
 */
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpsertTenantEntitlementRequest } from '../tenant-entitlement.dto';

describe('UpsertTenantEntitlementRequest — monthlySpendLimitMicros (FU-1)', () => {
  it('accepts a positive ceiling in micros', async () => {
    const dto = plainToInstance(UpsertTenantEntitlementRequest, { monthlySpendLimitMicros: 250_000_000 });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.monthlySpendLimitMicros).toBe(250_000_000);
  });

  it('accepts zero — a real setting, not the absent one', async () => {
    const dto = plainToInstance(UpsertTenantEntitlementRequest, { monthlySpendLimitMicros: 0 });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.monthlySpendLimitMicros).toBe(0);
  });

  it('accepts null — clears the ceiling back to unlimited', async () => {
    const dto = plainToInstance(UpsertTenantEntitlementRequest, { monthlySpendLimitMicros: null });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.monthlySpendLimitMicros).toBeNull();
  });

  it('rejects a negative ceiling', async () => {
    const dto = plainToInstance(UpsertTenantEntitlementRequest, { monthlySpendLimitMicros: -1 });
    expect((await validate(dto)).some((e) => e.property === 'monthlySpendLimitMicros')).toBe(true);
  });

  it('rejects a fractional micro', async () => {
    const dto = plainToInstance(UpsertTenantEntitlementRequest, { monthlySpendLimitMicros: 1.5 });
    expect((await validate(dto)).some((e) => e.property === 'monthlySpendLimitMicros')).toBe(true);
  });

  it('accepts the field being absent — only supplied fields change', async () => {
    const dto = plainToInstance(UpsertTenantEntitlementRequest, { expectedVersion: 1 });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.monthlySpendLimitMicros).toBeUndefined();
  });
});
