/**
 * TASK-732 Phase 1 Task 2 — missing-note rate + unverified-note harm-proxy instrumentation.
 *
 * WHAT THIS IS
 * ------------
 * The Postgres half of the go/no-go measurement `docs/implementation/TASK-732-Legacy-Migration-
 * Deletion/go-no-go-thresholds.md` defines. It is the sibling of `scripts/harness-availability-
 * report.py` (TASK-730 Task 4, Temporal-side: duplicate-execution counts + the 5xx/latency PromQL
 * to paste into Prometheus). That script answers "is the harness reliable when used?"; this one
 * answers "how often does a consultation come away with NO note at all, and how often does the
 * LEGACY path's floor flag a note it did generate?" Read the go-no-go-thresholds.md document
 * alongside this file — the formulas, their justification, and what each number does NOT measure
 * live there, not here.
 *
 * READ-ONLY: every query below is a SELECT/aggregate. No writes, no `--apply` flag exists.
 *
 * WHAT THIS SCRIPT DOES NOT DO (stated plainly, per this ticket's honesty requirement):
 *   - It does NOT attribute a missing note to "legacy" vs "harness" — that attribution needs a
 *     join against Temporal's own execution list (`harness-doc-{consultationId}`, which
 *     `scripts/harness-availability-report.py` already produces) or the `PipelinePolicy` cascade
 *     value AT THE TIME OF GENERATION, which is not persisted per-row anywhere. Cross-referencing
 *     both reports' consultation ids by hand (or a follow-on script, if this becomes a repeated
 *     measurement rather than a one-off) is how the sub-counters in the go-no-go document that
 *     need generator attribution — (a) Temporal unreachable, (b) workflow started but never
 *     completed — get their real numbers. This script reports the un-attributed top-line rate,
 *     which is exactly the quantity the ticket's Task 2 formula defines (numerator/denominator
 *     over ALL consultations that reached capture-stop, regardless of which generator was
 *     supposed to produce the note).
 *   - It does NOT compute the groundedness half of the "primary" harm-proxy
 *     (`guardrailDecisions.groundedness`). That field is Vault-Transit ciphertext only —
 *     `SummaryMeta`'s plaintext `guardrailDecisions` JSONB column was dropped (Data Encryption
 *     Initiative Phase 3D) — decrypting it per row needs a live Vault Transit client this
 *     Prisma-only script does not carry. `gateDecision` (also part of the "primary" proxy) IS
 *     plaintext and IS computed here. See go-no-go-thresholds.md §2 for the cost tradeoff.
 *   - It does NOT run the TASK-713 judge over a sample of signed notes (the "strongest" proxy).
 *     That is out of this pass's scope by the ticket's own design — recommended, not built.
 *
 * DATA SOURCES
 * ------------
 *   - `AuditLog` (resourceType=Consultation, action=UPDATE, data.action='stopRecording') — the
 *     ONLY persisted timestamp for "a consultation reached capture-stop" that exists in the
 *     schema today. `Consultation.status` is a mutable current-state column (TASK-711's DRAINING
 *     value exists in the enum but has ZERO non-test runtime readers as of this pass — grep
 *     confirmed, see go-no-go-thresholds.md §1 — so there is no DRAINING-transition timestamp to
 *     read yet); `Consultation.updatedAt` gets overwritten by every later transition, so it
 *     cannot answer "when did THIS consultation stop recording" retrospectively. AuditLog's
 *     `ResourceUpdated` event for `stopRecording` (`consultation.service.ts` `setRecordingStatus`)
 *     is the one row with both an immutable per-event timestamp and the specific action name.
 *   - `ContextItem` (type=RAW_SUMMARY) — the note-produced signal.
 *   - `SummaryMeta.gateDecision` — plaintext, the primary harm-proxy's flag half.
 *   - `HarnessAuditEvent.action` (SIGNED_BEFORE_ASSURANCE, ATTEST) — plaintext, the secondary
 *     harm-proxy.
 *
 * USAGE
 * -----
 *   NODE_ENV=development pnpm --filter @arcaai/database exec \
 *     tsx scripts/harness-migration-readiness-report.ts
 *   ... --since-days 90 --sla-minutes 15 --tenant-id <uuid> --json report.json
 */
