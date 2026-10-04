/**
 * TASK-1036 C0a — SEED SAFETY. Every seeded workflow (`seed/28-workflow-library.ts`,
 * `seed/29-arcaai-agents-and-workflows.ts`, read-only) must survive the data contract:
 *
 *  1. ZERO new ERROR findings — `validate()` + `publishFindings()` are as clean as the committed
 *     engine output (`*.generated.ts`), both the way the regen script calls the gate (agents
 *     unresolved) and the way the gateway will (agent tasks and output schemas resolved);
 *  2. with `emitDataContract` OFF, `compile()` reproduces the committed artifact BYTE FOR BYTE
 *     (same checksum);
 *  3. with it ON, everything but the three new keys is unchanged, and every legacy data input
 *     binding is translated into exactly one compiled binding that reads the same producer key.
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
import type { AgentIOResolver } from '../node-io';
import { publishFindings, TEMPLATE_REFERENCE_SEVERITY_RELEASE_1, type PublishAgentView } from '../publish-findings';
import type { WorkflowFinding } from '../report';
import { validate } from '../validate';
import { resolveOutputPort } from '../core-contract';
import type { AgentTask } from '../agent-schemas';

const SEED = path.resolve(__dirname, '../../../database/src/prisma/db_main/seed');

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
let AGENTS: AgentIOResolver = {};
let PUBLISH_AGENTS: Record<string, PublishAgentView> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let noteSchema: any;

/** Load the seed modules by path (read-only) — inside a hook, because this package compiles as CommonJS (no top-level await). */
beforeAll(async () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const load = (name: string): Promise<any> => import(/* @vite-ignore */ `${SEED}/${name}`);
  const [library, libraryGenerated, arcaai, arcaaiGenerated, agentsModule, note] = await Promise.all([
    load('28-workflow-library.ts'),
    load('28-workflow-library.generated.ts'),
    load('29-arcaai-agents-and-workflows.ts'),
    load('29-arcaai-agents-and-workflows.generated.ts'),
    load('25-agents.ts'),
    load('07e-consultation-note-context-schema.ts'),
  ]);
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

/** The compiler context the regen script builds (`engineOutputFor`), with the data-contract knobs on top. */
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
    caps: blob.compiledConfig.caps,
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

  it('every target: compiles byte-identically with the data contract off', () => {
    for (const { target, blob, registryChecksum } of TARGETS) {
      const result = compile(target.graph, compilerContext(target, blob, registryChecksum));
      if (!('config' in result)) throw new Error(`${target.key}: ${JSON.stringify(result.findings)}`);
      expect(result.config.checksum, target.key).toBe(blob.compiledConfig.checksum);
      expect(result.config, target.key).toEqual(blob.compiledConfig);
    }
  });

  it('every target: with the data contract on, only the new keys change and every legacy data input becomes one binding of the same producer key', () => {
    for (const { target, blob, registryChecksum } of TARGETS) {
      const result = compile(target.graph, compilerContext(target, blob, registryChecksum, { emitDataContract: true, agents: AGENTS }));
      if (!('config' in result)) throw new Error(`${target.key}: ${JSON.stringify(result.findings)}`);
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
    const result = compile(
      global.target.graph,
      compilerContext(global.target, global.blob, global.registryChecksum, { emitDataContract: true, agents: AGENTS }),
    );
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
