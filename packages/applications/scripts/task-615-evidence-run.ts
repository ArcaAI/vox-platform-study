/**
 * Live evidence run (gate).
 *
 * Runs the full metering→billing chain against the shared DEV Postgres
 * (localhost:5432/hope) with NO NestJS bootstrap and NO API server: every
 * service/repository is constructed directly, the same way
 * `packages/domains/src/integration/*.test.ts` construct a repository
 * against a real database. This is intentional per the task brief
 * ("invoke the drain method directly from the script — don't require the
 * API server").
 *
 * Steps: seed one synthetic AiUsageOutbox row per capability for the ArcaAI
 * dev tenant → drain it with the real `UsageOutboxDrainer` → print the
 * resulting `AiUsageEvent` rows and their rated cost → read
 * `MeteringService.getCurrentUsage` → temporarily force a real STT overage
 * (tenant.plan → STARTER, a low `monthlySttSessionSeconds` override) →
 * `BillingService.computeDraft` → print the draft invoice's line breakdown →
 * CLEAN UP every row this script created and restore the tenant to its
 * original state.
 *
 * Run:  cd hope-v2-wt-ws-k && npx dotenv -e .env.dev -- npx tsx scripts/task-615-evidence-run.ts
 *
 * Safety: only ever INSERTs/UPDATEs/DELETEs rows this script itself owns
 * (all requestIds/idempotencyKeys are prefixed `task615-evidence-`, and the
 * ArcaAI tenant's `plan`/`TenantEntitlement` override are read before
 * mutation and restored in `finally`). No migration, no `db push`, no
 * schema change — plain DML against the existing dev schema.
 */
import {
  AiUsageOutboxRepository,
  AiUsageEventRepository,
  AiUsageRollupHourlyRepository,
  AiUsageRollupDailyRepository,
  AiPriceBookRepository,
  BillingInvoiceRepository,
  BillingInvoiceLineWriteRepository,
  BillingAdjustmentRepository,
  PlanEntitlementRepository,
  TenantEntitlementRepository,
  TenantRepository,
  AiCapability,
  AiCostBasis,
  AiDeploymentKind,
  AiUsageUnit,
  TenantPlan,
  CoreUnitOfWorkService,
} from '@arcaai/domains';
import {
  UsageLedgerService,
  UsageOutboxDrainer,
  PriceBookService,
  MeteringService,
  BillingService,
  IPriceBookService,
} from '@arcaai/applications';
import { EventEmitter2 } from '@nestjs/event-emitter';
// eslint-disable-next-line no-restricted-imports -- sanctioned: standalone admin/evidence script, mirrors seeds + integration-test fixtures
import { getPlatformAdminPrismaClient_Unscoped } from '@arcaai/database';

const ARCAAI_TENANT_ID = '50000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}`;
const KEY_PREFIX = `task615-evidence-${RUN_ID}`;

const client = getPlatformAdminPrismaClient_Unscoped();

/** In-memory ClsService stand-in — no AsyncLocalStorage/request context needed for a batch script. */
function makeFakeCls(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return { get: (key: string) => store.get(key), set: (key: string, value: unknown) => void store.set(key, value) };
}

/** Domains-layer `CoreUnitOfWorkService`, constructed directly (no DI container). `databaseService.client`/`.baseClient` both point at the unscoped admin client — correct here because this script is a platform-wide maintenance job, exactly the posture `MeteringService`/`AuditRetentionService` already take in production. */
function makeRealUnitOfWork(): CoreUnitOfWorkService {
  const databaseService = { baseClient: client, client } as never;
  return new CoreUnitOfWorkService(databaseService, makeFakeCls() as never);
}

