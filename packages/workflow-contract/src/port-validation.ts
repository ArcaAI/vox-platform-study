/**
 * Type-checked edge validation and the publish-time descriptor rules ( Tasks 5 & 7).
 *
 * Closes defect D-5: `workflowGraphProblems` (`graph-model.ts:160`) checks only that
 * `fromPort`/`toPort` are non-empty strings, so `{ fromPort: 'banana', toPort: 'banana' }` was a
 * structurally valid edge. It stays that way on purpose — that function is the pure SHAPE check
 * and the package layering depends on it having no registry knowledge. Port typing needs the
 * registry, so it lives here.
 *
 * ## Why this is not wired into `validate()`
 *
 * Every graph authored before this ticket names its ports `in`/`out` untyped, for ordering and
 * data alike (see `node-ports.ts` NOTE). Folding the check into `validate()`'s
 * default rule loop would retroactively invalidate every saved definition the moment this
 * package shipped. So it is invoked EXPLICITLY:
 *
 *   - `isValidConnection(...)` — the canvas predicate, one candidate edge at a time.
 *   - `workflowPublishProblems(...)` — the publish gate, whole graph.
 *
 * Migrating the seeded graphs to typed ports is a FOLLOW-ON LANE OF ITSELF ( is
 * the endpoint stage, not the migration); wiring this gate into the gateway's publish path
 * belongs to whichever lane owns that path. Everything here is pure and total: it returns `problems: string[]` (the house idiom) and
 * never throws, whatever it is handed.
 */
import { agenticNodeConfigProblems } from './agentic-contract';
import type { AgenticGraphContext } from './agentic-contract';
import { coreNodeConfigProblems, effectivePorts, loopBodyProblems } from './core-contract';
import type { WorkflowGraph } from './graph-model';
import type { WorkflowNodeDescriptor } from './node-registry';
import { WORKFLOW_NODE_REGISTRY } from './node-registry';
import type { WorkflowPortDescriptor } from './port-model';
import { portPrimitiveSatisfies } from './port-model';

/** A caller may overlay descriptors (the gateway resolving a tenant's pinned registry, or a
 *  test exercising a rule against a synthetic node type) without mutating the module registry. */
export interface PortValidationOptions {
  readonly registry?: Readonly<Record<string, WorkflowNodeDescriptor>>;
  /**
   * TASK-864 — the two endpoint nodes' authored configs, for `isValidConnection`. The `core`
   * routers fan out one handle per declared class/branch and `core.action` takes its delegate's
   * ports, so a candidate edge on the canvas can only be judged against the INSTANCE. Absent, the
   * static table is used (correct for every legacy type).
   */
  readonly fromNodeConfig?: Readonly<Record<string, unknown>>;
  readonly toNodeConfig?: Readonly<Record<string, unknown>>;
}

function resolveRegistry(options?: PortValidationOptions): Readonly<Record<string, WorkflowNodeDescriptor>> {
  return options?.registry === undefined ? WORKFLOW_NODE_REGISTRY : { ...WORKFLOW_NODE_REGISTRY, ...options.registry };
}

function portsOf(
  descriptor: WorkflowNodeDescriptor | undefined,
  nodeType: string,
  config: Readonly<Record<string, unknown>> | undefined,
): { inputs: readonly WorkflowPortDescriptor[]; outputs: readonly WorkflowPortDescriptor[] } {
  // A `core` node's sockets are per INSTANCE (`core-contract.ts`); an overlaid synthetic
  // descriptor keeps its own declared ports.
  if (nodeType.startsWith('core.')) return effectivePorts(nodeType, config);
  if (descriptor !== undefined) return { inputs: descriptor.inputs, outputs: descriptor.outputs };
  return effectivePorts(nodeType, config);
}

function findPort(ports: readonly WorkflowPortDescriptor[], name: string): WorkflowPortDescriptor | undefined {
  return ports.find((candidate) => candidate.name === name);
}

/**
 * The canvas predicate (`workflow-canvas/types.ts`'s `isValidConnection` hook). Returns `true`
 * only when BOTH endpoints resolve to declared ports of the right direction AND the produced
 * type satisfies the consumed type. Everything else — unregistered node type, unknown port,
 * an edge drawn out of an input — is `false`, never a throw.
 */
