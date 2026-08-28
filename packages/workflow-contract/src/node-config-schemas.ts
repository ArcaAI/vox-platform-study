/**
 * `NODE_CONFIG_SCHEMAS` — the per-node-type config JSON Schema (authorable subset,
 * `@arcaai/json-schema-subset`), the piece `node-registry.ts`'s own docstring and
 * `docs/implementation/TASK-719-Workflow-Studio-V1/contracts/registry.contract.md` both
 * recorded as a real, structural gap: "no delivered node-type descriptor carries a config
 * schema… `WorkflowNodeDescriptor` in `node-registry.ts` likewise carries no schema field."
 *
 * `registry.contract.md`'s own resolution path (§"Where does a per-node config schema come
 * from, going forward?") named option 1: "TASK-720 adds a `configSchema` field to
 * `WorkflowNodeDescriptor`/`WorkflowNodeResponse` when it adds real palette node types." That
 * field never landed even after TASK-720/724/731/734 added the real node types — this module
 * closes exactly that gap, sourcing each schema from the CONTRACT DOCUMENT already committed
 * for it rather than inventing one:
 *
 * - Summarization palette (5): `docs/implementation/TASK-720-Palette-Summarization/contracts/
 *   nodes/*.schema.json` — copied verbatim.
 * - STT palette (8): `docs/implementation/TASK-724-Palette-Stt/contracts/nodes/*.schema.json`
 *   — copied verbatim.
 * - `noop`/`core.start`/`core.end`: no committed schema document exists, but the ACTUAL
 *   accepted config is small and readable straight off the interpreter activity
 *   (`apps/harness/src/harness/temporal/interpreter/activities.py`) — `interpreter_noop`
 *   reads `config["raise_error"]`/`config["sleep_seconds"]` and nothing else; `core_start`/
 *   `core_end` read no config at all.
 *
 * - Consultation palette (16): authored by TASK-809 Task 9 to close D-9. `node-types.md` named
 *   `contracts/nodes/*.schema.json` files for these and they were never written, so each schema
 *   is derived instead from the two sources that DO exist and are already enforced — the
 *   `DRAFT_CONSULTATION_RULE_SET` fields a published graph must already carry, and the keys each
 *   interpreter activity actually reads off `payload.config`. See the block comment above those
 *   schemas for the full derivation, and `__tests__/node-config-schemas.test.ts`, which asserts
 *   both directions (nothing the validator demands is missing; nothing the runtime honours is
 *   rejected).
 *
 * ONE node type is DELIBERATELY left with no entry (`configSchema: undefined` on the registry
 * descriptor, the posture the whole registry had for every node until this file):
 *
 * - `passthrough` — "echoes its own config back as output" (`activities.py`'s own docstring);
 *   its whole purpose is accepting an arbitrary payload verbatim, so a fixed schema would be
 *   a false constraint, not a documentation of a real one. The inspector's existing raw-JSON
 *   fallback (`registry.contract.md`'s Task 9 discipline) is the CORRECT rendering for this
 *   node, not a gap.
 *
 * Every entry here is asserted against `authorableJsonSchemaProblems` in
 * `__tests__/node-config-schemas.test.ts` — a schema that is not authorable cannot be compiled
 * by the Studio's `toFieldDescriptors` (`apps/admin-console`) either.
 */

export type NodeConfigSchema = Readonly<Record<string, unknown>>;

/** Summarization palette (TASK-720) — copied verbatim from `contracts/nodes/*.schema.json`. */
const INPUT_CONTEXT_BINDING_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/input.context_binding.schema.json',
  title: 'input.context_binding node config (N-1, safety class: mandatory)',
  type: 'object',
  additionalProperties: false,
  required: ['contextSchema', 'bindings'],
  properties: {
    contextSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'kinds'],
      properties: {
        schemaVersion: { type: 'string', const: '1.0' },
        kinds: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'label', 'primitive', 'phiClass', 'cardinality', 'lifecycle', 'producedBy'],
            properties: {
              key: { type: 'string', pattern: '^[a-z0-9_]{2,48}$' },
              label: { type: 'string', minLength: 1, maxLength: 200 },
              primitive: { type: 'string', enum: ['TEXT', 'STRUCTURED'] },
              phiClass: { type: 'string', enum: ['PHI', 'NON_PHI'] },
              cardinality: { type: 'string', enum: ['ONE', 'MANY'] },
              lifecycle: { type: 'string', enum: ['PRE', 'DURING', 'POST', 'ANY'] },
              producedBy: { type: 'array', minItems: 1, items: { type: 'string', enum: ['CLIENT', 'AGENT', 'SYSTEM'] } },
              required: { type: 'boolean' },
              description: { type: 'string', maxLength: 2000 },
            },
          },
        },
        outputs: {
          type: 'array',
          maxItems: 64,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'primitive'],
            properties: {
              key: { type: 'string', pattern: '^[a-z0-9_]{2,48}$' },
              label: { type: 'string', maxLength: 200 },
              description: { type: 'string', maxLength: 2000 },
              primitive: { type: 'string', enum: ['TEXT', 'STRUCTURED'] },
            },
          },
        },
      },
    },
    bindings: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kindKey', 'from'],
        properties: {
          kindKey: { type: 'string', pattern: '^[a-z0-9_]{2,48}$' },
          from: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
  },
});

