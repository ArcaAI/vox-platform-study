// TASK-891 B1 — realtime consultation-scribe runtime budgets.
//
// ## Why this key exists
//
// `LIVE_DOC_TEXT_TIMEOUT_MS` was a raw env read in the live-documentation
// constructor with a hard-coded `?? 20000` fallback and no row anywhere. Measured on
// `hope-v2-dev` (2026-09-07): ONE realtime SOAP generation takes **14.06 s on an idle
// cluster** with a 136-token transcript, and 20–52 s when Whisper is competing for the
// same time-sliced GPUs. The budget was therefore below the p50 of the thing it was
// budgeting, and EVERY realtime summary call timed out — the gateway logged
// `timeout of 20000ms exceeded` on every flush of the traced session.
//
// A budget that must move when a model, a GPU or a load profile changes is not a
// deploy-time constant (`09-infrastructure-devops.md` §Configuration Tiers, corollary
// L1: an env var is immutable for the process lifetime). It is a tuning knob, so it is
// `global-kv` / `open-to-default`, resolved on every flush like the `agentic.context.*`
// siblings — a super admin's write governs the next flush with no redeploy.
//
// The env var stays supported as the OPERATIONAL lane and deliberately LOSES to a
// stored value, exactly as `agentic-context.descriptors.ts` documents for its own keys:
// the registry is the control plane.
//
// ## Why the default is 60000 and not "a bit more than 20000"
//
// The observed distribution is 14 s idle → 52 s loaded. A budget must sit above the
// tail it is protecting against, or it converts a slow flush into no flush at all —
// which is the failure this ticket exists to fix. The single-flight gate (B3) is what
// bounds the cost of a generous budget: at most ONE generation per session is ever in
// flight, so a slow model degrades cadence rather than piling up concurrent calls.

import { SettingDescriptor } from '../registry.types';

/** The governed realtime TEXT budget (ms). */
export const CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY = 'consultation.realtime.textTimeoutMs';

// ─── TASK-940 — the seven remaining constructor freezes ──────────────────────
//
// Each of these was `Number(this.configService.get('LIVE_DOC_…') ?? <literal>)`
// read ONCE in the `LiveDocumentationService` constructor, so the value was
// immutable for the process lifetime. That is the disqualifying property, not a
// stylistic one: `09-infrastructure-devops.md` §Configuration Tiers corollary L1
// says a value that must change without a restart is not an env var, and every
// one of these is a budget or a cadence an operator tunes against a live GPU
// load profile. They join `textTimeoutMs` above on exactly its contract —
// `global-kv`, `open-to-default`, stored row wins, env loses.
//
// ## Which ones kept an env override, and why the answer differs
//
// Four kept theirs as a PRE-FIRST-FLUSH seed, the same role `textTimeoutMs`'s
// plays: they are consulted during a flush, and the seed makes the value before
// the first resolve identical to what that resolve returns.
//
// Two did NOT: `heartbeatMs` and `statsTtlSec`. Before retiring them it was
// measured that no DEPLOYMENT set any of the seven — not `.env.dev`/`.env.test`/any
// `.env.sample`, and not `hope-v2-deployment` (`base/config/api.env` and the dev
// overlay set exactly one `LIVE_DOC_*`, and it is `LIVE_DOC_TEXT_TIMEOUT_MS`). So
// no deployment loses a configured value, and each retired name is one fewer entry
// hashed into every turbo task's cache key for a lane nobody uses.
//
// `durableSnapshotMs` was in that retirement list and came OUT of it on evidence.
// The deployment scan missed TEST FIXTURES, and three set it — one to `0`, which is
// a meaningful value here (it disables periodic durable writes). More importantly
// the harness they use passes NO settings facade, so retiring the env name would
// have left that knob with no lane at all rather than one fewer lane. That is the
// case the `textTimeoutMs` exemplar kept its own env var for in the first place
// ("the fallback for an unwired settings graph"), and it applies unchanged here.
//
// ## `heartbeatMs` is honest about its granularity
//
// Six are read during a flush, so a write governs the next one. `heartbeatMs` is
// read once per SSE subscription in `subscribeToLiveSummary`, which is
// synchronous and holds no tenant — so a write reaches subscriptions opened after
// the next flush refreshes the mirror. It is governed (a restart is no longer
// required) but it is not per-flush, and the descriptor says so rather than
// claiming a granularity the call site cannot deliver.

