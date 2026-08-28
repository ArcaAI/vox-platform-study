/**
 * TASK-798 — regenerate the ArcaAI consultation `WorkflowDefinition` seed blobs from the REAL
 * `validate()` / `compile()` engine.
 *
 * A committed, re-runnable script rather than a throwaway, for the reason
 * `regen-workflow-definition-seed.ts` already argues: a throwaway cannot be re-run, so its output
 * drifts silently the moment the node registry or the service's compile constants move — which is
 * exactly what happened to the SYSTEM platform-default row (stale `registryChecksum`, a
 * `compilerVersion` and a `caps.maxNodeSeconds` that no real publish would ever stamp).
 *
 * It writes ONE clearly-marked generated module —
 * `src/prisma/db_main/seed/23-arcaai-workflow-authoring.generated.ts` — and never touches the
 * authored seed itself. That differs deliberately from its Summarization sibling, which prints
 * literals for a human to paste: these two `compiledConfig` blobs are ~450 lines EACH, and a
 * hand-paste of that size is a transcription-error surface with no upside. The review still
 * happens — the generated file is committed, so every regeneration shows up as a reviewable diff
 * — and `task-798-arcaai-workflow-authoring.test.ts` independently re-runs the real engine and
 * compares, so a hand-edit to the generated file cannot survive CI.
 *
 * Usage:
 *   pnpm --filter @arcaai/workflow-contract build
 *   pnpm --filter @arcaai/database exec tsx scripts/regen-arcaai-consultation-workflow-seed.ts
 *
 * `packages/database` takes no dependency on `@arcaai/workflow-contract` (that would edit the
 * shared root lockfile), so the engine is imported from its BUILT dist by relative path.
 *
 * WHEN to run it: `registryChecksum()` covers the WHOLE node registry, so ANY node any ticket adds
 * changes it. Run this after the registry is final for a release, never mid-merge-train —
 * otherwise you are committing a value that is knowably stale before it lands.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as contract from '../../workflow-contract/dist/index.mjs';
import {
  ARCAAI_CONSULTATION_GRAPH,
  ARCAAI_CONSULTATION_SOAP_ID,
  ARCAAI_CONSULTATION_SOAP_SLUG,
  ARCAAI_RHEUM_CONSULTATION_GRAPH,
  ARCAAI_RHEUM_CONSULTATION_SOAP_ID,
  ARCAAI_RHEUM_CONSULTATION_SOAP_SLUG,
  COMPILED_AT,
} from '../src/prisma/db_main/seed/23-arcaai-workflow-authoring';
import { SEED_CUSTOMER_TENANT_IDS } from '../src/prisma/db_main/seed/00-constants';

/* eslint-disable @typescript-eslint/no-explicit-any, no-console */
const { canonicalJson, compile, nodeInfo, registryChecksum, validate, workflowNodeClassLookup } = contract as any;

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

interface Target {
  label: string;
  id: string;
  slug: string;
  graph: unknown;
}

const TARGETS: Target[] = [
  { label: 'GEN', id: ARCAAI_CONSULTATION_SOAP_ID, slug: ARCAAI_CONSULTATION_SOAP_SLUG, graph: ARCAAI_CONSULTATION_GRAPH },
  { label: 'RHEUM', id: ARCAAI_RHEUM_CONSULTATION_SOAP_ID, slug: ARCAAI_RHEUM_CONSULTATION_SOAP_SLUG, graph: ARCAAI_RHEUM_CONSULTATION_GRAPH },
];

const OUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/prisma/db_main/seed/23-arcaai-workflow-authoring.generated.ts',
);

function main(): void {
  const currentRegistryChecksum = registryChecksum();
  console.log('=== REGISTRY_CHECKSUM ===');
  console.log(currentRegistryChecksum);

  let failed = false;
  const emitted: Record<string, unknown> = {};

  for (const target of TARGETS) {
    console.log(`\n\n######## ${target.label} — ${target.slug} ########`);

    const report = validate(
      target.graph,
      { paletteKey: 'consultation', registry: workflowNodeClassLookup },
      { ruleSetVersion: RULE_SET_VERSION, registryChecksum: currentRegistryChecksum, evaluatedAt: COMPILED_AT },
    );

    // A report with findings is a REAL result, not a script failure — print it and keep going, but
    // make the exit code say so. Publishing a graph with ERROR findings is not possible through
    // the service, so a seed that carried one would be unreachable by any other path.
    if (report.findings.length > 0) {
      console.error(`!! ${target.label} produced ${report.findings.length} finding(s) — this graph is NOT publishable as-is:`);
      console.error(JSON.stringify(report.findings, null, 2));
      failed = true;
    }

    const result = compile(target.graph, {
      definitionId: target.id,
      slug: target.slug,
      versionNumber: 1,
      tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
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
      console.error(`!! ${target.label} FAILED to compile against the current registry:`);
      console.error(JSON.stringify(result.findings, null, 2));
      failed = true;
      continue;
    }

    const graphChecksum = createHash('sha256').update(canonicalJson(target.graph)).digest('hex');
    emitted[`${target.label}_GRAPH_CHECKSUM`] = graphChecksum;
    emitted[`${target.label}_VALIDATION_REPORT`] = report;
    emitted[`${target.label}_COMPILED_CONFIG`] = result.config;

    console.log(`\n=== ${target.label}_GRAPH_CHECKSUM ===`);
    console.log(graphChecksum);
    console.log(
      `=== ${target.label}: validate() ok=${report.ok}, ${report.findings.length} finding(s) · compile() ${result.config.stages.length} stage(s), ${result.config.gates?.length ?? 0} gate(s) ===`,
    );
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
    ' * Produced by `scripts/regen-arcaai-consultation-workflow-seed.ts` from the REAL',
    ' * `validate()` / `compile()` / `registryChecksum()` in `packages/workflow-contract`, against the',
    ' * graphs authored in `23-arcaai-workflow-authoring.ts`.',
    ' *',
    ' * Every value here is engine output. Editing one by hand would assert a compiler verdict that',
    ' * no compiler ever reached — and `task-798-arcaai-workflow-authoring.test.ts` re-runs the engine',
    ' * and compares, so the edit would fail CI rather than ship.',
    ' *',
    ' * To change any of it, change the GRAPH and re-run the script:',
    ' *   pnpm --filter @arcaai/workflow-contract build',
    ' *   pnpm --filter @arcaai/database exec tsx scripts/regen-arcaai-consultation-workflow-seed.ts',
    ' */',
    '',
  ].join('\n');

  const decl = (name: string, value: unknown, type: string) => `export const ${name}: ${type} = ${JSON.stringify(value, null, 2)} as const;\n`;

  return [
    header,
    decl('REGISTRY_CHECKSUM', values.REGISTRY_CHECKSUM, 'string'),
    decl('GEN_GRAPH_CHECKSUM', values.GEN_GRAPH_CHECKSUM, 'string'),
    decl('GEN_VALIDATION_REPORT', values.GEN_VALIDATION_REPORT, 'Record<string, unknown>'),
    decl('GEN_COMPILED_CONFIG', values.GEN_COMPILED_CONFIG, 'Record<string, unknown>'),
    decl('RHEUM_GRAPH_CHECKSUM', values.RHEUM_GRAPH_CHECKSUM, 'string'),
    decl('RHEUM_VALIDATION_REPORT', values.RHEUM_VALIDATION_REPORT, 'Record<string, unknown>'),
    decl('RHEUM_COMPILED_CONFIG', values.RHEUM_COMPILED_CONFIG, 'Record<string, unknown>'),
  ].join('\n');
}

main();
