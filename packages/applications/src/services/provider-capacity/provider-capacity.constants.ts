/**
 * TASK-998 OD-4 — constants and Lua for the OUTBOUND vendor-capacity limiter.
 *
 * ## Why a SECOND limiter exists beside `TieredThrottlerGuard`
 *
 * They govern opposite directions and answer to different owners:
 *
 * |                | `TieredThrottlerGuard` (rate-limit plane) | this service                       |
 * |----------------|-------------------------------------------|------------------------------------|
 * | Direction      | INBOUND — requests arriving at the gateway | OUTBOUND — calls we make to a vendor |
 * | Bounded by     | what the PLATFORM will serve a tenant      | what the VENDOR's account will accept |
 * | Keyed by       | tenant × route                             | tenant × STT provider              |
 * | Owner of the number | the plan / a super-admin rate rule    | the vendor's account tier (Sarvam 60/100/4000 RPM, 20/100/100 sockets) |
 *
 * Folding these together would mean one number pretending to express two
 * unrelated ceilings: a console screen firing fifteen TanStack queries has
 * nothing to do with how many sockets Sarvam will hold open, and tuning either
 * one for the other's sake breaks the other. So: two limiters, deliberately.
 */

/** Redis key prefix — the fixed-window REST call counter. */
export const PROVIDER_RPM_KEY_PREFIX = 'hope:provider-capacity:rpm:';
/** Redis key prefix — the per-(provider, tenant) live-stream sorted set. */
export const PROVIDER_STREAMS_KEY_PREFIX = 'hope:provider-capacity:streams:';
/**
 * Redis key prefix — the session → `(provider, tenant)` reverse index.
 *
 * It exists so `releaseStreamSlot(sessionId)` can find the sorted set a session
 * sits in without the teardown caller having to remember which provider opened
 * it. Teardown is reached from four paths (the DELETE route, the WS gateway's
 * disconnect/finalize/shutdown sweeps, the Redis removal-retry drain and the
 * compat gateway) and only one of them ever saw the resolved spec.
 */
export const PROVIDER_STREAM_OWNER_KEY_PREFIX = 'hope:provider-capacity:stream-owner:';

/**
 * Fixed-window size for the requests-per-minute dimension, and the TTL of its
 * counter key.
 *
 * A fixed minute window rather than a sliding one because that is the shape the
 * VENDOR enforces — "N requests per minute" — so a sliding window would refuse
 * calls the vendor would have accepted. The TTL is twice the window so a key
 * always outlives the window it counts, even with a little clock skew between
 * API replicas; the bucket id is derived from wall-clock minutes, so replicas
 * agree on the window without coordinating.
 */
export const PROVIDER_RPM_WINDOW_SECONDS = 60;
export const PROVIDER_RPM_KEY_TTL_SECONDS = PROVIDER_RPM_WINDOW_SECONDS * 2;

/**
 * How long a stream slot survives without a heartbeat.
 *
 * ## What happens when a process dies mid-session
 *
 * A slot is a MEMBER of a sorted set whose score is the time it was last seen,
 * never a counter that something must remember to decrement. `acquireStreamSlot`
 * scores it `now`; `heartbeatStreamSlot` re-scores it `now`; every acquire first
 * drops every member older than this window. So a slot held by an API replica
 * that was SIGKILLed, OOM-killed or partitioned away is reclaimed by the next
 * acquire that happens after this window elapses — nothing has to notice the
 * death, and no operator has to clear anything. The whole key also carries the
 * same TTL, so a tenant that stops streaming entirely leaves nothing behind.
 *
 * A naive INCR/DECR pair would instead leak one slot per crash, permanently,
 * until someone found the key by hand. On a vendor cap of 20 concurrent sockets
 * that is a production outage after twenty crashes.
 *
 * ## Why this value
 *
 * It is the reclaim window when NOTHING heartbeats, so it must exceed the
 * longest legitimate consultation or a live session loses its own slot and the
 * next one is refused while it is still streaming. Two hours is comfortably
 * past any single consultation and still short enough that a crash cannot wedge
 * a 20-socket vendor cap for a working day.
 *
 * The intended steady-state caller of `heartbeatStreamSlot` is the WS gateway's
 * existing ~20 s heartbeat (`SttWsGateway.scheduleHeartbeat`, which already
 * republishes the socket registry on that tick); wiring it there belongs to the
 * lane that owns the gateway and shortens the reclaim window to seconds. Until
 * it lands, `StreamingSessionService.getSessionStatus` refreshes opportunistically
 * and ordinary teardown releases immediately — the two-hour window is the
 * backstop for the crash case only.
 */
