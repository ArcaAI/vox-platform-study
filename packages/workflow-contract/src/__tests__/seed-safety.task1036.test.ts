/**
 * TASK-1036 C0a — SEED SAFETY. Every seeded workflow (`seed/28-workflow-library.ts`,
 * `seed/29-arcaai-agents-and-workflows.ts`, read-only) must survive the data contract:
 *
 *  1. ZERO new ERROR findings — `validate()` + `publishFindings()` are as clean as the committed
 *     engine output (`*.generated.ts`), both the way the regen script calls the gate (agents
 *     unresolved) and the way the gateway will (agent tasks and output schemas resolved);
 *  2. compiled the way the regen script compiles (`packages/database/scripts/regen-workflow-seeds.ts`
 *     `engineOutputFor`: the W3 publish pins applied, `emitDataContract: true`, the resolved agents),
 *     it reproduces the committed artifact (same checksum), and every legacy data input binding is
 *     translated into exactly one compiled binding that reads the same producer key.
 *
 * TASK-1038 E2 (fix 16) — the committed blobs are compiled with the publish pins and the data
 * contract ON (TASK-1036 lane B6b). This suite used to rebuild a context with NEITHER, so it could
 * never reproduce them; the "contract off ⇒ byte-identical to the committed blob" assertion is
 * gone (no committed blob is compiled that way any more), and the context below is the regen
 * script's. The pin helpers are the SAME pure functions the regen script and the publish service
 * use, imported by path from `packages/applications` exactly as the regen script imports them.
 *
 * The seed modules live in `packages/database`, outside this package; they are imported by path,
 * as the regen script imports this package's dist. Nothing here writes.
 */
import path from 'node:path';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { beforeAll, describe, expect, it } from 'vitest';
import { compile, type CompiledNode, type CompiledWorkflowConfig, type CompilerContext } from '../compiler';
import type { WorkflowGraph } from '../graph-model';
import { NODE_PORTS } from '../node-ports';
import { nodeInfo, workflowNodeClassLookup, WORKFLOW_NODE_REGISTRY } from '../node-registry';
import type { AgentIOResolution, AgentIOResolver } from '../node-io';
import { publishFindings, TEMPLATE_REFERENCE_SEVERITY_RELEASE_1, type PublishAgentView } from '../publish-findings';
import type { WorkflowFinding } from '../report';
import { validate } from '../validate';
import { resolveOutputPort } from '../core-contract';
import type { AgentTask } from '../agent-schemas';

const SEED = path.resolve(__dirname, '../../../database/src/prisma/db_main/seed');
const PUBLISH_PINS = path.resolve(__dirname, '../../../applications/src/services/workflow-definition/publish-pins.ts');
const PROMPT_BINDINGS = path.resolve(__dirname, '../../../applications/src/services/workflow-definition/node-prompt-binding.ts');

/** MUST mirror the regen script (`COMPILER_VERSION`, `RULE_SET_VERSION`, `DEFAULT_CAPS`, `NON_DERIVABLE_POLICY_BINDINGS`). */
const REGEN_CAPS = { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 };
/** Every seeded agent row is version 1 (the regen script's `SEEDED_AGENT_VERSION`). */
const SEEDED_AGENT_VERSION = 1;

interface SeedAgentSpec {
  slug: string;
  task: AgentTask;
  status?: string;
  isActive?: boolean;
  instruction?: unknown;
  outputSchema: Record<string, unknown> | null;
}

interface Target {
  key: string;
  id: string;
  tenantId: string;
  slug: string;
  graph: WorkflowGraph;
  contextSchemaVersionId: string;
  contextSchemaDefinition?: Record<string, unknown>;
}

interface Blob {
  validationReport: { findings: WorkflowFinding[] };
  compiledConfig: CompiledWorkflowConfig;
}

interface SeededTarget {
  target: Target;
  blob: Blob;
  registryChecksum: string;
}

