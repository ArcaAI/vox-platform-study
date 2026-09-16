/**
 * TASK-930 §8.3 — the seeded Agents: the promotion process, as data.
 *
 * Global (`50000000-…`, the platform-admin PLAYGROUND — a customer tenant, never a config tier)
 * AUTHORS six agents. SYSTEM carries the IDENTICAL six as the PROMOTED copy: same slug, same
 * configuration, `sourceAgentId` / `sourceTenantId` / `sourceSlug` / `sourceVersionNumber`
 * pointing at the Global row — exactly the provenance `POST /admin/agents/promote-to-system`
 * (INTERFACES §6.1) stamps, so a seeded promotion and a real one are indistinguishable. ArcaAI
 * receives the SYSTEM set through phase 26 and adds its own department agents in phase 29.
 *
 *   realtime-transcription          SPEECH_TO_TEXT            arcaai-whisper-large-ml-en-gguf (+ gguf-q8_0, + faster-whisper CT2)
 *   medical-ner                     NAMED_ENTITY_RECOGNITION  medical-ner (TOKEN_CLASSIFICATION, built-in)         INTERFACES §2
 *   case-notes-pre-summary          TEXT_GENERATION           gemma + the platform pre-summary template, guards ON  TASK-932 D-9
 *   general-medicine-summarization  TEXT_GENERATION           gemma + the General Medicine summary template, guards ON
 *   casenote-finalization           TEXT_GENERATION           gemma + inline system prompt, `{ case_note, redactions }` output schema
 *   text-to-speech                  TEXT_TO_SPEECH            kokoro / af_heart
 *
 * `AgentAssignment` (TENANT scope) in BOTH tenants: one row per task, unqualified — plus ONE
 * qualified row, `TEXT_GENERATION [phase:pre-summary]` -> `case-notes-pre-summary`, which an
 * unqualified request never sees (see `assignmentsFor`).
 *
 * Rows are written directly (unscoped client, create-only): a PUBLISHED Agent is immutable at
 * the service AND at the `agent_immutability_guard` trigger, so an upsert with an `update`
 * branch would raise at the DB. `compiledConfig` mirrors `AgentService.compile`
 * (`AgentCompiledConfig` in @arcaai/types) and its checksum is `sha256:` over the same canonical
 * JSON (`canonicalJson` of @arcaai/workflow-contract, duplicated here because @arcaai/database
 * takes no dependency on the contract package; `task-930-agents.test.ts` pins the parity).
 *
 * NER on THIS branch: `packages/workflow-contract` learns `NAMED_ENTITY_RECOGNITION` from lane N.
 * The task maps below already carry it (the seed is what N's enum value is FOR), and the IO
 * defaults are the INTERFACES §2.3 literal, verbatim.
 */
import { createHash } from 'node:crypto';
import type { CorePrismaClient } from '../../../client';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import {
  DNA_ANALYSIS_CONTENT_V3,
  DNA_OUTPUT_SCHEMA,
  GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES,
  SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID,
  TEMPLATE_IDS,
} from './07-prompt-template';
import { NEW_VISIT_NOTE_SHAPE, REVISIT_NOTE_SHAPE } from './27-document-template-library';

export const COMPILED_AT = '2026-09-08T00:00:00.000Z';

export type SeedAgentTask = 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH' | 'NAMED_ENTITY_RECOGNITION';

export const AGENT_TASK_SERVICE: Record<SeedAgentTask, 'stt' | 'llm' | 'tts' | 'nlp'> = {
  SPEECH_TO_TEXT: 'stt',
  TEXT_GENERATION: 'llm',
  TEXT_TO_SPEECH: 'tts',
  NAMED_ENTITY_RECOGNITION: 'nlp',
};
export const AGENT_TASK_MODEL_TASK_TYPE: Record<SeedAgentTask, string> = {
  SPEECH_TO_TEXT: 'AUTOMATIC_SPEECH_RECOGNITION',
  TEXT_GENERATION: 'TEXT_GENERATION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
  NAMED_ENTITY_RECOGNITION: 'TOKEN_CLASSIFICATION',
};
/** NER is ONE-SHOT (`?mode=stream` → 400 `MODE_UNSUPPORTED`, INTERFACES §2.4). */
const AGENT_PROTOCOLS: Record<SeedAgentTask, string[]> = {
  SPEECH_TO_TEXT: ['http', 'socket'],
  TEXT_GENERATION: ['http', 'http-sse'],
  TEXT_TO_SPEECH: ['http', 'http-sse'],
  NAMED_ENTITY_RECOGNITION: ['http'],
};

/** INTERFACES §2.3, verbatim. */
export const NER_IO_DEFAULTS = {
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' }, language: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            label: { type: 'string' },
            start: { type: 'integer' },
            end: { type: 'integer' },
            score: { type: 'number' },
          },
          required: ['text', 'label', 'start', 'end'],
          additionalProperties: false,
        },
      },
    },
    required: ['entities'],
    additionalProperties: false,
  },
};

/** The task defaults of AGENT_IO_DEFAULTS, compiled verbatim so the runtime never reads a null schema. */
const IO_DEFAULTS: Record<SeedAgentTask, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = {
  TEXT_GENERATION: {
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', minLength: 1 }, variables: { type: 'object', additionalProperties: { type: 'string' } } },
    },
    outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  },
  SPEECH_TO_TEXT: {
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['audio'],
      properties: {
        audio: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: { type: 'string', enum: ['artifact', 'stream'] }, mediaId: { type: 'string' }, sessionId: { type: 'string' } },
        },
        language: { type: 'string', minLength: 2, maxLength: 16 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['transcript'],
      properties: {
        transcript: {
          type: 'array',
          items: {
            type: 'object',
            required: ['text', 'start', 'end'],
            properties: {
              text: { type: 'string' },
              start: { type: 'number', minimum: 0 },
              end: { type: 'number', minimum: 0 },
              speaker: { type: 'string' },
              isFinal: { type: 'boolean' },
            },
          },
        },
        language: { type: 'string' },
      },
    },
  },
  TEXT_TO_SPEECH: {
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', minLength: 1, maxLength: 20000 }, ssml: { type: 'string', minLength: 1, maxLength: 40000 } },
      anyOf: [{ required: ['text'] }, { required: ['ssml'] }],
    },
    outputSchema: {
      type: 'object',
      required: ['audio'],
      properties: {
        audio: {
          type: 'object',
          required: ['mediaId', 'format'],
          properties: { mediaId: { type: 'string' }, format: { type: 'string' }, sampleRate: { type: 'integer' } },
        },
        durationMs: { type: 'integer', minimum: 0 },
      },
    },
  },
  NAMED_ENTITY_RECOGNITION: NER_IO_DEFAULTS,
};

