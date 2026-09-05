/**
 * `NODE_CONFIG_SCHEMAS` — the per-node-type config JSON Schema (authorable subset,
 * `@arcaai/json-schema-subset`), the piece `node-registry.ts`'s own docstring and
 * both
 * recorded as a real, structural gap: "no delivered node-type descriptor carries a config
 * schema… `WorkflowNodeDescriptor` in `node-registry.ts` likewise carries no schema field."
 *
 * `registry.contract.md`'s own resolution path ("Where does a per-node config schema come
 * from, going forward?") named option 1: " adds a `configSchema` field to
 * `WorkflowNodeDescriptor`/`WorkflowNodeResponse` when it adds real palette node types." That
 * field never landed even after /724/731/734 added the real node types — this module
 * closes exactly that gap, sourcing each schema from the CONTRACT DOCUMENT already committed
 * for it rather than inventing one:
 *
 * Summarization palette (5):
 *   nodes/*.schema.json` — copied verbatim.
 * STT palette (8): *.schema.json`
 *   — copied verbatim.
 * - `noop`/`core.start`/`core.end`: no committed schema document exists, but the ACTUAL
 *   accepted config is small and readable straight off the interpreter activity
 *   (`apps/harness/src/harness/temporal/interpreter/activities.py`) — `interpreter_noop`
 *   reads `config["raise_error"]`/`config["sleep_seconds"]` and nothing else; `core_start`/
 *   `core_end` read no config at all.
 *
 * Consultation palette (16): authored by to close D-9. `node-types.md` named
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

/** Summarization palette — copied verbatim from `contracts/nodes/*.schema.json`. */
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

/**
 * OD-11's EVAL GATE, as one config key on the node that references the template.
 *
 * The gate runs a golden-set eval when a bound prompt template is approved (or
 * its pin re-pointed) and, in `block` mode, refuses the promotion on failure.
 * It used to be discovered through `DepartmentAgent.goldenSetId`; binds
 * it to the NODE that references the template instead, which is the only place
 * the binding is still meaningful once the agent row is gone.
 *
 * It lives in node CONFIG rather than on `WorkflowNodeDescriptor` (which also
 * declares an `evalGate`, added by) because the two answer different
 * questions. A descriptor is one code-owned constant shared by every tenant: it
 * can say "this node TYPE ships with a platform default gate" and nothing more.
 * `goldenSetId` names a row in ONE tenant's data, and OD-11 requires a per-tenant
 * enable/disable — neither of which a shared constant can hold. So the descriptor
 * field is the type-level default and this is the instance-level binding that
 * overrides it; `EvalPromotionGateService` reads instance-first.
 *
 * BOTH sub-fields are `required` on purpose. A gate with no `goldenSetId` gates
 * nothing (the same rule `nodeDescriptorContractProblems` enforces on the
 * descriptor), and a gate with no `enabled` would make a safety control's state
 * a matter of interpretation — disabling it must be an explicit act, which is
 * exactly what OD-11 says.
 *
 * Declared as one shared frozen object, and attached wherever the prompt binding
 * is, for the reason `PROMPT_BINDING_PROPERTIES` gives: every schema here is
 * `additionalProperties: false` and the Studio inspector renders a field per
 * DECLARED property, so an undeclared key is stripped twice over and a node
 * round-tripped through the authoring UI would come back with its gate silently
 * removed.
 */
const EVAL_GATE_PROPERTY = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['goldenSetId', 'enabled'],
  properties: {
    goldenSetId: {
      type: 'string',
      minLength: 1,
      description: 'OD-11 — the golden set this node’s prompt promotions are evaluated against.',
    },
    enabled: {
      type: 'boolean',
      description:
        'OD-11 — the tenant-admin toggle. Disabled means an approval proceeds with a recorded warning, exactly as "no golden set" always did.',
    },
  },
  description: 'OD-11 — the eval gate on this node’s bound prompt template.',
});

