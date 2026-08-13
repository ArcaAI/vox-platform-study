/**
 * Mapper posture for the APPEND-ONLY metering/billing models.
 *
 * These five tables carry `_metadata` / `_version` / audit columns (so the rows
 * still round-trip through the shared BaseTenantEntity + Repository machinery)
 * but have NO `resourceStatus*` columns. Their mappers must therefore strip
 * FOUR fields before persistence, exactly like `AgentTrajectoryStepEntityMapper`:
 *
 *   - `resourceStatus`, `resourceStatusUpdatedAt`, `resourceStatusUpdatedBy` —
 *     inherited from BaseEntity but not backed by a column. Leaving them in makes
 *     Prisma reject every INSERT with a validation error.
 *   - `version` — DB-owned, defaults to 1 in the schema; only
 *     `Repository.updateWithVersion` may ever write it.
 *
 * (`BillingInvoice` is the OCC-written exception and strips `version` ONLY —
 * see `BillingInvoiceEntityMapper.test.ts`.)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { AiUsageEventEntityMapper } from '../AiUsageEventEntityMapper';
import { AiUsageOutboxEntityMapper } from '../AiUsageOutboxEntityMapper';
import { AiUsageRollupHourlyEntityMapper } from '../AiUsageRollupHourlyEntityMapper';
import { AiUsageRollupDailyEntityMapper } from '../AiUsageRollupDailyEntityMapper';
import { BillingAdjustmentEntityMapper } from '../BillingAdjustmentEntityMapper';
import { AiUsageEventFactory, AiUsageOutboxFactory, AiUsageRollupHourlyFactory, AiUsageRollupDailyFactory, BillingAdjustmentFactory } from '../../../../factories';
import { AiCapability, AiUsageUnit, AiDeploymentKind } from '../../../../enums';

const OCCURRED_AT = new Date('2026-08-06T10:00:00.000Z');
const NON_PRISMA_FIELDS = ['version', 'resourceStatus', 'resourceStatusUpdatedAt', 'resourceStatusUpdatedBy'];

const cases: [string, { toPersistence: (e: any) => object; toPersistenceChanges: (e: any) => object }, () => unknown][] = [
  [
    'AiUsageEvent',
    new AiUsageEventEntityMapper(),
    () =>
      AiUsageEventFactory.CreateAiUsageEvent({
        tenantId: 't-1',
        idempotencyKey: 'req-1::LLM::INPUT_TOKEN',
        occurredAt: OCCURRED_AT,
        capability: AiCapability.LLM,
        operation: 'generate',
        provider: 'ollama',
        deployment: AiDeploymentKind.SELF_HOSTED,
        unit: AiUsageUnit.INPUT_TOKEN,
        quantity: 1234,
      }),
  ],
  ['AiUsageOutbox', new AiUsageOutboxEntityMapper(), () => AiUsageOutboxFactory.CreateAiUsageOutbox({ tenantId: 't-1', payload: { events: [] } })],
  [
    'AiUsageRollupHourly',
    new AiUsageRollupHourlyEntityMapper(),
    () =>
      AiUsageRollupHourlyFactory.CreateAiUsageRollupHourly({
        tenantId: 't-1',
        bucketStart: OCCURRED_AT,
        capability: AiCapability.LLM,
        provider: 'ollama',
        model: 'qwen3-8b',
        unit: AiUsageUnit.INPUT_TOKEN,
        quantitySum: 1234,
        costMicrosSum: 0n,
      }),
  ],
  [
    'AiUsageRollupDaily',
    new AiUsageRollupDailyEntityMapper(),
    () =>
      AiUsageRollupDailyFactory.CreateAiUsageRollupDaily({
        tenantId: 't-1',
        bucketStart: OCCURRED_AT,
        capability: AiCapability.LLM,
        provider: 'ollama',
        model: 'qwen3-8b',
        unit: AiUsageUnit.INPUT_TOKEN,
        quantitySum: 1234,
        costMicrosSum: 0n,
      }),
  ],
  [
    'BillingAdjustment',
    new BillingAdjustmentEntityMapper(),
    () => BillingAdjustmentFactory.CreateBillingAdjustment({ tenantId: 't-1', invoiceId: 'inv-1', reason: 'goodwill_credit', amountMicros: -5_000_000n }),
  ],
];

describe.each(cases)('%s mapper — append-only persistence shape', (_name, mapper, build) => {
  it.each(NON_PRISMA_FIELDS)('toPersistence strips `%s`', (field) => {
    expect(mapper.toPersistence(build() as any)).not.toHaveProperty(field);
  });

  it.each(NON_PRISMA_FIELDS)('toPersistenceChanges strips `%s` even when the change set carries it', (field) => {
    const entity = build() as any;
    entity._changes = { version: 99, resourceStatus: 'DELETED', resourceStatusUpdatedAt: new Date(), resourceStatusUpdatedBy: 'u-1' };
    expect(mapper.toPersistenceChanges(entity)).not.toHaveProperty(field);
  });
});

describe('BillingAdjustment money handling', () => {
  it('carries a NEGATIVE amount for a credit memo, as integer micros', () => {
    const entity = BillingAdjustmentFactory.CreateBillingAdjustment({
      tenantId: 't-1',
      invoiceId: 'inv-1',
      reason: 'goodwill_credit',
      amountMicros: -5_000_000n,
    });
    expect(entity.amountMicros).toBe(-5_000_000n);
    expect(new BillingAdjustmentEntityMapper().toPersistence(entity).amountMicros).toBe(-5_000_000n);
  });
});