/** Cross-lineage provenance — the four `Agent` columns a promotion / clone stamps. */
export interface SeedAgentProvenance {
  sourceAgentId: string;
  sourceTenantId: string;
  sourceSlug: string;
  sourceVersionNumber: number;
}

export interface SeedAgentSpec {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string;
  task: SeedAgentTask;
  modelSlug: string;
  fallbackModelSlugs: string[];
  instruction: Record<string, unknown> | null;
  parameters: Record<string, unknown>;
  /** An explicit output contract (INTERFACES §5); `null` = the task default. */
  outputSchema: Record<string, unknown> | null;
  status: 'PUBLISHED' | 'DRAFT';
  isActive: boolean;
  tags: string[];
  /** `null` on an authored row; set on a promoted / cloned copy. */
  provenance: SeedAgentProvenance | null;
}

/** Id blocks: `9c000000-…-0001-` SYSTEM agents, `-0002-` Global agents, `-0003-` fallbacks, `-0004-` assignments, `-0005-` ArcaAI agents (phase 29). */
const sys = (n: number) => `9c000000-0000-0000-0001-${String(n).padStart(12, '0')}`;
const glob = (n: number) => `9c000000-0000-0000-0002-${String(n).padStart(12, '0')}`;
export const fallbackId = (n: number) => `9c000000-0000-0000-0003-${String(n).padStart(12, '0')}`;
export const assignmentId = (n: number) => `9c000000-0000-0000-0004-${String(n).padStart(12, '0')}`;
export const arcaaiAgentId = (n: number) => `9c000000-0000-0000-0005-${String(n).padStart(12, '0')}`;

/** The lineage keys, in seed order. */
export const SEEDED_AGENT_SLUGS = [
  'realtime-transcription',
  'medical-ner',
  'case-notes-pre-summary',
  'general-medicine-summarization',
  'casenote-finalization',
  'text-to-speech',
  'dna-writing-style-analyst',
] as const;

/**
 * TASK-974 D-1 — the PLATFORM HIDDEN analyst's lineage key.
 *
 * Declared beside the others and seeded exactly like them (Global authors, SYSTEM is the promoted
 * copy), with two deliberate differences:
 *
 *  · it carries `visibility:hidden`, the tag the console reads to label it. The tag is a LABEL,
 *    not the gate — the gate is `PLATFORM_HIDDEN_AGENTS` in code, so editing tags cannot expose
 *    or conceal an agent;
 *  · it has NO `AgentAssignment`. An assignment is a tenant choosing which agent serves a task;
 *    this one is reached by the platform's own SYSTEM-pinned read, and `AgentAssignmentService`
 *    refuses the slug outright (409).
 */
export const DNA_WRITING_STYLE_ANALYST_SLUG = 'dna-writing-style-analyst';

/**
 * TASK-932 D-9 — the WARM-START agent's lineage key.
 *
 * Named here because three files reference it and none of them may spell it: `28-workflow-library`
 * puts it on the `n_presummary` node, phase 29 seeds ArcaAI's own copy bound to the department
 * corpus' v3 pre-summary body, and `LiveDocumentationService` runs whatever the graph's `onStart`
 * node names — never this constant, which is exactly the point.
 */
export const PRE_SUMMARY_AGENT_SLUG = 'case-notes-pre-summary';

/** The ONE ASR lineage key — Global and SYSTEM both carry it (§8.3); `09-consultation.ts` names it. */
export const ASR_AGENT_SLUG = 'realtime-transcription';

// ----------------------------------------------------------------------------------------------
// Shared configuration (exported so phase 29 builds the ArcaAI department agents the same way)
// ----------------------------------------------------------------------------------------------

/**
 * Today's `platform-transcription` parameters (TASK-938: `wordTimestamps: true`, guarded by
 * the adapter's own pinned-language refusal rather than by this flag).
 *
 * `minSpeechMs: 100` (TASK-934, OD-5): was 250, which re-imposed a value the engine author
 * had already retired (`dto.py:589-593`) — at 250ms a spoken yes/no (~150-250ms) is
 * discarded before it ever reaches ASR. 100ms is the engine's own default; this seed no
 * longer overrides it upward.
 *
 * ALaaS-Hope alignment plan Lane F2 (2026-09-13) — reactivity tuning for the ArcaAI tenant's
 * `realtime-transcription` agent (this row is the SYSTEM/Global default the tenant inherits;
 * it carries no per-tenant override today, so the change is platform-wide until one exists):
 *   - `streaming.partialIntervalMs` 500 -> 300 ms: how often a partial is re-emitted.
 *   - `streaming.partialWindowSec` added at 3 s (was unset, so the model row's `partialWindowSec`
 *     6 s applied): overrides the assigned model's window to trade decode-tail length for
 *     latency. `agent-schemas.ts`'s own doc comment on this field measured MORE garbage partials
 *     at shorter tails (31% at 6s -> 0% at 15s going the OTHER direction), so this is a
 *     deliberate experiment, not a settled win — see the runbook's revert rule.
 *   - `audioFrontEnd.vad.minSilenceMs` 500 -> 350 ms: how long a gap ends an utterance for VAD.
 *   - `endpointing` stays `semantic` (unchanged) and `maxUtteranceSec` stays 60 (unchanged).
 * Full measurement protocol, the admin-console equivalent (this dev stack is already seeded, so
 * these values only apply to a FRESH seed/reseed) and the revert rule:
 * `apps/audio-stream-svc/docs/tenant-config-runbook.md` (ALaaS repo) section F2.
 */