const PROMPT_BINDING_PROPERTIES = Object.freeze({
  promptTemplateId: PROMPT_TEMPLATE_ID_PROPERTY,
  promptVersionNumber: PROMPT_VERSION_NUMBER_PROPERTY,
  evalGate: EVAL_GATE_PROPERTY,
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
    // `abort` is DELIBERATELY not offered (closing). The shipped v1
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
// STT palette — copied verbatim from `contracts/nodes/*.schema.json`.
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
  title: 'stt.phiHop node config (optional guardrail redaction — PLACEHOLDER, not landed)',
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
// Consultation palette ( +) — sixteen node types, authored by
// to close D-9.
//
// D-9 is recorded as "13 of 16 `consultation.*` node types have no config schema". The true
// count is SIXTEEN of sixteen: the "13" figure predates, which added
// `realtimeSummary`, `suggestions` and `proposeCorrections`. This module's own docstring above
// still says "`consultation.*` (13 node types)" for the same reason — it was written before
// those three existed.
//
// `node-types.md` named `contracts/nodes/*.schema.json` files for this
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

/**
 * WF-CONS-013's `purposeScope` taxonomy (lane A, item 19).
 *
 * ## Why these values and not an invented vocabulary
 *
 * CR-03 states the rule in its own words: *"Every node performing a tool/MCP call MUST declare a
 * purpose scope in its config"*. So `purposeScope` names the PURPOSE OF USE of an outbound call,
 * not a property of the codes that come back — and this platform already has a ratified
 * purpose-of-use vocabulary for exactly that: `ConsentPurpose`
 * (`packages/database/src/prisma/db_main/enums.prisma`, consent-abac). WF-CONS-013's own
 * invariant list cites **INV-007**, which is the same invariant `ConsentPurpose.EXTERNAL_TOOL_LOOKUP`
 * cites — the two are the same concept seen from two sides.
 *
 * The correspondence is not theoretical. `consultation.bindTerminology`'s activity calls
 * `call_mcp_tool`, which performs a consent check with `purpose="EXTERNAL_TOOL_LOOKUP"`
 * (`apps/harness/src/harness/temporal/activities.py:1092`) — a HARDCODED literal today. Declaring
 * the config taxonomy over the same enum is what makes it possible for that literal to become
 * `config.purposeScope` instead, which is the direction `00-project-context.md` §Configuration
 * Principles requires ("a label taxonomy is NOT a literal in code").
 *
 * ## Which members, and which are deliberately absent
 *
 * | Value | Grounding |
 * |---|---|
 * | `EXTERNAL_TOOL_LOOKUP` | `activities.py:1092` — the purpose THIS node's own egress already checks. |
 * | `HISTORY_RETRIEVAL` | `activities.py:1541` — the purpose the platform's other retrieval egress checks. |
 * | `AI_DOCUMENTATION` | `enums.prisma` — "Consultation capture + AI-assisted note generation"; a bind performed purely to code the note being written. |
 * | `QUALITY_REVIEW` | `enums.prisma` — "Downstream quality/metrics review of the encounter". |
 *
 * `STYLE_LEARNING` is the one `ConsentPurpose` member deliberately EXCLUDED: it authorizes a DNA
 * writing-style opt-in, not an outbound tool call, so offering it here would let a node declare a
 * purpose under which its egress could never be granted.
 *
 * ⚠ **Proposed, pending owner confirmation.** left this "an open owner decision"; the
 * set above is derived from real usage rather than supplied, and the two values previously in the
 * tree (`terminology.validate` in the seed, `clinical-coding` in the golden fixtures) were both
 * free strings written before any taxonomy existed. Both are migrated to `EXTERNAL_TOOL_LOOKUP`,
 * which is what their egress actually asks consent for.
 */
export const TERMINOLOGY_PURPOSE_SCOPES = Object.freeze(['EXTERNAL_TOOL_LOOKUP', 'HISTORY_RETRIEVAL', 'AI_DOCUMENTATION', 'QUALITY_REVIEW'] as const);

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
    // item 19 — CLOSED. `purposeScope` now draws from `TERMINOLOGY_PURPOSE_SCOPES`
    // above, which is the `ConsentPurpose` purpose-of-use vocabulary restricted to the members
    // that can justify an outbound tool call. WF-CONS-013 still only checks PRESENCE (`op:
    // 'present'`); the enum is what makes the declared purpose comparable with the consent
    // purpose the node's own egress asks for.
    purposeScope: {
      type: 'string',
      enum: TERMINOLOGY_PURPOSE_SCOPES,
      description:
        "WF-CONS-013 — the purpose of use declared for this node's outbound terminology call. Drawn from ConsentPurpose , so it is comparable with the consent grant the egress is checked against.",
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
    //   `nodes/consultation.py:102` -> `if mode not in ("pseudonymize", "full"):`
    //   `nodes/consultation.py:107` -> DEGRADEs with "config.mode {mode!r} is not
    //                                     'pseudonymize' or 'full'"
    //   `nodes/consultation.py:92` -> docstring: "the same two-mode vocabulary
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

/**
 * TASK-882 — the re-visit CARRY-FORWARD decision, as a binding on the node that composes the
 * prompt. It replaces the platform key `agentic.revisit.carryForwardEnabled`: whether a re-visit
 * consultation carries its parent visit's most authoritative summary into the prompt is a
 * property of the workflow that generates the note, so it is authored on the graph the
 * consultation is assigned — the prompt-composition node here, `core.agent.overrides` in the
 * `core` vocabulary — and read by `ConfigResolver.resolveRevisitCarryForwardEnabled`.
 *
 * DEFAULT OFF, and that is a clinical-safety decision rather than caution about the plumbing:
 * carry-forward inherits the copy-paste / cloned-note risk profile (stale or unverified content
 * propagating into a new encounter), so it must be an explicit opt-in per graph.
 */
const CARRY_FORWARD_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'boolean',
  default: false,
  description:
    "Re-visit carry-forward. When true, a consultation with a parent visit carries the parent's most authoritative summary into this prompt as a labeled, non-authoritative prior that must be re-confirmed against the current transcript. Absent is OFF.",
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
    carryForward: CARRY_FORWARD_PROPERTY,
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
 *  provider selection is `AiRoutingPolicy`'s (SYSTEM default row), never a node literal
 *  (`consultation_verify.py`'s own docstring makes that explicit). */
const CONSULTATION_SENSORS_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation sensor node config (N-9/N-10 — verification, provider/model resolved by AiRoutingPolicy)',
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
        'WF-CONS-014 pins this to true — optimistic concurrency on the draft write is the  authorship protection made structural. Without it a background write silently overwrites an in-flight clinician edit.',
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
// W3 — the three live-assist nodes. All three call a language model through
// `apps/text`, so all three expose the same generation knobs; provider and model themselves are
// NEVER node config (SYSTEM `AiRoutingPolicy` default selection, fail-closed).
//
// `responseFormat` is typed as the same string enum the committed `generate.text` schema uses.
// The activities additionally accept a full json-schema OBJECT and fall back to the code-owned
// `SOAP_RESPONSE_FORMAT` (`nodes/_soap.py:76`) when unset — an arbitrary object is not
// expressible in the authorable subset, and the SOAP shape is code-owned rather than tenant
// business, so the enum is the honest authorable surface and the default keeps working.
// -----------------------------------------------------------------------------------------
/**
 * NOTE — the committed seed carries a DEAD `publishTo` this schema deliberately omits.
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
 * (alongside the port rewrite described in `node-ports.ts` NOTE), rather than this
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

// ---------------------------------------------------------------------------------------------
// The ENDPOINT STAGE — the five `trigger: 'on-end'` endpoint node types.
//
// Each schema is deliberately SMALL. The endpoint stage's ORDER is not authored here: since
// TASK-882 it is the EDGE ORDER of the endpoint nodes on the assigned graph (read by
// `LoopConfigService`; the platform default applies when a graph declares none), because the
// order is a property of the chain and not of any one node. What a node's config carries is
// only what THAT node does when its turn comes.
// ---------------------------------------------------------------------------------------------

const SESSION_TIMEOUT_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'session.timeout node config (the endpoint stage owns the idle bound)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    idleTimeoutSeconds: {
      type: 'integer',
      minimum: 0,
      description:
        'Idle SILENCE the loop tolerates before the endpoint sequence runs, in seconds. 0 disables the bound. Absent ⇒ the platform value (`harness.loop.idleTimeoutSeconds`). Every arriving context item restarts it, so this measures silence, not consultation length.',
    },
    runEndpointOnExpiry: {
      type: 'boolean',
      default: true,
      description:
        'Whether expiry runs the rest of the endpoint sequence. Defaults TRUE and should stay true: a timed-out consultation that never finalizes silently loses the encounter (D-12). Set false only to reproduce the pre-existing abandon-on-expiry behaviour.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const SUMMARY_FINALIZE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'summary.finalize node config (DD-3 — locks EVERY document, not just the SOAP note)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    // There is deliberately NO `documentKey` / `documentKeys` property. DD-3 is that finalize
    // locks every document of the consultation; a per-node document selector would be the exact
    // defect it closes — a finalize that locks only the SOAP note leaves a discharge summary
    // editable after signature.
    lockConfirmedOnly: {
      type: 'boolean',
      default: false,
      description:
        'When true, only CONFIRMED sections are locked and PROVISIONAL ones are left writable. Defaults FALSE: a signed encounter freezes whole, including the machine-written sections nobody edited.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const FEEDBACK_CAPTURE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'feedback.capture node config (DD-8 — the ONLY advisory-correction promotion path)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    promoteCorrections: {
      type: 'boolean',
      default: true,
      description:
        'Whether an ACCEPTED advisory correction is promoted onto the transcript. This node is the only path that can (DD-8); turning it off does not move the promotion elsewhere, it removes it.',
    },
    minConfidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Proposals below this confidence are never offered for promotion, even if the payload names them.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

/**
 * TASK-882 — the two endpoint stages that had no node type. `livedoc.stop` closes the live
 * audio session (`persistSnapshot` mirrors the loop's own stop); `harness.finalize` is the
 * position of note generation in the stage — inside an interpreter run it is an ordering marker
 * (the graph IS the document workflow), so it carries nothing but the shared `onError`.
 */
const LIVEDOC_STOP_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'livedoc.stop node config (the endpoint stage closes the live session first)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    persistSnapshot: {
      type: 'boolean',
      default: true,
      description: 'Whether stopping persists the final live snapshot. Defaults TRUE, matching the loop`s own stop.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const HARNESS_FINALIZE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'harness.finalize node config (the position of note generation in the endpoint stage)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    onError: CONSULTATION_ON_ERROR,
  },
});

// -----------------------------------------------------------------------------------------
// The TARGET CATALOGUE (/DD-9) and the guards — lane A.
//
// Nine `agent.*` entries and three `guard.*` entries. Almost every one of them REUSES the config
// schema of the engine it delegates to, exactly as `consultation.inferentialSensors` already
// reuses `consultation.sensors`' schema: DD-9's instruction is "one implementation behind them —
// do not fork the engine", and a forked SCHEMA is how a forked implementation starts. Only the
// two node types with no existing engine node carry a schema of their own, below.
// -----------------------------------------------------------------------------------------

/**
 * `agent.dna_redaction` — the DNA writing-style redaction pass, which turns from a
 * resolver flag triple into a NODE.
 *
 * The triple was `dnaRedactionEnabled` (tenant cascade) AND the doctor's `dnaStyleEnabled` opt-in
 * AND the department default agent's `dnaStylePolicy` veto. The veto retired with
 * `DepartmentAgent` and stays retired (owner ruling: "a consultation both surviving gates enable
 * IS redacted"). What remains migrates here as follows, and the split is deliberate:
 *
 *  - the TENANT gate becomes the NODE ITSELF. A tenant enables redaction by placing this node in
 *    its published graph; there is no separate boolean that can disagree with the graph.
 *  - the DOCTOR opt-in stays a doctor-scope setting, because it is a clinician's own preference
 * over their own writing style ( P-4 makes that ownership explicit). `requireDoctorOptIn`
 *    is the node's declaration of whether it honours that opt-in — default TRUE, which is the
 *    two-gate behaviour verbatim.
 */
const AGENT_DNA_REDACTION_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'agent.dna_redaction node config (§11 — the DNA-redaction pass as a node)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    requireDoctorOptIn: {
      type: 'boolean',
      default: true,
      description:
        "Whether the consulting doctor's own DNA opt-in is still required for this node to redact. TRUE reproduces the surviving two-gate behaviour exactly; FALSE makes the tenant's placement of this node sufficient.",
    },
    dnaStyleId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    onError: CONSULTATION_ON_ERROR,
  },
});

/**
 * `agent.dna_style` — TASK-882: the DNA WRITING-STYLE gate as a node.
 *
 * It replaces the tenant/department tier of the retired `pipeline.dnaStyleEnabled` toggle: a
 * tenant applies (and learns) a doctor's DNA writing style by placing this node, enabled, on its
 * consultation graph. The doctor's own opt-out is NOT on the node — it is the clinician's
 * preference over their own writing style (`UserSettings`, `dna` / `styleEnabled`), written by
 * `PUT dna-writing-styles/settings` and always honoured. The node therefore carries nothing but
 * the shared `onError`; presence + `enabled` IS the configuration.
 */
const AGENT_DNA_STYLE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'agent.dna_style node config (TASK-882 — the DNA writing-style gate as a node)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    onError: CONSULTATION_ON_ERROR,
  },
});

