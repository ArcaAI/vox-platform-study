/**
 * The Agent entity's TASK-TYPED configuration contract (TASK-863 §3.2).
 *
 * An Agent performs exactly one task — `SPEECH_TO_TEXT`, `TEXT_GENERATION`, `TEXT_TO_SPEECH` or
 * `NAMED_ENTITY_RECOGNITION` (TASK-930) — on ONE registered model (plus ordered fallbacks of the same task). Its `parameters` and
 * `instruction` are typed per task, and its `inputSchema` / `outputSchema` default per task so a
 * workflow `core.agent` node (TASK-864), an SDK caller (TASK-865) and the generated OpenAPI all
 * agree on what goes in and what comes out.
 *
 * This module is PURE and shared: the applications layer runs `jsonSchemaValueProblems` from
 * `@arcaai/json-schema-subset` over `AGENT_PARAMETER_SCHEMAS[task]`, and `agentConfigProblems`
 * for what a JSON Schema cannot express; the console's create wizard renders
 * `AGENT_PARAMETER_SCHEMAS[task]` through the same field-descriptor renderer the Studio inspector
 * uses. One definition, three consumers.
 *
 * Reference-only rule: an agent never names an engine, an endpoint or a credential. The model
 * row (`Agent.modelId`) decides engine, format, weights location and provider; every auxiliary
 * model in the ASR spec is a registry SLUG; the credential is the tenant's (or SYSTEM's)
 * `AiProviderConnection(service ← task, provider ← model)` row. `FORBIDDEN_CONFIG_KEYS`
 * applies to the agent's own JSON columns exactly as it applies to a workflow graph.
 *
 * The generation hyper-parameter / tool / guard shapes deliberately MIRROR the `agentic.agent`
 * node's (`node-config-schemas.ts`); they are duplicated here rather than exported from that
 * file because the node catalogue is being replaced by `core.*` (TASK-864) and the agent's
 * schema must outlive it.
 */
import {
  AGENT_PROMPT_CONDITION_MAX_DEPTH,
  AGENT_PROMPT_CONDITION_MAX_LENGTH,
  AGENT_PROMPT_FRAGMENT_KEY_PATTERN,
  AGENT_PROMPT_FRAGMENT_MAX,
  conditionNestingDepth,
} from './agent-instruction';
import { FORBIDDEN_CONFIG_KEYS, hyperparameterCapabilityProblems, type ProviderGenerationCapabilities } from './agentic-contract';
import { canonicalJson } from './canonical-json';
import { expressionProblems } from './expressions';
import type { NodeConfigSchema } from './node-config-schemas';

// =============================================================================================
// Task taxonomy
// =============================================================================================

export const AGENT_TASKS = Object.freeze(['SPEECH_TO_TEXT', 'TEXT_GENERATION', 'TEXT_TO_SPEECH', 'NAMED_ENTITY_RECOGNITION'] as const);
export type AgentTask = (typeof AGENT_TASKS)[number];

/**
 * The `AiProviderConnection.service` an agent's credential resolves under, per task.
 *
 * `null` for `NAMED_ENTITY_RECOGNITION` (TASK-930): token classification is served by
 * `apps/nlp` from platform-hosted weights, and `AiProviderConnection.service` has exactly three
 * members (`stt` / `llm` / `tts`). A NER agent therefore has no BYO credential tier — it is
 * always `platform-self-host`, and a resolver must SKIP the override lookup rather than invent a
 * service for it. `MODEL_TASK_TYPE_SERVICE[TOKEN_CLASSIFICATION]` is `null` for the same reason.
 */
export const AGENT_TASK_SERVICE: Readonly<Record<AgentTask, 'stt' | 'llm' | 'tts' | null>> = Object.freeze({
  SPEECH_TO_TEXT: 'stt',
  TEXT_GENERATION: 'llm',
  TEXT_TO_SPEECH: 'tts',
  NAMED_ENTITY_RECOGNITION: null,
});

/** The registry `AiModel.taskType` a model must carry to back an agent of each task. */
export const AGENT_TASK_MODEL_TASK_TYPE: Readonly<Record<AgentTask, string>> = Object.freeze({
  SPEECH_TO_TEXT: 'AUTOMATIC_SPEECH_RECOGNITION',
  TEXT_GENERATION: 'TEXT_GENERATION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
  NAMED_ENTITY_RECOGNITION: 'TOKEN_CLASSIFICATION',
});

/**
 * TASK-890 §3.3 — a dotted run-scope path, the SAME shape the template grammar's `path` accepts
 * (`ident ( "." ident )*`). Kept as a string literal so it can sit in a JSON Schema `pattern`
 * and be read by `agentConfigProblems` from one place — a binding whose path the renderer could
 * never parse is a defect at authoring time, not a surprise at render time.
 */
export const PROMPT_VARIABLE_PATH_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$';

export type AgentProtocol = 'http' | 'http-sse' | 'socket';

/** The invocation protocols each task publishes (TASK-863 §3.5). */
export const AGENT_PROTOCOLS: Readonly<Record<AgentTask, readonly AgentProtocol[]>> = Object.freeze({
  SPEECH_TO_TEXT: Object.freeze(['http', 'socket'] as const),
  TEXT_GENERATION: Object.freeze(['http', 'http-sse'] as const),
  TEXT_TO_SPEECH: Object.freeze(['http', 'http-sse'] as const),
  // TASK-930 — one-shot: the whole document is classified in a single pass, so there is nothing
  // to stream and no session to hold open. `?mode=stream` on a NER agent is refused, not degraded.
  NAMED_ENTITY_RECOGNITION: Object.freeze(['http'] as const),
});

export function isAgentTask(value: unknown): value is AgentTask {
  return typeof value === 'string' && (AGENT_TASKS as readonly string[]).includes(value);
}

// =============================================================================================
// Shared property shapes
// =============================================================================================

/** A registry model reference — always a SLUG, resolved through the tenant → SYSTEM cascade. */
const MODEL_SLUG_PROPERTY = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-z0-9][a-z0-9._-]{0,127}$',
  description: 'A registry `AiModel.slug` REFERENCE (filtered by task type). Never an engine name, an endpoint or a credential.',
});

const ROW_ID_PROPERTY = Object.freeze({ type: 'string', minLength: 1, maxLength: 64 });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const GENERATION_PROPERTY: NodeConfigSchema = Object.freeze({
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
    // TASK-891 C1 (OD-4) — the agent's REASONING posture. `enabled: false` reaches the
    // engine as `reasoning_effort: 'minimal'` (its own off switch), never as silence.
    // Measured on gemma-4-e2b-it-qat 2026-09-07: unset -> 5168ms / 184 reasoning tokens;
    // 'minimal' -> 1237ms / 30. `low` behaves like unset, so on this engine the dial is
    // effectively binary — do not read the four values as a gradient.
    reasoning: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['enabled']),
      properties: Object.freeze({
        enabled: Object.freeze({ type: 'boolean' }),
        effort: Object.freeze({ type: 'string', enum: Object.freeze(['minimal', 'low', 'medium', 'high']) }),
      }),
      description: 'Whether the engine is asked to reason, and how hard. Rides `GenerateRequest.extra.reasoning_effort` -> `extra_body`.',
    }),
  }),
  description: 'Generation hyper-parameters. Every key is capability-gated against the bound provider configuration — never silently dropped.',
});

/** Guardrail POLICY keys (resolved per tenant by `apps/guardrail`); TASK-864 compiles them into `core.classify` / `core.action(guard.*)` nodes around the agent. */
const GUARD_POLICY_LIST = Object.freeze({
  type: 'array',
  maxItems: 8,
  items: Object.freeze({ type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9_.-]{1,64}$' }),
});

const GUARDS_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    // TASK-890 §3.14 (OD-R clause 3) — the AGENT-level guardrail default, the bottom of the
    // node > workflow > agent > `true` precedence `resolveGuardrailDecision` implements.
    // ABSENT MEANS ON: guardrail is platform-managed and screening is the floor a tenant opts
    // OUT of, per agent, never a switch it has to remember to turn on. A `false` here is
    // recorded three ways — a publish WARNING (`GUARDRAIL_OPTED_OUT`), the per-call usage
    // attribute `guardrail: 'opted_out'`, and the TEXT response's own `reason` — so the
    // omission is attributable rather than merely permitted.
    enabled: Object.freeze({
      type: 'boolean',
      default: true,
      description:
        'Whether platform guardrail screens this agent`s input and output. Absent = on. A `core.agent` node or the workflow`s trigger may override it; nothing can turn a platform kill-switch back on.',
    }),
    input: GUARD_POLICY_LIST,
    output: GUARD_POLICY_LIST,
  }),
  description: 'Guardrail policy keys applied to this agent`s input / output. References, never thresholds or model ids.',
});

