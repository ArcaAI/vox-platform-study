// Python service-runtime descriptors (the effective-config pull path).
//
// These are the SERVICE-LEVEL knobs the stt and nlp services consume through
// `GET /api/v1/internal/effective-config`. They are deliberately
// NOT per-request model selection: Text's stateless-gateway contract
// (`apps/text/src/text/core/config.py:1-9`) stays intact, and Text's own tunables
// arrive as `AiRuntimeProfile` rows rather than registry keys.
//
// Registering them changes ZERO runtime behaviour: every `default` below is
// transcribed verbatim from the consuming Python service's own fallback, so a
// read that misses the DB resolves to exactly the value in force today.
//
// Sources of truth for the defaults (verified 2026-07-20):
//   stt.modelCache.maxModels     `settings.model_cache_max_models`      = 5
//   stt.modelCache.ttlSeconds    `settings.model_cache_ttl_seconds`     = 3600  (clamp ge=60 le=3600)
//   stt.modelCache.maxMemoryMb   `models/cache.py` ctor fallback        = 10000
//   stt.workers.concurrency      `settings.worker_concurrency`          = 4
//   stt.streaming.maxConcurrent  `settings.streaming_max_concurrent`    = 0 (0 = hardware auto-detect)
//   nlp.inference.maxConcurrent  NEW — nlp had NO bound at all
//   nlp.peerCall.maxConcurrent   `settings.service.peer_call_max_concurrent` = 8 (TASK-729 §6,
//                                owner decision 2026-08-20 — a SEPARATE bound from
//                                nlp.inference.maxConcurrent for outbound calls to `text`)
//
// ⚠️ Deliberate divergence from the legacy seed: the orphaned GlobalSetting row
// `stt.config/model_cache/max_memory_mb` (`seed/06-stt.ts`) carries 16384, but the
// running code has always used the 10000 ctor fallback — that row never had a
// reader. Adopting 16384 here would SILENTLY raise the cache's memory
// ceiling by 64% on first deploy ("wiring a dead field flips real defaults").
// The code value wins; reconciling or retiring the legacy row belongs to the
// seed owner.

import { ConsumingDeployable, CONSUMING_DEPLOYABLES, SettingDescriptor } from '../registry.types';

/**
 * Registry keys → the consuming Python service's current fallback. Shared by the
 * descriptors below and the effective-config read service, so the two can never
 * drift apart.
 */
