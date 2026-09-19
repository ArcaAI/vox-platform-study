// TASK-944 lane A — the GATEWAY-side budget for opening an STT streaming session.
//
// ## Why this key exists
//
// `StreamingSessionService.createSession` carried `timeout: 15000` as a literal on the
// gateway → `POST /internal/streaming/sessions` hop. Measured on `hope-v2-dev`
// (2026-09-10 09:37Z), the FIRST session after an STT pod restart:
//
//     stt.access  POST /internal/streaming/sessions  status_code 201  duration_ms 16870.07
//     api         StreamingSessionService  "Failed to create streaming session"
//                 error: "timeout of 15000ms exceeded"  (ECONNABORTED)
//     api         POST audio/transcription-jobs/stream/session -> 503 in 15027ms
//
// STT SUCCEEDED, 1 870 ms after the gateway had already given up and 503'd the
// clinician. A warm session is 0.1–0.5 s, so the literal failed on exactly one request
// per deploy — the first one — and never in a test.
//
// ## Why it is a descriptor and not a bigger literal
//
// A cold-start budget moves whenever the model set, the GPU contention profile or the
// weight cache changes. `09-infrastructure-devops.md` §Configuration Tiers corollary L1:
// a value that must change without a restart is not a deploy-time constant. Bumping
// `15000` to `30000` re-creates the same defect the first time a cold start crosses the
// new line, and does so on a platform where the only remedy is a redeploy. Making it
// `global-kv` / `open-to-default` means a super admin's write governs the NEXT session
// open, with no rebuild.
//
// ## Why the default is 60000
//
// The same reasoning as `consultation.realtime.textTimeoutMs`, which fixed the identical
// shape of defect one lane over: a budget must sit ABOVE the tail it protects against, or
// it converts a slow call into no call at all. The measured cold start is 16.87 s on an
// otherwise-idle cluster; whisper + embedding weights load under GPU contention. The
// timeout is not a UX dial — a warm session never reaches it, and the answer to a slow
// cold start is a warmed pod, not an early abort that turns a working STT into a 503.
//
// ## Why it lives HERE and not in `stt-runtime.descriptors.ts`
//
// Every key in that file is `consumedBy: ['stt']` — pulled BY the Python service over
// `GET /internal/effective-config`. This one is read by the GATEWAY, about its own
// outbound call, and `apps/stt` has no use for it. Declaring `consumedBy` on it would put
// a key on the pull route that no Python reader consumes; the naming follows the other
// gateway-side hop budgets (`phiRedaction.requestTimeoutMs`,
// `consultation.realtime.textTimeoutMs`) rather than the `stt.*` pull family, so the two
// namespaces stay legible.

import { SettingDescriptor } from '../registry.types';

/** The governed gateway→STT session-create budget (ms). */
export const STT_SESSION_CREATE_TIMEOUT_MS_KEY = 'sttStreaming.sessionCreateTimeoutMs';

/**
 * TASK-985 (ST-5) — the WS egress high watermark, in bytes of `bufferedAmount`.
 *
 * Above it the gateway DROPS partial transcripts and QUEUES finals. It was the module-scope
 * `process.env.STT_WS_EGRESS_HIGH_WATERMARK_BYTES` read at import in `stt-ws.gateway.ts`, i.e.
 * a value that could only change with a pod restart.
 */
export const STT_EGRESS_HIGH_WATERMARK_BYTES_KEY = 'sttStreaming.egressHighWatermarkBytes';

/** TASK-985 (ST-5) — the resume grace window (ms) a transient socket drop keeps the session for. */
export const STT_RESUME_GRACE_MS_KEY = 'sttStreaming.resumeGraceMs';

/** TASK-985 (ST-5) — the oldest a buffered PARTIAL may be and still be replayed on resume (ms). */
export const STT_RESUME_MAX_REPLAY_AGE_MS_KEY = 'sttStreaming.resumeMaxReplayAgeMs';

/** TASK-985 (M-47) — how often the gateway pings each live STT socket (ms). */
export const STT_WS_PING_INTERVAL_MS_KEY = 'sttStreaming.wsPingIntervalMs';

/** TASK-985 (M-47) — consecutive unanswered pings before the socket is terminated. */
export const STT_WS_PING_MISSES_KEY = 'sttStreaming.wsPingMissesBeforeTerminate';

