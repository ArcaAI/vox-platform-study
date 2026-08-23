// stt tuning knobs — the ~68 keys that used to be environment variables.
//
// TASK-799 lane C. `service-runtime.descriptors.ts` already carries stt's four
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
//  • `STORAGE_PROVIDER` and the `AZURE_STORAGE_*` companions. Their correct home
//    is the `storage.platformDefault.*` cascade, which is `tier: 'db-config'` —
//    and `EffectiveSettingsService.resolveEffective` has no resolver for that
//    tier (it throws for anything that is not `pipeline.*` / `models.*` /
//    `global-kv`). Declaring `consumedBy` on those descriptors today would
//    compile, deploy, and silently do NOTHING: `resolveKey` catches the throw
//    and degrades to `env-fallback`. They stay in env until the db-config read
//    lane exists (assessment RC-5).

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
    description:
      'Azure AI Foundry / Speech resource endpoint, e.g. https://<res>.cognitiveservices.azure.com. ' +
      'Empty = unset.',
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
    description:
      'Base URL for the OpenAI (or Azure-OpenAI-compatible) speech-to-text API. The key is BYOK and ' +
      'arrives per request.',
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
  'stt.whisperCpp.maxAudioSeconds': {
    dataType: 'number',
    default: 7.0,
    label: 'whisper.cpp max audio per decode (s)',
    description:
      'Longest audio fed to whisper.cpp in one decode. The ml-en code-switch fine-tune is accurate ' +
      'to ~6-7s and truncates or garbles beyond it, so longer utterances are split at silence ' +
      'troughs, decoded independently and stitched. 0 disables chunking.',
    category: 'STT Engines',
  },
  'stt.whisperCpp.consultationPromptEnabled': {
    dataType: 'boolean',
    default: false,
    label: 'whisper.cpp consultation prompt',
    description:
      'Whether the whisper.cpp adapter prepends its language-derived clinical-consultation ' +
      'initial_prompt (exemplar prior context, not an instruction). Default OFF — measured to ' +
      'inject spurious tokens and break grapheme clusters on the ml-en fine-tune. Turn on only ' +
      'where an eval shows it helps.',
    category: 'STT Engines',
  },

  // ── VAD (Silero v5) ──────────────────────────────────────────────────────
  'stt.vad.modelPath': {
    dataType: 'string',
    default: '',
    label: 'Silero VAD model path',
    description: 'Path to the Silero VAD ONNX model. Empty = auto-download on first use.',
    category: 'STT Audio',
  },
  'stt.vad.threshold': {
    dataType: 'number',
    default: 0.5,
    label: 'VAD speech threshold',
    description:
      'Silero VAD speech-detection threshold (0.0–1.0). Lower catches more quiet speech at the cost ' +
      'of more false triggers; this is the knob a deployment retunes against its own microphone ' +
      'estate, which is why it must not require a redeploy.',
    category: 'STT Audio',
  },
  'stt.vad.minSpeechDurationMs': {
    dataType: 'number',
    default: 100,
    label: 'VAD minimum speech duration (ms)',
    description:
      'Shortest segment VAD will report as speech. 100ms so short clinical confirmations ("mm", ' +
      '"yes") survive rather than being discarded as noise.',
    category: 'STT Audio',
  },
  'stt.vad.minSilenceDurationMs': {
    dataType: 'number',
    default: 500,
    label: 'VAD minimum silence duration (ms)',
    description: 'Silence required to end a speech segment.',
    category: 'STT Audio',
  },
  'stt.vad.speechPadMs': {
    dataType: 'number',
    default: 200,
    label: 'VAD segment padding (ms)',
    description: 'Padding applied to both ends of a detected segment (200ms per production ASR guidance).',
    category: 'STT Audio',
  },

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
      'Threads for PyTorch inter-op parallelism. 1 is optimal for single-request inference; raise it ' +
      'only for concurrent batch processing.',
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
    description:
      'Maximum batch size for the dynamic batch scheduler (GPU inference). 0 = auto-detect from the ' +
      'hardware execution profile.',
    category: 'STT Streaming',
  },
  'stt.streaming.batchWaitMs': {
    dataType: 'number',
    default: 0,
    label: 'Streaming batch wait (ms)',
    description:
      'How long the batch scheduler waits before dispatching an incomplete batch. 0 = auto-detect.',
    category: 'STT Streaming',
  },
  'stt.streaming.embeddingDevice': {
    dataType: 'string',
    default: 'auto',
    label: 'Streaming embedding device',
    description:
      "Device for speaker-embedding extraction during streaming. 'auto' picks from the hardware " +
      'profile (e.g. cuda:1, cpu, mps).',
    category: 'STT Streaming',
  },
  'stt.streaming.multiGpuStrategy': {
    dataType: 'string',
    default: 'auto',
    label: 'Streaming multi-GPU strategy',
    description:
      "auto (detect) | replicate (same model on each GPU) | split (ASR on GPU 0, embeddings on GPU 1) " +
      '| none (single GPU or CPU).',
    category: 'STT Streaming',
  },
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
    description:
      'Base backoff between durable-transcript persist retries; the delay scales with attempt number. ' +
      '0 disables the wait.',
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
    description:
      "How long to wait for a session's inference worker to drain and stop, on both graceful removal " +
      'and force-finalize.',
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
      'TTL for the worker heartbeat key. Must stay comfortably above the heartbeat interval, or a ' +
      'healthy worker is reaped between beats.',
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
  'stt.streaming.partialWindowS': {
    dataType: 'number',
    default: 6.0,
    label: 'Partial decode tail window (s)',
    description:
      'Tail window of the current utterance decoded for PARTIAL transcripts. Set to the whisper.cpp ' +
      'force-emit window (~6s) so the last partial and the final decode the SAME audio — decoding is ' +
      'deterministic, so matched windows converge and the final stops visibly rephrasing the partial.',
    category: 'STT Streaming',
  },
  'stt.streaming.partialIntervalS': {
    dataType: 'number',
    default: 0.4,
    label: 'Partial emission interval (s)',
    description:
      'Minimum wall-clock interval between successive PARTIAL emissions for a live utterance. The ' +
      'LocalAgreement-2 commit policy still governs when a word is COMMITTED; this only paces the ' +
      'tentative tail.',
    category: 'STT Streaming',
  },
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

  // ── semantic endpointing ─────────────────────────────────────────────────
  'stt.semanticEndpoint.enabled': {
    dataType: 'boolean',
    default: false,
    label: 'Semantic endpointing enabled',
    description:
      'Content-driven end-of-utterance detection on the streaming hot path. Default OFF: until it is ' +
      'measured against the accuracy/latency scorecard the preprocessor keeps the fixed Silero-VAD ' +
      'silence offset. A wrong early cut truncates clinical content, which is why this is a ' +
      'kill-switch rather than a plain flag.',
    category: 'STT Streaming',
    killSwitch: true,
  },
  'stt.semanticEndpoint.minSilenceMs': {
    dataType: 'number',
    default: 200,
    label: 'Semantic endpoint silence floor (ms)',
    description:
      'Trailing silence required before a semantic early cut is allowed. Kept below the fixed VAD ' +
      'backstop so a semantic cut is genuinely earlier than it.',
    category: 'STT Streaming',
  },
  'stt.semanticEndpoint.maxSilenceMs': {
    dataType: 'number',
    default: 500,
    label: 'Semantic endpoint latency band max (ms)',
    description:
      'Target-max end-of-utterance latency band — informational. The fixed VAD silence offset remains ' +
      'the true upper bound and backstop.',
    category: 'STT Streaming',
  },
  'stt.semanticEndpoint.confidenceThreshold': {
    dataType: 'number',
    default: 0.85,
    label: 'Semantic endpoint confidence threshold',
    description:
      'Minimum decision confidence (0–1) to cut a final early. Raise it if measurement shows early ' +
      'cuts truncating clinical content; the fixed backstop always still fires.',
    category: 'STT Streaming',
  },
  'stt.semanticEndpoint.minWords': {
    dataType: 'number',
    default: 3,
    label: 'Semantic endpoint minimum words',
    description:
      'Minimum running-hypothesis word count before a semantic early cut; shorter fragments defer to ' +
      'the fixed silence timer.',
    category: 'STT Streaming',
  },
  'stt.semanticEndpoint.modelId': {
    dataType: 'string',
    default: '',
    label: 'Semantic endpoint model id',
    description:
      'Optional SELF-HOSTED turn/end-of-utterance model. Empty = model-free heuristic only. An ' +
      'un-staged id degrades to the heuristic. Never a cloud vendor: this sees live clinical audio ' +
      'transcript ahead of the guardrail.',
    category: 'STT Streaming',
  },

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
  'stt.punctuation.enabled': {
    dataType: 'boolean',
    default: false,
    label: 'Punctuation restoration enabled',
    description:
      'Cadence punctuation restoration at startup and runtime. Default OFF: the production Whisper ' +
      'pipelines already emit punctuation and casing, so Cadence is redundant for them, and ' +
      'cadence-punctuation 1.1.0 cannot load under the pinned transformers 5.x. Enable only with a ' +
      "combination known to load — an Indic path on transformers <5, or the direct-load 'cadence-fast'.",
    category: 'STT Transcription',
    killSwitch: true,
  },
  'stt.punctuation.modelName': {
    dataType: 'string',
    default: 'Cadence',
    label: 'Punctuation model',
    description:
      "'Cadence' (1B) or 'Cadence-Fast' (270M) through the cadence-punctuation wrapper, or " +
      "'cadence-fast' for the direct transformers load (the only one that works under transformers 5.x). " +
      'A pipeline YAML may override it per pipeline.',
    category: 'STT Transcription',
  },
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