// eslint-disable-next-line no-restricted-imports -- scripts/** allow-list: cross-tenant aggregate report, no tenant CLS context exists outside a request
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';

export interface ReportOptions {
  sinceDays: number;
  slaMinutes: number;
  tenantId?: string;
  jsonPath?: string;
}

export function parseArgs(argv: string[]): ReportOptions {
  const opts: ReportOptions = { sinceDays: 90, slaMinutes: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--since-days') {
      opts.sinceDays = Number(argv[++i]);
    } else if (arg === '--sla-minutes') {
      opts.slaMinutes = Number(argv[++i]);
    } else if (arg === '--tenant-id') {
      opts.tenantId = argv[++i];
    } else if (arg === '--json') {
      opts.jsonPath = argv[++i];
    }
  }
  if (!Number.isFinite(opts.sinceDays) || opts.sinceDays <= 0) {
    throw new Error(`--since-days must be a positive number, got: ${argv.join(' ')}`);
  }
  if (!Number.isFinite(opts.slaMinutes) || opts.slaMinutes <= 0) {
    throw new Error(`--sla-minutes must be a positive number, got: ${argv.join(' ')}`);
  }
  return opts;
}

export interface MissingNoteRateResult {
  denominatorCaptureStopEvents: number;
  numeratorMissingWithinSla: number;
  rate: number | null;
  slaMinutes: number;
  /** Consultation ids whose capture-stop had no RAW_SUMMARY within the SLA — for manual
   *  cross-reference against harness-availability-report.py's Temporal execution list. */
  missingConsultationIds: string[];
}

export interface HarmProxyResult {
  gateDecisionFlag: {
    denominatorEvaluated: number;
    numeratorFlagged: number;
    rate: number | null;
  };
  signedBeforeAssurance: {
    denominatorSigned: number;
    numeratorAnnotated: number;
    rate: number | null;
  };
}

/** Minimal shape this script needs from the unscoped Prisma client — kept narrow so it is easy
 * to see exactly what surface is exercised (mirrors the narrow `BackfillClient` pattern in
 * `backfill-context-item-media-id.ts`). */
export interface ReadinessReportClient {
  auditLog: {
    findMany: (args: unknown) => Promise<Array<{ resourceId: string | null; createdAt: Date }>>;
  };
  contextItem: {
    findMany: (args: unknown) => Promise<Array<{ consultationId: string; createdAt: Date }>>;
  };
  summaryMeta: {
    count: (args: unknown) => Promise<number>;
  };
  harnessAuditEvent: {
    count: (args: unknown) => Promise<number>;
  };
}

export async function computeMissingNoteRate(client: ReadinessReportClient, opts: ReportOptions, since: Date): Promise<MissingNoteRateResult> {
  const stopEvents = await client.auditLog.findMany({
    where: {
      resourceType: 'Consultation',
      action: 'UPDATE',
      createdAt: { gte: since },
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      data: { path: ['action'], equals: 'stopRecording' },
    },
    select: { resourceId: true, createdAt: true },
  });

  const denominator = stopEvents.length;
  const missingIds: string[] = [];

  for (const stop of stopEvents) {
    if (!stop.resourceId) continue;
    const slaEnd = new Date(stop.createdAt.getTime() + opts.slaMinutes * 60_000);
    const drafts = await client.contextItem.findMany({
      where: {
        consultationId: stop.resourceId,
        type: 'RAW_SUMMARY',
        createdAt: { gte: stop.createdAt, lte: slaEnd },
      },
      select: { consultationId: true, createdAt: true },
    });
    if (drafts.length === 0) {
      missingIds.push(stop.resourceId);
    }
  }

  return {
    denominatorCaptureStopEvents: denominator,
    numeratorMissingWithinSla: missingIds.length,
    rate: denominator > 0 ? missingIds.length / denominator : null,
    slaMinutes: opts.slaMinutes,
    missingConsultationIds: missingIds,
  };
}