export const SERVICE_RUNTIME_DEFAULTS = {
  'stt.modelCache.maxModels': 5,
  'stt.modelCache.ttlSeconds': 600,
  'stt.modelCache.maxMemoryMb': 10000,
  'stt.modelCache.vramBudgetMb': 0,
  'stt.workers.concurrency': 4,
  'stt.streaming.maxConcurrent': 0,
  'nlp.inference.maxConcurrent': 4,
  'nlp.peerCall.maxConcurrent': 8,

  // ── nlp queue + batch geometry (TASK-799 lane D) ─────────────────────────
  // Nine `NLP_INFERENCE_*` env vars become one control-plane group. Platform-
  // scope service geometry with no tenant opinion — D-1's cardinality rule puts
  // exactly this class on the PULL route.
  //
  // Two lanes with DIFFERENT budgets, deliberately not one shared geometry: the
  // bulk lane serves the asynchronous per-utterance redaction pass, the
  // interactive lane a synchronous inline gate on a clinician's turn. The
  // interactive wait ceiling IS its declared SLO — past it the verdict arrives
  // too late to gate anything, so a 503 the caller fails closed on beats a
  // stale 200 that has already been acted on.
  //
  // `maxInflightBatches` is shared by both lanes because it bounds passes
  // against ONE weight slot; a per-lane bound would double what is in flight
  // against a single model the moment a second lane appeared.
  //
  // NOT here, deliberately: `NLP_INFERENCE_DEVICE` and
  // `NLP_INFERENCE_DEVICE_CPU_ONLY_MODULES`. Those are HOST facts (which
  // accelerator this pod has; which submodule the installed torch build
  // SIGABRTs on), and serving them centrally would push one host's hardware
  // onto every other.
  'nlp.inference.batchMaxSize': 8,
  'nlp.inference.batchLingerMs': 5,
  'nlp.inference.queueMaxDepth': 256,
  'nlp.inference.queueMaxWaitSeconds': 20,
  'nlp.inference.maxInflightBatches': 2,
  'nlp.interactiveInference.batchMaxSize': 2,
  'nlp.interactiveInference.batchLingerMs': 2,
  'nlp.interactiveInference.queueMaxDepth': 64,
  'nlp.interactiveInference.queueMaxWaitSeconds': 2,

  // ── nlp log sinks (TASK-799 lane D) ──────────────────────────────────────
  // Nine file/rotation knobs that were bare `os.getenv` reads scattered through
  // `nlp/core/logging.py`. `LOG_LEVEL` and `LOG_FILE_PATH` stay in env: the
  // level is what an operator reaches for FIRST during an incident (no
  // control-plane round trip), and the path is a host fact about where the
  // container's writable volume is mounted.
  //
  // `fileJsonFormat` and `consoleJsonFormat` differ ON PURPOSE — a file is
  // machine-read by a log backend, a console is human-read in `nlp:dev`. They
  // previously carried these same opposite defaults thirty lines apart with
  // nothing saying why, which read as a bug.
  'nlp.logging.fileEnabled': false,
  'nlp.logging.fileMaxSize': '10m',
  'nlp.logging.fileMaxFiles': 1000,
  'nlp.logging.fileSeparateError': false,
  'nlp.logging.consoleEnabled': true,
  'nlp.logging.fileJsonFormat': true,
  'nlp.logging.consoleJsonFormat': false,
  'nlp.logging.rotationWhen': 'midnight',
  'nlp.logging.rotationInterval': 1,
  'nlp.logging.rotationBackupCount': 30,
  'nlp.logging.useDailyRotation': true,

  // ── the remaining in-process caches ───────────────────────────
  // The `<svc>.modelCache.<knob>` grammar originally served stt only,
  // leaving guardrail/harness/tts as explicitly reserved subsets. This
  // fills them in the SAME family rather than adding a parallel
  // `models.retention.*` namespace: two key families for one knob would be
  // pure redundancy.
  //
  // `maxModels` values are transcribed verbatim from each service's own code
  // default, so residency is behaviour-preserving. `vramBudgetMb: 0` means
  // "unset" — no VRAM budget, the estimates path applies.
  'nlp.modelCache.ttlSeconds': 600,
  'nlp.modelCache.maxModels': 3,
  'nlp.modelCache.vramBudgetMb': 0,
  'guardrail.modelCache.ttlSeconds': 600,
  'guardrail.modelCache.maxModels': 2,
  'guardrail.modelCache.vramBudgetMb': 0,
  'harness.modelCache.ttlSeconds': 600,
  'harness.modelCache.maxModels': 1,
  'harness.modelCache.vramBudgetMb': 0,
  'tts.modelCache.ttlSeconds': 600,
  'tts.modelCache.maxModels': 2,
  'tts.modelCache.vramBudgetMb': 0,
  'text.modelCache.ttlSeconds': 600,

  // ── guardrail PHI redaction ──────────────────────────────────────────────
  // NOT a model-cache knob, so it sits outside the `<svc>.modelCache.*` family
  // and outside `MODEL_CACHE_SERVICES`. It bounds ONE GLiNER extraction call at
  // `POST /api/guardrail/redact`. Registered here rather than as a guardrail env
  // var precisely because it must be retunable without a redeploy: the safe
  // value depends on the redaction worker's real memory limit, which differs
  // per environment.
  'guardrail.redact.chunkChars': 4000,

  // ── guardrail output-side groundedness gate (TASK-799 lane D) ────────────
  // The last guardrail policy plane that lived in environment variables
  // (`GUARDRAIL_V2_GROUNDEDNESS_*`), so a platform admin could not switch the
  // clinical gate on, or retune its throughput, without a redeploy.
  //
  // These three are PLATFORM-scope service geometry with no tenant opinion,
  // which is exactly what D-1's cardinality rule puts on the PULL route. The
  // gate's VERDICT-DECIDING `entailmentThreshold` deliberately does NOT appear
  // here: it is model-coupled (it thresholds the scores of whichever NLI
  // checkpoint the `guardrail.groundedness` selection resolved), so it rides
  // `AiModel._metadata.policy` and is resolved by the same cascade that chose
  // the model. Splitting them keeps a threshold from ever outliving the
  // checkpoint it was calibrated against.
  //
  // `enabled` defaults FALSE — a safety gate is never switched on by silence.
  'guardrail.groundedness.enabled': false,
  'guardrail.groundedness.batchSize': 16,
  'guardrail.groundedness.maxSegments': 200,
} as const;

