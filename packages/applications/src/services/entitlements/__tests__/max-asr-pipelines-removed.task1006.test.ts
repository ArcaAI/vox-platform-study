/**
 * TASK-1006 — `maxAsrPipelines` is gone end to end.
 *
 * It bounded the retired `AsrPipeline` rows. With the pipeline stack and its tables removed the
 * knob bounded nothing, yet every entitlement DTO still ACCEPTED it, the resolver still carried it
 * and the plan matrix still declared a value for it — so an admin could "set" a ceiling on a
 * resource that no longer exists and read it back as if it meant something.
 *
 * Pinned at each layer that carried it: the two write DTOs refuse it (the global pipe runs
 * `whitelist + forbidNonWhitelisted`, so an undeclared field is a 400), and neither the resolved
 * limits nor the in-code plan matrix report it.
 */
import { TenantPlan } from '@arcaai/domains';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { UpdatePlanEntitlementRequest } from '../dto/plan-entitlement.dto';
import { UpsertTenantEntitlementRequest } from '../dto/tenant-entitlement.dto';
import { PLAN_ENTITLEMENT_DEFAULTS } from '../entitlements.constants';
import { resolveEntitlements } from '../resolve-entitlements';

const GLOBAL_PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

async function refusedProperties<T extends object>(metatype: new () => T, body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(metatype, body), GLOBAL_PIPE);
  return errors.map((error) => error.property);
}

describe('TASK-1006 — maxAsrPipelines is not an entitlement any more', () => {
  it('the tenant override request refuses it', async () => {
    expect(await refusedProperties(UpsertTenantEntitlementRequest, { maxAsrPipelines: 3 })).toContain('maxAsrPipelines');
  });

  it('the plan update request refuses it', async () => {
    expect(await refusedProperties(UpdatePlanEntitlementRequest, { maxAsrPipelines: 3, expectedVersion: 1 })).toContain('maxAsrPipelines');
  });

  it('the resolved limits carry no maxAsrPipelines, whatever a stale row says', () => {
    const resolved = resolveEntitlements(TenantPlan.PRO, { maxAsrPipelines: 9 } as never, { maxAsrPipelines: 12 } as never);
    expect(resolved.limits).not.toHaveProperty('maxAsrPipelines');
  });

  it('no plan in the in-code matrix declares one', () => {
    for (const [plan, values] of Object.entries(PLAN_ENTITLEMENT_DEFAULTS)) {
      expect(values, plan).not.toHaveProperty('maxAsrPipelines');
    }
  });
});
