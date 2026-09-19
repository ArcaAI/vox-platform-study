"""OpenTelemetry + structured-logging wiring for TTS — adapter over
``hope_obs`` (TASK-987).

Before this migration, TTS carried its own hand-rolled OTel setup and was the
fleet's HARDENED reference on two axes this module still guarantees, now by
delegating to the shared package instead of re-implementing it:

* **Never raises.** A service may expose telemetry but must never require a
  reachable observability backend to start or serve traffic —
  ``hope_obs.configure_observability`` guarantees this; see
  ``TestNeverRaises`` in ``tts/tests/test_otel_tracing_task636.py``.
* **The PHI hook is mandatory.** TTS receives clinical text on every
  synthesis request. ``hope_obs.tracing.instrument_fastapi`` passes
  ``phi_sanitization_hook`` to ``FastAPIInstrumentor`` UNCONDITIONALLY — there
  is no argument that switches it off, so there is nothing this module needs
  to wire. Pinned by ``TestPhiHookWiring``.

This module's own job, now that both guarantees live upstream, is narrower:
translate TTS's ``Settings`` (the ``TTS_``-prefixed env contract the dev
cluster actually sets) into the shared ``ObservabilityConfig``.

The WebSocket streaming endpoint (``api/endpoints/stream_ws.py``) stays
UNINSTRUMENTED — cross-service trace-context propagation over WebSocket is
separate, out-of-scope work; unchanged by this migration and still a
standing trace gap (see the TASK-987 lane-H report).
"""

from __future__ import annotations

import warnings
from dataclasses import replace
from typing import TYPE_CHECKING

from hope_obs import (
    ObservabilityConfig,
    configure_observability,
    get_logger,
    get_tracer,
    shutdown_observability,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fastapi import FastAPI

    from tts.core.config import Settings

__all__ = [
    "build_observability_config",
    "get_tracer",
    "setup_observability",
    "shutdown_observability",
]

_logger = get_logger(__name__)

#: TTS has never carried its own build/version file; the version string a
#: span's `service.version` attribute needs is a static literal here, the
#: same way the pre-migration module hardcoded `_TRACER_VERSION = "0.1.0"`.
_SERVICE_VERSION = "0.1.0"


def build_observability_config(settings: Settings) -> ObservabilityConfig:
    """Translate TTS's own ``Settings`` into the shared ``ObservabilityConfig``.

    ``ObservabilityConfig.from_env`` resolves the GENERIC ``OTEL_*`` names
    (TASK-987 R-2); TTS's ``Settings`` carries the ``TTS_``-prefixed ones the
    dev cluster actually sets (``TTS_OTEL_EXPORTER_ENDPOINT`` etc, via
    ``hope_settings_sources``). Settings values win whenever set, so an
    operator who has only ever set the ``TTS_`` names still gets tracing.

    ``TTS_OTEL_ENABLED`` is DEPRECATED — R-2 replaces it with "an endpoint is
    the only enable signal", there is no boolean — but it is still HONOURED
    for one release rather than silently dropped: `hope-v2-dev` sets it
    alongside the endpoint today, and if an operator ever sets it to
    ``false`` explicitly, tracing stays off even with an endpoint configured.
    A deprecation warning fires whenever the variable is set at all (true or
    false), so the operator has a path to removing it.
    """
    config = ObservabilityConfig.from_env("tts", service_version=_SERVICE_VERSION)

    # `or config.<field>` rather than a conditionally-built kwargs dict: each
    # TTS setting wins over whatever `from_env` resolved only when it is
    # actually set (non-empty) — an unset `TTS_` field must never blank out a
    # value `from_env` found on the generic `OTEL_*` names.
    #
    # `service_name` is the exception, and it must stay one: its default is the
    # non-empty `"tts"`, so `or` cannot tell "the operator chose tts" from "no
    # one said anything". It always won, and it silently discarded the
    # `OTEL_SERVICE_NAME=hope-tts` the dev Deployment sets — the live pod
    # reported `service.name=tts` in logs AND traces while the rest of the
    # fleet reported `hope-*`, which is what broke Grafana's trace->logs link
    # (it keys on Loki's `service_name` label, `hope-tts`). `model_fields_set`
    # is the same distinction this function already draws for `otel_enabled`
    # below: only an EXPLICITLY set `TTS_OTEL_SERVICE_NAME` overrides the
    # generic name the deployment chose.
    config = replace(
        config,
        otlp_endpoint=settings.otel_exporter_endpoint or config.otlp_endpoint,
        service_name=(
            settings.otel_service_name
            if "otel_service_name" in settings.model_fields_set
            else config.service_name
        ),
        service_namespace=settings.otel_service_namespace or config.service_namespace,
        deployment_environment=(
            settings.otel_deployment_environment or config.deployment_environment
        ),
        log_level=settings.log_level or config.log_level,
    )

    # `settings.otel_insecure` and `settings.otel_logs_enabled` are NOT read
    # here. `insecure` is now a derived property of the endpoint's scheme
    # (never a separate flag — R-2), and OTLP log export is deleted outright
    # (R-5). Both fields are now-unused config; see the lane-H report.
    if "otel_enabled" in settings.model_fields_set:
        warnings.warn(
            "TTS_OTEL_ENABLED is deprecated (TASK-987, removed in R4): "
            "an OTEL_EXPORTER_OTLP_ENDPOINT / TTS_OTEL_EXPORTER_ENDPOINT is "
            "now the only tracing enable signal.",
            DeprecationWarning,
            stacklevel=2,
        )
        _logger.warning(
            "tts.otel_enabled_flag_deprecated",
            otel_enabled=settings.otel_enabled,
        )
        if not settings.otel_enabled:
            config = replace(config, otlp_endpoint=None)

    return config


def setup_observability(app: FastAPI, settings: Settings) -> None:
    """Configure logging, request context, access logs and tracing.

    Call from ``create_app()``, before the app starts serving — logging (and
    the request-context/access-log middlewares) are installed unconditionally,
    tracing only when the resolved config carries an endpoint. Never raises.
    """
    configure_observability(app, build_observability_config(settings))