/**
 * `agent.important_findings` — the tenant's OWN definition of what matters, as a node.
 *
 * found no importance layer of any kind on the platform, and put the design
 * question to the owner. The answer was not a taxonomy, it was a configuration contract:
 *
 * > "'Important' information or findings will be mined/generated/extracted by agent following a
 * > set of instructions defined/declared/overwriten by tenant admin for using LLM to detect,
 * > extract, picking-up knowledge from consultation context."
 *
 * Read that as a schema and it says exactly what may and may not appear below. What MAY: a
 * binding to the tenant's instructions, and the tuning knobs a bounded LLM call needs. What may
 * NOT, and is asserted absent by `important-findings-and-grounding.task815.test.ts`: a severity
 * enum, a red-flag term list, an allergy-alert class, an importance threshold. Every one of those
 * is the platform answering the question the owner assigned to the tenant admin — and a
 * `default` on any of them would make the platform's answer the one that ships.
 *
 * `promptTemplateId` is therefore the whole capability. The instruction set is a `PromptTemplate`
 * the tenant authors, versions and approves through the governance every other governed prompt
 * goes through, and the tenant -> SYSTEM cascade is expressed the way this substrate expresses
 * every binding: the node names a template id, which may be the tenant's own or the SYSTEM
 * platform default it inherits. `evalGate` rides along with the prompt binding for the same
 * reason it does everywhere else (see `PROMPT_BINDING_PROPERTIES`).
 *
 * `taskKey` selects the `AiTaskDefault` routing key, NOT a model: selection resolves tenant ->
 * SYSTEM at run time and FAILS CLOSED. There is no provider or model field here, deliberately.
 */
const AGENT_IMPORTANT_FINDINGS_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'agent.important_findings node config (§14a — important findings as tenant-authored instructions)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    ...PROMPT_BINDING_PROPERTIES,
    taskKey: {
      type: 'string',
      description:
        'The AiTaskDefault routing key this node selects its text provider/model under. A ROUTING key, never a model id — selection resolves tenant -> SYSTEM and fails closed.',
    },
    maxFindings: {
      type: 'integer',
      minimum: 1,
      description:
        'Upper bound on findings returned per turn. A bounded-output knob, not a ranking policy — WHICH findings matter is the tenant instruction`s answer, never this node`s.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

/**
 * What ONE grounding policy may be pointed at — and it is the node's own evaluation inputs, not
 * an invented clinical vocabulary.
 *
 * `summary` is the required `in: document` socket (the redacted summary), `transcript` and
 * `findings` are the two optional ones added. Deriving the set from the ports is
 * what stops it drifting: a policy can only ever be scoped to something the node can actually be
 * handed, and adding a fourth target means adding a fourth input first.
 *
 * The socket is called `in` rather than `summary` because it predates this addition and renaming
 * a published port is the reshape `schemaVersion` exists to forbid; `summary` is the name an
 * ADMIN reads, which is why the taxonomy uses it and the port table does not.
 */
export const GROUNDING_POLICY_TARGETS = Object.freeze(['transcript', 'summary', 'findings'] as const);

/**
 * The grounding POLICY SET — the owner's specification, expressed as configuration.
 *
 * > "Grounding is a set of policies defined/declared/overwriten by tenant admin where LLM will
 * > follow and evaluate the: redacted transcript (errors fixes including grammar, spellings,
 * > etc), redacted summary (especially grammar, spelling, medical terms, concepts, detected named
 * > entities, etc.), highlighted important information/findings."
 *
 * Four words in that sentence decide the shape. **"set"** — an ARRAY, so a tenant declares as
 * many policies as it has, and each one can be turned off without deleting it. **"defined /
 * declared / overwriten by tenant admin"** — each policy's instruction is a `promptTemplateId`,
 * a governed template the tenant authors and approves, never a string typed into this file.
 * **"LLM will follow"** — there is no score formula and no rubric here; the model follows the
 * tenant's own words. **"evaluate the: ... , ... , ..."** — `appliesTo` says WHICH of the three
 * the policy governs, drawn from {@link GROUNDING_POLICY_TARGETS}.
 *
 * `key` is the tenant's own stable handle for the policy, so a verdict can name the policy that
 * produced it and an admin can recognise it. It is opaque to the platform on purpose: a
 * platform-owned key set would be a platform-owned policy catalogue, which is the thing this
 * whole property exists NOT to be.
 *
 * ABSENT `policies` is a real and supported state, not an unfinished one: the guard then behaves
 * exactly as it did before this ticket. That is what makes the addition safe for every graph
 * already published with a `guard.groundedness` node in it.
 */
const GROUNDING_POLICIES_PROPERTY = Object.freeze({
  type: 'array',
  description: 'The tenant-authored grounding policies this guard evaluates. Absent or empty means the guard runs its pre-existing pass unchanged.',
  items: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['key', 'appliesTo', 'promptTemplateId'],
    properties: {
      key: { type: 'string', minLength: 1, description: 'The tenant`s own stable handle for this policy. Opaque to the platform.' },
      appliesTo: {
        type: 'string',
        enum: GROUNDING_POLICY_TARGETS,
        description: 'Which of the guard`s three evaluation inputs this policy governs.',
      },
      promptTemplateId: PROMPT_TEMPLATE_ID_PROPERTY,
      promptVersionNumber: PROMPT_VERSION_NUMBER_PROPERTY,
      enabled: {
        type: 'boolean',
        description:
          'Turn one policy off without deleting it. Absent is ENABLED — a declared policy that silently did nothing would be worse than no policy.',
      },
    },
  }),
});

/**
 * `guard.groundedness` — the groundedness gate as a first-class, ATTACHABLE node.
 *
 * `realtime-lane.ts` records the gap this closes in its own words: *"There is no groundedness NODE
 * because the registry has no groundedness node type; the gate is a GUARD attached to the
 * generation node"*. `threshold` is the one knob that is already load-bearing rather than
 * invented — `guard-memo.ts` keys its memo on `(guard, config, input)` precisely because *"a
 * discharge summary held to 0.9 and a running note to 0.6 are two genuinely different verdicts on
 * the same text"*.
 */
const GUARD_GROUNDEDNESS_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'guard.groundedness node config (DD-7, extended by with tenant-authored policies)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    threshold: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'The groundedness score below which the guarded document is marked ungrounded. Per-node, by design (guard-memo.ts).',
    },
    // the routing key `nodes/guards.py:203` ALREADY reads
    // (`payload.config.get("taskKey") or "text.finalize"`), declared so an admin can
    // actually author it. Every schema here is `additionalProperties: false`, so until now
    // the activity honoured a key the Studio stripped — the same two-halves-disagree defect
    // the ADDENDUM at the foot of this module closed for `timeoutSeconds`/`retry`. The enum
    // is `_llm_policy.ALLOWED_TASK_KEYS` and the default is that activity's own literal, so
    // an unauthored node keeps resolving byte-identically.
    taskKey: { type: 'string', enum: ['text.finalize', 'text.live', 'text.test'], default: 'text.finalize' },
    policies: GROUNDING_POLICIES_PROPERTY,
    onError: CONSULTATION_ON_ERROR,
  },
});

// ===========================================================================================
// the GENERIC (`agentic`) node catalogue
// ===========================================================================================
//
// Program finding F-12: *"Missing: Loop, Data, TTS, and any generic Agent"* — Agent existed only
// as ~13 FIXED-PURPOSE types (`agent.summarization`, `agent.ner`, …), each of which encodes its
// behaviour in its KEY. The eight types below encode behaviour in CONFIGURATION instead, which is
// the whole point: a tenant composes an agent rather than picking one off a shelf. The fixed
// types stay registered and untouched (a node type is a contract with every saved graph); new
// work targets these.
//
// ## The rule that shapes every schema here: REFERENCES ONLY ( rule 16)
//
// A node config is TENANT GRAPH DATA. A model id, an endpoint, an API key or a deployment name
// stored in it would be read at run time WITHOUT passing through the tenant → SYSTEM cascade, and
// — worse, because it is silent — without passing through BYOK funding derivation, which decides
// `BYOK` vs `CLOUD` from `row.tenantId === SYSTEM_TENANT_ID`. A graph carrying its own endpoint
// mis-bills every run it serves and nothing fails.
//
// So every binding below names a ROW and stops:
//
//   providerConfigRef.routingPolicyId -> AiRoutingPolicy.id (connection + model + modelRef)
//   providerConfigRef.taskKey -> the tenant's ELECTED default for that task
//   tools[].mcpServerId -> McpServer.id (baseUrl + authRef live there)
//   guards.input/output[] -> a node id IN THIS GRAPH
//   instruction.promptTemplateId -> PromptTemplate.id, version-pinned
//
// There is deliberately no `provider`, no `model`, no `endpoint`, no `apiKey`, no `baseUrl` and
// no `headers` key anywhere in this catalogue, and `additionalProperties: false` means one cannot
// be smuggled in. `__tests__/reference-only.task847.test.ts` proves that mechanically over the
// whole registry rather than trusting this comment.