export async function computeHarmProxy(client: ReadinessReportClient, opts: ReportOptions, since: Date): Promise<HarmProxyResult> {
  const tenantFilter = opts.tenantId ? { tenantId: opts.tenantId } : {};

  const evaluated = await client.summaryMeta.count({
    where: { ...tenantFilter, gateDecision: { not: null }, createdAt: { gte: since } },
  });
  const flagged = await client.summaryMeta.count({
    where: { ...tenantFilter, gateDecision: 'FLAG', createdAt: { gte: since } },
  });

  const signed = await client.harnessAuditEvent.count({
    where: { ...tenantFilter, action: 'ATTEST', createdAt: { gte: since } },
  });
  const annotated = await client.harnessAuditEvent.count({
    where: { ...tenantFilter, action: 'SIGNED_BEFORE_ASSURANCE', createdAt: { gte: since } },
  });

  return {
    gateDecisionFlag: {
      denominatorEvaluated: evaluated,
      numeratorFlagged: flagged,
      rate: evaluated > 0 ? flagged / evaluated : null,
    },
    signedBeforeAssurance: {
      denominatorSigned: signed,
      numeratorAnnotated: annotated,
      rate: signed > 0 ? annotated / signed : null,
    },
  };
}

function formatPct(rate: number | null): string {
  return rate === null ? 'n/a (zero denominator)' : `${(rate * 100).toFixed(2)}%`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000);

  // eslint-disable-next-line no-restricted-imports -- scripts/** allow-list, see module docstring
  const prisma = getPlatformAdminPrismaClient_Unscoped() as unknown as ReadinessReportClient;

  const missingNote = await computeMissingNoteRate(prisma, opts, since);
  const harmProxy = await computeHarmProxy(prisma, opts, since);

  console.log('===== TASK-732 migration readiness report =====');
  console.log(`Generated:   ${new Date().toISOString()}`);
  console.log(`Window:      last ${opts.sinceDays} days (since ${since.toISOString()})`);
  console.log(`SLA:         ${opts.slaMinutes} minutes`);
  console.log(`Tenant:      ${opts.tenantId ?? '(all tenants)'}`);
  console.log('');
  console.log('--- Missing-note rate (Task 2 formula, un-attributed to generator — see docstring) ---');
  console.log(`capture-stop events (denominator): ${missingNote.denominatorCaptureStopEvents}`);
  console.log(`missing within SLA (numerator):    ${missingNote.numeratorMissingWithinSla}`);
  console.log(`rate:                              ${formatPct(missingNote.rate)}`);
  if (missingNote.missingConsultationIds.length > 0) {
    console.log(`missing consultation ids (cross-reference against Temporal executions):`);
    console.log(`  ${missingNote.missingConsultationIds.join(', ')}`);
  }
  console.log('');
  console.log('--- Harm proxy, primary half: SummaryMeta.gateDecision FLAG rate (across all generators) ---');
  console.log(`evaluated (denominator): ${harmProxy.gateDecisionFlag.denominatorEvaluated}`);
  console.log(`flagged (numerator):     ${harmProxy.gateDecisionFlag.numeratorFlagged}`);
  console.log(`rate:                    ${formatPct(harmProxy.gateDecisionFlag.rate)}`);
  console.log('(NOTE: the groundedness half of the primary proxy is NOT included — see docstring.)');
  console.log('');
  console.log('--- Harm proxy, secondary: SIGNED_BEFORE_ASSURANCE annotation rate over signed notes ---');
  console.log(`signed (denominator, ATTEST events):        ${harmProxy.signedBeforeAssurance.denominatorSigned}`);
  console.log(`SIGNED_BEFORE_ASSURANCE (numerator):        ${harmProxy.signedBeforeAssurance.numeratorAnnotated}`);
  console.log(`rate:                                       ${formatPct(harmProxy.signedBeforeAssurance.rate)}`);

  if (opts.jsonPath) {
    const fs = await import('node:fs');
    fs.writeFileSync(opts.jsonPath, JSON.stringify({ options: opts, since: since.toISOString(), missingNote, harmProxy }, null, 2));
    console.log(`\nJSON report written to ${opts.jsonPath}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- $disconnect exists on the real PrismaClient; the narrow interface above deliberately omits it
  await (prisma as any).$disconnect?.();
}

// Main-module guard so unit tests can import the pure helpers without running
// (mirrors decrypt-row.ts / backfill-context-item-media-id.ts — `require.main === module`
// is unreliable under tsx/ESM).
const invokedDirectly = typeof process.argv[1] === 'string' && /harness-migration-readiness-report/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('READINESS REPORT FAILED:', err);
    process.exit(1);
  });
}
