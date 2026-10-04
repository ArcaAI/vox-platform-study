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
// TASK-1036 (lane B6b) — the W3 pin logic a real publish applies, REUSED rather than mirrored: these
// are pure functions (`publish-pins.ts` / `node-prompt-binding.ts` depend only on the contract), so
// the seed and the service cannot freeze two different things.
import {
  agentNodeRefs,
  agentPromptPins,
  pinAgentNodes,
  type ResolvedAgentPin,
} from '../../applications/src/services/workflow-definition/publish-pins';
import { collectPromptBindings } from '../../applications/src/services/workflow-definition/node-prompt-binding';
import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../src/prisma/db_main/seed/00-constants';
import { NOTE_CONTEXT_SCHEMA_DEFINITION, payloadSchemaFromDefinition } from '../src/prisma/db_main/seed/07e-consultation-note-context-schema';
import {
  GLOBAL_AGENT_SPECS,
  GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS,
  PLATFORM_AGENT_SPECS,
  type SeedAgentSpec,
} from '../src/prisma/db_main/seed/25-agents';
import { COMPILED_AT, CORE_PALETTE_KEY, WORKFLOW_LIBRARY_TARGETS, type WorkflowSeedTarget } from '../src/prisma/db_main/seed/28-workflow-library';
import {
  ARCAAI_AGENT_SPECS,
  ARCAAI_FINALIZATION_AGENT_SPEC,
  ARCAAI_WORKFLOW_TARGETS,
} from '../src/prisma/db_main/seed/29-arcaai-agents-and-workflows';

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

/** Every seeded agent row is version 1 (`buildAgentRow`, and the phase-26 clone). */
const SEEDED_AGENT_VERSION = 1;

/**
 * The agent a seeded tenant runs under `slug`: its OWN published, active row — SYSTEM's for SYSTEM,
 * Global's (plus its playground-only rows) for Global, ArcaAI's for ArcaAI — and, for ArcaAI, the
 * SYSTEM row phase 26 clones in for a slug the tenant does not author (`copyAgents` skips a slug the
 * tenant already has). `cloned` marks that last case: its prompt templates are repointed to the
 * tenant's clones at seed time, so a pin read off the SYSTEM spec would name the wrong template.
 */
function seededAgentFor(tenantId: string, slug: string): { spec: SeedAgentSpec; cloned: boolean } | null {
  const live = (specs: readonly SeedAgentSpec[]) => specs.find((spec) => spec.slug === slug && spec.status === 'PUBLISHED' && spec.isActive);
  if (tenantId === SYSTEM_TENANT_ID) {
    const spec = live(PLATFORM_AGENT_SPECS);
    return spec ? { spec, cloned: false } : null;
  }
  if (tenantId === SEED_TENANT_ID) {
    const spec = live([...GLOBAL_AGENT_SPECS, ...GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS]);
    return spec ? { spec, cloned: false } : null;
  }
  if (tenantId === SEED_CUSTOMER_TENANT_IDS.ARCAAI) {
    const own = live([...ARCAAI_AGENT_SPECS, ARCAAI_FINALIZATION_AGENT_SPEC]);
    if (own) return { spec: own, cloned: false };
    const clone = live(PLATFORM_AGENT_SPECS);
    return clone ? { spec: clone, cloned: true } : null;
  }
  return null;
}

/**
 * TASK-1036 W3 — what a real publish freezes for one target (`WorkflowDefinitionService.
 * resolvePublishPins`): each `core.agent` node pinned to the agent version it runs, and the prompt
 * that version runs (its instruction's own pins) as `promptTemplateRefs`; plus the agents' task +
 * output schema for the compiler's data contract. The authored graph is returned untouched beside
 * the pinned copy — a seeded row's `graph` is what was authored, as a real publish keeps it.
 */
function publishPinsFor(
  target: WorkflowSeedTarget,
  pinTenantId: string = target.tenantId,
): {
  graph: WorkflowSeedTarget['graph'];
  agents: Record<string, { task: string; outputSchema: Record<string, unknown> | null }>;
  promptTemplateRefs: Array<{ nodeId: string; templateId: string; versionNumber: number }>;
  problems: string[];
} {
  const problems: string[] = [];
  const agents: Record<string, { task: string; outputSchema: Record<string, unknown> | null }> = {};
  const pins = new Map<string, ResolvedAgentPin>();
  const agentPromptRefs: Array<{ nodeId: string; templateId: string; versionNumber: number }> = [];
  for (const ref of agentNodeRefs(target.graph as never)) {
    const found = seededAgentFor(pinTenantId, ref.slug);
    if (!found || (ref.versionNumber !== null && ref.versionNumber !== SEEDED_AGENT_VERSION)) {
      problems.push(
        `pin: step \`${ref.nodeId}\` names agent \`${ref.slug}\`${ref.versionNumber === null ? '' : ` v${ref.versionNumber}`}, which tenant ${pinTenantId} does not seed`,
      );
      continue;
    }
    const promptRefs = agentPromptPins(found.spec.instruction, null);
    if (found.cloned && promptRefs.length > 0) {
      problems.push(
        `pin: step \`${ref.nodeId}\` runs the cloned \`${ref.slug}\`, whose prompt pins name the tenant's template clones — not derivable here`,
      );
      continue;
    }
    agents[ref.slug] = { task: found.spec.task, outputSchema: found.spec.outputSchema };
    pins.set(ref.nodeId, { versionNumber: SEEDED_AGENT_VERSION, promptRefs });
    for (const prompt of promptRefs) agentPromptRefs.push({ nodeId: ref.nodeId, ...prompt });
  }
  const graph = pinAgentNodes(target.graph as never, pins) as unknown as WorkflowSeedTarget['graph'];
  // The workflow's OWN pinned bindings first, then the agents' (the service's `buildCompilerContext` order).
  const promptTemplateRefs = [
    ...collectPromptBindings(graph as never)
      .filter((binding) => binding.pinnedVersionNumber !== null)
      .map((binding) => ({ nodeId: binding.nodeId, templateId: binding.promptTemplateId, versionNumber: binding.pinnedVersionNumber as number })),
    ...agentPromptRefs,
  ];
  return { graph, agents, promptTemplateRefs, problems };
}

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
export function engineOutputFor(
  target: WorkflowSeedTarget,
  currentRegistryChecksum: string,
  // TASK-1036 — whose agents the W3 pins are read from. A seeded definition is published in its own
  // tenant (the default); a reference-set CLONE carries its SOURCE's frozen pins verbatim, so its
  // parity check names the source tenant here.
  options: { pinTenantId?: string } = {},
): EngineOutput {
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

  const pinned = publishPinsFor(target, options.pinTenantId);
  problems.push(...pinned.problems);

  const entitlementKeys = [
    ...new Set(
      graph.nodes
        .map((node) => WORKFLOW_NODE_REGISTRY[node.type]?.entitlementKey)
        .filter((key: unknown): key is string => typeof key === 'string' && key.length > 0),
    ),
  ].sort();

  const result = compile(pinned.graph, {
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
      promptTemplateRefs: pinned.promptTemplateRefs,
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
    // TASK-1036 — a real publish compiles with the data contract on (wave B) and the agents it
    // resolved; the seed must freeze the same artifact.
    emitDataContract: true,
    agents: pinned.agents,
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