/** A UUID reference to a row in another table. Never the row's contents. */
const ROW_REFERENCE_PROPERTY = Object.freeze({
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});

/**
 * The agent node's ONE provider binding, in two mutually exclusive shapes.
 *
 * `routingPolicyId` PINS one specific `AiRoutingPolicy` row — the owner's *"agent nodes bind to
 * exactly one provider configuration"*, taken literally. `taskKey` instead names the TASK and
 * lets the standard tenant → SYSTEM cascade elect the configuration, which is what a tenant wants
 * when they mean "whatever we currently use for finalize".
 *
 * Both are offered because neither alone is right: pinning a SYSTEM row id in a tenant graph
 * freezes the platform default and takes the tenant's own override out of the picture, while
 * task-key resolution alone cannot express "this node, specifically, uses the cheap model".
 * EXACTLY ONE must be present — `agenticNodeConfigProblems` (`agentic-contract.ts`) enforces
 * that, because a JSON Schema `oneOf` would need a discriminator the authorable subset requires
 * and neither shape has a natural one.
 */
const PROVIDER_CONFIG_REF_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    routingPolicyId: Object.freeze({
      ...ROW_REFERENCE_PROPERTY,
      description:
        'The `AiRoutingPolicy` row this node generates through — the provider CONFIGURATION (connection + model + modelRef), by id. A REFERENCE: the provider name, the model id, the endpoint and the credential all live on that row and its `AiProviderConnection`, never here. Resolution fails CLOSED on a row that is absent, disabled or owned by another tenant.',
    }),
    taskKey: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description:
        'Resolve the tenant`s ELECTED default configuration for this task key instead of pinning one row — the standard tenant → SYSTEM cascade, widening only on absence. Mutually exclusive with `routingPolicyId`.',
    }),
  }),
  description: 'Which provider configuration serves this node. Exactly one of `routingPolicyId` / `taskKey`.',
});

/**
 * The generation hyper-parameters, INCLUDING the two program finding F-12 recorded as absent.
 *
 * `frequencyPenalty` and `presencePenalty` are not universally supported — llama.cpp and vLLM
 * accept them, several managed endpoints do not, and a provider that does not accept one
 * typically IGNORES it rather than erroring. Silently dropping a parameter a clinician tuned is
 * worse than refusing it, so these are CAPABILITY-GATED: `hyperparameterCapabilityProblems`
 * (`agentic-contract.ts`) refuses a graph that sets a parameter the bound provider configuration
 * does not declare support for. The gate lives there and not here because the capability set is
 * DATA (it comes off the resolved provider row) and this package is pure.
 *
 * Ranges follow the OpenAI-compatible convention every adapter in this platform speaks; they are
 * a floor on nonsense, not a claim that every provider accepts the whole range. The real CEILING
 * is a platform-admin descriptor enforced in `apps/text` (ticket step 5) — vLLM's
 * `--override-generation-config` sets DEFAULTS and the caller wins, so an engine-side ceiling is
 * not a ceiling at all.
 */
const GENERATION_HYPERPARAMETERS_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    temperature: Object.freeze({ type: 'number', minimum: 0, maximum: 2 }),
    maxTokens: Object.freeze({ type: 'integer', minimum: 1, maximum: 1048576 }),
    topP: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }),
    frequencyPenalty: Object.freeze({
      type: 'number',
      minimum: -2,
      maximum: 2,
      description: 'Capability-gated: refused at publish when the bound provider configuration does not declare support for it.',
    }),
    presencePenalty: Object.freeze({
      type: 'number',
      minimum: -2,
      maximum: 2,
      description: 'Capability-gated: refused at publish when the bound provider configuration does not declare support for it.',
    }),
    stopSequences: Object.freeze({ type: 'array', maxItems: 8, items: Object.freeze({ type: 'string', minLength: 1, maxLength: 128 }) }),
    seed: Object.freeze({ type: 'integer', minimum: 0, maximum: 2147483647 }),
  }),
  description: 'Generation hyper-parameters. Every key is capability-gated against the bound provider configuration — never silently dropped.',
});

/**
 * The agent's TOOL bindings — the owner's *"tenant admin can set some tools for agents to call"*,
 * which `WorkflowNodeDescriptor` had nowhere to hold (F-12: *"zero tool/MCP fields"*).
 *
 * A binding is `(mcpServerId, toolName)` and NOTHING else, and the omissions are the design.
 * delivered the tenant-scoped `McpServer` registry: `baseUrl`, `transport`, `authRef`
 * (a Vault reference, never a secret), `toolAllowlist`, `phiBoundary` and `enabled` all live on
 * that row, behind a deny-by-default SSRF egress guard. A `baseUrl` on a graph node would route
 * around every one of those — the guard, the allowlist, the PHI boundary and the enabled flag —
 * so the graph names the row and the ACTIVITY resolves it.
 */
const AGENT_TOOLS_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'array',
  maxItems: 32,
  items: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['mcpServerId', 'toolName']),
    properties: Object.freeze({
      mcpServerId: Object.freeze({
        ...ROW_REFERENCE_PROPERTY,
        description:
          'The tenant`s `McpServer` row . Its `baseUrl`/`authRef`/`toolAllowlist`/`enabled` are resolved in the activity; a disabled row FAILS CLOSED.',
      }),
      toolName: Object.freeze({ type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]{1,128}$' }),
    }),
  }),
  description: 'Tools this agent may call, as (server, tool) REFERENCES. Never a URL, a header or a credential.',
});

/** A reference to another node IN THE SAME GRAPH. Guard attachment is a graph fact. */
const NODE_ID_REFERENCE_LIST = Object.freeze({
  type: 'array',
  maxItems: 8,
  items: Object.freeze({ type: 'string', pattern: '^[a-z0-9_]{2,48}$' }),
});

/**
 * The owner's *"optional guardrail nodes on input/output"*. Guards are NODES in the graph, and
 * this names which ones wrap this agent — so the guardrail's own configuration, its policy
 * binding and its verdict all stay on the guard node where the rule catalogue can already see
 * them, rather than being duplicated into the agent's config.
 */
const AGENT_GUARDS_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    input: NODE_ID_REFERENCE_LIST,
    output: NODE_ID_REFERENCE_LIST,
  }),
  description: 'Guardrail NODE ids in this graph that wrap this agent`s input / output. References, checked at publish.',
});

/** A tenant-authored JSON Schema, carried verbatim. Validated by `authorableJsonSchemaProblems`
 *  at publish (the same subset a `ConsultationContextSchema` is bound by) and enforced again at
 *  the node boundary at run time — TIER 3, where correctness actually lives. */
const TENANT_IO_SCHEMA_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  description: 'A tenant-defined JSON Schema (authorable subset) describing the payload crossing this boundary.',
});

const AGENTIC_INPUT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/agentic.input.schema.json',
  title: 'agentic.input node config — the graph`s typed entry point',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['ioSchema']),
  properties: Object.freeze({
    ioSchema: TENANT_IO_SCHEMA_PROPERTY,
    sourceKey: Object.freeze({
      type: 'string',
      pattern: '^[a-z0-9_]{2,48}$',
      description: 'Which key of the run payload this node binds. Defaults to the whole payload.',
    }),
  }),
});

const AGENTIC_OUTPUT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/agentic.output.schema.json',
  title: 'agentic.output node config — the graph`s typed exit point',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['ioSchema']),
  properties: Object.freeze({
    ioSchema: TENANT_IO_SCHEMA_PROPERTY,
    onSchemaViolation: Object.freeze({
      type: 'string',
      enum: Object.freeze(['fail', 'degrade']),
      default: 'fail',
      description:
        'TIER 3. `fail` refuses to emit a payload that does not match the declared schema; `degrade` emits it and marks the node DEGRADED. Never silently emits a mismatch.',
    }),
  }),
});

const AGENTIC_AGENT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/agentic.agent.schema.json',
  title: 'agentic.agent node config — the GENERIC agent (behaviour is configuration, not type)',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['providerConfigRef']),
  properties: Object.freeze({
    providerConfigRef: PROVIDER_CONFIG_REF_PROPERTY,
    // The INSTRUCTION prompt, as an APPROVED, version-pinned template reference — the same
    // binding every generation node already carries , spread whole so this node cannot
    // fall out of step with the group. It brings `evalGate` with it, which is the point:
    // the golden-set gate binds to the NODE, and a generic agent is the node most in need of one.
    // `systemPrompt` stays available for the un-templated case and is capped, but a template is
    // the supported path — free text on a node has no approval workflow and no version history.
    ...PROMPT_BINDING_PROPERTIES,
    // DD-2. A generic agent is `generation`-classed, and every generation-classed node carries
    // the document-SHAPE binding (`node-config-schemas.test.ts` asserts that as a set equality).
    // It is also what makes one composed agent a discharge summary and another a note without
    // forking the model call — the same argument `agent.discharge_summary` records.
    ...DOCUMENT_BINDING_PROPERTIES,
    systemPrompt: Object.freeze({ type: 'string', maxLength: 50000 }),
    generation: GENERATION_HYPERPARAMETERS_PROPERTY,
    guards: AGENT_GUARDS_PROPERTY,
    tools: AGENT_TOOLS_PROPERTY,
    responseFormat: Object.freeze({ type: 'string', enum: Object.freeze(['text', 'json', 'json_schema']) }),
    responseSchema: TENANT_IO_SCHEMA_PROPERTY,
    onError: Object.freeze({ type: 'string', enum: Object.freeze(['fail', 'degrade']) }),
  }),
});