export const ASR_PARAMETERS = {
  audioFrontEnd: {
    // TASK-977 (owner decision D-1) — VAD segmentation is OFF until an admin opts in; the
    // resolver now fails closed on stage selection the same way it already does on models.
    // `modelSlug` and the tuning numbers stay bound so flipping `enabled` on gets a working
    // stage immediately, and so the resolver's own guard (409 `ASR_AGENT_VAD_MODEL_MISSING`)
    // never fires for this agent the moment an admin turns it on.
    vad: { enabled: false, modelSlug: 'silero-vad', threshold: 0.5, minSpeechMs: 100, minSilenceMs: 350 },
    // TASK-977 follow-up — all five `audioFrontEnd` controls are declared explicitly here
    // (`denoise.enabled`, `resample`, `normalize` alongside `vad.enabled` and
    // `diarization.enabled` above) so this platform agent is self-describing and a future
    // change to the schema's own defaults can never silently flip its behaviour. No denoise
    // model is bound — an enabled stage with none runs RNNoise.
    denoise: { enabled: false },
    diarization: { enabled: false, backend: 'embedding', embeddingModelSlug: 'wespeaker-voxceleb-resnet34', maxSpeakers: 2, matchThreshold: 0.6 },
    resample: true,
    normalize: true,
  },
  // The whisper.cpp adapter's per-word timestamp mode is "a lossy, script-corrupting hack" for
  // Malayalam (`whisper_cpp_asr.py:500-505`); nothing downstream consumes per-word timing.
  // TASK-938 (owner directive 2026-09-09): `wordTimestamps` back to true. It is no longer the
  // script-corrupting setting TASK-891 A4 turned off — that ticket also made the adapter REFUSE
  // the `max_len=1, split_on_word=True` decode unless the language is pinned to a space-delimited
  // one (`_WORD_SPLIT_SAFE_LANGUAGES`), so an unpinned or Malayalam session silently keeps the
  // clean sentence-level decode and only a declared `en`/`vi` session pays for word splitting.
  decoding: { languageMode: 'ml-en', codeSwitching: true, wordTimestamps: true, beamSize: 5, temperature: 0 },
  // TASK-966 — `cadence-fast` is the EXACT name `stt.punctuation.service` routes to its direct
  // transformers loader; the previous `cadence-punctuation` binding selected the legacy wrapper
  // path that cannot load under transformers 5.x, so the seeded agents ran unpunctuated.
  postProcessing: { punctuation: { enabled: true, modelSlug: 'cadence-fast' }, disfluency: true, stabilizer: true },
  // Lane F2: partialIntervalMs 500 -> 300, partialWindowSec added at 3 (was unset / model default 6).
  streaming: { partialIntervalMs: 300, partialWindowSec: 3, endpointing: 'semantic', maxUtteranceSec: 60 },
  fallback: { autoSwitch: true, switchAfterConsecutiveFailures: 3 },
};
export const ASR_INSTRUCTION = {
  initialPrompt: 'Clinical consultation between a clinician and a patient. English and Malayalam medical terminology.',
  hotwords: [] as string[],
};

/**
 * The per-turn summarization hyper-parameters. `guards.enabled: true` is the AGENT level of the
 * `node > workflow > agent > true` guardrail precedence (§3.14) — stated, not inherited, because
 * "guardrail enabled with GLiNER2 on the summarization agent" is an owner commitment (D-2).
 * Reasoning OFF: the live flush is a 20 s budget and reasoning tokens were measured at 92% of
 * the completion on this model (TASK-891).
 *
 * TEMPERATURE 0 (owner directive 2026-09-14). Platform-wide for every seeded agent that runs an
 * LLM: a clinical note is an extraction task, not a generative one, and any sampling entropy at
 * all is entropy spent inventing text the transcript does not support. It is the decoding-side
 * partner of the corpus's own NEVER INVENT rule — that rule tells the model not to fabricate,
 * this setting removes the randomness that makes fabrication cheap. `0` is stated rather than
 * omitted for the reason the reasoning posture is: an absent value is the ENGINE's default
 * (commonly 0.7-1.0), so leaving it out would be choosing the engine's opinion over ours.
 * `agent-schemas.ts` types it `minimum: 0`, and `agent-invocation.service.ts` forwards on
 * `typeof === 'number'`, so 0 travels rather than being swallowed as falsy.
 */
export const SUMMARIZATION_PARAMETERS = {
  generation: { temperature: 0, maxTokens: 2048, reasoning: { enabled: false } },
  responseFormat: 'text',
  guards: { enabled: true },
};

/** `NEW_VISIT_NOTE_SHAPE` / `REVISIT_NOTE_SHAPE` headings, as the text constant the prompt reads. */
export const headingList = (shape: { sections: ReadonlyArray<{ title: string }> }): string =>
  shape.sections.map((section) => section.title).join(' | ');

/**
 * F6 — a binding for EVERY variable the General Medicine template declares. The nine §8.2 fields
 * resolve from the trigger's validated context (`{{trigger.context.*}}`, INTERFACES §8.3); the two
 * document-template heading lists are CONSTANTS, because `Agent.instruction.variables` knows only
 * `{ value }` | `{ path }` — there is no document-template binding kind (reported).
 */
export function generalMedicinePromptVariables(): Record<string, { value: string } | { path: string }> {
  const constants: Record<string, string> = {
    new_visit_headings: headingList(NEW_VISIT_NOTE_SHAPE),
    revisit_headings: headingList(REVISIT_NOTE_SHAPE),
  };
  return Object.fromEntries(
    GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES.map((name) => [
      name,
      name in constants ? { value: constants[name]! } : { path: `trigger.context.${name}` },
    ]),
  );
}

/**
 * TASK-932 D-9 — the nine names the pre-summary corpus binds, in the order the body reads them.
 *
 * Declared here rather than imported from `07b-arcaai-clinical-templates.ts` for the same reason
 * `GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES` is declared in `07-prompt-template.ts`: the list is a
 * property of the PROMPT, and the two bodies that carry it (the SYSTEM platform default …040 and
 * the ArcaAI v3 corpus) declare exactly this set. `pre-summary-agent.task932.test.ts` cross-checks
 * it against both bodies, so the two cannot silently diverge.
 */
