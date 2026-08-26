/**
 * `NODE_PORTS` — the declared input/output ports for every node type in
 * `WORKFLOW_NODE_REGISTRY` (TASK-809 Task 1, closing defect D-4: "`WorkflowNodeDescriptor`
 * declares no `inputs`/`outputs`", `node-registry.ts:46-80`).
 *
 * Authored HERE rather than inline on the registry literals for exactly the reason
 * `NODE_CONFIG_SCHEMAS` is (`node-config-schemas.ts`): the tables are bulky, they are the piece
 * most likely to change per palette, and keeping them in one module means the registry file
 * stays readable as the pipeline it encodes. `node-registry.ts` attaches them uniformly, the
 * same way it attaches `configSchema`.
 *
 * ## Naming convention (uniform, and the canvas depends on it)
 *
 * | Port | Meaning |
 * |---|---|
 * | `after` | INPUT, `control` — "run this node after that one". Pure ordering, no payload. |
 * | `next` | OUTPUT, `control` — the ordering counterpart of `after`. |
 * | `in` | The node's PRIMARY data input. |
 * | `out` | The node's data output. |
 * | anything else | A secondary, semantically named data port (`context`, `prompt`, `verdict`, `entities`, `transcript`, `bypass`, `loop`). |
 *
 * Ordering is separated from data flow on purpose. Before this ticket, every graph in the repo
 * wired BOTH through a single untyped `in`/`out` pair — which is precisely why no type check
 * was possible: one port could not simultaneously mean "the transcript" and "run me after the
 * consent gate". Splitting them is what makes both checkable.
 *
 * ## MIGRATION NOTE — existing graphs are untyped and will need re-porting
 *
 * Every graph authored before this ticket (the golden fixtures under `__tests__/golden/`, and
 * the seeded definitions in `packages/database/src/prisma/db_main/seed/`) names its ports `in`
 * and `out` for BOTH data and ordering edges. Those graphs therefore do NOT satisfy the tables
 * below, and that is expected rather than a defect in either place: an untyped graph cannot be
 * retro-typed by guessing.
 *
 * This is why `workflowEdgePortProblems` is invoked EXPLICITLY at publish time
 * (`port-validation.ts`) and is deliberately NOT folded into `validate()`'s default rule loop —
 * doing so would retroactively invalidate every saved definition on the day this package
 * shipped. Migrating the seeded graphs is a FOLLOW-ON LANE OF TASK-809 ITSELF — not TASK-812,
 * which is the endpoint stage. Scale of that migration, as audited: every edge in every
 * committed seed uses `fromPort: 'out'` / `toPort: 'in'`, and no activity ever emits a key named
 * `"out"`; 14 of 15 edges in `ARCAAI_CONSULTATION_GRAPH` and all 3 in the SYSTEM platform-default
 * need rewriting, plus regeneration of the derived blobs via the script named in that seed's
 * docstring. That lane also drops the dead `publishTo` key (see the §SEED NOTE on
 * `CONSULTATION_REALTIME_SUMMARY_SCHEMA` in `node-config-schemas.ts`).
 *
 * ## The STT tables are DESIGN INTENT, not observed runtime behaviour
 *
 * All eight `stt.*` activities are deliberate non-execution placeholders
 * (`apps/harness/src/harness/temporal/interpreter/nodes/stt_placeholder.py:1-13`): a published
 * STT `WorkflowDefinition` compiles into an `AsrPipeline` row and is dispatched through the
 * existing realtime/batch ASR path, never executed node-by-node by the interpreter. There is no
 * runtime to infer ports from, so the tables below state the pipeline's intended shape as
 * TASK-724's contract documents it (audio in → audio through the pre-processors → transcript
 * out of the engine). `bypass` and `loop` are declared because the committed golden FIXTURES
 * author those port names; declaring them keeps those graphs resolvable, so they fail on the
 * structural rule they were written to exercise rather than on "unknown port".
 */
import type { WorkflowPortDescriptor } from './port-model';

export interface WorkflowNodePorts {
  readonly inputs: readonly WorkflowPortDescriptor[];
  readonly outputs: readonly WorkflowPortDescriptor[];
}

function port(name: string, primitive: WorkflowPortDescriptor['primitive'], required: boolean, multiple: boolean): WorkflowPortDescriptor {
  return Object.freeze({ name, primitive, required, multiple });
}

/** The ordering-edge input every node accepts (`core.start` excepted — nothing precedes it). */
const AFTER = port('after', 'control', false, true);
/** The ordering-edge output every node offers (`core.end` excepted — nothing follows it). */
const NEXT = port('next', 'control', false, true);