/**
 * DD-11's prompt binding, as two config keys on the node that carries it.
 *
 * `promptTemplateId` says WHICH template; `promptVersionNumber` is that node's own movable PIN
 * onto one IMMUTABLE version of it. The pin is the whole mechanism that stops an admin editing
 * one shared template on the Prompt-management screen from silently re-prompting every workflow
 * that references it — including published clinical ones.
 *
 * Declared here rather than per-schema because every schema in this module is
 * `additionalProperties: false` AND the Studio inspector builds its form from
 * `Object.entries(schema.properties)` alone. A node type that can carry a binding but does not
 * DECLARE it loses the pin twice over: the value evaluator rejects it, and form generation drops
 * it because no field is ever rendered for it — so a node round-tripped through the authoring UI
 * comes back unpinned. Sharing one frozen object is what stops the seven declaration sites
 * drifting apart into that state one node at a time.
 *
 * `minimum: 1` is not cosmetic: it is the same bound as `readBinding`'s `pinned > 0` guard
 * (`node-prompt-binding.ts`) and as `versionNumber` on the compiled artifact — the normative
 * `compiled-config.schema.json` and both pydantic models (`ge=1`). A pin authorable here that
 * those reject would be a pin the interpreter cannot honour.
 *
 * Deliberately NOT added to any schema's `required`: DD-11 says a generation node MUST reference
 * a prompt, but making the key required HERE would invalidate every graph already published
 * without one. Shape is this module's job; "must reference" is a rule-catalogue job.
 */
const PROMPT_TEMPLATE_ID_PROPERTY = Object.freeze({
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  description: 'DD-11 — the prompt template this node uses.',
});

const PROMPT_VERSION_NUMBER_PROPERTY = Object.freeze({
  type: 'integer',
  minimum: 1,
  description:
    "DD-11 — this node's own pin onto one immutable version of that template. Absent means the node follows the template's approved version.",
});

const PROMPT_BINDING_PROPERTIES = Object.freeze({
  promptTemplateId: PROMPT_TEMPLATE_ID_PROPERTY,
  promptVersionNumber: PROMPT_VERSION_NUMBER_PROPERTY,
});

/**
 * DD-2's DOCUMENT-SHAPE binding, as two config keys on the generation node that carries it.
 *
 * DD-2 is "no runtime shape switching": a generation node binds ONE document shape STATICALLY,
 * here, and it is frozen for the session — there is no selector node, no runtime classification
 * and no eligibility set. `documentTemplateId` says WHICH `DocumentTemplate`;
 * `documentVersionNumber` is that node's own movable PIN onto one IMMUTABLE version of it.
 *
 * The pin is the same mechanism DD-11 uses for prompts, protecting a DIFFERENT thing: the prompt
 * pin stops a shared template silently re-prompting every workflow; this one stops a republished
 * `DocumentTemplate` silently RESTRUCTURING the clinical document a published workflow already
 * produces. Both bounds match the compiled artifact's `versionNumber` (`minimum: 1` on the
 * normative `compiled-config.schema.json`, `ge=1` on both pydantic models) — a pin authorable
 * here that those reject would be a pin the interpreter cannot honour.
 *
 * Declared as one shared frozen object for the same reason `PROMPT_BINDING_PROPERTIES` is: every
 * schema in this module is `additionalProperties: false` AND the Studio inspector builds its form
 * from `Object.entries(schema.properties)` alone, so an UNDECLARED key is stripped twice over and
 * a node round-tripped through the authoring UI comes back with no shape bound at all.
 *
 * Deliberately NOT in any schema's `required`, exactly like the prompt binding: making it
 * required here would invalidate every graph already published without one.
 */
const DOCUMENT_TEMPLATE_ID_PROPERTY = Object.freeze({
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  description: 'DD-2 — the document template whose compiled shape this node produces.',
});

