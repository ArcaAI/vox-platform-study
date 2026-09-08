/**
 * `WORKFLOW_NODE_REGISTRY` — the code-owned node-type vocabulary for the agentic-workflow-
 * platform substrate (closing the gap `predicates/context.ts` flagged:
 * " `WORKFLOW_NODE_REGISTRY`, not yet built at the time this package was authored").
 *
 * own speculatively placed this at
 * `packages/applications/src/services/workflow-registry/` — but that same section says "re-
 * verify at execution time, do not assume", and nothing was ever built there. This ticket
 * places it here instead, in `@arcaai/workflow-contract`, for the same reason the compiler and
 * validator already live here: node specs are CODE CONTRACTS that gate what the interpreter
 * can execute, not tenant configuration, and this package's "zero runtime dependencies"
 * property means the registry can be imported by the database seed AND the applications layer
 * without either pulling in the other ( 's reason for the package split in the
 * first place). `packages/applications/src/services/workflow-definition/` re-exports what it
 * needs from here rather than owning a second copy.
 *
 * ## The cross-language constraint ( / mandate)
 *
 * `apps/harness/src/harness/temporal/interpreter/registry.py` is the RUNTIME dispatch table —
 * it binds each node type to a real `@activity.defn` Temporal activity and is Python-only by
 * necessity (Temporal activities cannot be expressed in TypeScript and run in this worker).
 * This file is the GATEWAY's view of the same vocabulary: what a graph is allowed to
 * reference, what class/palette/entitlement it carries, and what the compiler stamps into
 * `compiledConfig.stages[].nodes[].activity`. The two must agree on every KEY the registry
 * exposes today (currently `noop`/`passthrough` only — `registry.py`'s own docstring: "starts
 * EMPTY of palette nodes — populates it"), or a definition that validates in the
 * gateway fails admission in the interpreter. `__tests__/node-registry-parity.test.ts` (this
 * package) and `test_node_registry_parity.py` (harness) both assert against ONE committed
 * fixture — `packages/workflow-contract/src/__tests__/fixtures/node-registry.snapshot.json`
 * — rather than against each other directly, because neither
 * runtime can import the other language's module.
 *
 * `classes`/`paletteKey` are TS-only concepts (the predicate catalogue's `nodeClass` selector
 * and the Studio's palette grouping); `registry.py`'s `kind` field (reserved for a future
 * `child_workflow` dispatch) has no TS counterpart yet. The shared fixture therefore only
 * carries the fields both sides actually have today: `key`, `implemented`, `activityName`,
 * `critical`, `externalWrite`, `defaultTimeoutSeconds`, `defaultMaxAttempts`, `entitlementKey`.
 */
import { createHash } from 'node:crypto';
import { actionDelegateOf } from './action-catalogue';
import { canonicalJson } from './canonical-json';
import type { CompilerNodeInfo } from './compiler';
import { NODE_CONFIG_SCHEMAS, type NodeConfigSchema } from './node-config-schemas';
import { EMPTY_PORTS, NODE_PORTS } from './node-ports';
import type { WorkflowPortDescriptor } from './port-model';
import type { WorkflowNodeClassLookup } from './predicates';

export interface WorkflowNodeDescriptor {
  /** The node `type` string authored on a graph node (`WorkflowGraphNode.type`). */
  readonly key: string;
  /** Mirrors `registry.py`'s `NodeSpec.implemented` — an unimplemented entry is an
   *  OBSERVABLE, non-executable placeholder, never silently dropped: `nodeInfo()` returns
   *  `undefined` for it, so `compile()` refuses any graph that uses it (WF-C-002).
   *  Cross-language rule (TASK-867): `implemented: false` HERE means NO `NodeSpec` in
   *  `registry.py`. A Python spec cannot exist without a registered `@activity.defn` callable,
   *  and the interpreter already treats "no spec" and "unimplemented spec" identically
   *  (SKIPPED, `unsupported_node_type`), so an entry kept here only for its deprecation window
   *  has no Python twin — `test_node_registry_parity.py` asserts exactly that. */
  readonly implemented: boolean;
  /** The Temporal-registered activity name (`registry.py`'s `activity_name`, e.g.
   *  `"interpreter.noop"`) — what the compiler stamps into `CompiledNode.activity`. */
  readonly activityName: string;
  /** Registry-declared classes (e.g. `['gate']`, `['phiBearing']`) — resolved by
   *  `classesOf()` for the predicate catalogue's `{ nodeClass }` selectors and by the
   *  compiler to detect gate nodes. Empty for the seed `noop`/`passthrough` entries, which
   *  belong to no palette and carry no safety classification. */
  readonly classes: readonly string[];
  /** The palette this node type belongs to, or `null` for palette-agnostic utility nodes
   *  (the seed entries). Resolved by `paletteOf()`. */
  readonly paletteKey: string | null;
  /** Code-owned safety property — never tenant-configurable (mirrors `registry.py`). */
  readonly critical: boolean;
  /** Code-owned safety property — never tenant-configurable (mirrors `registry.py`). */
  readonly externalWrite: boolean;
  readonly defaultTimeoutSeconds: number;
  readonly defaultMaxAttempts: number;
  /**
   * An `EntitlementFeatureKey` string, or `null` if the node type is ungated
   * Per-palette entitlement gating: every node type in a palette must declare the
   *  same key as the palette, or none). Typed `string` rather than the domains enum so this
   *  package keeps zero runtime dependencies.
   */
  readonly entitlementKey: string | null;
  /**
   * The node type's config JSON Schema (authorable subset), or `undefined` when none has been
   *  authored yet — see `node-config-schemas.ts`'s docstring for which node types have one and
   * why some deliberately do not ( registry-contract gap, closed for the node types
   *  with a real, committed schema source). Attached below via `NODE_CONFIG_SCHEMAS`, never
   *  inline on these literals, so the schema source stays the single place it is authored.
   */
  readonly configSchema?: NodeConfigSchema;