const TENANT_IO_SCHEMA_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  description: 'A tenant-defined JSON Schema (authorable subset) describing the payload crossing this boundary.',
});

/** Tool bindings — `(mcpServerId, toolName)` references and NOTHING else; the row carries `baseUrl`/`authRef`/allowlist. */
export const AGENT_TOOLS_SCHEMA: NodeConfigSchema = Object.freeze({
  type: 'array',
  maxItems: 32,
  items: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['mcpServerId', 'toolName']),
    properties: Object.freeze({
      mcpServerId: ROW_ID_PROPERTY,
      toolName: Object.freeze({ type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]{1,128}$' }),
    }),
  }),
  description: 'Tools this agent may call, as (server, tool) REFERENCES. TEXT_GENERATION only.',
});

/**
 * TASK-876 — fallback governance, declared ONCE on the contract.
 *
 * Fallback is a platform HA capability (TASK-870 owner decision #4): every agent falls back on
 * outage, ON by default, to the platform default (the SYSTEM-assigned agent of the same task),
 * metered as platform-funded; the toggle is per agent node. These two defaults used to be
 * re-typed as literals by each runtime builder — TASK-880 finished that: the ASR builder's own
 * copy is gone and `build-resolved-asr-spec.ts` re-exports THIS declaration under this name.
 */
export const AGENT_FALLBACK_DEFAULTS = Object.freeze({ autoSwitch: true, switchAfterConsecutiveFailures: 2 });

export interface AgentFallbackGovernance {
  /** Another agent of the SAME task (lineage slug) to switch to; `null` ⇒ the agent's own model chain, then the platform default. */
  readonly agentSlug: string | null;
  readonly autoSwitch: boolean;
}

/**
 * The `parameters.fallback` block with the declared defaults applied. Tolerant: a malformed
 * block reads as the defaults — the JSON Schema is where a bad shape is refused, and a runtime
 * that threw here would fail a consultation over a field the validator already screened.
 */
export function readAgentFallbackGovernance(parameters: unknown): AgentFallbackGovernance {
  const block = isPlainObject(parameters) && isPlainObject(parameters.fallback) ? parameters.fallback : {};
  const slug = block.agentSlug;
  return {
    agentSlug: typeof slug === 'string' && slug.length > 0 ? slug : null,
    autoSwitch: typeof block.autoSwitch === 'boolean' ? block.autoSwitch : AGENT_FALLBACK_DEFAULTS.autoSwitch,
  };
}

/**
 * The fallback block for one task.
 *
 * `switchAfterConsecutiveFailures` is declared for SPEECH_TO_TEXT ONLY, and that asymmetry is
 * deliberate. A threshold needs a runtime that COUNTS across calls, which is what
 * `stt/streaming/session_manager.py` is — it holds a session and switches after N consecutive
 * failures. Both TEXT lanes are per-call: the live flush and the `core.agent` / `generate`
 * activities switch on the FIRST failure of the call they are in and keep no cross-call state, so
 * a TEXT threshold would be a tenant-settable, schema-validated knob with no reader at all.
 * Owner rule: no dead knobs. If a session-scoped text runtime ever appears, reinstate it here
 * together with its reader.
 */
function fallbackProperty(task: AgentTask): NodeConfigSchema {
  const threshold =
    task === 'SPEECH_TO_TEXT'
      ? {
          switchAfterConsecutiveFailures: Object.freeze({
            type: 'integer',
            minimum: 1,
            maximum: 20,
            default: AGENT_FALLBACK_DEFAULTS.switchAfterConsecutiveFailures,
          }),
        }
      : {};
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({
      agentSlug: Object.freeze({
        type: 'string',
        minLength: 2,
        maxLength: 80,
        pattern: '^[a-z0-9][a-z0-9-]{1,79}$',
        description: `Another ${task} agent (lineage slug) to switch to. Absent ⇒ this agent\`s own model fallback chain, then the platform default.`,
      }),
      autoSwitch: Object.freeze({
        type: 'boolean',
        default: AGENT_FALLBACK_DEFAULTS.autoSwitch,
        description: 'The per-agent HA toggle: switch to the fallback chain on primary failure. ON by default (platform HA capability).',
      }),
      ...threshold,
    }),
    description:
      'Fallback governance. Where the chain leads is a REFERENCE (an agent slug) or the agent`s own model chain; the platform default always terminates it.',
  });
}

// =============================================================================================
// Parameter schemas per task (§3.2)
// =============================================================================================

const TEXT_GENERATION_PARAMETERS: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/agents/TEXT_GENERATION.parameters.schema.json',
  title: 'TEXT_GENERATION agent parameters',
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    generation: GENERATION_PROPERTY,
    responseFormat: Object.freeze({ type: 'string', enum: Object.freeze(['text', 'json', 'json_schema']), default: 'text' }),
    responseSchema: TENANT_IO_SCHEMA_PROPERTY,
    memory: Object.freeze({
      type: 'string',
      enum: Object.freeze(['none', 'conversation']),
      default: 'none',
      description: 'Conversation memory is DEFERRED (open question 3): day-1 runtimes accept only `none`.',
    }),
    guards: GUARDS_PROPERTY,
    fallback: fallbackProperty('TEXT_GENERATION'),
  }),
});

