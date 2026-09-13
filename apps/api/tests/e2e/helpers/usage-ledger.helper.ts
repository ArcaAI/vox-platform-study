/**
 * Reading the usage ledger from an e2e spec (TASK-959).
 *
 * ============================================================================
 * WHY A DATABASE READ AND NOT AN HTTP ASSERTION
 * ============================================================================
 * There is no HTTP route that returns a ledger ROW. `GET admin/usage/summary`
 * answers the ROLLUPS, which exist only after the outbox drainer has run, and
 * the drainer is a scheduled job whose cadence a spec must not depend on. The
 * contract these specs exist to pin — which UNITS a call produces, what rides
 * on each unit's `attributesJson`, and which cost basis each row carries — is
 * the emitter's output, and the only place that output is observable
 * synchronously is `AiUsageOutbox`. `task-615-usage-ledger.spec.ts` and
 * `task-890-metering.spec.ts` both document and use the same fallback.
 *
 * ============================================================================
 * THE PAYLOAD SHAPE — `events[]`, ALREADY EXPANDED, NEVER `units[]`
 * ============================================================================
 * An emitter builds a BATCH (`{ common, units }`), but nothing of that shape
 * reaches the database. `UsageLedgerService.recordUsage` runs `expandUsageBatch`
 * first, which flattens the batch into one FULL event per unit —
 * `idempotencyKey` gains `:<UNIT>`, and the per-unit `attributesJson` is merged
 * OVER the common one — and writes
 *
 *     payload = { version, events: SerializedUsageEvent[] }
 *
 * with `quantity` already a decimal STRING on every row. So a reader looks for
 * `payload.events[]`, and a reader that looks for `payload.common` or
 * `payload.units` matches nothing at all, on any row, ever. That is not
 * hypothetical: `task-890-metering.spec.ts`'s private `outboxSince` read
 * `payload?.common ?? payload`, which resolved to the envelope, whose
 * `tenantId` is `undefined`, so its own tenant filter dropped every row. FIXED
 * (TASK-959 FU-2): that spec now reads through `ledgerRowsSince` below, so the
 * payload shape is asserted in ONE place and a future change to
 * `expandUsageBatch` breaks one reader rather than silently emptying another.
 * The bug survived as long as it did because that spec skips before it reads
 * anything whenever `apps/text` is unreachable — a reader that matches nothing
 * and a reader that never runs are indistinguishable from the report.
 *
 * ============================================================================
 * MATCH ON AN IDENTITY YOU MINTED, NOT ON A TIMESTAMP
 * ============================================================================
 * `since` narrows the scan; it is never the whole predicate. Two specs running
 * in parallel (Playwright's default) write into the same tenant in the same
 * second, and the suite's clock and Postgres's clock are not the same clock.
 * Every caller here therefore also matches on something it generated itself —
 * a session id, an idempotency-key prefix — so a sibling spec's rows can be
 * neither mistaken for its own nor able to make its assertion pass.
 */
import { join } from 'path';
import { pathToFileURL } from 'url';

/** One expanded ledger row, exactly as `serializeUsageEvent` wrote it. */
export interface LedgerRow {
  tenantId: string;
  idempotencyKey: string;
  occurredAt: string;
  capability: string;
  operation: string;
  provider: string;
  model: string | null;
  deployment: string;
  unit: string;
  /** ALWAYS a string on the wire — a JSON number is an IEEE double (§10.2). */
  quantity: string;
  costBasis: string;
  connectionId: string | null;
  consultationId: string | null;
  doctorId: string | null;
  departmentId: string | null;
  requestId: string | null;
  sessionId: string | null;
  attributesJson: Record<string, unknown> | null;
  /** The outbox row that carried it — a batch's rows share one. */
  outboxId: string;
}

interface OutboxRecord {
  id: string;
  createdAt: Date;
  payload: unknown;
}

interface DbClient {
  aiUsageOutbox: {
    findMany(args: { where: Record<string, unknown>; orderBy?: unknown }): Promise<OutboxRecord[]>;
  };
  $disconnect(): Promise<void>;
}

let dbClient: DbClient | null = null;

/**
 * The UNSCOPED platform client — the ledger is a platform-wide table and this
 * reader deliberately sees every tenant's rows so a cross-tenant assertion can
 * be written. Loaded from the built `dist` (not `src`) because Playwright runs
 * these specs through its own transform, which does not compile the workspace.
 */
