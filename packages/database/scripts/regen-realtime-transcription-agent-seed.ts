/**
 * regenerate the realtime transcription agent's seed blobs from
 * the REAL `validate()` / `compile()` / `registryChecksum()` engine, and its
 * compiled `AsrPipeline.configYaml` from the REAL
 * `compileSttGraphToYaml`.
 *
 * Modelled on `regen-arcaai-consultation-workflow-seed.ts`, with one addition
 * that is the whole point of this ticket's D2: the pipeline YAML is produced by
 * the SAME function `WorkflowDefinitionService.publish` calls
 * (`packages/applications/.../compilers/stt-pipeline.compiler.ts`), not by this
 * script's idea of what that function emits. A hand-written YAML that merely
 * looked right would make the seeded pipeline diverge from the next republish
 * of the same graph, silently, and the compiled artifact is what the runtime
 * actually serves.
 *
 * `compileSttGraphToYaml` and `sttWorkflowPipelineSlug` are PURE — no NestJS
 * DI, no I/O — so they are importable from the applications SOURCE by relative
 * path, which is how `packages/database` reaches both packages everywhere else
 * (it deliberately declares a dependency on neither; adding one edits the
 * shared root `pnpm-lock.yaml`).
 *
 * Usage:
 *   pnpm --filter @arcaai/workflow-contract build
 *   pnpm --filter @arcaai/database exec tsx scripts/regen-realtime-transcription-agent-seed.ts
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
import { compileSttGraphToYaml, sttWorkflowPipelineSlug } from '../../applications/src/services/workflow-definition/compilers/stt-pipeline.compiler';
import {
  ARCAAI_TRANSCRIPTION_AGENT_ID,
  ARCAAI_TRANSCRIPTION_AGENT_SLUG,
  ARCAAI_TRANSCRIPTION_PIPELINE_SLUG,
  COMPILED_AT,
  PLATFORM_TRANSCRIPTION_AGENT_ID,
  PLATFORM_TRANSCRIPTION_AGENT_SLUG,
  REALTIME_TRANSCRIPTION_GRAPH,
} from '../src/prisma/db_main/seed/23a-realtime-transcription-agent';
import { SEED_CUSTOMER_TENANT_IDS, SYSTEM_TENANT_ID } from '../src/prisma/db_main/seed/00-constants';

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
  tenantId: string;
  graph: unknown;
}

const TARGETS: Target[] = [
  {
    label: 'PLATFORM_TRANSCRIPTION',
    id: PLATFORM_TRANSCRIPTION_AGENT_ID,
    slug: PLATFORM_TRANSCRIPTION_AGENT_SLUG,
    tenantId: SYSTEM_TENANT_ID,
    graph: REALTIME_TRANSCRIPTION_GRAPH,
  },
  {
    label: 'ARCAAI_TRANSCRIPTION',
    id: ARCAAI_TRANSCRIPTION_AGENT_ID,
    slug: ARCAAI_TRANSCRIPTION_AGENT_SLUG,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    graph: REALTIME_TRANSCRIPTION_GRAPH,
  },
];

const OUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/prisma/db_main/seed/23a-realtime-transcription-agent.generated.ts',
);

function main(): void {
  const currentRegistryChecksum = registryChecksum();
  console.log('=== REGISTRY_CHECKSUM ===');
  console.log(currentRegistryChecksum);

  let failed = false;
  const emitted: Record<string, unknown> = {};
  let arcaaiCompiled: unknown = null;

  for (const target of TARGETS) {
    console.log(`\n\n######## ${target.label} — ${target.slug} ########`);

    const report = validate(
      target.graph,
      { paletteKey: 'stt', registry: workflowNodeClassLookup },
      { ruleSetVersion: RULE_SET_VERSION, registryChecksum: currentRegistryChecksum, evaluatedAt: COMPILED_AT },
    );

    if (report.findings.length > 0) {
      console.error(`!! ${target.label} produced ${report.findings.length} finding(s) — this graph is NOT publishable as-is:`);
      console.error(JSON.stringify(report.findings, null, 2));
      failed = true;
    }

    const result = compile(target.graph, {
      definitionId: target.id,
      slug: target.slug,
      versionNumber: 1,
      tenantId: target.tenantId,
      paletteKey: 'stt',
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
    if (target.label === 'ARCAAI_TRANSCRIPTION') arcaaiCompiled = result.config;

    console.log(`\n=== ${target.label}_GRAPH_CHECKSUM ===`);
    console.log(graphChecksum);
    console.log(
      `=== ${target.label}: validate() ok=${report.ok}, ${report.findings.length} finding(s) · compile() ${result.config.stages.length} stage(s) ===`,
    );
  }

  if (failed || arcaaiCompiled === null) {
    console.error('\nNOT writing the generated module — one or more graphs did not validate or compile.');
    process.exitCode = 1;
    return;
  }

  // The publish artifact, from the REAL compiler. A throw here is a genuine
  // publish-blocking defect in the graph (no `stt.asrEngine`, or one with no
  // `modelSlug`) and must not be caught.
  const pipelineYaml = compileSttGraphToYaml(arcaaiCompiled as never);
  const derivedSlug = sttWorkflowPipelineSlug(ARCAAI_TRANSCRIPTION_AGENT_SLUG);
  if (derivedSlug !== ARCAAI_TRANSCRIPTION_PIPELINE_SLUG) {
    console.error(`!! sttWorkflowPipelineSlug() derives "${derivedSlug}" but the seed declares "${ARCAAI_TRANSCRIPTION_PIPELINE_SLUG}".`);
    process.exitCode = 1;
    return;
  }
  emitted.PIPELINE_CONFIG_YAML = pipelineYaml;
  console.log('\n=== PIPELINE_CONFIG_YAML (compileSttGraphToYaml) ===');
  console.log(pipelineYaml);

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
    ' * Produced by `scripts/regen-realtime-transcription-agent-seed.ts` from the REAL',
    ' * `validate()` / `compile()` / `registryChecksum()` in `packages/workflow-contract` and the REAL',
    ' * `compileSttGraphToYaml` in `packages/applications`, against the graph authored in',
    ' * `23a-realtime-transcription-agent.ts`.',
    ' *',
    ' * Every value here is engine output. Editing one by hand would assert a compiler verdict that',
    ' * no compiler ever reached — and `task-858-realtime-transcription-agent.test.ts` re-runs all four',
    ' * functions and compares, so the edit would fail CI rather than ship.',
    ' *',
    ' * To change any of it, change the GRAPH and re-run the script:',
    ' *   pnpm --filter @arcaai/workflow-contract build',
    ' *   pnpm --filter @arcaai/database exec tsx scripts/regen-realtime-transcription-agent-seed.ts',
    ' */',
    '',
  ].join('\n');

  const decl = (name: string, value: unknown, type: string) => `export const ${name}: ${type} = ${JSON.stringify(value, null, 2)} as const;\n`;

  return [
    header,
    decl('REGISTRY_CHECKSUM', values.REGISTRY_CHECKSUM, 'string'),
    decl('PLATFORM_TRANSCRIPTION_GRAPH_CHECKSUM', values.PLATFORM_TRANSCRIPTION_GRAPH_CHECKSUM, 'string'),
    decl('PLATFORM_TRANSCRIPTION_VALIDATION_REPORT', values.PLATFORM_TRANSCRIPTION_VALIDATION_REPORT, 'Record<string, unknown>'),
    decl('PLATFORM_TRANSCRIPTION_COMPILED_CONFIG', values.PLATFORM_TRANSCRIPTION_COMPILED_CONFIG, 'Record<string, unknown>'),
    decl('ARCAAI_TRANSCRIPTION_GRAPH_CHECKSUM', values.ARCAAI_TRANSCRIPTION_GRAPH_CHECKSUM, 'string'),
    decl('ARCAAI_TRANSCRIPTION_VALIDATION_REPORT', values.ARCAAI_TRANSCRIPTION_VALIDATION_REPORT, 'Record<string, unknown>'),
    decl('ARCAAI_TRANSCRIPTION_COMPILED_CONFIG', values.ARCAAI_TRANSCRIPTION_COMPILED_CONFIG, 'Record<string, unknown>'),
    decl('PIPELINE_CONFIG_YAML', values.PIPELINE_CONFIG_YAML, 'string'),
  ].join('\n');
}

main();
