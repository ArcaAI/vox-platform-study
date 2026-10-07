// Python service-runtime descriptors (the effective-config pull path).
//
// These are the SERVICE-LEVEL knobs the stt and nlp services consume through
// `GET /api/v1/internal/effective-config`. They are deliberately
// NOT per-request model selection: Text's stateless-gateway contract
// (`apps/text/src/text/core/config.py:1-9`) stays intact, and Text's own tunables
// arrive as `AiProviderConnection` ceilings (TASK-862) rather than registry keys.
//
// Registering them changes ZERO runtime behaviour: every `default` below is
// transcribed verbatim from the consuming Python service's own fallback, so a
// read that misses the DB resolves to exactly the value in force today.
//
// Sources of truth for the defaults (verified 2026-07-20):
//   stt.modelCache.maxModels `settings.model_cache_max_models` = 5
//   stt.modelCache.ttlSeconds `settings.model_cache_ttl_seconds` = 3600 (clamp ge=60 le=3600)
//   stt.modelCache.maxMemoryMb `models/cache.py` ctor fallback = 10000
//   stt.workers.concurrency `settings.worker_concurrency` = 4
//   stt.streaming.maxConcurrent `settings.streaming_max_concurrent` = 0 (0 = hardware auto-detect)
//   nlp.inference.maxConcurrent NEW — nlp had NO bound at all
// nlp.peerCall.maxConcurrent `settings.service.peer_call_max_concurrent` = 8
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

import { ConsumingDeployable, CONSUMING_DEPLOYABLES, EDITABLE_BY_NONE, SettingDescriptor } from '../registry.types';

/**
 * Registry keys → the consuming Python service's current fallback. Shared by the
 * descriptors below and the effective-config read service, so the two can never
 * drift apart.
 */
