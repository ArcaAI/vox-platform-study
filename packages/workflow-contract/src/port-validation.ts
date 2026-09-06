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
import { effectivePorts } from './core-contract';
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
 * The publish gate MOVED (TASK-890 §3.5). `workflowPublishProblems` lived here, returned
 * `string[]`, and nothing in the gateway ever called it — an unwired gate is not a gate
 * (BLOCKER 1c). Its checks now run inside `publishFindings` (`publish-findings.ts`), which emits
 * `WorkflowFinding`s the Studio can map onto a canvas node and a console can branch on by
 * `code`, and which `WorkflowDefinitionService.publishEntity` actually calls.
 *
 * Nothing was dropped in the move: the port lattice below, `nodeDescriptorContractProblems`,
 * `requires[]` guard attachment, the loop-body rules and the `agentic.*` / `core.*` config checks
 * all run there. What is gone is a `string[]` API with no callers.
 */