/** SSE heartbeat interval for the live-summary channel (ms). */
export const CONSULTATION_REALTIME_HEARTBEAT_MS_KEY = 'consultation.realtime.heartbeatMs';
/** Durable-snapshot write throttle (ms); 0 disables periodic durable writes. */
export const CONSULTATION_REALTIME_DURABLE_SNAPSHOT_MS_KEY = 'consultation.realtime.durableSnapshotMs';
/** TTL on the per-session Redis stats snapshot and the active-session set (seconds). */
export const CONSULTATION_REALTIME_STATS_TTL_SEC_KEY = 'consultation.realtime.statsTtlSec';
/** `max_tokens` ceiling on every realtime TEXT generation. */
export const CONSULTATION_REALTIME_TEXT_MAX_TOKENS_KEY = 'consultation.realtime.textMaxTokens';
/** Per-call budget for the gateway→guardrail groundedness hop (ms). */
export const CONSULTATION_REALTIME_GROUNDEDNESS_TIMEOUT_MS_KEY = 'consultation.realtime.groundedness.timeoutMs';
/** Bounded retries for a failed groundedness call. */
export const CONSULTATION_REALTIME_GROUNDEDNESS_MAX_RETRIES_KEY = 'consultation.realtime.groundedness.maxRetries';
/** Backoff between groundedness retries (ms). */
export const CONSULTATION_REALTIME_GROUNDEDNESS_RETRY_BACKOFF_MS_KEY = 'consultation.realtime.groundedness.retryBackoffMs';

/**
 * Code defaults for the `consultation.realtime.*` runtime budgets — the single source
 * of truth shared by the descriptors below and the live-documentation consumer.
 */
export const CONSULTATION_REALTIME_DEFAULTS = {
  [CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY]: 60000,
  // TASK-940 — byte-identical to the constructor literals these replace. A
  // migration that also re-tunes a live clinical loop is two changes wearing one
  // commit, and only one of them would be under test.
  [CONSULTATION_REALTIME_HEARTBEAT_MS_KEY]: 15000,
  [CONSULTATION_REALTIME_DURABLE_SNAPSHOT_MS_KEY]: 30000,
  [CONSULTATION_REALTIME_STATS_TTL_SEC_KEY]: 300,
  [CONSULTATION_REALTIME_TEXT_MAX_TOKENS_KEY]: 8192,
  [CONSULTATION_REALTIME_GROUNDEDNESS_TIMEOUT_MS_KEY]: 5000,
  [CONSULTATION_REALTIME_GROUNDEDNESS_MAX_RETRIES_KEY]: 1,
  [CONSULTATION_REALTIME_GROUNDEDNESS_RETRY_BACKOFF_MS_KEY]: 200,
} as const;

/** Every `consultation.realtime.*` key, in declaration order. */
export const CONSULTATION_REALTIME_KEYS = Object.keys(CONSULTATION_REALTIME_DEFAULTS) as ReadonlyArray<keyof typeof CONSULTATION_REALTIME_DEFAULTS>;

