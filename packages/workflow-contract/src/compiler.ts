/**
 * The deterministic graph → `compiledConfig` compiler. This ticket DEFINES
 * the compiled-config format — see
 * `packages/workflow-contract/schemas/compiled-config.schema.json`
 * for the normative shape and its binding rules (no SIGNED node, `onTimeout` never means
 * approved, unknown `formatVersion` refused, `checksum` verified before execution).
 *
 * `compile()` assumes the graph has already passed `validate()` — it does not re-run the rule
 * catalogue — but it is still TOTAL: a structurally broken graph (a cycle, a dangling
 * reference) yields `{ findings }` rather than throwing, because a compiler that can be handed
 * an unsafe graph and silently produce SOMETHING is the exact failure mode warns about.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import { topologicalLevels } from './graph-algorithms';
import type { WorkflowGraph, WorkflowGraphNode } from './graph-model';
import { internalErrorFinding } from './report';
import type { WorkflowFinding } from './report';

export type CompiledGuardrailProfile = 'STANDARD' | 'STRICT' | 'RELAXED';

export interface CompiledRetryPolicy {
  maximumAttempts: number;
  initialIntervalSeconds: number;
  backoffCoefficient: number;
}

export interface CompiledInputBinding {
  fromNodeId: string;
  fromPort: string;
  toPort: string;
}

export interface CompiledNode {
  nodeId: string;
  type: string;
  activity: string;
  config: Record<string, unknown>;
  timeoutSeconds: number;
  retry: CompiledRetryPolicy;
  inputs: CompiledInputBinding[];
  onError: 'fail' | 'degrade';
  emitsTrajectory: true;
}

export interface CompiledStage {
  stageIndex: number;
  nodes: CompiledNode[];
}

export interface CompiledGate {
  nodeId: string;
  gateType: string;
  blocking: boolean;
  timeoutSeconds: number;
  onTimeout: string;
}

export interface CompiledPolicyBindings {
  guardrailProfile: CompiledGuardrailProfile;
  redactionRuleSetId: string | null;
  promptTemplateRefs: Array<{ nodeId: string; templateId: string; versionNumber: number }>;
  /**
   * WHICH `DocumentTemplate` version each generation node decodes its output
   * into, pinned at publish. Structurally identical to `promptTemplateRefs` and a DIFFERENT
   * guarantee: that one pins what the model is TOLD, this one pins the SHAPE it is decoded
   * into, so a tenant publishing a new template version cannot restructure a document a
   * published clinical workflow is already producing.
   *
   * SORTED by `nodeId` and UNPINNED bindings omitted — see `buildCompilerContext` in
   * `@arcaai/applications`' `workflow-definition.service.ts`, which derives it.
   */
  documentTemplateRefs: Array<{ nodeId: string; templateId: string; versionNumber: number }>;
  contextSchemaVersionId: string | null;
  entitlementKeys: string[];
}

export interface CompiledCaps {
  maxTotalSeconds: number;
  maxNodeSeconds: number;
  maxAttempts: number;
}

export interface CompiledWorkflowConfig {
  formatVersion: 1;
  definitionId: string;
  slug: string;
  versionNumber: number;
  tenantId: string;
  paletteKey: string;
  compiledAt: string;
  compilerVersion: string;
  registryChecksum: string;
  ruleSetVersion: number;
  stages: CompiledStage[];
  gates: CompiledGate[];
  policyBindings: CompiledPolicyBindings;
  caps: CompiledCaps;
  checksum: string;
}

export interface CompilerNodeInfo {
  activity: string;
  /** Registry-declared classes; a node bearing the `gate` class is lifted out of `stages`. */
  classes: readonly string[];
}

export interface CompilerContext {
  definitionId: string;
  slug: string;
  versionNumber: number;
  tenantId: string;
  paletteKey: string;
  compilerVersion: string;
  registryChecksum: string;
  ruleSetVersion: number;
  caps: CompiledCaps;
  policyBindings: CompiledPolicyBindings;
  /** Fixed timestamp for deterministic tests; defaults to `new Date().toISOString()`. */
  compiledAt?: string;
  nodeInfo(type: string): CompilerNodeInfo | undefined;
}

export type CompileResult = { config: CompiledWorkflowConfig } | { findings: WorkflowFinding[] };

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_RETRY: CompiledRetryPolicy = { maximumAttempts: 1, initialIntervalSeconds: 1, backoffCoefficient: 2 };

function clamp(value: number, max: number): number {
  return Math.min(value, max);
}

