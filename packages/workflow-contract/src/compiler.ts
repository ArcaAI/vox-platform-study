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
 *
 * ## TASK-864 — what the `core` vocabulary adds, all ADDITIVE and keyed on node CLASS
 *
 * The compiler stays registry-free: it reads `CompilerNodeInfo.classes` and nothing else.
 *
 *  - `annotation` (`core.note`) nodes and their edges are STRIPPED before anything else.
 *  - `router` / `review` nodes: an edge leaving any handle other than `out`/`next` is a BRANCH.
 *    It is recorded on the TARGET as a `branchGuards` entry (`{ fromNodeId, handle }`) and is
 *    NOT an input binding — a branch carries no payload, only the fact that it was taken. The
 *    interpreter dispatches a guarded node only when one of its guards was taken.
 *  - `loop` nodes: every node carrying `parentId = <loop id>` is the loop's BODY. Body nodes are
 *    lifted OUT of the top-level stages and compiled — recursively, with the same rules — into
 *    `loops[{ nodeId, body: { stages } }]`. The loop's `each` edges become the body's input
 *    bindings (`fromNodeId = <loop id>, fromPort = 'each'`), which `LoopWorkflow` satisfies from
 *    the current item.
 *  - Both new fields are OMITTED when empty, so every artifact compiled before this ticket is
 *    byte-identical (and so its checksum still verifies).
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import { guardrailOptOutOf } from './guardrail-optout';
import { topologicalLevels } from './graph-algorithms';
import type { WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from './graph-model';
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

/** TASK-864 — one branch a node is gated behind: the router/review node and the handle. */
export interface CompiledBranchGuard {
  fromNodeId: string;
  handle: string;
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
  /** TASK-864 — present only when the node sits behind at least one branch handle. */
  branchGuards?: CompiledBranchGuard[];
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

/** TASK-864 — a `core.loop`'s compiled body, walked once per iteration by `LoopWorkflow`. */
export interface CompiledLoopBody {
  stages: CompiledStage[];
}

export interface CompiledLoop {
  nodeId: string;
  body: CompiledLoopBody;
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
  /**
   * TASK-890 §3.4 — WHICH context-schema version each node that binds one by REFERENCE was
   * frozen against. Structurally a sibling of `promptTemplateRefs`, and the same kind of
   * guarantee: the interpreter validates a run payload against the schema the workflow was
   * PUBLISHED with, never against whatever the tenant has edited since.
   *
   * Additive-optional and OMITTED when empty, so every artifact compiled before this field
   * existed is byte-identical (and its checksum still verifies). Absent means "no node binds
   * a schema by reference", never "unknown".
   */
  contextSchemaRefs?: CompiledContextSchemaRef[];
  /**
   * TASK-890 §3.14 — the WORKFLOW-level guardrail opinion, authored on `core.trigger`
   * (the graph's one mandatory entry node) and folded with the per-node and per-agent
   * opinions by `resolveGuardrailDecision` at run time, node > workflow > agent > on.
   *
   * Tri-state BY ABSENCE: omitted = this workflow expresses no opinion. `{ enabled: true }`
   * is therefore not the same fact as absence — it is a recorded decision to screen.
   */
  guardrail?: { enabled: boolean };
}

/** TASK-890 §3.4 — one node's frozen context-schema binding. */
export interface CompiledContextSchemaRef {
  nodeId: string;
  schemaId: string;
  versionNumber: number;
  versionId: string;
}

/**
 * TASK-950 D-1/D-3 — WHERE a run payload carries the tenant's staff identifier.
 *
 * A structural MIRROR of `UserIdentityBinding` in
 * `@arcaai/applications`' `consultation-context-schema/context-schema-definition.ts`, restated
 * here because this package must not depend on that one. It is deliberately only the TYPE: the
 * derivation itself (`userIdentityBindingFromDefinition`) stays a single implementation on the
 * applications side and its answer is handed in on {@link ResolvedTriggerContextSchema}, exactly
 * as the derived payload schema is. A second derivation living here would eventually disagree
 * about which field HOPE resolves a user from.
 *
 * It is a mapping declaration, never authorization — a caller is still authorized by its own
 * credential.
 */
export interface CompiledUserIdentityBinding {
  kindKey: string;
  field: string;
}

/**
 * TASK-951 D-1 — WHERE a run payload carries ONE open-time fact: a declared kind, and one of
 * that kind's own properties.
 *
 * Structurally identical to {@link CompiledUserIdentityBinding} and named separately for the
 * same reason the applications side names `KindFieldBinding` separately: that one is about
 * identity, this is the shape every ROLE shares.
 */
export interface CompiledKindFieldBinding {
  kindKey: string;
  field: string;
}

/**
 * TASK-951 D-1 — every open-time mapping the trigger's pinned context-schema version declares.
 *
 * A structural MIRROR of `OpenBindings` in `@arcaai/applications`'
 * `consultation-context-schema/context-schema-definition.ts`, restated here because this
 * package must not depend on that one, and deliberately only the TYPE: the derivation
 * (`openBindingsFromDefinition`) stays a single implementation on the applications side and its
 * answer is handed in on {@link ResolvedTriggerContextSchema}, exactly as the derived payload
 * schema and the identity binding are. A second derivation living here would eventually
 * disagree about which field HOPE resolves a department — or a visit type — from.
 *
 * Every key is OPTIONAL and ABSENT when the version declares no marker for that role, because
 * this object is frozen inside the CHECKSUMMED compiled artifact.
 *
 * Like its siblings it is a mapping declaration, never authorization, and the interpreter does
 * not read it: `interpreter.core_trigger` validates against `resolved` / `inline` and nothing
 * else. The gateway acts on these before a run is dispatched.
 */
export interface CompiledOpenBindings {
  userIdentity?: CompiledKindFieldBinding;
  department?: CompiledKindFieldBinding & { by: 'code' | 'name' };
  visitType?: CompiledKindFieldBinding;
  externalRef?: CompiledKindFieldBinding;
  materialize?: { kindKey: string; as: 'CASE_NOTE' }[];
  streamContext?: { kindKey: string };
}

/**
 * TASK-890 §3.4 — what the CALLER resolved about the trigger's `contextSchema.contextSchemaId`.
 *
 * The compiler never reads a database; the service resolves the reference in the caller's
 * tenant (`ConsultationContextSchemaService.resolveReference`) and hands the DERIVED payload
 * schema in. An unresolvable reference never reaches here — it is a blocking publish finding
 * (`CONTEXT_SCHEMA_NOT_FOUND`), so `undefined` here means "nothing to freeze", not "unknown".
 */
export interface ResolvedTriggerContextSchema {
  schemaId: string;
  versionNumber: number;
  versionId: string;
  payloadSchema: Record<string, unknown>;
  /**
   * TASK-950 D-3 — the version's user-identity binding, derived by the same caller from the
   * same definition as `payloadSchema`. Absent (or `null`) means this version declares none.
   */
  userIdentity?: CompiledUserIdentityBinding | null;
  /**
   * TASK-951 D-1 — every open-time mapping of the same version, derived by the same caller
   * from the same definition. Absent means this version declares none; the caller never hands
   * in an empty object.
   */
  openBindings?: CompiledOpenBindings | null;
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
  /** TASK-864 — present only when the graph contains at least one `core.loop`. Sorted by `nodeId`. */
  loops?: CompiledLoop[];
  checksum: string;
}

export interface CompilerNodeInfo {
  activity: string;
  /** Registry-declared classes; a node bearing the `gate` class is lifted out of `stages`. */
  classes: readonly string[];
  /**
   * The node TYPE's own execution budget, used when the author set no `timeoutSeconds`
   * (F13). Optional so a caller may supply a registry-free context; absent falls back to
   * `DEFAULT_TIMEOUT_SECONDS`.
   */
  defaultTimeoutSeconds?: number;
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
  /**
   * TASK-890 §3.4 — the trigger's resolved context schema, when it binds one BY REFERENCE.
   * Absent (or null) leaves the compiled trigger config exactly as authored, INLINE schemas
   * included: an inline schema is already the definition, so there is nothing to resolve.
   */
  triggerContextSchema?: ResolvedTriggerContextSchema | null;
  /** Fixed timestamp for deterministic tests; defaults to `new Date().toISOString()`. */
  compiledAt?: string;
  nodeInfo(type: string): CompilerNodeInfo | undefined;
}

export type CompileResult = { config: CompiledWorkflowConfig } | { findings: WorkflowFinding[] };

/**
 * Last-resort budget for a node whose type declares none. Every registered type DOES declare
 * one (`node-registry.ts` `defaultTimeoutSeconds`, mirrored in the interpreter's `registry.py`
 * and pinned by `test_node_registry_parity.py`), so this is reached only by a context that
 * supplies a registry-free `nodeInfo`. It is deliberately NOT the number an `agent` node gets:
 * 60 s is below the harness's own per-call text budget (`HARNESS_TEXT_TIMEOUT_S`, 120 s), which
 * is exactly the mismatch that cancelled local-model generations mid-flight.
 */
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_RETRY: CompiledRetryPolicy = { maximumAttempts: 1, initialIntervalSeconds: 1, backoffCoefficient: 2 };

/** The classes the compiler keys on (mirrors `core-contract.ts`; duplicated so this module stays registry-free). */
const ROUTER_CLASSES: ReadonlySet<string> = new Set(['router', 'review']);
const LOOP_CLASS = 'loop';
const ANNOTATION_CLASS = 'annotation';
const GATE_CLASS = 'gate';
/** Output handles of a router/review node that carry data or ordering, not a branch. */
const NON_BRANCH_OUTPUTS: ReadonlySet<string> = new Set(['out', 'next']);
/** The loop's body-entry handle. */
const LOOP_EACH_PORT = 'each';
/**
 * The graph's one mandatory entry node. Matched by TYPE rather than by class because both
 * facts this module freezes onto it — the resolved context schema and the workflow's
 * guardrail opinion — are properties of the TRIGGER specifically, not of the `entry` or
 * `boundary` class. Matching a string keeps the compiler registry-free (it imports no
 * descriptor); `publish-findings.ts` reads the same two configs the same way.
 */
const TRIGGER_NODE_TYPE = 'core.trigger';

function clamp(value: number, max: number): number {
  return Math.min(value, max);
}

function hasClass(ctx: CompilerContext, type: string, cls: string): boolean {
  return ctx.nodeInfo(type)?.classes.includes(cls) ?? false;
}

function isBranchEdge(edge: WorkflowGraphEdge, nodesById: Map<string, WorkflowGraphNode>, ctx: CompilerContext): boolean {
  const from = nodesById.get(edge.from);
  if (from === undefined) return false;
  const info = ctx.nodeInfo(from.type);
  if (info === undefined || !info.classes.some((cls) => ROUTER_CLASSES.has(cls))) return false;
  return !NON_BRANCH_OUTPUTS.has(edge.fromPort);
}

function compileNode(
  node: WorkflowGraphNode,
  incoming: readonly WorkflowGraphEdge[],
  nodesById: Map<string, WorkflowGraphNode>,
  ctx: CompilerContext,
  activity: string,
): CompiledNode {
  const config = compiledConfigFor(node, ctx);
  const requestedTimeout =
    typeof config.timeoutSeconds === 'number' ? config.timeoutSeconds : (ctx.nodeInfo(node.type)?.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  const requestedRetry = typeof config.retry === 'object' && config.retry !== null ? (config.retry as Partial<CompiledRetryPolicy>) : {};

  const inputs: CompiledInputBinding[] = incoming
    .filter((edge) => !isBranchEdge(edge, nodesById, ctx))
    .map((edge) => ({ fromNodeId: edge.from, fromPort: edge.fromPort, toPort: edge.toPort }))
    // Deterministic regardless of authored edge order, per the shuffle-invariance property —
    // this does NOT contradict "array order is authored intent" (canonical-json.ts): that rule
    // protects the compiled OUTPUT's array order, not the compiler's internal aggregation of
    // scattered edges into one node's input list.
    .sort((a, b) => (a.toPort === b.toPort ? a.fromNodeId.localeCompare(b.fromNodeId) : a.toPort.localeCompare(b.toPort)));

  const branchGuards: CompiledBranchGuard[] = incoming
    .filter((edge) => isBranchEdge(edge, nodesById, ctx))
    .map((edge) => ({ fromNodeId: edge.from, handle: edge.fromPort }))
    .sort((a, b) => (a.fromNodeId === b.fromNodeId ? a.handle.localeCompare(b.handle) : a.fromNodeId.localeCompare(b.fromNodeId)));

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
    // Omitted when empty — see the module docstring (byte-identical legacy artifacts).
    ...(branchGuards.length > 0 ? { branchGuards } : {}),
  };
}

/**
 * A node's compiled config: verbatim as authored, except on the trigger, where a
 * BY-REFERENCE context schema gains the derived payload schema the caller resolved.
 *
 * `resolved` sits BESIDE the authored `contextSchemaId` / `versionNumber` rather than
 * replacing them: the reference is what the author wrote and what a re-publish re-resolves,
 * while `resolved` is the frozen answer the interpreter validates against without a
 * database read (invariant 4).
 *
 * TASK-950 D-3 — `userIdentity` freezes beside `resolved`, from the same resolution, for the
 * same reason: which field carries the staff identifier is a property of the version the
 * workflow was PUBLISHED against, and no run may re-read a schema row to learn it. It is
 * OMITTED when the resolution declares none, so an artifact whose schema has no identity
 * field compiles to exactly the bytes it did before this ticket and its checksum still
 * verifies. It never affects validation: `interpreter.core_trigger` reads `resolved` /
 * `inline` and nothing else.
 *
 * TASK-951 D-1 — `openBindings` freezes beside both, on the same terms and for the same
 * reason: which field carries the department, the visit type or the external reference is a
 * property of the version the workflow was PUBLISHED against. Omitted when the resolution
 * declares none, so nothing that compiled before this ticket moves.
 */
function compiledConfigFor(node: WorkflowGraphNode, ctx: CompilerContext): Record<string, unknown> {
  const config = node.config ?? {};
  if (node.type !== TRIGGER_NODE_TYPE) return config;

  const resolved = ctx.triggerContextSchema;
  if (resolved === undefined || resolved === null) return config;

  const authored = config.contextSchema;
  const contextSchema = typeof authored === 'object' && authored !== null && !Array.isArray(authored) ? (authored as Record<string, unknown>) : {};

  return {
    ...config,
    contextSchema: {
      ...contextSchema,
      resolved: resolved.payloadSchema,
      ...(resolved.userIdentity ? { userIdentity: resolved.userIdentity } : {}),
      ...(resolved.openBindings ? { openBindings: resolved.openBindings } : {}),
    },
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

interface Scope {
  /** The nodes of this scope — top-level nodes, or one loop's body. */
  nodes: WorkflowGraphNode[];
  /** Edges INSIDE this scope, plus (for a body) the loop's `each` edges into it. */
  edges: WorkflowGraphEdge[];
}

type ScopeResult = { stages: CompiledStage[]; gates: CompiledGate[]; loops: CompiledLoop[] } | { findings: WorkflowFinding[] };

/**
 * Compile one SCOPE (the top level, or a loop body) into stages, lifting gates and compiling
 * nested loop bodies recursively.
 */
function compileScope(
  scope: Scope,
  allNodesById: Map<string, WorkflowGraphNode>,
  bodiesByLoop: Map<string, WorkflowGraphNode[]>,
  allEdges: readonly WorkflowGraphEdge[],
  ctx: CompilerContext,
): ScopeResult {
  const scopeIds = new Set(scope.nodes.map((node) => node.id));
  // Topological ordering considers only edges BETWEEN scope members; an `each` edge from the
  // enclosing loop is a binding, not an ordering constraint inside the body.
  const orderingEdges = scope.edges.filter((edge) => scopeIds.has(edge.from) && scopeIds.has(edge.to));
  const levels = topologicalLevels({ version: 1, nodes: scope.nodes, edges: orderingEdges });
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

  const gateIds = new Set(scope.nodes.filter((node) => hasClass(ctx, node.type, GATE_CLASS)).map((node) => node.id));

  const stages: CompiledStage[] = [];
  const loops: CompiledLoop[] = [];
  for (const level of levels.levels) {
    const stageNodeIds = level.filter((id) => !gateIds.has(id)).sort();
    if (stageNodeIds.length === 0) continue;
    const nodes: CompiledNode[] = [];
    for (const id of stageNodeIds) {
      const node = allNodesById.get(id) as WorkflowGraphNode;
      const info = ctx.nodeInfo(node.type) as CompilerNodeInfo;
      const incoming = scope.edges.filter((edge) => edge.to === node.id);
      nodes.push(compileNode(node, incoming, allNodesById, ctx, info.activity));

      if (hasClass(ctx, node.type, LOOP_CLASS)) {
        const body = bodiesByLoop.get(node.id) ?? [];
        const bodyIds = new Set(body.map((member) => member.id));
        const bodyEdges = allEdges.filter(
          (edge) =>
            (bodyIds.has(edge.from) && bodyIds.has(edge.to)) || (edge.from === node.id && edge.fromPort === LOOP_EACH_PORT && bodyIds.has(edge.to)),
        );
        const compiledBody = compileScope({ nodes: body, edges: bodyEdges }, allNodesById, bodiesByLoop, allEdges, ctx);
        if ('findings' in compiledBody) return compiledBody;
        loops.push({ nodeId: node.id, body: { stages: compiledBody.stages } }, ...compiledBody.loops);
      }
    }
    stages.push({ stageIndex: stages.length, nodes });
  }

  const gates: CompiledGate[] = Array.from(gateIds)
    .sort()
    .map((id) => compileGate(allNodesById.get(id) as WorkflowGraphNode, ctx));

  return { stages, gates, loops };
}

/**
 * Compile a graph into its `compiledConfig`. Total: returns `{ findings }` (never throws) when
 * the graph is not shape-safe for compilation (e.g. contains a cycle, so no topological stage
 * assignment exists) or references a node type the context cannot resolve.
 */
export function compile(graph: WorkflowGraph, ctx: CompilerContext): CompileResult {
  try {
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

    // 1) Strip annotations (TASK-864): a note is a canvas comment and never executes.
    const annotationIds = new Set(graph.nodes.filter((node) => hasClass(ctx, node.type, ANNOTATION_CLASS)).map((node) => node.id));
    const nodes = graph.nodes.filter((node) => !annotationIds.has(node.id));
    const edges = graph.edges.filter((edge) => !annotationIds.has(edge.from) && !annotationIds.has(edge.to));

    const nodesById = new Map(nodes.map((node) => [node.id, node]));

    // 2) Partition loop bodies (TASK-864) by `parentId`. A body whose loop is not a loop-classed
    //    node, or whose wiring crosses the body boundary, is refused by `loopBodyProblems` at
    //    publish; here only the partition is needed.
    const bodiesByLoop = new Map<string, WorkflowGraphNode[]>();
    const topLevel: WorkflowGraphNode[] = [];
    for (const node of nodes) {
      const parentId = node.parentId;
      if (typeof parentId === 'string' && nodesById.has(parentId) && hasClass(ctx, (nodesById.get(parentId) as WorkflowGraphNode).type, LOOP_CLASS)) {
        const body = bodiesByLoop.get(parentId) ?? [];
        body.push(node);
        bodiesByLoop.set(parentId, body);
      } else {
        topLevel.push(node);
      }
    }
    const topLevelIds = new Set(topLevel.map((node) => node.id));
    const topLevelEdges = edges.filter((edge) => topLevelIds.has(edge.from) && topLevelIds.has(edge.to));

    const compiled = compileScope({ nodes: topLevel, edges: topLevelEdges }, nodesById, bodiesByLoop, edges, ctx);
    if ('findings' in compiled) return compiled;

    const loops = compiled.loops.slice().sort((a, b) => a.nodeId.localeCompare(b.nodeId));

    // TASK-890 — the two additive `policyBindings` facts, derived from the trigger. Both are
    // OMITTED when there is nothing to say, so an artifact that binds neither compiles to the
    // same bytes (and the same checksum) it did before either field existed.
    const trigger = topLevel.find((node) => node.type === TRIGGER_NODE_TYPE);
    const contextSchemaRefs: CompiledContextSchemaRef[] =
      trigger !== undefined && ctx.triggerContextSchema !== undefined && ctx.triggerContextSchema !== null
        ? [
            {
              nodeId: trigger.id,
              schemaId: ctx.triggerContextSchema.schemaId,
              versionNumber: ctx.triggerContextSchema.versionNumber,
              versionId: ctx.triggerContextSchema.versionId,
            },
          ]
        : [];
    const workflowGuardrail = trigger === undefined ? null : guardrailOptOutOf(trigger.config);

    const policyBindings: CompiledPolicyBindings = {
      ...ctx.policyBindings,
      ...(contextSchemaRefs.length > 0 ? { contextSchemaRefs } : {}),
      ...(workflowGuardrail === null ? {} : { guardrail: { enabled: workflowGuardrail } }),
    };

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
      stages: compiled.stages,
      gates: compiled.gates,
      policyBindings,
      caps: ctx.caps,
      // Omitted when empty — see the module docstring (byte-identical legacy artifacts).
      ...(loops.length > 0 ? { loops } : {}),
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