const DOCUMENT_VERSION_NUMBER_PROPERTY = Object.freeze({
  type: 'integer',
  minimum: 1,
  description:
    "DD-2 — this node's own pin onto one immutable version of that document template. Absent means the node follows the template's current pin.",
});

const DOCUMENT_BINDING_PROPERTIES = Object.freeze({
  documentTemplateId: DOCUMENT_TEMPLATE_ID_PROPERTY,
  documentVersionNumber: DOCUMENT_VERSION_NUMBER_PROPERTY,
});

const PROMPT_TEMPLATE_REF_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/prompt.template_ref.schema.json',
  title: 'prompt.template_ref node config (N-2, safety class: optional)',
  type: 'object',
  additionalProperties: false,
  required: ['promptTemplateId'],
  properties: {
    ...PROMPT_BINDING_PROPERTIES,
    variableBindings: { type: 'object', additionalProperties: { type: 'string', maxLength: 4000 } },
  },
});

const GENERATE_TEXT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/generate.text.schema.json',
  title: 'generate.text node config (N-3, safety class: mandatory, critical)',
  type: 'object',
  additionalProperties: false,
  required: ['taskKey'],
  properties: {
    taskKey: { type: 'string', enum: ['text.finalize', 'text.live', 'text.test'] },
    ...PROMPT_BINDING_PROPERTIES,
    ...DOCUMENT_BINDING_PROPERTIES,
    systemPrompt: { type: 'string', maxLength: 50000 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    maxTokens: { type: 'integer', minimum: 1 },
    topP: { type: 'number', minimum: 0, maximum: 1 },
    responseFormat: { type: 'string', enum: ['text', 'json', 'json_schema'] },
    onError: { type: 'string', enum: ['fail', 'degrade'] },
  },
});

const GUARDRAIL_CHECK_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/guardrail.check.schema.json',
  title: 'guardrail.check node config (N-4, safety class: mandatory, non-removable)',
  type: 'object',
  additionalProperties: false,
  required: ['guardrailType', 'failOn', 'onFail'],
  properties: {
    guardrailType: { type: 'string', minLength: 1, maxLength: 64 },
    failOn: { type: 'string', enum: ['unsafe_or_unknown'], default: 'unsafe_or_unknown' },
    // `abort` is DELIBERATELY not offered (TASK-791 W4, closing TASK-789's M-1). The shipped v1
    // interpreter has no mechanism for a per-node CONFIG value to override a CODE-OWNED registry
    // property: `critical` lives on `NODE_REGISTRY` (`guardrail.check` is `critical: false`) and
    // `NodeActivityResult.status` is `Literal['SUCCEEDED','DEGRADED','SKIPPED']` — an activity
    // cannot return `FAILED`, and only the workflow body promotes a degraded CRITICAL node to a
    // run-level failure. So a tenant authoring `onFail: 'abort'` previously got SILENT
    // NON-ENFORCEMENT: the value validated, was recorded on the trajectory, and gated nothing —
    // while the tenant believed they had made that run's guardrail failure fatal. Rejecting the
    // value at authoring time is the honest half of "enforce it or reject it"; same posture as
    // `failOn` above, which is likewise pinned to its one v1-permitted value. Restore `abort`
    // only together with a real promotion mechanism.
    onFail: { type: 'string', enum: ['mark'] },
  },
});

const OUTPUT_DELIVER_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/output.deliver.schema.json',
  title: 'output.deliver node config (N-5, safety class: mandatory)',
  type: 'object',
  additionalProperties: false,
  required: ['outputs'],
  properties: {
    outputs: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'primitive'],
        properties: {
          key: { type: 'string', pattern: '^[a-z0-9_]{2,48}$' },
          label: { type: 'string', maxLength: 200 },
          description: { type: 'string', maxLength: 2000 },
          primitive: { type: 'string', enum: ['TEXT', 'STRUCTURED'] },
        },
      },
    },
  },
});

// -----------------------------------------------------------------------------------------
// STT palette (TASK-724) — copied verbatim from `contracts/nodes/*.schema.json`.
// -----------------------------------------------------------------------------------------
const STT_AUDIO_INPUT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/stt.audioInput.schema.json',
  title: 'stt.audioInput node config (mandatory)',
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['realtime', 'batch'] },
    mediaId: { type: 'string', minLength: 1, maxLength: 128 },
    audioUri: { type: 'string', minLength: 1, maxLength: 2048 },
  },
});

const STT_VAD_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/stt.vad.schema.json',
  title: 'stt.vad node config (optional)',
  type: 'object',
  additionalProperties: false,
  properties: { modelSlug: { type: 'string', minLength: 1, maxLength: 100 } },
});