function ports(inputs: readonly WorkflowPortDescriptor[], outputs: readonly WorkflowPortDescriptor[]): WorkflowNodePorts {
  return Object.freeze({ inputs: Object.freeze(inputs), outputs: Object.freeze(outputs) });
}

/**
 * Node type -> its declared ports. Every key in `WORKFLOW_NODE_REGISTRY` appears here; a key
 * missing from this table is a failing test (`node-contract.test.ts`), never a silent
 * `inputs: []`, because a node with no declared ports is exactly the D-4 state this closes.
 */
export const NODE_PORTS: Readonly<Record<string, WorkflowNodePorts>> = Object.freeze({
  // -------------------------------------------------------------------------------------------
  // Palette-agnostic utility + boundary markers. These execute nothing (`core.start`/`core.end`)
  // or nothing meaningful (`noop`/`passthrough`), so they carry ORDERING ports only. Giving
  // `passthrough` a data port would be a false constraint for the same reason it deliberately
  // has no config schema: it round-trips arbitrary config verbatim, and no fixed data type
  // describes that honestly.
  // -------------------------------------------------------------------------------------------
  noop: ports([AFTER], [NEXT]),
  passthrough: ports([AFTER], [NEXT]),
  'core.start': ports([], [NEXT]),
  'core.end': ports([AFTER], []),

  // -------------------------------------------------------------------------------------------
  // Summarization palette (TASK-720). `generate.text` is the one node with two distinct data
  // inputs — the bound context and the resolved prompt — which is the clearest demonstration of
  // why a single untyped `in` could never be type-checked.
  // -------------------------------------------------------------------------------------------
  'input.context_binding': ports([AFTER], [port('out', 'context<schemaRef>', true, true), NEXT]),
  'prompt.template_ref': ports([AFTER], [port('out', 'text', true, true), NEXT]),
  'generate.text': ports(
    [port('context', 'context<schemaRef>', true, false), port('prompt', 'text', false, false), AFTER],
    [port('out', 'document', true, true), NEXT],
  ),
  // `in: text` and not `in: document`: a guardrail legitimately reads ANY textual product — a
  // generated document, a transcript, an assembled prompt — and `document`/`transcript` both
  // widen to `text`. This is the widening direction being useful; the reverse never is.
  'guardrail.check': ports([port('in', 'text', true, false), AFTER], [port('out', 'verdict', true, true), NEXT]),
  'output.deliver': ports([port('in', 'document', true, false), port('verdict', 'verdict', false, true), AFTER], [NEXT]),

  // -------------------------------------------------------------------------------------------
  // STT palette (TASK-724) — DESIGN INTENT (see this module's docstring). Audio flows through
  // the pre-processors unchanged in type; `stt.asrEngine` is the ONLY node that turns
  // `stream<audio>` into `transcript`, which is what makes it the palette's mandatory,
  // non-bypassable step in type terms as well as in rule terms.
  // -------------------------------------------------------------------------------------------
  'stt.audioInput': ports([AFTER], [port('out', 'stream<audio>', true, true), port('bypass', 'stream<audio>', false, true), NEXT]),
  'stt.vad': ports([port('in', 'stream<audio>', true, false), AFTER], [port('out', 'stream<audio>', true, true), NEXT]),
  'stt.noiseFilter': ports([port('in', 'stream<audio>', true, false), AFTER], [port('out', 'stream<audio>', true, true), NEXT]),
  'stt.diarization': ports([port('in', 'stream<audio>', true, false), AFTER], [port('out', 'stream<audio>', true, true), NEXT]),
  'stt.languageDetection': ports([port('in', 'stream<audio>', true, false), AFTER], [port('out', 'stream<audio>', true, true), NEXT]),
  'stt.asrEngine': ports(
    [port('in', 'stream<audio>', true, false), AFTER],
    [port('out', 'transcript', true, true), port('loop', 'control', false, true), NEXT],
  ),
  'stt.transcriptOutput': ports([port('in', 'transcript', true, false), AFTER], [port('loop', 'control', false, true), NEXT]),
  // Redaction preserves the type: a redacted transcript is still a transcript, never model
  // prose. That is what lets `asrEngine -> phiHop -> ner` stay legal while `synthesize -> ner`
  // cannot be expressed at all.
  'stt.phiHop': ports([port('in', 'transcript', true, false), AFTER], [port('out', 'transcript', true, true), NEXT]),

  // -------------------------------------------------------------------------------------------
  // Consultation palette (TASK-731 + TASK-791). The type assignments here carry the palette's
  // safety semantics:
  //
  //   - `captureBinding` and `phiHop` are the only consultation-side producers of `transcript`
  //     — the verbatim record of what was actually said.
  //   - `extractEntities` (the NER node) consumes `transcript` and NOTHING else. See
  //     `__tests__/anti-laundering.test.ts`.
  //   - every generation node (`synthesize`, `realtimeSummary`) produces `document`, and the two
  //     PROPOSAL surfaces (`suggestions`, `proposeCorrections`) produce `edits` — a set of
  //     model-proposed changes a clinician accepts or rejects, never applied silently
  //     (`node-registry.ts` records exactly that reasoning for `externalWrite: false` on them).
  // -------------------------------------------------------------------------------------------
  // A gate authorizes; it emits a control signal, not data.
  'consultation.consentGate': ports([AFTER], [port('out', 'control', true, true), NEXT]),
  'consultation.captureBinding': ports([AFTER], [port('out', 'transcript', true, true), NEXT]),
  'consultation.extractEntities': ports([port('in', 'transcript', true, false), AFTER], [port('out', 'entities', true, true), NEXT]),
  'consultation.bindTerminology': ports([port('in', 'entities', true, false), AFTER], [port('out', 'entities', true, true), NEXT]),
  'consultation.phiHop': ports([port('in', 'transcript', true, false), AFTER], [port('out', 'transcript', true, true), NEXT]),
  'consultation.retrieveEvidence': ports([port('in', 'entities', false, true), AFTER], [port('out', 'context<schemaRef>', true, true), NEXT]),
  // ⚠ DOC-vs-CODE DIVERGENCE, recorded rather than resolved. `node-types.md:117` documents this
  // node's input as `TEXT + STRUCTURED`, but the ACTIVITY reads no `bound_inputs` at all — it
  // resolves everything server-side from `consultationId` (`consultation_compose.py:90-118`,
  // which reads only `config.template` / `dnaStyleId` / `conversationLanguage`).
  //
  // Both data inputs are therefore declared OPTIONAL (`required: false`): that is consistent with
  // the code (nothing must be wired for the node to run) while still permitting the wiring the
  // doc describes and the golden fixtures author. Typing them `required: true` off the doc alone
  // would make the activity's own behaviour unpublishable.
  // OWNER CALL NEEDED on which of the two is authoritative — do not silently "fix" either side.
  'consultation.assemblePrompt': ports(
    [port('in', 'context<schemaRef>', false, true), port('transcript', 'transcript', false, false), AFTER],
    [port('out', 'text', true, true), NEXT],
  ),
  // `in: text` (multiple) accepts BOTH the assembled prompt and a transcript widened to text —
  // the two things a clinical note is actually synthesized from.
  'consultation.synthesize': ports([port('in', 'text', true, true), AFTER], [port('out', 'document', true, true), NEXT]),
  'consultation.sensors': ports(
    [port('in', 'document', true, false), port('entities', 'entities', false, true), AFTER],
    [port('out', 'verdict', true, true), NEXT],
  ),
  'consultation.inferentialSensors': ports(
    [port('in', 'document', true, false), port('verdict', 'verdict', false, true), AFTER],
    [port('out', 'verdict', true, true), NEXT],
  ),
  'consultation.persistDraft': ports([port('in', 'document', true, false), port('verdict', 'verdict', false, true), AFTER], [NEXT]),
  'consultation.finalizeAssurance': ports([port('in', 'document', true, false), port('verdict', 'verdict', false, true), AFTER], [NEXT]),
  // The draft under review is OPTIONAL on the gate: a graph may route the human wait purely as
  // an ordering step. What the gate emits is always a control signal.
  'consultation.hitlGate': ports([port('in', 'document', false, false), AFTER], [port('out', 'control', true, true), NEXT]),
  'consultation.realtimeSummary': ports(
    [port('in', 'transcript', true, false), port('entities', 'entities', false, true), AFTER],
    [port('out', 'document', true, true), NEXT],
  ),
  'consultation.suggestions': ports(
    [port('in', 'transcript', true, false), port('entities', 'entities', false, true), AFTER],
    [port('out', 'edits', true, true), NEXT],
  ),
  // `in: text` rather than `transcript`: corrections are proposed over ANY clinical text,
  // including a generated note. Safe precisely because its product is `edits`, which no
  // extraction node consumes.
  'consultation.proposeCorrections': ports(
    [port('in', 'text', true, false), port('entities', 'entities', false, true), AFTER],
    [port('out', 'edits', true, true), NEXT],
  ),
});

/** `{ inputs: [], outputs: [] }` for an unregistered type — callers detect that via the
 *  registry, not by probing this table. */
export const EMPTY_PORTS: WorkflowNodePorts = Object.freeze({ inputs: Object.freeze([]), outputs: Object.freeze([]) });
