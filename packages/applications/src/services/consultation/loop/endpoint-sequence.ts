/**
 * The consultation ENDPOINT STAGE — the ordered actions `ConsultationLoopWorkflow` runs before a
 * consultation session closes — read off the ASSIGNED GRAPH (TASK-882).
 *
 * ## Where it came from
 *
 * It began as a code literal (`endingActionsBase = hasStreamAudio ? ['livedoc.stop',
 * 'harness.finalize'] : ['harness.finalize']`) that a department agent could only SUBTRACT from
 * (`neverActions`); then it became the admin-ordered `consultation.endpoint.actions` setting,
 * extended by the agent's `alwaysActions` and still vetoed by its `neverActions`. TASK-882
 * retired all three levers: a tenant-managed list of steps is a tenant-managed condition, and
 * the owner's model has none — developers branch in workflows.
 *
 * ## What decides it now
 *
 * | Lever | Source | Effect |
 * |---|---|---|
 * | membership | the governing graph's endpoint nodes (`ENDPOINT_ELIGIBLE_ACTIONS`, directly or through a `core.action`) | a node present and `enabled` runs |
 * | order | the graph's edges | topological order; declaration order breaks ties |
 * | audio scoping | the consultation's own context schema | drops `livedoc.stop` with no STREAM_AUDIO kind |
 *
 * A graph that declares NO endpoint node runs `CONSULTATION_ENDPOINT_ACTIONS_DEFAULT`. That
 * fallback is a clinical-safety floor, not a convenience: "nobody authored this" must never mean
 * "close consultations without finalizing them". A graph author who wants a different stage
 * declares one; the seeded legacy SOAP graph declares none (WF-CONS-004 makes its HITL gate
 * terminal, and a stage placed BEFORE the gate would lock documents before review) and so runs
 * the default.
 */

import type { WorkflowGraph, WorkflowGraphNode } from '@arcaai/workflow-contract';
import { topologicalLevels } from '@arcaai/workflow-contract';

/**
 * The actions that may appear in the endpoint sequence — a CLOSED list.
 *
 * A graph author places the stage; they do not invent steps for it. Anything outside this list
 * would reach `ConsultationLoopWorkflow._run_lifecycle_actions`, find no `LOOP_ACTION_REGISTRY`
 * entry, and be reported as `unsupported_action` — a step that looks configured and does nothing.
 *
 * These are deliberately the SAME strings as the five `trigger: 'on-end'` endpoint node keys in
 * `@arcaai/workflow-contract` — one vocabulary whether the consultation runs on the legacy loop
 * or on an authored graph.
 */
export const ENDPOINT_ELIGIBLE_ACTIONS = ['livedoc.stop', 'harness.finalize', 'session.timeout', 'summary.finalize', 'feedback.capture'] as const;

export type EndpointActionKey = (typeof ENDPOINT_ELIGIBLE_ACTIONS)[number];

const ELIGIBLE = new Set<string>(ENDPOINT_ELIGIBLE_ACTIONS);

/**
 * Endpoint actions that only make sense when the consultation actually streamed audio. Dropping
 * `livedoc.stop` from a text-only consultation is the one behaviour carried over verbatim from
 * `endingActionsBase`'s `hasStreamAudio` ternary.
 */
const AUDIO_ONLY_ENDPOINT_ACTIONS = new Set<string>(['livedoc.stop']);

/**
 * The platform's ordered endpoint stage.
 *
 * The order is not arbitrary and is the part most worth reading:
 *
 * 1. `livedoc.stop` — close the audio session first, so nothing downstream reads a transcript
 *    that is still growing.
 * 2. `session.timeout` — stamp HOW the session ended, before anything acts on it. A note produced
 *    from a timed-out consultation must be identifiable as one.
 * 3. `harness.finalize` — the existing child workflow that generates and delivers the note.
 * 4. `summary.finalize` — LOCK every document. After the note exists, and before feedback.
 * 5. `feedback.capture` — last, deliberately. It is the step most likely to degrade (it depends
 *    on a clinician having acted), and placing it after finalize means a feedback failure can
 *    never cost a clinician their locked note.
 */