/** TASK-992 — how many times a batch job may be reclaimed from a dead worker before it is marked DEAD. */
export const STT_BATCH_MAX_RECLAIMS_KEY = 'stt.batch.maxReclaims';

/** TASK-992 — how long a PROCESSING batch job may go without a write before the reaper fails it (minutes). */
export const STT_BATCH_STALE_PROCESSING_MINUTES_KEY = 'stt.batch.staleProcessingMinutes';

/** TASK-992 — the reaper's scan cadence. */
export const STT_BATCH_REAPER_CRON_KEY = 'stt.batch.reaper.cron';

/**
 * Code defaults for the gateway-side STT budgets — the single source of truth shared by
 * the descriptor below and `StreamingSessionService`, so the two can never disagree
 * about what "no row" means.
 */
export const STT_GATEWAY_DEFAULTS = {
  [STT_SESSION_CREATE_TIMEOUT_MS_KEY]: 60_000,
  // TASK-985 ST-5. 512 KiB of queued captions is ~50 s of stale transcript in flight to a
  // client that is already not keeping up; by the time it drains, everything in it is
  // clinically useless. 32 KiB bounds the staleness to a few seconds, which is the whole
  // point of dropping under back-pressure rather than queueing.
  [STT_EGRESS_HIGH_WATERMARK_BYTES_KEY]: 32 * 1024,
  [STT_RESUME_GRACE_MS_KEY]: 15_000,
  [STT_RESUME_MAX_REPLAY_AGE_MS_KEY]: 10_000,
  [STT_WS_PING_INTERVAL_MS_KEY]: 20_000,
  [STT_WS_PING_MISSES_KEY]: 2,
} as const;

/**
 * TASK-992 — code defaults for batch-job crash recovery.
 *
 * A SEPARATE map from {@link STT_GATEWAY_DEFAULTS} on purpose. That one is a
 * map of numeric WS/session budgets, and `SttWsGateway.resolveBudget` indexes
 * it generically (`keyof typeof`) while promising a `number` back — so putting
 * the cron STRING in it widens that lookup to `number | string` and breaks the
 * gateway's build. These are not transport budgets anyway; they belong to the
 * batch recovery path and read better owning their own map.
 */
export const STT_BATCH_DEFAULTS = {
  // Mirrors the shape of the per-row `maxRetries` default so the two read
  // alike, but they are deliberately SEPARATE budgets (OD-2).
  [STT_BATCH_MAX_RECLAIMS_KEY]: 3,
  // 2x the actor's own `time_limit` (`transcription_timeout_seconds`, 600 s),
  // so the reaper can never fire while an attempt could legitimately still be
  // running — Dramatiq kills the thread at 600 s, so past 20 minutes with no
  // write there is nothing left alive to interrupt.
  [STT_BATCH_STALE_PROCESSING_MINUTES_KEY]: 20,
  [STT_BATCH_REAPER_CRON_KEY]: '*/5 * * * *',
} as const;

