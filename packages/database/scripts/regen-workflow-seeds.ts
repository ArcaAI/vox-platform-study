/**
 * TASK-930 §8.6 — regenerate EVERY seeded workflow's engine output from the REAL
 * `validate()` / `compile()` / `registryChecksum()` / `publishFindings()` of
 * `@arcaai/workflow-contract`, into the two GENERATED modules:
 *
 *   seed/28-workflow-library.generated.ts             Global + SYSTEM (§8.4)
 *   seed/29-arcaai-agents-and-workflows.generated.ts  ArcaAI (§8.5)
 *
 * ONE script for the whole seed set (it replaced three), re-runnable and idempotent: run it twice
 * and `git status` is clean. The authored graphs stay in their seed modules; only engine output
 * lands here, and `task-930-workflow-seeds.test.ts` re-runs the engine and compares, so a
 * hand-edit cannot survive CI.
 *
 * Usage:
 *   pnpm --filter @arcaai/workflow-contract build
 *   pnpm --filter @arcaai/database seed:regen:workflows
 *
 * WHEN to run it: `registryChecksum()` covers the WHOLE node registry, so ANY node any ticket adds
 * or removes changes it — after lane R's retirement lands, the orchestrator re-runs this.
 *
 * `packages/database` takes no dependency on `@arcaai/workflow-contract` or
 * `@arcaai/json-schema-subset` (adding one edits the shared root lockfile), so both are imported
 * from their BUILT dist by relative path, exactly as the three retired `regen-*` scripts did.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as contract from '../../workflow-contract/dist/index.mjs';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as jsonSchemaSubset from '../../json-schema-subset/dist/index.mjs';
import { NOTE_CONTEXT_SCHEMA_DEFINITION, payloadSchemaFromDefinition } from '../src/prisma/db_main/seed/07e-consultation-note-context-schema';
import { COMPILED_AT, CORE_PALETTE_KEY, WORKFLOW_LIBRARY_TARGETS, type WorkflowSeedTarget } from '../src/prisma/db_main/seed/28-workflow-library';
import { ARCAAI_WORKFLOW_TARGETS } from '../src/prisma/db_main/seed/29-arcaai-agents-and-workflows';

/* eslint-disable @typescript-eslint/no-explicit-any, no-console */
const {
  WORKFLOW_NODE_REGISTRY,
  canonicalJson,
  compile,
  nodeInfo,
  publishFindings,
  registryChecksum,
  TEMPLATE_REFERENCE_SEVERITY_RELEASE_1,
  validate,
  workflowEdgePortProblems,
  workflowNodeClassLookup,
} = contract as any;
const { jsonSchemaValueProblems } = jsonSchemaSubset as any;

/** MUST mirror `WorkflowDefinitionService`'s own constants — this is what a real publish stamps. */
export const COMPILER_VERSION = '0.1.0';
export const RULE_SET_VERSION = 1;
export const DEFAULT_CAPS = { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 };
/** The two `policyBindings` fields a real publish cannot derive from the graph (`NON_DERIVABLE_POLICY_BINDINGS`). */
export const NON_DERIVABLE_POLICY_BINDINGS = { guardrailProfile: 'STANDARD', redactionRuleSetId: null };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(HERE, '../src/prisma/db_main/seed');

export interface EngineOutput {
  graphChecksum: string;
  validationReport: unknown;
  compiledConfig: Record<string, unknown>;
  problems: string[];
}

/**
 * Everything a real publish through `WorkflowDefinitionService` stamps for one target, from the
 * engine. `entitlementKeys` are derived from the registry like `buildCompilerContext` does;
 * `contextSchemaVersionId` is the tenant's default schema version (what `getEffectiveBundle`
 * answers for a seeded tenant); the trigger's REFERENCE is resolved to the seeded
 * `consultation_note_context` payload schema, exactly as `resolveTriggerContextSchema` would.
 */