const STT_NOISE_FILTER_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/stt.noiseFilter.schema.json',
  title: 'stt.noiseFilter node config (optional)',
  type: 'object',
  additionalProperties: false,
  properties: { modelSlug: { type: 'string', minLength: 1, maxLength: 100 } },
});

const STT_DIARIZATION_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/stt.diarization.schema.json',
  title: 'stt.diarization node config (optional)',
  type: 'object',
  additionalProperties: false,
  properties: {
    modelSlug: { type: 'string', minLength: 1, maxLength: 100 },
    embeddingModelSlug: { type: 'string', minLength: 1, maxLength: 100 },
  },
});

const STT_LANGUAGE_DETECTION_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/stt.languageDetection.schema.json',
  title: 'stt.languageDetection node config (optional)',
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['single', 'code_switch', 'auto'] },
    languageModeId: { type: 'string', enum: ['en', 'ml', 'ml-en', 'vi', 'vi-en', 'auto'] },
  },
});

const STT_ASR_ENGINE_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/stt.asrEngine.schema.json',
  title: 'stt.asrEngine node config (mandatory)',
  type: 'object',
  additionalProperties: false,
  required: ['modelSlug'],
  properties: {
    modelSlug: { type: 'string', minLength: 1, maxLength: 100 },
    onError: { type: 'string', enum: ['fail', 'degrade'] },
  },
});

const STT_TRANSCRIPT_OUTPUT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/stt.transcriptOutput.schema.json',
  title: 'stt.transcriptOutput node config (mandatory)',
  type: 'object',
  additionalProperties: false,
  properties: {},
});

const STT_PHI_HOP_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/stt.phiHop.schema.json',
  title: 'stt.phiHop node config (optional guardrail redaction — PLACEHOLDER, TASK-710 not landed)',
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: { mode: { type: 'string', enum: ['pseudonymize', 'full-redact'] } },
});

// -----------------------------------------------------------------------------------------
// Palette-agnostic utility/marker nodes — no committed schema document; read directly off
// the interpreter activity (`activities.py`, cited in this module's docstring).
// -----------------------------------------------------------------------------------------
const NOOP_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'noop node config (test/smoke-test utility, all fields optional)',
  description:
    'Mirrors interpreter_noop (activities.py): accepts raise_error to exercise the DEGRADED path and sleep_seconds to hold the node in flight, both test conveniences rather than business config.',
  type: 'object',
  additionalProperties: false,
  properties: {
    raise_error: { type: 'boolean' },
    sleep_seconds: { type: 'number', minimum: 0 },
  },
});

/** `core.start`/`core.end` execute nothing and read no config (activities.py) — the schema
 *  says so explicitly rather than leaving the node's config an unexplained "no schema known". */
const BOUNDARY_MARKER_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'boundary marker node config (none — the node executes nothing)',
  type: 'object',
  additionalProperties: false,
  properties: {},
});

// -----------------------------------------------------------------------------------------
// Consultation palette (TASK-731 + TASK-791) — sixteen node types, authored by TASK-809 Task 9
// to close D-9.
//
// D-9 is recorded as "13 of 16 `consultation.*` node types have no config schema". The true
// count is SIXTEEN of sixteen: the "13" figure predates TASK-791, which added
// `realtimeSummary`, `suggestions` and `proposeCorrections`. This module's own docstring above
// still says "`consultation.*` (13 node types)" for the same reason — it was written before
// those three existed.
//
// `node-types.md` §"Config schemas" named `contracts/nodes/*.schema.json` files for this
// palette and they were never authored, which is why the previous pass declined to invent them.
// They are NOT invented here either: every field below comes from one of two sources that
// already exist and are already enforced, and `__tests__/node-config-schemas.test.ts` asserts
// against both.
//
//   1. `DRAFT_CONSULTATION_RULE_SET` (`rule-catalogue.ts`) — the config fields a published
//      consultation graph is ALREADY required to carry: `occ` (WF-CONS-014), `producesCode`
//      (WF-CONS-015), `purposeScope` (WF-CONS-013), `unmappedOutputKey` (WF-CONS-016),
//      `requiresFinalized` (WF-CONS-017/018) and `onError` on every activity-classed node
//      (WF-CONS-019). A schema omitting any of them would reject graphs the validator demands.
//   2. The interpreter activities — every key each one actually reads off `payload.config`
//      (`apps/harness/src/harness/temporal/interpreter/nodes/consultation*.py`). A schema
//      omitting any of them would reject config the runtime honours.
//
// Two conventions carried from the schemas above rather than reinvented:
//
//   - `onError` is `['degrade', 'retry', 'fail']` — WF-CONS-019's own permitted set, and
//     NOTABLY not `abort`. Same posture as `guardrail.check.onFail`: the v1 interpreter cannot
//     promote a node failure to a run-level abort (`NodeActivityResult.status` has no `FAILED`),
//     so offering the value would be silent non-enforcement. Reject at authoring time instead.
//   - Neither GATE node (`consentGate`, `hitlGate`) declares `onError`. They are the two nodes
//     that are not `activity`-classed, so WF-CONS-019 never fires for them and requiring an error
//     policy would be a constraint nothing enforces. NOTE: `consentGate` takes no config at all,
//     but `hitlGate` DOES — `compileGate` reads four fields off it (see its schema below).
// -----------------------------------------------------------------------------------------