export const PRE_SUMMARY_VARIABLE_NAMES: readonly string[] = [
  'current_department',
  'visit_type',
  'safe_age',
  'safe_dob',
  'safe_gender',
  'safe_vitals',
  'formatted_test_results',
  'formatted_previous_visits',
  'language_name',
];

/**
 * Every pre-summary variable, bound to the trigger's validated context.
 *
 * The bodies themselves are written in the `{{context.<name>}}` grammar and are NOT rewritten:
 * `buildAgentPromptScope` publishes the trigger under BOTH `trigger` and `context`
 * (`agent-prompt-scope.ts`), so `{{context.safe_age}}` already resolves from
 * `trigger.context.safe_age` with no binding at all. The bindings below are declared anyway, for
 * two reasons that are not decoration:
 *
 *  - the bare name and the dotted path must be the SAME value ("`{{age}}` and
 *    `{{context.patientAge}}` are the same value", `agent-prompt-scope.ts` §3.3), and declaring
 *    the binding is how that is stated rather than assumed;
 *  - `publish-findings` cross-checks a template's placeholders against the agent's DECLARED
 *    variables plus the trigger's namespace, so an author editing the body in the Studio sees the
 *    nine names as variables of the agent instead of as an opaque context reach-through.
 *
 * Every one of the nine is a field of `consultation_note_context`
 * (`07e-consultation-note-context-schema.ts`: six §8.2 fields, three folded-in v1 names), so the
 * paths resolve on the seeded graphs by construction.
 */
export function preSummaryPromptVariables(): Record<string, { path: string }> {
  return Object.fromEntries(PRE_SUMMARY_VARIABLE_NAMES.map((name) => [name, { path: `trigger.context.${name}` }]));
}

/**
 * The WARM-START hyper-parameters.
 *
 * Same class as {@link SUMMARIZATION_PARAMETERS} — guards ON, reasoning OFF — with a larger
 * completion budget, because the pre-summary reproduces a whole prior record under five headings
 * while a per-turn note extends one that already exists. Reasoning stays off for the reason
 * TASK-891 measured: 92% of the completion went to reasoning tokens on this model, and the
 * warm start races the capture session it runs beside. Temperature 0 for the reason stated on
 * {@link SUMMARIZATION_PARAMETERS} — it applies to every seeded LLM agent, not to a tier.
 */
export const PRE_SUMMARY_PARAMETERS = {
  generation: { temperature: 0, maxTokens: 3072, reasoning: { enabled: false } },
  responseFormat: 'text',
  guards: { enabled: true },
};

/**
 * TASK-932 D-10 — the finalize prompt now carries the DNA WRITING-STYLE block.
 *
 * `{{context.dna_style_text}}` is a declared field of `consultation_note_context`
 * (`07e`, folded in from the v1 vocabulary) and is the SAME name `PromptAssemblyService`
 * injects on the gateway finalize path, so one clinician's style reaches both finalizers under
 * one name. It carries `default("")` for the reason the grammar has the filter at all: a
 * consultation whose doctor has no report, or has DNA switched off, must finalize normally —
 * `renderTemplate` throws `PromptVariableUnresolved` on an undefaulted miss, and a finalize that
 * fails because a style is absent would be a worse outcome than a finalize with no style.
 *
 * The block is STYLE ONLY, and says so twice. A writing style may change how a fact is phrased;
 * it may never change, add or remove one. That boundary is the whole reason DNA is applied at
 * finalize rather than live (TASK-891 F-1 / D-10): the clinician reads the note before signing it.
 */
export const CASENOTE_FINALIZATION_SYSTEM_PROMPT =
  "You are a clinical documentation assistant finalizing the case note of a consultation that has ended. You are given the running partial summaries produced during the consultation and the clinician's work notes. Produce ONE finalized case note that keeps the document template headings exactly as they appear in the partial summaries (same names, same order), merges every partial into a single coherent, non-repetitive note, and preserves every clinical fact, medication, dose, date and instruction exactly as recorded. Redact residual PII: replace any personal name, identifier, address, phone number or email that slipped into the note with a bracketed placeholder such as [NAME] or [ID], and list each redaction with its label. Use only facts present in the input; never add findings, diagnoses, recommendations or plans of your own, and never write a clinical code. THE FINALIZED NOTE IS ENTIRELY IN ENGLISH: the partials reach you already translated, so should any Malayalam script or romanised Malayalam have survived into them, translate it into the standard English clinical term here rather than copying it forward — translating carries the meaning across and adds nothing, and drug names, doses, numbers, units, dates, values and proper names are reproduced, never translated.\n\n" +
  '=== WRITING STYLE ===\n' +
  'The clinician`s own documentation style, when one is supplied, is:\n{{context.dna_style_text | default("")}}\n' +
  'Apply it to HOW the note reads — sentence length, register, abbreviation habit, the order in which findings are stated within a heading — and to nothing else. It must never change WHAT the note says: not one clinical fact, drug name, dose, route, frequency, value, date, laterality or heading may be added, removed, reworded into a different meaning, or re-ordered between headings to suit it. An abbreviation is used only where the style calls for one AND the expansion is unambiguous in context. When the block above is empty, write in plain clinical prose and change nothing about your output.\n' +
  'The redaction rules above outrank the style in every case: a name is replaced with its placeholder however the clinician would have written it.\n\n' +
  'Return a JSON object with `case_note` (the finalized Markdown note) and `redactions` (an array of `{ text, label }`).';

/** INTERFACES §8.3 — `{ case_note: string, redactions: [{ text, label }] }`. */
export const CASENOTE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['case_note', 'redactions'],
  properties: {
    case_note: { type: 'string' },
    redactions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'label'],
        properties: { text: { type: 'string' }, label: { type: 'string' } },
      },
    },
  },
};

// ----------------------------------------------------------------------------------------------
// The five, as pure data
// ----------------------------------------------------------------------------------------------

/**
 * ONE catalogue for both tenants — the whole point of §8.3 is that Global and SYSTEM differ only
 * by tenant, id, the template id each tenant owns, and provenance.
 */
