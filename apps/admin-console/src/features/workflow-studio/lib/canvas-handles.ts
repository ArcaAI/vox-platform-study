/**
 * TASK-893 §3.1 — which HANDLES a node draws, now that the canvas shows two dots instead of
 * fourteen. The companion of `socket-resolution.ts`: that module decides what a drawn link
 * MEANS, this one decides what there is to grab.
 *
 * Three questions, one rule each:
 *
 *  - `primaryIoFor` — does this node get a primary input dot / a primary output dot? A node has
 *    a way IN if it declares either primary socket (`in` or `after`), and a way OUT if it
 *    declares either (`out` or `next`). The canvas handle ids are fixed (`"in"` / `"out"`,
 *    Contract A §2.1) and are PRESENTATION ids: `resolvePrimarySockets` maps the gesture onto the
 *    real wire socket, so a `core.start` whose only output is the ordering `next` still shows a
 *    dot and still wires correctly.
 *  - `branchHandlesFor` — the labelled extra SOURCE handles, the one place multiple outputs earn
 *    their space (README §3.1: `core.condition`, `core.classify`, `core.humanReview`, `core.loop`
 *    keep theirs; the other seven core types become single-dot).
 *  - `secondaryInputsFor` — the data inputs that STOP being wires and become inspector binding
 *    fields ("Context <- ① Trigger"). `core.action` declares 7 inputs; exactly one of them (`in`)
 *    stays on the canvas.
 *
 * Everything here reads the per-INSTANCE port table (`core-ports.ts`'s `effectiveNodePorts`,
 * itself pinned to `@arcaai/workflow-contract` by `__tests__/core-ports.test.ts`), so a router's
 * per-class handles and a `core.action`'s delegated table are already resolved — this module
 * never re-derives them.
 */
import type { WorkflowNodeDescriptor, WorkflowNodePort } from '../api/types';
import { effectiveNodePorts } from './core-ports';
import { humanizeKey } from './schema-form';

const PRIMARY_DATA_OUTPUT = 'out';
const PRIMARY_DATA_INPUT = 'in';
const CONTROL_OUTPUT = 'next';
const CONTROL_INPUT = 'after';

export interface BranchHandle {
  /** The React Flow handle id, which MUST be the real wire port name (Contract A §2.1). */
  id: string;
  label: string;
}

export interface SecondaryInput {
  name: string;
  primitive: string;
  required: boolean;
}

/**
 * The labelled BRANCH outputs of this instance.
 *
 * A branch is any output that is neither of the two primary sockets AND either
 *  - carries no payload (`control`) — the routers' per-class / per-branch handles, `otherwise`,
 *    `else`, `approved`, `rejected`, `timedOut`: taking the handle IS the decision, so each needs
 *    its own visible, labelled dot; or
 *  - is a DATA output on a node that declares no `out` at all — `core.loop`'s `each` and `done`,
 *    which are the only ways anything leaves a loop and so cannot be collapsed into a primary dot
 *    that does not exist.
 *
 * A node that HAS an `out` keeps its other data outputs off the canvas (`core.agent`'s `data` /
 * `transcript` / `audio`, `core.action`'s five): the consumer binds them as a secondary INPUT
 * instead, which is where §3.1 moved that decision.
 */
export function branchHandlesFor(
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>,
  type: string,
  config: Record<string, unknown>,
): BranchHandle[] {
  const ports = effectiveNodePorts(descriptorByType, type, config);
  if (!ports) return [];
  const hasPrimaryDataOutput = ports.outputs.some((port) => port.name === PRIMARY_DATA_OUTPUT);
  return ports.outputs
    .filter((port) => port.name !== PRIMARY_DATA_OUTPUT && port.name !== CONTROL_OUTPUT)
    .filter((port) => port.primitive === 'control' || !hasPrimaryDataOutput)
    // `humanizeKey` — the SAME derivation the inspector's field labels and the palette's node
    // names use. The registry carries no display name for a port (registry.contract.md), so a
    // second humanizer here would only be a second way to spell the same label.
    .map((port) => ({ id: port.name, label: humanizeKey(port.name) }));
}

/** Whether this node type shows a primary input / output dot. Config-independent: a delegate or a
 *  router changes WHICH branch handles exist, never whether the node has a primary way in or out. */
export function primaryIoFor(
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>,
  type: string,
): { hasInput: boolean; hasOutput: boolean } {
  const ports = effectiveNodePorts(descriptorByType, type, undefined);
  if (!ports) return { hasInput: false, hasOutput: false };
  const named = (list: readonly WorkflowNodePort[], ...names: string[]): boolean => list.some((port) => names.includes(port.name));
  return {
    hasInput: named(ports.inputs, PRIMARY_DATA_INPUT, CONTROL_INPUT),
    hasOutput: named(ports.outputs, PRIMARY_DATA_OUTPUT, CONTROL_OUTPUT),
  };
}

/**
 * The DATA inputs that are no longer canvas wires — everything except the primary `in` and the
 * ordering `after`. The inspector renders each as a labelled upstream-node picker and writes the
 * choice to `inputs.<portName>` (Contract B §4.2).
 */
export function secondaryInputsFor(
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>,
  type: string,
  config: Record<string, unknown>,
): SecondaryInput[] {
  const ports = effectiveNodePorts(descriptorByType, type, config);
  if (!ports) return [];
  return ports.inputs
    .filter((port) => port.primitive !== 'control' && port.name !== PRIMARY_DATA_INPUT)
    .map((port) => ({ name: port.name, primitive: port.primitive, required: port.required }));
}
