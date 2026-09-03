/**
 * Clear the inert per-department pre-summary overrides.
 *
 * WHY
 * ---
 * Before, `Department.preSummaryPromptId` selected the
 * pre-summary prompt for that department. Phase 1 established that pre-summary
 * has NO department axis: `PromptResolutionService.resolvePreSummaryPromptId()`
 * explicitly records `trace.departmentPromptId = null` and never reads the
 * column. The chain is now
 *
 *     department default agent (only when the caller passes a departmentId)
 *       → tenant TENANT_DEFAULT template (departmentId null, APPROVED, ENABLED,
 *         tagged 'pre-summary', surface-tag matched)
 *       → the SYSTEM pre-summary default for the requested surface
 *       → 503 (fail closed).
 *
 * Every row still carrying `preSummaryPromptId` is therefore leftover
 * configuration that changes nothing but reads to an admin as though it does —
 * the admin console's Fallbacks tab surfaces them as "Legacy per-department
 * pre-summary". This script clears them.
 *
 * WHAT IT TOUCHES
 * ---------------
 * ONLY `Department.preSummaryPromptId` → NULL (plus the standard `_version`
 * bump and `updatedBy`/`updatedAt` audit stamp). It NEVER deletes a row, never
 * touches a PromptTemplate, and never touches `newPatientPromptId` /
 * `revisitPromptId` (those DO still drive the summary chain).
 *
 * SAFETY
 * ------
 *   - DRY RUN IS THE DEFAULT. Nothing is written unless `--apply` is passed.
 *   - All writes run inside a single interactive transaction; any error rolls
 *     the whole batch back.
 *   - Idempotent: a second run finds zero rows and exits 0.
 *   - Prints a read-only pre-flight showing, per tenant, which template (if any)
 *     satisfies the tier-1 pre-summary predicate — so an operator can see
 *     BEFORE clearing anything whether a tenant would fail closed.
 *
 * USAGE
 * -----
 *   # 1. dry run (default) — prints the plan, writes nothing
 *   NODE_ENV=development pnpm --filter @arcaai/database exec \
 *     tsx scripts/clear-stale-pre-summary-overrides.ts
 *
 *   # 2. scope to one tenant while reviewing
 *   ... tsx scripts/clear-stale-pre-summary-overrides.ts --tenant 50000000-0000-0000-0000-000000000000
 *
 *   # 3. apply, after the dry-run output has been reviewed
 *   ... tsx scripts/clear-stale-pre-summary-overrides.ts --apply
 *
 * Against a remote database, set DATABASE_URL explicitly.
 *
 * Exit codes: 0 success (or nothing to do) · 1 runtime error · 2 bad invocation.
 */
// eslint-disable-next-line no-restricted-imports -- scripts/** allow-list: maintenance task must see every tenant's rows
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';

/** The tag that marks a template as a tenant's pre-summary prompt (mirrors PromptResolutionService). */
const PRE_SUMMARY_TEMPLATE_TAG = 'pre-summary';
/** Surface discriminator for the department-free fork (mirrors PRE_SUMMARY_SURFACE_TAG). */
const DEPT_FREE_SURFACE_TAG = 'dept-free';
/** System user — the audit actor for unattended maintenance writes (seed/00-constants.ts). */
const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

interface Options {
  apply: boolean;
  tenantId: string | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { apply: false, tenantId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--tenant') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('--tenant requires a tenant id');
        process.exit(2);
      }
      opts.tenantId = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: clear-stale-pre-summary-overrides.ts [--tenant <tenantId>] [--apply]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = getPlatformAdminPrismaClient_Unscoped();

  const mode = opts.apply ? 'APPLY' : 'DRY RUN (default — no writes)';
  console.log(`===== D-22 — stale pre-summary overrides =====`);
  console.log(`mode   : ${mode}`);
  console.log(`tenant : ${opts.tenantId ?? 'ALL'}`);

  // ---------------------------------------------------------------- pre-flight
  // Read-only: which template satisfies the tier-1 predicate, per tenant.
  const tenants = await prisma.tenant.findMany({
    where: opts.tenantId ? { id: opts.tenantId } : {},
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  console.log('\n----- tier-1 pre-summary candidates (read-only) -----');
  for (const tenant of tenants) {
    const candidates = await prisma.promptTemplate.findMany({
      where: {
        tenantId: tenant.id,
        scope: 'TENANT_DEFAULT',
        status: 'APPROVED',
        departmentId: null,
        resourceStatus: 'ENABLED',
        tags: { has: PRE_SUMMARY_TEMPLATE_TAG },
        NOT: { tags: { has: DEPT_FREE_SURFACE_TAG } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    });
    const resolved = candidates[0];
    const suffix = candidates.length > 1 ? `  ⚠ ${candidates.length} candidates — resolver takes the oldest` : '';
    console.log(
      `  ${tenant.name} (${tenant.id}): ${resolved ? `${resolved.name} [${resolved.id}]` : 'NONE → falls through to the SYSTEM default'}${suffix}`,
    );
    for (const extra of candidates.slice(1)) console.log(`      also matching: ${extra.name} [${extra.id}]`);
  }

  // ------------------------------------------------------------------- targets
  const stale = await prisma.department.findMany({
    where: {
      preSummaryPromptId: { not: null },
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
    orderBy: [{ tenantId: 'asc' }, { code: 'asc' }],
    select: { id: true, tenantId: true, code: true, name: true, preSummaryPromptId: true, version: true },
  });

  console.log(`\n----- departments carrying an inert preSummaryPromptId: ${stale.length} -----`);
  for (const dept of stale) {
    console.log(`  ${dept.tenantId}  ${dept.code.padEnd(6)} ${dept.name.padEnd(24)} ${dept.preSummaryPromptId} → NULL  (id ${dept.id}, _version ${dept.version})`);
  }

  if (stale.length === 0) {
    console.log('\nNothing to do — already clean.');
    await prisma.$disconnect();
    return;
  }

  if (!opts.apply) {
    console.log(`\nDRY RUN — no rows were modified. Re-run with --apply to clear these ${stale.length} override(s).`);
    await prisma.$disconnect();
    return;
  }

  // --------------------------------------------------------------------- apply
  // One interactive transaction: either every override clears or none does.
  // The `preSummaryPromptId: { not: null }` guard on each update makes a
  // concurrent clear a no-op rather than a spurious version bump.
  const cleared = await prisma.$transaction(async (tx) => {
    let count = 0;
    for (const dept of stale) {
      const result = await tx.department.updateMany({
        where: { id: dept.id, preSummaryPromptId: { not: null } },
        data: {
          preSummaryPromptId: null,
          version: { increment: 1 },
          updatedBy: SYSTEM_USER_ID,
        },
      });
      count += result.count;
    }
    return count;
  });

  const remaining = await prisma.department.count({
    where: { preSummaryPromptId: { not: null }, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) },
  });

  console.log(`\nAPPLIED — cleared ${cleared} override(s); ${remaining} remaining in scope (expected 0).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('CLEAR STALE PRE-SUMMARY OVERRIDES FAILED:', err);
  process.exit(1);
});
