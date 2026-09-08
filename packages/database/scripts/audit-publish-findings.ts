/**
 * TASK-890 §4.4 proof #1 — run the NEW publish gate over everything that already exists.
 *
 * WHY
 * ---
 * `publishFindings` (TASK-890 §3.5) wires a gate that has never run: `workflowPublishProblems`
 * was complete, tested and called by nothing (BLOCKER 1c), and the per-node config SCHEMA check
 * was never run by anything at all. The moment `WorkflowDefinitionService.publishEntity` calls
 * it, every graph in the corpus meets a check it has never met.
 *
 * That is either a no-op or a data-migration task, and guessing which is not acceptable. This
 * script answers it BEFORE the merge: it runs the gate over every seeded graph and over every
 * `WorkflowDefinition.graph` row of whichever database it is pointed at, and prints the counts by
 * finding code. A non-empty ERROR count means real rows would stop republishing — that is a
 * migration to plan, not a surprise to discover at a tenant's next publish (Risk 3). The ERROR
 * counts are also what decides whether the first release keeps its `core.*`-only scope.
 *
 * WHAT IT TOUCHES
 * ---------------
 * NOTHING. It is a pure READ: `findMany` over `WorkflowDefinition`, plus in-memory seed graphs.
 * There is no `--apply`, because there is nothing to apply.
 *
 * USAGE
 * -----
 *   pnpm --filter @arcaai/workflow-contract build          # the dist this reads
 *   npx dotenv -e .env.dev -- tsx packages/database/scripts/audit-publish-findings.ts
 *
 *   # seeds only, no database (works with no DATABASE_URL at all)
 *   npx tsx packages/database/scripts/audit-publish-findings.ts --seeds-only
 *
 * `packages/database` takes no dependency on `@arcaai/workflow-contract` or
 * `@arcaai/json-schema-subset` (adding one edits the shared root lockfile — a collision surface
 * while sibling agents share this repo), so both are imported from their BUILT dist by relative
 * path, exactly as `regen-workflow-seeds.ts` does.
 */
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
import * as contract from '../../workflow-contract/dist/index.mjs';
import * as jsonSchemaSubset from '../../json-schema-subset/dist/index.mjs';
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';
import { WORKFLOW_LIBRARY_TARGETS } from '../src/prisma/db_main/seed/28-workflow-library';
import { ARCAAI_WORKFLOW_TARGETS } from '../src/prisma/db_main/seed/29-arcaai-agents-and-workflows';

const { publishFindings, TEMPLATE_REFERENCE_SEVERITY_RELEASE_1 } = contract as any;
const { jsonSchemaValueProblems } = jsonSchemaSubset as any;

interface Finding {
  code?: string;
  severity: 'ERROR' | 'WARNING';
  nodeId: string | null;
  message: string;
}

/**
 * The same context `WorkflowDefinitionService` passes today. The per-agent and context-schema
 * slots are deliberately unresolved: they need reads this script does not do, and the contract
 * SKIPS those checks rather than guessing — so an unresolved slot under-reports, never
 * over-reports. Anything this prints is real.
 */
function findingsFor(graph: unknown): Finding[] {
  return publishFindings(graph, {
    schemaValueProblems: jsonSchemaValueProblems,
    templateReferenceSeverity: TEMPLATE_REFERENCE_SEVERITY_RELEASE_1,
  }) as Finding[];
}

const SEED_GRAPHS: Array<[string, unknown]> = [...WORKFLOW_LIBRARY_TARGETS, ...ARCAAI_WORKFLOW_TARGETS].map((target) => [target.key, target.graph]);

function tally(counts: Map<string, number>, findings: Finding[]): void {
  for (const finding of findings) {
    const key = `${finding.severity}/${finding.code ?? 'UNCODED'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

function printTally(label: string, counts: Map<string, number>, subjects: number): void {
  const errors = [...counts].filter(([key]) => key.startsWith('ERROR/'));
  const warnings = [...counts].filter(([key]) => key.startsWith('WARNING/'));
  console.log(`\n=== ${label} — ${subjects} graph(s) ===`);
  if (counts.size === 0) {
    console.log('  clean: no findings of any severity');
    return;
  }
  for (const [key, count] of [...errors, ...warnings].sort()) console.log(`  ${key.padEnd(38)} ${count}`);
  console.log(`  -> ${errors.reduce((sum, [, n]) => sum + n, 0)} ERROR / ${warnings.reduce((sum, [, n]) => sum + n, 0)} WARNING`);
}

async function main(): Promise<number> {
  const seedsOnly = process.argv.includes('--seeds-only');

  const seedCounts = new Map<string, number>();
  let seedErrorGraphs = 0;
  for (const [label, graph] of SEED_GRAPHS) {
    const findings = findingsFor(graph);
    tally(seedCounts, findings);
    const errors = findings.filter((finding) => finding.severity === 'ERROR');
    if (errors.length > 0) {
      seedErrorGraphs += 1;
      console.log(`\n!! ${label}: ${errors.length} ERROR finding(s)`);
      for (const finding of errors) console.log(`   [${finding.code}] ${finding.nodeId ?? '(graph)'}: ${finding.message}`);
    }
  }
  printTally('SEEDED graphs', seedCounts, SEED_GRAPHS.length);

  if (seedsOnly) {
    console.log('\n(--seeds-only: the database was not read)');
    return seedErrorGraphs === 0 ? 0 : 1;
  }

  const prisma = getPlatformAdminPrismaClient_Unscoped();
  try {
    const rows = await prisma.workflowDefinition.findMany({
      select: { id: true, tenantId: true, slug: true, versionNumber: true, status: true, paletteKey: true, graph: true },
      orderBy: [{ slug: 'asc' }, { versionNumber: 'asc' }],
    });
    const rowCounts = new Map<string, number>();
    let rowErrorGraphs = 0;
    for (const row of rows) {
      const findings = findingsFor(row.graph);
      tally(rowCounts, findings);
      const errors = findings.filter((finding) => finding.severity === 'ERROR');
      if (errors.length === 0) continue;
      rowErrorGraphs += 1;
      console.log(
        `\n!! ${row.slug} v${row.versionNumber} (${row.status}, palette ${row.paletteKey}, tenant ${row.tenantId}): ${errors.length} ERROR finding(s)`,
      );
      for (const finding of errors) console.log(`   [${finding.code}] ${finding.nodeId ?? '(graph)'}: ${finding.message}`);
    }
    printTally('DATABASE WorkflowDefinition.graph rows', rowCounts, rows.length);
    console.log(`\nGraphs with at least one ERROR: ${seedErrorGraphs} seeded, ${rowErrorGraphs} of ${rows.length} rows.`);
    console.log(
      rowErrorGraphs === 0 && seedErrorGraphs === 0
        ? 'VERDICT: the new gate is a NO-OP on this corpus — nothing needs migrating.'
        : 'VERDICT: rows above would be REFUSED at their next publish — plan the migration before merging (Risk 3).',
    );
    return seedErrorGraphs === 0 && rowErrorGraphs === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(2);
  });