const SPEECH_TO_TEXT_PARAMETERS: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/agents/SPEECH_TO_TEXT.parameters.schema.json',
  title: 'SPEECH_TO_TEXT agent parameters — the ASR spec of TASK-861 §3.2 (the primary ASR model is `Agent.modelId`)',
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    audioFrontEnd: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        vad: Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties: Object.freeze({
            modelSlug: Object.freeze({ ...MODEL_SLUG_PROPERTY, description: 'Registry slug of a `VOICE_ACTIVITY_DETECTION` model.' }),
            threshold: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }),
            minSpeechMs: Object.freeze({ type: 'integer', minimum: 0, maximum: 10000 }),
            minSilenceMs: Object.freeze({ type: 'integer', minimum: 0, maximum: 10000 }),
            speechPadMs: Object.freeze({
              type: 'integer',
              minimum: 0,
              maximum: 5000,
              description:
                'TASK-880 — padding applied to BOTH ends of a detected segment, ms. Replaces the platform key `stt.vad.speechPadMs`: how much lead-in and tail a clinic wants around speech is a tuning choice like the three above it, not a property of the box. Optional; the runtime keeps its own default when absent.',
            }),
          }),
        }),
        denoise: Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties: Object.freeze({
            modelSlug: Object.freeze({ ...MODEL_SLUG_PROPERTY, description: 'Registry slug of an `AUDIO_TO_AUDIO` model.' }),
            level: Object.freeze({ type: 'string', enum: Object.freeze(['off', 'low', 'medium', 'high']) }),
          }),
        }),
        // TASK-887 (owner decision, target model item 8) — diarization is a DECLARED agent
        // option, OFF by default. The agent names the speaker-embedding model, and that model
        // IS the space enrolled `UserVoiceProfile` rows live in; there is no platform
        // `stt.diarization.hfModelId` behind it any more. With `backend: 'embedding'` and
        // `enabled: true`, `embeddingModelSlug` is REQUIRED in practice —
        // `buildResolvedAsrSpec` refuses the spec (409 `ASR_AGENT_DIARIZATION_MODEL_MISSING`)
        // rather than silently substituting one, because model SELECTION fails closed.
        diarization: Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties: Object.freeze({
            enabled: Object.freeze({ type: 'boolean', default: false }),
            backend: Object.freeze({ type: 'string', enum: Object.freeze(['embedding', 'sortformer']), default: 'embedding' }),
            embeddingModelSlug: Object.freeze({
              ...MODEL_SLUG_PROPERTY,
              // `modelTaskType` is an ANNOTATION, not a validation keyword: it tells an editor
              // which registry rows are selectable here so the admin picks from the tenant's
              // `SPEAKER_EMBEDDING` catalogue instead of typing a slug. Unknown keywords are
              // ignored by `jsonSchemaValueProblems`, and it is not a property NAME, so
              // `forbiddenSchemaKeyProblems` does not see it either.
              modelTaskType: 'SPEAKER_EMBEDDING',
              description:
                'Registry slug of a `SPEAKER_EMBEDDING` model — the vector space this agent diarizes in AND the space its users enroll their voice profiles in. Required when diarization is enabled with the `embedding` backend.',
            }),
            maxSpeakers: Object.freeze({ type: 'integer', minimum: 1, maximum: 16 }),
            matchThreshold: Object.freeze({
              type: 'number',
              minimum: 0,
              maximum: 1,
              default: 0.6,
              description:
                'TASK-887 — cosine floor for attaching an ENROLLED voice profile\u2019s label to a segment, and the cross-sample consistency floor enrollment must clear. Replaces the platform key `stt.voiceProfile.minSimilarity`. Below it the segment is labelled generically (`Speaker N`); a real clinician name is never attached on a weak match. Optional; the runtime keeps its own default when absent.',
            }),
          }),
        }),
        resample: Object.freeze({ type: 'boolean' }),
        normalize: Object.freeze({ type: 'boolean' }),
      }),
    }),
    decoding: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        languageMode: Object.freeze({ type: 'string', enum: Object.freeze(['en', 'ml', 'ml-en', 'vi', 'vi-en', 'auto']) }),
        codeSwitching: Object.freeze({ type: 'boolean' }),
        wordTimestamps: Object.freeze({ type: 'boolean' }),
        beamSize: Object.freeze({ type: 'integer', minimum: 1, maximum: 10 }),
        temperature: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }),
        vadFilter: Object.freeze({ type: 'boolean' }),
        chunkLengthSec: Object.freeze({
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: 'TASK-877 (owner decision #9) — batch chunk length in seconds. Optional; the runtime keeps its own default when absent.',
        }),
        strideLengthSec: Object.freeze({
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: Object.freeze({ type: 'number', minimum: 0, maximum: 30 }),
          description:
            "TASK-877 (owner decision #9) — `[left, right]` overlap in seconds around each chunk. TASK-880 corrected the type: the wire field, `buildResolvedAsrSpec`'s reader and the committed contract fixture have always been a PAIR, so a scalar here made the value an agent could author and the value the runtime consumes different things. Optional.",
        }),
        // TASK-934 (gap G-2, owner decision OD-4) — the six knobs that decided transcription
        // quality from a Python literal in `InferenceConfig`: no wire field, no schema key, no
        // settings descriptor, one number for every agent and every tenant on the box. They are
        // settable at BOTH tiers now — here, and on the assigned model's `_metadata.asr` decode
        // profile — resolved agent → model profile → engine default (OD-3). The ranges below are
        // the literal mirror of `AI_MODEL_ASR_PROFILE_DECODING_RANGES` in `@arcaai/types`: two
        // tiers feeding one engine field must accept exactly the same values.
        noSpeechThreshold: Object.freeze({
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'TASK-934 — above this no-speech probability a decoded segment is discarded. Raise it when the model hallucinates over silence, lower it when quiet speech is dropped. Optional; unset ⇒ the assigned model`s profile, then the engine default (0.6).',
        }),
        compressionRatioThreshold: Object.freeze({
          type: 'number',
          minimum: 1,
          maximum: 10,
          description:
            'TASK-934 — gzip compression ratio above which a decode is treated as looping and retried at a higher temperature. Optional; unset ⇒ the assigned model`s profile, then the engine default (2.4).',
        }),
        logprobThreshold: Object.freeze({
          type: 'number',
          minimum: -10,
          maximum: 0,
          description:
            'TASK-934 — average token log-probability floor below which a decode is retried. Optional; unset ⇒ the assigned model`s profile, then the engine default (-1.0).',
        }),
        conditionOnPrevTokens: Object.freeze({
          type: 'boolean',
          description:
            'TASK-934 — feed the previous window`s tokens to the decoder as context. Improves continuity across windows and is the classic Whisper repetition-loop risk, which is why it is a per-agent (and per-fine-tune) choice. Optional; unset ⇒ the assigned model`s profile, then the engine default (false).',
        }),
        noRepeatNgramSize: Object.freeze({
          type: 'integer',
          minimum: 0,
          maximum: 10,
          description:
            'TASK-934 — block repeats of an n-gram this long within one decode (0 disables). Optional; unset ⇒ the assigned model`s profile, then the engine default (3).',
        }),
        prevTextContextWords: Object.freeze({
          type: 'integer',
          minimum: 0,
          maximum: 200,
          description:
            'TASK-934 — how many words of already-committed text ride as decoder context on the next window. Optional; unset ⇒ the assigned model`s profile, then the engine default (50).',
        }),
      }),
    }),
    postProcessing: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        punctuation: Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties: Object.freeze({
            enabled: Object.freeze({ type: 'boolean' }),
            modelSlug: Object.freeze({ ...MODEL_SLUG_PROPERTY, description: 'Registry slug of a `TOKEN_CLASSIFICATION` punctuation model.' }),
          }),
        }),
        disfluency: Object.freeze({ type: 'boolean' }),
        stabilizer: Object.freeze({ type: 'boolean' }),
        merge: Object.freeze({ type: 'boolean' }),
        // TASK-935 (OD-2 a / OD-5 a) — deterministic clinical-vocabulary correction, the
        // SECOND consumer of `instruction.hotwords`. TASK-934 made those terms bias the
        // decoder prompt; three runs proved prompt bias cannot reach a token sequence a
        // fine-tune never learned ("ceftriaxone" decodes as "septrioxone" every time), so
        // the same list also snaps the decoded text. There is deliberately NO `terms` key
        // here: a second list would be free to drift from the one that primes the decoder,
        // and an admin who names a term means it in both places (OD-5 a).
        lexicon: Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties: Object.freeze({
            enabled: Object.freeze({
              type: 'boolean',
              description:
                'TASK-935 — snap decoded words onto `instruction.hotwords` when they agree phonetically and differ by no more than `maxDistance` of their characters. Optional; unset ⇒ ON exactly when the resolved hotword list is non-empty, because a term named for the decoder is a term the clinician expects to read back.',
            }),
            maxDistance: Object.freeze({
              type: 'number',
              minimum: 0.1,
              maximum: 0.5,
              description:
                'TASK-935 — normalised edit distance (`lev / max(len)`) at which a decoded word may be snapped to a configured term. Lower is stricter. Optional; unset ⇒ the engine default (0.34). An exact phonetic match earns twice this, capped at 0.5, so no correction ever rewrites more than half of a word.',
            }),
          }),
          description:
            'TASK-935 — clinical-vocabulary correction over `instruction.hotwords` (one list, two consumers: decoder prompt bias and this stage). It runs after punctuation and disfluency removal, on partials and finals alike, and can only ever produce a term the tenant configured. Optional; unset ⇒ enabled exactly when there are hotwords.',
        }),
      }),
    }),
    streaming: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        partialIntervalMs: Object.freeze({ type: 'integer', minimum: 100, maximum: 5000 }),
        // TASK-934 (OD-4) — how much of the live utterance's TAIL is re-decoded for each partial.
        // Distinct from the model row's `maxDecodeWindowSec`, which bounds a FINAL decode and stays
        // model geometry (OD-3): §2.2 measured 31 % garbage partials at a 6 s tail against 0 % at
        // 15 s on the same weights, so the partial window is a streaming-behaviour choice an agent
        // may take. Set here it OVERRIDES the assigned model's `partialWindowSec`.
        partialWindowSec: Object.freeze({
          type: 'number',
          minimum: 1,
          maximum: 30,
          description:
            'TASK-934 — seconds of the live utterance`s tail re-decoded for each partial. Longer settles the language model (fewer garbage partials) at the cost of decode time. Optional; unset ⇒ the assigned model`s `partialWindowSec`, then the runtime default.',
        }),
        endpointing: Object.freeze({ type: 'string', enum: Object.freeze(['fixed', 'semantic']) }),
        maxUtteranceSec: Object.freeze({ type: 'integer', minimum: 1, maximum: 600 }),
        semantic: Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties: Object.freeze({
            modelSlug: Object.freeze({
              ...MODEL_SLUG_PROPERTY,
              description: 'Registry slug of the end-of-utterance model — the `endpointing` role of the resolved ASR spec (TASK-877).',
            }),
            minSilenceMs: Object.freeze({ type: 'integer', minimum: 0, maximum: 10000 }),
            maxSilenceMs: Object.freeze({ type: 'integer', minimum: 0, maximum: 30000 }),
            confidenceThreshold: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }),
            minWords: Object.freeze({ type: 'integer', minimum: 0, maximum: 64 }),
          }),
          description: 'Semantic endpointing tuning (`streaming.endpointing: semantic`). Optional; the runtime keeps its own defaults when absent.',
        }),
      }),
    }),
    fallback: fallbackProperty('SPEECH_TO_TEXT'),
  }),
});

