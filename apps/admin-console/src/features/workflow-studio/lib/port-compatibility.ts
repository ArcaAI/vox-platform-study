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
 *
 * That posture would normally leave nothing tying the two copies together but a comment — fine
 * for a mirrored SHAPE (drift there is a type error or a wrong render), not fine for a mirrored
 * SAFETY PREDICATE, where drift means the canvas starts permitting or refusing wires on stale
 * rules while the real anti-laundering invariant (`document -> ner` must stay a type error)
 * moves on without it. So `@arcaai/workflow-contract` IS a `devDependency` of
 * `@arcaai/admin-console` (workspace protocol, `package.json`) — deliberately, ONLY for this —
 * and `__tests__/port-compatibility.test.ts` imports `WORKFLOW_PORT_SUPERTYPE` /
 * `WORKFLOW_PORT_PRIMITIVES` from it and asserts this file's mirror against them verbatim. A
 * `devDependency` does not bundle into the Next.js runtime, so `api/types.ts`'s "the console
 * never imports `@arcaai/workflow-contract` at runtime" still holds — do NOT remove this
 * dependency as unused; it exists solely to back that test.
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
 *  mirror, not an import. Exported ONLY so the drift-guard test can assert it against the
 *  canonical constant; no application code outside this module should need it directly. */
export const PORT_SUPERTYPE: Readonly<Record<WorkflowPortPrimitive, WorkflowPortPrimitive | null>> = Object.freeze({
  control: null,
  'stream<audio>': null,
  audio: null,
  transcript: 'text',
  text: null,
  object: null,
  entities: 'object',
  document: 'text',
  edits: 'object',
  verdict: 'object',
  'context<schemaRef>': 'object',
});

/** Derived from `PORT_SUPERTYPE`'s own keys rather than hand-listed again, so there is exactly
 *  ONE place that enumerates the vocabulary in this file, not two that could disagree with each
 *  other. Compared against the canonical `WORKFLOW_PORT_PRIMITIVES` by the drift-guard test —
 *  this is what catches a primitive being ADDED to the contract (a changed widening alone would
 *  not add or remove a key). */
export const MIRRORED_PORT_PRIMITIVES: readonly WorkflowPortPrimitive[] = Object.keys(PORT_SUPERTYPE) as WorkflowPortPrimitive[];

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
