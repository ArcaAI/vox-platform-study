"""What a cache needs to take part in model residency control (TASK-1005).

Handing a :class:`CacheResidency` to ``ModelCache(residency=…)`` makes the cache:

* MEASURE each load's footprint on its :class:`~.devices.Device` (the usage delta
  around the factory call; unknown when anything overlapped it);
* emit the per-model residency metrics (``model_resident``,
  ``model_resident_bytes``, ``model_load_seconds``, ``model_evictions_total``) —
  from EVERY process that constructs the cache, so the stt Dramatiq worker is
  visible even though it serves no agent API;
* optionally gate loads behind an admission check (:class:`AdmissionPolicy`),
  which is OFF by default so wiring a cache changes nothing live until the
  controller turns it on.

A cache without one behaves exactly as it did before TASK-1005.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from .devices import Device
from .metrics import ResidencyMetricsSink


def _identity(key: str) -> str:
    return key


@dataclass(frozen=True)
class AdmissionPolicy:
    """Load admission against measured free memory (plan §5.3 step 7, OD-2).

    When enabled, a load that would leave less than ``headroom_percent`` of the
    device free first evicts idle, unpinned models (reason ``pressure``); if
    nothing is evictable it waits up to ``max_wait_ms`` for room and then raises
    ``AdmissionRejected`` (services answer 503 + ``Retry-After``). The incoming
    model's footprint is the one MEASURED at its previous load in this process —
    unknown counts as 0, so a never-seen model is admitted whenever the headroom
    itself is intact. A device that cannot report its memory admits everything.
    """

    enabled: bool = False
    headroom_percent: float = 15.0
    max_wait_ms: int = 5000
    poll_interval_ms: int = 100


@dataclass
class CacheResidency:
    """The residency wiring of one cache. ``admission`` may be swapped at runtime."""

    service: str
    device: Device
    metrics: ResidencyMetricsSink | None = None
    admission: AdmissionPolicy = field(default_factory=AdmissionPolicy)
    #: cache key → the model label on metrics (keys may carry more than the model,
    #: e.g. nlp's `name\\x00path` slots).
    model_ref: Callable[[str], str] = _identity