export const STT_GATEWAY_SETTINGS: SettingDescriptor[] = [
  {
    key: STT_SESSION_CREATE_TIMEOUT_MS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // PLATFORM-owned. This budgets the platform's own gateway→STT hop against the
    // platform's own cold-start cost; it is not a clinical preference a tenant holds an
    // opinion about, and a per-tenant row would multiply the resolution cardinality of a
    // value read on every session open.
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    // TUNING: an absent row degrades to the code default, never to an outage.
    // (`failMode` governs an ABSENT VALUE only — a settings-backend error still
    // propagates and is never disguised as "the default".)
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'STT session-create timeout (ms)',
    description:
      'How long the gateway waits for `POST /internal/streaming/sessions` before aborting and answering the ' +
      'client 503. A WARM STT answers in 0.1–0.5 s; this budget only ever binds on the first session after an ' +
      'STT restart, while the pipeline loads its weights — measured at 16.87 s on an idle dev cluster, which is ' +
      'why the former hard-coded 15 000 ms failed on the first request after every single deploy while STT was ' +
      'busy returning 201. Set it above the slowest cold start you actually run, not tight: an abort here does ' +
      'not make the session faster, it discards a session STT is about to open.',
    default: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY],
  },
  // ---------------------------------------------------------------------------------------
  // TASK-985 ST-5 — the five WS-transport budgets, moved off `process.env`.
  //
  // ## Why these are a rule violation and not a preference
  //
  // `STT_WS_EGRESS_HIGH_WATERMARK_BYTES` and `STT_WS_RESUME_GRACE_MS` were module-scope
  // `process.env` reads EVALUATED AT IMPORT (`stt-ws.gateway.ts`). Neither is part of the
  // bootstrap floor: neither is needed to reach the database or to authenticate to Vault, and
  // both are exactly the kind of value that must change without a restart
  // (`09-infrastructure-devops.md` §Configuration Tiers, corollary L1 — "env vars are immutable
  // for the process lifetime"). Worse, both were declared in `turbo.json#globalEnv` and
  // `.env.sample`, so the DECLARATION implied a mutability the code did not have: an operator
  // editing the value got nothing until the pod was recycled (D8 §8 N-7).
  //
  // The other three never existed at all — they are the new budgets M-47 and the resume-replay
  // age bound need, registered here rather than added as fresh literals for the same reason.
  //
  // ## Why they share the `sessionCreateTimeoutMs` shape exactly
  //
  // `global-kv` / `maxScope: 'system'` / `globalOnly: true` / `failMode: 'open-to-default'` /
  // no `consumedBy`. Each describes the PLATFORM's own socket transport, not a clinical
  // preference a tenant holds an opinion about; a per-tenant row would multiply the resolution
  // cardinality of a value read on every session open (and, for the watermark, on every
  // transcript). No `consumedBy` because no Python reader pulls them — `apps/stt` never sees
  // the client socket.
  //
  // ## `failMode: 'open-to-default'` is right for all five
  //
  // Every one is a TUNING knob: an absent row degrades to the code default, never to an outage.
  // (`failMode` governs an ABSENT VALUE only — a settings-backend error still propagates.)
  // Contrast provider/model SELECTION, which is `closed`, because substituting a default there
  // would transcribe with an engine nobody chose.
  // ---------------------------------------------------------------------------------------
  {
    key: STT_EGRESS_HIGH_WATERMARK_BYTES_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'STT WS egress high watermark (bytes)',
    // DEPRECATED ENV OVERRIDE (TASK-985, removed in R4). Honoured for one release as a
    // PRE-RESOLUTION seed — a stored row always wins — so an operator who set the old name in a
    // deployment does not lose their value the moment this lands. Declaring it here is what
    // puts the name into `turbo.json#globalEnv` as a READ (never into any `.env.sample`), which
    // is the mechanism the register row depends on.
    envOverride: ['STT_WS_EGRESS_HIGH_WATERMARK_BYTES'],
    description:
      "Bytes of a client socket's `bufferedAmount` above which the gateway stops sending PARTIAL transcripts " +
      '(dropped, and the client is told once per episode with a `gap` frame) and QUEUES finals until the socket ' +
      'drains. It is a STALENESS bound, not a throughput dial: the old 512 KiB default is roughly 50 seconds of ' +
      'captions in flight to a client that is already not keeping up, all of which is clinically useless by the ' +
      'time it arrives. Raise it only if you would rather deliver old captions than fresh ones. Resolved ONCE per ' +
      'session at the WebSocket handshake, so a change governs the next session to open, not the ones already running.',
    default: STT_GATEWAY_DEFAULTS[STT_EGRESS_HIGH_WATERMARK_BYTES_KEY],
  },
  {
    key: STT_RESUME_GRACE_MS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'STT WS resume grace window (ms)',
    // DEPRECATED ENV OVERRIDE (TASK-985, removed in R4) — same contract as the watermark above.
    envOverride: ['STT_WS_RESUME_GRACE_MS'],
    description:
      'How long a TRANSIENT socket drop keeps the session — its resume buffer, its seq counter and its upstream ' +
      'STT session — alive so the same client can reconnect and continue. The cost of a longer window is real: an ' +
      'in-grace session still holds an upstream STT session, a model pin and a GPU slot, and it counts against the ' +
      "tenant's concurrency cap for the whole window. Resolved at the moment the socket drops, so a change reaches " +
      'the next disconnect.',
    default: STT_GATEWAY_DEFAULTS[STT_RESUME_GRACE_MS_KEY],
  },
  {
    key: STT_RESUME_MAX_REPLAY_AGE_MS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'STT resume max partial replay age (ms)',
    description:
      'The oldest a buffered PARTIAL transcript may be and still be replayed to a client that reconnects inside the ' +
      'grace window. Finals are NEVER aged out — a final is distinct clinical content and is always replayed. A ' +
      'partial older than this has been superseded by the speaker continuing, so replaying it repaints the live ' +
      'region with text the ASR itself no longer believes.',
    default: STT_GATEWAY_DEFAULTS[STT_RESUME_MAX_REPLAY_AGE_MS_KEY],
  },
  {
    key: STT_WS_PING_INTERVAL_MS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'STT WS keepalive ping interval (ms)',
    description:
      'How often the gateway sends a WebSocket ping to each live STT socket. Detection of a HALF-OPEN client — one ' +
      'whose egress was firewalled, so TCP never closes — takes between one and two intervals. Before this existed ' +
      "such a client held its upstream STT session, its model pin and a GPU slot until STT's own 300 s idle reaper, " +
      'up to ten minutes counting the reaper interval.',
    default: STT_GATEWAY_DEFAULTS[STT_WS_PING_INTERVAL_MS_KEY],
  },
  {
    key: STT_WS_PING_MISSES_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'STT WS unanswered pings before terminate',
    description:
      'Consecutive unanswered pings after which the gateway terminates the socket. Terminating routes through the ' +
      'ordinary disconnect path, so a genuinely flaky client still gets its full resume grace window — this setting ' +
      'shortens DETECTION, it does not remove resumability. Below 2 a single lost pong on a congested link ends the ' +
      "socket, so 2 is the floor worth running; 1 is a valid setting only if you are deliberately trading a client's " +
      'reconnect for a GPU slot.',
    default: STT_GATEWAY_DEFAULTS[STT_WS_PING_MISSES_KEY],
  },
  // ── TASK-992 — batch-job crash recovery ────────────────────────────────────
  // All three are PLATFORM-owned (`globalOnly`): they govern the platform's own
  // Dramatiq workers and its own maintenance tick, not a clinical preference a
  // tenant holds an opinion about. All three are TUNING knobs, so an absent row
  // degrades to the code default rather than to an outage — a reaper that
  // refuses to run because a `GlobalSetting` is missing would re-create exactly
  // the stranded-job condition it exists to clear.
  {
    key: STT_BATCH_MAX_RECLAIMS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'STT batch job max reclaims',
    description:
      'How many times a batch transcription job may be taken over by a NEW worker after the previous one died ' +
      'mid-flight. Counted on the job row as `reclaimCount`, separately from `retryCount`: a crashed worker and a ' +
      'transcription that genuinely failed are different events, and sharing one budget would let an OOM spend the ' +
      'allowance a bad audio file needs. Past this bound the job is marked DEAD rather than reclaimed again, which ' +
      'is what stops a worker that crashes on one specific recording from reclaiming it forever. 0 disables ' +
      'reclaim entirely and restores the pre-TASK-992 behaviour, where such a job stranded in PROCESSING.',
    default: STT_BATCH_DEFAULTS[STT_BATCH_MAX_RECLAIMS_KEY],
  },
  {
    key: STT_BATCH_STALE_PROCESSING_MINUTES_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'STT batch stale-PROCESSING window (minutes)',
    description:
      'How long a batch job may sit in PROCESSING with no write to its row before the reaper fails it as ' +
      'WORKER_LOST. The signal is `updatedAt`, which the worker refreshes on every progress callback, so a job ' +
      'that is still making progress is never eligible however long it runs. Keep this ABOVE the worker actor ' +
      "time limit (`transcription_timeout_seconds`, 600 s): Dramatiq kills the attempt's thread at that point, so " +
      'anything older has nothing left alive to interrupt. Set it too low and the reaper fails jobs out from under ' +
      'workers that are mid-diarization, a phase that emits no progress at all.',
    default: STT_BATCH_DEFAULTS[STT_BATCH_STALE_PROCESSING_MINUTES_KEY],
  },
  {
    key: STT_BATCH_REAPER_CRON_KEY,
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'STT batch job reaper cron',
    description:
      'Cron expression for the stranded-batch-job sweep. Cadence only — how LATE a stranded job is noticed is this ' +
      'plus the stale window above; it does not change which jobs are eligible.',
    default: STT_BATCH_DEFAULTS[STT_BATCH_REAPER_CRON_KEY],
  },
];
