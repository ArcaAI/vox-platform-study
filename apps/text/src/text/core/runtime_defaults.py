"""Resource-safety FLOORS — deliberately not configuration.

Every value here answers one question: *what keeps a single wedged upstream from
exhausting this process during the window before the control plane has answered?*
That is a property of the runtime, not a deployment choice, so none of it is
settable — no env var, no pydantic field, no override. Real operating values come
from `AiRuntimeProfile` through `GET /internal/effective-config?service=text`
(`core/effective_config.py`) and are applied to the LIVE objects by
`services/runtime_limits.py`.

The distinction matters because it is exactly what was fixing. A
`pydantic-settings` field whose default is a real operating value is a hardcoded
configuration wearing a config costume: it looks governed, but no tenant and no
platform admin can move it without a redeploy. A floor is different in kind — it
is never the intended operating value, it applies uniformly, and raising it would
not express any policy.

## Why one floor, not one per provider

The eight per-provider blocks encoded ten different timeouts and six different
concurrency ceilings, and *none* of that variation was ever a decision anyone
made — it was accumulated defaults. Per-provider capacity is a real concern, and
it belongs where it can differ per deployment and change without a restart: an
`AiRuntimeProfile` row keyed by provider. Here there is one conservative number.

## Lanes

The user-facing path and the internal judge path share the same mechanism
(`ResizableSemaphore` + `CircuitBreaker`) with separate budgets, so a saturated
user pool cannot starve a safety-plane judgement and a wedged judge call cannot
eat the user-facing budget. That was previously expressed three times over
(`TEXT_CB_*`, `TEXT_QUEUE_*`, `TEXT_JUDGE_*`) with different numbers for the same
four concepts. It is one shape now, keyed `(provider, lane)`.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Literal

Lane = Literal["user", "judge"]

#: Ceiling on a single upstream call. Long enough that a legitimately slow local
#: generation is not cut off, short enough that a hung socket cannot hold a
#: permit forever.
PROVIDER_TIMEOUT_FLOOR_S = 300

#: Concurrent in-flight calls per provider before requests queue.
PROVIDER_MAX_CONCURRENT_FLOOR = 4

#: The engine whose capacity the platform governs directly (TASK-1031 D-1).
LM_STUDIO_PROVIDER = "lm-studio"

#: LM Studio's decode slots per loaded model when the control plane has not
#: answered. The governed value is `lmStudio.serving.parallel` (platform admin,
#: default 10), served as ``lmStudioServing.parallel`` and applied to BOTH lanes
#: of ``lm-studio`` by `services/runtime_limits.py`; this floor must equal that
#: default so an unreachable gateway still serves the same capacity.
LM_STUDIO_PARALLEL_FLOOR = 8  # TASK-1059 OD-1: LM Studio serves 8 parallel slots (was 10)

#: TASK-1062 D-2 A — the live-documentation lane's own share of LM Studio's slots.
#: The gateway marks every live-lane `/generate` call ``X-Hope-Lane: live``; text
#: admits those into a SEPARATE semaphore of this size, so a live flush never queues
#: behind finalize / pre-summary generations on the user lane. The governed value is
#: `lmStudio.serving.liveLaneSlots` (platform admin, default 2), served as
#: ``lmStudioServing.liveLaneSlots``; this floor equals that default.
LIVE_LANE_SLOTS_FLOOR = 2

#: How long a live-marked generation waits for a permit (its reserved live permit, or an idle
#: user-lane permit it borrows) before answering 503 ``CONCURRENCY_LIMIT``. One live generation
#: takes ~40 s on the cluster, so a wait shorter than that refuses every waiter behind a full
#: lane; it stays well under the gateway's TEXT timeout. The governed value is
#: `lmStudio.serving.liveLaneQueueTimeoutSeconds` (platform admin, default 90), served as
#: ``lmStudioServing.liveLaneQueueTimeoutS``; this floor equals that default.
LIVE_LANE_QUEUE_TIMEOUT_FLOOR_S = 90

#: The request header that marks a generation's admission lane, and the one value
#: that selects the live lane. Any other value — or none — is the user lane.
LANE_HEADER = "X-Hope-Lane"
LIVE_LANE = "live"


def split_lm_studio_slots(parallel: int, live_slots: int) -> tuple[int, int]:
    """``(user, live)`` permits for ``lm-studio`` out of ``parallel`` decode slots.

    The live lane is clamped to ``[1, parallel]``; the user lane keeps the rest and
    never drops below one permit, so a live budget at (or above) ``parallel`` can
    never take the user lane offline.
    """
    live = max(1, min(live_slots, parallel))
    return max(1, parallel - live), live


#: Zero means "no client-side rate limiting" — the honest floor, because a
#: non-zero guess would silently throttle a vendor account whose real quota
#: nobody told us. Vendor quotas are a property of the account, so they belong on
#: that account's `AiRuntimeProfile` row.
PROVIDER_TPM_FLOOR = 0
PROVIDER_RPM_FLOOR = 0

#: Admin-facing `/providers` reachability probe. Never a generation path: one
#: hung engine must not stall the listing, so this is far below the generation
#: ceiling by design.
PROVIDER_PROBE_TIMEOUT_S = 5

#: Idle-retention hint forwarded to SERVER-MANAGED engines (Ollama `keep_alive`,
#: LM Studio `ttl`). Text holds no weights, so this is propagation, not a cache.
MODEL_RETENTION_TTL_FLOOR_S = 600

#: Shared outbound connection pool. Sized to the process, not to any upstream.
HTTPX_MAX_CONNECTIONS = 200
HTTPX_MAX_KEEPALIVE = 100

#: Async-task bookkeeping in Redis. How long a finished task's result stays
#: readable, and the cap on a task's event stream. Both are storage-hygiene
#: bounds on a PHI-adjacent store rather than a behaviour anyone tunes, and the
#: env vars that used to set them had no reader outside `main.py`.
TASK_TTL_S = 3600
TASK_STREAM_MAX_LEN = 10_000


@dataclass(frozen=True)
class LaneBudget:
    """One lane's resource budget: queue, concurrency and breaker.

    The four concepts that `TEXT_CB_*` / `TEXT_QUEUE_*` / `TEXT_JUDGE_*` each
    expressed separately, in one shape. ``half_open_max_calls`` and
    ``reset_timeout_s`` stay nullable: ``None`` preserves the breaker's
    unlimited-trial / undecayed behaviour, and a non-null literal here would
    silently start capping and decaying on every deployment.

    ``count_rate_limits`` is False (TASK-993 D-5). Its previous ``True`` was a
    COMPATIBILITY value, not a decision: nothing ever passed
    ``record_failure(is_rate_limit=True)``, so the two settings were
    indistinguishable and the choice was never made on the merits. Now that the
    request path classifies a vendor 429, it is: a 429 is the provider
    answering correctly and naming a deadline, which is evidence about OUR rate,
    not its health — and the breaker's answer (30s blanket open, every tenant,
    no upstream deadline) is strictly worse than honouring the seconds the
    vendor asked for. Sustained 429s DO eventually mean the lane is unusable;
    an operator who wants the breaker to say so sets ``countRateLimits`` on the
    runtime profile, which `merged` applies over this floor. The policy stays in
    the control plane — only the safe default moved.
    """

    max_concurrent: int
    acquire_timeout_s: float
    timeout_s: int
    failure_threshold: int
    recovery_timeout_s: float
    queue_max_size: int
    queue_max_wait_s: float
    half_open_max_calls: int | None = None
    reset_timeout_s: float | None = None
    count_rate_limits: bool = False

    def merged(self, served: dict[str, object]) -> LaneBudget:
        """Return this budget with any control-plane value applied over it.

        A key the control plane does not carry — or carries as null — keeps the
        floor. Never coerce an absent opinion into a real limit.
        """
        updates: dict[str, object] = {
            name: value
            for name, value in served.items()
            if name in self.__dataclass_fields__ and value is not None
        }
        return replace(self, **updates) if updates else self  # type: ignore[arg-type]


#: The user-facing generation lane.
USER_LANE_FLOOR = LaneBudget(
    max_concurrent=PROVIDER_MAX_CONCURRENT_FLOOR,
    acquire_timeout_s=60.0,
    timeout_s=PROVIDER_TIMEOUT_FLOOR_S,
    failure_threshold=5,
    recovery_timeout_s=30.0,
    queue_max_size=200,
    queue_max_wait_s=60.0,
)

#: The internal judge lane (`/generate/internal/judge`).
#:
#: Bounded, never unbounded: an unbounded safety lane would just relocate the
#: saturation problem. A judge call that cannot get a permit WAITS, in a bounded
#: queue, for up to ``acquire_timeout_s`` (owner decision OD-6, TASK-1059): the
#: TASK-1058 e2e showed that shedding the instant every slot was busy (5 s, queue
#: 0) failed whole medical validations under an ordinary burst. A call that finds
#: the queue full, or whose wait runs out, is still a fast 503 — guardrail then
#: retries only that one window (`api/endpoints/judge.acquire_judge_permit`).
#:
#: Concurrency 10, not 2 (owner decision 2026-10-01, TASK-1031): two permits
#: were the cause of every judge-route 503 for a week, and 10 matches LM
#: Studio's decode slots per model. For ``lm-studio`` the served
#: `lmStudio.serving.parallel` replaces it live; this is the floor.
JUDGE_LANE_FLOOR = LaneBudget(
    max_concurrent=LM_STUDIO_PARALLEL_FLOOR,
    acquire_timeout_s=30.0,
    timeout_s=60,
    failure_threshold=5,
    recovery_timeout_s=30.0,
    queue_max_size=2 * LM_STUDIO_PARALLEL_FLOOR,
    queue_max_wait_s=30.0,
)

LANE_FLOORS: dict[str, LaneBudget] = {"user": USER_LANE_FLOOR, "judge": JUDGE_LANE_FLOOR}

#: The user lane of ``lm-studio``: the generic floor at LM Studio's slot count.
LM_STUDIO_USER_LANE_FLOOR = replace(USER_LANE_FLOOR, max_concurrent=LM_STUDIO_PARALLEL_FLOOR)


def lane_floor(provider: str, lane: str) -> LaneBudget:
    """The floor for one ``(provider, lane)``; an unknown lane is the user lane."""
    floor = LANE_FLOORS.get(lane, USER_LANE_FLOOR)
    if floor is USER_LANE_FLOOR and provider == LM_STUDIO_PROVIDER:
        return LM_STUDIO_USER_LANE_FLOOR
    return floor


#: Guardrail transport-tuning floors — see `core/guardrail_posture.py`.
#:
#: There is no ``enabled`` floor and no ``require_medical`` floor any more
#: (TASK-1035 OD-1/OD-4/OD-5): both gates always run, and the medical judge is
#: skipped only by a request that declares ``medical_exempt: "internal"``.
#:
#: How long TEXT waits for guardrail's ANSWER. It must outlast one guardrail
#: validation: admission wait (5 s) + one judge attempt at
#: `guardrail.judge.timeoutSeconds` (60 s; measured judge p99 50.6 s) + slack;
#: raised to 120 s (2026-10-01) for headroom after live 10 s timeouts failed DNA jobs.
#: Shorter, and TEXT abandons judgements guardrail is still running. The nesting
#: is pinned by tests on both services and over the two descriptors.
GUARDRAIL_TIMEOUT_FLOOR_S = 120
#: Retries apply only to failures that started no work downstream (connect
#: failures, a connection dropped before any response, 502/503/504) — see
#: `services/external_guardrail.py`.
GUARDRAIL_MAX_RETRIES_FLOOR = 2
GUARDRAIL_RETRY_BACKOFF_FLOOR_MS = 100
GUARDRAIL_INCLUDE_REASONING_FLOOR = False

#: Connect-phase bound on the moderation call, independent of the answer wait.
#: A connect failure is retried, so under the full answer budget three
#: unreachable attempts would cost minutes. A resource-safety floor, not a policy.
GUARDRAIL_CONNECT_TIMEOUT_S = 5

#: Circuit breaker on the TEXT → guardrail leg. Mirrors guardrail's own per-peer
#: breakers (`TransportPolicy.breaker_failure_threshold` /
#: `breaker_recovery_timeout_s` in `apps/guardrail/.../core/config.py`), which are
#: code contracts with one definition site rather than settings. Open after this
#: many consecutive peer-health failures; admit one probe after the cool-down.
GUARDRAIL_BREAKER_FAILURE_THRESHOLD = 5
GUARDRAIL_BREAKER_RECOVERY_S = 15.0
