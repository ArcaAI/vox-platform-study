"""Resource-safety FLOORS — deliberately not configuration.

Every value here answers one question: *what keeps a single wedged upstream from
exhausting this process during the window before the control plane has answered?*
That is a property of the runtime, not a deployment choice, so none of it is
settable — no env var, no pydantic field, no override. Real operating values come
from `AiRuntimeProfile` through `GET /internal/effective-config?service=text`
(`core/effective_config.py`) and are applied to the LIVE objects by
`services/runtime_limits.py`.

The distinction matters because it is exactly what TASK-799 was fixing. A
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
    count_rate_limits: bool = True

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
#: Deliberately smaller: judgement calls are short, and an unbounded safety lane
#: would just relocate the saturation problem. A judge call that cannot get a
#: permit fails fast with a 503 rather than queueing — guardrail owns the retry
#: budget for the safety plane, and queueing here would add latency to a call
#: already on the critical path of a user-facing generation. Its queue size is 0
#: for the same reason: there is no judge queue, and there must not be one.
JUDGE_LANE_FLOOR = LaneBudget(
    max_concurrent=2,
    acquire_timeout_s=5.0,
    timeout_s=60,
    failure_threshold=5,
    recovery_timeout_s=30.0,
    queue_max_size=0,
    queue_max_wait_s=0.0,
)

LANE_FLOORS: dict[str, LaneBudget] = {"user": USER_LANE_FLOOR, "judge": JUDGE_LANE_FLOOR}


#: Guardrail moderation posture floors — see `core/guardrail_posture.py`.
#:
#: ``enabled`` is False so a checkout with no control plane and no guardrail peer
#: still runs (local dev, hermetic CI), exactly as the retired
#: ``TEXT_EXTERNAL_GUARDRAIL_ENABLED`` default did. Turning moderation ON for a
#: clinical deployment is now a platform-admin action in the console rather than
#: an env edit — which is the point: it can be done, and audited, without a
#: redeploy.
GUARDRAIL_ENABLED_FLOOR = False
GUARDRAIL_TIMEOUT_FLOOR_S = 10
GUARDRAIL_MAX_RETRIES_FLOOR = 2
GUARDRAIL_RETRY_BACKOFF_FLOOR_MS = 100
#: Clinical enforce: a reachable guardrail must classify the prompt as medical.
#: A non-clinical tenant turns this off through its own pushed policy, never by
#: changing the platform floor.
GUARDRAIL_REQUIRE_MEDICAL_FLOOR = True
GUARDRAIL_INCLUDE_REASONING_FLOOR = False