export const CONSULTATION_ENDPOINT_ACTIONS_DEFAULT: readonly EndpointActionKey[] = Object.freeze([
  'livedoc.stop',
  'session.timeout',
  'harness.finalize',
  'summary.finalize',
  'feedback.capture',
] as const);

const CORE_ACTION_NODE_TYPE = 'core.action';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The effective type of a node — a `core.action`'s is the action it delegates to. */
function endpointActionOf(node: WorkflowGraphNode): string | null {
  const config = asRecord(node.config);
  if (config.enabled === false) return null;
  const type = node.type === CORE_ACTION_NODE_TYPE ? config.actionKey : node.type;
  return typeof type === 'string' && ELIGIBLE.has(type) ? type : null;
}

/**
 * The endpoint chain a graph DECLARES, in edge order — or `null` when it declares none (which
 * is what makes the platform default apply; an all-disabled chain declares none too).
 *
 * Order is the topological order of the graph's edges; nodes no edge orders keep their
 * declaration order. An action declared by more than one node runs once, at its FIRST position.
 */
export function endpointSequenceFromGraph(graph: WorkflowGraph | null | undefined): string[] | null {
  if (!graph || !Array.isArray(graph.nodes)) return null;
  const declarationIndex = new Map(graph.nodes.map((node, index) => [node.id, index] as const));
  const levelIndex = new Map<string, number>();
  const ordering = topologicalLevels({ ...graph, edges: Array.isArray(graph.edges) ? graph.edges : [] });
  if ('levels' in ordering) {
    ordering.levels.forEach((level, index) => level.forEach((id) => levelIndex.set(id, index)));
  }
  const rank = (node: WorkflowGraphNode): [number, number] => [levelIndex.get(node.id) ?? 0, declarationIndex.get(node.id) ?? 0];

  const sequence: string[] = [];
  const ordered = graph.nodes.slice().sort((a, b) => {
    const [la, da] = rank(a);
    const [lb, db] = rank(b);
    return la - lb || da - db;
  });
  for (const node of ordered) {
    const action = endpointActionOf(node);
    if (action && !sequence.includes(action)) sequence.push(action);
  }
  return sequence.length === 0 ? null : sequence;
}

export interface ResolveEndpointSequenceInput {
  /** The chain the governing graph declares (`endpointSequenceFromGraph`), or `null` for none. */
  readonly declared?: readonly string[] | null;
  /** True when the consultation subscribes at least one STREAM_AUDIO kind. */
  readonly hasStreamAudio: boolean;
}

/** Keep only eligible string entries, de-duplicated, order preserved (first occurrence wins). */
function eligibleInOrder(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !ELIGIBLE.has(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * The endpoint sequence this consultation will run, in dispatch order.
 *
 * Pure: every input is passed in, nothing is read from a service. That is what lets the ordering
 * rules be tested exhaustively without a graph backend, and it is why the graph READ lives in
 * `LoopConfigService` (which already resolves the governing definition) rather than here.
 */
export function resolveEndpointSequence(input: ResolveEndpointSequenceInput): string[] {
  const source = Array.isArray(input.declared) && input.declared.length > 0 ? input.declared : CONSULTATION_ENDPOINT_ACTIONS_DEFAULT;

  let sequence = eligibleInOrder(source);
  // A declared chain of nothing eligible is indistinguishable, to a consultation, from no chain
  // at all — so it degrades the same way rather than closing consultations with no stage.
  if (sequence.length === 0) sequence = eligibleInOrder(CONSULTATION_ENDPOINT_ACTIONS_DEFAULT);

  if (!input.hasStreamAudio) {
    sequence = sequence.filter((action) => !AUDIO_ONLY_ENDPOINT_ACTIONS.has(action));
  }
  return sequence;
}