function catalogue(tenantId: string, ids: (n: number) => string, generalMedicineTemplateId: string, preSummaryTemplateId: string): SeedAgentSpec[] {
  const tier = tenantId === SYSTEM_TENANT_ID ? 'tier:platform-default' : 'tier:playground';
  return [
    {
      id: ids(1),
      tenantId,
      slug: 'realtime-transcription',
      name: 'Realtime transcription (whisper.cpp ML/EN)',
      description:
        'Realtime + batch speech-to-text on the in-house Malayalam/English whisper.cpp GGUF (F16), Silero VAD gating, Cadence punctuation; the Q8_0 GGUF and the CTranslate2 turbo as fallbacks.',
      task: 'SPEECH_TO_TEXT',
      // TASK-938 (owner directive 2026-09-09): back to the F16 row, reverting TASK-930's move to
      // Q8_0. The two measured within 0.005 CER of each other (TASK-934), so this is not an
      // accuracy claim — it restores the weights that were serving before the 2026-09-06 baseline
      // so the live A/B has one variable fewer. Q8_0 stays first in the fallback chain.
      modelSlug: 'arcaai-whisper-large-ml-en-gguf',
      fallbackModelSlugs: ['arcaai-whisper-large-ml-en-gguf-q8_0', 'faster-whisper-large-v3-turbo-int8'],
      instruction: ASR_INSTRUCTION,
      parameters: ASR_PARAMETERS,
      outputSchema: null,
      status: 'PUBLISHED',
      isActive: true,
      tags: [tier, 'task:stt', 'capability:transcription'],
      provenance: null,
    },
    {
      id: ids(2),
      tenantId,
      slug: 'medical-ner',
      name: 'Medical NER',
      description: 'Medical named-entity recognition over the transcript (blaze999/Medical-NER through the NLP service). One-shot.',
      task: 'NAMED_ENTITY_RECOGNITION',
      modelSlug: 'medical-ner',
      fallbackModelSlugs: [],
      instruction: null,
      parameters: { threshold: 0.5, aggregation: 'simple' },
      outputSchema: null,
      status: 'PUBLISHED',
      isActive: true,
      tags: [tier, 'task:ner', 'capability:entity-recognition'],
      provenance: null,
    },
    {
      id: ids(6),
      tenantId,
      slug: PRE_SUMMARY_AGENT_SLUG,
      name: 'Case-notes pre-summary (warm start)',
      description:
        "The WARM START of a consultation: one pass over the patient's prior case notes, producing the dated background the clinician reads while the recording is coming up. Bound to the platform pre-summary template; guardrail screening ON.",
      task: 'TEXT_GENERATION',
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      fallbackModelSlugs: [],
      instruction: { promptTemplateId: preSummaryTemplateId, promptVersionNumber: 1, variables: preSummaryPromptVariables() },
      parameters: PRE_SUMMARY_PARAMETERS,
      outputSchema: null,
      status: 'PUBLISHED',
      isActive: true,
      tags: [tier, 'task:llm', 'capability:pre-summary', 'phase:pre-summary'],
      provenance: null,
    },
    {
      id: ids(3),
      tenantId,
      slug: 'general-medicine-summarization',
      name: 'General Medicine summarization (partial)',
      description:
        'The running per-turn consultation note for General Medicine, bound to the approved General Medicine consultation summary template; guardrail screening ON.',
      task: 'TEXT_GENERATION',
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      fallbackModelSlugs: [],
      instruction: { promptTemplateId: generalMedicineTemplateId, promptVersionNumber: 1, variables: generalMedicinePromptVariables() },
      parameters: SUMMARIZATION_PARAMETERS,
      outputSchema: null,
      status: 'PUBLISHED',
      isActive: true,
      tags: [tier, 'task:llm', 'capability:summarization', 'specialty:general-medicine'],
      provenance: null,
    },
    {
      id: ids(4),
      tenantId,
      slug: 'casenote-finalization',
      name: 'Case note finalization',
      description:
        'Finalizes the case note from the partial summaries and the work notes, redacts residual PII, keeps the document template headings. Structured output: { case_note, redactions }.',
      task: 'TEXT_GENERATION',
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      fallbackModelSlugs: [],
      instruction: { systemPrompt: CASENOTE_FINALIZATION_SYSTEM_PROMPT },
      // No `responseFormat`: the declared `outputSchema` IS the response format (INTERFACES §5).
      //
      // Reasoning OFF (owner directive 2026-09-13). TASK-891 C3 seeded the posture on the REALTIME
      // tier only and left this one "as-is" — which is not neutral: an absent block is the engine's
      // OWN default, the exact state the 5168 ms / 184-reasoning-token measurement was taken in. The
      // directive is now platform-wide, so no seeded TEXT_GENERATION agent leaves the decision to
      // the engine. `enabled: false` travels as the `reasoning` posture and each adapter renders
      // its own engine's off-switch (TASK-970); on an effort-only engine it is approximated
      // (`agent-reasoning.ts`), and `lms-gemma-4-e2b-it-qat` DECLARES `reasoning` in
      // `supportedGenerationParams`, so the publish gate accepts it.
      //
      // Temperature 0, same owner directive as {@link SUMMARIZATION_PARAMETERS}. This agent signs
      // the note the clinician puts their name to, so it is the last place sampling entropy belongs.
      parameters: { generation: { temperature: 0, maxTokens: 4096, reasoning: { enabled: false } }, guards: { enabled: true } },
      outputSchema: CASENOTE_OUTPUT_SCHEMA,
      status: 'PUBLISHED',
      isActive: true,
      tags: [tier, 'task:llm', 'capability:finalization'],
      provenance: null,
    },
    {
      id: ids(7),
      tenantId,
      slug: DNA_WRITING_STYLE_ANALYST_SLUG,
      name: 'DNA writing-style analyst',
      description:
        "Extracts a clinician's writing style — sentence structure, verbosity, abbreviation habit, tone — from a time series of their own notes, as a closed-vocabulary profile. PLATFORM-OWNED: never cloned into a tenant, never listed or invokable on the business plane, never assignable. A tenant overrides only the INSTRUCTION, through its own DNA_ANALYSIS prompt template.",
      task: 'TEXT_GENERATION',
      // The same model as `casenote-finalization`: both produce a bounded, structured artifact
      // from clinical prose, and the platform funds both.
      modelSlug: 'lms-gemma-4-e2b-it-qat',
      fallbackModelSlugs: [],
      // The GENERAL instruction every tenant inherits — the same body the Global playground's
      // DNA_ANALYSIS template carries, inline here because a SYSTEM PromptTemplate would be
      // CLONED into every tenant by the reference set and so would hand each of them an
      // "override" on day one, defeating the cascade this agent exists to provide (D-2).
      instruction: { systemPrompt: DNA_ANALYSIS_CONTENT_V3 },
      // Temperature 0 for the reason every seeded LLM agent carries it, and doubly here: this is
      // a CLASSIFICATION into a closed vocabulary, so sampling entropy can only invent a style
      // the clinician does not write. Reasoning OFF (TASK-968 measured 92% of the completion
      // spent on reasoning tokens on this model) — a style extraction does not need deliberation.
      parameters: { generation: { temperature: 0, maxTokens: 2048, reasoning: { enabled: false } } },
      // The closed vocabulary IS the PHI containment (owner directive D-A, 2026-08-17): a field
      // whose only valid values are `'active' | 'passive' | 'mixed'` cannot smuggle a quoted
      // clinical sentence out of the corpus. Stated on the AGENT so a tenant that authors no
      // template of its own still gets it.
      outputSchema: DNA_OUTPUT_SCHEMA,
      status: 'PUBLISHED',
      isActive: true,
      tags: [tier, 'task:llm', 'capability:dna-writing-style', 'visibility:hidden'],
      provenance: null,
    },
    {
      id: ids(5),
      tenantId,
      slug: 'text-to-speech',
      name: 'Text-to-speech (Kokoro)',
      description: 'English speech synthesis on the local Kokoro engine, voice af_heart, 24 kHz WAV.',
      task: 'TEXT_TO_SPEECH',
      modelSlug: 'kokoro',
      fallbackModelSlugs: [],
      instruction: null,
      parameters: { voice: 'af_heart', language: 'en', speed: 1, format: 'wav', sampleRate: 24000 },
      outputSchema: null,
      status: 'PUBLISHED',
      isActive: true,
      tags: [tier, 'task:tts'],
      provenance: null,
    },
  ];
}