export const CONSULTATION_REALTIME_SETTINGS: SettingDescriptor[] = [
  {
    key: CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // PLATFORM-owned, like every other `agentic`/live-loop knob: this is a budget for
    // the platform's own gateway→TEXT hop, not a clinical preference a tenant holds an
    // opinion about. A per-tenant row would also multiply the resolution cardinality of
    // a value read on every flush.
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    // A tuning knob: an absent row degrades to the code default, never to an outage.
    // (`failMode` governs an ABSENT VALUE only — a settings-backend error still
    // propagates and is never disguised as "the default".)
    failMode: 'open-to-default',
    // Still honoured as an override, and seeded in the consumer's constructor so
    // the value before the first resolve matches what that resolve returns.
    // Declared so `turbo.json#globalEnv` hashes a name the gateway really reads
    // (TASK-940) — it is never rendered into an operator-facing `.env.sample`.
    envOverride: ['LIVE_DOC_TEXT_TIMEOUT_MS'],
    category: 'Agentic Context',
    label: 'Realtime TEXT generation timeout (ms)',
    description:
      'Per-call budget for the gateway→TEXT hop on the REALTIME consultation lane (the running note, the grammar/corrections pass and the important-findings pass). Replaces the hard-coded 20000 ms behind `LIVE_DOC_TEXT_TIMEOUT_MS`, which sat BELOW the measured p50 of a realtime SOAP generation (14 s idle, 20–52 s under GPU contention) and therefore timed out every flush. The env var is still read as an operational override and deliberately loses to a stored value. Raising it is bounded by the single-flight flush gate: at most one generation per session is ever in flight.',
    default: CONSULTATION_REALTIME_DEFAULTS[CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY],
  },
  // TASK-940 — the seven former constructor freezes, on the same contract as the
  // exemplar above. Built through `budget()` because the SHARED half (tier, scope,
  // failMode, category) must be identical by construction: seven hand-copied
  // descriptors are seven chances for one to drift to `maxScope: 'tenant'` and
  // multiply the resolution cardinality of a value read on every flush.
  ...(
    [
      {
        key: CONSULTATION_REALTIME_HEARTBEAT_MS_KEY,
        label: 'Realtime SSE heartbeat (ms)',
        description:
          'Interval between keep-alive frames on the live-summary SSE channel. Replaces `LIVE_DOC_HEARTBEAT_MS`, read once in the live-documentation constructor. NOTE the granularity: this value is read when a SUBSCRIPTION opens, not on each flush, so a write here reaches subscriptions opened after the next flush refreshes the in-memory mirror — it is governed, but it is not per-flush. Too long and an idle proxy may drop the connection; too short and every quiet consultation pays for traffic it does not need.',
        envOverride: undefined,
      },
      {
        key: CONSULTATION_REALTIME_DURABLE_SNAPSHOT_MS_KEY,
        label: 'Durable snapshot throttle (ms)',
        description:
          'Minimum time between DURABLE writes of the live note, so a busy consultation does not write the same document to Postgres on every flush. 0 disables periodic durable writes entirely, leaving only the forced writes at section confirm and close. Replaces `LIVE_DOC_DURABLE_SNAPSHOT_MS`, which it still honours as a pre-resolution override. Raising it reduces write load and widens the window a crash can lose; lowering it does the reverse.',
        envOverride: ['LIVE_DOC_DURABLE_SNAPSHOT_MS'],
      },
      {
        key: CONSULTATION_REALTIME_STATS_TTL_SEC_KEY,
        label: 'Live stats snapshot TTL (seconds)',
        description:
          'How long a per-session Redis stats snapshot and its entry in the tenant active-set survive without a refresh. Refreshed on every flush, so this is also the window after which a CRASHED or quiet session drops out of the admin "live sessions" list. Replaces `LIVE_DOC_STATS_TTL_SEC`. Too short and an actively-recording but slow session disappears from the admin view; too long and dead sessions linger in it.',
        envOverride: undefined,
      },
      {
        key: CONSULTATION_REALTIME_TEXT_MAX_TOKENS_KEY,
        label: 'Realtime TEXT max tokens',
        description:
          "Ceiling on `max_tokens` for every realtime TEXT generation (the running note, the grammar pass and the important-findings pass). This is the LANE budget and is deliberately distinct from the selected agent's own `parameters.generation.maxTokens`, which wins where it is set. Replaces `LIVE_DOC_TEXT_MAX_TOKENS`. Set it below the note a template asks for and sections arrive truncated, which reads as a model fault and is not one.",
        envOverride: ['LIVE_DOC_TEXT_MAX_TOKENS'],
      },
      {
        key: CONSULTATION_REALTIME_GROUNDEDNESS_TIMEOUT_MS_KEY,
        label: 'Groundedness call timeout (ms)',
        description:
          'Per-call budget for the gateway→guardrail groundedness hop that verifies the generated note against the source transcript. Replaces `LIVE_DOC_GROUNDEDNESS_TIMEOUT_MS`. Degrade is fail-CLOSED: exhausting this budget marks segments `unverified`, never `grounded` — so a value set too low does not weaken the gate, it stops the gate from ever passing.',
        envOverride: ['LIVE_DOC_GROUNDEDNESS_TIMEOUT_MS'],
      },
      {
        key: CONSULTATION_REALTIME_GROUNDEDNESS_MAX_RETRIES_KEY,
        label: 'Groundedness max retries',
        description:
          'How many times a failed groundedness call is retried before the flush gives up and marks its segments `unverified`. The bounded retry is what absorbs a transient guardrail blip without stalling the clinical loop. Replaces `LIVE_DOC_GROUNDEDNESS_MAX_RETRIES`.',
        envOverride: ['LIVE_DOC_GROUNDEDNESS_MAX_RETRIES'],
      },
      {
        key: CONSULTATION_REALTIME_GROUNDEDNESS_RETRY_BACKOFF_MS_KEY,
        label: 'Groundedness retry backoff (ms)',
        description:
          'Delay before retrying a failed groundedness call. Replaces `LIVE_DOC_GROUNDEDNESS_RETRY_BACKOFF_MS`. It is paid inside the flush, so this plus the timeout bounds how long groundedness can hold a note back from the clinician.',
        envOverride: ['LIVE_DOC_GROUNDEDNESS_RETRY_BACKOFF_MS'],
      },
    ] as const
  ).map<SettingDescriptor>((budget) => ({
    key: budget.key,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // PLATFORM-owned, for the same reason the exemplar above is: these are
    // budgets for the platform's own hops, not clinical preferences a tenant
    // holds an opinion about — and a per-tenant row would multiply the
    // resolution cardinality of a value read on every flush.
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    // Tuning knobs: an absent row degrades to the code default, never to an
    // outage. (`failMode` governs an ABSENT VALUE only — a settings-backend
    // error still propagates and is never disguised as "the default".)
    failMode: 'open-to-default',
    category: 'Agentic Context',
    label: budget.label,
    description: budget.description,
    default: CONSULTATION_REALTIME_DEFAULTS[budget.key],
    ...(budget.envOverride ? { envOverride: budget.envOverride } : {}),
  })),
];
