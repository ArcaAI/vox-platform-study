/**
 * TASK-615 — soft-delete posture of the metering + billing repositories.
 *
 * The platform default is soft delete. Five of the eight new models
 * deliberately opt OUT because they are APPEND-ONLY facts, not managed
 * resources:
 *
 *   - `AiUsageEvent` / `AiUsageRollupHourly` / `AiUsageRollupDaily` — metering
 *     truth under hard retention (18 months raw, rollups indefinite). A usage
 *     fact is corrected by a compensating event, never by deletion; the raw
 *     rows are the dispute evidence behind an invoice.
 *   - `AiUsageOutbox` — transactional-outbox work items, drained then pruned.
 *   - `BillingAdjustment` — a credit memo against a FINALIZED (immutable)
 *     invoice. Retracting one by deleting it would rewrite a closed period; the
 *     correction path is another adjustment.
 *
 * None of the five carries a `resourceStatus` column, so `softDelete()` /
 * `restore()` MUST throw (`Repository.supportsSoftDelete` is driven by
 * `MODELS_WITHOUT_SOFT_DELETE` in `packages/database/src/client.ts`). If this
 * suite ever goes green-by-accident because a model was dropped from that set,
 * the soft-delete `$extends` would start injecting
 * `resourceStatus: { not: 'DELETED' }` into every read and Prisma would reject
 * it — the AsrPipelineVersion / GateEditExemplar failure shape.
 *
 * The three MANAGED models keep soft delete: `AiPriceBook` (a mistaken rate-card
 * row is retired, and reads must exclude it), `BillingInvoice` and
 * `BillingInvoiceLine` (draft invoices are editable until finalize).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { AiUsageEventRepository } from '../AiUsageEventRepository';
import { AiUsageOutboxRepository } from '../AiUsageOutboxRepository';
import { AiUsageRollupHourlyRepository } from '../AiUsageRollupHourlyRepository';
import { AiUsageRollupDailyRepository } from '../AiUsageRollupDailyRepository';
import { AiPriceBookRepository } from '../AiPriceBookRepository';
import { BillingInvoiceRepository } from '../BillingInvoiceRepository';
import { BillingInvoiceLineRepository } from '../BillingInvoiceLineRepository';
import { BillingAdjustmentRepository } from '../BillingAdjustmentRepository';

/** A unit-of-work stub whose delegates are never reached (the guard throws first). */
const unitOfWork = () => ({ getDatabaseService: () => new Proxy({}, { get: () => ({}) }) }) as never;

const APPEND_ONLY: [string, new (uow: never) => { supportsSoftDelete: boolean; softDelete: (id: string) => Promise<unknown>; restore: (id: string) => Promise<unknown> }][] = [
  ['AiUsageEvent', AiUsageEventRepository as never],
  ['AiUsageOutbox', AiUsageOutboxRepository as never],
  ['AiUsageRollupHourly', AiUsageRollupHourlyRepository as never],
  ['AiUsageRollupDaily', AiUsageRollupDailyRepository as never],
  ['BillingAdjustment', BillingAdjustmentRepository as never],
];

const SOFT_DELETABLE: [string, new (uow: never) => { supportsSoftDelete: boolean }][] = [
  ['AiPriceBook', AiPriceBookRepository as never],
  ['BillingInvoice', BillingInvoiceRepository as never],
  ['BillingInvoiceLine', BillingInvoiceLineRepository as never],
];

describe('TASK-615 append-only models reject soft delete', () => {
  it.each(APPEND_ONLY)('%s: supportsSoftDelete is false', (_name, Repo) => {
    expect(new Repo(unitOfWork()).supportsSoftDelete).toBe(false);
  });

  it.each(APPEND_ONLY)('%s: softDelete() throws', async (_name, Repo) => {
    await expect(new Repo(unitOfWork()).softDelete('id-1')).rejects.toThrow(/softDelete is not supported/);
  });

  it.each(APPEND_ONLY)('%s: restore() throws', async (_name, Repo) => {
    await expect(new Repo(unitOfWork()).restore('id-1')).rejects.toThrow(/restore is not supported/);
  });
});

describe('TASK-615 managed models keep soft delete', () => {
  it.each(SOFT_DELETABLE)('%s: supportsSoftDelete is true', (_name, Repo) => {
    expect(new Repo(unitOfWork()).supportsSoftDelete).toBe(true);
  });
});