function compileNode(node: WorkflowGraphNode, graph: WorkflowGraph, ctx: CompilerContext, activity: string): CompiledNode {
  const config = node.config ?? {};
  const requestedTimeout = typeof config.timeoutSeconds === 'number' ? config.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
  const requestedRetry = typeof config.retry === 'object' && config.retry !== null ? (config.retry as Partial<CompiledRetryPolicy>) : {};

  const inputs: CompiledInputBinding[] = graph.edges
    .filter((edge) => edge.to === node.id)
    .map((edge) => ({ fromNodeId: edge.from, fromPort: edge.fromPort, toPort: edge.toPort }))
    // Deterministic regardless of authored edge order, per the shuffle-invariance property —
    // this does NOT contradict "array order is authored intent" (canonical-json.ts): that rule
    // protects the compiled OUTPUT's array order, not the compiler's internal aggregation of
    // scattered edges into one node's input list.
    .sort((a, b) => (a.toPort === b.toPort ? a.fromNodeId.localeCompare(b.fromNodeId) : a.toPort.localeCompare(b.toPort)));

  return {
    nodeId: node.id,
    type: node.type,
    activity,
    config,
    timeoutSeconds: clamp(requestedTimeout, ctx.caps.maxNodeSeconds),
    retry: {
      maximumAttempts: clamp(requestedRetry.maximumAttempts ?? DEFAULT_RETRY.maximumAttempts, ctx.caps.maxAttempts),
      initialIntervalSeconds: requestedRetry.initialIntervalSeconds ?? DEFAULT_RETRY.initialIntervalSeconds,
      backoffCoefficient: requestedRetry.backoffCoefficient ?? DEFAULT_RETRY.backoffCoefficient,
    },
    inputs,
    onError: config.onError === 'degrade' ? 'degrade' : 'fail',
    emitsTrajectory: true,
  };
}

function compileGate(node: WorkflowGraphNode, ctx: CompilerContext): CompiledGate {
  const config = node.config ?? {};
  const requestedTimeout = typeof config.timeoutSeconds === 'number' ? config.timeoutSeconds : ctx.caps.maxNodeSeconds;
  return {
    nodeId: node.id,
    gateType: typeof config.gateType === 'string' ? config.gateType : node.type,
    blocking: config.blocking !== false,
    timeoutSeconds: clamp(requestedTimeout, ctx.caps.maxTotalSeconds),
    // Never a value that means "approved" — INV-001/INV-147/INV-181 (see contracts/README.md).
    // A timeout always resolves to a non-approval outcome; the graph never authors this field
    // directly to "APPROVED" because no node type in the registry can carry that meaning.
    onTimeout: typeof config.onTimeout === 'string' ? config.onTimeout : 'TIMED_OUT',
  };
}

/**
 * Compile a graph into its `compiledConfig`. Total: returns `{ findings }` (never throws) when
 * the graph is not shape-safe for compilation (e.g. contains a cycle, so no topological stage
 * assignment exists) or references a node type the context cannot resolve.
 */
export function compile(graph: WorkflowGraph, ctx: CompilerContext): CompileResult {
  try {
    const levels = topologicalLevels(graph);
    if ('cycle' in levels) {
      return {
        findings: [
          {
            ruleId: 'WF-S-001',
            ruleClass: 'structural',
            severity: 'ERROR',
            nodeId: null,
            message: `cannot compile: graph contains a cycle involving: ${levels.cycle.join(', ')}`,
          },
        ],
      };
    }

    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const unresolvable = graph.nodes.filter((node) => ctx.nodeInfo(node.type) === undefined);
    if (unresolvable.length > 0) {
      return {
        findings: unresolvable.map((node) => ({
          ruleId: 'WF-C-002',
          ruleClass: 'schema',
          severity: 'ERROR',
          nodeId: node.id,
          message: `cannot compile: node type "${node.type}" is not a registered node type`,
        })),
      };
    }

    const gateIds = new Set(
      graph.nodes.filter((node) => (ctx.nodeInfo(node.type) as CompilerNodeInfo).classes.includes('gate')).map((node) => node.id),
    );

    const stages: CompiledStage[] = [];
    for (const level of levels.levels) {
      const stageNodeIds = level.filter((id) => !gateIds.has(id)).sort();
      if (stageNodeIds.length === 0) continue;
      stages.push({
        stageIndex: stages.length,
        nodes: stageNodeIds.map((id) => {
          const node = nodesById.get(id) as WorkflowGraphNode;
          const info = ctx.nodeInfo(node.type) as CompilerNodeInfo;
          return compileNode(node, graph, ctx, info.activity);
        }),
      });
    }

    const gates: CompiledGate[] = Array.from(gateIds)
      .sort()
      .map((id) => compileGate(nodesById.get(id) as WorkflowGraphNode, ctx));

    const withoutChecksum = {
      formatVersion: 1 as const,
      definitionId: ctx.definitionId,
      slug: ctx.slug,
      versionNumber: ctx.versionNumber,
      tenantId: ctx.tenantId,
      paletteKey: ctx.paletteKey,
      compiledAt: ctx.compiledAt ?? new Date().toISOString(),
      compilerVersion: ctx.compilerVersion,
      registryChecksum: ctx.registryChecksum,
      ruleSetVersion: ctx.ruleSetVersion,
      stages,
      gates,
      policyBindings: ctx.policyBindings,
      caps: ctx.caps,
    };

    const checksum = sha256Hex(canonicalJson(withoutChecksum));

    return { config: { ...withoutChecksum, checksum } };
  } catch (error) {
    return { findings: [internalErrorFinding('WF-COMPILE', 'structural', error)] };
  }
}

// A minimal dependency-free sha256 would be a lot of code to hand-roll and re-verify; Node's
// `node:crypto` is a BUILT-IN module, not an npm dependency, so importing it does not violate
// this package's "zero runtime dependencies" property. This package's consumers (the
// `packages/database` seed and `@arcaai/applications`) are both Node-only, unlike
// `packages/json-schema-subset` which is also bundled into the browser SDK and therefore
// cannot use any Node built-in.
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