export type ServiceRuntimeKey = keyof typeof SERVICE_RUNTIME_DEFAULTS;

/**
 * The in-process caches this registry family governs. `text` is deliberately ABSENT: it
 * holds no weights — its `text.modelCache.ttlSeconds` is forwarded to
 * server-managed engines (Ollama `keep_alive`, LM Studio `ttl`), so it has no
 * `maxModels`/`vramBudgetMb` to speak of.
 */
export const MODEL_CACHE_SERVICES = ['stt', 'nlp', 'guardrail', 'harness', 'tts'] as const;

export type ModelCacheService = (typeof MODEL_CACHE_SERVICES)[number];

/** Human-facing service names for the generated retention descriptions. */
const SERVICE_LABEL: Record<ModelCacheService, string> = {
  stt: 'stt',
  nlp: 'nlp',
  guardrail: 'guardrail',
  harness: 'harness',
  tts: 'tts',
};

const TTL_DESCRIPTION = (service: string): string =>
  `Idle TTL before a cached ${service} model is evicted. The service re-applies its own product clamp ` +
  '(min 60s / max 3600s) to whatever is served here, so an out-of-range value cannot take effect. ' +
  'Models pinned by an in-flight request are never evicted, so the TTL applies only after the last release.';

const MAX_MODELS_DESCRIPTION = (service: string): string =>
  `Maximum number of models held resident in the ${service} LRU cache. Under all-pinned load the cache ` +
  'deliberately exceeds this ceiling rather than drop a model serving a request.';

const VRAM_DESCRIPTION = (service: string): string =>
  `Per-service VRAM budget in MB for ${service}. 0 = unset (no VRAM budget — the memory-estimate path ` +
  'applies). Only takes effect where an NVML probe is available; CPU-only hosts ignore it.';

type KeyMeta = { label: string; description: string };

/**
 * Retention metadata for the four services added here, generated so
 * the wording can never drift between them. stt's three pre-existing entries
 * keep their hand-written text below (they are equivalent in substance).
 */
const RETENTION_META: Partial<Record<ServiceRuntimeKey, KeyMeta>> = Object.fromEntries(
  MODEL_CACHE_SERVICES.flatMap((service) => {
    const label = SERVICE_LABEL[service];
    return [
      [`${service}.modelCache.ttlSeconds`, { label: `${label} model cache idle TTL (s)`, description: TTL_DESCRIPTION(label) }],
      [`${service}.modelCache.maxModels`, { label: `${label} model cache size`, description: MAX_MODELS_DESCRIPTION(label) }],
      [`${service}.modelCache.vramBudgetMb`, { label: `${label} VRAM budget (MB)`, description: VRAM_DESCRIPTION(label) }],
    ];
  }),
) as Partial<Record<ServiceRuntimeKey, KeyMeta>>;