/** WF-CONS-019's permitted error policies, verbatim. Shared so the rule and the schemas cannot
 *  drift apart silently. */
const CONSULTATION_ON_ERROR = Object.freeze({
  type: 'string',
  enum: Object.freeze(['degrade', 'retry', 'fail']),
  description: 'Node error policy (WF-CONS-019). `abort` is deliberately not offered — the v1 interpreter cannot enforce it.',
});

/** `consultation.consentGate` — its activity reads no `payload.config`
 *  (`nodes/consultation.py:44`), and unlike `hitlGate` it does NOT carry the `gate` class, so the
 *  compiler routes it through `compileNode` rather than `compileGate` and it has no gate config
 *  either. (`compileNode` does read the palette-agnostic `timeoutSeconds`/`retry`/`onError` off
 *  every node — see the ADDENDUM at the foot of this module; that gap is uniform across all 33
 *  node types and is deliberately not patched here one node at a time.) */
const CONSULTATION_CONSENT_GATE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.consentGate node config (none — the gate reads no config)',
  type: 'object',
  additionalProperties: false,
  properties: {},
});

/**
 * `consultation.hitlGate` — the ONE node in the registry carrying the `gate` class, which is
 * what makes its config surface unique.
 *
 * Its ACTIVITY reads no config. Its real consumer is the TYPESCRIPT COMPILER: `compileGate`
 * (`compiler.ts:153-166`) lifts a `gate`-classed node out of `stages` into `gates` and reads
 * four fields straight off `node.config` — `gateType`, `blocking`, `timeoutSeconds`,
 * `onTimeout`. Declaring `{}` here (as the first pass did) told the Studio inspector this node
 * takes no configuration, so an admin could not author the blocking/timeout behaviour of the
 * platform's only durable human wait even though the compiler honours it.
 *
 * `onError` is absent on purpose: `compileGate` never reads it, and `hitlGate` is not
 * `activity`-classed, so WF-CONS-019 does not apply.
 */
const CONSULTATION_HITL_GATE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.hitlGate node config (N-13, the one durable human wait — consumed by compileGate, not by the activity)',
  type: 'object',
  additionalProperties: false,
  properties: {
    gateType: { type: 'string', minLength: 1, maxLength: 64, description: 'Defaults to the node type when unset (compiler.ts:158).' },
    blocking: { type: 'boolean', default: true, description: 'Anything other than an explicit `false` blocks (compiler.ts:159).' },
    timeoutSeconds: { type: 'integer', minimum: 1, description: 'Clamped to the compiled caps; defaults to `caps.maxNodeSeconds`.' },
    onTimeout: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      // compiler.ts:161-164 states the invariant: a timeout ALWAYS resolves to a non-approval
      // outcome. No enum is declared because the compiler accepts any string and defaults to
      // 'TIMED_OUT'; pinning a taxonomy here would be a new design decision, not a wiring-up.
      description: 'Outcome recorded when the wait times out; defaults to TIMED_OUT. Never a value meaning "approved" (INV-001/INV-147/INV-181).',
    },
  },
});

