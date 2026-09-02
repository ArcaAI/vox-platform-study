/**
 * TASK-858 D3 — regenerate the three example consultation workflows' seed blobs
 * from the REAL `validate()` / `compile()` / `registryChecksum()` engine.
 *
 * Same contract as `regen-arcaai-consultation-workflow-seed.ts`, which this is
 * modelled on: a committed, re-runnable script rather than a throwaway, writing
 * ONE clearly-marked generated module and never touching the authored seed. Six
 * compiled configs at ~200 lines each is not a hand-paste anybody should be
 * asked to review character by character; the generated file is committed, so
 * every regeneration still shows up as a reviewable diff, and
 * `task-858-example-consultation-workflows.test.ts` independently re-runs the
 * engine and compares, so a hand-edit cannot survive CI.
 *
 * THREE graphs, SIX compiled configs: `validate()` reads only the graph, so a
 * variant has one report; `compile()` stamps `definitionId`/`slug`/`tenantId`,
 * so each variant has a distinct config per tenant.
 *
 * Usage:
 *   pnpm --filter @arcaai/workflow-contract build
 *   pnpm --filter @arcaai/database exec tsx scripts/regen-example-consultation-workflow-seed.ts
 *
 * WHEN to run it: `registryChecksum()` covers the WHOLE node registry, so ANY
 * node any ticket adds changes it. Run this after the registry is final for a
 * release, never mid-merge-train.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as contract from '../../workflow-contract/dist/index.mjs';
import {
  COMPILED_AT,
  GRAMMAR_FIX_GRAPH,
  MEDICAL_NER_GRAPH,
  NER_GRAMMAR_FIX_GRAPH,
} from '../src/prisma/db_main/seed/24-example-consultation-workflows';
import { SEED_CUSTOMER_TENANT_IDS, SYSTEM_TENANT_ID } from '../src/prisma/db_main/seed/00-constants';

/* eslint-disable @typescript-eslint/no-explicit-any, no-console */
const { canonicalJson, compile, nodeInfo, registryChecksum, validate, workflowNodeClassLookup, workflowPublishProblems } = contract as any;

/** MUST mirror `WorkflowDefinitionService`'s own constants — this is what a real publish stamps. */
const COMPILER_VERSION = '0.1.0';
const RULE_SET_VERSION = 1;
const DEFAULT_CAPS = { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 };
const DEFAULT_POLICY_BINDINGS = {
  guardrailProfile: 'STANDARD',
  redactionRuleSetId: null,
  promptTemplateRefs: [],
  documentTemplateRefs: [],
  contextSchemaVersionId: null,
  entitlementKeys: [],
};

interface Variant {
  key: string;
  graph: unknown;
  platform: { id: string; slug: string };
  arcaai: { id: string; slug: string };
}

/**
 * The ids and slugs are restated here rather than imported from the seed's
 * `EXAMPLE_WORKFLOW_VARIANTS`, because that array reads the GENERATED module —
 * which does not exist on a first run and holds stale values on every other.
 * The test asserts the two agree, so a divergence is a failing suite rather
 * than a quietly mis-stamped `compiledConfig`.
 */
const VARIANTS: Variant[] = [
  {
    key: 'GRAMMAR_FIX',
    graph: GRAMMAR_FIX_GRAPH,
    platform: { id: '99000000-0000-0000-0003-000000000001', slug: 'platform-consultation-grammar-fix' },
    arcaai: { id: '99000000-0000-0000-0003-000000000011', slug: 'arcaai-consultation-grammar-fix' },
  },
  {
    key: 'MEDICAL_NER',
    graph: MEDICAL_NER_GRAPH,
    platform: { id: '99000000-0000-0000-0003-000000000002', slug: 'platform-consultation-medical-ner' },
    arcaai: { id: '99000000-0000-0000-0003-000000000012', slug: 'arcaai-consultation-medical-ner' },
  },
  {
    key: 'NER_GRAMMAR_FIX',
    graph: NER_GRAMMAR_FIX_GRAPH,
    platform: { id: '99000000-0000-0000-0003-000000000003', slug: 'platform-consultation-ner-grammar-fix' },
    arcaai: { id: '99000000-0000-0000-0003-000000000013', slug: 'arcaai-consultation-ner-grammar-fix' },
  },
];

const OUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/prisma/db_main/seed/24-example-consultation-workflows.generated.ts',
);