const AGENTIC_GUARDRAIL_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/agentic.guardrail.schema.json',
  title: 'agentic.guardrail node config — the generic guardrail, bound to a tenant policy',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['guardrailType', 'onFail']),
  properties: Object.freeze({
    // A guardrail TYPE is a policy key `apps/guardrail` resolves per tenant — never a model id,
    // never a threshold literal. The threshold and the label taxonomy ride on the AiModel row
    // the tenant → SYSTEM cascade selected ( phases 3 & 6).
    guardrailType: Object.freeze({ type: 'string', minLength: 1, maxLength: 64 }),
    failOn: Object.freeze({ type: 'string', enum: Object.freeze(['unsafe_or_unknown']), default: 'unsafe_or_unknown' }),
    // `abort` is deliberately absent for the reason `GUARDRAIL_CHECK_SCHEMA` records at length:
    // no v1 mechanism promotes a per-node config value over the code-owned `critical` registry
    // property, so accepting it would be a promise the runtime cannot keep.
    onFail: Object.freeze({ type: 'string', enum: Object.freeze(['mark']) }),
  }),
});

/**
 * The DATA node — a deterministic reshape between two schemas, and the tier-2 ESCAPE HATCH.
 *
 * Tier 2 (`schema-compat.ts`) WARNS when a producer's declared output shape does not obviously
 * satisfy a consumer's declared input shape. The warning is only useful if there is something to
 * do about it, and this is that something: drop a Data node on the edge and map the fields. That
 * is why the mapping language is deliberately tiny — dotted reads, renamed writes, literal
 * constants. Anything richer is a transformation language, which is a second place for tenant
 * logic to live and a second thing to audit.
 */
const AGENTIC_DATA_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/agentic.data.schema.json',
  title: 'agentic.data node config — deterministic reshape, the tier-2 escape hatch',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['mappings']),
  properties: Object.freeze({
    mappings: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['from', 'to']),
        properties: Object.freeze({
          from: Object.freeze({ type: 'string', minLength: 1, maxLength: 256, description: 'Dotted path into this node`s bound inputs.' }),
          to: Object.freeze({ type: 'string', pattern: '^[a-z0-9_]{2,48}$', description: 'Key on this node`s output object.' }),
          required: Object.freeze({
            type: 'boolean',
            default: false,
            description: 'An unresolved REQUIRED mapping degrades the node observably; an optional one is simply absent.',
          }),
        }),
      }),
    }),
    constants: Object.freeze({
      type: 'object',
      description: 'Literal values merged into the output. Non-secret by construction: this is graph data.',
    }),
    outputSchema: TENANT_IO_SCHEMA_PROPERTY,
  }),
});

/**
 * The LOOP node's bounds — THREE axes, and the third is the one the owner's specification did
 * not name.
 *
 * `maxIterations` and `maxDurationSeconds` bound the schedule. Neither bounds the INVOICE: fifty
 * iterations of a large model is an unbounded bill that completes successfully, on time, and
 * looks like a healthy run. `maxTotalTokens` is the cost ceiling, and it is REQUIRED for exactly
 * that reason — an optional ceiling is one nobody sets.
 *
 * `maxDurationSeconds` is spent as a TEMPORAL WORKFLOW TIMER (`workflow.sleep` /
 * `asyncio.wait_for` on the workflow clock), never as wall-clock. Reading a wall clock inside
 * `@workflow.defn` is non-deterministic and breaks replay — the run would take a different number
 * of iterations the second time history is fed through it, which for a clinical pipeline means a
 * completed run that cannot be reproduced. owns the enforcement; this declares what it
 * must enforce.
 *
 * `noProgressIterations` is the fourth stop condition and the one that catches the common failure
 * an iteration cap does not: an orchestrator that has converged and is now paraphrasing itself
 * burns the whole budget to reach the same answer.
 */
const AGENTIC_LOOP_BOUNDS_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['maxIterations', 'maxDurationSeconds', 'maxTotalTokens']),
  properties: Object.freeze({
    maxIterations: Object.freeze({ type: 'integer', minimum: 1, maximum: 100 }),
    maxDurationSeconds: Object.freeze({
      type: 'integer',
      minimum: 1,
      maximum: 3600,
      description: 'Spent as a Temporal WORKFLOW TIMER, never wall-clock — a wall-clock read inside a workflow breaks replay determinism.',
    }),
    maxTotalTokens: Object.freeze({
      type: 'integer',
      minimum: 1,
      maximum: 4000000,
      description:
        'The COST ceiling, summed across every iteration and every sub-agent. Required: an iteration cap bounds the schedule, not the invoice.',
    }),
    noProgressIterations: Object.freeze({
      type: 'integer',
      minimum: 1,
      maximum: 20,
      default: 2,
      description: 'Stop after this many consecutive iterations that produce no change in the orchestrator`s working state.',
    }),
  }),
});

const AGENTIC_LOOP_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/agentic.loop.schema.json',
  title: 'agentic.loop node config — orchestrator + sub-agents, bounded on three axes',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['bounds', 'orchestratorNodeId']),
  properties: Object.freeze({
    bounds: AGENTIC_LOOP_BOUNDS_PROPERTY,
    orchestratorNodeId: Object.freeze({
      type: 'string',
      pattern: '^[a-z0-9_]{2,48}$',
      description: 'The MASTER agent node in this graph. A node REFERENCE.',
    }),
    subAgentNodeIds: NODE_ID_REFERENCE_LIST,
    // The Loop node earns its existence only for RUNTIME-UNKNOWN step counts :
    // chaining, routing, sectioning and voting are all graph SHAPES and need no loop.
    terminationKey: Object.freeze({
      type: 'string',
      pattern: '^[a-z0-9_]{2,48}$',
      description: 'Key on the orchestrator`s output whose truthiness ends the loop early.',
    }),
  }),
});

const AGENTIC_STT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/agentic.stt.schema.json',
  title: 'agentic.stt node config — BATCH transcription of a stored artifact',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['pipelineRef']),
  properties: Object.freeze({
    // The published `stt`-palette definition compiles to an `AsrPipeline` row (; this
    // node names that row. Engine, model, language pack and every threshold live on it — none of
    // them are authorable here, which is what keeps STT selection inside the same cascade every
    // other model selection uses.
    pipelineRef: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        pipelineId: Object.freeze({
          ...ROW_REFERENCE_PROPERTY,
          description: 'An `AsrPipeline` row id. A REFERENCE — never an engine name or a model id.',
        }),
        pipelineSlug: Object.freeze({
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'Resolve the tenant`s pipeline by slug through the tenant → SYSTEM cascade instead of pinning an id.',
        }),
      }),
      description: 'Which ASR pipeline transcribes. Exactly one of `pipelineId` / `pipelineSlug`.',
    }),
    language: Object.freeze({
      type: 'string',
      minLength: 2,
      maxLength: 16,
      description: 'BCP-47 hint. Absent means the pipeline`s own language detection decides.',
    }),
    pollTimeoutSeconds: Object.freeze({ type: 'integer', minimum: 1, maximum: 3600, default: 900 }),
  }),
});

const AGENTIC_TTS_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/agentic.tts.schema.json',
  title: 'agentic.tts node config — speech synthesis to a stored artifact (OD-4)',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['providerConfigRef']),
  properties: Object.freeze({
    // Same binding shape as the agent node, and for the same reason: a voice is served by a
    // provider configuration, so the connection, the model and the credential resolve through the
    // tenant → SYSTEM cascade rather than being named here.
    providerConfigRef: PROVIDER_CONFIG_REF_PROPERTY,
    voiceRef: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'A voice IDENTIFIER within the bound configuration`s catalogue — resolved against it, never an endpoint.',
    }),
    language: Object.freeze({ type: 'string', minLength: 2, maxLength: 16 }),
    format: Object.freeze({ type: 'string', enum: Object.freeze(['wav', 'mp3', 'ogg', 'pcm']) }),
    speed: Object.freeze({ type: 'number', minimum: 0.25, maximum: 4 }),
  }),
});