const TEXT_TO_SPEECH_PARAMETERS: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/agents/TEXT_TO_SPEECH.parameters.schema.json',
  title: 'TEXT_TO_SPEECH agent parameters',
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    voice: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'A voice identifier within the bound model`s catalogue (`AiModel.metaData.voices`).',
    }),
    language: Object.freeze({ type: 'string', minLength: 2, maxLength: 16 }),
    speed: Object.freeze({ type: 'number', minimum: 0.25, maximum: 4 }),
    format: Object.freeze({ type: 'string', enum: Object.freeze(['wav', 'mp3', 'ogg', 'pcm']) }),
    sampleRate: Object.freeze({ type: 'integer', enum: Object.freeze([8000, 16000, 22050, 24000, 44100, 48000]) }),
    ssml: Object.freeze({ type: 'boolean', description: 'Capability-gated: refused at publish unless the bound provider declares SSML support.' }),
    // TASK-879 — the speech path became agent-first, so a TTS agent needs the same HA governance
    // the other two tasks have. `AgentModelFallback` was always task-agnostic; what was missing was
    // a way to SAY it, so an operator could bind a fallback engine and nothing would read it.
    // No `switchAfterConsecutiveFailures`, for the reason `fallbackProperty` records: synthesis is
    // per-request and switches on the first failure, keeping no cross-call state a threshold could
    // count. Owner rule: no dead knobs.
    fallback: fallbackProperty('TEXT_TO_SPEECH'),
  }),
});

/**
 * TASK-876/877 — where the ASR spec references the end-of-utterance model. The agent resolver
 * materialises it as the `endpointing` role once `ResolvedAgentModelRole` (`@arcaai/types`)
 * carries that member; the path itself is contract, so it lives beside the schema.
 */
export const ASR_ENDPOINTING_MODEL_SLUG_PATH: readonly string[] = Object.freeze(['streaming', 'semantic', 'modelSlug']);

/**
 * TASK-930 — the two knobs `apps/nlp`'s `POST /api/v1/classify/tokens` actually acts on.
 *
 * No `model`, no `labels` (that is the INSTRUCTION — what to look for, not how hard to look),
 * and no fallback governance: token classification is a single platform-hosted pass with no
 * provider to fail over to, so a `fallback` block here would be a dead knob.
 */
const NAMED_ENTITY_RECOGNITION_PARAMETERS: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    threshold: Object.freeze({
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Minimum span confidence to emit. Unset = the checkpoint`s own default.',
    }),
    aggregation: Object.freeze({
      type: 'string',
      enum: Object.freeze(['simple', 'first', 'max', 'average']),
      description: 'How sub-token scores are combined into one span score (the token-classification aggregation strategy).',
    }),
  }),
});

export const AGENT_PARAMETER_SCHEMAS: Readonly<Record<AgentTask, NodeConfigSchema>> = Object.freeze({
  SPEECH_TO_TEXT: SPEECH_TO_TEXT_PARAMETERS,
  TEXT_GENERATION: TEXT_GENERATION_PARAMETERS,
  TEXT_TO_SPEECH: TEXT_TO_SPEECH_PARAMETERS,
  NAMED_ENTITY_RECOGNITION: NAMED_ENTITY_RECOGNITION_PARAMETERS,
});

// =============================================================================================
// Instruction schemas per task (§3.2) — `null` where the task carries none
// =============================================================================================

const EVAL_GATE_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({ goldenSetId: ROW_ID_PROPERTY, enabled: Object.freeze({ type: 'boolean' }) }),
});

/**
 * TASK-890 §3.1 / §3.3 (OD-K) — `instruction.variables` is a map of BINDINGS, not of strings.
 *
 * `{ value: "…" }` is a literal; `{ path: "context.patientAge" }` is resolved from the run scope
 * BEFORE the bare-name overlay, which is what makes `{{age}}` and `{{context.patientAge}}` the
 * same value in one template (§3.3). The retired flat-string form is REFUSED rather than read as
 * a literal: a flat string cannot express the path half, so accepting it would silently pin a
 * variable that the author meant to bind to the consultation's context.
 *
 * `agentConfigProblems` repeats this rule with a named message, because a tenant hitting it is
 * mid-migration and "matches none of the `anyOf` branches" does not tell them what to write.
 */
const PROMPT_VARIABLE_BINDINGS_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: Object.freeze({
    anyOf: Object.freeze([
      Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['value']),
        properties: Object.freeze({ value: Object.freeze({ type: 'string', maxLength: 4000 }) }),
      }),
      Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['path']),
        properties: Object.freeze({
          path: Object.freeze({ type: 'string', minLength: 1, maxLength: 256, pattern: PROMPT_VARIABLE_PATH_PATTERN }),
        }),
      }),
    ]),
    description: 'Exactly one of `value` (a literal) or `path` (a dotted run-scope path). Never a bare string.',
  }),
  description: 'Bindings for the instruction template`s variables, by name.',
});

/**
 * TASK-947 (OD-2) — one fragment of a COMPOSITE instruction: exactly one of `promptTemplateId` /
 * `systemPrompt` (the keyword schema cannot say "exactly one"; `fragmentProblems` does), a pin
 * only beside a template, and an optional CEL `when` over the render scope. Absent `when` means
 * "always included" — and at least one fragment must be that (OD-6).
 */
const PROMPT_FRAGMENT_SCHEMA: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['key']),
  properties: Object.freeze({
    key: Object.freeze({
      type: 'string',
      pattern: AGENT_PROMPT_FRAGMENT_KEY_PATTERN,
      description: 'Names the fragment in findings, the bench and telemetry. Unique in the list.',
    }),
    promptTemplateId: ROW_ID_PROPERTY,
    promptVersionNumber: Object.freeze({ type: 'integer', minimum: 1 }),
    systemPrompt: Object.freeze({ type: 'string', minLength: 1, maxLength: 50000 }),
    when: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: AGENT_PROMPT_CONDITION_MAX_LENGTH,
      description:
        'CEL over the render scope (`context.*`, `trigger.*`, `input.*`, `vars.*`, `nodes.*`, bound names). Absent = always included. Guard a possibly-missing field with `has(context.field)`.',
    }),
  }),
});

const PROMPT_FRAGMENTS_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'array',
  minItems: 1,
  maxItems: AGENT_PROMPT_FRAGMENT_MAX,
  items: PROMPT_FRAGMENT_SCHEMA,
  description: 'Ordered prompt fragments; the selected ones are rendered separately and joined. Exclusive with `promptTemplateId` / `systemPrompt`.',
});