/** Global authors. */
export const GLOBAL_AGENT_SPECS: SeedAgentSpec[] = catalogue(
  SEED_TENANT_ID,
  glob,
  TEMPLATE_IDS.GENERAL_MEDICINE_CONSULTATION_SUMMARY,
  TEMPLATE_IDS.PRE_SUMMARY_DEFAULT,
);

/** SYSTEM is the promoted copy — provenance → the Global row of the same slug. */
export const PLATFORM_AGENT_SPECS: SeedAgentSpec[] = catalogue(
  SYSTEM_TENANT_ID,
  sys,
  SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID,
  TEMPLATE_IDS.PRE_SUMMARY_DEFAULT,
).map((spec) => {
  const source = GLOBAL_AGENT_SPECS.find((global) => global.slug === spec.slug);
  if (!source) throw new Error(`SYSTEM agent ${spec.slug} has no Global source`);
  return { ...spec, provenance: { sourceAgentId: source.id, sourceTenantId: source.tenantId, sourceSlug: source.slug, sourceVersionNumber: 1 } };
});

export interface SeedAgentAssignment {
  id: string;
  tenantId: string;
  task: SeedAgentTask;
  agentSlug: string;
  selectorKey?: string;
}

const assignmentsFor = (tenantId: string, offset: number): SeedAgentAssignment[] => [
  { id: assignmentId(offset + 1), tenantId, task: 'SPEECH_TO_TEXT', agentSlug: 'realtime-transcription' },
  { id: assignmentId(offset + 2), tenantId, task: 'TEXT_GENERATION', agentSlug: 'general-medicine-summarization' },
  { id: assignmentId(offset + 3), tenantId, task: 'TEXT_TO_SPEECH', agentSlug: 'text-to-speech' },
  { id: assignmentId(offset + 4), tenantId, task: 'NAMED_ENTITY_RECOGNITION', agentSlug: 'medical-ner' },
  // TASK-932 D-9 — the warm start, QUALIFIED. `TEXT_GENERATION` already carries an unqualified
  // TENANT row (the running note), and a second unqualified row for the same task would be a
  // coin-toss at resolve time. `phase:pre-summary` is TASK-891's reserved selector key
  // (`TEXT_PHASE_TAG_KEY`, `harness-policy.service.ts`) with a new value, so this row is a
  // candidate ONLY for a request that asks for it: `tierCandidates` admits a row whose selector
  // is a SUBSET of the request's tags, so an unqualified request still sees exactly the one
  // unqualified row it always did. The graph names the agent by SLUG on `n_presummary`, so
  // nothing depends on this row today — it is what a tenant re-points to change the warm start
  // without editing its graph.
  { id: assignmentId(offset + 5), tenantId, task: 'TEXT_GENERATION', agentSlug: PRE_SUMMARY_AGENT_SLUG, selectorKey: 'phase:pre-summary' },
];

/**
 * TENANT-scope assignments. SYSTEM's are the reference set a tenant is provisioned FROM (TASK-890
 * OD-M: content is CLONED, never read across tenants at run time); Global's are its own.
 */
export const PLATFORM_AGENT_ASSIGNMENTS: SeedAgentAssignment[] = assignmentsFor(SYSTEM_TENANT_ID, 0);
export const GLOBAL_AGENT_ASSIGNMENTS: SeedAgentAssignment[] = assignmentsFor(SEED_TENANT_ID, 10);

// ----------------------------------------------------------------------------------------------
// Row building (pure)
// ----------------------------------------------------------------------------------------------

export interface SeedModelRef {
  id: string;
  slug: string;
  taskType: string;
  provider: string | null;
  /** `AiModel.wireModelId` — what an invocation puts on the wire; `null` on a platform-self-host row. */
  wireModelId: string | null;
}

export type SeedResolvedPrompt =
  { source: 'template'; promptTemplateId: string; promptVersionNumber: number; content: string } | { source: 'inline'; content: string } | null;

