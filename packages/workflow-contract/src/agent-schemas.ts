/**
 * The Agent entity's TASK-TYPED configuration contract (TASK-863 §3.2).
 *
 * An Agent performs exactly one task — `SPEECH_TO_TEXT`, `TEXT_GENERATION` or `TEXT_TO_SPEECH`
 * — on ONE registered model (plus ordered fallbacks of the same task). Its `parameters` and
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
import { FORBIDDEN_CONFIG_KEYS, hyperparameterCapabilityProblems, type ProviderGenerationCapabilities } from './agentic-contract';
import type { NodeConfigSchema } from './node-config-schemas';

// =============================================================================================
// Task taxonomy
// =============================================================================================

export const AGENT_TASKS = Object.freeze(['SPEECH_TO_TEXT', 'TEXT_GENERATION', 'TEXT_TO_SPEECH'] as const);
export type AgentTask = (typeof AGENT_TASKS)[number];

/** The `AiProviderConnection.service` an agent's credential resolves under, per task. */
export const AGENT_TASK_SERVICE: Readonly<Record<AgentTask, 'stt' | 'llm' | 'tts'>> = Object.freeze({
  SPEECH_TO_TEXT: 'stt',
  TEXT_GENERATION: 'llm',
  TEXT_TO_SPEECH: 'tts',
});

/** The registry `AiModel.taskType` a model must carry to back an agent of each task. */
export const AGENT_TASK_MODEL_TASK_TYPE: Readonly<Record<AgentTask, string>> = Object.freeze({
  SPEECH_TO_TEXT: 'AUTOMATIC_SPEECH_RECOGNITION',
  TEXT_GENERATION: 'TEXT_GENERATION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
});

export type AgentProtocol = 'http' | 'http-sse' | 'socket';

/** The invocation protocols each task publishes (TASK-863 §3.5). */
export const AGENT_PROTOCOLS: Readonly<Record<AgentTask, readonly AgentProtocol[]>> = Object.freeze({
  SPEECH_TO_TEXT: Object.freeze(['http', 'socket'] as const),
  TEXT_GENERATION: Object.freeze(['http', 'http-sse'] as const),
  TEXT_TO_SPEECH: Object.freeze(['http', 'http-sse'] as const),
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
  properties: Object.freeze({ input: GUARD_POLICY_LIST, output: GUARD_POLICY_LIST }),
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
        diarization: Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties: Object.freeze({
            enabled: Object.freeze({ type: 'boolean' }),
            backend: Object.freeze({ type: 'string', enum: Object.freeze(['embedding', 'sortformer']) }),
            embeddingModelSlug: Object.freeze({ ...MODEL_SLUG_PROPERTY, description: 'Registry slug of a `SPEAKER_EMBEDDING` model.' }),
            maxSpeakers: Object.freeze({ type: 'integer', minimum: 1, maximum: 16 }),
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
      }),
    }),
    streaming: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        partialIntervalMs: Object.freeze({ type: 'integer', minimum: 100, maximum: 5000 }),
        endpointing: Object.freeze({ type: 'string', enum: Object.freeze(['fixed', 'semantic']) }),
        maxUtteranceSec: Object.freeze({ type: 'integer', minimum: 1, maximum: 600 }),
      }),
    }),
    fallback: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        agentSlug: Object.freeze({
          type: 'string',
          minLength: 2,
          maxLength: 80,
          description: 'Another SPEECH_TO_TEXT agent (lineage slug) to switch to.',
        }),
        autoSwitch: Object.freeze({ type: 'boolean' }),
        switchAfterConsecutiveFailures: Object.freeze({ type: 'integer', minimum: 1, maximum: 20 }),
      }),
    }),
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
  }),
});

export const AGENT_PARAMETER_SCHEMAS: Readonly<Record<AgentTask, NodeConfigSchema>> = Object.freeze({
  SPEECH_TO_TEXT: SPEECH_TO_TEXT_PARAMETERS,
  TEXT_GENERATION: TEXT_GENERATION_PARAMETERS,
  TEXT_TO_SPEECH: TEXT_TO_SPEECH_PARAMETERS,
});

// =============================================================================================
// Instruction schemas per task (§3.2) — `null` where the task carries none
// =============================================================================================

const EVAL_GATE_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({ goldenSetId: ROW_ID_PROPERTY, enabled: Object.freeze({ type: 'boolean' }) }),
});

/** Exactly one of `promptTemplateId` or `systemPrompt` — enforced by `agentConfigProblems`. */
const TEXT_GENERATION_INSTRUCTION: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    promptTemplateId: ROW_ID_PROPERTY,
    promptVersionNumber: Object.freeze({ type: 'integer', minimum: 1 }),
    variables: Object.freeze({ type: 'object', additionalProperties: Object.freeze({ type: 'string', maxLength: 4000 }) }),
    systemPrompt: Object.freeze({ type: 'string', minLength: 1, maxLength: 50000 }),
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

export const AGENT_INSTRUCTION_SCHEMAS: Readonly<Record<AgentTask, NodeConfigSchema | null>> = Object.freeze({
  SPEECH_TO_TEXT: SPEECH_TO_TEXT_INSTRUCTION,
  TEXT_GENERATION: TEXT_GENERATION_INSTRUCTION,
  TEXT_TO_SPEECH: null,
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

export interface AgentConfigProblem {
  readonly severity: 'ERROR' | 'WARNING';
  readonly path: string;
  readonly message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function textGenerationInstructionProblems(instruction: Record<string, unknown>, out: AgentConfigProblem[]): void {
  const hasTemplate = typeof instruction.promptTemplateId === 'string' && instruction.promptTemplateId.length > 0;
  const hasSystemPrompt = typeof instruction.systemPrompt === 'string' && instruction.systemPrompt.length > 0;
  if (hasTemplate === hasSystemPrompt) {
    out.push({
      severity: 'ERROR',
      path: 'instruction',
      message: hasTemplate
        ? 'A TEXT_GENERATION instruction binds exactly one of `promptTemplateId` (an approved, version-pinned template) or `systemPrompt`, not both.'
        : 'A TEXT_GENERATION instruction must bind exactly one of `promptTemplateId` (an approved, version-pinned template) or `systemPrompt`.',
    });
  }
  if (
    hasTemplate &&
    instruction.promptVersionNumber !== undefined &&
    !(Number.isInteger(instruction.promptVersionNumber) && (instruction.promptVersionNumber as number) >= 1)
  ) {
    out.push({ severity: 'ERROR', path: 'instruction.promptVersionNumber', message: '`promptVersionNumber` must be a positive integer when set.' });
  }
  if (!hasTemplate && (instruction.promptVersionNumber !== undefined || instruction.variables !== undefined)) {
    out.push({ severity: 'ERROR', path: 'instruction', message: '`promptVersionNumber` / `variables` only apply to a template-bound instruction.' });
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

  // Instruction shape per task.
  const instruction = isPlainObject(view.instruction) ? view.instruction : undefined;
  if (task === 'TEXT_TO_SPEECH') {
    if (instruction !== undefined && Object.keys(instruction).length > 0) {
      problems.push({ severity: 'ERROR', path: 'instruction', message: 'A TEXT_TO_SPEECH agent carries no instruction.' });
    }
  } else if (task === 'TEXT_GENERATION') {
    if (instruction !== undefined) textGenerationInstructionProblems(instruction, problems);
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