export const PROVIDER_STREAM_SLOT_TTL_SECONDS = 2 * 60 * 60;

/** Event emitted when the limiter refuses a call. Audited like a quota block. */
export const PROVIDER_CAPACITY_BLOCKED_EVENT = 'provider-capacity.blocked';

/**
 * Counts checks that were SKIPPED because Redis could not answer (fail-open).
 *
 * Non-zero means outbound vendor capacity is NOT being enforced, which is the
 * deliberate posture (see the service's fail-posture note) but must never be
 * invisible. Labelled by `dimension` only — `tenantId` is unbounded cardinality.
 */
export const PROVIDER_CAPACITY_SKIPPED_METRIC = 'provider_capacity_check_skipped_total';

/**
 * The capability strings carried in `QuotaExceededException.metadata.capability`.
 *
 * Both are registered in `QUOTA_RATE_CAPABILITIES`
 * (`apps/api/src/interceptors/exception.interceptor.ts`) so they map to **429**,
 * not the default 409: running into a vendor's per-minute or concurrent-socket
 * ceiling is retry-later, never a permanent conflict. The provider is named in
 * the message rather than in the key so the key stays a stable, matchable
 * constant.
 */
export const PROVIDER_RPM_CAPABILITY = 'sttProviderRequestsPerMinute';
export const PROVIDER_STREAMS_CAPABILITY = 'sttProviderMaxConcurrentStreams';

/**
 * Fixed-window admission, atomic.
 *
 * CHECK-then-INCR rather than INCR-then-compare: a refused call never reaches
 * the vendor, so it must not consume the vendor's budget. The INCR-first form
 * keeps a hammering client locked out for the remainder of the window even
 * after it backs off, which over-protects by punishing the caller instead of
 * pacing it.
 *
 * KEYS[1] counter key
 * ARGV[1] limit (-1 = unlimited)  ARGV[2] key TTL seconds
 * returns {allowed 0|1, countAfter}
 */
export const PROVIDER_RPM_LUA = `
local limit = tonumber(ARGV[1])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if limit >= 0 and used + 1 > limit then
  return {0, used}
end
local after = redis.call('INCR', KEYS[1])
if after == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return {1, after}
`;

/**
 * Concurrency admission, atomic.
 *
 * Sweeps expired members first, so the count is always "slots seen recently",
 * never "slots someone remembered to release". Re-acquiring a member that is
 * already present is idempotent and does NOT re-check the limit — a resumed
 * socket is the same stream, and refusing it at the cap would make a network
 * blip unrecoverable for the session that already owned the slot.
 *
 * KEYS[1] sorted-set key            KEYS[2] session→owner reverse-index key
 * ARGV[1] member (sessionId)        ARGV[2] now (ms)
 * ARGV[3] cutoff (ms, exclusive)    ARGV[4] limit (-1 = unlimited)
 * ARGV[5] ttl seconds               ARGV[6] owner value ("provider|tenantId")
 * returns {allowed 0|1, activeCount}
 */
export const PROVIDER_STREAM_ACQUIRE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
local limit = tonumber(ARGV[4])
local held = redis.call('ZSCORE', KEYS[1], ARGV[1])
if held == false and limit >= 0 then
  local active = redis.call('ZCARD', KEYS[1])
  if active + 1 > limit then
    return {0, active}
  end
end
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('SETEX', KEYS[2], tonumber(ARGV[5]), ARGV[6])
return {1, redis.call('ZCARD', KEYS[1])}
`;