/** Exactly one of `promptTemplateId`, `systemPrompt` or `fragments` (TASK-947) — enforced by `agentConfigProblems`. */
const TEXT_GENERATION_INSTRUCTION: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    promptTemplateId: ROW_ID_PROPERTY,
    promptVersionNumber: Object.freeze({ type: 'integer', minimum: 1 }),
    variables: PROMPT_VARIABLE_BINDINGS_PROPERTY,
    systemPrompt: Object.freeze({ type: 'string', minLength: 1, maxLength: 50000 }),
    fragments: PROMPT_FRAGMENTS_PROPERTY,
    evalGate: EVAL_GATE_PROPERTY,
  }),
});

const SPEECH_TO_TEXT_INSTRUCTION: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    initialPrompt: Object.freeze({
      type: 'string',
      maxLength: 1000,
      description: 'Decoder initial prompt (≤ 224 tokens; the character cap is a floor on nonsense).',
    }),
    hotwords: Object.freeze({ type: 'array', maxItems: 64, items: Object.freeze({ type: 'string', minLength: 1, maxLength: 64 }) }),
  }),
});

/**
 * TASK-930 — a NER agent's instruction is its LABEL SET, and nothing else.
 *
 * Zero-shot checkpoints (GLiNER-style) take the list on the wire; fixed-label checkpoints
 * (`medical-ner`) ignore it and emit their own schema. Declaring it either way is deliberate:
 * the agent says what the author is looking for, and the model row decides whether that request
 * is honoured — the same reference-only posture the other three tasks have.
 */
const NAMED_ENTITY_RECOGNITION_INSTRUCTION: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    labels: Object.freeze({
      type: 'array',
      maxItems: 64,
      items: Object.freeze({ type: 'string', minLength: 1, maxLength: 64 }),
      description: 'The entity types to extract. Honoured by zero-shot checkpoints; ignored by fixed-label ones.',
    }),
  }),
});

export const AGENT_INSTRUCTION_SCHEMAS: Readonly<Record<AgentTask, NodeConfigSchema | null>> = Object.freeze({
  SPEECH_TO_TEXT: SPEECH_TO_TEXT_INSTRUCTION,
  TEXT_GENERATION: TEXT_GENERATION_INSTRUCTION,
  TEXT_TO_SPEECH: null,
  NAMED_ENTITY_RECOGNITION: NAMED_ENTITY_RECOGNITION_INSTRUCTION,
});

// =============================================================================================
// Default I/O schemas per task (§3.2)
// =============================================================================================

export interface AgentIoDefaults {
  readonly inputSchema: NodeConfigSchema;
  readonly outputSchema: NodeConfigSchema;
}

const TRANSCRIPT_SEGMENT_SCHEMA: NodeConfigSchema = Object.freeze({
  type: 'object',
  required: Object.freeze(['text', 'start', 'end']),
  properties: Object.freeze({
    text: Object.freeze({ type: 'string' }),
    start: Object.freeze({ type: 'number', minimum: 0 }),
    end: Object.freeze({ type: 'number', minimum: 0 }),
    speaker: Object.freeze({ type: 'string' }),
    isFinal: Object.freeze({ type: 'boolean' }),
    words: Object.freeze({
      type: 'array',
      items: Object.freeze({
        type: 'object',
        required: Object.freeze(['text', 'start', 'end']),
        properties: Object.freeze({
          text: Object.freeze({ type: 'string' }),
          start: Object.freeze({ type: 'number', minimum: 0 }),
          end: Object.freeze({ type: 'number', minimum: 0 }),
        }),
      }),
    }),
  }),
});

export const AGENT_IO_DEFAULTS: Readonly<Record<AgentTask, AgentIoDefaults>> = Object.freeze({
  TEXT_GENERATION: Object.freeze({
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['text']),
      properties: Object.freeze({
        text: Object.freeze({ type: 'string', minLength: 1, description: 'The user turn / the document to operate on.' }),
        variables: Object.freeze({
          type: 'object',
          additionalProperties: Object.freeze({ type: 'string' }),
          description: 'Prompt-template variables (override the agent`s bound defaults).',
        }),
      }),
    }),
    outputSchema: Object.freeze({
      type: 'object',
      required: Object.freeze(['text']),
      properties: Object.freeze({ text: Object.freeze({ type: 'string' }) }),
    }),
  }),
  SPEECH_TO_TEXT: Object.freeze({
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['audio']),
      properties: Object.freeze({
        audio: Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: Object.freeze(['kind']),
          properties: Object.freeze({
            kind: Object.freeze({ type: 'string', enum: Object.freeze(['artifact', 'stream']) }),
            mediaId: Object.freeze({ type: 'string', description: '`artifact`: an uploaded media row.' }),
            sessionId: Object.freeze({ type: 'string', description: '`stream`: a realtime STT session.' }),
          }),
        }),
        language: Object.freeze({ type: 'string', minLength: 2, maxLength: 16 }),
      }),
    }),
    outputSchema: Object.freeze({
      type: 'object',
      required: Object.freeze(['transcript']),
      properties: Object.freeze({
        transcript: Object.freeze({ type: 'array', items: TRANSCRIPT_SEGMENT_SCHEMA }),
        language: Object.freeze({ type: 'string' }),
      }),
    }),
  }),
  TEXT_TO_SPEECH: Object.freeze({
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        text: Object.freeze({ type: 'string', minLength: 1, maxLength: 20000 }),
        ssml: Object.freeze({ type: 'string', minLength: 1, maxLength: 40000 }),
      }),
      anyOf: Object.freeze([Object.freeze({ required: Object.freeze(['text']) }), Object.freeze({ required: Object.freeze(['ssml']) })]),
    }),
    outputSchema: Object.freeze({
      type: 'object',
      required: Object.freeze(['audio']),
      properties: Object.freeze({
        audio: Object.freeze({
          type: 'object',
          required: Object.freeze(['mediaId', 'format']),
          properties: Object.freeze({
            mediaId: Object.freeze({ type: 'string' }),
            format: Object.freeze({ type: 'string' }),
            sampleRate: Object.freeze({ type: 'integer' }),
          }),
        }),
        durationMs: Object.freeze({ type: 'integer', minimum: 0 }),
      }),
    }),
  }),
  // TASK-930 §2.3 — character OFFSETS into the submitted text, not a re-serialised copy of it.
  // `score` is optional because a fixed-label checkpoint may emit spans without one; everything
  // that locates the span is required, because a span the caller cannot find is not a finding.
  NAMED_ENTITY_RECOGNITION: Object.freeze({
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['text']),
      properties: Object.freeze({
        text: Object.freeze({ type: 'string', minLength: 1, description: 'The document to extract entities from.' }),
        language: Object.freeze({ type: 'string', minLength: 2, maxLength: 16 }),
      }),
    }),
    outputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['entities']),
      properties: Object.freeze({
        entities: Object.freeze({
          type: 'array',
          items: Object.freeze({
            type: 'object',
            additionalProperties: false,
            required: Object.freeze(['text', 'label', 'start', 'end']),
            properties: Object.freeze({
              text: Object.freeze({ type: 'string' }),
              label: Object.freeze({ type: 'string' }),
              start: Object.freeze({ type: 'integer', minimum: 0 }),
              end: Object.freeze({ type: 'integer', minimum: 0 }),
              score: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }),
            }),
          }),
        }),
      }),
    }),
  }),
});

// =============================================================================================
// agentConfigProblems — the checks a JSON Schema cannot express
// =============================================================================================

export interface AgentConfigView {
  readonly task: AgentTask;
  readonly parameters?: Readonly<Record<string, unknown>> | null;
  readonly instruction?: Readonly<Record<string, unknown>> | null;
  readonly inputSchema?: Readonly<Record<string, unknown>> | null;
  readonly outputSchema?: Readonly<Record<string, unknown>> | null;
  readonly tools?: readonly unknown[] | null;
  /**
   * TASK-890 §3.4 — the `ConsultationContextSchema` row this agent binds, by REFERENCE. The
   * contract has no database, so it checks only that the reference is WHOLE; resolving the row
   * (and refusing a SYSTEM or foreign id with `CONTEXT_SCHEMA_NOT_FOUND`) is the service's job,
   * and freezing the derived payload schema into `compiledConfig` is publish's.
   */
  readonly contextSchemaId?: string | null;
  readonly contextSchemaVersionNumber?: number | null;
}

