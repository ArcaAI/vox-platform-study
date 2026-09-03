/**
 * TASK-864 — the `core` vocabulary's CONTRACT beyond what a JSON Schema can say: the action
 * catalogue behind `core.action`, the per-instance (dynamic) branch handles of the router
 * nodes, the loop-body rules, and the publish-time checks.
 *
 * Everything here is pure and total (the house `problems: string[]` idiom); nothing reads a
 * row, a clock or the network. The applications layer resolves the REFERENCES this module only
 * shape-checks (an Agent slug, a registry model slug, a context-schema id).
 */
import { EXPRESSION_CONTEXT_ROOTS, expressionProblems, expressionRootIdentifiers } from './expressions';
import type { WorkflowGraph, WorkflowGraphNode } from './graph-model';
import { EMPTY_PORTS, NODE_PORTS, type WorkflowNodePorts } from './node-ports';
import { WORKFLOW_NODE_REGISTRY, type WorkflowNodeDescriptor } from './node-registry';
import type { WorkflowPortDescriptor } from './port-model';

// =============================================================================================
// Classes the compiler and the interpreter key on
// =============================================================================================

/** An edge leaving any handle of a `router` node other than `out`/`next` is a BRANCH. */
export const ROUTER_NODE_CLASS = 'router';
/** In-stage human wait; its `approved`/`rejected`/`timedOut` handles are branches too. */
export const REVIEW_NODE_CLASS = 'review';
/** Nodes carrying `parentId = <this node>` are its body. */
export const LOOP_NODE_CLASS = 'loop';
/** A canvas comment — stripped by `compile()`, never dispatched. */
export const ANNOTATION_NODE_CLASS = 'annotation';

/** Output handles that carry DATA (or ordering) rather than a branch, on every router/review node. */
const NON_BRANCH_OUTPUTS: ReadonlySet<string> = new Set(['out', 'next']);

export const CORE_TRIGGER_KINDS = ['consultation', 'api', 'webhook', 'schedule'] as const;
export type CoreTriggerKind = (typeof CORE_TRIGGER_KINDS)[number];

export const CORE_OUTPUT_PROTOCOLS = ['http', 'http-sse', 'socket'] as const;
export type CoreOutputProtocol = (typeof CORE_OUTPUT_PROTOCOLS)[number];

/** What an Output node declares when it says nothing: SSE is the default publish protocol (D-4). */
export const DEFAULT_OUTPUT_PROTOCOLS: readonly CoreOutputProtocol[] = Object.freeze(['http-sse']);

// =============================================================================================
// The ACTION CATALOGUE — every remaining fixed-purpose clinical step, keyed
// =============================================================================================

export interface CoreActionDescriptor {
  /** The `actionKey` a `core.action` node carries — the legacy node type's own key, so a
   *  migration is a rename of `type` to `core.action` + `actionKey`, nothing else. */
  readonly key: string;
  /** The legacy node type whose activity, config schema and ports this action reuses. */
  readonly delegateType: string;
  readonly label: string;
}

/**
 * The legacy node types that survive as ACTIONS. Excluded on purpose: the input/output/agent
 * shapes (`input.context_binding`, `output.deliver`, `agentic.input/output/agent/loop/data/stt/
 * tts`, `generate.text`, `consultation.synthesize`, `agent.{summarization,presummarization,
 * discharge_summary}`, `consultation.hitlGate`) — those map onto a `core.*` PRIMITIVE, and an
 * action that duplicated one would give the same capability two homes.
 */
const ACTION_KEYS: readonly string[] = Object.freeze([
  'consultation.consentGate',
  'consultation.captureBinding',
  'consultation.extractEntities',
  'consultation.bindTerminology',
  'consultation.phiHop',
  'consultation.retrieveEvidence',
  'consultation.assemblePrompt',
  'consultation.sensors',
  'consultation.inferentialSensors',
  'consultation.persistDraft',
  'consultation.finalizeAssurance',
  'consultation.realtimeSummary',
  'consultation.suggestions',
  'consultation.proposeCorrections',
  'agent.transcription',
  'agent.normalization',
  'agent.ner',
  'agent.grammar',
  'agent.important_findings',
  'agent.retrieval',
  'agent.feedback',
  'agent.dna_redaction',
  'guard.phi',
  'guard.moderation',
  'guard.groundedness',
  'guardrail.check',
  'agentic.guardrail',
  'session.timeout',
  'summary.finalize',
  'feedback.capture',
  'prompt.template_ref',
]);