const CONSULTATION_CAPTURE_BINDING_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.captureBinding node config (N-2, safety class: mandatory)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    action: { type: 'string', minLength: 1, maxLength: 64, description: 'Capture action to bind (`payload.config["action"]`).' },
    persistSnapshot: { type: 'boolean', default: true, description: 'Persist a capture snapshot alongside the binding.' },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_EXTRACT_ENTITIES_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.extractEntities node config (N-3, the NER node)',
  type: 'object',
  additionalProperties: false,
  // `requiresFinalized` is REQUIRED by WF-CONS-017, which additionally pins it to `true`. The
  // schema governs SHAPE and the rule governs VALUE — keeping the split is why a golden `fail`
  // fixture authoring `false` still parses and then fails on the rule it was written to exercise.
  required: ['requiresFinalized', 'onError'],
  properties: {
    requiresFinalized: { type: 'boolean', description: 'WF-CONS-017 — extraction may only read a FINALIZED transcript segment.' },
    language: { type: 'string', minLength: 2, maxLength: 16, default: 'en' },
    persist: { type: 'boolean', default: true, description: 'Persist extracted entities (the node`s externalWrite leg).' },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_BIND_TERMINOLOGY_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.bindTerminology node config (N-4)',
  type: 'object',
  additionalProperties: false,
  required: ['purposeScope', 'unmappedOutputKey', 'onError'],
  properties: {
    // DELIBERATELY UNCONSTRAINED beyond "a non-empty string". `purposeScope` is required by
    // WF-CONS-013 (`op: 'present'` — presence only, no value check) and is read NOWHERE in
    // `consultation_nlp.py`: no activity, no client, no validator consumes its VALUE. The only
    // sample in the tree is the seed's `'terminology.validate'`
    // (`seed/23-arcaai-workflow-authoring.ts:139`), which is one data point, not a taxonomy.
    // An enum, a pattern or even a length ceiling invented here would be a NEW design decision
    // wearing a schema's clothes, and would silently reject purposes nobody has thought of yet.
    // ⚠ OPEN OWNER DECISION: what vocabulary `purposeScope` draws from is unresolved.
    purposeScope: {
      type: 'string',
      minLength: 1,
      description:
        'WF-CONS-013 — the declared purpose the code binding is scoped to. Taxonomy is an open owner decision; presence is all that is enforced.',
    },
    unmappedOutputKey: {
      type: 'string',
      pattern: '^[a-z0-9_]{2,48}$',
      description:
        'WF-CONS-016 — where terms that bound to NO code are surfaced. An unmapped term that is silently dropped is an unmapped term nobody reviews.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_PHI_HOP_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.phiHop node config (N-5, safety class: mandatory, redaction)',
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'onError'],
  properties: {
    // ⚠ DELIBERATELY DIFFERENT from `stt.phiHop`, which is `['pseudonymize', 'full-redact']`.
    // DO NOT "harmonise" these two enums — they are not the same vocabulary, and the difference
    // is load-bearing. The consultation activity guards on its own two values:
    //
    //   `nodes/consultation.py:102`  ->  `if mode not in ("pseudonymize", "full"):`
    //   `nodes/consultation.py:107`  ->  DEGRADEs with "config.mode {mode!r} is not
    //                                     'pseudonymize' or 'full'"
    //   `nodes/consultation.py:92`   ->  docstring: "the same two-mode vocabulary
    //                                     `IPhiRedactor.redact()` uses on the gateway side"
    //
    // This schema drives the Studio inspector, so declaring `full-redact` here offered an admin
    // a value that DEGRADES at runtime while hiding `full`, the only one that actually redacts —
    // a PHI-redaction node silently not redacting is the worst possible shape for this defect.
    mode: { type: 'string', enum: ['pseudonymize', 'full'] },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_RETRIEVE_EVIDENCE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.retrieveEvidence node config (N-6)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    retrievalEnabled: {
      type: 'boolean',
      description: 'Whether evidence retrieval runs at all; false makes the node an observable no-op rather than a silent one.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_ASSEMBLE_PROMPT_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.assemblePrompt node config (N-7)',
  type: 'object',
  additionalProperties: false,
  required: ['requiresFinalized', 'onError'],
  properties: {
    requiresFinalized: { type: 'boolean', description: 'WF-CONS-018 — the prompt may only be assembled from FINALIZED material.' },
    // The prompt-assembly node is the one most likely to reference a MANAGED template rather
    // than the inline `template` string below, so it must be able to carry — and keep — a pin.
    ...PROMPT_BINDING_PROPERTIES,
    template: { type: 'string', maxLength: 50000 },
    dnaStyleId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    conversationLanguage: { type: 'string', minLength: 2, maxLength: 16 },
    onError: CONSULTATION_ON_ERROR,
  },
});

/**
 * `interpreter_consultation_synthesize` is `return await interpreter_text_generate(payload)` —
 * verbatim delegation to the summarization palette's N-3 (`consultation_compose.py:151-200`,
 * which states the reason: one generation engine, not a second copy). Its config surface is
 * therefore `generate.text`'s, plus `producesCode`.
 */
const CONSULTATION_SYNTHESIZE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.synthesize node config (N-8, generation)',
  type: 'object',
  additionalProperties: false,
  required: ['producesCode', 'onError'],
  properties: {
    producesCode: {
      type: 'boolean',
      description:
        'WF-CONS-015 pins this to false — the synthesizer drafts prose. Code binding belongs to consultation.bindTerminology, against a terminology server, not to a language model recalling codes.',
    },
    taskKey: { type: 'string', enum: ['text.finalize', 'text.live', 'text.test'] },
    ...PROMPT_BINDING_PROPERTIES,
    ...DOCUMENT_BINDING_PROPERTIES,
    systemPrompt: { type: 'string', maxLength: 50000 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    maxTokens: { type: 'integer', minimum: 1 },
    topP: { type: 'number', minimum: 0, maximum: 1 },
    responseFormat: { type: 'string', enum: ['text', 'json', 'json_schema'] },
    onError: CONSULTATION_ON_ERROR,
  },
});

/** `consultation.sensors` (deterministic) and `consultation.inferentialSensors` (LLM judge).
 *  Neither activity reads `payload.config` beyond the palette-wide error policy — model and
 *  provider selection is `AiTaskDefault`'s, resolved tenant → SYSTEM, never a node literal
 *  (`consultation_verify.py`'s own docstring makes that explicit). */
const CONSULTATION_SENSORS_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation sensor node config (N-9/N-10 — verification, provider/model resolved by AiTaskDefault)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: { onError: CONSULTATION_ON_ERROR },
});