let TARGETS: SeededTarget[] = [];
/* eslint-disable @typescript-eslint/no-explicit-any */
let PINS: any;
let BINDINGS: any;
let CONSTANTS: any;
let AGENT_SPECS: { platform: SeedAgentSpec[]; global: SeedAgentSpec[]; arcaai: SeedAgentSpec[] } = { platform: [], global: [], arcaai: [] };
/* eslint-enable @typescript-eslint/no-explicit-any */
let AGENTS: AgentIOResolver = {};
let PUBLISH_AGENTS: Record<string, PublishAgentView> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let noteSchema: any;

/** Load the seed modules by path (read-only) — inside a hook, because this package compiles as CommonJS (no top-level await). */
beforeAll(async () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const load = (name: string): Promise<any> => import(/* @vite-ignore */ `${SEED}/${name}`);
  const [library, libraryGenerated, arcaai, arcaaiGenerated, agentsModule, note, constants, pins, bindings] = await Promise.all([
    load('28-workflow-library.ts'),
    load('28-workflow-library.generated.ts'),
    load('29-arcaai-agents-and-workflows.ts'),
    load('29-arcaai-agents-and-workflows.generated.ts'),
    load('25-agents.ts'),
    load('07e-consultation-note-context-schema.ts'),
    load('00-constants.ts'),
    import(/* @vite-ignore */ PUBLISH_PINS),
    import(/* @vite-ignore */ PROMPT_BINDINGS),
  ]);
  CONSTANTS = constants;
  PINS = pins;
  BINDINGS = bindings;
  AGENT_SPECS = {
    platform: agentsModule.PLATFORM_AGENT_SPECS,
    global: [...agentsModule.GLOBAL_AGENT_SPECS, ...agentsModule.GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS],
    arcaai: [...arcaai.ARCAAI_AGENT_SPECS, arcaai.ARCAAI_FINALIZATION_AGENT_SPEC],
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  noteSchema = note;
  TARGETS = [
    ...(library.WORKFLOW_LIBRARY_TARGETS as Target[]).map((target) => ({
      target,
      blob: libraryGenerated.WORKFLOW_LIBRARY_GENERATED[target.key] as Blob,
      registryChecksum: libraryGenerated.REGISTRY_CHECKSUM as string,
    })),
    ...(arcaai.ARCAAI_WORKFLOW_TARGETS as Target[]).map((target) => ({
      target,
      blob: arcaaiGenerated.ARCAAI_GENERATED[target.key] as Blob,
      registryChecksum: arcaaiGenerated.REGISTRY_CHECKSUM as string,
    })),
  ];
  /** Every seeded agent, by slug: its task and output schema (`null` = the task default). */
  const specs: Array<{ slug: string; task: AgentTask; outputSchema: Record<string, unknown> | null }> = [
    ...agentsModule.GLOBAL_AGENT_SPECS,
    ...agentsModule.PLATFORM_AGENT_SPECS,
    ...arcaai.ARCAAI_AGENT_SPECS,
    arcaai.ARCAAI_FINALIZATION_AGENT_SPEC,
  ];
  AGENTS = Object.fromEntries(specs.map((spec) => [spec.slug, { task: spec.task, outputSchema: spec.outputSchema }]));
  PUBLISH_AGENTS = Object.fromEntries(
    specs.map((spec) => [spec.slug, { declaredVariables: [], contextPayloadSchema: null, task: spec.task, outputSchema: spec.outputSchema }]),
  );
});

function payloadSchemaOf(target: Target): Record<string, unknown> {
  return noteSchema.payloadSchemaFromDefinition(target.contextSchemaDefinition ?? noteSchema.NOTE_CONTEXT_SCHEMA_DEFINITION);
}

/**
 * The regen script's `seededAgentFor`: the agent a seeded tenant runs under `slug` — its OWN live
 * row (SYSTEM's, Global's + playground-only, ArcaAI's), and for ArcaAI the SYSTEM row phase 26
 * clones in for a slug it does not author (`cloned`).
 */
