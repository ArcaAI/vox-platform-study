/**
 * Backfill `GateEditExemplar.structureAfter` for rows mined before the column existed (TASK-1062 D-3).
 *
 * WHY
 * ---
 * The few-shot retriever now reads ONLY `structureAfter` — the structure-only skeleton of the
 * signed note (`toStructureOnlyExemplar`, TASK-1061 OD-2), written at save time. A row mined before
 * the column existed has `structureAfter IS NULL` and is skipped by retrieval until this script
 * fills it from the row's own `redactedAfter`. `redactedAfter` is never modified: the SME corpus,
 * fine-tune and golden-case exports keep reading it.
 *
 * WHAT IT TOUCHES
 * ---------------
 * `GateEditExemplar` rows with `structureAfter IS NULL AND redactedAfter IS NOT NULL` (optionally
 * one tenant). Each gets `structureAfter = toStructureOnlyExemplar(redactedAfter)` — the same
 * transform the save path uses — plus an `updatedBy` stamp. `_version` is NOT bumped: the column is
 * derived and no curator decides on it, so a bump would only 412 a curation already in flight.
 *
 * SAFETY
 * ------
 *   - DRY RUN IS THE DEFAULT (`--dry-run` says so explicitly). Nothing is written without `--apply`.
 *   - Each write is a compare-and-set on `structureAfter IS NULL`, so a row saved (with its own
 *     structure) between the plan and the write is left alone.
 *   - Idempotent BY CONSTRUCTION: a filled row no longer matches the selection, so a second run
 *     finds nothing and exits 0. A partial run is resumed by running it again.
 *   - The plan printout carries ids only — never note text.
 *
 * USAGE
 * -----
 *   # 1. dry run (default) — prints the plan, writes nothing
 *   NODE_ENV=development pnpm --filter @arcaai/database exec tsx scripts/backfill-exemplar-structure-after.ts
 *
 *   # 2. scope to one tenant, then apply
 *   ... tsx scripts/backfill-exemplar-structure-after.ts --tenant <tenantId> --apply
 *
 * Against a remote database, set DATABASE_URL explicitly.
 *
 * Exit codes: 0 success (or nothing to do) · 1 runtime error · 2 bad invocation.
 */
// The transform is a dependency-free pure module owned by the gate-edit-mining service; importing it
// keeps ONE definition of "structure only" for the save path and this backfill (precedent:
// scripts/regen-workflow-seeds.ts imports from applications/src the same way).
import { toStructureOnlyExemplar } from '../../applications/src/services/gate-edit-mining/exemplar-structure';
// eslint-disable-next-line no-restricted-imports -- scripts/** allow-list: maintenance task must see every tenant's rows
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';

/** System user — the audit actor for unattended maintenance writes (seed/00-constants.ts). */
const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

export interface TargetExemplar {
  id: string;
  tenantId: string;
  redactedAfter: string | null;
}

export interface BackfillClient {
  gateEditExemplar: {
    findMany(args: unknown): Promise<TargetExemplar[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface BackfillOptions {
  apply: boolean;
  tenantId: string | null;
}

export interface BackfillPlanRow {
  id: string;
  tenantId: string;
  structureAfter: string;
}

/** Read-only: every row still missing `structureAfter`, with the skeleton it should get. */
export async function planBackfill(client: BackfillClient, opts: BackfillOptions): Promise<BackfillPlanRow[]> {
  const rows = await client.gateEditExemplar.findMany({
    where: {
      structureAfter: null,
      redactedAfter: { not: null },
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
    select: { id: true, tenantId: true, redactedAfter: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows
    .filter((row) => !!row.redactedAfter)
    .map((row) => ({ id: row.id, tenantId: row.tenantId, structureAfter: toStructureOnlyExemplar(row.redactedAfter as string) }));
}

/** Write each planned skeleton, compare-and-set on `structureAfter IS NULL`. Returns rows written. */
export async function applyBackfill(client: BackfillClient, plan: BackfillPlanRow[]): Promise<number> {
  let count = 0;
  for (const row of plan) {
    const result = await client.gateEditExemplar.updateMany({
      where: { id: row.id, structureAfter: null },
      data: { structureAfter: row.structureAfter, updatedBy: SYSTEM_USER_ID },
    });
    count += result.count;
  }
  return count;
}

export function parseArgs(argv: string[]): BackfillOptions {
  const opts: BackfillOptions = { apply: false, tenantId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--dry-run') {
      opts.apply = false;
    } else if (arg === '--tenant') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('--tenant requires a tenant id');
        process.exit(2);
      }
      opts.tenantId = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: backfill-exemplar-structure-after.ts [--tenant <tenantId>] [--dry-run | --apply]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (argv.includes('--apply') && argv.includes('--dry-run')) {
    console.error('--apply and --dry-run are mutually exclusive');
    process.exit(2);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CorePrismaClient structurally satisfies BackfillClient for the fields used
  const prisma = getPlatformAdminPrismaClient_Unscoped() as any as BackfillClient;

  console.log('===== backfill GateEditExemplar.structureAfter (TASK-1062 D-3) =====');
  console.log(`mode   : ${opts.apply ? 'APPLY' : 'DRY RUN (default — no writes)'}`);
  console.log(`tenant : ${opts.tenantId ?? 'ALL'}`);

  const plan = await planBackfill(prisma, opts);

  console.log(`\n----- rows missing structureAfter: ${plan.length} -----`);
  for (const row of plan) {
    // Ids and sizes only — the skeleton carries no facts, but there is no reason to print it.
    console.log(`  ${row.tenantId}  exemplar=${row.id}  structure=${row.structureAfter.length} chars`);
  }

  if (plan.length === 0) {
    console.log('\nNothing to do — every exemplar already carries structureAfter.');
    return;
  }

  if (!opts.apply) {
    console.log(`\nDRY RUN — no rows were modified. Re-run with --apply to fill these ${plan.length} row(s).`);
    return;
  }

  const applied = await applyBackfill(prisma, plan);
  console.log(`\nAPPLIED — wrote structureAfter on ${applied} of ${plan.length} planned row(s).`);
}

// Main-module guard so unit tests can import the helpers without running (mirrors
// backfill-context-item-media-id.ts — `require.main === module` is unreliable under tsx).
const invokedDirectly = typeof process.argv[1] === 'string' && /backfill-exemplar-structure-after/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('BACKFILL EXEMPLAR STRUCTURE AFTER FAILED:', err);
    process.exit(1);
  });
}
