"""STT's observability configuration — adapter over `hope_obs` (TASK-987).

The implementation (structured logging, the OTLP tracer, FastAPI/httpx
instrumentation, the PHI request hook) now lives entirely in `hope_obs`
(`packages/py-obs`); this module only resolves the ONE `ObservabilityConfig`
STT's `main.py`/`worker.py` hand it.

Two things this adapter does that `hope_obs.ObservabilityConfig.from_env`
cannot do on its own:

* Reads STT's *own* settings (`otel_service_name`, `log_level`) so the single
  `Settings` object stays the source of truth an operator already knows to
  check, instead of a second, silently-divergent env read.
* Honours the pre-TASK-987 `otel_enabled` / `otel_exporter_endpoint` pair for
  one more release (`docs/operations/deprecation-register.md`) when the R-2
  signal (`OTEL_EXPORTER_OTLP_ENDPOINT`) is absent. In `hope-v2-dev` today the
  endpoint already reaches STT both ways — via `hope-platform-config`
  (`OTEL_EXPORTER_OTLP_ENDPOINT`, which `from_env` reads directly) and via
  `hope-stt-config` (`OTEL_ENABLED` / `OTEL_EXPORTER_ENDPOINT`, which it does
  not) — so this fallback is a safety net for a manifest that has not
  migrated yet, not the primary signal.
"""

from __future__ import annotations

import warnings
from dataclasses import replace

from hope_obs import ObservabilityConfig
from hope_obs import get_tracer as _get_tracer
from opentelemetry import trace

from stt.core.config.settings import Settings

__all__ = ["build_observability_config", "get_tracer"]


def build_observability_config(settings: Settings) -> ObservabilityConfig:
    """Resolve the one `ObservabilityConfig` for this process (API or worker).

    Callers hand the result straight to `hope_obs.configure_observability` /
    `hope_obs.configure_worker_observability` — the worker path suffixes the
    service name itself (`hope_obs.runtime.worker_service_name`), so this
    function returns the API's identity either way.
    """
    config = ObservabilityConfig.from_env("stt", service_version=settings.app_version)
    config = replace(config, service_name=settings.otel_service_name, log_level=settings.log_level)

    if not config.tracing_enabled and settings.otel_enabled:
        warnings.warn(
            "STT's OTEL_ENABLED / OTEL_EXPORTER_ENDPOINT pair is deprecated "
            "(TASK-987 R-2) and honoured for one more release only; set "
            "OTEL_EXPORTER_OTLP_ENDPOINT instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        config = replace(config, otlp_endpoint=settings.otel_exporter_endpoint)

    return config


def get_tracer(name: str = "stt") -> trace.Tracer:
    """Re-export of `hope_obs.get_tracer` — kept for this module's one prior caller."""
    return _get_tracer(name)
