/**
 * Frozen operation + provider vocabulary for the usage ledger.
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
 *   - **Operations are CLOSED.** Twelve values, listed below. `recordUsage`
 *     rejects anything else. Adding a thirteenth is a one-line change here plus
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
 * The twelve operations. One per (capability, call shape) that an emitter can
 * produce.
 *
 * | operation            | emitted by                                   |
 * |----------------------|----------------------------------------------|
 * | `transcribe.stream` | — live STT socket teardown |
 * | `transcribe.batch` | — batch transcription job completion |
 * | `generate` | — non-streaming TEXT generation |
 * | `generate.stream` | — streaming TEXT generation (incl. abort)|
 * | `presummarize` | — pre-summary pass |
 * | `guardrail.validate` | — guardrail LLM calls (metered, never quota-blocked, never invoiced) |
 * | `ner.extract` | — NLP entity extraction |
 * | `tts.synthesize` | — speech synthesis |
 * | `harness.step` | — one agentic-loop step |
 * | `embed` | / — retrieval + diarization embeddings |
 * | `workflow.step` | — one durable/realtime workflow node, and the durable worker's own CPU for it |
 * | `storage.snapshot` | — the nightly per-(tenant, storage class) GB-day snapshot |
 *
 * TASK-959 added the last two, and they are the first two that are NOT "an
 * inference call landed". `workflow.step` carries BOTH the inference a node
 * performed and — under `capability: WORKFLOW` — the `hope-harness-worker`
 * CPU that orchestrated it (§3.4); `storage.snapshot` carries no call at all,
 * only what a tenant was holding when the job ran (§5.2). They are operations
 * rather than a second event shape because the ledger's grain is
 * `(request, unit)` and nothing about either measure needs a different one.
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
  'workflow.step',
  'storage.snapshot',
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
 *     Note `azure` (NOT `azure-openai`, which is an TEXT *setting* value),
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
  'azure-foundry',
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
  // --- platform workers -----------------------------------------------------
  // `harness` is the durable-function server (`hope-harness-worker`), and it is
  // a provider in exactly the sense the other self-hosted ids are: it runs on
  // the platform's own hardware and its CPU is a real COGS unit. It is NOT an
  // inference engine and never appears on a token row — it is the `provider` of
  // the `WORKFLOW` / `CPU_SECOND` rows the metering interceptor emits per
  // activity (TASK-959 §3.4). Listed in its own group because a reader
  // scanning "self-hosted server connection ids" for an LLM endpoint must not
  // find it there: there is no `AiProviderConnection` row behind this id.
  'harness',
  // --- self-hosted engine ids ----------------------------------------------
  'whisper_cpp',
  'faster_whisper',
  // TASK-959: `parakeet_cpp` (stt/core/config/settings.py, control_plane.py) and
  // `indic_f5` (tts/core/config.py, control_plane.py) are reported by the
  // Python services and now carry GPU_SECOND COST rows, but were missing here.
  'parakeet_cpp',
  'kokoro',
  'indic_parler',
  'indic_f5',
  'silero',
  'gliner',
] as const;

export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/** True only for a provider in the canonical vocabulary. NOT a gate — see the header. */
export function isKnownProvider(value: unknown): value is KnownProvider {
  return typeof value === 'string' && (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The provider ids the platform runs on its OWN hardware.
 *
 * The SAME group `KNOWN_PROVIDERS` lists under "self-hosted server connection
 * ids", plus the `harness` worker (TASK-959) — named here so a caller that must
 * derive `AiDeploymentKind` reads the canonical membership rather than
 * restating it. A `harness` row that classified as CLOUD would bill a workflow
 * run's worker CPU against a vendor nobody called. (Two older restatements exist
 * — `consultation/summary/text-usage.ts` and `agent-trajectory/harness-usage.mapper.ts`
 * — and should converge here when either is next touched; they are not this
 * lane's files.)
 */
export const SELF_HOSTED_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama', 'lm-studio', 'vllm', 'llama-cpp', 'built-in', 'harness']);

/**
 * Derive the deployment kind of an LLM call from its provider and its FUNDING.
 *
 * Funding is DERIVED, never stamped (rule 09 §Tenant-first): a call served on a
 * tenant's own credential is `BYOK` whichever vendor answered it, and only when
 * nobody's credential was borrowed does the provider decide self-hosted vs
 * cloud. Getting this backwards mis-bills silently — a BYOK call charged as
 * CLOUD bills a tenant for tokens it already paid the vendor for.
 */
export function classifyLlmDeployment(provider: string, byok: boolean): 'BYOK' | 'SELF_HOSTED' | 'CLOUD' {
  if (byok) return 'BYOK';
  return SELF_HOSTED_PROVIDER_IDS.has(provider) ? 'SELF_HOSTED' : 'CLOUD';
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