/** `canonicalJson` of @arcaai/workflow-contract, verbatim (sorted keys, `undefined` dropped, no whitespace). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function buildCompiledConfig(
  spec: SeedAgentSpec,
  model: SeedModelRef,
  fallbacks: SeedModelRef[],
  resolvedPrompt: SeedResolvedPrompt,
): Record<string, unknown> {
  return {
    task: spec.task,
    service: AGENT_TASK_SERVICE[spec.task],
    // `wireModelId` is FROZEN beside the reference exactly as `AgentService.compile` freezes it
    // (present-and-null on a self-host row; never absent).
    model: { id: model.id, slug: model.slug, provider: model.provider ?? null, taskType: model.taskType, wireModelId: model.wireModelId ?? null },
    fallbacks: fallbacks.map((fallback, priority) => ({ priority, id: fallback.id, slug: fallback.slug, provider: fallback.provider ?? null })),
    instruction: spec.instruction,
    resolvedPrompt,
    parameters: spec.parameters,
    inputSchema: IO_DEFAULTS[spec.task].inputSchema,
    outputSchema: spec.outputSchema ?? IO_DEFAULTS[spec.task].outputSchema,
    tools: [],
    protocols: AGENT_PROTOCOLS[spec.task],
    // `contextSchema: null` — no seeded agent pins a context schema: a schema is CONTENT, cloned
    // per tenant; the trigger of the workflow binds it and `{{trigger.context.*}}` reads it.
    contextSchema: null,
    // ABSENT MEANS ON — the agent level of the guardrail precedence.
    guardrail: { enabled: guardrailEnabledOf(spec.parameters) },
  };
}

/** Mirrors `guardrailEnabledOf` in `AgentService` (duplicated: no dependency on the applications layer). */
function guardrailEnabledOf(parameters: Record<string, unknown> | null | undefined): boolean {
  const guards = parameters?.guards;
  if (guards === null || typeof guards !== 'object' || Array.isArray(guards)) return true;
  return (guards as Record<string, unknown>).enabled === false ? false : true;
}