/** The slice of a registry row the checks need. */
export interface AgentModelView {
  readonly slug: string;
  readonly taskType: string;
  readonly provider?: string;
}

export interface AgentProviderCapabilities extends ProviderGenerationCapabilities {
  /** TTS only: whether the bound provider accepts SSML input. `undefined` = unknown → WARNING. */
  readonly supportsSsml?: boolean;
}

export interface AgentConfigContext {
  readonly model?: AgentModelView;
  readonly fallbackModels?: readonly AgentModelView[];
  readonly capabilities?: AgentProviderCapabilities;
}

/**
 * TASK-947 — the problems the contract can NAME rather than leave to a path heuristic. Two
 * fragment problems share the path `instruction.fragments` and differ only in what went wrong,
 * so the applications layer's `codeForConfigProblem` reads `code` first when it is present.
 * Every pre-947 problem carries none; nothing downstream depends on it being set.
 */
export type AgentConfigProblemCode = 'PROMPT_FRAGMENT_SHAPE' | 'PROMPT_FRAGMENT_CONDITION_SYNTAX' | 'PROMPT_COMPOSITION_NO_BASE';

export interface AgentConfigProblem {
  readonly severity: 'ERROR' | 'WARNING';
  readonly path: string;
  readonly message: string;
  readonly code?: AgentConfigProblemCode;
}

/** Walk a JSON value for FORBIDDEN property names (exact, case-insensitive) — the agent-side form of rule 16. */
function forbiddenKeyProblems(value: unknown, path: string, out: AgentConfigProblem[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => forbiddenKeyProblems(entry, `${path}[${index}]`, out));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const at = `${path}.${key}`;
    if (FORBIDDEN_CONFIG_KEYS.has(key.toLowerCase())) {
      out.push({
        severity: 'ERROR',
        path: at,
        message: `\`${at}\` names a credential, an endpoint or a wire model — an agent carries REFERENCES only; the model row and the tenant's provider connection decide those.`,
      });
      continue;
    }
    forbiddenKeyProblems(entry, at, out);
  }
}

function modelTaskProblem(task: AgentTask, model: AgentModelView, path: string): AgentConfigProblem | undefined {
  const expected = AGENT_TASK_MODEL_TASK_TYPE[task];
  if (model.taskType === expected) return undefined;
  return {
    severity: 'ERROR',
    path,
    message: `Model \`${model.slug}\` has task type \`${model.taskType}\`; a ${task} agent must be backed by a \`${expected}\` model.`,
  };
}

/**
 * TASK-890 (OD-K) — `instruction.variables` entries are BINDINGS. The schema says the same thing
 * with `anyOf`; this says it in words, because a tenant hitting the rule is migrating off the
 * retired flat-string form and needs to be told what to write, not which branch failed.
 */
function variableBindingProblems(instruction: Record<string, unknown>, out: AgentConfigProblem[]): void {
  const variables = instruction.variables;
  if (variables === undefined) return;
  if (!isPlainObject(variables)) {
    out.push({ severity: 'ERROR', path: 'instruction.variables', message: '`instruction.variables` is a map of variable name -> binding.' });
    return;
  }
  const pathPattern = new RegExp(PROMPT_VARIABLE_PATH_PATTERN);
  for (const [name, binding] of Object.entries(variables)) {
    const at = `instruction.variables.${name}`;
    if (!isPlainObject(binding)) {
      out.push({
        severity: 'ERROR',
        path: at,
        message: `\`${at}\` is ${typeof binding === 'string' ? 'a bare string' : 'not an object'}; a binding is \`{ "value": "…" }\` (a literal) or \`{ "path": "context.field" }\` (resolved from the run scope).`,
      });
      continue;
    }
    const hasValue = binding.value !== undefined;
    const hasPath = binding.path !== undefined;
    if (hasValue === hasPath) {
      out.push({
        severity: 'ERROR',
        path: at,
        message: `\`${at}\` must declare exactly one of \`value\` (a literal) or \`path\` (a dotted run-scope path).`,
      });
      continue;
    }
    if (hasPath && (typeof binding.path !== 'string' || !pathPattern.test(binding.path))) {
      out.push({
        severity: 'ERROR',
        path: at,
        message: `\`${at}.path\` must be a dotted identifier path the template grammar can resolve (e.g. \`context.patientAge\`).`,
      });
    }
    if (hasValue && typeof binding.value !== 'string') {
      out.push({ severity: 'ERROR', path: at, message: `\`${at}.value\` must be a string.` });
    }
  }
}

function textGenerationInstructionProblems(instruction: Record<string, unknown>, out: AgentConfigProblem[]): void {
  const hasTemplate = typeof instruction.promptTemplateId === 'string' && instruction.promptTemplateId.length > 0;
  const hasSystemPrompt = typeof instruction.systemPrompt === 'string' && instruction.systemPrompt.length > 0;
  const hasFragments = Array.isArray(instruction.fragments);
  const forms = [hasTemplate, hasSystemPrompt, hasFragments].filter(Boolean).length;
  if (forms !== 1) {
    out.push({
      severity: 'ERROR',
      path: 'instruction',
      message:
        forms > 1
          ? 'A TEXT_GENERATION instruction binds exactly one of `promptTemplateId` (an approved, version-pinned template), `systemPrompt`, or `fragments` (an ordered, conditional list of either) — not several.'
          : 'A TEXT_GENERATION instruction must bind exactly one of `promptTemplateId` (an approved, version-pinned template), `systemPrompt`, or `fragments` (an ordered, conditional list of either).',
    });
  }
  if (
    hasTemplate &&
    instruction.promptVersionNumber !== undefined &&
    !(Number.isInteger(instruction.promptVersionNumber) && (instruction.promptVersionNumber as number) >= 1)
  ) {
    out.push({ severity: 'ERROR', path: 'instruction.promptVersionNumber', message: '`promptVersionNumber` must be a positive integer when set.' });
  }
  if (!hasTemplate && !hasFragments && (instruction.promptVersionNumber !== undefined || instruction.variables !== undefined)) {
    out.push({ severity: 'ERROR', path: 'instruction', message: '`promptVersionNumber` / `variables` only apply to a template-bound instruction.' });
  }
  // TASK-947 — a composite instruction pins per FRAGMENT; a top-level pin has nothing to pin.
  if (hasFragments && instruction.promptVersionNumber !== undefined) {
    out.push({
      severity: 'ERROR',
      path: 'instruction.promptVersionNumber',
      message:
        'A composite instruction pins a template version on the fragment that binds it (`fragments[i].promptVersionNumber`), not at the top level.',
    });
  }
  if (hasFragments) fragmentProblems(instruction.fragments as unknown[], out);
  variableBindingProblems(instruction, out);
}

/**
 * TASK-947 (OD-2, OD-6) — the composite form's own rules, each named by `code` so the
 * applications layer reports it without a path heuristic. Every problem is reported at the
 * fragment it belongs to; the list-level ones at `instruction.fragments`.
 */