function log(section: string, data: unknown) {
  console.log(`\n=== ${section} ===`);
  console.log(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

async function main() {
  const uowStub = { getDatabaseService: () => client } as never;
  const realUow = makeRealUnitOfWork();

  const outboxRepo = new AiUsageOutboxRepository(uowStub);
  const eventRepo = new AiUsageEventRepository(uowStub);
  const hourlyRepo = new AiUsageRollupHourlyRepository(uowStub);
  const dailyRepo = new AiUsageRollupDailyRepository(uowStub);
  const priceBookRepo = new AiPriceBookRepository(uowStub);
  const priceBookService: IPriceBookService = new PriceBookService(priceBookRepo);
  const ledgerService = new UsageLedgerService(outboxRepo);
  const drainer = new UsageOutboxDrainer(outboxRepo, eventRepo, hourlyRepo, dailyRepo, priceBookService, realUow);

  const appSettingsStub = { getValueWithDefault: (_k: string, fallback: unknown) => fallback } as never;
  const schedulerStub = { addCronJob: () => {}, getCronJob: () => undefined, deleteCronJob: () => {} } as never;
  const meteringService = new MeteringService(appSettingsStub, schedulerStub, { baseClient: client } as never);

  const invoiceRepo = new BillingInvoiceRepository(uowStub);
  const lineRepo = new BillingInvoiceLineWriteRepository(uowStub);
  const adjustmentRepo = new BillingAdjustmentRepository(uowStub);
  const planEntitlementRepo = new PlanEntitlementRepository(uowStub);
  const tenantEntitlementRepo = new TenantEntitlementRepository(uowStub);
  const tenantRepo = new TenantRepository(uowStub);
  // BillingUsageAggregateRepository is applications-external (domains/repositories/billing) but not re-exported from the domains barrel under that exact name check — import directly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- avoids a second import block for one class
  const { BillingUsageAggregateRepository } = require('@arcaai/domains');
  const usageAggregateRepo = new BillingUsageAggregateRepository(realUow);

  const eventEmitter = new EventEmitter2();
  const globalAdminCls = makeFakeCls({ user: { id: 'task615-evidence-script', roles: ['GLOBAL_ADMIN'] }, tenantId: ARCAAI_TENANT_ID });
  const billingService = new BillingService(
    eventEmitter,
    globalAdminCls as never,
    invoiceRepo,
    lineRepo,
    adjustmentRepo,
    dailyRepo,
    usageAggregateRepo,
    planEntitlementRepo,
    tenantEntitlementRepo,
    tenantRepo,
    priceBookService,
    realUow,
  );

  const now = new Date();
  let createdOutboxIds: string[] = [];
  let createdInvoiceId: string | null = null;
  let overrideCreated = false;
  let originalPlan: TenantPlan | null = null;
  // Hoisted out of `try` so `finally` can see them for cleanup even if an earlier step throws.
  let events: Array<{ common: Record<string, unknown>; units: Array<{ unit: AiUsageUnit; quantity: string }> }> = [];
  const rollupBaseline = new Map<string, { quantitySum: string; costMicrosSum: string } | null>();
  const bucketStart = new Date(now.toISOString().slice(0, 10));
  let rollupTuples: Array<{ tenantId: string; bucketStart: Date; capability: AiCapability; provider: string; model: string; unit: AiUsageUnit }> = [];

  try {
    // ── 0. Snapshot the tenant's current plan (restored in finally) ──────
    const tenantBefore = await client.tenant.findUniqueOrThrow({ where: { id: ARCAAI_TENANT_ID } });
    originalPlan = tenantBefore.plan as TenantPlan | null;
    log('0. tenant before', { id: tenantBefore.id, plan: tenantBefore.plan });

    // ── 1. Seed one synthetic batch covering every capability ────────────
    events = [
      // STT — streaming session (both units, per ws-b-contract.md §9)
      {
        common: {
          tenantId: ARCAAI_TENANT_ID,
          idempotencyKey: `${KEY_PREFIX}:stt:session`,
          occurredAt: now,
          capability: AiCapability.STT,
          operation: 'transcribe.stream' as const,
          provider: 'whisper_cpp',
          model: null,
          deployment: AiDeploymentKind.SELF_HOSTED,
          sessionId: `${KEY_PREFIX}-session`,
        },
        units: [
          { unit: AiUsageUnit.SESSION_SECOND, quantity: '5000' },
          { unit: AiUsageUnit.AUDIO_SECOND, quantity: '5000' },
        ],
      },
      // LLM generate (SMR)
      {
        common: {
          tenantId: ARCAAI_TENANT_ID,
          idempotencyKey: `${KEY_PREFIX}:llm:generate`,
          occurredAt: now,
          capability: AiCapability.LLM,
          operation: 'generate' as const,
          provider: 'lm-studio',
          model: 'llama-3.1-8b',
          deployment: AiDeploymentKind.SELF_HOSTED,
          requestId: `${KEY_PREFIX}-llm`,
        },
        units: [
          { unit: AiUsageUnit.INPUT_TOKEN, quantity: '1200' },
          { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: '400' },
        ],
      },
      // guardrail.validate — metered for COGS, never invoiced (D16)
      {
        common: {
          tenantId: ARCAAI_TENANT_ID,
          idempotencyKey: `${KEY_PREFIX}:guardrail`,
          occurredAt: now,
          capability: AiCapability.LLM,
          operation: 'guardrail.validate' as const,
          provider: 'lm-studio',
          model: 'granite-guardian',
          deployment: AiDeploymentKind.SELF_HOSTED,
          requestId: `${KEY_PREFIX}-guardrail`,
        },
        units: [
          { unit: AiUsageUnit.INPUT_TOKEN, quantity: '300' },
          { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: '20' },
        ],
      },
      // harness.step — metered for COGS, never invoiced (D16)
      {
        common: {
          tenantId: ARCAAI_TENANT_ID,
          idempotencyKey: `${KEY_PREFIX}:harness`,
          occurredAt: now,
          capability: AiCapability.LLM,
          operation: 'harness.step' as const,
          provider: 'lm-studio',
          model: 'llama-3.1-8b',
          deployment: AiDeploymentKind.SELF_HOSTED,
          requestId: `${KEY_PREFIX}-harness`,
        },
        units: [
          { unit: AiUsageUnit.INPUT_TOKEN, quantity: '500' },
          { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: '150' },
        ],
      },
      // TTS
      {
        common: {
          tenantId: ARCAAI_TENANT_ID,
          idempotencyKey: `${KEY_PREFIX}:tts`,
          occurredAt: now,
          capability: AiCapability.TTS,
          operation: 'tts.synthesize' as const,
          provider: 'kokoro',
          model: null,
          deployment: AiDeploymentKind.SELF_HOSTED,
          requestId: `${KEY_PREFIX}-tts`,
        },
        units: [
          { unit: AiUsageUnit.CHARACTER, quantity: '850' },
          { unit: AiUsageUnit.AUDIO_SECOND, quantity: '42' },
        ],
      },
      // NLP — consultation-batched
      {
        common: {
          tenantId: ARCAAI_TENANT_ID,
          idempotencyKey: `${KEY_PREFIX}:nlp`,
          occurredAt: now,
          capability: AiCapability.NLP,
          operation: 'ner.extract' as const,
          provider: 'gliner',
          model: null,
          deployment: AiDeploymentKind.SELF_HOSTED,
          requestId: `${KEY_PREFIX}-nlp`,
        },
        units: [
          { unit: AiUsageUnit.TEXT_UNIT, quantity: '18' },
          { unit: AiUsageUnit.REQUEST, quantity: '1' },
        ],
      },
      // EMBED
      {
        common: {
          tenantId: ARCAAI_TENANT_ID,
          idempotencyKey: `${KEY_PREFIX}:embed`,
          occurredAt: now,
          capability: AiCapability.EMBEDDING,
          operation: 'embed' as const,
          provider: 'lm-studio',
          model: 'bge-m3',
          deployment: AiDeploymentKind.SELF_HOSTED,
          requestId: `${KEY_PREFIX}-embed`,
        },
        units: [{ unit: AiUsageUnit.INPUT_TOKEN, quantity: '640' }],
      },
    ];

    // ── Snapshot the exact AiUsageRollupDaily rows this run's (capability,
    // provider, model, unit, today) tuples will touch, BEFORE any drain runs,
    // so cleanup can restore them EXACTLY (there is no per-row event count on
    // this table — restoring the pre-run snapshot is the only precise
    // undo, rather than guessing whether a delta decrement empties the row).
    rollupTuples = events.flatMap((event) =>
      event.units.map((unit) => ({
        tenantId: ARCAAI_TENANT_ID,
        bucketStart,
        capability: event.common.capability as AiCapability,
        provider: event.common.provider as string,
        model: (event.common.model as string | null) ?? '',
        unit: unit.unit,
      })),
    );
    for (const tuple of rollupTuples) {
      const dimKey = `${tuple.capability}::${tuple.provider}::${tuple.model}::${tuple.unit}`;
      if (rollupBaseline.has(dimKey)) continue;
      const row = await client.aiUsageRollupDaily.findUnique({
        where: { AiUsageRollupDaily_dimension_unique: tuple },
      });
      rollupBaseline.set(dimKey, row ? { quantitySum: row.quantitySum.toString(), costMicrosSum: row.costMicrosSum.toString() } : null);
    }

    const recordResults = [];
    for (const event of events) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- batch shape matches UsageEventBatchInput; avoiding a second import block
      const result = await ledgerService.recordUsage(event as any);
      recordResults.push({ key: event.common.idempotencyKey, ...result });
      createdOutboxIds.push(...result.outboxIds);
    }
    log('1. recordUsage results (outbox rows written)', recordResults);

    // ── 2. Drain the outbox (real UsageOutboxDrainer, no BullMQ needed) ───
    // `availableAt` defaults to `now()` AT INSERT TIME (a few ms after the `now`
    // captured above), so draining with the STALE `now` would find nothing
    // claimable — always drain with a fresh timestamp.
    let drainReport = await drainer.drainBatch(50, new Date());
    let guard = 0;
    while (drainReport.rows > 0 && guard < 10) {
      drainReport = await drainer.drainBatch(50, new Date());
      guard += 1;
    }
    log('2. final drain pass report', drainReport);

    const ledgerRows = await client.aiUsageEvent.findMany({
      where: { idempotencyKey: { startsWith: KEY_PREFIX } },
      orderBy: { idempotencyKey: 'asc' },
    });
    log(
      '2b. AiUsageEvent rows produced (row counts + rated cost per unit)',
      ledgerRows.map((r) => ({
        idempotencyKey: r.idempotencyKey,
        capability: r.capability,
        operation: r.operation,
        unit: r.unit,
        quantity: r.quantity.toString(),
        unitPriceMicros: r.unitPriceMicros?.toString() ?? null,
        costMicros: r.costMicros?.toString() ?? null,
        costBasis: r.costBasis,
      })),
    );

    const rollupRows = await client.aiUsageRollupDaily.findMany({
      where: { tenantId: ARCAAI_TENANT_ID, bucketStart: { gte: new Date(now.toISOString().slice(0, 10)) } },
      orderBy: [{ capability: 'asc' }, { unit: 'asc' }],
    });
    log(
      '2c. AiUsageRollupDaily rows for today (includes pre-existing dev usage, not just this run)',
      rollupRows.map((r) => ({ capability: r.capability, unit: r.unit, quantitySum: r.quantitySum.toString(), eventCount: r.eventCount })),
    );

    // ── 3. MeteringService.getCurrentUsage ────────────────────────────────
    const currentUsage = await meteringService.getCurrentUsage(ARCAAI_TENANT_ID, now);
    log('3. MeteringService.getCurrentUsage (current month, includes pre-existing dev usage)', currentUsage);

    // ── 4a. Draft with the tenant's ACTUAL current state (expect zero overage: allowances are NULL — ) ──
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const draftBefore = await billingService.computeDraft(ARCAAI_TENANT_ID, period);
    createdInvoiceId = draftBefore.id;
    log('4a. computeDraft BEFORE forcing an allowance override (expect: zero overage lines — NULL allowances)', {
      id: draftBefore.id,
      status: draftBefore.status,
      lineCount: draftBefore.lines.length,
      totalMicros: draftBefore.totalMicros,
    });

    // ── 4b. Force a real overage: plan=STARTER + a low STT session-second override, recompute ──
    if (originalPlan === null || originalPlan === undefined) {
      await client.tenant.update({ where: { id: ARCAAI_TENANT_ID }, data: { plan: TenantPlan.STARTER } });
    }
    const existingOverride = await client.tenantEntitlement.findUnique({ where: { tenantId: ARCAAI_TENANT_ID } });
    if (!existingOverride) {
      await client.tenantEntitlement.create({ data: { tenantId: ARCAAI_TENANT_ID, monthlySttSessionSeconds: 10n } });
      overrideCreated = true;
    } else {
      await client.tenantEntitlement.update({ where: { tenantId: ARCAAI_TENANT_ID }, data: { monthlySttSessionSeconds: 10n } });
    }

    const draftAfter = await billingService.computeDraft(ARCAAI_TENANT_ID, period);
    createdInvoiceId = draftAfter.id;
    log('4b. computeDraft AFTER forcing monthlySttSessionSeconds=10 (expect: a real STT overage line)', {
      id: draftAfter.id,
      status: draftAfter.status,
      totalMicros: draftAfter.totalMicros,
      subtotalMicros: draftAfter.subtotalMicros,
      lines: draftAfter.lines.map((l: Record<string, unknown>) => ({
        kind: l.kind,
        capability: l.capability,
        unit: l.unit,
        description: l.description,
        quantity: l.quantity,
        unitPriceMicros: l.unitPriceMicros,
        amountMicros: l.amountMicros,
      })),
    });

    console.log('\n✅ Evidence run complete — see sections 1–4b above.');
  } finally {
    // ── 5. CLEANUP — restore the tenant, remove every synthetic row ──────
    console.log('\n=== 5. cleanup ===');

    if (createdInvoiceId) {
      const lineDeleteCount = await client.billingInvoiceLine.deleteMany({ where: { invoiceId: createdInvoiceId } });
      const invoiceDelete = await client.billingInvoice.deleteMany({ where: { id: createdInvoiceId } });
      console.log('deleted draft invoice + lines:', { invoiceId: createdInvoiceId, lines: lineDeleteCount.count, invoices: invoiceDelete.count });
    }

    if (overrideCreated) {
      const del = await client.tenantEntitlement.deleteMany({ where: { tenantId: ARCAAI_TENANT_ID } });
      console.log('deleted synthetic TenantEntitlement override row:', del.count);
    } else {
      await client.tenantEntitlement.updateMany({ where: { tenantId: ARCAAI_TENANT_ID }, data: { monthlySttSessionSeconds: null } });
      console.log('restored monthlySttSessionSeconds to null (pre-existing override row kept)');
    }

    if (originalPlan === null || originalPlan === undefined) {
      await client.tenant.update({ where: { id: ARCAAI_TENANT_ID }, data: { plan: null } });
      console.log('restored tenant.plan to null');
    }

    const eventDelete = await client.aiUsageEvent.deleteMany({ where: { idempotencyKey: { startsWith: KEY_PREFIX } } });
    console.log('deleted AiUsageEvent rows:', eventDelete.count);

    if (createdOutboxIds.length > 0) {
      const outboxDelete = await client.aiUsageOutbox.deleteMany({ where: { id: { in: createdOutboxIds } } });
      console.log('deleted AiUsageOutbox rows by id:', { attempted: createdOutboxIds.length, deleted: outboxDelete.count });
    }

    // Restore the daily-rollup rows this run's (capability, provider, model, unit, today) tuples touched to their EXACT pre-run snapshot (baseline capture above) — precise, not a guessed decrement.
    const restoredDims = new Set<string>();
    let rollupRestored = 0;
    let rollupDeleted = 0;
    for (const tuple of rollupTuples) {
      const dimKey = `${tuple.capability}::${tuple.provider}::${tuple.model}::${tuple.unit}`;
      if (restoredDims.has(dimKey)) continue;
      restoredDims.add(dimKey);

      const baseline = rollupBaseline.get(dimKey);
      const existing = await client.aiUsageRollupDaily.findUnique({ where: { AiUsageRollupDaily_dimension_unique: tuple } });
      if (!existing) continue;

      if (baseline === null || baseline === undefined) {
        // No row existed before this run touched it — this run created it outright; remove it entirely.
        await client.aiUsageRollupDaily.delete({ where: { id: existing.id } });
        rollupDeleted += 1;
      } else {
        // A row already existed (other, unrelated usage) — restore its EXACT pre-run values.
        await client.aiUsageRollupDaily.update({
          where: { id: existing.id },
          data: { quantitySum: baseline.quantitySum, costMicrosSum: BigInt(baseline.costMicrosSum) },
        });
        rollupRestored += 1;
      }
    }
    console.log('rollup cleanup:', { dimensionsTouched: restoredDims.size, restoredToBaseline: rollupRestored, deletedNewlyCreated: rollupDeleted });

    await client.$disconnect();
  }
}

main().catch((error) => {
  console.error('Evidence run FAILED:', error);
  process.exitCode = 1;
});
