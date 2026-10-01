"""How a denoise engine that could not run is reported (TASK-1030, owner decision OD-2).

An engine that is not ready never breaks the ASR task: the session or batch job
transcribes WITHOUT denoise. That is only acceptable if it is never silent, so every
degrade goes through ``report_denoise_degraded`` — one WARNING plus one
``stt_denoise_degraded_total{engine,reason}`` increment. A streaming session also
publishes a ``denoise_degraded`` status frame (``ResultPublisher``).

Deliberately import-free of the denoisers themselves, so both denoisers and the
selection module can depend on it without a cycle.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

from stt.core.metrics import STT_DENOISE_DEGRADED_TOTAL

logger = logging.getLogger(__name__)

DegradeReason = Literal[
    "package_missing",  # the engine's Python package is not installed in this image
    "weights_unavailable",  # DeepFilterNet3: no bound weights dir, or it lacks the checkpoint
    "init_failed",  # the package is present but the engine/checkpoint failed to load
    "enhance_failed",  # the engine raised while processing audio
    "unknown_engine",  # the bound row's library names no engine this runtime runs
]
REASONS: tuple[str, ...] = (
    "package_missing",
    "weights_unavailable",
    "init_failed",
    "enhance_failed",
    "unknown_engine",
)


@dataclass(frozen=True)
class DenoiseDegraded:
    """Why the selected engine is not running for this session/job."""

    engine: str
    reason: DegradeReason
    detail: str = ""


def report_denoise_degraded(
    engine: str,
    reason: DegradeReason,
    detail: str = "",
    *,
    session_id: str | None = None,
    job_id: str | None = None,
) -> DenoiseDegraded:
    """Log + count one degrade, and return it for the caller to publish or keep."""
    logger.warning(
        "Denoise engine '%s' unavailable (%s): %s — continuing WITHOUT denoise",
        engine,
        reason,
        detail or "no detail",
        extra={
            "denoise_engine": engine,
            "denoise_reason": reason,
            "session_id": session_id,
            "job_id": job_id,
        },
    )
    try:
        STT_DENOISE_DEGRADED_TOTAL.labels(engine=engine, reason=reason).inc()
    except Exception:  # noqa: BLE001 — metrics must never break the audio path
        pass
    return DenoiseDegraded(engine=engine, reason=reason, detail=detail)