function humanLabel(key: string): string {
  const tail = key.slice(key.indexOf('.') + 1);
  return tail
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/** `actionKey -> descriptor`. Derived from the registry so a key that stops existing fails here. */
export const ACTION_CATALOGUE: Readonly<Record<string, CoreActionDescriptor>> = Object.freeze(
  Object.fromEntries(
    ACTION_KEYS.filter((key) => WORKFLOW_NODE_REGISTRY[key] !== undefined).map((key) => [
      key,
      Object.freeze({ key, delegateType: key, label: humanLabel(key) }),
    ]),
  ),
);

/** The registry descriptor an action delegates to, or `undefined` for an unknown key. */
export function actionDelegateOf(config: Readonly<Record<string, unknown>> | undefined): WorkflowNodeDescriptor | undefined {
  const key = config?.actionKey;
  if (typeof key !== 'string') return undefined;
  const action = ACTION_CATALOGUE[key];
  return action === undefined ? undefined : WORKFLOW_NODE_REGISTRY[action.delegateType];
}

/** The config schema the action's own `action` sub-config must satisfy (the delegate's). */
export function actionConfigSchemaOf(config: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  return actionDelegateOf(config)?.configSchema;
}

// =============================================================================================
// Effective ports — per INSTANCE, where the static table is a superset
// =============================================================================================

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function keysOf(config: Readonly<Record<string, unknown>> | undefined, field: string): string[] {
  const items = config?.[field];
  if (!Array.isArray(items)) return [];
  return items.map((item) => asObject(item)?.key).filter((key): key is string => typeof key === 'string' && key.length > 0);
}

/**
 * The BRANCH handles an instance fans out to. Static for a review node, per-config for the two
 * routers. Empty for every other node type.
 */
export function branchHandlesOf(nodeType: string, config: Readonly<Record<string, unknown>> | undefined): string[] {
  switch (nodeType) {
    case 'core.classify':
      return [...keysOf(config, 'classes'), 'otherwise'];
    case 'core.condition':
      return [...keysOf(config, 'branches'), 'else'];
    case 'core.humanReview':
      return ['approved', 'rejected', 'timedOut'];
    default:
      return [];
  }
}

/** Whether `portName` on an instance of `nodeType` is a branch handle (a `control` output). */
export function isBranchHandle(nodeType: string, config: Readonly<Record<string, unknown>> | undefined, portName: string): boolean {
  if (NON_BRANCH_OUTPUTS.has(portName)) return false;
  return branchHandlesOf(nodeType, config).includes(portName);
}

/**
 * The ports an INSTANCE actually offers. `core.action` takes its delegate's table (the action
 * IS the legacy node, under a key); the routers add one `control` output per declared class /
 * branch; everything else is the static table.
 */
export function effectivePorts(nodeType: string, config: Readonly<Record<string, unknown>> | undefined): WorkflowNodePorts {
  if (nodeType === 'core.action') {
    const delegate = actionDelegateOf(config);
    if (delegate !== undefined) return { inputs: delegate.inputs, outputs: delegate.outputs };
  }
  const base = NODE_PORTS[nodeType] ?? EMPTY_PORTS;
  const dynamic = branchHandlesOf(nodeType, config).filter((handle) => !base.outputs.some((port) => port.name === handle));
  if (dynamic.length === 0) return base;
  const outputs: WorkflowPortDescriptor[] = [
    ...base.outputs,
    ...dynamic.map((name) => Object.freeze({ name, primitive: 'control' as const, required: false, multiple: true })),
  ];
  return { inputs: base.inputs, outputs };
}

/** One OUTPUT port of an instance by name — static or dynamic — or `undefined`. */
export function resolveOutputPort(
  nodeType: string,
  config: Readonly<Record<string, unknown>> | undefined,
  portName: string,
): WorkflowPortDescriptor | undefined {
  return effectivePorts(nodeType, config).outputs.find((port) => port.name === portName);
}

/** One INPUT port of an instance by name, or `undefined`. */
export function resolveInputPort(
  nodeType: string,
  config: Readonly<Record<string, unknown>> | undefined,
  portName: string,
): WorkflowPortDescriptor | undefined {
  return effectivePorts(nodeType, config).inputs.find((port) => port.name === portName);
}

// =============================================================================================
// Publish-time checks a JSON Schema cannot express
// =============================================================================================

export interface CoreNodeView {
  readonly id: string;
  readonly type: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

function uniqueKeyProblems(nodeId: string, field: string, keys: readonly string[], reserved: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (reserved.includes(key)) problems.push(`node \`${nodeId}\`: \`${field}\` key \`${key}\` is reserved for a static handle.`);
    if (seen.has(key)) problems.push(`node \`${nodeId}\`: \`${field}\` key \`${key}\` is declared twice — a handle must be unique.`);
    seen.add(key);
  }
  return problems;
}

function celProblems(nodeId: string, field: string, source: unknown): string[] {
  if (source === undefined) return [];
  const parse = expressionProblems(source);
  if (parse.length > 0) return parse.map((problem) => `node \`${nodeId}\`: \`${field}\`: ${problem}`);
  const unknownRoots = expressionRootIdentifiers(source as string).filter((root) => !EXPRESSION_CONTEXT_ROOTS.includes(root));
  return unknownRoots.map(
    (root) => `node \`${nodeId}\`: \`${field}\` reads \`${root}\`, which is not a run-context root (${EXPRESSION_CONTEXT_ROOTS.join(', ')}).`,
  );
}

/**
 * Publish-blocking problems for one `core.*` node. A no-op for every other node type, exactly
 * as `agenticNodeConfigProblems` is for its catalogue.
 */
export function coreNodeConfigProblems(node: CoreNodeView): string[] {
  if (!node.type.startsWith('core.')) return [];
  const config = node.config ?? {};
  const problems: string[] = [];

  switch (node.type) {
    case 'core.trigger': {
      const kinds = Array.isArray(config.kinds) ? config.kinds : [];
      if (kinds.length === 0) problems.push(`node \`${node.id}\`: \`kinds\` must name at least one trigger kind.`);
      for (const kind of kinds) {
        if (!(CORE_TRIGGER_KINDS as readonly unknown[]).includes(kind)) {
          problems.push(`node \`${node.id}\`: \`kinds\` contains \`${String(kind)}\`, which is not one of ${CORE_TRIGGER_KINDS.join(' / ')}.`);
        }
      }
      const schema = asObject(config.contextSchema);
      if (schema !== undefined) {
        const inline = schema.inline !== undefined;
        const byRef = typeof schema.contextSchemaId === 'string' && schema.contextSchemaId.length > 0;
        if (inline && byRef) problems.push(`node \`${node.id}\`: \`contextSchema\` must be EITHER inline OR a row reference, not both.`);
        if (!inline && !byRef) problems.push(`node \`${node.id}\`: \`contextSchema\` declares neither \`inline\` nor \`contextSchemaId\`.`);
      }
      break;
    }
    case 'core.agent': {
      const ref = asObject(config.agentRef);
      if (ref === undefined || typeof ref.slug !== 'string' || ref.slug.length === 0) {
        problems.push(`node \`${node.id}\`: \`agentRef.slug\` is required — an Agent node references a published Agent by slug.`);
      }
      break;
    }
    case 'core.classify': {
      if (typeof config.modelSlug !== 'string' || config.modelSlug.length === 0) {
        problems.push(`node \`${node.id}\`: \`modelSlug\` is required — a Classify node names a registry classification model.`);
      }
      const keys = keysOf(config, 'classes');
      if (keys.length === 0) problems.push(`node \`${node.id}\`: \`classes\` must declare at least one class.`);
      problems.push(...uniqueKeyProblems(node.id, 'classes', keys, ['otherwise', 'out', 'next']));
      break;
    }
    case 'core.condition': {
      const keys = keysOf(config, 'branches');
      if (keys.length === 0) problems.push(`node \`${node.id}\`: \`branches\` must declare at least one branch.`);
      problems.push(...uniqueKeyProblems(node.id, 'branches', keys, ['else', 'out', 'next']));
      const branches = Array.isArray(config.branches) ? config.branches : [];
      branches.forEach((branch, index) => {
        const when = asObject(branch)?.when;
        problems.push(...celProblems(node.id, `branches[${index}].when`, when ?? ''));
      });
      break;
    }
    case 'core.loop': {
      const mode = config.mode;
      if (mode === 'foreach' && (typeof config.over !== 'string' || config.over.length === 0)) {
        problems.push(`node \`${node.id}\`: a \`foreach\` loop needs \`over\` — the run-context path of the array to iterate.`);
      }
      if (mode === 'while') {
        if (typeof config.until !== 'string' || config.until.length === 0) {
          problems.push(`node \`${node.id}\`: a \`while\` loop needs \`until\` — the CEL expression that ends it.`);
        } else {
          problems.push(...celProblems(node.id, 'until', config.until));
        }
      }
      if (mode !== 'foreach' && mode !== 'while') problems.push(`node \`${node.id}\`: \`mode\` must be \`foreach\` or \`while\`.`);
      const bounds = asObject(config.bounds);
      for (const bound of ['maxIterations', 'maxDurationSeconds', 'maxTotalTokens'] as const) {
        if (bounds === undefined || typeof bounds[bound] !== 'number') {
          problems.push(
            `node \`${node.id}\`: \`bounds.${bound}\` is required — a loop bounded on fewer than all three axes is unbounded on the missing one.`,
          );
        }
      }
      break;
    }
    case 'core.output': {
      const protocols = config.protocols;
      if (protocols !== undefined) {
        if (!Array.isArray(protocols) || protocols.length === 0) {
          problems.push(`node \`${node.id}\`: \`protocols\` must name at least one of ${CORE_OUTPUT_PROTOCOLS.join(' / ')}.`);
        } else {
          for (const protocol of protocols) {
            if (!(CORE_OUTPUT_PROTOCOLS as readonly unknown[]).includes(protocol)) {
              problems.push(
                `node \`${node.id}\`: \`protocols\` contains \`${String(protocol)}\`, which is not one of ${CORE_OUTPUT_PROTOCOLS.join(' / ')}.`,
              );
            }
          }
        }
      }
      break;
    }
    case 'core.action': {
      const key = config.actionKey;
      if (typeof key !== 'string' || ACTION_CATALOGUE[key] === undefined) {
        problems.push(`node \`${node.id}\`: \`actionKey\` ${JSON.stringify(key ?? null)} is not in the action catalogue.`);
      }
      break;
    }
    default:
      break;
  }
  return problems;
}

/**
 * Loop-body problems over the WHOLE graph: a body names a real loop; a body never wires outside
 * its loop except through the loop's own `each` (in) and the loop's `done` (out, from the loop
 * node itself); an `each` edge targets a body node of that loop.
 */
export function loopBodyProblems(graph: WorkflowGraph): string[] {
  const problems: string[] = [];
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map<string, WorkflowGraphNode>();
  for (const node of nodes) if (typeof node?.id === 'string') byId.set(node.id, node);

  const parentOf = (id: string): string | undefined => byId.get(id)?.parentId;

  nodes.forEach((node, index) => {
    if (typeof node?.parentId !== 'string') return;
    const parent = byId.get(node.parentId);
    if (parent === undefined) return; // reported by the shape check
    if (parent.type !== 'core.loop') {
      problems.push(`/nodes/${index}/parentId: \`${node.id}\` names \`${node.parentId}\` as its loop, but that node is a \`${parent.type}\`.`);
    }
    if (node.type === 'core.trigger' || node.type === 'core.output') {
      problems.push(`/nodes/${index}: a \`${node.type}\` cannot sit inside a loop body — the boundaries belong to the graph, not to an iteration.`);
    }
  });

  edges.forEach((edge, index) => {
    const fromParent = parentOf(edge.from);
    const toParent = parentOf(edge.to);
    const fromNode = byId.get(edge.from);
    const toNode = byId.get(edge.to);
    if (fromNode === undefined || toNode === undefined) return;

    // The loop's `each` handle is the ONE way in: it must target a body node of THAT loop.
    if (fromNode.type === 'core.loop' && edge.fromPort === 'each') {
      if (toParent !== fromNode.id) {
        problems.push(
          `/edges/${index}: \`${fromNode.id}.each\` must enter a node whose \`parentId\` is \`${fromNode.id}\` (the loop body); \`${edge.to}\` is not.`,
        );
      }
      return;
    }
    if (fromParent === toParent) return; // same scope (both top-level, or both in the same body)
    // Crossing a body boundary any other way is refused: the body's product leaves through `done`.
    if (fromParent !== undefined && toParent !== fromParent) {
      problems.push(
        `/edges/${index}: \`${edge.from}\` is inside loop \`${fromParent}\` and may not wire to \`${edge.to}\` outside it — an iteration's product leaves through the loop's \`done\` handle.`,
      );
    } else if (toParent !== undefined) {
      problems.push(
        `/edges/${index}: \`${edge.to}\` is inside loop \`${toParent}\`; a body node may only be entered from the loop's \`each\` handle or from another body node.`,
      );
    }
  });

  return problems;
}

/** Whether a graph is authored in the `core` vocabulary (has a `core.trigger`). */
export function isCoreGraph(graph: Pick<WorkflowGraph, 'nodes'>): boolean {
  return Array.isArray(graph.nodes) && graph.nodes.some((node) => node?.type === 'core.trigger');
}

/**
 * The union of every Output node's declared protocols — what bounds `?mode=` at invocation
 * (TASK-864 §3.4). Empty for a graph with no `core.output` (a legacy palette; the caller treats
 * that as unrestricted, exactly as today).
 */
export function declaredOutputProtocols(graph: Pick<WorkflowGraph, 'nodes'>): CoreOutputProtocol[] {
  const declared = new Set<CoreOutputProtocol>();
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    if (node?.type !== 'core.output') continue;
    const protocols = asObject(node.config)?.protocols;
    const list = Array.isArray(protocols) && protocols.length > 0 ? protocols : DEFAULT_OUTPUT_PROTOCOLS;
    for (const protocol of list) {
      if ((CORE_OUTPUT_PROTOCOLS as readonly unknown[]).includes(protocol)) declared.add(protocol as CoreOutputProtocol);
    }
  }
  return [...declared].sort();
}