const CONSULTATION_PERSIST_DRAFT_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.persistDraft node config (N-11, safety class: mandatory, externalWrite)',
  type: 'object',
  additionalProperties: false,
  required: ['occ', 'onError'],
  properties: {
    occ: {
      type: 'boolean',
      description:
        'WF-CONS-014 pins this to true — optimistic concurrency on the draft write is the TASK-709 authorship protection made structural. Without it a background write silently overwrites an in-flight clinician edit.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_FINALIZE_ASSURANCE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.finalizeAssurance node config (N-12, safety class: mandatory, externalWrite)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: { onError: CONSULTATION_ON_ERROR },
});

// -----------------------------------------------------------------------------------------
// TASK-791 W1-W3 — the three live-assist nodes. All three call a language model through
// `apps/text`, so all three expose the same generation knobs; provider and model themselves are
// NEVER node config (tenant → SYSTEM `AiTaskDefault` selection, fail-closed).
//
// `responseFormat` is typed as the same string enum the committed `generate.text` schema uses.
// The activities additionally accept a full json-schema OBJECT and fall back to the code-owned
// `SOAP_RESPONSE_FORMAT` (`nodes/_soap.py:76`) when unset — an arbitrary object is not
// expressible in the authorable subset, and the SOAP shape is code-owned rather than tenant
// business, so the enum is the honest authorable surface and the default keeps working.
// -----------------------------------------------------------------------------------------
/**
 * §SEED NOTE — the committed seed carries a DEAD `publishTo` this schema deliberately omits.
 *
 * `seed/23-arcaai-workflow-authoring.ts:134` authors
 * `{ publishTo: 'live-summary', onError: 'degrade' }` on the `n_realtime` node. Nothing reads
 * `publishTo`: `grep -rn "publishTo" apps/harness packages/workflow-contract` returns nothing.
 * The activity publishes to a FIXED channel (`consultation:live-summary:{id}`), not a
 * configurable one, so the key is decorative — it describes a capability the runtime does not
 * have.
 *
 * It is deliberately NOT declared here. `additionalProperties: false` plus an undeclared key is
 * the honest statement that the field does nothing; adding it to keep the seed "valid" would
 * document a knob that silently gates nothing, which is the same mistake as
 * `guardrail.check.onFail: 'abort'`.
 *
 * This is LATENT, not live: `configSchema` is never enforced during validation or publish — its
 * only consumer is `workflow-definition.dto.mapper.ts:86`, which surfaces it to the UI. So the
 * seed keeps working today. **The seed-migration lane must DROP `publishTo` from that node**
 * (alongside the port rewrite described in `node-ports.ts` §MIGRATION NOTE), rather than this
 * schema being loosened to accommodate it.
 */