const HAND_WRITTEN_META: Partial<Record<ServiceRuntimeKey, KeyMeta>> = {
  'stt.modelCache.maxModels': {
    label: 'STT model cache size',
    description: 'Maximum number of ASR models held in the stt LRU cache.',
  },
  'stt.modelCache.ttlSeconds': {
    label: 'STT model cache idle TTL (s)',
    description:
      'Idle TTL before a cached ASR model is evicted. The service re-applies its own product clamp ' +
      '(min 60s / max 3600s) to whatever is served here, so an out-of-range value cannot take effect. ' +
      'Active sessions pin models, so the TTL applies only after the last release.',
  },
  'stt.modelCache.maxMemoryMb': {
    label: 'STT model cache memory ceiling (MB)',
    description: 'Upper bound on resident memory for cached ASR models before eviction is forced.',
  },
  'stt.workers.concurrency': {
    label: 'STT worker concurrency',
    description: 'Number of concurrent Dramatiq worker threads processing batch transcription jobs.',
  },
  'stt.streaming.maxConcurrent': {
    label: 'STT streaming max concurrent sessions',
    description: 'Ceiling on concurrent streaming sessions. 0 = auto-detect from the hardware execution profile.',
  },
  'nlp.inference.maxConcurrent': {
    label: 'NLP inference concurrency',
    description:
      'Ceiling on concurrent NER/classification/diagnosis inferences. Previously the nlp service had ' +
      'no bound of any kind, so concurrent requests piled onto the model unbounded.',
  },
  'nlp.peerCall.maxConcurrent': {
    label: 'NLP peer-call concurrency (to text)',
    description:
      'Ceiling on concurrent outbound HTTP calls nlp makes to text for /classify/topic and ' +
      '/classify/intent (TASK-729). A SEPARATE bound from nlp.inference.maxConcurrent (owner decision ' +
      '2026-08-20): that ceiling protects local GPU/CPU inference slots, while this one protects ' +
      "nlp's own outbound connection/concurrency budget to a peer service — sharing one bound between " +
      'the two would let a slow peer round-trip starve local inference, or vice versa.',
  },
  // ── nlp queue + batch geometry ──────────────────────────────────────────
  'nlp.inference.batchMaxSize': {
    label: 'NLP bulk batch size',
    description:
      'How many items may ride one coalesced forward pass on the BULK lane (the asynchronous ' +
      'per-utterance redaction pass). An encoder pass over a batch costs far less than the same ' +
      'items one at a time, because the per-pass overhead is paid once.',
  },
  'nlp.inference.batchLingerMs': {
    label: 'NLP bulk batch linger (ms)',
    description:
      'How long an otherwise-idle bulk request waits for company before its batch is dispatched. ' +
      'This is the ENTIRE latency price of batching — keep it well under the p50 forward pass, or ' +
      'batching costs more than it saves.',
  },
  'nlp.inference.queueMaxDepth': {
    label: 'NLP bulk queue depth',
    description:
      'Bounded queue for the bulk lane; submissions past it are REJECTED with 503 rather than ' +
      'queued. Rejection is the point: an unbounded queue under overload converts a latency ' +
      'problem into an out-of-memory kill and takes the safety plane down with it.',
  },
  'nlp.inference.queueMaxWaitSeconds': {
    label: 'NLP bulk queue wait ceiling (s)',
    description: 'An item that has waited longer than this is rejected rather than served stale.',
  },
  'nlp.inference.maxInflightBatches': {
    label: 'NLP concurrent forward passes per model',
    description:
      'Forward passes allowed in flight against ONE weight slot, SHARED by both lanes. Small on ' +
      'purpose: torch already parallelises inside a pass, so stacking passes on the same weights ' +
      'buys cache contention rather than throughput. A per-lane bound would double what is in ' +
      'flight against a single model.',
  },
  'nlp.interactiveInference.batchMaxSize': {
    label: 'NLP interactive batch size',
    description:
      "Batch size for the INTERACTIVE lane — the synchronous inline gate on a clinician's turn. " +
      'Deliberately smaller than the bulk lane: the cost of a wider gate batch is paid by the ' +
      'request waiting for the verdict.',
  },
  'nlp.interactiveInference.batchLingerMs': {
    label: 'NLP interactive batch linger (ms)',
    description: 'Coalescing window for the interactive lane, measured against ITS latency budget.',
  },
  'nlp.interactiveInference.queueMaxDepth': {
    label: 'NLP interactive queue depth',
    description: 'Bounded queue for the interactive lane; past it, shed load with a 503.',
  },
  'nlp.interactiveInference.queueMaxWaitSeconds': {
    label: 'NLP interactive queue wait ceiling (s)',
    description:
      "The interactive lane's declared SLO. Past it the verdict would arrive too late to gate " +
      'anything, so a 503 the caller can fail closed on beats a stale 200 already acted upon.',
  },

  // ── nlp log sinks ───────────────────────────────────────────────────────
  'nlp.logging.fileEnabled': {
    label: 'NLP file logging enabled',
    description: 'Write logs to a rotating file sink in addition to the console.',
  },
  'nlp.logging.fileMaxSize': {
    label: 'NLP log file size cap',
    description: 'Size at which a log file rotates, e.g. `10m`, `500k`, `1g`.',
  },
  'nlp.logging.fileMaxFiles': {
    label: 'NLP log file count cap',
    description: 'Maximum rotated size-based log files retained.',
  },
  'nlp.logging.fileSeparateError': {
    label: 'NLP separate error log',
    description: 'Write ERROR and above to their own file alongside the combined log.',
  },
  'nlp.logging.consoleEnabled': {
    label: 'NLP console logging enabled',
    description: 'Emit logs on stdout. Off only for deployments that ship exclusively from files.',
  },
  'nlp.logging.fileJsonFormat': {
    label: 'NLP file logs as JSON',
    description:
      'Default ON — a file is machine-read by a log backend. Deliberately the OPPOSITE default ' +
      'from the console switch below; the two sinks have different readers.',
  },
  'nlp.logging.consoleJsonFormat': {
    label: 'NLP console logs as JSON',
    description:
      'Default OFF — a console is human-read during local development. See the file switch above ' + 'for why the two defaults differ on purpose.',
  },
  'nlp.logging.rotationWhen': {
    label: 'NLP log rotation trigger',
    description: 'Time-based rotation trigger, in Python `TimedRotatingFileHandler` terms.',
  },
  'nlp.logging.rotationInterval': {
    label: 'NLP log rotation interval',
    description: 'Number of `rotationWhen` units between rotations.',
  },
  'nlp.logging.rotationBackupCount': {
    label: 'NLP log retention (files)',
    description: "How many rotated log files to keep — the service's local log retention window.",
  },
  'nlp.logging.useDailyRotation': {
    label: 'NLP daily log rotation',
    description: 'Rotate on a schedule rather than purely on size.',
  },

  'guardrail.groundedness.enabled': {
    label: 'Groundedness gate enabled',
    description:
      'Master switch for the output-side NLI groundedness gate. OFF (the default) answers every ' +
      'segment honestly as `unverified` and resolves no model; ON is the clinical enforce posture. ' +
      'Fail-closed either way — a disabled gate, an unreachable apps/nlp, or a scoring error all ' +
      'degrade to `unverified`, and no path ever yields `grounded` without a model entailing the ' +
      'segment. The verdict THRESHOLD is not here: it rides the selected model row ' +
      '(`AiModel._metadata.policy.groundednessEntailmentThreshold`), because a threshold calibrated ' +
      'for one NLI checkpoint is meaningless against another.',
  },
  'guardrail.groundedness.batchSize': {
    label: 'Groundedness batch size (segments)',
    description: 'Summary segments per delegated scoring call to apps/nlp — the throughput lever for the gate.',
  },
  'guardrail.groundedness.maxSegments': {
    label: 'Groundedness max scored segments',
    description:
      'Hard per-request ceiling on scored segments. Segments beyond it are reported `unverified` ' +
      'rather than silently skipped, so a truncated check never reads as a passed one.',
  },
  'guardrail.redact.chunkChars': {
    label: 'PHI redaction chunk size (characters)',
    description:
      'Maximum characters handed to GLiNER in ONE PII-extraction call at `POST /api/guardrail/redact`. ' +
      'Longer inputs are split on whitespace boundaries and processed sequentially, so an identifier is ' +
      'never cut in half and peak memory is bounded by this value rather than by the document. GLiNER cost ' +
      'is super-linear in input length, so SMALLER chunks are faster, not slower: measured over a ' +
      '100,000-character corpus (CPU-only), 8,000 took 17.5s and 4,000 took 9.7s, with peak memory flat at ' +
      '~2.8GB either way and an identical entity count. 4,000 is the knee — below ~2,000 the per-call ' +
      'overhead wins the gain back and the model gets less context to work with. Raising it above 8,000 ' +
      'buys nothing and costs both latency and memory.',
  },
  'text.modelCache.ttlSeconds': {
    label: 'Text engine retention TTL (s)',
    description:
      'Idle retention forwarded to SERVER-managed LLM engines — Ollama `keep_alive` and LM Studio `ttl`. ' +
      'Text holds no weights itself, so this is a per-request hint to the engine rather than a cache bound. ' +
      'vLLM / llama.cpp-server load one model at launch and stay resident by design; this value does not apply ' +
      'to them. Clamped to [60s, 3600s] by the service.',
  },
};