export function isValidConnection(
  fromNodeType: string,
  fromPort: string,
  toNodeType: string,
  toPort: string,
  options?: PortValidationOptions,
): boolean {
  const registry = resolveRegistry(options);
  const fromDescriptor = registry[fromNodeType];
  const toDescriptor = registry[toNodeType];
  if (fromDescriptor === undefined || toDescriptor === undefined) return false;

  const source = findPort(portsOf(fromDescriptor, fromNodeType, options?.fromNodeConfig).outputs, fromPort);
  const target = findPort(portsOf(toDescriptor, toNodeType, options?.toNodeConfig).inputs, toPort);
  if (source === undefined || target === undefined) return false;

  return portPrimitiveSatisfies(source.primitive, target.primitive);
}

/**
 * Every port problem in an authored graph, in one pass (never just the first — a caller
 * surfaces them all in one response rather than discovering them a round-trip at a time, the
 * same contract `workflowGraphProblems` keeps).
 *
 * Paths mirror that function's JSON-pointer style (`/edges/3/fromPort`) so a client can point at
 * the offending field.
 */
export function workflowEdgePortProblems(graph: WorkflowGraph, options?: PortValidationOptions): string[] {
  const registry = resolveRegistry(options);
  const problems: string[] = [];

  const nodeTypeById = new Map<string, string>();
  const nodeConfigById = new Map<string, Readonly<Record<string, unknown>> | undefined>();
  for (const node of graph.nodes ?? []) {
    if (typeof node?.id === 'string' && typeof node?.type === 'string') {
      nodeTypeById.set(node.id, node.type);
      nodeConfigById.set(node.id, node.config as Readonly<Record<string, unknown>> | undefined);
    }
  }

  (graph.edges ?? []).forEach((edge, index) => {
    const path = `/edges/${index}`;

    const fromType = nodeTypeById.get(edge?.from);
    const toType = nodeTypeById.get(edge?.to);
    if (fromType === undefined) {
      problems.push(`${path}/from: references unknown node ${JSON.stringify(edge?.from)}`);
      return;
    }
    if (toType === undefined) {
      problems.push(`${path}/to: references unknown node ${JSON.stringify(edge?.to)}`);
      return;
    }

    const fromDescriptor = registry[fromType];
    const toDescriptor = registry[toType];
    if (fromDescriptor === undefined) {
      problems.push(
        `${path}/from: node ${JSON.stringify(edge.from)} has unregistered type ${JSON.stringify(fromType)} — its ports cannot be resolved`,
      );
      return;
    }
    if (toDescriptor === undefined) {
      problems.push(`${path}/to: node ${JSON.stringify(edge.to)} has unregistered type ${JSON.stringify(toType)} — its ports cannot be resolved`);
      return;
    }

    const fromPorts = portsOf(fromDescriptor, fromType, nodeConfigById.get(edge.from));
    const toPorts = portsOf(toDescriptor, toType, nodeConfigById.get(edge.to));
    const source = findPort(fromPorts.outputs, edge.fromPort);
    const target = findPort(toPorts.inputs, edge.toPort);

    if (source === undefined) {
      // Naming an INPUT port as an edge source is the commonest authoring slip, so say so
      // rather than reporting a bare "unknown port".
      const asInput = findPort(fromPorts.inputs, edge.fromPort);
      const detail =
        asInput === undefined
          ? `declares no output port ${JSON.stringify(edge.fromPort)} (declared: ${JSON.stringify(fromPorts.outputs.map((p) => p.name))})`
          : `port ${JSON.stringify(edge.fromPort)} is an INPUT, so it cannot be an edge source`;
      problems.push(`${path}/fromPort: node type ${JSON.stringify(fromType)} ${detail}`);
    }
    if (target === undefined) {
      const asOutput = findPort(toPorts.outputs, edge.toPort);
      const detail =
        asOutput === undefined
          ? `declares no input port ${JSON.stringify(edge.toPort)} (declared: ${JSON.stringify(toPorts.inputs.map((p) => p.name))})`
          : `port ${JSON.stringify(edge.toPort)} is an OUTPUT, so it cannot be an edge target`;
      problems.push(`${path}/toPort: node type ${JSON.stringify(toType)} ${detail}`);
    }
    if (source === undefined || target === undefined) return;

    if (!portPrimitiveSatisfies(source.primitive, target.primitive)) {
      problems.push(
        `${path}: incompatible port types — ${fromType}[${source.name}] produces ${JSON.stringify(source.primitive)}, ` +
          `which does not satisfy ${toType}[${target.name}] expecting ${JSON.stringify(target.primitive)}`,
      );
    }
  });

  return problems;
}

