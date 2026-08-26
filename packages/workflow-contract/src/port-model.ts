/**
 * The workflow PORT type vocabulary and its compatibility lattice (TASK-809 Task 2).
 *
 * ## Why a vocabulary at all
 *
 * Before this module, `WorkflowGraphEdge.fromPort`/`toPort` were checked only for being
 * non-empty strings (`graph-model.ts`, defect D-5), and `WorkflowNodeDescriptor` declared no
 * ports at all (defect D-4). An edge therefore carried no meaning a machine could check: the
 * canvas could not offer a `isValidConnection`, publish could not refuse a nonsensical wiring,
 * and the interpreter had to fall back on threading the whole upstream output object when a
 * port name did not resolve. Ports are the contract that closes all three.
 *
 * ## The vocabulary REFINES `CONTEXT_PRIMITIVES`
 *
 * `CONTEXT_PRIMITIVES` (`packages/applications/src/services/consultation-context-schema/
 * context-schema-definition.ts:35`) is the closed set the consultation CONTEXT SCHEMA already
 * types its variables with: `STREAM_AUDIO`, `TEXT`, `DOCUMENT`, `IMAGE`, `STRUCTURED`. Port
 * types are a REFINEMENT of that set, not a parallel invention — which is what makes "this
 * input is any variable in the context object" both expressible and checkable. This package
 * has ZERO runtime dependencies by design (`package.json`), so it cannot import that constant;
 * `CONTEXT_PRIMITIVES_MIRROR` below is the pinned copy and `port-model.test.ts` asserts it
 * verbatim.
 *
 * `TEXT` is refined into `transcript` and `text`, and `STRUCTURED` into `entities`, `edits`,
 * `verdict` and `context<schemaRef>` — because "a string" and "an object" are not clinical
 * types, and the whole safety value of this contract lives in the distinctions they erase.
 * `IMAGE` deliberately has no standalone port type: an image context variable travels inside
 * `context<schemaRef>` like every other context kind, and no node in the registry consumes one
 * on its own.
 *
 * ## `control` — the ninth member
 *
 * TASK-809 §2b names EIGHT data types. A ninth, `control`, is required and is NOT a data type:
 * it types an ORDERING edge, which carries no payload. Every graph in this repo already
 * contains such edges (`core.start -> …`, `consultation.consentGate -> …`,
 * `consultation.hitlGate -> …`); none of the eight can type them, because those nodes produce
 * no data. The precedent is explicit — TASK-715's README:735 already specified a port primitive
 * as "one of CONTEXT_PRIMITIVES … or 'CONTROL'".
 *
 * `control` is safety-NEUTRAL by construction: it satisfies only itself, in both directions
 * (see `portPrimitiveSatisfies`), so it can neither carry data nor be substituted for data.
 * Adding it cannot weaken the anti-laundering rule.
 *
 * ## The lattice, and why it IS the anti-laundering rule
 *
 * Compatibility is a SUBTYPE relation with exactly two widenings — `transcript ⊑ text` and
 * `document ⊑ text` — and no others. Two consequences, both load-bearing:
 *
 * - Widening only ever goes specific → general. A `text` producer can never satisfy a
 *   `transcript` consumer, so nothing can be laundered by first erasing its provenance.
 * - `transcript` and `document` are SIBLINGS. Neither satisfies the other. Since the NER node
 *   consumes `transcript` and every generation node produces `document`, **`document -> ner` is
 *   a type error** — the anti-hallucination-laundering rule made structural rather than
 *   procedural. `__tests__/anti-laundering.test.ts` proves it exhaustively.
 */

/**
 * The closed port type vocabulary. `control` types ordering edges; the other eight are
 * TASK-809 §2b's data types. Closed on purpose — an open vocabulary is an API surface that
 * cannot be versioned, and every later ticket (810/811/812/815) consumes this list.
 */
export const WORKFLOW_PORT_PRIMITIVES = [
  'control',
  'stream<audio>',
  'transcript',
  'text',
  'entities',
  'document',
  'edits',
  'verdict',
  'context<schemaRef>',
] as const;

export type WorkflowPortPrimitive = (typeof WORKFLOW_PORT_PRIMITIVES)[number];

/**
 * The direction-independent half of a port declaration. `required` and `multiple` describe the
 * port's ARITY for the canvas and for the interpreter's input binding; the type check itself
 * (`portPrimitiveSatisfies`) reads only `primitive`.
 */
interface WorkflowPortBase {
  /** Stable, node-type-local port name — what a graph edge's `fromPort`/`toPort` names. */
  readonly name: string;
  /** An input the node cannot run without / an output the node always produces. */
  readonly required: boolean;
  /** Whether the port accepts (inputs) or feeds (outputs) more than one edge. */
  readonly multiple: boolean;
}