/** Hand-written entries win; generated retention metadata fills the rest. */
const META: Record<ServiceRuntimeKey, KeyMeta> = {
  ...RETENTION_META,
  ...HAND_WRITTEN_META,
} as Record<ServiceRuntimeKey, KeyMeta>;

/**
 * The deployable that consumes a key, read off the key's own first segment.
 *
 * Every key in this family is `<service>.<group>.<knob>`, and that leading
 * segment IS the consuming service — so the mapping is derived, not maintained.
 * A key whose prefix is not a known deployable declares no consumer and simply
 * never reaches the pull route (there are none today; the check exists so a
 * typo fails silent-and-absent rather than mis-routing to another service).
 */
/**
 * The declared `dataType`, DERIVED from the default rather than asserted.
 *
 * This family was number-only until TASK-799 lane D added the groundedness
 * gate's boolean switch and nlp's log-sink strings. Getting it wrong is not
 * cosmetic: `EffectiveConfigService` validates every served value against this
 * field and degrades a mismatch to `null`, so a boolean declared as a number
 * would silently never reach the service that asked for it.
 */
function settingDataTypeOf(value: unknown): SettingDescriptor['dataType'] {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'number';
}

function consumerOf(key: ServiceRuntimeKey): readonly ConsumingDeployable[] {
  const prefix = key.split('.')[0];
  return (CONSUMING_DEPLOYABLES as readonly string[]).includes(prefix) ? [prefix as ConsumingDeployable] : [];
}