/**
 * The two publish-time DESCRIPTOR rules, plus the node-type versioning rule, checked against one
 * descriptor. Total — returns `[]` for a conforming descriptor.
 *
 * | Rule | Why |
 * |---|---|
 * | EVERY node MUST be `idempotent`, in either lane | Both runtimes retry. Temporal retries a durable activity; realtime executor retries a realtime node up to its compiled `retry.maximumAttempts` (`realtime-lane.ts`'s `RealtimeNode.maxAttempts`). A non-idempotent retry double-writes in a way the author never sees, and the lane makes no difference to that. |
 * | `key` suffix and `schemaVersion` must agree | A node type is a contract with every saved tenant graph. Reshaping a published node's ports in place silently breaks them; a breaking change becomes `agent.ner@2`, and the suffix must not lie about which version it is. |
 *
 * ## The rule that was REMOVED, and why (lane A, item 7)
 *
 * declared *"a realtime-lane node MUST NOT be `externalWrite`"*, on the reasoning
 * that "the realtime lane has a latency budget; an inline external write blows it and cannot be
 * compensated on restart". It was written before a realtime runtime existed, and the runtime
 * then shipped FALSIFIES it: of the three node types the realtime executor implements,
 * `consultation.realtimeSummary` publishes each interim summary to the live consultation feed and
 * `consultation.extractEntities` persists the entities it found. Writing is not an accident of
 * those nodes — publishing the running note IS the realtime lane's product. The rule could only
 * be satisfied by declaring `lane: 'durable'` on nodes no durable runtime executes, which is
 * exactly the state item 7 exists to end.
 *
 * Neither half of its stated reasoning survives contact with the implementation either. Latency is
 * enforced by a PER-NODE budget the executor races each node against , not by a type flag;
 * and the realtime lane is not restart-compensated for ANY node, writing or not, because a lane
 * run is a live flush rather than a durable history.
 *
 * The hazard the rule was reaching for is real but is a different one: TWO runtimes executing the
 * same node, which for `consultation.realtimeSummary` would mean two engines writing one
 * consultation's document. That is a lane-MEMBERSHIP hazard, and it is now closed structurally —
 * `lane` is a shared registry field and the durable interpreter SKIPS every `realtime` node
 * (`apps/harness/.../interpreter/workflow.py`, reason `realtime_lane`), so exactly one runtime
 * ever executes a given node.
 */
export function nodeDescriptorContractProblems(descriptor: WorkflowNodeDescriptor): string[] {
  const problems: string[] = [];

  if (!descriptor.idempotent) {
    problems.push(
      `${descriptor.key}: a node MUST declare idempotent:true — both runtimes retry (Temporal retries a durable activity, the realtime executor retries up to retry.maximumAttempts)`,
    );
  }

  const suffix = descriptor.key.includes('@') ? Number(descriptor.key.slice(descriptor.key.lastIndexOf('@') + 1)) : 1;
  if (!Number.isInteger(suffix) || suffix !== descriptor.schemaVersion) {
    problems.push(`${descriptor.key}: schemaVersion ${descriptor.schemaVersion} disagrees with the key's version suffix (${suffix})`);
  }

  if (descriptor.evalGate !== undefined && descriptor.evalGate.goldenSetId.length === 0) {
    problems.push(`${descriptor.key}: evalGate.goldenSetId must be a non-empty golden-set id — an eval gate with no golden set gates nothing`);
  }

  return problems;
}