// ===========================================================================================
// TASK-864 — the `core` vocabulary's config schemas.
//
// One palette, nine primitives, behaviour as CONFIGURATION. The same reference-only discipline
// the `agentic` catalogue set applies here without exception: an Agent node names a published
// Agent by SLUG, a Classify node names a registry model by SLUG, a Trigger names a context-schema
// row by id. Nothing here is a provider, a model id, an endpoint or a credential
// (`reference-only.task847.test.ts` sweeps these too).
// ===========================================================================================

/** A tenant-authored slug (`WORKFLOW_DEFINITION_SLUG_PATTERN`, mirrored for the schema). */
const SLUG_PATTERN = '^[a-z0-9][a-z0-9_-]{0,78}[a-z0-9]$';

/** An authoring KEY — the same grammar as a node id (`WORKFLOW_NODE_ID_PATTERN`). */
const KEY_PATTERN = '^[a-z0-9_]{2,48}$';

/** A CEL expression (TASK-864 §3.2). Parse-checked at publish by `expressionProblems`. */
const CEL_EXPRESSION_PROPERTY = Object.freeze({
  type: 'string',
  // A JSON-Schema annotation (never asserted): the Studio's inspector renders `format: 'cel'`
  // strings through its expression editor instead of a plain text box (TASK-864 B1).
  format: 'cel',
  minLength: 1,
  maxLength: 2000,
  description:
    'A CEL expression over the run context — `trigger.*`, `vars.*`, `nodes.<id>.*`. Deterministic and side-effect free; type-checked at publish and evaluated by the interpreter.',
});

const CORE_TRIGGER_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.trigger.schema.json',
  title: 'core.trigger node config — the graph`s ONE entry point',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['kinds']),
  properties: Object.freeze({
    kinds: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: Object.freeze({ type: 'string', enum: Object.freeze(['consultation', 'api', 'webhook', 'schedule']) }),
      description:
        'Which trigger kinds may start this workflow. `consultation` = the clinical plane (session open); `api` = POST /workflows/{slug}/runs; `webhook` = POST /hooks/workflows/{slug}; `schedule` is reserved.',
    }),
    contextSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        inline: TENANT_IO_SCHEMA_PROPERTY,
        contextSchemaId: Object.freeze({
          ...ROW_REFERENCE_PROPERTY,
          description: 'A `ConsultationContextSchema` row — a REFERENCE; the schema body lives on the row.',
        }),
        versionNumber: Object.freeze({ type: 'integer', minimum: 1 }),
      }),
      description:
        'The consultation-context object schema available to the whole session, authored inline or referenced by row. The run payload is validated against it before any node runs.',
    }),
    sampleInput: Object.freeze({ type: 'object', description: 'An example payload for the Studio and the generated docs. Never executed.' }),
  }),
});

/**
 * `core.agent` — ONE task, by REFERENCE to a published Agent (TASK-863). Ports are the union of
 * every task's sockets (`node-ports.ts`); `overrides` are bounded by the agent's own declared
 * ranges at publish (`coreNodeConfigProblems`, once the agent row is resolvable), and
 * `execution` is what used to be the registry's per-TYPE `lane`/`trigger`: it is now per
 * INSTANCE, so one summarizer can run live and at finalization without two node types.
 */
const CORE_AGENT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.agent.schema.json',
  title: 'core.agent node config — one task, one published Agent, by reference',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['agentRef']),
  properties: Object.freeze({
    agentRef: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['slug']),
      properties: Object.freeze({
        slug: Object.freeze({
          type: 'string',
          pattern: SLUG_PATTERN,
          description: 'The published Agent`s slug, resolved [tenant, SYSTEM] preferring tenant. A REFERENCE — never a model, provider or endpoint.',
        }),
        versionNumber: Object.freeze({
          type: 'integer',
          minimum: 1,
          description: 'Pin one published version. Absent means the agent`s ACTIVE version.',
        }),
      }),
    }),
    overrides: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        promptVariables: Object.freeze({
          type: 'object',
          additionalProperties: Object.freeze({ type: 'string', maxLength: 4000 }),
          description:
            'Values for the agent`s instruction-template variables. `{{vars.key}}` / `{{nodes.id.key}}` / `{{trigger.key}}` interpolate from the run context.',
        }),
        generation: GENERATION_HYPERPARAMETERS_PROPERTY,
        carryForward: CARRY_FORWARD_PROPERTY,
      }),
      description:
        'Per-node overrides, limited to prompt variables, hyper-parameters within the agent`s declared ranges, and the re-visit carry-forward switch.',
    }),
    execution: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        lane: Object.freeze({
          type: 'string',
          enum: Object.freeze(['durable', 'realtime']),
          default: 'durable',
          description:
            'WHICH RUNTIME executes this instance. `realtime` = the gateway`s live executor (the durable interpreter skips it, reason `realtime_lane`).',
        }),
        cadence: Object.freeze({
          type: 'string',
          enum: Object.freeze(['once', 'perTurn', 'onEnd']),
          default: 'once',
          description: 'WHEN it runs — once at start, per live turn, or once at the close.',
        }),
      }),
    }),
    ...DOCUMENT_BINDING_PROPERTIES,
    onError: Object.freeze({ type: 'string', enum: Object.freeze(['fail', 'degrade']) }),
  }),
});

const CORE_CLASSIFY_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.classify.schema.json',
  title: 'core.classify node config — route text into one of the declared classes',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['modelSlug', 'classes']),
  properties: Object.freeze({
    modelSlug: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description:
        'An `AiModel.slug` whose task is TEXT_CLASSIFICATION or TOKEN_CLASSIFICATION (TASK-860 registry). A REFERENCE — never an engine or a model id.',
    }),
    classes: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['key', 'label']),
        properties: Object.freeze({
          key: Object.freeze({ type: 'string', pattern: KEY_PATTERN, description: 'The branch handle name. One output handle per class.' }),
          label: Object.freeze({ type: 'string', minLength: 1, maxLength: 200 }),
          description: Object.freeze({ type: 'string', maxLength: 2000 }),
          labels: Object.freeze({
            type: 'array',
            maxItems: 32,
            items: Object.freeze({ type: 'string', minLength: 1, maxLength: 128 }),
            description: 'Which of the model`s own labels map onto this class. Absent means the class key is the label.',
          }),
        }),
      }),
    }),
    mode: Object.freeze({ type: 'string', enum: Object.freeze(['single', 'multi']), default: 'single' }),
    threshold: Object.freeze({ type: 'number', minimum: 0, maximum: 1, description: 'Below it, no class is taken and `otherwise` fires.' }),
    spans: Object.freeze({ type: 'boolean', default: false, description: 'Token-classification models: also emit the matched spans.' }),
    onError: Object.freeze({ type: 'string', enum: Object.freeze(['fail', 'degrade']) }),
  }),
});

const CORE_HUMAN_REVIEW_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.humanReview.schema.json',
  title: 'core.humanReview node config — a durable hold-out for a human decision',
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    reviewType: Object.freeze({ type: 'string', minLength: 1, maxLength: 64, default: 'approval' }),
    instructions: Object.freeze({ type: 'string', maxLength: 4000, description: 'Shown to the reviewer. Never a prompt.' }),
    assignRole: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'The role whose members may decide (TASK-859 OD-9: role only, today).',
    }),
    timeoutSeconds: Object.freeze({
      type: 'integer',
      minimum: 1,
      maximum: 604800,
      description: 'How long the run waits before `timedOut` fires. A timeout NEVER approves.',
    }),
    escalation: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        afterSeconds: Object.freeze({ type: 'integer', minimum: 1, maximum: 604800 }),
        maxEscalations: Object.freeze({ type: 'integer', minimum: 0, maximum: 10 }),
      }),
    }),
    allowEdit: Object.freeze({
      type: 'boolean',
      default: false,
      description: 'Whether the reviewer may return an edited payload with the decision.',
    }),
  }),
});

const CORE_VARIABLE_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.variable.schema.json',
  title: 'core.variable node config — declare run variables with defaults',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['variables']),
  properties: Object.freeze({
    variables: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['key']),
        properties: Object.freeze({
          key: Object.freeze({ type: 'string', pattern: KEY_PATTERN, description: 'Readable as `vars.<key>` everywhere.' }),
          schema: TENANT_IO_SCHEMA_PROPERTY,
          // `default` may be any JSON value; the authorable subset expresses that as an
          // unconstrained schema (`{}` accepts anything, per JSON Schema).
          default: Object.freeze({ description: 'The initial value. Any JSON value.' }),
        }),
      }),
    }),
  }),
});

const CORE_CONDITION_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.condition.schema.json',
  title: 'core.condition node config — If/Else routing over CEL expressions',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['branches']),
  properties: Object.freeze({
    branches: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['key', 'when']),
        properties: Object.freeze({
          key: Object.freeze({ type: 'string', pattern: KEY_PATTERN, description: 'The branch handle name.' }),
          label: Object.freeze({ type: 'string', maxLength: 200 }),
          when: CEL_EXPRESSION_PROPERTY,
        }),
      }),
      description: 'Evaluated in order; the FIRST true branch is taken, else the `else` handle.',
    }),
  }),
});