/** The trigger kinds a graph accepts — `[]` for a legacy palette (the caller treats it as `api`). */
export function declaredTriggerKinds(graph: Pick<WorkflowGraph, 'nodes'>): CoreTriggerKind[] {
  const kinds = new Set<CoreTriggerKind>();
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    if (node?.type !== 'core.trigger') continue;
    const declared = asObject(node.config)?.kinds;
    for (const kind of Array.isArray(declared) ? declared : []) {
      if ((CORE_TRIGGER_KINDS as readonly unknown[]).includes(kind)) kinds.add(kind as CoreTriggerKind);
    }
  }
  return [...kinds].sort();
}

/** The Trigger's inline context schema and the Output's schema, when authored — what the
 *  generated OpenAPI components are built from (TASK-864 A7). */
export function declaredIoSchemas(graph: Pick<WorkflowGraph, 'nodes'>): {
  input: Readonly<Record<string, unknown>> | null;
  output: Readonly<Record<string, unknown>> | null;
} {
  let input: Readonly<Record<string, unknown>> | null = null;
  let output: Readonly<Record<string, unknown>> | null = null;
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    if (node?.type === 'core.trigger') {
      const inline = asObject(asObject(node.config)?.contextSchema)?.inline;
      if (asObject(inline) !== undefined) input = inline as Record<string, unknown>;
    }
    if (node?.type === 'core.output') {
      const schema = asObject(node.config)?.outputSchema;
      if (asObject(schema) !== undefined) output = schema as Record<string, unknown>;
    }
  }
  return { input, output };
}
