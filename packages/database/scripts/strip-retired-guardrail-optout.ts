/**
 * Strip the RETIRED guardrail opt-out from stored `Agent` and `WorkflowDefinition` JSON.
 *
 * ## Why
 *
 * Owner decision OD-1 (2026-10-02) retired the per-agent / per-workflow / per-node guardrail
 * opt-out: platform guardrail screens every LLM call. The fields that carried it —
 * `Agent.parameters.guards.enabled` and `config.guardrail` on a workflow graph's `core.trigger` /
 * `core.agent` nodes — are gone from the vocabulary. For one release every parser ACCEPTS and
 * STRIPS them (`stripRetired*GuardrailOptOut*` in `@arcaai/workflow-contract`), so a stored value
 * is never honoured and never a 400. This script removes the stored copies so that release can
 * delete the strip.
 *
 * ## What it touches, and what it must not
 *
 * Only rows whose status is NOT `PUBLISHED` / `DEPRECATED`. Those two are immutable by database
 * trigger (`agent_immutability_guard`, `workflow_definition_immutability_guard`) — a published
 * version's bytes ARE the version. They are REPORTED, never written: the runtime already ignores
 * the field on them, and they shed it when a new version is branched and published.
 *
 * For a `WorkflowDefinition` the `graphChecksum` is recomputed exactly as the service computes it
 * (`sha256` over the contract's canonical JSON). A stale `compiledConfig` on a VALIDATED row is
 * left alone — the next publish recompiles it, and the compiler strips the field too.
 *
 * Idempotent: a second run finds nothing to change. Soft-deleted rows are skipped.
 *
 * ## Usage (build the contract first — this script imports its dist, like `regen-workflow-seeds.ts`)
 *
 *   pnpm --filter @arcaai/workflow-contract build
 *   npx dotenv -e .env.dev -- tsx packages/database/scripts/strip-retired-guardrail-optout.ts --dry-run
 *   npx dotenv -e .env.dev -- tsx packages/database/scripts/strip-retired-guardrail-optout.ts
 */
/* eslint-disable no-console, @typescript-eslint/no-explicit-any -- operator CLI: console is its output; raw JSON rows */
import { createHash } from 'node:crypto';
import * as contract from '../../workflow-contract/dist/index.mjs';
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';
import { SYSTEM_USER_ID } from '../src/prisma/db_main/seed/00-constants';

const { canonicalJson, stripRetiredAgentGuardrailOptOut, stripRetiredGraphGuardrailOptOuts } = contract as any;

const IMMUTABLE = new Set(['PUBLISHED', 'DEPRECATED']);

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const client = getPlatformAdminPrismaClient_Unscoped();
  console.log(`Retired guardrail opt-out strip${dryRun ? ' (DRY RUN)' : ''}\n`);

  try {
    // ── Agent.parameters.guards.enabled ─────────────────────────────────────────────────────
    const agents = await client.agent.findMany({
      where: { resourceStatus: { not: 'DELETED' } },
      select: { id: true, tenantId: true, slug: true, versionNumber: true, status: true, parameters: true },
    });
    let agentsStripped = 0;
    let agentsImmutable = 0;
    for (const agent of agents) {
      const stripped = stripRetiredAgentGuardrailOptOut(agent.parameters);
      if (stripped === agent.parameters) continue;
      const label = `${agent.tenantId}/${agent.slug}@v${agent.versionNumber} (${agent.status})`;
      if (IMMUTABLE.has(String(agent.status))) {
        console.log(`  agent   KEPT     ${label}: immutable — ignored at runtime, cleared by its next published version`);
        agentsImmutable += 1;
        continue;
      }
      console.log(`  agent   ${dryRun ? 'would strip' : 'strip'} ${label}`);
      agentsStripped += 1;
      if (!dryRun) {
        await client.agent.update({
          where: { id: agent.id },
          data: { parameters: stripped, version: { increment: 1 }, updatedBy: SYSTEM_USER_ID },
        });
      }
    }

    // ── WorkflowDefinition.graph nodes[].config.guardrail ───────────────────────────────────
    const definitions = await client.workflowDefinition.findMany({
      where: { resourceStatus: { not: 'DELETED' } },
      select: { id: true, tenantId: true, slug: true, versionNumber: true, status: true, graph: true },
    });
    let definitionsStripped = 0;
    let definitionsImmutable = 0;
    for (const definition of definitions) {
      const { graph, changed } = stripRetiredGraphGuardrailOptOuts(definition.graph);
      if (!changed) continue;
      const label = `${definition.tenantId}/${definition.slug}@v${definition.versionNumber} (${definition.status})`;
      if (IMMUTABLE.has(String(definition.status))) {
        console.log(`  workflow KEPT     ${label}: immutable — ignored at runtime, cleared by its next published version`);
        definitionsImmutable += 1;
        continue;
      }
      console.log(`  workflow ${dryRun ? 'would strip' : 'strip'} ${label}`);
      definitionsStripped += 1;
      if (!dryRun) {
        await client.workflowDefinition.update({
          where: { id: definition.id },
          data: {
            graph,
            graphChecksum: createHash('sha256').update(canonicalJson(graph)).digest('hex'),
            version: { increment: 1 },
            updatedBy: SYSTEM_USER_ID,
          },
        });
      }
    }

    console.log(
      `\nAgents: ${agentsStripped} ${dryRun ? 'to strip' : 'stripped'}, ${agentsImmutable} published/deprecated kept.` +
        `\nWorkflow definitions: ${definitionsStripped} ${dryRun ? 'to strip' : 'stripped'}, ${definitionsImmutable} published/deprecated kept.`,
    );
  } finally {
    await client.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