  // -------------------------------------------------------------------------------------------
  // the node CONTRACT. Everything above describes how a node is DISPATCHED; the
  // fields below describe what it may be WIRED TO, when it runs, and what must be true of it
  // before a graph containing it can be published. All seven are TypeScript-side only: the
  // cross-language parity fixture carries the eight fields both runtimes share, and
  // `classes`/`paletteKey` are the standing precedent for a TS-only concept (the fixture's own
  // `_comment` records it). Do not add any of them to either projection without adding them to
  // `registry.py`'s `NodeSpec` and BOTH projections in the same change.
  // -------------------------------------------------------------------------------------------

  /** Declared input ports. Attached below from `NODE_PORTS` (`node-ports.ts`) for the same
   *  reason `configSchema` is: the tables are bulky and belong in one place. Closes D-4. */
  readonly inputs: readonly WorkflowPortDescriptor[];
  /** Declared output ports — see `inputs`. */
  readonly outputs: readonly WorkflowPortDescriptor[];
  /** WHEN the node runs, ORTHOGONAL to `lane` (DD-5). `on-start` once at the opening,
   *  `per-turn` as new material arrives, `on-end` once at the close. This is what lets two
   *  nodes share a lane without sharing a cadence, and it absorbs the endpoint stage uniformly
   *  as `on-end`. */
  readonly trigger: WorkflowNodeTrigger;
  /**
   * WHICH RUNTIME executes it, and it is now LOAD-BEARING rather than descriptive
   *  lane A, item 7). `durable` means the interpreter workflow dispatches `activityName` as a
   * Temporal activity; `realtime` means live executor runs it and the durable
   *  interpreter SKIPS it (`reason: 'realtime_lane'`), so exactly one runtime ever executes a
   *  given node.
   *
   *  It was `durable` on every entry until this lane, which was a claim the platform had already
   *  outgrown: `REALTIME_NODE_TYPES` (`realtime-node-registry.ts`) listed three consultation
   *  nodes the realtime runtime executes, and that set is now DERIVED from this field rather than
   *  hand-maintained beside it. `lane` is the SECOND field shared with the Python mirror (after
   *  `outputKey`), because the skip has to be enforced where dispatch happens.
   */
  readonly lane: WorkflowNodeLane;
  /**
   * Guard attachment keys — node types that must be wired to EVERY INSTANCE of this node
   *  before a graph containing it can be published (`workflowPublishProblems`, checked per
   *  instance, not per type).
   *
   * Populated on the TARGET CATALOGUE only (lane A, item 17): the three `agent.*`
   *  generation entries require `guard.groundedness`, and `agent.transcription` requires
   *  `guard.phi`. It stays `[]` on every PIPELINE node type, deliberately — the summarization
   *  palette's mandatory guardrail and the consultation palette's mandatory PHI hop are already
   *  enforced by the rule catalogue (`WF-SUMM-*`, `WF-CONS-009`), and a second enforcement path
   *  for one policy is how the two drift apart. The new catalogue has no rule set of its own, so
   *  here `requires` IS the only enforcement rather than a duplicate of one.
   */
  readonly requires: readonly string[];
  /** MUST be `true` for any `lane: 'durable'` node, because Temporal retries activities and a
   *  non-idempotent retry double-writes invisibly. Enforced by
   *  `nodeDescriptorContractProblems`. */
  readonly idempotent: boolean;
  /** The node TYPE's version. A node type is a contract with every saved tenant graph, so a
   *  published node's ports are never reshaped in place — a breaking change becomes a new key
   *  with an `@N` suffix (`agent.ner@2`) and this field must agree with that suffix. Otherwise
   *  definition-level immutability is undermined by node-level mutation. */
  readonly schemaVersion: number;
  /**
   * OD-11: the eval gate binds to the NODE, not to a `DepartmentAgent`. Declared here so the
   * binding has a home; `undefined` on every node today — migrates the data onto it.
   */
  readonly evalGate?: WorkflowNodeEvalGate;
  /**
   * TASK-864 / TASK-859 §6 — the node type is DEPRECATED: it keeps compiling and executing for
   * the two-release window, the Studio hides it from the palette rail (but still renders graphs
   * that use it), and `replacedBy` names the `core.*` type that supersedes it. TS-only, like
   * `classes`/`paletteKey`: the interpreter dispatches a deprecated type exactly as before.
   * The one exception is a type that is ALSO `implemented: false` (the retired `stt` palette,
   * TASK-861 step 10 / TASK-867): `compile()` refuses it, so only already-published rows keep
   * loading and rendering.
   */
  readonly deprecated?: boolean;
  /** The `core.*` node type (or `core.action` key) a deprecated type maps onto. */
  readonly replacedBy?: string;
}