function seededAgentFor(tenantId: string, slug: string): { spec: SeedAgentSpec; cloned: boolean } | null {
  const live = (specs: readonly SeedAgentSpec[]) => specs.find((spec) => spec.slug === slug && spec.status === 'PUBLISHED' && spec.isActive);
  if (tenantId === CONSTANTS.SYSTEM_TENANT_ID) {
    const spec = live(AGENT_SPECS.platform);
    return spec ? { spec, cloned: false } : null;
  }
  if (tenantId === CONSTANTS.SEED_TENANT_ID) {
    const spec = live(AGENT_SPECS.global);
    return spec ? { spec, cloned: false } : null;
  }
  if (tenantId === CONSTANTS.SEED_CUSTOMER_TENANT_IDS.ARCAAI) {
    const own = live(AGENT_SPECS.arcaai);
    if (own) return { spec: own, cloned: false };
    const clone = live(AGENT_SPECS.platform);
    return clone ? { spec: clone, cloned: true } : null;
  }
  return null;
}

/** The regen script's `publishPinsFor`: the pinned graph copy, the agents, and the prompt refs a publish freezes. */
function publishPinsFor(target: Target): {
  graph: WorkflowGraph;
  agents: AgentIOResolver;
  promptTemplateRefs: Array<{ nodeId: string; templateId: string; versionNumber: number }>;
} {
  // Built mutably, returned as the read-only `AgentIOResolver` (TS2542 on an index write otherwise).
  const agents: Record<string, AgentIOResolution> = {};
  const pins = new Map<string, { versionNumber: number; promptRefs: Array<{ templateId: string; versionNumber: number }> }>();
  const agentPromptRefs: Array<{ nodeId: string; templateId: string; versionNumber: number }> = [];
  for (const ref of PINS.agentNodeRefs(target.graph) as Array<{ nodeId: string; slug: string; versionNumber: number | null }>) {
    const found = seededAgentFor(target.tenantId, ref.slug);
    if (!found || (ref.versionNumber !== null && ref.versionNumber !== SEEDED_AGENT_VERSION)) continue;
    const promptRefs = PINS.agentPromptPins(found.spec.instruction, null) as Array<{ templateId: string; versionNumber: number }>;
    if (found.cloned && promptRefs.length > 0) continue;
    agents[ref.slug] = { task: found.spec.task, outputSchema: found.spec.outputSchema };
    pins.set(ref.nodeId, { versionNumber: SEEDED_AGENT_VERSION, promptRefs });
    for (const prompt of promptRefs) agentPromptRefs.push({ nodeId: ref.nodeId, ...prompt });
  }
  const graph = PINS.pinAgentNodes(target.graph, pins) as WorkflowGraph;
  const promptTemplateRefs = [
    ...(BINDINGS.collectPromptBindings(graph) as Array<{ nodeId: string; promptTemplateId: string; pinnedVersionNumber: number | null }>)
      .filter((binding) => binding.pinnedVersionNumber !== null)
      .map((binding) => ({ nodeId: binding.nodeId, templateId: binding.promptTemplateId, versionNumber: binding.pinnedVersionNumber as number })),
    ...agentPromptRefs,
  ];
  return { graph, agents, promptTemplateRefs };
}

/**
 * TASK-1038 E2 (fix 16) — the compile the regen script runs (`engineOutputFor`): the pinned graph,
 * the publish's prompt refs, `emitDataContract: true` and the resolved agents.
 */
function regenCompile(target: Target, blob: Blob, registryChecksum: string): ReturnType<typeof compile> {
  const pinned = publishPinsFor(target);
  return compile(
    pinned.graph,
    compilerContext(target, blob, registryChecksum, {
      emitDataContract: true,
      agents: pinned.agents,
      policyBindings: {
        guardrailProfile: 'STANDARD',
        redactionRuleSetId: null,
        promptTemplateRefs: pinned.promptTemplateRefs,
        documentTemplateRefs: [],
        contextSchemaVersionId: target.contextSchemaVersionId,
        entitlementKeys: blob.compiledConfig.policyBindings.entitlementKeys,
      },
    }),
  );
}

