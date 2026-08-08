import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import Decimal from 'decimal.js';
import { DataNotFoundException, SpendLimitExceededException } from '@arcaai/exceptions';
import {
  AiCapability,
  AiUsageRollupDailyRepository,
  AiUsageUnit,
  BillingAdjustmentEntity,
  BillingAdjustmentFactory,
  BillingAdjustmentRepository,
  BillingInvoiceEntity,
  BillingInvoiceFactory,
  BillingInvoiceLineEntity,
  BillingInvoiceLineFactory,
  BillingInvoiceLineWriteRepository,
  BillingInvoiceRepository,
  BillingInvoiceStatus,
  BillingLineKind,
  BillingUsageAggregateRepository,
  CoreUnitOfWorkService,
  PlanEntitlementRepository,
  ResourceType,
  SysEventType,
  TenantEntitlementRepository,
  TenantPlan,
  TenantPlanHistoryFactory,
  TenantPlanHistoryRepository,
  TenantRepository,
} from '@arcaai/domains';

import { BaseService, isSuperAdmin } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IPriceBookService } from '../priceBook/IPriceBookService';
import { resolveBillingAllowances } from './allowances';
import { BILLABLE_UNITS, NON_BILLABLE_LLM_OPERATIONS, STT_BATCH_OPERATION, buildBillableUsage, DayUnitSum } from './billable-usage';
import { BillingPeriod, parseBillingPeriod, truncateToUtcDay } from './billing-period';
import { BillingDtoMapper } from './billing.dto.mapper';
import { AddAdjustmentRequest, BillingInvoiceResponse, BillingInvoiceSummaryResponse, SpendStatusResponse } from './dto';
import { IBillingService } from './IBillingService';
import {
  CurrencyMismatchError,
  InvoiceLineDraft,
  MissingSellRateError,
  PlanFeeBasis,
  PlanFeeSegment,
  ResolvedSellRate,
  SellRateResolver,
  clampPlanSegments,
  computeCapabilityOverage,
  computeInvoiceTotals,
  computePlanFeeLines,
} from './invoice-math';

/**
 * The invoice engine (TASK-615 WS-I, decisions D11–D15, D17).
 *
 * This class fetches inputs and persists outputs; every money decision lives
 * in the PURE modules next to it (`invoice-math`, `billable-usage`,
 * `allowances`, `billing-period`) where it is golden- and property-tested.
 *
 * ============================================================================
 * DATA SOURCES (D13 — rollups, never raw events at invoice time)
 * ============================================================================
 *   usage       → `AiUsageRollupDaily`, plus the bounded ledger AGGREGATES of
 *                 `BillingUsageAggregateRepository` for the two
 *                 operation-shaped rules the rollup grain cannot express
 *                 (D16 guardrail/harness exclusion, OQ1 batch-only audio).
 *   allowances  → `PlanEntitlement` ← `TenantEntitlement` (D11), resolved by
 *                 the pure `resolveBillingAllowances`.
 *   rates       → SELL plane of `AiPriceBook` via `IPriceBookService`,
 *                 pre-resolved per (unit, usage-day) and MEMOIZED for the
 *                 single computation only — never a cross-request cache (the
 *                 ws-b-contract §11 cache question: a per-computation memo is
 *                 inherently tenant-scoped, so §M4 cannot be violated).
 *
 * ============================================================================
 * PRORATION — THE HONEST VERSION (D15)
 * ============================================================================
 * There is NO plan-change history table: `Tenant.plan` is a bare column, its
 * `updatedAt` moves on ANY tenant edit, and audit-log rows are neither a
 * financial record nor retained on a billing horizon. Deriving a change date
 * from any of them would be guesswork stamped onto an invoice. So:
 *
 *   - The engine bills the plan in effect AT COMPUTATION TIME for the whole
 *     period (`planFeeBasis: PERIOD_END_PLAN` on every response), and applies
 *     that plan's allowances to the whole period's usage — which makes D15's
 *     upgrade retroactivity hold by construction.
 *   - The daily-proration math (`computePlanFeeLines`) is ALREADY multi-
 *     segment and golden-tested; a future `TenantPlanHistory` source only has
 *     to produce segments and true mid-month proration lights up with zero
 *     engine change.
 *   - Operational consequences, documented: compute drafts PROMPTLY after
 *     period close, and apply downgrades at the period boundary after
 *     drafting the closing month ("downgrade next period", D15).
 *
 * ============================================================================
 * LIFECYCLE (D13)
 * ============================================================================
 * DRAFT → FINALIZED (immutable; only after `periodEnd`) · DRAFT → VOID
 * (one-way; a voided period stays void in v1). Recomputing a draft SUPERSEDES
 * its lines (soft-delete + insert + totals, one transaction). A finalized
 * period is corrected by credit memos which net as ADJUSTMENT lines on the
 * draft of the period they were ISSUED in — the finalize guard (period must
 * have ended) plus the compute-after-close workflow guarantee every memo is
 * picked up by exactly one draft.
 *
 * // AUTH-NOTE: computeDraft / finalize / void / addAdjustment are
 * // GLOBAL-ADMIN-ONLY, enforced imperatively (`isSuperAdmin`) because the
 * // permission decorators cannot express "global admins only" (rule 05).
 * // Deliberate 403 privilege boundary; cross-tenant BY-ID reads still 404.
 */