async function getDb(): Promise<DbClient> {
  if (!dbClient) {
    const distEntry = pathToFileURL(join(__dirname, '../../../../../packages/database/dist/index.js')).href;
    const mod = (await import(distEntry)) as { getPlatformAdminPrismaClient_Unscoped(): unknown };
    dbClient = mod.getPlatformAdminPrismaClient_Unscoped() as DbClient;
  }
  return dbClient;
}

/** Release the connection so a Playwright worker can exit instead of hanging on an open pool. */
export async function closeLedgerDb(): Promise<void> {
  if (!dbClient) return;
  const client = dbClient;
  dbClient = null;
  await client.$disconnect();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Every ledger row written since `since`, newest outbox row first.
 *
 * `since` is widened by five seconds: the spec's clock and Postgres's clock are
 * independent, and a row lost to a 300 ms skew reads exactly like an emitter
 * that never fired — the one confusion these specs must not create. Narrowing
 * back to the caller's own rows is the caller's job (see the header).
 */
export async function ledgerRowsSince(since: Date, filter: { tenantId?: string } = {}): Promise<LedgerRow[]> {
  const db = await getDb();
  const rows = await db.aiUsageOutbox.findMany({
    where: {
      createdAt: { gte: new Date(since.getTime() - 5_000) },
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  const ledgerRows: LedgerRow[] = [];
  for (const row of rows) {
    const payload = asRecord(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload);
    const events = Array.isArray(payload?.events) ? payload.events : [];
    for (const event of events) {
      const record = asRecord(event);
      if (!record) continue;
      ledgerRows.push({ ...(record as unknown as LedgerRow), outboxId: row.id });
    }
  }
  return ledgerRows;
}

/**
 * Poll until at least `minimum` rows match, then return EVERY matching row.
 *
 * Emission is fire-and-forget — the gateway answers the caller before (or
 * while) it writes — so a read taken the instant the response lands is a race,
 * not a result. Returning all matches rather than the first is what lets a
 * caller assert about a batch as a whole ("these three units and no fourth"),
 * which is the shape most of §2.1 is stated in.
 *
 * The failure message names what WAS seen. A bare "timed out" sends the reader
 * to the poll loop; the units that did land send them to the emitter.
 */
export async function waitForLedgerRows(
  since: Date,
  match: (row: LedgerRow) => boolean,
  options: { label: string; minimum?: number; timeoutMs?: number; tenantId?: string },
): Promise<LedgerRow[]> {
  const { label, minimum = 1, timeoutMs = 20_000, tenantId } = options;
  const deadline = Date.now() + timeoutMs;
  let seen: LedgerRow[] = [];

  for (;;) {
    seen = await ledgerRowsSince(since, { tenantId });
    const matched = seen.filter(match);
    if (matched.length >= minimum) return matched;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(
    `[${label}] expected at least ${minimum} matching ledger row(s) within ${timeoutMs}ms; ` +
      `saw ${seen.length} row(s) since the mark: ${describe(seen)}`,
  );
}

/** A compact census for a failure message — operation/unit pairs, not a wall of JSON. */
export function describe(rows: LedgerRow[]): string {
  if (rows.length === 0) return 'none';
  return rows.map((row) => `${row.operation}/${row.unit}=${row.quantity}`).join(', ');
}

/** The compute units §2.1 defines. `device` is what decides WHICH of the two a row carries. */
export const COMPUTE_UNITS = ['GPU_SECOND', 'CPU_SECOND'] as const;
/** The two direction units — separate units so direction stays a ledger dimension (§2.1). */
export const BYTE_UNITS = ['EGRESS_BYTE', 'INGRESS_BYTE'] as const;

/** `cuda`/`mps` → `GPU_SECOND`, `cpu` → `CPU_SECOND` (§10.2). The rule, in one place. */
export function unitForDevice(device: string): string {
  return device === 'cuda' || device === 'mps' ? 'GPU_SECOND' : 'CPU_SECOND';
}

/** A decimal quantity string — never a JSON number, never empty, always parseable. */
export function isDecimalString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Number(value));
}

/**
 * The same unscoped client, for state no HTTP route can set.
 *
 * Used by `task-959-spend-limit.spec.ts` for exactly one column —
 * `TenantEntitlement.monthlySpendLimitMicros`, which the ticket's §7 F-4 gate
 * reads on four routes and which NO request DTO anywhere declares (see that
 * spec's header). A spec reaches for this only when the alternative is not
 * testing the behaviour at all, and it restores what it changed.
 *
 * Typed by the caller: the shape needed is one model wide, and importing
 * Prisma's generated types into a Playwright spec would drag the whole client
 * through its transform for no benefit.
 */
export async function platformDb<T>(): Promise<T> {
  return (await getDb()) as unknown as T;
}