/** The compiler context the regen script builds (`engineOutputFor`) before its pins and data-contract knobs. */
function compilerContext(target: Target, blob: Blob, registryChecksum: string, extra: Partial<CompilerContext> = {}): CompilerContext {
  const trigger = target.graph.nodes.find((node) => node.type === 'core.trigger');
  const contextSchemaId = (trigger?.config.contextSchema as { contextSchemaId?: string } | undefined)?.contextSchemaId;
  return {
    definitionId: target.id,
    slug: target.slug,
    versionNumber: 1,
    tenantId: target.tenantId,
    paletteKey: 'core',
    compilerVersion: '0.1.0',
    registryChecksum,
    ruleSetVersion: 1,
    caps: REGEN_CAPS,
    policyBindings: {
      guardrailProfile: 'STANDARD',
      redactionRuleSetId: null,
      promptTemplateRefs: [],
      documentTemplateRefs: [],
      contextSchemaVersionId: target.contextSchemaVersionId,
      entitlementKeys: blob.compiledConfig.policyBindings.entitlementKeys,
    },
    triggerContextSchema: contextSchemaId
      ? {
          schemaId: contextSchemaId,
          versionNumber: 1,
          versionId: target.contextSchemaVersionId,
          payloadSchema: payloadSchemaOf(target),
          followsLatest: true,
        }
      : null,
    compiledAt: blob.compiledConfig.compiledAt,
    nodeInfo,
    ...extra,
  };
}

function errorsOf(target: Target, withAgents: boolean): WorkflowFinding[] {
  const report = validate(target.graph, { paletteKey: 'core', registry: workflowNodeClassLookup }, { ruleSetVersion: 1, registryChecksum: 'x' });
  const gate = publishFindings(target.graph, {
    schemaValueProblems: jsonSchemaValueProblems,
    templateReferenceSeverity: TEMPLATE_REFERENCE_SEVERITY_RELEASE_1,
    triggerContextSchema: payloadSchemaOf(target),
    ...(withAgents
      ? { agents: PUBLISH_AGENTS, contextSchemaDefinition: target.contextSchemaDefinition ?? noteSchema.NOTE_CONTEXT_SCHEMA_DEFINITION }
      : {}),
  });
  return [...report.findings, ...gate].filter((finding) => finding.severity === 'ERROR');
}

function nodesOf(config: CompiledWorkflowConfig): CompiledNode[] {
  return [
    ...config.stages.flatMap((stage) => stage.nodes),
    ...(config.loops ?? []).flatMap((loop) => loop.body.stages.flatMap((stage) => stage.nodes)),
  ];
}

function withoutDataContract(config: CompiledWorkflowConfig): Record<string, unknown> {
  const strip = (node: CompiledNode) => {
    const { bindings: _b, consultationReads: _r, ...rest } = node;
    return rest;
  };
  const { settings: _s, checksum: _c, ...rest } = config;
  return { ...rest, stages: rest.stages.map((stage) => ({ ...stage, nodes: stage.nodes.map(strip) })) };
}

