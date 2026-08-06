/**
 * Frozen operation + provider vocabulary for the usage ledger (TASK-615 WS-B).
 *
 * `AiUsageEvent.operation` and `.provider` are `String` columns on purpose — a
 * new emitter must not need a migration. But they are also ROLLUP DIMENSIONS,
 * and an unbounded dimension is how `azure` and `Azure` become two providers to
 * Postgres and one provider to a human, halving a cost figure nobody can then
 * explain. This module is the bound: the schema stays migration-free, the
 * values stay canonical.
 *
 * The two halves are governed DIFFERENTLY, and the asymmetry is deliberate:
 *
 *   - **Operations are CLOSED.** Ten values, listed below. `recordUsage`
 *     rejects anything else. Adding an eleventh is a one-line change here plus
 *     a contract-doc line — cheap, reviewed, and visible to every lane.
 *
 *   - **Providers are OPEN but SHAPED.** A tenant admin can create an
 *     `AiProviderConnection` at runtime, so a closed list would silently drop
 *     real usage (real money) to protect a naming convention. `recordUsage`
 *     therefore enforces only the SHAPE; {@link KNOWN_PROVIDERS} is the
 *     canonical vocabulary that emitter lanes assert against in their own
 *     tests.
 */

/**
 * The ten operations. One per (capability, call shape) that a wave-1 emitter
 * can produce.
 *
 * | operation            | emitted by                                   |
 * |----------------------|----------------------------------------------|
 * | `transcribe.stream`  | WS-C — live STT socket teardown              |
 * | `transcribe.batch`   | WS-C — batch transcription job completion    |
 * | `generate`           | WS-D — non-streaming SMR generation          |
 * | `generate.stream`    | WS-D — streaming SMR generation (incl. abort)|
 * | `presummarize`       | WS-D — pre-summary pass                      |
 * | `guardrail.validate` | WS-D — guardrail LLM calls (metered, never quota-blocked, never invoiced) |
 * | `ner.extract`        | WS-E — NLP entity extraction                 |
 * | `tts.synthesize`     | WS-E — speech synthesis                      |
 * | `harness.step`       | WS-F — one agentic-loop step                 |
 * | `embed`              | WS-E/WS-D — retrieval + diarization embeddings |
 */
export const USAGE_OPERATIONS = [
  'transcribe.stream',
  'transcribe.batch',
  'generate',
  'generate.stream',
  'presummarize',
  'guardrail.validate',
  'ner.extract',
  'tts.synthesize',
  'harness.step',
  'embed',
] as const;

export type UsageOperation = (typeof USAGE_OPERATIONS)[number];

/** Exact-match membership test (case-sensitive — `transcribe.Batch` is not a member). */
export function isUsageOperation(value: unknown): value is UsageOperation {
  return typeof value === 'string' && (USAGE_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Canonical provider ids.
 *
 * TWO POPULATIONS, one namespace:
 *
 *   - **Connection ids** — verbatim from the `AiProviderConnection` seed
 *     (`packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts`).
 *     Note `azure` (NOT `azure-openai`, which is an SMR *setting* value),
 *     `lm-studio` and `llama-cpp` (hyphenated).
 *   - **Engine ids** — what the platform's own self-hosted engines report,
 *     verbatim from the Python services (`whisper_cpp`, `indic_parler` and
 *     friends are snake_case; they are model/engine identifiers, not slugs).
 *
 * The spellings are copied, not invented. Getting one wrong does not fail — it
 * silently forks a rollup dimension, which is worse.
 */
export const KNOWN_PROVIDERS = [
  // --- cloud / BYOK connection ids -----------------------------------------
  'openai',
  'azure',
  'azure-speech',
  'anthropic',
  'bedrock',
  'vertex',
  'sarvam',
  // --- self-hosted server connection ids ------------------------------------
  'ollama',
  'lm-studio',
  'vllm',
  'llama-cpp',
  'built-in',
  // --- self-hosted engine ids ----------------------------------------------
  'whisper_cpp',
  'faster_whisper',
  'kokoro',
  'indic_parler',
  'silero',
  'gliner',
] as const;

export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/** True only for a provider in the canonical vocabulary. NOT a gate — see the header. */
export function isKnownProvider(value: unknown): value is KnownProvider {
  return typeof value === 'string' && (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Lowercase id shape: `[a-z0-9]` then up to 63 of `[a-z0-9._-]`.
 *
 * Lowercase is enforced, not normalised: silently down-casing would hide the
 * emitter bug that produced `Azure`, and the next dimension it forks might not
 * be one a regex can repair.
 */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Validate a provider id's SHAPE (not its membership).
 *
 * @returns every violation; empty means acceptable.
 */
export function validateProviderId(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) {
    return ['provider must be a non-empty string'];
  }
  if (!PROVIDER_ID.test(value)) {
    return [`provider "${value}" must be a lowercase id matching ${PROVIDER_ID.source} (see vocabulary.ts)`];
  }
  return [];
}
