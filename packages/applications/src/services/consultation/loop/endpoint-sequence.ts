/**
 * TASK-812 (D-10) — the CONSULTATION ENDPOINT SEQUENCE.
 *
 * The endpoint stage is the ordered list of actions that runs before a consultation session
 * closes. Until this module it was a literal, four lines into a private method:
 *
 * ```ts
 * const endingActionsBase = hasStreamAudio ? ['livedoc.stop', 'harness.finalize'] : ['harness.finalize'];
 * const endingActions = endingActionsBase.filter((action) => !neverActions.has(action));
 * ```
 *
 * ## What was actually wrong with that
 *
 * Not that it was hardcoded — plenty of correct things are. The defect is the SHAPE of the only
 * control it offered: `neverActions` can only SUBTRACT. A tenant could delete a step from the
 * stage that closes a consultation and could do nothing else with it — not reorder it, not add a
 * step, not express "capture feedback after finalizing". "You may remove entries from this list"
 * is a veto, not configuration, and a veto is the one lever you would least want to be the only
 * one on a clinical closing sequence.
 *
 * ## Where the ordered list lives, and why it is not a new column
 *
 * `consultation.endpoint.actions`, a `global-kv` setting with `maxScope: 'tenant'`
 * (`consultation-endpoint.descriptors.ts`). Registering a descriptor is the ONLY step needed to
 * make a key governed, readable and writable — there is no per-key allow-list — so the platform
 * order, the per-tenant override, the admin write lane, the cache invalidation and the
 * settings-catalog surface all come for free, and no migration is involved. A
 * `DepartmentAgent.endpointActions` column would have bought a third cascade level nobody asked
 * for at the cost of a schema change on a shared branch.
 *
 * ## The four levers, in resolution order
 *
 * | Lever | Who sets it | What it does |
 * |---|---|---|
 * | the persisted list | platform admin, or a tenant override | ORDER and membership |
 * | audio scoping | the consultation's own context schema | drops `livedoc.stop` with no STREAM_AUDIO kind |
 * | `alwaysActions` | the department agent | EXTENDS — appends an endpoint-eligible action the list omits |
 * | `neverActions` | the department agent | SUBTRACTS — the compliance veto, unchanged |
 *
 * `alwaysActions` extends only with ENDPOINT-ELIGIBLE keys, and that restriction is what keeps
 * every existing agent byte-identical: agents configured before this ticket carry per-kind
 * actions there (`client.emit` above all), and appending those to the endpoint stage would
 * silently change what happens when their consultations close.
 *
 * ## Fallback is a real default, never an empty stage
 *
 * An unset, empty or malformed value resolves to `CONSULTATION_ENDPOINT_ACTIONS_DEFAULT`. The
 * descriptor is `failMode: 'open-to-default'` for the same reason: "nobody has configured this"
 * must never mean "close consultations without finalizing them". An admin who genuinely wants an
 * empty stage says so through `neverActions`, which is an explicit act.
 */

import { AgentActionKey } from '../../departmentAgent/constants';

/** The `global-kv` key holding the ordered endpoint sequence. */
export const CONSULTATION_ENDPOINT_ACTIONS_KEY = 'consultation.endpoint.actions';

/**
 * The actions that may appear in the endpoint sequence — a CLOSED list.
 *
 * An admin orders the stage; they do not invent steps for it. Anything outside this list would
 * reach `ConsultationLoopWorkflow._run_lifecycle_actions`, find no `LOOP_ACTION_REGISTRY` entry,
 * and be reported as `unsupported_action` — a step that looks configured and does nothing.
 *
 * The first two are the pre-TASK-812 stage. The last three are the node types this ticket adds
 * (`session.timeout`, `summary.finalize`, `feedback.capture`), which are deliberately the SAME
 * strings as the `trigger: 'on-end'` node keys in `@arcaai/workflow-contract` — one vocabulary
 * whether the consultation runs on the legacy loop or on an authored graph.
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
 * 4. `summary.finalize` — LOCK every document (DD-3). After the note exists, and before feedback.
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

export interface ResolveEndpointSequenceInput {
  /** The persisted, admin-ordered list. Anything not a non-empty array falls back to the default. */
  readonly configured?: readonly string[] | null;
  /** True when the consultation subscribes at least one STREAM_AUDIO kind. */
  readonly hasStreamAudio: boolean;
  /** The agent's compliance-envelope EXTENSION lever. */
  readonly alwaysActions?: readonly (AgentActionKey | string)[] | null;
  /** The agent's compliance-envelope VETO lever. */
  readonly neverActions?: readonly (AgentActionKey | string)[] | null;
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
 * rules be tested exhaustively without a settings backend, and it is why the setting READ lives
 * in `LoopConfigService` (which already resolves the idle bound the same way) rather than here.
 */
export function resolveEndpointSequence(input: ResolveEndpointSequenceInput): string[] {
  const source = Array.isArray(input.configured) && input.configured.length > 0 ? input.configured : CONSULTATION_ENDPOINT_ACTIONS_DEFAULT;

  let sequence = eligibleInOrder(source);
  // A configured list of nothing but junk is indistinguishable, to a consultation, from no list
  // at all — so it degrades the same way rather than closing consultations with no stage.
  if (sequence.length === 0) sequence = eligibleInOrder(CONSULTATION_ENDPOINT_ACTIONS_DEFAULT);

  if (!input.hasStreamAudio) {
    sequence = sequence.filter((action) => !AUDIO_ONLY_ENDPOINT_ACTIONS.has(action));
  }

  // EXTEND. Appended at the END, never inserted: the admin owns the ordering, and an agent that
  // adds a step gets it after the ones the platform placed. An action already present keeps its
  // authored position.
  for (const action of eligibleInOrder(input.alwaysActions ?? [])) {
    if (!sequence.includes(action)) sequence.push(action);
  }

  // SUBTRACT, last, so the veto outranks every other lever including `alwaysActions`. An action
  // that is both mandatory and forbidden is already refused at write time
  // (`actionOverlapProblems`); resolving it here in the strict direction is the safe residue.
  const never = new Set(input.neverActions ?? []);
  return sequence.filter((action) => !never.has(action));
}
