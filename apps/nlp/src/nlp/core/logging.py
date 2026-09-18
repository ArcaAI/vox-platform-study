"""NLP's logging entry point — a thin shim over ``hope_obs`` (TASK-987 R-3).

Finding F-03: this module used to define ``JsonFormatter``, which read
``otelTraceID``/``otelSpanID``/``otelTraceFlags`` off the record — and never
installed it. The single console handler was given a plain
``logging.Formatter``, so Loki stored unparsed text for this service and the
trace-correlation plumbing had never executed. ``JsonFormatter`` and
``LoggingConfig`` are gone; NLP now configures logging exactly the way the
other five services do, through ``hope_obs``.

Kept as a shim (not inlined at every call site) because dozens of modules do
``from nlp.core.logging import get_logger`` — rewriting every one would balloon
this diff without changing behaviour. New code should import
``hope_obs.get_logger`` directly. Registered by the orchestrator in
``docs/operations/deprecation-register.md``.
"""

from __future__ import annotations

from dataclasses import replace

from hope_obs import ObservabilityConfig, configure_logging, get_logger

from nlp.core.config import settings

__all__ = ["build_observability_config", "get_logger", "setup_logging"]


def build_observability_config() -> ObservabilityConfig:
    """The one ``ObservabilityConfig`` NLP resolves and hands everywhere.

    ``ObservabilityConfig.from_env("nlp", ...)`` already reproduces NLP's exact
    historic log-level precedence — ``NLP_LOG_LEVEL`` over the bare
    ``LOG_LEVEL``, name-or-number both accepted (see
    ``hope_obs.config._service_log_level_var`` /
    ``hope_obs.logging.resolve_log_level``) — so nothing extra is needed to
    preserve that behaviour.

    ``otlp_endpoint`` is widened to also accept ``NLP_OTLP_ENDPOINT``:
    ``NLPServiceConfig.otlp_endpoint`` has always accepted that alias
    (`core/config.py`), and `hope_obs` only reads the OTel-standard
    ``OTEL_EXPORTER_OTLP_ENDPOINT``. Falling back to the base value keeps a
    deployment that only ever set the standard name working unchanged.
    """
    base = ObservabilityConfig.from_env("nlp", service_version=settings.service.version)
    return replace(base, otlp_endpoint=settings.service.otlp_endpoint or base.otlp_endpoint)


def setup_logging(service_name: str = "nlp") -> None:
    """Install the ``hope_obs`` JSON logging chain. Idempotent (see hope_obs).

    Kept as a zero-argument-friendly entry point for ``nlp.main``'s
    import-time call; ``service_name`` is accepted for backward compatibility
    with existing callers (e.g. `tests/test_task883_logging_retirement.py`)
    but the resolved ``ObservabilityConfig.service_name`` is always ``"nlp"``
    (or ``OTEL_SERVICE_NAME`` when the operator overrides it) — the same
    identity every other reader of `NLPServiceConfig` uses.
    """
    configure_logging(build_observability_config())