/** When a node runs — orthogonal to `lane`. */
export type WorkflowNodeTrigger = 'on-start' | 'per-turn' | 'on-end';

/** Which runtime executes a node. */
export type WorkflowNodeLane = 'realtime' | 'durable';

/** OD-11 — the golden-set binding, on the node rather than on an agent row. */
export interface WorkflowNodeEvalGate {
  readonly goldenSetId: string;
  readonly enabled: boolean;
}

/**
 * The seed entries mirror `registry.py`'s `NODE_REGISTRY` exactly — both intentionally ship
 * ONLY `noop`/`passthrough` in this pass; adds the five summarization-palette node
 * types to both sides together. `configSchema` is deliberately NOT set on these literals —
 * see the derivation below, which attaches it uniformly from `NODE_CONFIG_SCHEMAS`.
 */
const WORKFLOW_NODE_REGISTRY_BASE: Readonly<Record<string, Omit<WorkflowNodeDescriptor, 'configSchema' | 'inputs' | 'outputs'>>> = Object.freeze({

  // ===========================================================================================
  // TASK-864 — the `core` vocabulary: ONE palette for every future graph.
  //
  // Trigger · Agent · Classify · Human review · Variable · If/Else · Loop · Note · Output are the
  // owner's control vocabulary; `core.data` and `core.action` are the two platform-action node
  // types (a deterministic reshape, and every remaining fixed-purpose clinical step keyed by
  // `actionKey`). The four legacy palettes stay registered — a node type is a contract with every
  // saved tenant graph — and are marked `deprecated` with a `replacedBy` pointer here.
  //
  // ## Classes that are LOAD-BEARING on the compiler and the interpreter
  //
  //  - `boundary` on trigger/output: the palette-agnostic reachability rules exempt markers.
  //  - `router` on classify/condition: an edge leaving any handle other than `out`/`next` is a
  //    BRANCH — the compiler records it as a `branchGuards` entry on the target, and the
  //    interpreter SKIPS the target (`branch_not_taken`) unless that handle was taken.
  //  - `review` on humanReview: the same branch treatment for `approved`/`rejected`/`timedOut`,
  //    PLUS in-stage dispatch as a `ReviewGateWorkflow` child. Deliberately NOT `gate`: the
  //    compiler lifts `gate`-classed nodes to the END of the walk, and a review must be able to
  //    sit in the middle of a graph (`... -> Agent -> Human review -> Output`).
  //  - `loop` on loop: nodes with `parentId = <loop id>` are its BODY, compiled into
  //    `loops[].body` and run by `LoopWorkflow` one iteration per generation.
  //  - `annotation` on note: stripped by `compile()`, never dispatched.
  //
  // ## `critical` / `externalWrite`
  //
  // `core.trigger` and `core.output` are `critical`: a payload that does not match the declared
  // schema (`fail` mode) is a run that cannot honestly proceed or return. `core.output` and
  // `core.humanReview` are `externalWrite` (a published result; a recorded human decision), so a
  // sandbox run suppresses both. `core.action` is `externalWrite: false` on the TYPE and the
  // interpreter resolves the DELEGATED action's own flags per instance (`ACTION_CATALOGUE`).
  // ===========================================================================================
  'core.trigger': Object.freeze({
    key: 'core.trigger',
    implemented: true,
    activityName: 'interpreter.core_trigger',
    classes: Object.freeze(['boundary', 'mandatory', 'entry']),
    paletteKey: 'core',
    critical: true,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.agent': Object.freeze({
    key: 'core.agent',
    implemented: true,
    activityName: 'interpreter.core_agent',
    // NOT `generation`-classed, deliberately. That class means "this NODE carries the prompt
    // binding, the eval gate and the document-shape pin"; an Agent node carries none of them —
    // its instruction, its model and its guards live on the published Agent row it references
    // (TASK-863). It is also what keeps the anti-laundering rule intact: a generation-classed node
    // may never emit `transcript`, and this node's `transcript` socket is live for an ASR agent.
    classes: Object.freeze(['agent']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 300,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.classify': Object.freeze({
    key: 'core.classify',
    implemented: true,
    activityName: 'interpreter.core_classify',
    classes: Object.freeze(['router']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.humanReview': Object.freeze({
    key: 'core.humanReview',
    implemented: true,
    activityName: 'interpreter.core_human_review',
    classes: Object.freeze(['review']),
    paletteKey: 'core',
    critical: false,
    externalWrite: true,
    // The wait itself; `timeoutSeconds` on the node config is the review deadline.
    defaultTimeoutSeconds: 3600,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.variable': Object.freeze({
    key: 'core.variable',
    implemented: true,
    activityName: 'interpreter.core_variables',
    classes: Object.freeze([]),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.condition': Object.freeze({
    key: 'core.condition',
    implemented: true,
    activityName: 'interpreter.core_condition',
    classes: Object.freeze(['router']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.loop': Object.freeze({
    key: 'core.loop',
    implemented: true,
    activityName: 'interpreter.core_loop',
    classes: Object.freeze(['loop']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    // The whole `maxDurationSeconds` ceiling — the parent spends it as a workflow timer.
    defaultTimeoutSeconds: 3600,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.note': Object.freeze({
    key: 'core.note',
    implemented: true,
    activityName: 'interpreter.core_note',
    classes: Object.freeze(['annotation']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 1,
    defaultMaxAttempts: 1,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.output': Object.freeze({
    key: 'core.output',
    implemented: true,
    activityName: 'interpreter.core_output',
    classes: Object.freeze(['boundary', 'mandatory', 'terminal']),
    paletteKey: 'core',
    critical: true,
    externalWrite: true,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-end',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.data': Object.freeze({
    key: 'core.data',
    implemented: true,
    activityName: 'interpreter.core_data',
    classes: Object.freeze([]),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
  'core.action': Object.freeze({
    key: 'core.action',
    implemented: true,
    activityName: 'interpreter.core_action',
    classes: Object.freeze(['action']),
    paletteKey: 'core',
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    entitlementKey: null,
    trigger: 'on-start',
    lane: 'durable',
    requires: Object.freeze([]),
    idempotent: true,
    schemaVersion: 1,
  }),
});

/**
 * The public registry: `WORKFLOW_NODE_REGISTRY_BASE` with each entry's `configSchema` attached
 * from `NODE_CONFIG_SCHEMAS` (`node-config-schemas.ts`) and its `inputs`/`outputs` from
 * `NODE_PORTS` (`node-ports.ts`). A key absent from the schema map yields
 * `configSchema: undefined` — the documented, structural "no schema authored yet" state, not a
 * defect (see that module's docstring for which node types this applies to and why).
 *
 * A key absent from `NODE_PORTS` is NOT the same kind of state: it yields empty port lists,
 * which is the exact D-4 condition this ticket closes, so `__tests__/node-contract.test.ts`
 * fails on it rather than letting a portless node type ship.
 */
export const WORKFLOW_NODE_REGISTRY: Readonly<Record<string, WorkflowNodeDescriptor>> = Object.freeze(
  Object.fromEntries(
    Object.entries(WORKFLOW_NODE_REGISTRY_BASE).map(([key, descriptor]) => {
      const declaredPorts = NODE_PORTS[key] ?? EMPTY_PORTS;
      return [
        key,
        Object.freeze({ ...descriptor, configSchema: NODE_CONFIG_SCHEMAS[key], inputs: declaredPorts.inputs, outputs: declaredPorts.outputs }),
      ];
    }),
  ),
);

/**
 * TASK-864 — the `core` palette: the ONE vocabulary graphs are authored in (and, since TASK-893,
 * the only palette the registry declares). Declared as a constant because three independent
 * things key on it: `KNOWN_PALETTE_KEYS` derives the create-time validation set from the
 * registry, the Studio's palette rail groups by it, and `CORE_NODE_TYPES` is derived from it.
 */
export const CORE_PALETTE_KEY = 'core';

/** The `core.*` node types, DERIVED from `paletteKey` rather than re-typed. */
export const CORE_NODE_TYPES: readonly string[] = Object.freeze(
  Object.values(WORKFLOW_NODE_REGISTRY)
    .filter((descriptor) => descriptor.paletteKey === CORE_PALETTE_KEY)
    .map((descriptor) => descriptor.key),
);

/** Whether a node type is marked deprecated (TASK-859 §6) — `false` for every registered type
 *  since TASK-893 retired the legacy vocabulary, and for an unknown type. */
export function isDeprecatedNodeType(nodeType: string): boolean {
  return WORKFLOW_NODE_REGISTRY[nodeType]?.deprecated === true;
}

/**
 * The classes an INSTANCE carries (TASK-893 §7.3) — `[]` for an unknown type (never throws; a
 * caller checks `nodeInfo()`/`compile()` findings for "unknown type", not this).
 *
 *  - `core.action` → its catalogue entry's classes ∪ `{'action'}`, so a rule written against a
 *    class (`WF-I-004`'s `activity`, `mandatory`, `redaction`, …) keeps firing on a migrated node;
 *    an action with no resolvable key answers the TYPE's own classes.
 *  - `core.agent` → `{'agent', 'activity', 'generation'}`: an agent node emits a trajectory step
 *    and generates, so `WF-I-002` / `WF-I-004` select it. The REGISTRY descriptor deliberately
 *    stays `['agent']` (`nodeInfo()` is what the compiler reads — a generation-classed descriptor
 *    would be a different compile contract).
 *  - everything else → the descriptor's classes.
 */
export function classesOf(nodeType: string, config?: Readonly<Record<string, unknown>>): readonly string[] {
  if (nodeType === 'core.action') {
    const delegate = actionDelegateOf(config);
    if (delegate !== undefined) return Object.freeze([...new Set([...delegate.classes, 'action'])]);
  }
  if (nodeType === 'core.agent') return CORE_AGENT_INSTANCE_CLASSES;
  return WORKFLOW_NODE_REGISTRY[nodeType]?.classes ?? [];
}

const CORE_AGENT_INSTANCE_CLASSES: readonly string[] = Object.freeze(['agent', 'activity', 'generation']);

/** The palette a node type belongs to, or `undefined` if unregistered/palette-agnostic. */
export function paletteOf(nodeType: string): string | undefined {
  return WORKFLOW_NODE_REGISTRY[nodeType]?.paletteKey ?? undefined;
}

/** The `{ activity, classes, defaultTimeoutSeconds }` shape `compile()`'s
 *  `CompilerContext.nodeInfo()` expects — `undefined` for an unregistered or unimplemented
 *  type, so the compiler's existing "not a registered node type" finding also fires for a
 *  registered-but-`implemented: false` entry (mirrors `registry.py`'s "no entry, or
 *  `implemented=False`, is an observable skip").
 *
 *  `defaultTimeoutSeconds` travels so an untimed node compiles to the budget its own TYPE
 *  declares rather than to one flat number (F13) — the declaration stays here, in the registry,
 *  and the compiler stays registry-free. */
export function nodeInfo(nodeType: string): CompilerNodeInfo | undefined {
  const descriptor = WORKFLOW_NODE_REGISTRY[nodeType];
  if (descriptor === undefined || !descriptor.implemented) return undefined;
  return { activity: descriptor.activityName, classes: descriptor.classes, defaultTimeoutSeconds: descriptor.defaultTimeoutSeconds };
}

/** Satisfies `WorkflowEvaluationContext.registry` (`predicates/context.ts`) — the impure glue
 *  between this static registry and the pure predicate evaluators. */
export const workflowNodeClassLookup: WorkflowNodeClassLookup = { classesOf, paletteOf };

/**
 * sha256 of the registry, descriptors sorted by `key` before hashing ( finding #7:
 * "descriptor array order must also be stable or every deploy looks like a registry bump and
 * flags every published definition NEEDS_REVIEW"). A definition's stamped `registryChecksum`
 * is compared against this at read time to trigger `NEEDS_REVIEW` re-validation.
 */
export function registryChecksum(): string {
  const sorted = Object.values(WORKFLOW_NODE_REGISTRY)
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key));
  return createHash('sha256').update(canonicalJson(sorted)).digest('hex');
}