const CORE_LOOP_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.loop.schema.json',
  title: 'core.loop node config — repeat a sub-graph, bounded on every axis',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['mode', 'bounds']),
  properties: Object.freeze({
    mode: Object.freeze({ type: 'string', enum: Object.freeze(['foreach', 'while']) }),
    over: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: '`foreach`: a dotted path into the run context naming the array to iterate (`nodes.split.items`, `trigger.documents`).',
    }),
    until: Object.freeze({
      ...CEL_EXPRESSION_PROPERTY,
      description: '`while`: the loop ends when this CEL expression is true. Re-evaluated after every iteration.',
    }),
    bounds: AGENTIC_LOOP_BOUNDS_PROPERTY,
    collect: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'A dotted path into each iteration`s result whose values are collected onto `done`. Absent collects the whole result.',
    }),
  }),
});

const CORE_NOTE_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.note.schema.json',
  title: 'core.note node config — a canvas comment, never compiled',
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    text: Object.freeze({ type: 'string', maxLength: 4000 }),
    color: Object.freeze({ type: 'string', enum: Object.freeze(['neutral', 'info', 'warning', 'success']), default: 'neutral' }),
  }),
});

const CORE_OUTPUT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.output.schema.json',
  title: 'core.output node config — the graph`s end point and its published protocols',
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    outputSchema: TENANT_IO_SCHEMA_PROPERTY,
    protocols: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: Object.freeze({ type: 'string', enum: Object.freeze(['http', 'http-sse', 'socket']) }),
      default: Object.freeze(['http-sse']),
      description:
        'Under which protocols the published workflow is reachable. Bounds `?mode=` at invocation: `http` -> blocking, `http-sse` -> stream, `socket` -> the WS stream; `async` is always allowed.',
    }),
    onSchemaViolation: Object.freeze({ type: 'string', enum: Object.freeze(['fail', 'degrade']), default: 'fail' }),
    claimCheck: Object.freeze({ type: 'string', enum: Object.freeze(['auto', 'always', 'never']), default: 'auto' }),
    notify: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        webhook: Object.freeze({ type: 'boolean', default: true, description: 'Emit the run-completed webhook (PHI-free payload).' }),
      }),
    }),
  }),
});

/**
 * `core.action` — every remaining fixed-purpose clinical step as ONE node type keyed by
 * `actionKey`. The action's own config travels under `action` and is validated at publish
 * against the delegated legacy node type's schema (`core-contract.ts`), so the per-type
 * schemas move under the key unchanged rather than being re-authored.
 */
const CORE_ACTION_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.action.schema.json',
  title: 'core.action node config — a platform action, by key',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['actionKey']),
  properties: Object.freeze({
    actionKey: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description:
        'A key of the action catalogue (`ACTION_CATALOGUE`). Selects the activity, the effective ports and the config schema under `action`.',
    }),
    action: Object.freeze({ type: 'object', description: 'The action`s own config — the delegated node type`s schema, unchanged.' }),
    execution: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        lane: Object.freeze({ type: 'string', enum: Object.freeze(['durable', 'realtime']) }),
        cadence: Object.freeze({ type: 'string', enum: Object.freeze(['once', 'perTurn', 'onEnd']) }),
      }),
    }),
    onError: Object.freeze({ type: 'string', enum: Object.freeze(['fail', 'degrade']) }),
  }),
});

/**
 * Node-type key -> AUTHORED config JSON Schema. A key ABSENT from this map means no schema has
 * been authored for that node type yet (`WORKFLOW_NODE_REGISTRY[key].configSchema` stays
 * `undefined`) — a real, structural, always-possible state (see this module's docstring),
 * not an omission to fix here.
 *
 * This is the AUTHORED half. The exported `NODE_CONFIG_SCHEMAS` below folds the palette-agnostic
 * runtime knobs into every entry — see the ADDENDUM at the foot of this module.
 */
const AUTHORED_NODE_CONFIG_SCHEMAS: Readonly<Record<string, NodeConfigSchema>> = Object.freeze({
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
  // Consultation palette (closing D-9) — ordered by pipeline position, the
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
  // The endpoint stage, in the order the default sequence runs them.
  'session.timeout': SESSION_TIMEOUT_SCHEMA,
  'summary.finalize': SUMMARY_FINALIZE_SCHEMA,
  'feedback.capture': FEEDBACK_CAPTURE_SCHEMA,
  'livedoc.stop': LIVEDOC_STOP_SCHEMA,
  'harness.finalize': HARNESS_FINALIZE_SCHEMA,
  // The TARGET CATALOGUE , in catalogue order. Each entry reuses the schema of the
  // engine it delegates to — see the block above `AGENT_DNA_REDACTION_SCHEMA`.
  'agent.transcription': CONSULTATION_CAPTURE_BINDING_SCHEMA,
  'agent.normalization': CONSULTATION_BIND_TERMINOLOGY_SCHEMA,
  'agent.ner': CONSULTATION_EXTRACT_ENTITIES_SCHEMA,
  // Lane R (R1) — the realtime grammar pass shares the correction engine's config surface for
  // the same reason the three generation entries share theirs: one engine, one authorable
  // schema. In particular it inherits `promptTemplateId`, which is where the correction prompt
  // comes from — a bound template, never a literal in runtime code.
  'agent.grammar': CONSULTATION_PROPOSE_CORRECTIONS_SCHEMA,
  // DD-9 — three palette entries, ONE generation engine, therefore ONE config surface.
  'agent.presummarization': CONSULTATION_SYNTHESIZE_SCHEMA,
  'agent.summarization': CONSULTATION_SYNTHESIZE_SCHEMA,
  'agent.discharge_summary': CONSULTATION_SYNTHESIZE_SCHEMA,
  'agent.retrieval': CONSULTATION_RETRIEVE_EVIDENCE_SCHEMA,
  'agent.feedback': FEEDBACK_CAPTURE_SCHEMA,
  'agent.important_findings': AGENT_IMPORTANT_FINDINGS_SCHEMA,
  'agent.dna_redaction': AGENT_DNA_REDACTION_SCHEMA,
  'agent.dna_style': AGENT_DNA_STYLE_SCHEMA,
  // The guards. `guard.phi` and `guard.moderation` reuse the redaction and content-safety
  // engines' own schemas; only groundedness had no node to inherit from.
  'guard.phi': CONSULTATION_PHI_HOP_SCHEMA,
  'guard.moderation': GUARDRAIL_CHECK_SCHEMA,
  'guard.groundedness': GUARD_GROUNDEDNESS_SCHEMA,
  // the GENERIC catalogue. Behaviour is configuration, not type; every binding is a
  // ROW REFERENCE. See the block above `ROW_REFERENCE_PROPERTY` for why nothing here names a
  // provider, a model, an endpoint or a credential.
  'agentic.input': AGENTIC_INPUT_SCHEMA,
  'agentic.output': AGENTIC_OUTPUT_SCHEMA,
  'agentic.agent': AGENTIC_AGENT_SCHEMA,
  'agentic.guardrail': AGENTIC_GUARDRAIL_SCHEMA,
  'agentic.data': AGENTIC_DATA_SCHEMA,
  'agentic.loop': AGENTIC_LOOP_SCHEMA,
  'agentic.stt': AGENTIC_STT_SCHEMA,
  'agentic.tts': AGENTIC_TTS_SCHEMA,
  // TASK-864 — the `core` vocabulary. `core.data` reuses the Data node's schema verbatim: the
  // mapping language is the same tiny one, and a second copy is a second thing to audit.
  'core.trigger': CORE_TRIGGER_SCHEMA,
  'core.agent': CORE_AGENT_SCHEMA,
  'core.classify': CORE_CLASSIFY_SCHEMA,
  'core.humanReview': CORE_HUMAN_REVIEW_SCHEMA,
  'core.variable': CORE_VARIABLE_SCHEMA,
  'core.condition': CORE_CONDITION_SCHEMA,
  'core.loop': CORE_LOOP_SCHEMA,
  'core.note': CORE_NOTE_SCHEMA,
  'core.output': CORE_OUTPUT_SCHEMA,
  'core.data': AGENTIC_DATA_SCHEMA,
  'core.action': CORE_ACTION_SCHEMA,
});

