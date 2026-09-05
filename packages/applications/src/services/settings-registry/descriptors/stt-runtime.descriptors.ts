// stt tuning knobs — the ~68 keys that used to be environment variables.
//
// lane C. `service-runtime.descriptors.ts` already carries stt's four
// CAPACITY knobs (`stt.modelCache.*`, `stt.workers.concurrency`,
// `stt.streaming.maxConcurrent`); this file carries everything else the service
// tunes at runtime — VAD, streaming geometry and timeouts, transcription
// chunking, punctuation, semantic endpointing, worker/threading, and the
// non-secret halves of the cloud engine connections.
//
// WHY THEY ARE HERE AND NOT IN `service-runtime.descriptors.ts`
// -------------------------------------------------------------
// That file's family is deliberately uniform: every key is a number, every key
// is `<service>.modelCache.*`-shaped capacity, and its descriptors are GENERATED
// from one defaults map with one metadata generator. These are not — they span
// booleans, strings, enums and floats, several are kill-switches, and each needs
// its own description. Folding them in would have forced that generator to grow
// a per-key exception table, which is the shape the registry exists to avoid.
// The two files share the tier, the scope and the `consumedBy` mechanism; they
// differ only in how their metadata is authored.
//
// EVERY `default` BELOW IS TRANSCRIBED VERBATIM FROM THE PYTHON FIELD
// -------------------------------------------------------------------
// Emitted from `Settings.model_fields[...].default` rather than retyped, and
// asserted against the Python side by `stt-runtime.descriptors.test.ts` +
// `apps/stt/tests/unit/test_task799_control_plane.py`. That is what makes this
// change BEHAVIOUR-NEUTRAL on an empty `GlobalSetting` table: with no row,
// `EffectiveSettingsService` resolves the descriptor default and labels it
// `source: 'env-fallback'`, so the service runs on exactly the values it ran on
// before. No seeding is required for this to land safely.
//
// THE `''` CONVENTION FOR NULLABLE STRINGS
// -----------------------------------------
// Five keys back a Python `str | None` field (`stt.azureSpeech.region`,
// `stt.azureFoundry.endpoint`, `stt.parakeetCpp.libraryPath`,
// `stt.vad.modelPath`, `stt.punctuation.modelCacheDir`). A `string` descriptor
// has no null literal, so their default is `''` and the consuming client reads
// an empty string as "no opinion — keep `None`". Adopting `''` as a real value
// would replace "unset, resolve it yourself" with an empty path.
//
// WHAT IS DELIBERATELY *NOT* HERE
// --------------------------------
//  • Credentials. Azure Speech, Azure Foundry, Sarvam and OpenAI ASR are all
//    BYOK: the key is resolved per request from `AiProviderConnection` and has
//    no settings field at all. Only the non-secret region/endpoint/base-URL is
//    below, and `sensitivity` stays `internal` throughout — the read service
//    filters `secret` off this route unconditionally.
//  • Anything that can vary BY TENANT. Owner decision D-1: the pull route is
//    PLATFORM scope, one cached snapshot per process forever, so every key here
//    is `maxScope: 'system'` + `globalOnly`. A tenant-varying value travels the
//    PUSH channel (per-request gateway injection) instead.
//  • `STORAGE_PROVIDER` and the `AZURE_STORAGE_*` companions. Their home is the
//    `storage.platformDefault.*` cascade (`tier: 'db-config'`, backed by the
// SYSTEM `TenantStorageConfig` row), and as of A.1 that tier IS
//    resolvable on the pull route — `storage.platformDefault.provider` now
//    declares `consumedBy: ['stt']` and `stt`'s `storage_provider` env path is
//    closed. Duplicating it as an `stt.storage.provider` key here would be the
//    second-home failure D-2 forbids, so it stays where it is.
//    (Historical note, because it explains the shape of this file: until that
//    lane existed, declaring `consumedBy` on a `db-config` key compiled,
//    deployed and served `null` forever — `resolveKey` catches the "no resolver"
//    throw and degrades to `env-fallback`. That is assessment RC-5, now closed.)