function main(): void {
  const currentRegistryChecksum = registryChecksum();
  console.log('=== REGISTRY_CHECKSUM ===');
  console.log(currentRegistryChecksum);

  let failed = false;
  const emitted: Record<string, unknown> = {};

  for (const variant of VARIANTS) {
    console.log(`\n\n######## ${variant.key} ########`);

    const report = validate(
      variant.graph,
      { paletteKey: 'consultation', registry: workflowNodeClassLookup },
      { ruleSetVersion: RULE_SET_VERSION, registryChecksum: currentRegistryChecksum, evaluatedAt: COMPILED_AT },
    );

    // A report with findings is a REAL result, not a script failure — print it
    // and keep going, but make the exit code say so. Publishing a graph with
    // ERROR findings is not possible through the service, so a seed that
    // carried one would be unreachable by any other path.
    if (report.findings.length > 0) {
      console.error(`!! ${variant.key} produced ${report.findings.length} finding(s) — this graph is NOT publishable as-is:`);
      console.error(JSON.stringify(report.findings, null, 2));
      failed = true;
    }

    // `workflowPublishProblems` is the only check that enforces a node
    // descriptor's `requires[]`, and it has NO production caller — so a seeded
    // graph could ship with a generation node whose mandatory guard was never
    // wired and no gate would say so. Run it here as well as in the test.
    const publishProblems = workflowPublishProblems(variant.graph);
    if (publishProblems.length > 0) {
      console.error(`!! ${variant.key} has ${publishProblems.length} publish problem(s):`);
      console.error(JSON.stringify(publishProblems, null, 2));
      failed = true;
    }

    const graphChecksum = createHash('sha256').update(canonicalJson(variant.graph)).digest('hex');
    emitted[`${variant.key}_GRAPH_CHECKSUM`] = graphChecksum;
    emitted[`${variant.key}_VALIDATION_REPORT`] = report;

    for (const [scope, target, tenantId] of [
      ['PLATFORM', variant.platform, SYSTEM_TENANT_ID],
      ['ARCAAI', variant.arcaai, SEED_CUSTOMER_TENANT_IDS.ARCAAI],
    ] as const) {
      const result = compile(variant.graph, {
        definitionId: target.id,
        slug: target.slug,
        versionNumber: 1,
        tenantId,
        paletteKey: 'consultation',
        compilerVersion: COMPILER_VERSION,
        registryChecksum: currentRegistryChecksum,
        ruleSetVersion: RULE_SET_VERSION,
        caps: DEFAULT_CAPS,
        policyBindings: DEFAULT_POLICY_BINDINGS,
        compiledAt: COMPILED_AT,
        nodeInfo,
      });

      if ('findings' in result) {
        console.error(`!! ${scope}_${variant.key} FAILED to compile against the current registry:`);
        console.error(JSON.stringify(result.findings, null, 2));
        failed = true;
        continue;
      }
      emitted[`${scope}_${variant.key}_COMPILED_CONFIG`] = result.config;
      console.log(`=== ${scope}_${variant.key}: compile() ${result.config.stages.length} stage(s), ${result.config.gates?.length ?? 0} gate(s) ===`);
    }

    console.log(`=== ${variant.key}_GRAPH_CHECKSUM ===`);
    console.log(graphChecksum);
    console.log(`=== ${variant.key}: validate() ok=${report.ok}, ${report.findings.length} finding(s) ===`);
  }

  if (failed) {
    console.error('\nNOT writing the generated module — one or more graphs did not validate or compile.');
    process.exitCode = 1;
    return;
  }

  emitted.REGISTRY_CHECKSUM = currentRegistryChecksum;
  writeFileSync(OUT_PATH, renderModule(emitted), 'utf8');
  console.log(`\nWrote ${OUT_PATH}`);
}

/** Emits the generated module. Values go through `JSON.stringify` — never string concatenation. */
function renderModule(values: Record<string, unknown>): string {
  const header = [
    '/**',
    ' * GENERATED FILE — DO NOT EDIT BY HAND.',
    ' *',
    ' * Produced by `scripts/regen-example-consultation-workflow-seed.ts` from the REAL',
    ' * `validate()` / `compile()` / `registryChecksum()` in `packages/workflow-contract`, against the',
    ' * three graphs authored in `24-example-consultation-workflows.ts`.',
    ' *',
    ' * Every value here is engine output. Editing one by hand would assert a compiler verdict that',
    ' * no compiler ever reached — and `task-858-example-consultation-workflows.test.ts` re-runs the',
    ' * engine and compares, so the edit would fail CI rather than ship.',
    ' *',
    ' * To change any of it, change the GRAPH and re-run the script:',
    ' *   pnpm --filter @arcaai/workflow-contract build',
    ' *   pnpm --filter @arcaai/database exec tsx scripts/regen-example-consultation-workflow-seed.ts',
    ' */',
    '',
  ].join('\n');

  const decl = (name: string, type: string) => `export const ${name}: ${type} = ${JSON.stringify(values[name], null, 2)} as const;\n`;

  return [
    header,
    decl('REGISTRY_CHECKSUM', 'string'),
    ...VARIANTS.flatMap((variant) => [
      decl(`${variant.key}_GRAPH_CHECKSUM`, 'string'),
      decl(`${variant.key}_VALIDATION_REPORT`, 'Record<string, unknown>'),
      decl(`PLATFORM_${variant.key}_COMPILED_CONFIG`, 'Record<string, unknown>'),
      decl(`ARCAAI_${variant.key}_COMPILED_CONFIG`, 'Record<string, unknown>'),
    ]),
  ].join('\n');
}

main();