const CONSULTATION_REALTIME_SUMMARY_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.realtimeSummary node config (W1, generation, externalWrite — publishes to the live feed)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    taskKey: { type: 'string', enum: ['text.finalize', 'text.live', 'text.test'], default: 'text.live' },
    ...PROMPT_BINDING_PROPERTIES,
    ...DOCUMENT_BINDING_PROPERTIES,
    windowChars: { type: 'integer', minimum: 1, description: 'How much of the tail of the running transcript each interim summary reads.' },
    systemPrompt: { type: 'string', maxLength: 50000 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    maxTokens: { type: 'integer', minimum: 1 },
    responseFormat: { type: 'string', enum: ['text', 'json', 'json_schema'] },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_SUGGESTIONS_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.suggestions node config (W2, generation — a PROPOSAL surface, writes nothing)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    taskKey: { type: 'string', enum: ['text.finalize', 'text.live', 'text.test'], default: 'text.live' },
    ...PROMPT_BINDING_PROPERTIES,
    ...DOCUMENT_BINDING_PROPERTIES,
    maxSuggestions: {
      type: 'integer',
      minimum: 0,
      description: 'Upper bound on suggestions returned per turn; 0 disables the surface without removing the node.',
    },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    maxTokens: { type: 'integer', minimum: 1 },
    responseFormat: { type: 'string', enum: ['text', 'json', 'json_schema'] },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_PROPOSE_CORRECTIONS_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.proposeCorrections node config (W3, generation — PROPOSES corrections, never applies them)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    taskKey: { type: 'string', enum: ['text.finalize', 'text.live', 'text.test'], default: 'text.live' },
    ...PROMPT_BINDING_PROPERTIES,
    ...DOCUMENT_BINDING_PROPERTIES,
    language: { type: 'string', minLength: 2, maxLength: 16, default: 'en' },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    maxTokens: { type: 'integer', minimum: 1 },
    responseFormat: { type: 'string', enum: ['text', 'json', 'json_schema'] },
    onError: CONSULTATION_ON_ERROR,
  },
});

/**
 * Node-type key -> config JSON Schema. A key ABSENT from this map means no schema has been
 * authored for that node type yet (`WORKFLOW_NODE_REGISTRY[key].configSchema` stays
 * `undefined`) — a real, structural, always-possible state (see this module's docstring),
 * not an omission to fix here.
 */
export const NODE_CONFIG_SCHEMAS: Readonly<Record<string, NodeConfigSchema>> = Object.freeze({
  noop: NOOP_SCHEMA,
  'core.start': BOUNDARY_MARKER_SCHEMA,
  'core.end': BOUNDARY_MARKER_SCHEMA,
  'input.context_binding': INPUT_CONTEXT_BINDING_SCHEMA,
  'prompt.template_ref': PROMPT_TEMPLATE_REF_SCHEMA,
  'generate.text': GENERATE_TEXT_SCHEMA,
  'guardrail.check': GUARDRAIL_CHECK_SCHEMA,
  'output.deliver': OUTPUT_DELIVER_SCHEMA,
  'stt.audioInput': STT_AUDIO_INPUT_SCHEMA,
  'stt.vad': STT_VAD_SCHEMA,
  'stt.noiseFilter': STT_NOISE_FILTER_SCHEMA,
  'stt.diarization': STT_DIARIZATION_SCHEMA,
  'stt.languageDetection': STT_LANGUAGE_DETECTION_SCHEMA,
  'stt.asrEngine': STT_ASR_ENGINE_SCHEMA,
  'stt.transcriptOutput': STT_TRANSCRIPT_OUTPUT_SCHEMA,
  'stt.phiHop': STT_PHI_HOP_SCHEMA,
  // Consultation palette (TASK-809 Task 9, closing D-9) — ordered by pipeline position, the
  // same order `node-registry.ts` uses, so the two files read as the same pipeline.
  'consultation.consentGate': CONSULTATION_CONSENT_GATE_SCHEMA,
  'consultation.captureBinding': CONSULTATION_CAPTURE_BINDING_SCHEMA,
  'consultation.extractEntities': CONSULTATION_EXTRACT_ENTITIES_SCHEMA,
  'consultation.bindTerminology': CONSULTATION_BIND_TERMINOLOGY_SCHEMA,
  'consultation.phiHop': CONSULTATION_PHI_HOP_SCHEMA,
  'consultation.retrieveEvidence': CONSULTATION_RETRIEVE_EVIDENCE_SCHEMA,
  'consultation.assemblePrompt': CONSULTATION_ASSEMBLE_PROMPT_SCHEMA,
  'consultation.synthesize': CONSULTATION_SYNTHESIZE_SCHEMA,
  'consultation.sensors': CONSULTATION_SENSORS_SCHEMA,
  'consultation.inferentialSensors': CONSULTATION_SENSORS_SCHEMA,
  'consultation.persistDraft': CONSULTATION_PERSIST_DRAFT_SCHEMA,
  'consultation.finalizeAssurance': CONSULTATION_FINALIZE_ASSURANCE_SCHEMA,
  'consultation.hitlGate': CONSULTATION_HITL_GATE_SCHEMA,
  'consultation.realtimeSummary': CONSULTATION_REALTIME_SUMMARY_SCHEMA,
  'consultation.suggestions': CONSULTATION_SUGGESTIONS_SCHEMA,
  'consultation.proposeCorrections': CONSULTATION_PROPOSE_CORRECTIONS_SCHEMA,
});
