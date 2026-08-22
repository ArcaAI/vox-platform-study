/**
 * TASK-790 W6 — regenerate the platform-default Summarization seed blobs from the REAL
 * `compile()` / `validate()` engine.
 *
 * ## Why this exists as a committed script rather than a one-off
 *
 * `21-workflow-definition.ts`'s own docstring says its blobs "are the literal output of
 * `packages/workflow-contract`'s real `validate()`/`compile()` engine, run against this exact node
 * set via a THROWAWAY script and pasted here verbatim". A throwaway script cannot be re-run, so
 * the blobs drifted the moment either the registry or the service's compile constants moved — and
 * they did, silently, in three separate ways (TASK-789 H-2 / TASK-790 W6):
 *
 *   - `compiledConfig.caps.maxNodeSeconds` = 900, while `WorkflowDefinitionService.DEFAULT_CAPS`
 *     stamps 600.
 *   - `compiledConfig.compilerVersion` = 'task-720-seed-1', while `COMPILER_VERSION` is '0.1.0'.
 *   - `registryChecksum` was computed over a SEVEN-entry registry that now has many more.
 *
 * So a republish of the seeded row would produce a materially different `compiledConfig` than the
 * one seeded. Making the regeneration reproducible is the actual fix; a fresh set of pasted
 * literals would just restart the same clock.
 *
 * ## Why it is not a runtime dependency
 *
 * `packages/database` deliberately takes NO dependency on `@arcaai/workflow-contract` (see the
 * seed's docstring): adding one edits the shared root `pnpm-lock.yaml`, which is a collision
 * surface while sibling agents share this repo. This script therefore imports the BUILT dist by
 * relative path — no manifest change, no lockfile change.
 *
 * ## Usage
 *
 *   pnpm --filter @arcaai/workflow-contract build     # the dist this reads
 *   pnpm --filter @arcaai/database exec tsx scripts/regen-workflow-definition-seed.ts
 *
 * It PRINTS the regenerated literals and a drift verdict; it never rewrites the seed itself, so a
 * human still reviews what changes before it is committed (the same posture as the `gen:*:check`
 * drift gates).
 *
 * ## IMPORTANT — when to run it
 *
 * `registryChecksum()` covers the WHOLE node registry, so ANY node added by any ticket changes it.
 * Run this AFTER the node registry is final for a release (e.g. after TASK-791's consultation
 * nodes land), never in the middle of a merge train — otherwise you are pasting a value that is
 * knowably stale before it is committed, which is exactly how the current drift happened.
 */
import { createHash } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as contract from '../../workflow-contract/dist/index.mjs';
import { COMPILED_AT, COMPILED_CONFIG, GRAPH, PLATFORM_DEFAULT_ID, SLUG } from '../src/prisma/db_main/seed/21-workflow-definition';
import { SYSTEM_TENANT_ID } from '../src/prisma/db_main/seed/00-constants';

/* eslint-disable @typescript-eslint/no-explicit-any, no-console */
const { canonicalJson, compile, nodeInfo, registryChecksum, validate, workflowNodeClassLookup } = contract as any;

/**
 * These MUST mirror `WorkflowDefinitionService`'s own constants — they are what a real publish
 * stamps. Duplicated here rather than imported because `packages/database` does not depend on
 * `@arcaai/applications` either; the assertion below is what keeps the copy honest.
 */
const COMPILER_VERSION = '0.1.0';
const RULE_SET_VERSION = 1;
const DEFAULT_CAPS = { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 };
const DEFAULT_POLICY_BINDINGS = {
  guardrailProfile: 'STANDARD',
  redactionRuleSetId: null,
  promptTemplateRefs: [],
  contextSchemaVersionId: null,
  entitlementKeys: [],
};

function main(): void {
  const currentRegistryChecksum = registryChecksum();

  const report = validate(
    GRAPH,
    { paletteKey: 'summarization', registry: workflowNodeClassLookup },
    { ruleSetVersion: RULE_SET_VERSION, registryChecksum: currentRegistryChecksum },
  );

  const result = compile(GRAPH, {
    definitionId: PLATFORM_DEFAULT_ID,
    slug: SLUG,
    versionNumber: 1,
    tenantId: SYSTEM_TENANT_ID,
    paletteKey: 'summarization',
    compilerVersion: COMPILER_VERSION,
    registryChecksum: currentRegistryChecksum,
    ruleSetVersion: RULE_SET_VERSION,
    caps: DEFAULT_CAPS,
    policyBindings: DEFAULT_POLICY_BINDINGS,
    nodeInfo,
  });

  if ('findings' in result) {
    console.error('compile() FAILED — the seeded graph no longer compiles against the current registry:');
    console.error(JSON.stringify(result.findings, null, 2));
    process.exitCode = 1;
    return;
  }

  const graphChecksum = createHash('sha256').update(canonicalJson(GRAPH)).digest('hex');

  console.log('=== REGISTRY_CHECKSUM ===');
  console.log(currentRegistryChecksum);
  console.log('\n=== GRAPH_CHECKSUM ===');
  console.log(graphChecksum);
  console.log('\n=== COMPILED_CONFIG (compiledAt pinned to the seed constant for determinism) ===');
  console.log(JSON.stringify({ ...result.config, compiledAt: COMPILED_AT }, null, 2));
  console.log('\n=== VALIDATION_REPORT ===');
  console.log(JSON.stringify({ ...report, evaluatedAt: COMPILED_AT }, null, 2));

  // --- drift verdict -------------------------------------------------------
  const seeded = COMPILED_CONFIG as any;
  const drift: string[] = [];
  if (seeded.registryChecksum !== currentRegistryChecksum) {
    drift.push(`registryChecksum: seeded ${seeded.registryChecksum} !== current ${currentRegistryChecksum}`);
  }
  if (seeded.compilerVersion !== COMPILER_VERSION) {
    drift.push(`compilerVersion: seeded '${seeded.compilerVersion}' !== service '${COMPILER_VERSION}'`);
  }
  if (seeded.caps?.maxNodeSeconds !== DEFAULT_CAPS.maxNodeSeconds) {
    drift.push(`caps.maxNodeSeconds: seeded ${seeded.caps?.maxNodeSeconds} !== service ${DEFAULT_CAPS.maxNodeSeconds}`);
  }
  if (seeded.checksum !== result.config.checksum) {
    drift.push(`compiledConfig.checksum: seeded ${seeded.checksum} !== recomputed ${result.config.checksum}`);
  }

  console.log(`\n=== DRIFT: ${drift.length} ===`);
  for (const line of drift) console.log(`  - ${line}`);
  if (drift.length === 0) console.log('  (none — the seed matches what a real publish would stamp)');
}

main();
