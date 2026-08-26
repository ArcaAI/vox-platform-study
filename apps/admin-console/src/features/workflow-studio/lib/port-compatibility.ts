/**
 * Port-type compatibility for the Studio canvas (TASK-809 Task 12).
 *
 * `WorkflowCanvasProps.isValidConnection` (`@arcaai/ui`'s `workflow-canvas/types.ts:64-69`)
 * already wires drag-time refusal into React Flow, and the graph store's `connect` already
 * calls `canConnect` for the commit-time path — but until this module, `canConnect` only
 * checked topology (self-edge, duplicate, missing endpoint). Nothing computed PORT validity, so
 * `document -> ner` looked like a legal wire on the canvas right up until server-side publish
 * validation rejected it. This module is that missing predicate.
 *
 * The lattice is mirrored, not imported, from `@arcaai/workflow-contract`'s
 * `port-model.ts` — the same posture `api/types.ts` already takes for the rest of the wire
 * contract (see that file's module comment): the console never bundles that package at
 * runtime, because it is the server validator's engine, not a browser artifact.
 * `port-model.test.ts` in that package is the source of truth for the lattice; this file's own
 * tests pin the two widenings verbatim so a drift is a failing test on EITHER side, never a
 * silent divergence.
 *
 * Compatibility is a subtype relation with exactly two widenings: `transcript ⊑ text` and
 * `document ⊑ text`. `transcript` and `document` are SIBLINGS — neither satisfies the other —
 * which is what makes `document -> ner` (concretely, `consultation.synthesize.out` ->
 * `consultation.extractEntities.in`) a type error rather than a legal wire. See
 * `__tests__/port-compatibility.test.ts`'s dedicated anti-laundering case.
 */
import type { ActionResult } from '../store/types';
import type { WorkflowNodeDescriptor, WorkflowNodePort, WorkflowPortPrimitive } from '../api/types';

/** Each primitive's direct supertype, or `null` at a lattice root. Verbatim mirror of
 *  `WORKFLOW_PORT_SUPERTYPE` (`port-model.ts`) — see the module comment for why this is a
 *  mirror, not an import. */
const PORT_SUPERTYPE: Readonly<Record<WorkflowPortPrimitive, WorkflowPortPrimitive | null>> = Object.freeze({
  control: null,
  'stream<audio>': null,
  transcript: 'text',
  text: null,
  entities: null,
  document: 'text',
  edits: null,
  verdict: null,
  'context<schemaRef>': null,
});

/**
 * Does a value produced on a `produced`-typed output satisfy a `consumed`-typed input? True
 * when `consumed` is `produced` or any of its transitive supertypes. Direction matters and is
 * the whole point — this relation is deliberately NOT symmetric.
 */
export function portPrimitiveSatisfies(produced: WorkflowPortPrimitive, consumed: WorkflowPortPrimitive): boolean {
  let cursor: WorkflowPortPrimitive | null = produced;
  while (cursor !== null) {
    if (cursor === consumed) return true;
    cursor = PORT_SUPERTYPE[cursor];
  }
  return false;
}

type PortDirection = 'input' | 'output';

function findPort(descriptor: WorkflowNodeDescriptor | undefined, handle: string, direction: PortDirection): WorkflowNodePort | undefined {
  if (!descriptor) return undefined;
  const ports = direction === 'input' ? descriptor.inputs : descriptor.outputs;
  return ports.find((port) => port.name === handle);
}

export interface PortEndpoint {
  /** Registry node TYPE (not the graph node id) — the caller resolves id -> type. */
  type: string;
  /** The edge's `fromPort`/`toPort` name. */
  handle: string;
}

/**
 * The ONE predicate both drag-time (`isValidConnection`) and commit-time (`connect`) must
 * evaluate — the "same predicate" contract `workflow-canvas/types.ts:64-69` documents. Pure and
 * side-effect-free so it can run on every pointer-drag frame.
 *
 * Topology rules (self-edge, duplicate, missing graph endpoint) are the store's own concern
 * (`create-graph-store.ts`'s `canConnect`); this function is ONLY the port-type check, and the
 * store calls it after its own checks pass.
 */
export function checkPortCompatibility(
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>,
  source: PortEndpoint,
  target: PortEndpoint,
): ActionResult {
  const outputPort = findPort(descriptorByType.get(source.type), source.handle, 'output');
  if (!outputPort) {
    return { ok: false, reason: `Node type "${source.type}" has no output port named "${source.handle}".` };
  }
  const inputPort = findPort(descriptorByType.get(target.type), target.handle, 'input');
  if (!inputPort) {
    return { ok: false, reason: `Node type "${target.type}" has no input port named "${target.handle}".` };
  }
  if (!portPrimitiveSatisfies(outputPort.primitive, inputPort.primitive)) {
    return { ok: false, reason: `\`${outputPort.primitive}\` cannot feed an input expecting \`${inputPort.primitive}\`.` };
  }
  return { ok: true };
}
