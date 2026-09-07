/**
 * TASK-893 §3.1 — which WIRE SOCKETS one user-drawn link becomes.
 *
 * The canvas now draws ONE input dot and ONE output dot per node (plus labelled branch handles),
 * because `core.action` rendering 7 inputs + 7 outputs was the complexity the owner rejected.
 * The wire contract underneath is UNCHANGED: `WorkflowGraphEdge` still names a real `fromPort`
 * and `toPort`, `NODE_PORTS` still declares them, and the interpreter still threads one value
 * per socket through `outputKey`. This module is the whole of the difference — it maps a gesture
 * onto the pair of sockets it means.
 *
 * ## It chooses; it does not decide
 *
 * Every candidate pair is put through `checkPortCompatibility` — the SAME predicate
 * `canConnect`/`connect` and the canvas's drag-time `isValidConnection` run. This function can
 * therefore never propose a pair the store would then refuse, and it cannot widen the lattice:
 * `document -> transcript` is still a type error, so `consultation.synthesize` still cannot be
 * wired into `consultation.extractEntities` on `out -> in`. The anti-hallucination-laundering
 * property is a property of `port-compatibility.ts`, and collapsing the PRESENTATION of the
 * sockets does not touch it.
 *
 * ## The two pairs, and why in that order
 *
 * `node-ports.ts`'s naming convention is uniform and load-bearing: `in`/`out` are the primary
 * DATA sockets, `after`/`next` the ORDERING ones. Drawing A -> B almost always means "B consumes
 * what A produced", so the data pair is tried first; when either end has no compatible data
 * socket — a gate that emits only a control signal, a node whose primary output cannot satisfy
 * the target's primary input — the link degrades to the ordering pair rather than being refused,
 * which is what the user drawing it almost certainly meant. `null` means the two nodes cannot be
 * linked at all (a `core.output` has no outputs; a `core.trigger` has no inputs).
 */
import type { WorkflowNodeDescriptor } from '../api/types';
import { effectiveNodePorts } from './core-ports';
import { checkPortCompatibility } from './port-compatibility';

/** The node's primary DATA sockets — `node-ports.ts`'s convention, not a guess. */
const PRIMARY_DATA_OUTPUT = 'out';
const PRIMARY_DATA_INPUT = 'in';
/** The node's ORDERING sockets ("run this node after that one"). */
const CONTROL_OUTPUT = 'next';
const CONTROL_INPUT = 'after';

export interface SocketEndpoint {
  /** Registry node TYPE (not the graph node id). */
  type: string;
  /** The instance's config — decides a router's branch handles and a `core.action`'s delegate. */
  config: Record<string, unknown>;
}

export interface ResolvedSockets {
  sourceHandle: string;
  targetHandle: string;
}

export function resolvePrimarySockets(
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>,
  source: SocketEndpoint,
  target: SocketEndpoint,
  sourceHandleHint?: string | null,
): ResolvedSockets | null {
  const sourcePorts = effectiveNodePorts(descriptorByType, source.type, source.config);
  const targetPorts = effectiveNodePorts(descriptorByType, target.type, target.config);
  if (!sourcePorts || !targetPorts) return null;

  const accepts = (candidate: ResolvedSockets): boolean =>
    checkPortCompatibility(
      descriptorByType,
      { type: source.type, handle: candidate.sourceHandle, config: source.config },
      { type: target.type, handle: candidate.targetHandle, config: target.config },
    ).ok;

  // A hint means the user grabbed a specific handle — a branch (`then`, `approved`, a class key)
  // or the loop's `each`. That socket is FIXED: silently re-resolving it to `out`/`next` would
  // land the wire on a handle the user did not touch, which is a different graph. Only the
  // TARGET socket is still open, and if nothing there fits, the answer is `null`.
  //
  // `out` is the ONE hint that is not a grab. The canvas renders the primary output with the
  // literal handle id `out` (Contract A), so React Flow reports `sourceHandle: 'out'` for every
  // ordinary link — never `null`. Treating that as a fixed socket pins resolution to the data
  // pair and makes the ordering fallback below unreachable: `consultation.synthesize ->
  // consultation.extractEntities` would be REFUSED (`document` cannot satisfy `transcript`, by
  // the anti-laundering rule) instead of degrading to `next -> after`, which is what the user
  // drawing that link meant. So the primary id is filtered out here and resolution falls through.
  const explicitGrab = sourceHandleHint && sourceHandleHint !== PRIMARY_DATA_OUTPUT ? sourceHandleHint : null;
  const hinted = explicitGrab ? sourcePorts.outputs.find((port) => port.name === explicitGrab) : undefined;
  if (hinted) {
    // A branch handle carries no payload, so it wants the ordering input; a data handle wants the
    // data input. Both orders are then tried, because the lattice — not this ordering — decides.
    const order = hinted.primitive === 'control' ? [CONTROL_INPUT, PRIMARY_DATA_INPUT] : [PRIMARY_DATA_INPUT, CONTROL_INPUT];
    for (const targetHandle of order) {
      const candidate = { sourceHandle: hinted.name, targetHandle };
      if (accepts(candidate)) return candidate;
    }
    return null;
  }

  for (const candidate of [
    { sourceHandle: PRIMARY_DATA_OUTPUT, targetHandle: PRIMARY_DATA_INPUT },
    { sourceHandle: CONTROL_OUTPUT, targetHandle: CONTROL_INPUT },
  ]) {
    if (accepts(candidate)) return candidate;
  }
  return null;
}