function fragmentProblems(fragments: unknown[], out: AgentConfigProblem[]): void {
  const shape = (path: string, message: string): void => {
    out.push({ severity: 'ERROR', path, message, code: 'PROMPT_FRAGMENT_SHAPE' });
  };

  if (fragments.length === 0) shape('instruction.fragments', 'A composite instruction needs at least one fragment.');
  if (fragments.length > AGENT_PROMPT_FRAGMENT_MAX) {
    shape('instruction.fragments', `A composite instruction carries at most ${AGENT_PROMPT_FRAGMENT_MAX} fragments; found ${fragments.length}.`);
  }

  const keyPattern = new RegExp(AGENT_PROMPT_FRAGMENT_KEY_PATTERN);
  const seenKeys = new Set<string>();
  let hasBase = false;

  fragments.forEach((raw, index) => {
    const at = `instruction.fragments[${index}]`;
    if (!isPlainObject(raw)) {
      shape(at, `\`${at}\` must be an object \`{ key, promptTemplateId | systemPrompt, promptVersionNumber?, when? }\`.`);
      return;
    }

    if (typeof raw.key !== 'string' || !keyPattern.test(raw.key)) {
      shape(`${at}.key`, `\`${at}.key\` must match ${AGENT_PROMPT_FRAGMENT_KEY_PATTERN} (lowercase letters, digits, underscores; 2–48 characters).`);
    } else if (seenKeys.has(raw.key)) {
      shape(`${at}.key`, `\`${at}.key\` duplicates \`${raw.key}\`; fragment keys are unique within the list.`);
    } else {
      seenKeys.add(raw.key);
    }

    const hasTemplate = typeof raw.promptTemplateId === 'string' && raw.promptTemplateId.length > 0;
    const hasSystemPrompt = typeof raw.systemPrompt === 'string' && raw.systemPrompt.length > 0;
    if (hasTemplate === hasSystemPrompt) {
      shape(
        at,
        hasTemplate
          ? `\`${at}\` binds exactly one of \`promptTemplateId\` or \`systemPrompt\`, not both.`
          : `\`${at}\` must bind exactly one of \`promptTemplateId\` (an approved template) or \`systemPrompt\` (an inline body).`,
      );
    }
    if (raw.promptVersionNumber !== undefined) {
      if (!hasTemplate) shape(`${at}.promptVersionNumber`, `\`${at}.promptVersionNumber\` pins a template version; this fragment binds none.`);
      else if (!(Number.isInteger(raw.promptVersionNumber) && (raw.promptVersionNumber as number) >= 1)) {
        shape(`${at}.promptVersionNumber`, `\`${at}.promptVersionNumber\` must be a positive integer when set.`);
      }
    }

    if (raw.when === undefined) {
      hasBase = true;
      return;
    }
    if (typeof raw.when !== 'string' || raw.when.length === 0 || raw.when.length > AGENT_PROMPT_CONDITION_MAX_LENGTH) {
      shape(
        `${at}.when`,
        `\`${at}.when\` must be a non-empty CEL expression of at most ${AGENT_PROMPT_CONDITION_MAX_LENGTH} characters, or absent for "always".`,
      );
      return;
    }
    for (const problem of expressionProblems(raw.when)) {
      out.push({ severity: 'ERROR', path: `${at}.when`, message: `\`${at}.when\` ${problem}.`, code: 'PROMPT_FRAGMENT_CONDITION_SYNTAX' });
    }
    // R1 #2 — the length cap alone let a 244-character, 120-deep condition through to a worker
    // whose parser recurses; bound the nesting at publish so the two runtimes cannot disagree.
    const depth = conditionNestingDepth(raw.when);
    if (depth > AGENT_PROMPT_CONDITION_MAX_DEPTH) {
      out.push({
        severity: 'ERROR',
        path: `${at}.when`,
        message: `\`${at}.when\` is nested ${depth} levels deep; the limit is ${AGENT_PROMPT_CONDITION_MAX_DEPTH}.`,
        code: 'PROMPT_FRAGMENT_CONDITION_SYNTAX',
      });
    }
  });

  if (fragments.length > 0 && !hasBase) {
    out.push({
      severity: 'ERROR',
      path: 'instruction.fragments',
      message:
        'Every fragment carries a `when`, so the runtime could select nothing. At least one fragment must be unconditional (no `when`) — the base the composition can never lose.',
      code: 'PROMPT_COMPOSITION_NO_BASE',
    });
  }
}

/**
 * Every check that is NOT a JSON-Schema keyword: task ↔ model task-type match (primary and
 * fallbacks), the reference-only rule over the agent's own JSON columns, per-task instruction
 * shape, `tools` restricted to TEXT_GENERATION, `responseFormat: json_schema` ⇒ `responseSchema`,
 * and the capability gates (generation hyper-parameters; TTS `ssml`). The keyword checks —
 * types, ranges, enums, `additionalProperties: false` — are `jsonSchemaValueProblems` over
 * `AGENT_PARAMETER_SCHEMAS[task]` / `AGENT_INSTRUCTION_SCHEMAS[task]` in the applications layer.
 *
 * `context` is optional: without a model the model checks are skipped (the console can validate
 * a draft before the model step); without a capability view the gates are skipped, and with a
 * view that declares nothing the gated parameters WARN (unknown ≠ unsupported — the same posture
 * as `hyperparameterCapabilityProblems`).
 */
