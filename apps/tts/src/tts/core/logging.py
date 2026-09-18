"""Structured logging for TTS — thin re-export shim over ``hope_obs`` (TASK-987).

The real implementation (structlog + stdlib bridge, JSON on stdout,
``traceId``/``spanId`` stamping) now lives in ``hope_obs.logging``. This
module stays as a ONE-RELEASE migration aid because seven modules across
``tts.providers``, ``tts.api.middleware`` and ``tts.routing`` import
``get_logger`` from this exact path; new code should import
``from hope_obs import get_logger`` directly.

``setup_logging`` is superseded by ``hope_obs.configure_observability``,
which ``tts.core.observability.setup_observability`` calls from
``create_app()``. It is kept here, calling straight into
``hope_obs.configure_logging``, only so nothing that still imports it breaks.
"""

from __future__ import annotations

from hope_obs import ObservabilityConfig, configure_logging, get_logger

__all__ = ["get_logger", "setup_logging"]


def setup_logging(log_level: str = "info") -> None:
    """Configure structlog + stdlib logging via ``hope_obs``. Idempotent."""
    configure_logging(ObservabilityConfig(service_name="tts", log_level=log_level))