/**
 * The publish gate: every port problem in the graph, every descriptor-contract violation among
 * the node types it uses, and every UNSATISFIED GUARD ATTACHMENT.
 *
 * `requires[]` is checked **per node INSTANCE**, not per type: two `generate.text` nodes in one
 * graph each need their own attached guard, because a guard wired to one of them says nothing
 * about the other. A guard counts as attached when an edge connects the instance to a node of
 * the required type in EITHER direction — a pre-guard and a post-guard are both attachments.
 *
 * Every descriptor in the shipped registry declares `requires: []`, so this imposes nothing
 * today; the `guard.*` node types the target catalogue names do not exist yet, and assigning
 * real guard requirements before they do would make every seeded graph unpublishable. The
 * MECHANISM is what this ticket owes; the POLICY belongs to the lane that adds the guards.
 */
export function workflowPublishProblems(graph: WorkflowGraph, options?: PortValidationOptions): string[] {
  const registry = resolveRegistry(options);
  const problems: string[] = [...workflowEdgePortProblems(graph, options)];

  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const typeById = new Map<string, string>();
  for (const node of nodes) {
    if (typeof node?.id === 'string' && typeof node?.type === 'string') typeById.set(node.id, node.type);
  }

  // the `agentic.*` per-node checks a JSON Schema cannot express: exactly-one
  // provider-configuration selection source, the three-axis loop bounds (including the COST
  // ceiling), and guard/orchestrator references that must name real nodes of the right class.
  //
  // Wired HERE and not left as an exported helper, because an unwired gate is not a gate. The
  // schema governs what may be AUTHORED; this is the only thing that governs what may be
  // PUBLISHED, and a definition that arrived through an importer — or that predates a schema
  // change — reaches publish without ever passing through the schema.
  //
  // `nodeIds`/`nodeTypesById` are supplied from THIS graph, so the cross-node reference checks
  // are exact rather than skipped. A node-level caller (the Studio inspector, before the node is
  // wired) can call `agenticNodeConfigProblems` with no context and still get the within-node
  // rules — that asymmetry is the function's own contract, not an accident here.
  const agenticContext: AgenticGraphContext = { nodeIds: [...typeById.keys()], nodeTypesById: Object.fromEntries(typeById) };
  for (const node of nodes) {
    if (typeof node?.id !== 'string' || typeof node?.type !== 'string') continue;
    problems.push(
      ...agenticNodeConfigProblems({ id: node.id, type: node.type, config: node.config as Record<string, unknown> | undefined }, agenticContext).map(
        (problem) => `/nodes: ${problem}`,
      ),
    );
  }

  // TASK-864 — the `core` vocabulary's own publish checks: router handles unique and non-reserved,
  // CEL conditions that parse and read only the declared context roots, loop bounds and modes,
  // output protocols, action keys, and the loop-body wiring rules.
  for (const node of nodes) {
    if (typeof node?.id !== 'string' || typeof node?.type !== 'string') continue;
    problems.push(
      ...coreNodeConfigProblems({ id: node.id, type: node.type, config: node.config as Record<string, unknown> | undefined }).map(
        (problem) => `/nodes: ${problem}`,
      ),
    );
  }
  problems.push(...loopBodyProblems(graph));

  const seenTypes = new Set<string>();
  for (const node of nodes) {
    const descriptor = registry[node?.type];
    if (descriptor === undefined) continue;

    if (!seenTypes.has(node.type)) {
      seenTypes.add(node.type);
      problems.push(...nodeDescriptorContractProblems(descriptor));
    }

    if (descriptor.requires.length === 0) continue;
    const neighbourTypes = new Set<string>();
    for (const edge of edges) {
      if (edge?.from === node.id) {
        const neighbour = typeById.get(edge.to);
        if (neighbour !== undefined) neighbourTypes.add(neighbour);
      }
      if (edge?.to === node.id) {
        const neighbour = typeById.get(edge.from);
        if (neighbour !== undefined) neighbourTypes.add(neighbour);
      }
    }
    for (const required of descriptor.requires) {
      if (!neighbourTypes.has(required)) {
        problems.push(
          `/nodes: node ${JSON.stringify(node.id)} (${node.type}) requires an attached ${JSON.stringify(required)} guard, and none is connected to this instance`,
        );
      }
    }
  }

  return problems;
}