export function agentConfigProblems(view: AgentConfigView, context: AgentConfigContext = {}): AgentConfigProblem[] {
  const problems: AgentConfigProblem[] = [];
  if (!isAgentTask(view.task)) {
    return [{ severity: 'ERROR', path: 'task', message: `Unknown agent task \`${String(view.task)}\`; expected one of ${AGENT_TASKS.join(', ')}.` }];
  }
  const task = view.task;

  // Reference-only rule over every JSON column the tenant authors.
  forbiddenKeyProblems(view.parameters ?? undefined, 'parameters', problems);
  forbiddenKeyProblems(view.instruction ?? undefined, 'instruction', problems);
  forbiddenKeyProblems(view.tools ?? undefined, 'tools', problems);

  // Model ↔ task.
  if (context.model !== undefined) {
    const problem = modelTaskProblem(task, context.model, 'modelId');
    if (problem) problems.push(problem);
  }
  (context.fallbackModels ?? []).forEach((model, index) => {
    const problem = modelTaskProblem(task, model, `fallbacks[${index}]`);
    if (problem) problems.push(problem);
  });

  // TASK-890 §3.4 — half a context-schema reference is not a reference. The ROW is resolved by
  // the service (it needs the tenant); what the contract owns is that the pair is whole, so a
  // pinned version can never outlive the id that gives it meaning.
  if ((view.contextSchemaVersionNumber ?? null) !== null && (typeof view.contextSchemaId !== 'string' || view.contextSchemaId.length === 0)) {
    problems.push({
      severity: 'ERROR',
      path: 'contextSchemaVersionNumber',
      message: '`contextSchemaVersionNumber` pins a version of `contextSchemaId`; set both or neither.',
    });
  }

  // Instruction shape per task.
  const instruction = isPlainObject(view.instruction) ? view.instruction : undefined;
  if (task === 'TEXT_TO_SPEECH') {
    if (instruction !== undefined && Object.keys(instruction).length > 0) {
      problems.push({ severity: 'ERROR', path: 'instruction', message: 'A TEXT_TO_SPEECH agent carries no instruction.' });
    }
  } else if (task === 'TEXT_GENERATION') {
    if (instruction !== undefined) textGenerationInstructionProblems(instruction, problems);
  } else if (task === 'NAMED_ENTITY_RECOGNITION') {
    // TASK-930 — the label set, and nothing else. Named explicitly rather than left to the
    // SPEECH_TO_TEXT fall-through below, which would have told a NER author to write `hotwords`.
    if (instruction !== undefined) {
      const allowed = new Set(Object.keys((NAMED_ENTITY_RECOGNITION_INSTRUCTION.properties as Record<string, unknown>) ?? {}));
      const stray = Object.keys(instruction).filter((key) => !allowed.has(key));
      if (stray.length > 0) {
        problems.push({
          severity: 'ERROR',
          path: 'instruction',
          message: `A NAMED_ENTITY_RECOGNITION instruction carries only \`labels\`; found ${stray.map((key) => `\`${key}\``).join(', ')}.`,
        });
      }
    }
  } else if (instruction !== undefined) {
    const allowed = new Set(Object.keys((SPEECH_TO_TEXT_INSTRUCTION.properties as Record<string, unknown>) ?? {}));
    const stray = Object.keys(instruction).filter((key) => !allowed.has(key));
    if (stray.length > 0) {
      problems.push({
        severity: 'ERROR',
        path: 'instruction',
        message: `A SPEECH_TO_TEXT instruction carries only \`initialPrompt\` / \`hotwords\`; found ${stray.map((key) => `\`${key}\``).join(', ')}.`,
      });
    }
  }

  // Tools are a TEXT_GENERATION concept.
  if (task !== 'TEXT_GENERATION' && Array.isArray(view.tools) && view.tools.length > 0) {
    problems.push({ severity: 'ERROR', path: 'tools', message: `Tool bindings apply to TEXT_GENERATION agents only (this agent is ${task}).` });
  }

  const parameters = isPlainObject(view.parameters) ? view.parameters : undefined;
  if (task === 'TEXT_GENERATION' && parameters !== undefined) {
    if (parameters.responseFormat === 'json_schema' && !isPlainObject(parameters.responseSchema)) {
      problems.push({ severity: 'ERROR', path: 'parameters.responseSchema', message: '`responseFormat: json_schema` requires a `responseSchema`.' });
    }
    // The capability gate runs only when the caller supplied a capability VIEW (the publish
    // path always does). A view with no declared set still WARNS — unknown ≠ unsupported.
    if (context.capabilities !== undefined) {
      const generation = isPlainObject(parameters.generation) ? parameters.generation : undefined;
      for (const finding of hyperparameterCapabilityProblems(generation, context.capabilities)) {
        problems.push({ severity: finding.severity, path: `parameters.generation.${finding.parameter}`, message: finding.message });
      }
    }
  }

  if (task === 'TEXT_TO_SPEECH' && parameters?.ssml === true && context.capabilities !== undefined) {
    const supportsSsml = context.capabilities?.supportsSsml;
    if (supportsSsml === false) {
      problems.push({
        severity: 'ERROR',
        path: 'parameters.ssml',
        message: 'SSML is not supported by the bound provider configuration; it would be spoken as literal markup — refused instead.',
      });
    } else if (supportsSsml === undefined) {
      problems.push({
        severity: 'WARNING',
        path: 'parameters.ssml',
        message: 'SSML support cannot be verified: the bound provider configuration declares no capability set.',
      });
    }
  }

  return problems;
}

export function hasBlockingAgentProblems(problems: readonly AgentConfigProblem[]): boolean {
  return problems.some((problem) => problem.severity === 'ERROR');
}

// =============================================================================================
// TASK-930 §5 — `Agent.outputSchema` is ENFORCED, not decorative
// =============================================================================================

/**
 * The `json_schema` response format a declared `outputSchema` implies — the one thing that turns
 * the column from documentation into a constraint the engine actually honours.
 *
 * Three deliberate silences, each returning `undefined`:
 *   - the declared schema IS the task default (nothing was declared, so nothing is enforced);
 *   - it is not an object schema with at least one property (an engine cannot constrain to it,
 *     and half a constraint is worse than none because it looks like one);
 *   - `parameters.responseFormat` is set — an explicit hyper-parameter is an author's decision
 *     and always wins, including when it says `text`.
 *
 * The three consumers (the gateway invocation service, the harness `_run_text_generation` and the
 * realtime `core.agent` handler) share this ONE rule so that an agent cannot behave differently
 * depending on which lane happens to run it.
 */
export function outputSchemaResponseFormat(
  slug: string,
  outputSchema: unknown,
  parameters: Record<string, unknown> | null | undefined,
): { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown>; strict: true } } | undefined {
  if (parameters?.responseFormat !== undefined) return undefined;
  if (!isPlainObject(outputSchema)) return undefined;
  if (outputSchema.type !== 'object') return undefined;
  const properties = outputSchema.properties;
  if (!isPlainObject(properties) || Object.keys(properties).length === 0) return undefined;
  const declared = canonicalJson(outputSchema);
  for (const defaults of Object.values(AGENT_IO_DEFAULTS)) {
    if (canonicalJson(defaults.outputSchema) === declared) return undefined;
  }
  return {
    type: 'json_schema',
    json_schema: { name: `${slug.replace(/[^a-z0-9_]/gi, '_')}_output`, schema: outputSchema, strict: true },
  };
}

// =============================================================================================
// Agent TAGS — the `key:value` alignment vocabulary (TASK-884, owner decision #6)
// =============================================================================================

/**
 * The owner's ruling: there are NO tenant-managed conditions (department, visit type, …).
 * Developers branch inside a workflow; tenant admins ALIGN AGENTS by `key:value` tags, and an
 * `AgentAssignment` may carry a tag SELECTOR so a tier resolves "the TEXT_GENERATION agent
 * tagged `specialty:rheumatology`" rather than a second condition table.
 *
 * That only works if a tag is a PAIR. A bare tag (`rheumatology`) has no key, so two tenants
 * writing `cardiology` and `specialty:cardiology` produce a vocabulary that cannot be grouped,
 * faceted or matched — which is exactly the drift the retired `(task, visitType) -> prompt`
 * binding created. So the grammar is enforced on every WRITE:
 *
 *   key   — 1–32 chars, `[a-z0-9]` then `[a-z0-9_-]`, e.g. `specialty`, `tier`, `task`
 *   value — 1–64 chars, `[a-z0-9]` then `[a-z0-9._-]`, e.g. `rheumatology`, `platform`, `v2.1`
 *
 * Lower-case only, and exactly ONE colon: a tag is compared by equality everywhere (list
 * facets, selector matching, the console filter), and case- or separator-insensitive
 * comparison is the kind of leniency that turns one vocabulary into three.
 *
 * Reads are NOT re-validated. Rows written before this grammar existed keep their bare tags and
 * stay listable; they simply cannot be SELECTED by a selector, which is the honest outcome.
 */
export const AGENT_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/;

/** How many tags one agent (or one selector) may carry. A selector longer than this is a query, not an alignment. */
export const AGENT_TAG_MAX_COUNT = 24;

export interface AgentTagPair {
  readonly key: string;
  readonly value: string;
}

/** `'specialty:rheumatology'` → `{ key, value }`; `null` for anything that is not a well-formed tag. */
export function parseAgentTag(tag: unknown): AgentTagPair | null {
  if (typeof tag !== 'string' || !AGENT_TAG_PATTERN.test(tag)) return null;
  const colon = tag.indexOf(':');
  return { key: tag.slice(0, colon), value: tag.slice(colon + 1) };
}

/**
 * Every problem with a tag list: shape, count, and duplicates. ERROR-only — a malformed tag is
 * refused rather than dropped, because silently dropping one changes which agent a selector
 * resolves.
 */
export function agentTagProblems(tags: unknown, path = 'tags'): AgentConfigProblem[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) {
    return [{ severity: 'ERROR', path, message: '`tags` must be an array of `key:value` strings.' }];
  }
  const problems: AgentConfigProblem[] = [];
  if (tags.length > AGENT_TAG_MAX_COUNT) {
    problems.push({ severity: 'ERROR', path, message: `At most ${AGENT_TAG_MAX_COUNT} tags; this list has ${tags.length}.` });
  }
  const seen = new Set<string>();
  tags.forEach((tag, index) => {
    const at = `${path}[${index}]`;
    if (parseAgentTag(tag) === null) {
      problems.push({
        severity: 'ERROR',
        path: at,
        message:
          typeof tag === 'string' && !tag.includes(':')
            ? `\`${tag}\` is a bare tag; agent tags are \`key:value\` pairs (e.g. \`specialty:${tag.toLowerCase()}\`).`
            : `\`${String(tag)}\` is not a valid agent tag; expected lower-case \`key:value\` (key 1-32, value 1-64 chars).`,
      });
      return;
    }
    if (seen.has(tag as string)) {
      problems.push({ severity: 'ERROR', path: at, message: `Duplicate tag \`${String(tag)}\`.` });
      return;
    }
    seen.add(tag as string);
  });
  return problems;
}

/**
 * The canonical form of a tag list: de-duplicated and sorted. Used as the STORED form of an
 * assignment's selector so that `{a,b}` and `{b,a}` are one row rather than two competing ones,
 * and so the uniqueness key over a tier is comparable at the database.
 */
export function canonicalAgentTags(tags: readonly string[]): string[] {
  return [...new Set(tags)].sort();
}

/**
 * Does an agent (or a request) carrying `available` satisfy a `selector`?
 *
 * SUBSET semantics, AND-joined: every selector tag must be present. An EMPTY selector matches
 * everything — that is what makes an unqualified assignment the fallback rather than a
 * competitor. Specificity for ordering is simply the selector's length, so a two-tag selector
 * is tried before a one-tag one and both before the unqualified row.
 */
export function agentTagsSatisfy(available: readonly string[], selector: readonly string[]): boolean {
  if (selector.length === 0) return true;
  const have = new Set(available);
  return selector.every((tag) => have.has(tag));
}