// ===========================================================================================
// ADDENDUM — the palette-agnostic RUNTIME knobs `compileNode` reads off EVERY node
// (lane A, item 5; the addendum promised at line ~505 and never wrote)
// ===========================================================================================
//
// `compiler.ts`'s `compileNode` reads three keys off `node.config` for every node it compiles:
// `timeoutSeconds`, `retry` and `onError`. Until now NO schema declared the first two, and every
// schema sets `additionalProperties: false` — so the two halves of the platform disagreed about
// the same object: the engine honoured a per-node budget and retry ceiling that an admin could
// not author, and a graph that DID carry them failed publish on an undeclared property.
//
// The decision (recorded because the alternative was live): **declare them once, here**, rather
// than deleting the compiler's reads. Deleting them would remove a capability that is genuinely
// exercised — `compileGate` reads `timeoutSeconds` on the one durable human wait, and
// realtime executor takes its PER-NODE budget and retry ceiling straight off the compiled
// `timeoutSeconds` / `retry.maximumAttempts` (`realtime-lane.ts`'s `RealtimeNode`). A per-node
// budget is the mechanism by which one slow model does not stall another; it is not dead code.
//
// Folded in HERE rather than pasted into ~36 literals for the same reason `NODE_PORTS` is
// attached in `node-registry.ts` rather than inlined: a uniform property that must appear on
// every node is a derivation, and a derivation cannot be forgotten on the next node someone adds.
// An authored schema that already declares one of these keys KEEPS its own declaration
// (`consultation.hitlGate` declares a gate-scoped `timeoutSeconds`), so this can only ever add.
//
// `onError` is deliberately NOT folded in: the consultation palette declares it with WF-CONS-019's
// own enum, and the summarization/STT schemas that omit it would need a vocabulary this module
// cannot derive (`compileNode` treats every value that is not `'degrade'` as `'fail'`, so the
// consultation enum's `'retry'` is already an authoring-time value with no compiled meaning).
// That is a real, separate gap — reported, not silently papered over with a guessed enum.
//
// adds a THIRD key to this fold, `enabled`, on the same argument one level over: it is
// read by the two RUNTIMES rather than by `compileNode` (which passes `config` through
// wholesale), it was already honoured by one of them, and it was undeclared — so it was stripped
// by the validator and undrawn by the inspector, exactly as `timeoutSeconds`/`retry` were. It is
// the first folded key with an EXCLUSION SET of its own; see `MANDATORY_NODE_TYPES` below.

/** The per-node retry ceiling `compileNode` clamps against `caps.maxAttempts`. Mirrors
 *  `CompiledRetryPolicy` exactly; a key the compiler does not read is not offered. */
const NODE_RETRY_SCHEMA: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    maximumAttempts: { type: 'integer', minimum: 1, description: 'Clamped to the definition`s `caps.maxAttempts` at compile time.' },
    initialIntervalSeconds: { type: 'number', minimum: 0, description: 'First retry delay, in seconds.' },
    backoffCoefficient: { type: 'number', minimum: 1, description: 'Multiplier applied to the interval after each attempt.' },
  },
});

/**
 * item 3 — the per-node KILL SWITCH, declared at last.
 *
 * Both runtimes read this key off `CompiledNode.config`: realtime executor as
 * `enabled: node.config?.enabled !== false` (`realtime-lane.ts`), and the durable interpreter's
 * `_dispatch_node` as a `SKIPPED(disabled_by_config)` branch. Neither compiles
 * it — `compileNode` passes `config` through wholesale — so unlike `timeoutSeconds`/`retry` this
 * is a key the RUNTIMES read rather than the compiler, and it is folded in here for exactly the
 * reason they are: an undeclared key is stripped twice over (the validator rejects it under
 * `additionalProperties: false`, and the Studio inspector draws no field for it), so the toggle
 * the runtimes already honoured was unreachable from the supported authoring path.
 *
 * `default: true` is not decoration. ABSENT MUST MEAN ON: every graph published before this
 * ticket carries no `enabled` key, and both runtimes therefore test for the literal `false`
 * rather than for falsiness.
 */
const NODE_ENABLED_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'boolean',
  default: true,
  description:
    'Turn this node off without deleting it from the graph. Absent is ENABLED. A disabled node is SKIPPED observably by both runtimes — never a silent no-op — and mandatory nodes do not offer it.',
});

/** The palette-agnostic runtime knobs folded onto every node type: the two keys `compileNode`
 *  reads off every node`s config, plus the `enabled` toggle both RUNTIMES read off it. */
const NODE_RUNTIME_PROPERTIES: Readonly<Record<string, NodeConfigSchema>> = Object.freeze({
  timeoutSeconds: Object.freeze({
    type: 'integer',
    minimum: 1,
    description: 'Per-node execution budget in seconds, clamped to the definition`s `caps.maxNodeSeconds` at compile time.',
  }),
  retry: NODE_RETRY_SCHEMA,
  enabled: NODE_ENABLED_PROPERTY,
});

// The per-node `llmBinding` (DD-10) used to be folded in here by `withLlmBinding()` onto every
// schema declaring `taskKey`. TASK-882 removed it: since TASK-876 the TEXT_GENERATION agent
// selects the model and no runtime read the binding (`api_client.py`, `_llm_policy.py`), so the
// property was a configuration promise nothing kept. Model selection is the agent's alone.

/**
 * `consultation.hitlGate` is the ONE exclusion, and it is structural rather than a carve-out: it
 * is the only `gate`-classed node type, so the compiler lifts it out of `stages` into `gates` and
 * routes it through `compileGate` — which reads `timeoutSeconds` (already declared on its own
 * schema, scoped to the human wait) and NO retry policy at all. `CompiledGate` has no `retry`
 * field, so offering one would be a configuration promise the runtime cannot keep.
 */
const RUNTIME_PROPERTY_EXCLUSIONS: ReadonlySet<string> = new Set(['consultation.hitlGate']);

/**
 * the node types that get every runtime knob EXCEPT `enabled`.
 *
 * A node type carrying the registry class `mandatory` is one `rule-catalogue.ts` requires on
 * every path from `core.start` to a terminal (`REQUIRED_PATH_THROUGH` with
 * `throughClass: 'mandatory'` — *"nothing routes around a gate"*). `enabled: false` on such a
 * node IS that routing-around, achieved a different way: the node stays in the graph so the
 * structural rule still passes, while the runtime skips it. On `consultation.consentGate` that
 * is a consent gate a tenant admin can switch off, which is a compliance defect in a healthcare
 * product, not a feature; on `consultation.phiHop` it is a redaction hop that stops redacting.
 *
 * So the discriminator is the class the rule catalogue ALREADY uses to mean "must run", not a
 * list of node names — a node type that gains the class gains the withholding for free, and one
 * that loses it loses the withholding visibly. It is duplicated here as a literal set ONLY
 * because `node-registry.ts` imports THIS module (reading `classesOf()` here would close an
 * import cycle); `__tests__/node-enabled-toggle.task852.test.ts` asserts the two sets are the
 * same one, so the projection cannot drift from the registry it mirrors.
 *
 * `consultation.hitlGate` is in both this set and `RUNTIME_PROPERTY_EXCLUSIONS` above, for two
 * independent reasons — it is mandatory AND it is the one `gate`-classed type whose config the
 * compiler, not an activity, consumes.
 */
const MANDATORY_NODE_TYPES: ReadonlySet<string> = new Set([
  // summarization palette
  'input.context_binding',
  'generate.text',
  'guardrail.check',
  'output.deliver',
  // stt palette
  'stt.audioInput',
  'stt.asrEngine',
  'stt.transcriptOutput',
  // consultation palette
  'consultation.consentGate',
  'consultation.captureBinding',
  'consultation.phiHop',
  'consultation.persistDraft',
  'consultation.finalizeAssurance',
  'consultation.hitlGate',
  // TASK-864 — the `core` graph boundaries. A trigger or an output that can be switched off is a
  // graph with no entry or no exit; both carry the `mandatory` class in `node-registry.ts`.
  'core.trigger',
  'core.output',
]);

function withRuntimeProperties(key: string, schema: NodeConfigSchema): NodeConfigSchema {
  if (RUNTIME_PROPERTY_EXCLUSIONS.has(key)) return schema;
  const declared = (schema.properties ?? {}) as Record<string, NodeConfigSchema>;
  const offered = Object.entries(NODE_RUNTIME_PROPERTIES).filter(([name]) => !(name === 'enabled' && MANDATORY_NODE_TYPES.has(key)));
  const additions = offered.filter(([name]) => declared[name] === undefined);
  if (additions.length === 0) return schema;
  return Object.freeze({ ...schema, properties: Object.freeze({ ...declared, ...Object.fromEntries(additions) }) });
}

/**
 * The PUBLIC map: every authored schema with the palette-agnostic runtime knobs folded in. This
 * is what `node-registry.ts` attaches as `WorkflowNodeDescriptor.configSchema`, what
 * `GET /admin/workflow-nodes` serves, and what the Studio inspector compiles into fields.
 */
export const NODE_CONFIG_SCHEMAS: Readonly<Record<string, NodeConfigSchema>> = Object.freeze(
  Object.fromEntries(Object.entries(AUTHORED_NODE_CONFIG_SCHEMAS).map(([key, schema]) => [key, withRuntimeProperties(key, schema)])),
);