import { SettingDescriptor } from '../registry.types';

/**
 * Registry key → the consuming Python field's CURRENT default, and the metadata
 * that makes the key legible to an admin.
 *
 * `killSwitch` marks the enforcing gates. The registry refuses to assemble a
 * kill-switch that defaults ON, which is exactly why `stt.pubsub.enabled` is
 * NOT marked as one — see its entry.
 */
type SttKnob = {
  dataType: 'boolean' | 'number' | 'string';
  default: boolean | number | string;
  label: string;
  description: string;
  category: string;
  killSwitch?: boolean;
};

const KNOBS: Record<string, SttKnob> = {
  // ── cloud engine connections (non-secret halves) ─────────────────────────
  'stt.azureSpeech.region': {
    dataType: 'string',
    default: '',
    label: 'Azure Speech region',
    description:
      'Azure Speech service region (e.g. eastus, westeurope) for the platform default connection. ' +
      'Empty = unset. The subscription KEY is never here: Azure Speech is BYOK and its credential ' +
      'is resolved per request from AiProviderConnection.',
    category: 'STT Engines',
  },
  'stt.azureFoundry.enabled': {
    dataType: 'boolean',
    default: false,
    label: 'Azure AI Foundry engine enabled',
    description:
      'Enables the Azure AI Foundry MAI-Transcribe engine. PREVIEW: no SLA, no diarization, ' +
      'batch-only. PHI must not flow through it until GA and data-residency sign-off, which is why ' +
      'it defaults OFF and is a kill-switch rather than a plain flag.',
    category: 'STT Engines',
    killSwitch: true,
  },
  'stt.azureFoundry.endpoint': {
    dataType: 'string',
    default: '',
    label: 'Azure AI Foundry endpoint',
    description: 'Azure AI Foundry / Speech resource endpoint, e.g. https://<res>.cognitiveservices.azure.com. ' + 'Empty = unset.',
    category: 'STT Engines',
  },
  'stt.sarvam.baseUrl': {
    dataType: 'string',
    default: 'https://api.sarvam.ai',
    label: 'Sarvam API base URL',
    description:
      'Base URL for the Sarvam speech-to-text API. Point this at an enterprise VPC / on-prem host ' +
      'before real patient data flows: the public API carries no BAA.',
    category: 'STT Engines',
  },
  'stt.openai.baseUrl': {
    dataType: 'string',
    default: 'https://api.openai.com/v1',
    label: 'OpenAI ASR base URL',
    description: 'Base URL for the OpenAI (or Azure-OpenAI-compatible) speech-to-text API. The key is BYOK and ' + 'arrives per request.',
    category: 'STT Engines',
  },

  // ── local ggml runtimes ──────────────────────────────────────────────────
  'stt.parakeetCpp.libraryPath': {
    dataType: 'string',
    default: '',
    label: 'parakeet.cpp library path',
    description:
      'Filesystem path to libparakeet. Empty = the loader lazy-imports a Python binding module if ' +
      'one is present. No official upstream bindings exist, so this is how a deployment points at ' +
      'its own build.',
    category: 'STT Engines',
  },
  'stt.parakeetCpp.numThreads': {
    dataType: 'number',
    default: 4,
    label: 'parakeet.cpp CPU threads',
    description: 'CPU threads used for parakeet.cpp inference.',
    category: 'STT Engines',
  },
  'stt.whisperCpp.numThreads': {
    dataType: 'number',
    default: 8,
    label: 'whisper.cpp CPU threads',
    description: 'CPU threads used for whisper.cpp inference.',
    category: 'STT Engines',
  },
  // TASK-880 removed `stt.whisperCpp.maxAudioSeconds` and
  // `stt.whisperCpp.consultationPromptEnabled`.
  //
  // The first is the MODEL's decode window, not the box's: it applied one number to every
  // whisper.cpp row, including rows with a 30s context that never needed splitting. It is
  // `AiModel._metadata.asr.maxDecodeWindowSec`, so a fallback chain decodes on its own
  // window. The second gated two HARDCODED consultation lines the adapter prepended — but
  // WHAT prior context a decode gets is the agent's `instruction.initialPrompt`, which
  // already reached the adapter by another route, so the flag could only ever add a second
  // platform-authored prompt in front of the agent's own.

  // ── VAD (Silero v5) ──────────────────────────────────────────────────────
  // NOTHING is left here. `stt.vad.threshold`, `stt.vad.minSpeechDurationMs` and
  // `stt.vad.minSilenceDurationMs` went in TASK-872 (shadowed by the spec's own VAD
  // parameters), and TASK-880 took the last two:
  //
  //  • `stt.vad.modelPath` named the ONNX weights. The weights are an `AiModel`
  //    (`VOICE_ACTIVITY_DETECTION`) row whose `localPath` ALREADY travels on every
  //    session as `ResolvedAsrSpec.models.vad.localPath` — the platform key was a
  //    second way to say the same thing, and the only one the loader read.
  //  • `stt.vad.speechPadMs` is segment padding: a tuning choice beside the three
  //    knobs above it, all of which the agent has owned since TASK-861. It is
  //    `audioFrontEnd.vad.speechPadMs` now.

  // ── diarization / voice profiles ─────────────────────────────────────────
  'stt.diarization.hfModelId': {
    dataType: 'string',
    default: 'pyannote/wespeaker-voxceleb-resnet34-LM',
    label: 'Speaker-embedding model',
    description:
      'HuggingFace model id for speaker-embedding extraction. Changing it changes the embedding ' +
      'SPACE, so enrolled voice profiles do not transfer — a swap is a re-enrolment exercise, and ' +
      'a model whose output dimension differs from the deployed UserVoiceProfile.embedding column ' +
      'will fail every enrollment.',
    category: 'STT Audio',
  },
  'stt.diarization.device': {
    dataType: 'string',
    default: 'auto',
    label: 'Diarization device',
    description: 'Device for pyannote inference: auto | cuda | cpu.',
    category: 'STT Audio',
  },
  'stt.voiceProfile.minSimilarity': {
    dataType: 'number',
    default: 0.6,
    label: 'Voice-profile enrollment similarity floor',
    description:
      'Minimum pairwise cosine similarity between a speaker’s enrollment samples; below it the ' +
      'enrollment is rejected as inconsistent. Keep >= 0.6 in production; ~0.3 is workable for dev ' +
      'with consumer microphones.',
    category: 'STT Audio',
  },

  // ── worker + runtime threading ───────────────────────────────────────────
  'stt.workers.pollTimeoutMs': {
    dataType: 'number',
    default: 1000,
    label: 'Worker poll max-backoff (ms)',
    description: 'Dramatiq consumer poll interval max-backoff.',
    category: 'STT Runtime',
  },
  'stt.workers.maxRetries': {
    dataType: 'number',
    default: 3,
    label: 'Worker max retries',
    description: 'Maximum retry attempts for a batch transcription job.',
    category: 'STT Runtime',
  },
  'stt.runtime.onnxNumThreads': {
    dataType: 'number',
    default: 0,
    label: 'ONNX Runtime intra-op threads',
    description:
      'Threads for ONNX Runtime intra-op parallelism. 0 = auto (recommended): the runtime sizes to ' +
      'physical core count with proper thread affinity. Set explicitly only when profiling shows a gain.',
    category: 'STT Runtime',
  },
  'stt.runtime.torchNumThreads': {
    dataType: 'number',
    default: 0,
    label: 'PyTorch intra-op threads',
    description:
      'Threads for PyTorch intra-op parallelism. 0 = auto (physical core count). In Kubernetes set ' +
      'this to match the CPU request/limit, or the process will over-subscribe the cores it was given.',
    category: 'STT Runtime',
  },
  'stt.runtime.torchNumInteropThreads': {
    dataType: 'number',
    default: 1,
    label: 'PyTorch inter-op threads',
    description:
      'Threads for PyTorch inter-op parallelism. 1 is optimal for single-request inference; raise it ' + 'only for concurrent batch processing.',
    category: 'STT Runtime',
  },
  'stt.gateway.timeoutSeconds': {
    dataType: 'number',
    default: 30,
    label: 'Gateway call timeout (s)',
    description:
      'Timeout for outbound calls to the API gateway. The gateway URL and key stay in env — they ' +
      'are bootstrap TRANSPORT, the means by which this process reaches the config source, so they ' +
      'cannot themselves come from it.',
    category: 'STT Runtime',
  },

  // ── batch transcription geometry ─────────────────────────────────────────
  'stt.transcription.timeoutSeconds': {
    dataType: 'number',
    default: 600,
    label: 'Transcription job timeout (s)',
    description: 'Maximum wall-clock time for one batch transcription job.',
    category: 'STT Transcription',
  },
  'stt.transcription.chunkLengthS': {
    dataType: 'number',
    default: 15,
    label: 'Whisper chunk length (s)',
    description:
      "Audio chunk length for Whisper inference. Whisper's feature extractor truncates to a 30s " +
      'context window, so longer audio is split into overlapping chunks. 15s gives roughly half the ' +
      'time-to-first-word of 30s at comparable accuracy; use 30 for maximum accuracy, 10 for ' +
      'ultra-low latency.',
    category: 'STT Transcription',
  },
  'stt.transcription.strideLengthS': {
    dataType: 'string',
    default: '4,2',
    label: 'Whisper chunk overlap (s, "left,right")',
    description:
      'Left and right overlap between consecutive chunks, as a comma-separated pair. The pipeline ' +
      'uses these to avoid cutting words at a chunk boundary.',
    category: 'STT Transcription',
  },
  'stt.segmentMerge.gapThresholdS': {
    dataType: 'number',
    default: 2.0,
    label: 'VAD segment merge gap (s)',
    description:
      'Largest gap between adjacent VAD speech segments that still merges them into one inference ' +
      'chunk. Merging cuts the number of Whisper generate() calls, each of which carries ~6s of ' +
      'encoder overhead on CPU. 0 disables merging.',
    category: 'STT Transcription',
  },

  // ── streaming ────────────────────────────────────────────────────────────
  'stt.streaming.maxBatchSize': {
    dataType: 'number',
    default: 0,
    label: 'Streaming batch size',
    description: 'Maximum batch size for the dynamic batch scheduler (GPU inference). 0 = auto-detect from the ' + 'hardware execution profile.',
    category: 'STT Streaming',
  },
  // `stt.streaming.batchWaitMs` was here (TASK-872): the batch scheduler takes
  // its wait from the hardware execution profile, and no code read the knob.
  // `stt.streaming.embeddingDevice` and `stt.streaming.multiGpuStrategy` were
  // here (TASK-872). Device placement is decided by the hardware execution
  // profile and, for the embedding model, by the `ResolvedAsrSpec`; neither
  // string reached a reader.
  'stt.streaming.sessionPersistIntervalS': {
    dataType: 'number',
    default: 5.0,
    label: 'Session metadata persist interval (s)',
    description: 'How often streaming session metadata is written to Redis.',
    category: 'STT Streaming',
  },
  'stt.streaming.snapshotIntervalS': {
    dataType: 'number',
    default: 30.0,
    label: 'Audio snapshot interval (s)',
    description: 'Interval between audio snapshot uploads to object storage during an active session.',
    category: 'STT Streaming',
  },
  'stt.streaming.maxAudioBufferBytes': {
    dataType: 'number',
    default: 500000000,
    label: 'Per-session audio buffer cap (bytes)',
    description:
      'Hard cap on the in-memory audio buffer per session; past it new frames are dropped with a ' +
      'warning. ~500MB is about 87 minutes of 16kHz mono s16le audio.',
    category: 'STT Streaming',
  },
  'stt.streaming.sessionTimeoutS': {
    dataType: 'number',
    default: 60,
    label: 'Session inactivity timeout (s)',
    description: 'Inactivity before the reaper auto-finalizes a streaming session.',
    category: 'STT Streaming',
  },
  'stt.streaming.audioIdleTimeoutS': {
    dataType: 'number',
    default: 300,
    label: 'Audio idle timeout (s)',
    description: 'Time with no audio data before the service auto-stops a streaming session.',
    category: 'STT Streaming',
  },
  'stt.streaming.reaperIntervalS': {
    dataType: 'number',
    default: 300,
    label: 'Reaper scan interval (s)',
    description: 'Interval between background reaper scans for expired sessions.',
    category: 'STT Streaming',
  },
  'stt.streaming.transcriptPersistMaxAttempts': {
    dataType: 'number',
    default: 3,
    label: 'Transcript persist attempts',
    description:
      'Attempts to persist the durable streaming transcript to the gateway during finalize. The ' +
      'transcript is the clinical system of record AND the harness auto-draft trigger, so a ' +
      'transient blip is retried rather than swallowed; the endpoint is idempotent, so a retry never ' +
      'double-creates it. Must be >= 1.',
    category: 'STT Streaming',
  },
  'stt.streaming.transcriptPersistBackoffS': {
    dataType: 'number',
    default: 0.5,
    label: 'Transcript persist backoff (s)',
    description: 'Base backoff between durable-transcript persist retries; the delay scales with attempt number. ' + '0 disables the wait.',
    category: 'STT Streaming',
  },
  'stt.streaming.transcriptOutboxMaxAttempts': {
    dataType: 'number',
    default: 10,
    label: 'Transcript outbox re-drive attempts',
    description:
      'Re-drive attempts for a transcript in the durable Redis outbox before it is dropped with a ' +
      'loud alert. A PERMANENT (4xx) error is dropped immediately instead of consuming attempts.',
    category: 'STT Streaming',
  },
  'stt.streaming.inferenceDrainTimeoutS': {
    dataType: 'number',
    default: 60.0,
    label: 'Finalize drain timeout (s)',
    description:
      'How long finalize waits for the inference queue to drain before building the transcript. On ' +
      'timeout the still-queued tail utterances are transcribed inline rather than dropped, so the ' +
      'last utterance is never lost.',
    category: 'STT Streaming',
  },
  'stt.streaming.inferenceQueueMaxsize': {
    dataType: 'number',
    default: 64,
    label: 'Per-session inference queue bound',
    description:
      'Bound on the per-session in-process inference queue. Once full past the bounded wait the ' +
      'utterance is DROPPED with a counter rather than blocking the single ingestion dispatch loop — ' +
      'blocking there would stop acknowledging Redis audio frames and let the stream trim unread audio.',
    category: 'STT Streaming',
  },
  'stt.streaming.inferenceStopTimeoutS': {
    dataType: 'number',
    default: 30.0,
    label: 'Inference worker stop timeout (s)',
    description: "How long to wait for a session's inference worker to drain and stop, on both graceful removal " + 'and force-finalize.',
    category: 'STT Streaming',
  },
  'stt.streaming.workerHeartbeatS': {
    dataType: 'number',
    default: 10,
    label: 'Worker heartbeat interval (s)',
    description: 'Interval between worker heartbeat extensions in Redis.',
    category: 'STT Streaming',
  },
  'stt.streaming.workerHeartbeatTtlS': {
    dataType: 'number',
    default: 30,
    label: 'Worker heartbeat TTL (s)',
    description:
      'TTL for the worker heartbeat key. Must stay comfortably above the heartbeat interval, or a ' + 'healthy worker is reaped between beats.',
    category: 'STT Streaming',
  },
  'stt.streaming.audioStreamMaxlen': {
    dataType: 'number',
    default: 10000,
    label: 'Audio stream MAXLEN',
    description:
      'Approximate MAXLEN for the per-session Redis audio stream. The SINGLE source of truth for that ' +
      "bound — it is kept equal to the gateway bridge's XADD MAXLEN, which is the only production " +
      'writer. At 30-80ms per frame this retains minutes of audio.',
    category: 'STT Streaming',
  },
  'stt.streaming.resultStreamMaxlen': {
    dataType: 'number',
    default: 10000,
    label: 'Result stream MAXLEN',
    description:
      'Approximate MAXLEN for the per-session Redis result stream. High enough that a keeping-up ' +
      'consumer never misses a result; overflowed finals remain in the durable transcript.',
    category: 'STT Streaming',
  },
  'stt.streaming.audioTrimIntervalS': {
    dataType: 'number',
    default: 30.0,
    label: 'Audio stream trim interval (s)',
    description:
      'Minimum interval between XTRIM MINID calls on the consumed portion of the audio stream. ' +
      '0 disables consumed-portion trimming; the MAXLEN bound still applies.',
    category: 'STT Streaming',
  },
  'stt.streaming.extraFillerPatterns': {
    dataType: 'string',
    default: '',
    label: 'Extra hallucination filler patterns',
    description:
      'Pipe-separated extra regex alternates appended to the streaming hallucination filler pattern. ' +
      'Empty = the built-in English + Malayalam filler forms only.',
    category: 'STT Streaming',
  },
  'stt.streaming.punctuationTimeoutS': {
    dataType: 'number',
    default: 0.4,
    label: 'Streaming punctuation timeout (s)',
    description:
      'How long a streaming FINAL waits for Cadence-Fast punctuation before the raw text is published ' +
      '(0.3-0.5s recommended). Applies only when the punctuation model resolves to cadence-fast.',
    category: 'STT Streaming',
  },
  // TASK-880 removed `stt.streaming.partialWindowS`. Its own description said to set it to
  // "the whisper.cpp force-emit window" — i.e. it was a property of the ASR MODEL, applied
  // as one number to every engine on the box. It is now
  // `AiModel._metadata.asr.partialWindowSec`, carried per chain on the spec.
  'stt.streaming.resultStreamExpireS': {
    dataType: 'number',
    default: 3600,
    label: 'Result stream TTL after close (s)',
    description: 'TTL for the Redis result-stream key once the session closes.',
    category: 'STT Streaming',
  },
  'stt.streaming.sessionMetadataExpireS': {
    dataType: 'number',
    default: 86400,
    label: 'Session metadata TTL after close (s)',
    description: 'TTL for the Redis session-metadata key once the session closes.',
    category: 'STT Streaming',
  },

  // TASK-877 removed the whole `stt.semanticEndpoint.*` family (enabled, minSilenceMs,
  // maxSilenceMs, confidenceThreshold, minWords, modelId) and `stt.streaming.partialIntervalS`.
  // Each duplicated a concept the ASR AGENT owns, and the owner's rule is that a redundant
  // setting from the old architecture is removed COMPLETELY, not dual-homed: endpointing mode,
  // its four tuning knobs, the end-of-utterance model and the partial cadence all arrive per
  // session on `ResolvedAsrSpec` (`streaming.{partialIntervalMs,endpointing,semantic}` plus the
  // new `endpointing` model role).
  //
  // `stt.semanticEndpoint.enabled` carried `killSwitch: true`. Its replacement is NOT a flag:
  // an agent selects `streaming.endpointing`, and the platform's veto is refusing to publish
  // an `endpointing` model row — the same shape the rest of the agent's model chain already
  // has. Nothing can turn semantic endpointing on behind the agent's back any more.

  // ── real-time event publishing ───────────────────────────────────────────
  'stt.pubsub.channelPrefix': {
    dataType: 'string',
    default: 'stt:transcription:',
    label: 'Transcription pub/sub channel prefix',
    description:
      'Redis pub/sub channel prefix for real-time transcription events; the full channel is ' +
      '{prefix}{jobId}. The gateway subscriber listens on the same channel to relay events over SSE, ' +
      'so the two must agree — changing this alone silently stops the relay.',
    category: 'STT Runtime',
  },
  'stt.pubsub.enabled': {
    dataType: 'boolean',
    default: true,
    // DELIBERATELY NOT `killSwitch: true`.
    //
    // The registry enforces that a kill-switch defaults OFF, and this one
    // defaults ON — correctly. Turning it off does not disable an enforcement
    // gate; it stops the real-time transcription event feed the clinician-facing
    // SSE relay is built on, so a "fail-safe" default of OFF would silently take
    // live transcription off the air on first deploy. The precedent for flipping
    // a default while migrating (`consultation.ocr.enabled`) applies to gates
    // that ENFORCE something, not to a data path.
    label: 'Transcription pub/sub enabled',
    description:
      'Publishes real-time transcription events to Redis pub/sub. When off the worker still calls the ' +
      'gateway for job lifecycle updates, but the live SSE relay receives nothing — turn it off only ' +
      'to shed load from the event path deliberately.',
    category: 'STT Runtime',
  },

  // ── punctuation restoration (Cadence) ────────────────────────────────────
  // TASK-877 removed `stt.punctuation.enabled` and `stt.punctuation.modelName`.
  // The first was a boot gate that returned early and so VETOED
  // `postProcessing.punctuation.enabled` on every agent's spec (and defaulted OFF,
  // meaning punctuation was globally unreachable); the second duplicated
  // `models.punctuation.slug`. Both are agent decisions now.
  //
  // The kill-switch is not needed to contain the loader hazard it cited: only the
  // legacy `cadence` wrapper fails under the pinned transformers 5.x (the exact name
  // `cadence-fast` loads fine), and the service latches off after ONE failed load,
  // degrading to passthrough with a single warning.
  //
  // The three below are KEPT: device placement, cache directory and window width
  // describe the HOST, not the agent's behaviour.
  'stt.punctuation.modelCacheDir': {
    dataType: 'string',
    default: '',
    label: 'Punctuation model cache dir',
    description: 'Cache directory for punctuation model weights. Empty = the default HuggingFace cache.',
    category: 'STT Transcription',
  },
  'stt.punctuation.device': {
    dataType: 'string',
    default: 'auto',
    label: 'Punctuation device',
    description: 'Device for punctuation inference: cpu | cuda | auto.',
    category: 'STT Transcription',
  },
  'stt.punctuation.maxLength': {
    dataType: 'number',
    default: 300,
    label: 'Punctuation max sequence length',
    description: 'Maximum sequence length / sliding-window width for the punctuation model.',
    category: 'STT Transcription',
  },
};

export const STT_RUNTIME_SETTINGS: SettingDescriptor[] = Object.entries(KNOBS).map<SettingDescriptor>(([key, knob]) => ({
  key,
  // D-2: `global-kv` is the one tier with a complete read + write + cascade +
  // invalidate loop. Every migrated Python knob defaults to it.
  tier: 'global-kv',
  dataType: knob.dataType,
  // Never `secret` — the read service filters secrets off this route
  // unconditionally, and no credential appears in this file by construction.
  sensitivity: 'internal',
  // D-1: PLATFORM scope. One cached snapshot per stt process, forever.
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  // TUNING, so an unwritten row degrades to the descriptor default rather than
  // failing the pull. `resolveKey` already turns a control-plane miss into
  // `env-fallback` with a null value, which the Python client reads as "keep my
  // bootstrap value" — `open-to-default` keeps that contract exact.
  failMode: 'open-to-default',
  // The ONE wiring step: this is what puts the key on
  // `GET /internal/effective-config?service=stt`.
  consumedBy: ['stt'],
  category: knob.category,
  ...(knob.killSwitch ? { killSwitch: true } : {}),
  label: knob.label,
  description: knob.description,
  default: knob.default,
}));
