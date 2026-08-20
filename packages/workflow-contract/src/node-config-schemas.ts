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
 * Two node types are DELIBERATELY left with no entry (`configSchema: undefined` on the
 * registry descriptor, same posture the whole registry had for every node until this file):
 *
 * - `passthrough` — "echoes its own config back as output" (`activities.py`'s own docstring);
 *   its whole purpose is accepting an arbitrary payload verbatim, so a fixed schema would be
 *   a false constraint, not a documentation of a real one. The inspector's existing raw-JSON
 *   fallback (`registry.contract.md`'s Task 9 discipline) is the CORRECT rendering for this
 *   node, not a gap.
 * - `consultation.*` (13 node types) — `node-types.md`'s own "Config schemas" section names
 *   the files (`contracts/nodes/*.schema.json`) but they were never authored; inventing
 *   thirteen clinical-workflow config contracts without that validated source would be a new
 *   design decision, not wiring up an existing one. Left as an open item (README §6/§7), same
 *   as this module's own docstring above documents for `passthrough`.
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

const PROMPT_TEMPLATE_REF_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/prompt.template_ref.schema.json',
  title: 'prompt.template_ref node config (N-2, safety class: optional)',
  type: 'object',
  additionalProperties: false,
  required: ['promptTemplateId'],
  properties: {
    promptTemplateId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
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
    taskKey: { type: 'string', enum: ['smr.finalize', 'smr.live', 'smr.test'] },
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
    onFail: { type: 'string', enum: ['mark', 'abort'] },
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
});