export function engineOutputFor(target: WorkflowSeedTarget, currentRegistryChecksum: string): EngineOutput {
  const problems: string[] = [];
  const graph = target.graph;
  const trigger = graph.nodes.find((node) => node.type === 'core.trigger');
  const contextSchemaId = (trigger?.config.contextSchema as { contextSchemaId?: string } | undefined)?.contextSchemaId;
  if (!contextSchemaId) problems.push('the trigger binds no context schema by reference');
  // TASK-951 — the payload schema is THIS target's, not an assumed one. It used to be
  // `NOTE_CONTEXT_SCHEMA_DEFINITION` for every target, which was true only while every seeded
  // graph triggered on `consultation_note_context`; the 11 ArcaAI workflows now trigger on
  // `arcaai_consultation_scribe`. What is frozen here is what the harness validates a run's
  // authored context against, so an assumed schema would reject the very fields the trigger
  // declares. Absent ⇒ the note context, so every pre-existing target compiles unchanged.
  const payloadSchema = payloadSchemaFromDefinition(target.contextSchemaDefinition ?? NOTE_CONTEXT_SCHEMA_DEFINITION);

  for (const problem of workflowEdgePortProblems(graph) as string[]) problems.push(`edge: ${problem}`);

  const report = validate(
    graph,
    { paletteKey: CORE_PALETTE_KEY, registry: workflowNodeClassLookup },
    { ruleSetVersion: RULE_SET_VERSION, registryChecksum: currentRegistryChecksum, evaluatedAt: COMPILED_AT },
  );
  for (const finding of report.findings as Array<{ severity: string; ruleId?: string; message: string }>) {
    problems.push(`validate ${finding.severity} ${finding.ruleId ?? ''}: ${finding.message}`);
  }

  // The publish gate. Agents are deliberately UNRESOLVED (the script does no DB read; the
  // contract skips those checks rather than guessing); the trigger context IS resolved so every
  // `{{trigger.context.*}}` a node reads is checked against the seeded schema. ERROR only — a
  // WARNING (`GUARDRAIL_OPTED_OUT`, the `PROMPT_VARIABLE_UNDECLARED` ramp) never blocks a publish.
  const gate = publishFindings(graph, {
    schemaValueProblems: jsonSchemaValueProblems,
    templateReferenceSeverity: TEMPLATE_REFERENCE_SEVERITY_RELEASE_1,
    triggerContextSchema: payloadSchema,
  }) as Array<{ severity: string; code?: string; message: string }>;
  for (const finding of gate.filter((entry) => entry.severity === 'ERROR')) problems.push(`publish ${finding.code ?? ''}: ${finding.message}`);

  const entitlementKeys = [
    ...new Set(
      graph.nodes
        .map((node) => WORKFLOW_NODE_REGISTRY[node.type]?.entitlementKey)
        .filter((key: unknown): key is string => typeof key === 'string' && key.length > 0),
    ),
  ].sort();

  const result = compile(graph, {
    definitionId: target.id,
    slug: target.slug,
    versionNumber: 1,
    tenantId: target.tenantId,
    paletteKey: CORE_PALETTE_KEY,
    compilerVersion: COMPILER_VERSION,
    registryChecksum: currentRegistryChecksum,
    ruleSetVersion: RULE_SET_VERSION,
    caps: DEFAULT_CAPS,
    policyBindings: {
      ...NON_DERIVABLE_POLICY_BINDINGS,
      promptTemplateRefs: [],
      documentTemplateRefs: [],
      contextSchemaVersionId: target.contextSchemaVersionId,
      entitlementKeys,
    },
    // TASK-982 — every seeded trigger now binds by reference with no authored `versionNumber`
    // (FOLLOW LATEST), so `followsLatest: true` here is what a real publish would resolve too;
    // `versionNumber`/`versionId` stay the CONCRETE version resolved at compile time (both
    // bindings resolve to a concrete version — only the intent differs, and the compiler freezes
    // `followsLatest` beside `resolved` to record which one it was).
    triggerContextSchema: contextSchemaId
      ? { schemaId: contextSchemaId, versionNumber: 1, versionId: target.contextSchemaVersionId, payloadSchema, followsLatest: true }
      : null,
    compiledAt: COMPILED_AT,
    nodeInfo,
  });
  if ('findings' in result) {
    for (const finding of result.findings as Array<{ message: string }>) problems.push(`compile: ${finding.message}`);
    return { graphChecksum: '', validationReport: report, compiledConfig: {}, problems };
  }

  return {
    graphChecksum: createHash('sha256').update(canonicalJson(graph)).digest('hex'),
    validationReport: report,
    compiledConfig: result.config,
    problems,
  };
}