export function checksumOf(compiled: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(compiled)).digest('hex')}`;
}

/** The `agent.create` data for one spec. PUBLISHED rows carry a compiledConfig; DRAFT rows do not. */
export function buildAgentRow(spec: SeedAgentSpec, model: SeedModelRef, fallbacks: SeedModelRef[], resolvedPrompt: SeedResolvedPrompt) {
  const published = spec.status === 'PUBLISHED';
  const compiled = published ? buildCompiledConfig(spec, model, fallbacks, resolvedPrompt) : null;
  return {
    id: spec.id,
    tenantId: spec.tenantId,
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    task: spec.task,
    versionNumber: 1,
    parentVersionId: null,
    sourceAgentId: spec.provenance?.sourceAgentId ?? null,
    sourceTenantId: spec.provenance?.sourceTenantId ?? null,
    sourceSlug: spec.provenance?.sourceSlug ?? null,
    sourceVersionNumber: spec.provenance?.sourceVersionNumber ?? null,
    status: spec.status,
    isActive: spec.isActive,
    modelId: model.id,
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    instruction: spec.instruction,
    parameters: spec.parameters,
    inputSchema: null,
    outputSchema: spec.outputSchema,
    tools: null,
    compiledConfig: compiled,
    compiledConfigChecksum: compiled ? checksumOf(compiled) : null,
    validationReport: published ? { checkedAt: COMPILED_AT, blocking: false, findings: [] } : null,
    validatedAt: published ? new Date(COMPILED_AT) : null,
    publishedAt: published ? new Date(COMPILED_AT) : null,
    tags: spec.tags,
    createdBy: SYSTEM_USER_ID,
  };
}

// ----------------------------------------------------------------------------------------------
// Seeding
// ----------------------------------------------------------------------------------------------

export interface SeedAgentsResult {
  created: number;
  skippedExisting: number;
  skippedUnresolvable: number;
  assignmentsCreated: number;
}

/** The slice of the Prisma client the seed touches — typed narrowly so the test can hand in a fake. */
export interface SeedAgentsClient {
  aiModel: {
    findMany(args: {
      where: { tenantId: string };
    }): Promise<Array<{ id: string; slug: string; taskType: string; provider: string | null; wireModelId: string | null }>>;
  };
  promptTemplate: {
    findUnique(args: {
      where: { id: string };
    }): Promise<{
      id: string;
      status: string | null;
      content: string | null;
      approvedVersionNumber: number | null;
      currentVersionNumber: number | null;
    } | null>;
  };
  promptVersion: { findFirst(args: { where: { promptTemplateId: string; versionNumber: number } }): Promise<{ content: string | null } | null> };
  agent: {
    findUnique(args: { where: { id: string }; select?: { id: true } }): Promise<{ id: string } | null>;
    create(args: { data: unknown }): Promise<unknown>;
  };
  agentModelFallback: { create(args: { data: unknown }): Promise<unknown> };
  agentAssignment: {
    findUnique(args: { where: { id: string }; select?: { id: true } }): Promise<{ id: string } | null>;
    create(args: { data: unknown }): Promise<unknown>;
  };
}

async function resolvePrompt(
  client: SeedAgentsClient,
  spec: SeedAgentSpec,
): Promise<{ ok: true; resolvedPrompt: SeedResolvedPrompt } | { ok: false; reason: string }> {
  if (spec.task !== 'TEXT_GENERATION' || !spec.instruction) return { ok: true, resolvedPrompt: null };
  const systemPrompt = spec.instruction.systemPrompt;
  if (typeof systemPrompt === 'string') return { ok: true, resolvedPrompt: { source: 'inline', content: systemPrompt } };
  const templateId = spec.instruction.promptTemplateId;
  if (typeof templateId !== 'string') return { ok: true, resolvedPrompt: null };
  const template = await client.promptTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: `prompt template ${templateId} is not seeded` };
  if (template.status !== 'APPROVED') return { ok: false, reason: `prompt template ${templateId} is ${template.status ?? 'DRAFT'}, not APPROVED` };
  const versionNumber =
    typeof spec.instruction.promptVersionNumber === 'number'
      ? spec.instruction.promptVersionNumber
      : (template.approvedVersionNumber ?? template.currentVersionNumber ?? 1);
  const version = await client.promptVersion.findFirst({ where: { promptTemplateId: templateId, versionNumber } });
  return {
    ok: true,
    resolvedPrompt: {
      source: 'template',
      promptTemplateId: templateId,
      promptVersionNumber: versionNumber,
      content: version?.content ?? template.content ?? '',
    },
  };
}

/**
 * Seed one spec list. `fallbackSeqStart` numbers this list's `AgentModelFallback` ids so two
 * lists never collide: SYSTEM starts at 1, Global at 100, ArcaAI (phase 29) at 200.
 */
export async function seedAgentSpecs(
  client: SeedAgentsClient,
  specs: SeedAgentSpec[],
  label: string,
  fallbackSeqStart: number,
): Promise<SeedAgentsResult> {
  console.log(`Seeding ${label} agents ...`);
  const result: SeedAgentsResult = { created: 0, skippedExisting: 0, skippedUnresolvable: 0, assignmentsCreated: 0 };
  const models = await client.aiModel.findMany({ where: { tenantId: SYSTEM_TENANT_ID } });
  const bySlug = new Map(models.map((model) => [model.slug, model]));
  let fallbackSeq = fallbackSeqStart;

  for (const spec of specs) {
    const existing = await client.agent.findUnique({ where: { id: spec.id }, select: { id: true } });
    if (existing) {
      result.skippedExisting += 1;
      // Keep the fallback id sequence stable across runs whether or not this row was created.
      fallbackSeq += spec.fallbackModelSlugs.length;
      continue;
    }
    const model = bySlug.get(spec.modelSlug);
    if (!model) {
      console.warn(`  ! ${spec.slug}: model '${spec.modelSlug}' is not in the SYSTEM registry — skipped (seed the catalogue first)`);
      result.skippedUnresolvable += 1;
      fallbackSeq += spec.fallbackModelSlugs.length;
      continue;
    }
    if (model.taskType !== AGENT_TASK_MODEL_TASK_TYPE[spec.task]) {
      console.warn(`  ! ${spec.slug}: model '${spec.modelSlug}' is ${model.taskType}, not ${AGENT_TASK_MODEL_TASK_TYPE[spec.task]} — skipped`);
      result.skippedUnresolvable += 1;
      fallbackSeq += spec.fallbackModelSlugs.length;
      continue;
    }
    const fallbacks: SeedModelRef[] = [];
    let fallbackMissing = false;
    for (const slug of spec.fallbackModelSlugs) {
      const fallback = bySlug.get(slug);
      if (!fallback) {
        console.warn(`  ! ${spec.slug}: fallback model '${slug}' is not in the SYSTEM registry — skipped`);
        fallbackMissing = true;
        break;
      }
      fallbacks.push(fallback);
    }
    if (fallbackMissing) {
      result.skippedUnresolvable += 1;
      fallbackSeq += spec.fallbackModelSlugs.length;
      continue;
    }
    const prompt = await resolvePrompt(client, spec);
    if (!prompt.ok) {
      console.warn(`  ! ${spec.slug}: ${prompt.reason} — skipped (fail closed)`);
      result.skippedUnresolvable += 1;
      fallbackSeq += spec.fallbackModelSlugs.length;
      continue;
    }

    const row = buildAgentRow(spec, model, fallbacks, prompt.resolvedPrompt);
    await client.agent.create({ data: row });
    for (const [priority, fallback] of fallbacks.entries()) {
      await client.agentModelFallback.create({
        data: {
          id: fallbackId(fallbackSeq++),
          tenantId: spec.tenantId,
          agentId: spec.id,
          priority,
          modelId: fallback.id,
          enabled: true,
          createdBy: SYSTEM_USER_ID,
        },
      });
    }
    result.created += 1;
    console.log(`  created ${spec.slug} (${spec.task}, ${spec.status}${spec.isActive ? ', isActive' : ''}, model ${model.slug})`);
  }
  return result;
}

/** TENANT-scope assignments for one tenant; a row is written only when its agent was seeded. */
export async function seedAgentAssignments(
  client: SeedAgentsClient,
  assignments: SeedAgentAssignment[],
  specs: SeedAgentSpec[],
  label: string,
): Promise<number> {
  let created = 0;
  for (const assignment of assignments) {
    const existing = await client.agentAssignment.findUnique({ where: { id: assignment.id }, select: { id: true } });
    if (existing) continue;
    const agent = await client.agent.findUnique({
      where: { id: specs.find((spec) => spec.slug === assignment.agentSlug)?.id ?? '' },
      select: { id: true },
    });
    if (!agent) {
      console.warn(`  ! ${label} assignment ${assignment.task} → ${assignment.agentSlug}: the agent was not seeded — skipped`);
      continue;
    }
    await client.agentAssignment.create({
      data: {
        id: assignment.id,
        tenantId: assignment.tenantId,
        scope: 'TENANT',
        scopeId: null,
        task: assignment.task,
        agentSlug: assignment.agentSlug,
        selectorKey: assignment.selectorKey ?? '',
        createdBy: SYSTEM_USER_ID,
      },
    });
    created += 1;
    console.log(`  assigned ${label} ${assignment.task}${assignment.selectorKey ? ` [${assignment.selectorKey}]` : ''} → ${assignment.agentSlug}`);
  }
  return created;
}

/** Global authors, then SYSTEM as the promoted copy; each with its four TENANT assignments. */
export async function seedAgents(client: CorePrismaClient | SeedAgentsClient): Promise<SeedAgentsResult> {
  const typed = client as unknown as SeedAgentsClient;
  const global = await seedAgentSpecs(typed, GLOBAL_AGENT_SPECS, 'Global (playground) authored', 100);
  const globalAssignments = await seedAgentAssignments(typed, GLOBAL_AGENT_ASSIGNMENTS, GLOBAL_AGENT_SPECS, 'Global');
  const platform = await seedAgentSpecs(typed, PLATFORM_AGENT_SPECS, 'SYSTEM (promoted copy)', 1);
  const platformAssignments = await seedAgentAssignments(typed, PLATFORM_AGENT_ASSIGNMENTS, PLATFORM_AGENT_SPECS, 'SYSTEM');
  return {
    created: global.created + platform.created,
    skippedExisting: global.skippedExisting + platform.skippedExisting,
    skippedUnresolvable: global.skippedUnresolvable + platform.skippedUnresolvable,
    assignmentsCreated: globalAssignments + platformAssignments,
  };
}