@Injectable()
export class BillingService extends BaseService implements IBillingService {
  constructor(
    eventEmitter: EventEmitter2,
    clsService: ClsService<IActiveUserContext>,
    private readonly invoiceRepository: BillingInvoiceRepository,
    private readonly lineRepository: BillingInvoiceLineWriteRepository,
    private readonly adjustmentRepository: BillingAdjustmentRepository,
    private readonly rollupRepository: AiUsageRollupDailyRepository,
    private readonly usageAggregateRepository: BillingUsageAggregateRepository,
    private readonly planEntitlementRepository: PlanEntitlementRepository,
    private readonly tenantEntitlementRepository: TenantEntitlementRepository,
    private readonly tenantRepository: TenantRepository,
    private readonly planHistoryRepository: TenantPlanHistoryRepository,
    @Inject(IPriceBookService) private readonly priceBook: IPriceBookService,
    private readonly unitOfWork: CoreUnitOfWorkService,
  ) {
    super(eventEmitter, clsService, ResourceType.BillingInvoice);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // computeDraft
  // ═════════════════════════════════════════════════════════════════════════

  async computeDraft(tenantId: string, period: string): Promise<BillingInvoiceResponse> {
    this.assertGlobalAdmin();

    const billingPeriod = parseBillingPeriod(period);
    if (billingPeriod.start.getTime() > Date.now()) {
      throw new BadRequestException(`Billing period ${period} has not started — a draft cannot be computed for the future.`);
    }

    const existing = await this.invoiceRepository.findByPeriod(tenantId, billingPeriod.start);
    if (existing && existing.status === BillingInvoiceStatus.FINALIZED) {
      throw new ConflictException(`Period ${period} is FINALIZED — corrections to a closed period are credit memos (addAdjustment).`);
    }
    if (existing && existing.status === BillingInvoiceStatus.VOID) {
      throw new ConflictException(`Period ${period} was voided — a voided period stays void (v1 posture).`);
    }

    const computation = await this.computeLineDrafts(tenantId, billingPeriod, { includeAdjustments: true, usageUntil: billingPeriod.end });
    const totals = computeInvoiceTotals(computation.lines);
    const byokNotionalCostMicros = await this.usageAggregateRepository.sumByokNotionalCostMicros(tenantId, billingPeriod.start, billingPeriod.end);

    let invoice: BillingInvoiceEntity;
    let lineEntities: BillingInvoiceLineEntity[];
    let eventType: SysEventType;

    if (!existing) {
      invoice = BillingInvoiceFactory.CreateBillingInvoice({
        tenantId,
        periodStart: billingPeriod.start,
        periodEnd: billingPeriod.end,
        currency: computation.currency,
        subtotalMicros: totals.subtotalMicros,
        totalMicros: totals.totalMicros,
        createdBy: this.requestUserId ?? undefined,
      });
      lineEntities = computation.lines.map((draft) => this.toLineEntity(tenantId, invoice.id, draft));
      await this.unitOfWork.runInTransaction(async (tx) => {
        await this.invoiceRepository.create(invoice, tx);
        await this.lineRepository.createManyInTx(lineEntities, tx);
      });
      eventType = SysEventType.ResourceCreated;
    } else {
      // Recompute = supersede: soft-delete the old lines, insert the new set,
      // and move the totals — ONE transaction, so a crash can never leave an
      // invoice whose totals disagree with its live lines.
      existing.subtotalMicros = totals.subtotalMicros;
      existing.totalMicros = totals.totalMicros;
      existing.currency = computation.currency;
      existing.updatedBy = this.requestUserId ?? undefined;
      lineEntities = computation.lines.map((draft) => this.toLineEntity(tenantId, existing.id, draft));
      invoice = await this.unitOfWork.runInTransaction(async (tx) => {
        await this.lineRepository.softDeleteByInvoice(tenantId, existing.id, this.requestUserId, tx);
        await this.lineRepository.createManyInTx(lineEntities, tx);
        return this.invoiceRepository.updateWithVersion(existing.id, existing, existing.version, tx);
      });
      eventType = SysEventType.ResourceUpdated;
    }

    this.broadcastSysEvent(eventType, {
      resourceId: invoice.id,
      metaData: { period, status: BillingInvoiceStatus.DRAFT, totalMicros: totals.totalMicros.toString(), lineCount: lineEntities.length },
    });

    const adjustmentsAgainst = await this.adjustmentRepository.findByInvoice(tenantId, invoice.id);
    return BillingDtoMapper.toInvoiceResponse(invoice, lineEntities, adjustmentsAgainst, {
      planTier: computation.planTier,
      byokNotionalCostMicros,
      rateCardVersions: computation.rateCardVersions,
      planFeeBasis: computation.planFeeBasis,
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Reads
  // ═════════════════════════════════════════════════════════════════════════

  async getInvoice(tenantId: string, invoiceId: string): Promise<BillingInvoiceResponse> {
    const invoice = await this.findScopedInvoice(tenantId, invoiceId);
    return this.buildReadModel(tenantId, invoice);
  }

  async listInvoices(tenantId: string, status?: BillingInvoiceStatus): Promise<BillingInvoiceSummaryResponse[]> {
    const invoices = await this.invoiceRepository.findByTenant(tenantId, status);
    return invoices.map((invoice) => BillingDtoMapper.toSummaryResponse(invoice));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Lifecycle transitions
  // ═════════════════════════════════════════════════════════════════════════

  async finalize(tenantId: string, invoiceId: string, expectedVersion: number): Promise<BillingInvoiceResponse> {
    this.assertGlobalAdmin();
    const invoice = await this.findScopedInvoice(tenantId, invoiceId);

    if (invoice.status === BillingInvoiceStatus.FINALIZED) {
      throw new ConflictException('Invoice is already FINALIZED — corrections to a closed period are credit memos.');
    }
    if (invoice.status === BillingInvoiceStatus.VOID) {
      throw new ConflictException('A voided invoice cannot be finalized.');
    }
    if (invoice.periodEnd.getTime() > Date.now()) {
      throw new BadRequestException('The period is still running — a month is closed only after it ends (and its memos are all in).');
    }

    invoice.finalize(this.requestUserId ?? 'system');
    const previousVersion = expectedVersion;
    const updated = await this.invoiceRepository.updateWithVersion(invoiceId, invoice, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: invoiceId,
      metaData: { status: BillingInvoiceStatus.FINALIZED, previousVersion, newVersion: updated.version },
    });
    return this.buildReadModel(tenantId, updated);
  }

  async voidDraft(tenantId: string, invoiceId: string, expectedVersion: number): Promise<BillingInvoiceResponse> {
    this.assertGlobalAdmin();
    const invoice = await this.findScopedInvoice(tenantId, invoiceId);

    // VOID only from DRAFT (D13): voiding a finalized period would rewrite it.
    if (invoice.status !== BillingInvoiceStatus.DRAFT) {
      throw new ConflictException(`Only a DRAFT can be voided (invoice is ${invoice.status}).`);
    }

    invoice.voidInvoice();
    invoice.updatedBy = this.requestUserId ?? undefined;
    const updated = await this.invoiceRepository.updateWithVersion(invoiceId, invoice, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: invoiceId,
      metaData: { status: BillingInvoiceStatus.VOID, previousVersion: expectedVersion, newVersion: updated.version },
    });
    return this.buildReadModel(tenantId, updated);
  }

  async addAdjustment(tenantId: string, invoiceId: string, request: AddAdjustmentRequest): Promise<BillingInvoiceResponse> {
    this.assertGlobalAdmin();
    const invoice = await this.findScopedInvoice(tenantId, invoiceId);

    // Memos exist to correct CLOSED periods; an open draft is corrected by
    // recomputing it (same inputs, same result — no memo needed).
    if (invoice.status !== BillingInvoiceStatus.FINALIZED) {
      throw new ConflictException('Adjustments target FINALIZED invoices only — recompute the draft instead.');
    }

    const adjustment = BillingAdjustmentFactory.CreateBillingAdjustment({
      tenantId,
      invoiceId,
      reason: request.reason,
      amountMicros: BigInt(request.amountMicros),
      createdBy: this.requestUserId ?? undefined,
    });
    const saved = await this.adjustmentRepository.create(adjustment);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceType: ResourceType.BillingAdjustment,
      resourceId: saved.id,
      metaData: { invoiceId, reason: request.reason, amountMicros: request.amountMicros },
    });
    return this.buildReadModel(tenantId, invoice);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Spend status (D12 — enforcement wiring belongs to a later lane)
  // ═════════════════════════════════════════════════════════════════════════

  async getSpendStatus(tenantId: string, period: string): Promise<SpendStatusResponse> {
    const billingPeriod = parseBillingPeriod(period);
    const now = new Date();
    const usageUntil = new Date(Math.min(now.getTime(), billingPeriod.end.getTime()));

    const computation =
      usageUntil.getTime() <= billingPeriod.start.getTime()
        ? null // period not started — nothing to rate
        : await this.computeLineDrafts(tenantId, billingPeriod, { includeAdjustments: false, usageUntil, overageOnly: true });

    let overageSpendMicros = 0n;
    for (const line of computation?.lines ?? []) {
      if (line.kind === BillingLineKind.OVERAGE) overageSpendMicros += line.amountMicros;
    }

    const override = await this.tenantEntitlementRepository.findByTenant(tenantId);
    const spendLimitMicros = override?.monthlySpendLimitMicros ?? null;
    const byokNotionalCostMicros = await this.usageAggregateRepository.sumByokNotionalCostMicros(tenantId, billingPeriod.start, usageUntil);

    const response = new SpendStatusResponse();
    response.period = billingPeriod.label;
    response.periodStart = billingPeriod.start.toISOString();
    response.periodEnd = billingPeriod.end.toISOString();
    response.computedAt = now.toISOString();
    response.overageSpendMicros = overageSpendMicros.toString();
    response.spendLimitMicros = spendLimitMicros === null ? null : spendLimitMicros.toString();
    response.remainingMicros =
      spendLimitMicros === null ? null : (spendLimitMicros > overageSpendMicros ? spendLimitMicros - overageSpendMicros : 0n).toString();
    response.exceeded = spendLimitMicros !== null && overageSpendMicros >= spendLimitMicros;
    response.utilizationPercent = spendLimitMicros === null || spendLimitMicros <= 0n ? null : Number((overageSpendMicros * 100n) / spendLimitMicros);
    response.byokNotionalCostMicros = byokNotionalCostMicros.toString();
    return response;
  }

  async assertSpendLimit(tenantId: string, period?: string): Promise<void> {
    // Cheap opt-in gate: a tenant that has NOT set a limit is unlimited (D12), so
    // skip the overage computation entirely — this is the common case on the
    // metered hot path.
    const override = await this.tenantEntitlementRepository.findByTenant(tenantId);
    if ((override?.monthlySpendLimitMicros ?? null) === null) return;

    const status = await this.getSpendStatus(tenantId, period ?? new Date().toISOString().slice(0, 7));
    if (!status.exceeded) return;

    throw new SpendLimitExceededException(`Tenant has reached its monthly spend limit for ${status.period}.`, {
      tenantId,
      period: status.period,
      spendLimitMicros: status.spendLimitMicros ?? '0',
      overageSpendMicros: status.overageSpendMicros,
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // recordPlanChange — append-only plan-history writer (TASK-615 #6)
  // ═════════════════════════════════════════════════════════════════════════

  async recordPlanChange(tenantId: string, newPlan: TenantPlan | null, effectiveAt: Date, changeReason?: string): Promise<void> {
    const open = await this.planHistoryRepository.findOpenWindow(tenantId);

    // Idempotent: re-recording the plan already in force changes nothing.
    if ((open?.plan ?? null) === newPlan) return;

    // Close the current window and open the new one atomically, so a period is
    // never left double-covered or gapped.
    await this.unitOfWork.runInTransaction(async (tx) => {
      // Inside runInTransaction the repositories join the tx via the shared
      // unit-of-work context; `update(id, entity)` carries no tx param (it reads
      // that context), while `create` also accepts it explicitly.
      if (open) {
        open.supersedeAt(effectiveAt);
        await this.planHistoryRepository.update(open.id, open);
      }
      if (newPlan !== null) {
        const next = TenantPlanHistoryFactory.CreateTenantPlanHistory({
          tenantId,
          plan: newPlan,
          effectiveFrom: effectiveAt,
          previousPlan: open?.plan ?? null,
          changeReason: changeReason ?? (open ? 'change' : 'initial'),
        });
        await this.planHistoryRepository.create(next, tx);
      }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The computation core (shared by computeDraft and getSpendStatus)
  // ═════════════════════════════════════════════════════════════════════════

  private async computeLineDrafts(
    tenantId: string,
    period: BillingPeriod,
    options: { includeAdjustments: boolean; usageUntil: Date; overageOnly?: boolean },
  ): Promise<{ lines: InvoiceLineDraft[]; currency: string; planTier: TenantPlan | null; rateCardVersions: string[]; planFeeBasis: PlanFeeBasis }> {
    // --- tenant + plan --------------------------------------------------------
    let plan: TenantPlan | null;
    try {
      const tenant = await this.tenantRepository.findById(tenantId);
      plan = tenant.plan ?? null;
    } catch (err) {
      if (err instanceof DataNotFoundException) throw new NotFoundException(`Tenant ${tenantId} not found`);
      throw err;
    }

    const planRow = plan ? await this.planEntitlementRepository.findByPlan(plan) : null;
    const override = await this.tenantEntitlementRepository.findByTenant(tenantId);
    const resolved = resolveBillingAllowances(plan, planRow, override);

    const lines: InvoiceLineDraft[] = [];
    const currencies = new Set<string>();
    const bookVersions = new Set<string>();

    // --- plan fee (multi-segment from TenantPlanHistory, else PERIOD_END_PLAN) --
    // TASK-615 #6: when the tenant has dated plan segments overlapping the period
    // the fee is prorated PER SEGMENT (`fee × ownedDays / periodDays`); with no
    // history the single whole-period segment reproduces the pre-#6 behavior
    // exactly (a whole-period single segment bills the fee to the micro). The
    // CURRENT plan still supplies the allowances for the whole period, so D15's
    // upgrade retroactivity holds either way.
    let planFeeBasis: PlanFeeBasis = 'PERIOD_END_PLAN';
    if (!options.overageOnly) {
      const history = await this.planHistoryRepository.findOverlappingPeriod(tenantId, period.start, period.end);
      const intervals =
        history.length > 0
          ? clampPlanSegments(
              history.map((row) => ({ plan: row.plan, from: row.effectiveFrom, to: row.effectiveTo ?? null })),
              period,
            )
          : plan !== null
            ? [{ plan, from: period.start, to: period.end }]
            : [];
      if (history.length > 0) planFeeBasis = 'TENANT_PLAN_HISTORY';

      const segments: PlanFeeSegment[] = [];
      for (const interval of intervals) {
        const fee = await this.priceBook.resolvePlanFee(tenantId, interval.plan, interval.from);
        if (!fee) {
          throw new ConflictException(
            `The SELL card carries no PLAN_FEE row for tier ${interval.plan} — the rate card is incomplete; a draft will not silently bill 0.`,
          );
        }
        segments.push({
          planTier: interval.plan,
          from: interval.from,
          to: interval.to,
          feeMicrosPerPeriod: fee.unitPriceMicros,
          priceBookId: fee.priceBookId,
          bookVersion: fee.bookVersion,
          currency: fee.currency,
        });
        currencies.add(fee.currency);
        bookVersions.add(fee.bookVersion);
      }
      lines.push(...computePlanFeeLines(segments, period));
    }

    // --- billable usage per capability -----------------------------------------
    const rollups = await this.rollupRepository.findByPeriod(tenantId, period.start, options.usageUntil);
    const llmDeductions = await this.usageAggregateRepository.sumDailyQuantitiesByOperation({
      tenantId,
      capability: AiCapability.LLM,
      operations: NON_BILLABLE_LLM_OPERATIONS,
      from: period.start,
      to: options.usageUntil,
    });
    const sttBatchAudio = (
      await this.usageAggregateRepository.sumDailyQuantitiesByOperation({
        tenantId,
        capability: AiCapability.STT,
        operations: [STT_BATCH_OPERATION],
        from: period.start,
        to: options.usageUntil,
      })
    ).filter((entry) => entry.unit === AiUsageUnit.AUDIO_SECOND);

    for (const capability of Object.values(AiCapability)) {
      const slices: DayUnitSum[] = rollups
        .filter((rollup) => rollup.capability === capability)
        .map((rollup) => ({ day: rollup.bucketStart, unit: rollup.unit, quantity: new Decimal(String(rollup.quantitySum)) }));

      const usage = buildBillableUsage(
        capability,
        slices,
        capability === AiCapability.LLM ? { subtract: llmDeductions } : capability === AiCapability.STT ? { replace: sttBatchAudio } : {},
      );
      if (usage.length === 0) continue;

      const resolveRate = await this.prefetchSellRates(tenantId, capability, plan, usage);
      let result;
      try {
        result = computeCapabilityOverage({ capability, allowance: resolved.allowances[capability], usage }, resolveRate.resolver);
      } catch (err) {
        if (err instanceof MissingSellRateError) throw new ConflictException(err.message);
        if (err instanceof CurrencyMismatchError) throw new ConflictException(err.message);
        throw err;
      }
      for (const currency of resolveRate.currenciesUsed) currencies.add(currency);
      for (const version of result.bookVersions) bookVersions.add(version);
      lines.push(...result.lines);
    }

    // --- adjustments issued IN this period (credit memos carried forward) -------
    if (options.includeAdjustments) {
      const adjustments = await this.adjustmentRepository.findAll({
        filters: { tenantId, createdAt: { gte: period.start, lt: period.end } },
        sort: [{ id: 'asc' }],
      } as never);
      for (const adjustment of adjustments as BillingAdjustmentEntity[]) {
        lines.push({
          kind: BillingLineKind.ADJUSTMENT,
          capability: null,
          unit: null,
          quantity: null,
          includedAllowance: null,
          overageQuantity: null,
          unitPriceMicros: null,
          amountMicros: adjustment.amountMicros,
          description: `Adjustment (${adjustment.reason})`,
        });
      }
    }

    if (currencies.size > 1) {
      throw new ConflictException(`Invoice computation crossed currencies [${[...currencies].sort().join(', ')}] — a v1 invoice is single-currency.`);
    }

    return {
      lines,
      currency: currencies.values().next().value ?? 'USD',
      planTier: plan,
      rateCardVersions: [...bookVersions].sort(),
      planFeeBasis,
    };
  }

  /**
   * Pre-resolve SELL rates for every (unit, usage-day) pair so the pure engine
   * can stay synchronous. Memoized for THIS computation only — deliberately
   * never a cross-request cache (ws-b-contract §11 / §M4: a per-computation
   * memo cannot serve one tenant's rate to another).
   */
  private async prefetchSellRates(
    tenantId: string,
    capability: AiCapability,
    planTier: TenantPlan | null,
    usage: ReadonlyArray<{ day: Date; unit: AiUsageUnit }>,
  ): Promise<{ resolver: SellRateResolver; currenciesUsed: string[] }> {
    const rates = new Map<string, ResolvedSellRate | null>();
    const currencies = new Set<string>();

    for (const bucket of usage) {
      if (!BILLABLE_UNITS[capability].includes(bucket.unit)) continue;
      const day = truncateToUtcDay(bucket.day);
      const key = `${bucket.unit}::${day.getTime()}`;
      if (rates.has(key)) continue;

      const price = await this.priceBook.resolveSellPrice({
        tenantId,
        capability,
        unit: bucket.unit,
        occurredAt: day,
        provider: null,
        model: null,
        contextBand: null,
        planTier,
      });
      rates.set(
        key,
        price === null
          ? null
          : { priceBookId: price.priceBookId, unitPriceMicros: price.unitPriceMicros, bookVersion: price.bookVersion, currency: price.currency },
      );
      if (price) currencies.add(price.currency);
    }

    return {
      resolver: (unit, day) => rates.get(`${unit}::${truncateToUtcDay(day).getTime()}`) ?? null,
      currenciesUsed: [...currencies],
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═════════════════════════════════════════════════════════════════════════

  private toLineEntity(tenantId: string, invoiceId: string, draft: InvoiceLineDraft): BillingInvoiceLineEntity {
    return BillingInvoiceLineFactory.CreateBillingInvoiceLine({
      tenantId,
      invoiceId,
      kind: draft.kind,
      capability: draft.capability ?? undefined,
      unit: draft.unit ?? undefined,
      quantity: draft.quantity ?? undefined,
      includedAllowance: draft.includedAllowance ?? undefined,
      overageQuantity: draft.overageQuantity ?? undefined,
      unitPriceMicros: draft.unitPriceMicros ?? undefined,
      amountMicros: draft.amountMicros,
      description: draft.description,
      createdBy: this.requestUserId ?? undefined,
    });
  }

  /** 404-over-403: an id that exists under another tenant reads as "not found". */
  private async findScopedInvoice(tenantId: string, invoiceId: string): Promise<BillingInvoiceEntity> {
    let invoice: BillingInvoiceEntity;
    try {
      invoice = await this.invoiceRepository.findById(invoiceId);
    } catch (err) {
      if (err instanceof DataNotFoundException) throw new NotFoundException(`Invoice ${invoiceId} not found`);
      throw err;
    }
    if (invoice.tenantId !== tenantId) {
      throw new NotFoundException(`Invoice ${invoiceId} not found`);
    }
    return invoice;
  }

  private async buildReadModel(tenantId: string, invoice: BillingInvoiceEntity): Promise<BillingInvoiceResponse> {
    const [lines, adjustments, byokNotionalCostMicros, tenantPlan] = await Promise.all([
      this.lineRepository.findByInvoice(tenantId, invoice.id),
      this.adjustmentRepository.findByInvoice(tenantId, invoice.id),
      this.usageAggregateRepository.sumByokNotionalCostMicros(tenantId, invoice.periodStart, invoice.periodEnd),
      this.tenantRepository
        .findById(tenantId)
        .then((tenant) => tenant.plan ?? null)
        .catch(() => null),
    ]);
    return BillingDtoMapper.toInvoiceResponse(invoice, lines, adjustments, {
      planTier: tenantPlan,
      byokNotionalCostMicros,
      // Book versions are known at computation time only; the persisted lines
      // carry the applied rate (unitPriceMicros) as the dispute evidence.
      rateCardVersions: [],
    });
  }

  private assertGlobalAdmin(): void {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('Invoice computation and lifecycle transitions are restricted to global administrators.');
    }
  }
}