function renderModule(
  fileName: string,
  exportName: string,
  values: Record<string, EngineOutput>,
  currentRegistryChecksum: string,
  typeImport: string,
): string {
  const blobs = Object.fromEntries(
    Object.entries(values).map(([key, output]) => [
      key,
      { graphChecksum: output.graphChecksum, validationReport: output.validationReport, compiledConfig: output.compiledConfig },
    ]),
  );
  return [
    '/**',
    ' * GENERATED FILE — DO NOT EDIT BY HAND.',
    ' *',
    ' * Produced by `scripts/regen-workflow-seeds.ts` (`pnpm --filter @arcaai/database seed:regen:workflows`)',
    ' * from the REAL `validate()` / `compile()` / `registryChecksum()` / `publishFindings()` in',
    ` * \`packages/workflow-contract\`, against the graphs authored in \`${fileName}\`.`,
    ' *',
    ' * Every value here is engine output. Editing one by hand would assert a compiler verdict that no',
    ' * compiler ever reached — and `task-930-workflow-seeds.test.ts` re-runs the engine and compares.',
    ' */',
    typeImport,
    '',
    `export const REGISTRY_CHECKSUM: string = ${JSON.stringify(currentRegistryChecksum)};`,
    '',
    `export const ${exportName}: Readonly<Record<string, GeneratedWorkflowBlob>> = ${JSON.stringify(blobs, null, 2)};`,
    '',
  ].join('\n');
}

function main(): void {
  const currentRegistryChecksum = registryChecksum();
  console.log(`=== REGISTRY_CHECKSUM === ${currentRegistryChecksum}`);

  let failed = false;
  const outputs: Record<string, Record<string, EngineOutput>> = { library: {}, arcaai: {} };
  for (const [group, targets] of [
    ['library', WORKFLOW_LIBRARY_TARGETS],
    ['arcaai', ARCAAI_WORKFLOW_TARGETS],
  ] as const) {
    for (const target of targets) {
      const output = engineOutputFor(target, currentRegistryChecksum);
      if (output.problems.length > 0) {
        failed = true;
        console.error(`!! ${target.key} is NOT publishable as-is:`);
        for (const problem of output.problems) console.error(`   - ${problem}`);
        continue;
      }
      outputs[group]![target.key] = output;
      console.log(
        `=== ${target.key}: ${(output.compiledConfig.stages as unknown[]).length} stage(s), validate ok, graph ${output.graphChecksum.slice(0, 12)}…`,
      );
    }
  }

  if (failed) {
    console.error('\nNOT writing the generated modules — one or more graphs did not validate, pass the publish gate, or compile.');
    process.exitCode = 1;
    return;
  }

  writeFileSync(
    path.join(SEED_DIR, '28-workflow-library.generated.ts'),
    renderModule(
      '28-workflow-library.ts',
      'WORKFLOW_LIBRARY_GENERATED',
      outputs.library!,
      currentRegistryChecksum,
      'export interface GeneratedWorkflowBlob {\n  graphChecksum: string;\n  validationReport: Record<string, unknown>;\n  compiledConfig: Record<string, unknown>;\n}',
    ),
    'utf8',
  );
  writeFileSync(
    path.join(SEED_DIR, '29-arcaai-agents-and-workflows.generated.ts'),
    renderModule(
      '29-arcaai-agents-and-workflows.ts',
      'ARCAAI_GENERATED',
      outputs.arcaai!,
      currentRegistryChecksum,
      "import type { GeneratedWorkflowBlob } from './28-workflow-library.generated';",
    ),
    'utf8',
  );
  console.log(`\nWrote ${Object.keys(outputs.library!).length} library + ${Object.keys(outputs.arcaai!).length} ArcaAI blobs.`);
}

// Importable by the parity test (which calls `engineOutputFor` itself) — only a direct run writes files.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