describe('seed safety — the 15 seeded workflows', () => {
  it('reads all 15 targets and their committed engine output', () => {
    expect(TARGETS).toHaveLength(15);
    for (const { target, blob } of TARGETS) expect(blob, target.key).toBeDefined();
    // Every agent a seeded graph references is resolvable to a task.
    for (const { target } of TARGETS) {
      for (const node of target.graph.nodes) {
        if (node.type !== 'core.agent') continue;
        const slug = (node.config.agentRef as { slug: string }).slug;
        expect(AGENTS[slug]?.task, `${target.key} ${node.id} ${slug}`).toBeDefined();
      }
    }
  });

  it('every target: zero ERROR findings, as today (agents unresolved, and resolved)', () => {
    for (const { target, blob } of TARGETS) {
      const today = blob.validationReport.findings.filter((finding) => finding.severity === 'ERROR');
      expect(today, target.key).toEqual([]);
      expect(errorsOf(target, false), target.key).toEqual([]);
      expect(errorsOf(target, true), target.key).toEqual([]);
    }
  });

  it('every target, compiled the way the regen script compiles: the committed artifact, and every legacy data input becomes one binding of the same producer key', () => {
    for (const { target, blob, registryChecksum } of TARGETS) {
      const result = regenCompile(target, blob, registryChecksum);
      if (!('config' in result)) throw new Error(`${target.key}: ${JSON.stringify(result.findings)}`);
      // The regen script's compile reproduces the committed artifact exactly (same checksum).
      expect(result.config.checksum, target.key).toBe(blob.compiledConfig.checksum);
      expect(withoutDataContract(result.config), target.key).toEqual(withoutDataContract(blob.compiledConfig));
      expect(result.config.settings?.connections.length, target.key).toBeGreaterThan(0);

      const typeOf = new Map(nodesOf(result.config).map((node) => [node.nodeId, node]));
      for (const node of nodesOf(result.config)) {
        const expected = new Set<string>();
        for (const input of node.inputs) {
          const producer = typeOf.get(input.fromNodeId);
          const port = producer === undefined ? undefined : resolveOutputPort(producer.type, producer.config, input.fromPort);
          if (port === undefined || port.primitive === 'control' || port.outputKey === undefined) continue;
          expected.add(`nodes.${input.fromNodeId}.outputs.${port.outputKey}`);
        }
        const bound = new Set<string>();
        for (const binding of Object.values(node.bindings ?? {})) {
          if ('from' in binding) bound.add(binding.from);
          else if ('firstOf' in binding) for (const path of binding.firstOf) bound.add(path);
        }
        expect([...bound].sort(), `${target.key} ${node.nodeId}`).toEqual([...expected].sort());
      }
    }
  });

  it('the documented seeded patterns translate as the brief requires', () => {
    const global = TARGETS.find((entry) => entry.target.key === 'GLOBAL:general-medicine-consultation');
    if (global === undefined) throw new Error('GLOBAL:general-medicine-consultation not seeded');
    const result = regenCompile(global.target, global.blob, global.registryChecksum);
    if (!('config' in result)) throw new Error('compile failed');
    const nodes = new Map(nodesOf(result.config).map((node) => [node.nodeId, node]));
    expect(nodes.get('n_ner')?.bindings).toEqual({ text: { firstOf: ['nodes.n_transcript.outputs.text', 'nodes.n_asr.outputs.transcript'] } });
    expect(nodes.get('n_output')?.bindings).toEqual({ in: { from: 'nodes.n_finalize.outputs.data' } });
    expect(nodes.get('n_summary')?.bindings).toEqual({
      message: { from: 'nodes.n_ner.outputs.text' },
      context: { from: 'nodes.n_trigger.outputs.context' },
    });
  });

  it('records the WARNINGS the data contract adds, for the report (never blocking)', () => {
    const warnings = TARGETS.flatMap(({ target }) =>
      publishFindings(target.graph, {
        schemaValueProblems: jsonSchemaValueProblems,
        triggerContextSchema: payloadSchemaOf(target),
        agents: PUBLISH_AGENTS,
        contextSchemaDefinition: target.contextSchemaDefinition ?? noteSchema.NOTE_CONTEXT_SCHEMA_DEFINITION,
      })
        .filter((finding) => finding.severity === 'WARNING')
        .map((finding) => `${target.key} ${finding.nodeId ?? '-'} ${finding.code}`),
    );
    // Keep the list explicit so a change in what the seeds warn about is a reviewed diff.
    expect(warnings.every((line) => / (INPUT_MULTIPLE_PRODUCERS|SETTINGS_[A-Z_]+|GUARDRAIL_OPTED_OUT)$/.test(line))).toBe(true);
    console.info(`[seed-safety] ${warnings.length} WARNING findings:\n${warnings.join('\n')}`);
    // Sanity: the registry still declares the ports the translation walked.
    expect(Object.keys(NODE_PORTS).length).toBe(Object.keys(WORKFLOW_NODE_REGISTRY).length);
  });
});