export const SERVICE_RUNTIME_SETTINGS: SettingDescriptor[] = (Object.keys(SERVICE_RUNTIME_DEFAULTS) as ServiceRuntimeKey[]).map<SettingDescriptor>(
  (key) => ({
    key,
    tier: 'global-kv',
    // What puts this key on `GET /internal/effective-config?service=<name>`.
    // It is the ONLY wiring step: the read service queries the registry on this
    // field, so there is no switch case, response-DTO field or defaults map to
    // edit alongside it.
    consumedBy: consumerOf(key),
    // DERIVED from the declared default, not asserted. This family was
    // number-only until the groundedness gate's boolean switch joined it, and a
    // hardcoded `'number'` would have mislabelled it — which is not cosmetic:
    // `EffectiveConfigService` validates the served value against this field and
    // degrades a mismatch to `null`, so a boolean declared as a number would
    // never reach the service at all.
    dataType: settingDataTypeOf(SERVICE_RUNTIME_DEFAULTS[key]),
    sensitivity: 'internal',
    // Platform-owned capacity/retention knobs — never tenant-set.
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // Capacity/retention TUNING — `EffectiveConfigService.resolveKey` already
    // degrades a control-plane miss to `env-fallback` so the Python client keeps
    // its bootstrap value. open-to-default keeps that contract exact; fail-closed
    // would make an unwritten row an effective-config endpoint failure.
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: META[key].label,
    description: META[key].description,
    default: SERVICE_RUNTIME_DEFAULTS[key],
  }),
);