/**
 * One declared port on a node type.
 *
 * ## `outputKey` — the socket's RUNTIME key (TASK-809 OD-15, option A)
 *
 * A port name is an AUTHORING handle: `out`, `entities`, `verdict` are what the canvas draws and
 * what an edge's `fromPort`/`toPort` names. The interpreter, however, threads values by reading a
 * KEY out of the producing activity's own output dict (`NodeActivityResult.output`), and no
 * activity in this platform has ever emitted a key called `"out"`. Before OD-15 the two models
 * only met through the interpreter's whole-object fallback — which is exactly the untyped
 * "bundle" the port vocabulary exists to abolish (a bundle cannot be typed as "contains a
 * document", so generated text could reach NER again).
 *
 * `outputKey` closes that gap in ONE place: the socket keeps its authored name, and declares
 * beside it which key of the activity's output it carries. `_resolve_bound_inputs`
 * (`apps/harness/.../interpreter/workflow.py`) reads `upstream_output[outputKey]`; an edge whose
 * `fromPort` resolves to no declared output port RAISES rather than silently threading the whole
 * object.
 *
 * Two invariants, one of them enforced by this type rather than by a test:
 *
 *  - a **`control`** port carries no payload at all — ordering only — so it can never declare an
 *    `outputKey`. That is `outputKey?: never` below, not a convention.
 *  - every non-control **OUTPUT** port MUST declare one. `node-contract.test.ts` asserts that
 *    across the whole registry (an input port's `outputKey` is meaningless and is never set).
 *
 * There is deliberately NO "the whole output object" encoding. Where an activity's natural shape
 * offered no key for a port — `input.context_binding`, `consultation.retrieveEvidence`,
 * `consultation.sensors`, `consultation.inferentialSensors` — the ACTIVITY was changed to publish
 * its object under a named key, because a nameless whole-object port is option C, which the owner
 * rejected.
 */
export type WorkflowPortDescriptor =
  | (WorkflowPortBase & {
      readonly primitive: 'control';
      /** Ordering carries no payload: a control port never names a runtime output key. */
      readonly outputKey?: never;
    })
  | (WorkflowPortBase & {
      readonly primitive: Exclude<WorkflowPortPrimitive, 'control'>;
      /** The key of the producing activity's `output` dict this socket carries. Set on OUTPUT
       *  ports only — an input port is bound BY `toPort`, so it has no key of its own. */
      readonly outputKey?: string;
    });

/**
 * Each primitive's DIRECT supertype, or `null` when it is a lattice root. Widening is the
 * reflexive-transitive closure of this map — see `portPrimitiveSatisfies`.
 *
 * Read the two non-null entries as the safety claim they are: a transcript IS text and a
 * generated document IS text, so both may be handed to a consumer that asked for text (a
 * guardrail, a moderation check). Nothing else widens, and nothing narrows.
 */
export const WORKFLOW_PORT_SUPERTYPE: Readonly<Record<WorkflowPortPrimitive, WorkflowPortPrimitive | null>> = Object.freeze({
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
 * The pinned copy of `CONTEXT_PRIMITIVES` (`context-schema-definition.ts:35`). Pinned rather
 * than imported because this package must keep zero runtime dependencies; `port-model.test.ts`
 * asserts it verbatim so a divergence is a failing test, not a silent drift.
 */
export const CONTEXT_PRIMITIVES_MIRROR = ['STREAM_AUDIO', 'TEXT', 'DOCUMENT', 'IMAGE', 'STRUCTURED'] as const;

/**
 * The bridge: which `CONTEXT_PRIMITIVES` member each port type refines. `'CONTROL'` for the
 * ordering type, which is not a context primitive at all (TASK-715 README:735's own phrasing).
 * This is what lets a context variable of a given primitive be matched against a node input.
 */
export const PORT_PRIMITIVE_CONTEXT_PRIMITIVE: Readonly<Record<WorkflowPortPrimitive, string>> = Object.freeze({
  control: 'CONTROL',
  'stream<audio>': 'STREAM_AUDIO',
  transcript: 'TEXT',
  text: 'TEXT',
  entities: 'STRUCTURED',
  document: 'DOCUMENT',
  edits: 'STRUCTURED',
  verdict: 'STRUCTURED',
  'context<schemaRef>': 'STRUCTURED',
});

/** Whether `value` is a member of the closed vocabulary. */
export function isWorkflowPortPrimitive(value: unknown): value is WorkflowPortPrimitive {
  return typeof value === 'string' && (WORKFLOW_PORT_PRIMITIVES as readonly string[]).includes(value);
}

/**
 * Does a value PRODUCED on an output port of type `produced` satisfy an input port of type
 * `consumed`?
 *
 * True when `consumed` is `produced` or any of its transitive supertypes. Direction matters and
 * is the whole point: this relation is deliberately NOT symmetric.
 */
export function portPrimitiveSatisfies(produced: WorkflowPortPrimitive, consumed: WorkflowPortPrimitive): boolean {
  let cursor: WorkflowPortPrimitive | null = produced;
  while (cursor !== null) {
    if (cursor === consumed) return true;
    cursor = WORKFLOW_PORT_SUPERTYPE[cursor];
  }
  return false;
}