export const SERVICE_RUNTIME_DEFAULTS = {
  'stt.modelCache.maxModels': 5,
  'stt.modelCache.ttlSeconds': 600,
  'stt.modelCache.maxMemoryMb': 10000,
  'stt.workers.concurrency': 4,
  'stt.streaming.maxConcurrent': 0,
  'nlp.inference.maxConcurrent': 4,
  'nlp.peerCall.maxConcurrent': 8,

  // ── nlp queue + batch geometry ─────────────────────────
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

  // ── nlp bounded inference + worker recycling (TASK-1047 D6, FC-8) ─────
  // Frozen defaults. `maxInputChars` covers guardrail's `screenWindowChars` (2,000 since the OD-6
  // re-decision; 4,000 allowed) + `screenWindowOverlapChars` (256) with headroom; guardrail refuses a policy
  // whose window + overlap exceeds it. `threadsPerInference` 0 = derive
  // `cpu_count // maxConcurrent` (min 1) in the service.
  'nlp.inference.maxInputChars': 8192,
  'nlp.inference.maxInputWords': 2048,
  'nlp.inference.threadsPerInference': 0,
  'nlp.worker.recycleAfterRequests': 2000,
  // TASK-1047 live validation: the warm working set (all screening models loaded) peaks at 5.4–5.7 GiB,
  // so the recycle ceiling sits ~2x above it — a leak backstop, never a per-request event.
  'nlp.worker.recycleRssMib': 12288,
  // TASK-1047 F1 — per-batch character budget: a micro-batch closes before its summed text length
  // would exceed it, so transient memory is bounded by the budget, not by the batch COUNT.
  'nlp.inference.maxBatchChars': 8192,
  // TASK-1047 FC-8a (OD-10) — `/classify/tokens` windows text above `maxInputChars` server-side
  // (NER callers send whole transcripts and notes); `windowChars + windowOverlapChars` must stay
  // at or below `maxInputChars`, otherwise the service warns and uses these defaults.
  'nlp.ner.maxRequestChars': 200000,
  'nlp.ner.windowChars': 2000,
  'nlp.ner.windowOverlapChars': 256,
  // TASK-1049 F10 — the tenant-keyed NER result cache (`nlp/services/ner_result_cache.py`); `0` disables it.
  'nlp.ner.resultCacheTtlSeconds': 600,
  'nlp.ner.resultCacheMaxEntries': 1024,

  // ── the remaining in-process caches ───────────────────────────
  // The `<svc>.modelCache.<knob>` grammar originally served stt only,
  // leaving guardrail/harness/tts as explicitly reserved subsets. This
  // fills them in the SAME family rather than adding a parallel
  // `models.retention.*` namespace: two key families for one knob would be
  // pure redundancy.
  //
  // `maxModels` values are transcribed verbatim from each service's own code
  // default, so residency is behaviour-preserving.
  //
  // TASK-872 removed the knobs no service ever READ, and what is left is
  // exactly what each service consumes: `vramBudgetMb` (all five) was parsed by
  // nobody; `tts.modelCache.maxModels` was declared against a client whose own
  // `retention()` documents that "maxModels is meaningless here"; and the three
  // `guardrail.modelCache.*` keys fed a `retention()` accessor with zero
  // callers. A knob an operator can set that reaches no reader is worse than an
  // absent one — it reports success and changes nothing.
  'nlp.modelCache.ttlSeconds': 600,
  'nlp.modelCache.maxModels': 3,
  'harness.modelCache.ttlSeconds': 600,
  'harness.modelCache.maxModels': 1,
  'tts.modelCache.ttlSeconds': 600,
  'text.modelCache.ttlSeconds': 600,

  // ── guardrail PHI redaction ──────────────────────────────────────────────
  // NOT a model-cache knob, so it sits outside the `<svc>.modelCache.*` family
  // and outside `MODEL_CACHE_SERVICES`. It bounds ONE GLiNER extraction call at
  // `POST /api/guardrail/redact`. Registered here rather than as a guardrail env
  // var precisely because it must be retunable without a redeploy: the safe
  // value depends on the redaction worker's real memory limit, which differs
  // per environment.
  'guardrail.redact.chunkChars': 4000,

  // ── guardrail output-side groundedness gate ────────────
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
 * The services with an in-process cache this registry family still governs —
 * i.e. the ones that get a `retention` group on the pull route.
 *
 * `text` is deliberately ABSENT: it holds no weights, and its
 * `text.modelCache.ttlSeconds` is forwarded to server-managed engines (Ollama
 * `keep_alive`, LM Studio `ttl`) rather than bounding a cache of its own.
 *
 * `guardrail` LEFT this list in TASK-872, when its three `modelCache.*` keys
 * were removed for having no reader — see {@link MODEL_WEIGHT_SERVICES} for why
 * that is not the same as leaving the weights plane.
 */
export const MODEL_CACHE_SERVICES = ['stt', 'nlp', 'harness', 'tts'] as const;

export type ModelCacheService = (typeof MODEL_CACHE_SERVICES)[number];

/**
 * The services that hold model WEIGHTS in their own process, and therefore
 * receive the `modelWeights` block on the pull route (slug → source/localPath/
 * checksum for the models their task keys select).
 *
 * SPLIT from {@link MODEL_CACHE_SERVICES} by TASK-872. One constant was doing
 * two jobs — driving the retention-descriptor generator AND gating
 * `EffectiveConfigService.resolveModelWeights` — and the two only ever agreed
 * by coincidence. They answer different questions: "does this service expose
 * cache-retention knobs" and "does this service need to be told where its
 * weights live". Removing guardrail's dead cache knobs would otherwise have
 * silently stopped serving guardrail its weights block, which is a real
 * behaviour change hiding inside a cleanup.
 */
export const MODEL_WEIGHT_SERVICES = ['stt', 'nlp', 'guardrail', 'harness', 'tts'] as const;

export type ModelWeightService = (typeof MODEL_WEIGHT_SERVICES)[number];

/** Human-facing service names for the generated retention descriptions. */
const SERVICE_LABEL: Record<ModelCacheService, string> = {
  stt: 'stt',
  nlp: 'nlp',
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

type KeyMeta = { label: string; description: string };

/**
 * Retention metadata, generated so the wording can never drift between
 * services. stt's pre-existing entries keep their hand-written text below (they
 * are equivalent in substance).
 *
 * Filtered against `SERVICE_RUNTIME_DEFAULTS` rather than emitted blindly per
 * service: the knob set is no longer uniform (tts declares a TTL and no
 * `maxModels`, because its own client documents `maxModels` as meaningless
 * there), and generating metadata for a key that does not exist would leave a
 * label describing a control nobody can reach.
 */
const RETENTION_META: Partial<Record<ServiceRuntimeKey, KeyMeta>> = Object.fromEntries(
  MODEL_CACHE_SERVICES.flatMap((service) => {
    const label = SERVICE_LABEL[service];
    return (
      [
        [`${service}.modelCache.ttlSeconds`, { label: `${label} model cache idle TTL (s)`, description: TTL_DESCRIPTION(label) }],
        [`${service}.modelCache.maxModels`, { label: `${label} model cache size`, description: MAX_MODELS_DESCRIPTION(label) }],
      ] as const
    ).filter(([key]) => key in SERVICE_RUNTIME_DEFAULTS);
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
      '/classify/intent. A SEPARATE bound from nlp.inference.maxConcurrent (owner decision ' +
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

  'nlp.inference.maxInputChars': {
    label: 'NLP max input length (characters)',
    description:
      'Hard input bound on every guard and text-classification route: text longer than this is refused with ' +
      '413 `INPUT_EXCEEDS_WINDOW` (callers window the text; nothing is silently truncated). `/classify/tokens` ' +
      'instead windows such text server-side up to `nlp.ner.maxRequestChars`. Guardrail’s ' +
      '`screenWindowChars + screenWindowOverlapChars` must stay at or below it. Bounds peak memory per request.',
  },
  'nlp.inference.maxBatchChars': {
    label: 'NLP micro-batch character budget',
    description:
      'A micro-batch of guard inferences closes before the summed length of its texts would exceed this budget (an ' +
      'item longer than the budget runs alone). Transient memory then scales with the budget, not with the batch ' +
      'count — 8 padded 4,000-char windows in one pass drove NLP to 7 GiB in the TASK-1047 validation.',
  },
  'nlp.ner.maxRequestChars': {
    label: 'NLP NER max request length (characters)',
    description:
      'Hard input bound on `/classify/tokens`: text longer than this is refused with 413 `INPUT_EXCEEDS_WINDOW`. ' +
      'Text above `nlp.inference.maxInputChars` but within this bound is split into windows server-side and run ' +
      'one window at a time, so memory stays bounded by the window, not by the request.',
  },
  'nlp.ner.windowChars': {
    label: 'NLP NER window length (characters)',
    description:
      'Nominal window length when `/classify/tokens` splits a text longer than `nlp.inference.maxInputChars`. ' +
      'Cuts prefer whitespace in the last 10% of the window. `windowChars + windowOverlapChars` must stay at or ' +
      'below `nlp.inference.maxInputChars`; a pair that does not is ignored (the defaults apply, with a warning).',
  },
  'nlp.ner.resultCacheTtlSeconds': {
    label: 'NLP NER result cache TTL (s)',
    description:
      'Lifetime of a cached `/classify/tokens` result in the tenant-keyed NER result cache (the key includes the tenant, ' +
      'the model and the text hash, so one tenant never reads another`s spans). 0 disables the cache.',
  },
  'nlp.ner.resultCacheMaxEntries': {
    label: 'NLP NER result cache size (entries)',
    description: 'Most results the NER result cache holds per nlp process before evicting the least recently used. 0 disables the cache.',
  },
  'nlp.ner.windowOverlapChars': {
    label: 'NLP NER window overlap (characters)',
    description:
      'Characters each NER window re-reads before the previous cut, so an entity straddling a cut is seen whole ' +
      'by one window. Duplicate spans from the overlap are merged (identical spans keep the best score; ' +
      'overlapping spans of one label keep the longer).',
  },
  'nlp.inference.maxInputWords': {
    label: 'NLP max input length (words, gliner2 max_len)',
    description:
      'Second fence on the same routes: the `max_len` (in words) handed to gliner2, so the model never ' +
      'attends over more than this even if the character bound is raised.',
  },
  'nlp.inference.threadsPerInference': {
    label: 'NLP torch threads per inference',
    description:
      'CPU threads one inference may use. 0 = derive `cpu_count // nlp.inference.maxConcurrent` (minimum 1), ' +
      'so concurrent inferences share the cores instead of oversubscribing them.',
  },
  'nlp.worker.recycleAfterRequests': {
    label: 'NLP worker recycle after N requests',
    description:
      'The NLP worker exits gracefully after serving this many requests and is restarted by the supervisor / ' +
      'uvicorn, so allocator retention cannot ratchet resident memory without bound. 0 disables the request-count recycle.',
  },
  'nlp.worker.recycleRssMib': {
    label: 'NLP worker recycle RSS ceiling (MiB)',
    description:
      'After a response, a worker whose resident set exceeds this exits gracefully and is restarted by the ' +
      'supervisor / uvicorn. Size it under the pod memory limit with headroom. 0 disables the RSS recycle.',
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
 * This family was number-only until lane D added the groundedness
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

/**
 * The harness worker's claim-check offload switch — moved here from
 * `feature-flags.descriptors.ts`, which TASK-932 dissolved.
 *
 * It is NOT a feature (nothing about the product is available or unavailable
 * because of it): it decides whether large clinical blobs are written to a
 * content-addressed store instead of into Temporal workflow history, protecting
 * the ~50 MB history budget. That is service runtime, so it is categorised as
 * such and it stays `tier: 'env'` — the reader is `pydantic-settings` inside the
 * Python harness worker, and moving it would need the effective-config pull
 * route plus a worker restart contract (D-4 keeps that out of this ticket).
 * `targetTier` records the intended destination so the pending migration stays
 * queryable rather than becoming folklore.
 *
 * DEFAULTS **ON**, and is therefore NOT marked `killSwitch` — it is a
 * PROTECTION, so turning it off REMOVES a safeguard (unbounded history growth)
 * rather than disabling an enforcement path. Marking it a kill-switch would
 * violate the defaults-OFF invariant and fail registry assembly. Same polarity
 * as `rateLimit.enabled` (`platform-ops.descriptors.ts`).
 */
export const HARNESS_CLAIM_CHECK_ENABLED: SettingDescriptor = {
  key: 'harness.claimCheck.enabled',
  tier: 'env',
  targetTier: 'global-kv',
  dataType: 'boolean',
  sensitivity: 'internal',
  // An env var has no cascade; the governance suite binds `env` ⇒ `system`.
  maxScope: 'system',
  editableBy: EDITABLE_BY_NONE,
  failMode: 'open-to-default',
  category: 'Service Runtime',
  label: 'Harness claim-check offload',
  description:
    'Moves large clinical blobs OUT of Temporal workflow history into a self-hosted content-addressed store, protecting the ~50 MB history budget. ' +
    'DEFAULTS ON, and is therefore NOT marked `killSwitch` — it is a PROTECTION, so turning it off REMOVES a safeguard (unbounded history growth) rather than disabling an enforcement path. ' +
    'Turning it off is a deliberate acceptance of unbounded Temporal history, exactly as the harness startup validator states.',
  default: true,
};

/**
 * The model-publisher worker's download staging — its path and its budget.
 *
 * Both stay `tier: 'env'`: one is a path on the worker's own filesystem, the
 * other the size of the volume behind it (on the cluster the staging emptyDir's
 * `sizeLimit`, set by the publisher Deployment) — topology, fixed for the
 * process lifetime, with no admin write path. But neither is needed to REACH
 * the database or to AUTHENTICATE to Vault, so they are NOT the bootstrap floor
 * (TASK-1027: declared there by TASK-1019, they pushed the floor past its
 * 60-line target). They sit with the other single-worker runtime key above and,
 * like it, are spread into the gateway's boot-time env schema: one shared env
 * file means one shared contract.
 */
export const MODEL_PUBLISHER_STAGING_SETTINGS: SettingDescriptor[] = [
  {
    key: 'modelPublisher.stagingDir',
    tier: 'env',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: EDITABLE_BY_NONE,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'Model publisher staging directory',
    description:
      "Filesystem path under which the model-publisher worker stages each download (streamed to disk, hashed, then multipart-uploaded to `hope-models`). A path on the worker's own filesystem — on the cluster a size-limited emptyDir. Unset falls back to the OS temp dir (`os.tmpdir()`).",
  },
  {
    key: 'modelPublisher.stagingMaxBytes',
    tier: 'env',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: EDITABLE_BY_NONE,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'Model publisher staging budget (bytes)',
    description:
      'The size, in whole bytes, of the model-publisher worker’s staging volume — on the cluster the staging emptyDir’s `sizeLimit`, set by the publisher Deployment (a topology value). ' +
      'The download pre-flight refuses (`STAGING_SPACE_INSUFFICIENT`) a publish that exceeds min(filesystem free space, this budget − bytes already under `MODEL_PUBLISHER_STAGING_DIR`): `statfs` reports the NODE’s disk, not the emptyDir’s limit, so without it a publish that fits the node but not the pod gets the pod evicted mid-download. ' +
      'Unset = no budget (the filesystem free space alone, right for local dev). A value that is not a positive whole number fails the worker at start. Read ONLY by the model-publisher worker.',
  },
];
