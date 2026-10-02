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
 *   general-medicine-summarization  TEXT_GENERATION           gemma + the General Medicine summary template + output-language policy, guards ON
 *   casenote-finalization           TEXT_GENERATION           gemma + inline system prompt + output-language policy, `{ case_note, redactions }` output schema
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
import { SEED_TENANT_ID, SYSTEM_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import {
  DNA_ANALYSIS_CONTENT_V3,
  DNA_OUTPUT_SCHEMA,
  GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES,
  GLOBAL_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
  SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID,
  TEMPLATE_IDS,
  outputLanguagePolicyFragment,
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

/**
 * Id blocks: `9c000000-…-0001-` SYSTEM agents, `-0002-` Global agents, `-0003-` fallbacks, `-0004-` assignments, `-0005-` ArcaAI agents (phase 29),
 * `-0006-` Global PLAYGROUND-ONLY agents (never promoted, never assigned — see `GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS`).
 */
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

/**
 * TASK-1001 (OD-8) — the agents that WRITE THE NOTE, and therefore carry the tenant's output-language
 * policy as their last, unconditional, unpinned fragment. The same shape the 22 ArcaAI department
 * agents took in wave 1 (`29-arcaai-agents-and-workflows.ts`).
 *
 * Deliberately NOT on this list, each for its own reason:
 *  - `realtime-transcription`, `medical-ner`, `text-to-speech` — they write no note (and only a
 *    TEXT_GENERATION instruction has a prompt to compose into);
 *  - `case-notes-pre-summary` — its body already binds `{{context.language_name}}`, which the
 *    runtime resolves from the platform default output language, so a policy fragment would state
 *    the rule a second time — the reason ArcaAI's own warm start was left without one in wave 1
 *    (`output-language-policy.task1001.test.ts`);
 *  - `dna-writing-style-analyst` — the PLATFORM HIDDEN agent (TASK-974 D-1) is configuration, not
 *    content: never cloned, so a tenant policy fragment could never reach its row anyway, and its
 *    output is a closed-vocabulary style profile, not a note.
 */
export const OUTPUT_LANGUAGE_POLICY_AGENT_SLUGS = ['general-medicine-summarization', 'casenote-finalization'] as const;

/**
 * The key of the note agent's own clinical body inside its composite instruction — the spelling the
 * ArcaAI department agents use, so every note-writing agent in the seed reads the same way in the
 * console and in per-call fragment telemetry.
 */
export const CLINICAL_NOTE_FRAGMENT_KEY = 'clinical_note';

// ----------------------------------------------------------------------------------------------
// Shared configuration (exported so phase 29 builds the ArcaAI department agents the same way)
// ----------------------------------------------------------------------------------------------

/**
 * The `realtime-transcription` agent's parameters (TASK-938: `wordTimestamps: true`, guarded
 * by the adapter's own pinned-language refusal rather than by this flag).
 *
 * TASK-985 (M-58) — this block said "`platform-transcription`", a slug that exists nowhere in
 * this repo; the agent is `realtime-transcription` (`ASR_AGENT_SLUG`, above).
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
 *     applied): overrides the assigned model's window to trade decode-tail length for latency.
 *     TASK-985 (M-58) — the number named here was wrong in both directions. The ml-en GGUF rows
 *     carry `partialWindowSec: 6`, not 15; and TASK-934 measured a SHORT partial tail as the
 *     damage (31% garbage partials at 6 s against 0% at 15 s), so 3 s runs the experiment
 *     TOWARDS the measured-worse end. It is a deliberate latency trade, not a settled win, and
 *     it is a live A/B arm: revert it before attributing a partial-quality regression elsewhere.
 *     The revert rule lives with the ALaaS runbook named below, in a SEPARATE repository — this
 *     repo contains no `apps/audio-stream-svc`.
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
  // TASK-985 (M-14) — `beamSize: 5` is INERT on this agent's engine and is kept deliberately.
  // pywhispercpp fixes the sampling strategy at `Model()` construction and every loader builds a
  // GREEDY context, so beam fields are never read; reaching beam search needs a second whisper
  // context (a second full weight allocation), not a kwarg. The resolver now says so rather than
  // claiming a tier for it — `decoding.sources.beamSize` resolves to `unsupported:whisper.cpp` on
  // this chain and to `agent` on the CTranslate2 fallback, which does honour it. The value stays
  // because it is the correct instruction for the fallback and because it is the live RED case
  // the honesty test pins.
  decoding: { languageMode: 'ml-en', prevTextContextWords: 0, codeSwitching: true, wordTimestamps: true, beamSize: 5, temperature: 0 },
  // TASK-966 — `cadence-fast` is the EXACT name `stt.punctuation.service` routes to its direct
  // transformers loader; the previous `cadence-punctuation` binding selected the legacy wrapper
  // path that cannot load under transformers 5.x, so the seeded agents ran unpunctuated.
  postProcessing: { punctuation: { enabled: true, modelSlug: 'cadence-fast' }, disfluency: true, stabilizer: true },
  // Lane F2: partialIntervalMs 500 -> 300, partialWindowSec added at 3 (was unset / model default 6).
  // TASK-994 (2026-09-21): partialWindowSec 3 -> 7, partialIntervalMs 300 -> 500, measured live through
  // the WS gateway on 37 code-switched clips — the 3 s / 300 ms tail fed the semantic endpointer the
  // noisiest hypotheses (65 % garbage partials) and cost ~0.1 CER on the FINALS through the utterance
  // cuts; 7 s and 15 s tied on finals, 7 s committing earlier and equalling the row's decode window.
  // `decoding.prevTextContextWords: 0` (previous-final carry-over off): −0.117 CER on multi-final clips.
  // The row's `partialWindowSec 6` stays the platform default for agents without an opinion.
  streaming: { partialIntervalMs: 500, partialWindowSec: 7, endpointing: 'semantic', maxUtteranceSec: 60 },
  fallback: { autoSwitch: true, switchAfterConsecutiveFailures: 3 },
};
/**
 * TASK-985 (M-57) — `hotwords` is ABSENT here, and that absence is load-bearing.
 *
 * The key used to be seeded as `[] as string[]`, which was harmless only because the
 * resolver could not tell an empty list from a missing one: both collapsed to `[]` before
 * the precedence branch ran, so the assigned model row's 20 clinical terms flowed through
 * anyway. That collapse is now FIXED — an explicitly empty list is a tenant's VETO, and the
 * runtime derives the lexicon correction stage's default from `bool(instruction.hotwords)`.
 *
 * Had the literal stayed, fixing M-57 would have turned the correction stage OFF for every
 * seeded tenant, silently, and cut the row's vocabulary out of the decode with it. Omitting
 * the key says what this agent actually means: no opinion, inherit the model row's terms.
 * The two changes belong to one commit and must never be split.
 *
 * `initialPrompt` OVERRIDES the assigned model row's `_metadata.asr.initialPrompt` — one
 * tier wins whole, they are never concatenated. Clearing it here is therefore how an
 * operator hands the prompt decision back to the row (TASK-985 ST-3).
 */
// TASK-994 (2026-09-21) — NO `initialPrompt` on the ml-en agent. Measured on two independent
// code-switched recordings at the served 7 s window: the previous prompt ("Clinical consultation
// between a clinician and a patient. English and Malayalam medical terminology.") raised mean CER
// from 0.390 to 0.680 (37 clips, worse on 32) and from 0.363 to 0.623 (23 clips, worse on 18),
// deleting about half of every span — the early-stop mechanism TASK-985 §2.7 isolated for the
// bilingual priming prompt, which TASK-985 had measured as neutral on ENGLISH fixtures only. Live
// through the WS gateway clearing it moved 0.696 → 0.481 (30/37 better). Any prior text in the
// window (prompt, priming template, previous-final carry-over) hurts this fine-tune; see
// `prevTextContextWords: 0` above and `task-994-asr-agent-prompt.test.ts`.
export const ASR_INSTRUCTION = {};

/**
 * TASK-1000 — the output-budget floor every seeded summarization agent starts from, and the
 * per-section allowance above it. Mirrored by `OUTPUT_TOKENS_ABSOLUTE_FLOOR` /
 * `OUTPUT_TOKENS_PER_SECTION` in `@arcaai/applications`, which enforces the same rule at runtime;
 * `packages/database` cannot import that package, so the parity is pinned by a test instead.
 */
export const SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS = 8192;
export const SUMMARIZATION_TOKENS_PER_SECTION = 512;

/** The budget a note shape of `sectionCount` sections is seeded with. */
export const summarizationMaxTokens = (sectionCount: number): number =>
  Number.isFinite(sectionCount) && sectionCount > 0
    ? Math.max(SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS, Math.ceil(sectionCount) * SUMMARIZATION_TOKENS_PER_SECTION)
    : SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS;

/**
 * The per-turn summarization hyper-parameters. (No `guards.enabled`: the guardrail opt-out is
 * retired, so guardrail screening — GLiNER2 included — is not a per-agent setting any more.)
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
  generation: { temperature: 0, maxTokens: SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS, reasoning: { enabled: false } },
  responseFormat: 'text',
};

/**
 * TASK-1000 — the same parameters, sized for a note shape with `sectionCount` sections.
 *
 * ## Why one constant could not serve 22 agents
 *
 * Every `arcaai-*-summary-*` agent shared {@link SUMMARIZATION_PARAMETERS} and therefore a single
 * `maxTokens: 2048`, across templates running from 5 sections (diet revisit) to 23 (surgical
 * oncology intake). On 2026-09-22 a 14-section note outgrew that budget partway through a real
 * consultation: the engine reported `stop_reason: "length"`, the turn JSON was cut mid-string,
 * and the degrade path wrote the fragment into the note's first section. A budget that is a
 * property of the TEMPLATE cannot be a constant shared by every template.
 *
 * ## Why the runtime ALSO enforces this
 *
 * This function fixes tenants provisioned from here on. It cannot fix the 22 rows already in a
 * running database: `seedAgentSpecs` is create-only, the reference-set resync is `missing-only`,
 * and a published agent's `parameters` are immutable (a DB trigger raises `restrict_violation`).
 * The authoritative guard is therefore the runtime clamp in
 * `@arcaai/applications` → `live-documentation/output-budget.ts`, which bounds every live
 * generation into `[templateFloor, platformCeiling]` whatever the row says. The two agree by
 * construction — same floor, same per-section allowance — and this one exists so the value an
 * admin READS on the agent matches the value the flush actually runs under.
 */
export const summarizationParameters = (sectionCount: number): typeof SUMMARIZATION_PARAMETERS => ({
  ...SUMMARIZATION_PARAMETERS,
  generation: { ...SUMMARIZATION_PARAMETERS.generation, maxTokens: summarizationMaxTokens(sectionCount) },
});

/** `NEW_VISIT_NOTE_SHAPE` / `REVISIT_NOTE_SHAPE` headings, as the text constant the prompt reads. */
export const headingList = (shape: { sections: ReadonlyArray<{ title: string }> }): string =>
  shape.sections.map((section) => section.title).join(' | ');

/**
 * F6 — a binding for EVERY variable the General Medicine template declares. The §8.2 fields it
 * reads (eight of the nine since TASK-1001 dropped `language` from the body) resolve from the
 * trigger's validated context (`{{trigger.context.*}}`, INTERFACES §8.3); the two
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
 * `buildPromptScope` publishes the trigger under BOTH `trigger` and `context`
 * (`@arcaai/workflow-contract prompt-scope.ts`), so `{{context.safe_age}}` already resolves from
 * `trigger.context.safe_age` with no binding at all. The bindings below are declared anyway, for
 * two reasons that are not decoration:
 *
 *  - the bare name and the dotted path must be the SAME value ("`{{age}}` and
 *    `{{context.patientAge}}` are the same value", `@arcaai/workflow-contract prompt-scope.ts` §3.3), and declaring
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
  // TASK-1000 (OD-9) — 3072 -> 12288, and INDEPENDENT of the per-turn budget.
  //
  // The two budgets were coupled by a test asserting `PRE_SUMMARY > SUMMARIZATION`. They answer
  // different questions — this one reproduces a whole prior record under five headings from the
  // case-note corpus, the other extends one note by one turn — and they read different templates,
  // so a relational invariant would block either from being tuned on its own evidence. The
  // invariant is now two absolute floors. 12288 keeps the warm start's historical ratio to the
  // per-turn floor (3072 : 2048 = 1.5 ⇒ 8192 × 1.5) rather than inventing a new relationship.
  generation: { temperature: 0, maxTokens: 12288, reasoning: { enabled: false } },
  responseFormat: 'text',
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
 *
 * TASK-1034 R3 — the CLINICIAN REDACTION RULES block. `{{context.dna_redaction_rules_text}}` is the
 * doctor's redaction/rewrite rules rendered as a bullet list (`renderDnaRedactionRulesText`), emitted
 * by the live handoff behind the redaction gate. It TELLS the model what the deterministic
 * post-generation pass (`apply_redaction`) enforces anyway — that pass stays the guarantee. It sits
 * BEFORE the style block, so "the redaction rules above outrank the style" covers it too.
 *
 * TASK-1022 — the HEADINGS block. The prompt used to ask for "the document template headings
 * exactly as they appear in the partial summaries" while the user turn carried the section bodies
 * with no titles, so the model invented a layout. The input now arrives headed (`## <title>`,
 * harness `_render_input_for_generation`) and the frozen template's titles arrive on the handoff as
 * `document_headings`; the default covers every path that has no frozen template (the note then
 * keeps the input's own headings). `Not discussed` is the owner's literal marker (OD-1 (b)). The
 * diagnosis rule RECORDS an update the conversation states; it licenses no inference, so it sits
 * under "never add findings, diagnoses…" rather than against it.
 */
export const CASENOTE_FINALIZATION_SYSTEM_PROMPT =
  "You are a clinical documentation assistant finalizing the case note of a consultation that has ended. You are given the running partial summaries produced during the consultation and the clinician's work notes. Produce ONE finalized case note that merges every partial into a single coherent, non-repetitive note, and preserves every clinical fact, medication, dose, date and instruction exactly as recorded. Redact residual PII: replace any personal name, identifier, address, phone number or email that slipped into the note with a bracketed placeholder such as [NAME] or [ID], and list each redaction with its label. Use only facts present in the input; never add findings, diagnoses, recommendations or plans of your own, and never write a clinical code. THE FINALIZED NOTE IS ENTIRELY IN ENGLISH: the partials reach you already translated, so should any Malayalam script or romanised Malayalam have survived into them, translate it into the standard English clinical term here rather than copying it forward — translating carries the meaning across and adds nothing, and drug names, doses, numbers, units, dates, values and proper names are reproduced, never translated.\n\n" +
  '=== DOCUMENT HEADINGS ===\n' +
  'The document template headings, in order, are:\n{{trigger.context.document_headings | default("")}}\n' +
  'Write the note under EXACTLY these headings, in exactly this order, each as a `## ` Markdown heading worded exactly as listed (without its number). When the list above is empty, use the `## ` headings of the input instead, in the order they appear there. Every heading appears exactly once, and no other heading is added. Put each fact under the heading it belongs to, even when a partial recorded it under a different one, and state it only once. A heading with nothing recorded for it gets exactly the line `Not discussed`: never a paraphrase of it, and never content of your own. Under the assessment or diagnosis heading, record the diagnosis the conversation states, including every update the conversation makes to it (for example once results are discussed), so the note carries the latest diagnosis stated; this is recording, not inferring, and a diagnosis the conversation does not state is never written.\n\n' +
  '=== CLINICIAN REDACTION RULES ===\n' +
  'Never include / always rewrite:\n{{context.dna_redaction_rules_text | default("")}}\n' +
  'These are the clinician`s own rules. Never write anything a rule says never to write, and always write what a rule says to rewrite in exactly the form it gives. A rule changes only the wording it names: it never removes, adds or alters a clinical fact, drug name, dose, value, date or heading beyond that wording. When the list above is empty, ignore this block.\n\n' +
  '=== WRITING STYLE ===\n' +
  'The clinician`s own documentation style, when one is supplied, is:\n{{context.dna_style_text | default("")}}\n' +
  'Apply it to HOW the note reads — sentence length, register, abbreviation habit, the order in which findings are stated within a heading — and to nothing else. It must never change WHAT the note says: not one clinical fact, drug name, dose, route, frequency, value, date, laterality or heading may be added, removed, reworded into a different meaning, or re-ordered between headings to suit it. An abbreviation is used only where the style calls for one AND the expansion is unambiguous in context. When the block above is empty, write in plain clinical prose and change nothing about your output.\n' +
  'The redaction rules above outrank the style in every case: a name is replaced with its placeholder however the clinician would have written it.\n\n' +
  'Return a JSON object with `case_note` (the finalized Markdown note) and `redactions` (an array of `{ text, label }`).';

/**
 * The finalizer's parameters — one constant, because ArcaAI seeds its own `casenote-finalization`
 * (phase 29, TASK-1020) and must finalize exactly as the platform row does. The reasoning and
 * temperature posture is explained at the `casenote-finalization` spec below.
 */
export const CASENOTE_FINALIZATION_PARAMETERS = {
  generation: { temperature: 0, maxTokens: 4096, reasoning: { enabled: false } },
};

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
 * by tenant, id, the template ids each tenant owns, and provenance.
 *
 * TASK-1001 (OD-8) — `outputLanguagePolicyTemplateId` is the tenant's OWN policy row: an agent
 * never binds another tenant's template, and the reference-set copy re-points each clone's
 * fragment at the target tenant's clone of it.
 */
function catalogue(
  tenantId: string,
  ids: (n: number) => string,
  generalMedicineTemplateId: string,
  preSummaryTemplateId: string,
  outputLanguagePolicyTemplateId: string,
): SeedAgentSpec[] {
  const tier = tenantId === SYSTEM_TENANT_ID ? 'tier:platform-default' : 'tier:playground';
  return [
    {
      id: ids(1),
      tenantId,
      slug: 'realtime-transcription',
      name: 'Realtime transcription (whisper.cpp ML/EN)',
      // TASK-985 (M-58) — the description used to claim "Silero VAD gating" and "the Q8_0 GGUF
      // and the CTranslate2 turbo as fallbacks". Neither was true of what runs: TASK-977 (D-1)
      // made VAD an opt-in stage and this agent leaves it OFF (`audioFrontEnd.vad.enabled:
      // false`), and until TASK-985 carried the chain whole the gateway took `chain[0]` only, so
      // the CT2 turbo was never reachable. Both are now accurate: VAD is off, and the chain is
      // ordered and complete.
      description:
        'Realtime + batch speech-to-text on the in-house Malayalam/English whisper.cpp GGUF (F16), energy segmentation (Silero VAD bound but OFF), Cadence punctuation; fallback chain: the Q8_0 GGUF, then the CTranslate2 turbo.',
      task: 'SPEECH_TO_TEXT',
      // TASK-938 (owner directive 2026-09-09): back to the F16 row, reverting TASK-930's move to
      // Q8_0. The two measured within 0.005 CER of each other (TASK-934), so this is not an
      // accuracy claim — it restores the weights that were serving before the 2026-09-06 baseline
      // so the live A/B has one variable fewer. Q8_0 stays first in the fallback chain.
      modelSlug: 'arcaai-whisper-large-ml-en-gguf',
      // TASK-985 (M-49) — both entries are LIVE now. Until the chain travelled whole only
      // `[0]` did, so the only reachable fallback was the q8_0 quantisation of this very
      // primary: same weights, same failure modes, and therefore protection against exactly
      // one class (the f16 artifact failing to load or OOM-ing) and nothing else. Entry 2 is
      // a different RUNTIME over the same family — a genuinely independent decode path — and
      // it only became reachable with the chain.
      //
      // Worth stating plainly, because it bounds what this chain can buy: `EngineSwitchController`
      // arms on `ModelError` / `CloudASRTranscriptionError`, so a decoder that returns empty or
      // truncated text is a SUCCESS to the switch and triggers no failover at all. The chain is
      // availability insurance, not an accuracy backstop (OD-H).
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
      // TASK-1001 (OD-8) — COMPOSITE: the General Medicine body (template and pin unchanged), then
      // the tenant's output-language policy, LAST so it is the instruction nearest the generation
      // point. The body's rule 5 used to say "write all content values in the conversation language";
      // the policy names that clause and overrides it. Since the owner directive of 2026-09-23 rule 5
      // itself names English, and the policy remains the tenant's lever for its own language.
      // `variables` stays on the instruction: it binds what EVERY fragment reads (the policy reads none).
      instruction: {
        fragments: [
          { key: CLINICAL_NOTE_FRAGMENT_KEY, promptTemplateId: generalMedicineTemplateId, promptVersionNumber: 1 },
          outputLanguagePolicyFragment(outputLanguagePolicyTemplateId),
        ],
        variables: generalMedicinePromptVariables(),
      },
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
      // TASK-1001 (OD-8) — COMPOSITE: the inline finalization body becomes an INLINE fragment
      // (byte-identical), then the tenant's output-language policy. The policy adds the
      // headings-stay-English clause (S-4) and sits under the platform-reserved key, so the
      // runtime reads this agent's language as the tenant's. NOTE: the body itself still says the
      // finalized note is entirely in English — a tenant that moves its policy AWAY from English
      // must edit this fragment of its copy too, or the two instructions disagree.
      instruction: {
        fragments: [
          { key: CLINICAL_NOTE_FRAGMENT_KEY, systemPrompt: CASENOTE_FINALIZATION_SYSTEM_PROMPT },
          outputLanguagePolicyFragment(outputLanguagePolicyTemplateId),
        ],
      },
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
      parameters: CASENOTE_FINALIZATION_PARAMETERS,
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
  GLOBAL_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
);

/** SYSTEM is the promoted copy — provenance → the Global row of the same slug. */
export const PLATFORM_AGENT_SPECS: SeedAgentSpec[] = catalogue(
  SYSTEM_TENANT_ID,
  sys,
  SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID,
  TEMPLATE_IDS.PRE_SUMMARY_DEFAULT,
  SYSTEM_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
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
// Global playground-only agents
// ----------------------------------------------------------------------------------------------

/**
 * TASK-1010 (OD-12) — the lineage key of the vLLM Whisper agent. TASK-1021 dropped its `-spike`
 * suffix when `apps/asr-vllm` became `apps/vllm`; it is still playground-only.
 *
 * Owner rule: model selection is ALWAYS through an agent — the bench and `apps/vllm` reach the
 * vLLM registry row (`arcaai-whisper-large-ml-en-vllm`) by `agentSlug`, never by a model slug.
 */
export const VLLM_ASR_AGENT_SLUG = 'realtime-transcription-vllm';

const playgroundOnly = (n: number) => `9c000000-0000-0000-0006-${String(n).padStart(12, '0')}`;

/**
 * Agents the Global PLAYGROUND authors and deliberately does NOT promote: trials, not platform
 * content. The deliberate differences from {@link GLOBAL_AGENT_SPECS}:
 *
 *  · no SYSTEM copy — so the reference set (phase 26) can never clone one into a customer tenant
 *    (TASK-890 OD-M: content is cloned from SYSTEM, never from Global);
 *  · no `AgentAssignment` and no workflow names them — so no assignment cascade or governing
 *    workflow resolves one implicitly. Only a request that names the slug reaches it.
 *
 * Promotion stays what it always is: an explicit `POST /admin/agents/promote-to-system`.
 */
export const GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS: SeedAgentSpec[] = [
  {
    id: playgroundOnly(1),
    tenantId: SEED_TENANT_ID,
    slug: VLLM_ASR_AGENT_SLUG,
    name: 'Realtime transcription — vLLM (ML/EN)',
    description:
      'The in-house Malayalam/English Whisper fine-tune (fp16) on the vLLM inference service (`apps/vllm`, continuous batching across streams). Playground-only: never promoted, never assigned — reached only by naming this agent.',
    task: 'SPEECH_TO_TEXT',
    modelSlug: 'arcaai-whisper-large-ml-en-vllm',
    // No fallback chain: the spike measures ONE engine, and a silent failover to another runtime
    // would hide exactly the failures it exists to find.
    fallbackModelSlugs: [],
    // The `realtime-transcription` agent's instruction and parameters, verbatim — one variable (the
    // serving engine) between the two agents.
    instruction: ASR_INSTRUCTION,
    parameters: ASR_PARAMETERS,
    outputSchema: null,
    status: 'PUBLISHED',
    isActive: true,
    tags: ['tier:playground', 'task:stt', 'capability:transcription', 'spike:task-1010'],
    provenance: null,
  },
];

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

/**
 * TASK-947 — one fragment of a COMPOSITE artifact. Field-for-field `ResolvedPromptFragment` of
 * `@arcaai/workflow-contract`; `when` is `null` (never absent) for an unconditional fragment,
 * because `staticProjection` and the realtime selector both read it that way.
 */
export interface SeedResolvedPromptFragment {
  key: string;
  source: 'template' | 'inline';
  promptTemplateId?: string;
  promptVersionNumber?: number;
  content: string;
  when: string | null;
}

export type SeedResolvedPrompt =
  | { source: 'template'; promptTemplateId: string; promptVersionNumber: number; content: string }
  | { source: 'inline'; content: string }
  | { source: 'composite'; content: string; join: string; fragments: SeedResolvedPromptFragment[] }
  | null;

/** `PROMPT_COMPOSITION_JOIN` of @arcaai/workflow-contract, verbatim (this package takes no contract dependency). */
const PROMPT_COMPOSITION_JOIN = '\n\n';

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
    // TASK-983 OD-6 — `protocols` (per-task, never enforced) is REMOVED; NER's one-shot posture
    // (`?mode=stream` → 400 `MODE_UNSUPPORTED`) is enforced in `AgentController.invokeNer`.
    // `contextSchema: null` — no seeded agent pins a context schema: a schema is CONTENT, cloned
    // per tenant; the trigger of the workflow binds it and `{{trigger.context.*}}` reads it.
    contextSchema: null,
  };
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
    findUnique(args: { where: { id: string } }): Promise<{
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

/**
 * ONE template binding, resolved: APPROVED status, and the body of the version it pins (or of the
 * template's own approved/current version when it pins none).
 *
 * Extracted from `resolvePrompt` unchanged so the single-body form and each fragment of a
 * composite resolve by the SAME rule — which is the property `AgentService.resolveTemplateBinding`
 * exists to provide on the publish path this mirrors.
 */
async function resolveTemplateBinding(
  client: SeedAgentsClient,
  templateId: string,
  pinned: number | null,
): Promise<{ ok: true; promptVersionNumber: number; content: string } | { ok: false; reason: string }> {
  const template = await client.promptTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: `prompt template ${templateId} is not seeded` };
  if (template.status !== 'APPROVED') return { ok: false, reason: `prompt template ${templateId} is ${template.status ?? 'DRAFT'}, not APPROVED` };
  const versionNumber = pinned ?? template.approvedVersionNumber ?? template.currentVersionNumber ?? 1;
  const version = await client.promptVersion.findFirst({ where: { promptTemplateId: templateId, versionNumber } });
  return { ok: true, promptVersionNumber: versionNumber, content: version?.content ?? template.content ?? '' };
}

/**
 * TASK-1001 — the COMPOSITE form (`instruction.fragments[]`), compiled exactly as
 * `AgentService.resolveCompositePrompt` compiles it at publish:
 * `{ source: 'composite', content: <static projection>, join, fragments }`, fragments in AUTHORED
 * order, the static projection being the UNCONDITIONAL fragments joined.
 *
 * This branch exists because without it a composite spec fell through `resolvePrompt`'s
 * `typeof templateId !== 'string'` guard to `resolvedPrompt: null` — which is not a seed failure
 * but something worse: a PUBLISHED agent whose compiled artifact carries no prompt at all, so the
 * live lane falls back to the platform system prompt and the department's clinical instruction is
 * silently gone. Fail CLOSED instead, like every other unresolvable binding here.
 *
 * Both fragment kinds compile: a TEMPLATE fragment through `resolveTemplateBinding` (the ArcaAI
 * department agents, and every policy fragment), an INLINE one (`systemPrompt`) verbatim as
 * `{ source: 'inline', content }` — which `casenote-finalization` relies on since OD-8 moved its
 * inline body into a fragment beside the policy.
 */
async function resolveCompositePrompt(
  client: SeedAgentsClient,
  fragments: unknown[],
): Promise<{ ok: true; resolvedPrompt: SeedResolvedPrompt } | { ok: false; reason: string }> {
  const compiled: SeedResolvedPromptFragment[] = [];

  for (const [index, raw] of fragments.entries()) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, reason: `instruction.fragments[${index}] is not an object` };
    const fragment = raw as Record<string, unknown>;
    const key = typeof fragment.key === 'string' ? fragment.key : '';
    if (!key) return { ok: false, reason: `instruction.fragments[${index}] has no key` };
    const when = typeof fragment.when === 'string' ? fragment.when : null;

    const promptTemplateId = typeof fragment.promptTemplateId === 'string' ? fragment.promptTemplateId : null;
    const systemPrompt = typeof fragment.systemPrompt === 'string' ? fragment.systemPrompt : null;

    if (promptTemplateId === null) {
      if (systemPrompt === null) {
        return { ok: false, reason: `instruction.fragments[${index}] (${key}) binds neither promptTemplateId nor systemPrompt` };
      }
      compiled.push({ key, source: 'inline', content: systemPrompt, when });
      continue;
    }

    const outcome = await resolveTemplateBinding(
      client,
      promptTemplateId,
      typeof fragment.promptVersionNumber === 'number' ? fragment.promptVersionNumber : null,
    );
    if (!outcome.ok) return { ok: false, reason: `instruction.fragments[${index}] (${key}): ${outcome.reason}` };
    compiled.push({
      key,
      source: 'template',
      promptTemplateId,
      promptVersionNumber: outcome.promptVersionNumber,
      content: outcome.content,
      when,
    });
  }

  return {
    ok: true,
    resolvedPrompt: {
      source: 'composite',
      // `staticProjection` — the UNCONDITIONAL fragments only (OD-3), so a reader that predates
      // fragments still serves the base prompt rather than nothing.
      content: compiled
        .filter((fragment) => fragment.when === null)
        .map((fragment) => fragment.content)
        .join(PROMPT_COMPOSITION_JOIN),
      join: PROMPT_COMPOSITION_JOIN,
      fragments: compiled,
    },
  };
}

async function resolvePrompt(
  client: SeedAgentsClient,
  spec: SeedAgentSpec,
): Promise<{ ok: true; resolvedPrompt: SeedResolvedPrompt } | { ok: false; reason: string }> {
  if (spec.task !== 'TEXT_GENERATION' || !spec.instruction) return { ok: true, resolvedPrompt: null };
  // Composite FIRST, exactly as `AgentService.resolvePrompt` dispatches: the three forms are
  // mutually exclusive (`agentConfigProblems` enforces it), and reading `systemPrompt` off a
  // composite would silently serve one fragment's body as the whole prompt.
  if (Array.isArray(spec.instruction.fragments)) return resolveCompositePrompt(client, spec.instruction.fragments);
  const systemPrompt = spec.instruction.systemPrompt;
  if (typeof systemPrompt === 'string') return { ok: true, resolvedPrompt: { source: 'inline', content: systemPrompt } };
  const templateId = spec.instruction.promptTemplateId;
  if (typeof templateId !== 'string') return { ok: true, resolvedPrompt: null };
  const outcome = await resolveTemplateBinding(
    client,
    templateId,
    typeof spec.instruction.promptVersionNumber === 'number' ? spec.instruction.promptVersionNumber : null,
  );
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  return {
    ok: true,
    resolvedPrompt: {
      source: 'template',
      promptTemplateId: templateId,
      promptVersionNumber: outcome.promptVersionNumber,
      content: outcome.content,
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

/**
 * TASK-1010 — the Global playground-only agents. Create-only like every seeded agent, and NO
 * assignments: that absence is the point (see {@link GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS}). Its own
 * fallback id range (150) so a future entry with a chain can never collide with Global's (100) or
 * ArcaAI's (200).
 */
export async function seedGlobalPlaygroundOnlyAgents(client: CorePrismaClient | SeedAgentsClient): Promise<SeedAgentsResult> {
  return seedAgentSpecs(client as unknown as SeedAgentsClient, GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS, 'Global (playground-only, never promoted)', 150);
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
