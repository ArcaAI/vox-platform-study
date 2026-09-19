"""Harness's ``ObservabilityConfig`` mapping onto ``hope_obs`` (TASK-987).

The tracing/logging IMPLEMENTATION — the ``TracerProvider``, the PHI
sanitization hook, the structlog/stdlib bridge — lives entirely in
``hope_obs`` now (R-1..R-8). This module's only remaining job is translating
harness's own ``Settings`` into an ``hope_obs.ObservabilityConfig``:

* ``ObservabilityConfig.from_env`` reads bare ``os.getenv`` values. Harness's
  ``Settings`` resolve through ``hope_settings_sources`` (init > host env >
  Vault Agent ``secrets_dir`` > ``.env.<NODE_ENV>`` > default,
  ``core/config.py``), so a value that only ever reached the process through
  ``.env.dev`` would be INVISIBLE to a bare ``os.getenv`` call. Every
  OTel-shaped field is therefore taken from ``settings`` instead;
  ``from_env`` supplies only what ``Settings`` does not carry at all
  (an ``OTEL_SERVICE_NAME`` override and ``OTEL_TRACES_SAMPLER_ARG``).
* ``HARNESS_OTEL_ENABLED`` is deprecated — R-2's contract has no
  ``*_OTEL_ENABLED`` boolean; ``HARNESS_OTEL_EXPORTER_ENDPOINT`` presence
  alone is the enable signal. It is honoured for one more release as a
  fail-closed VETO: a manifest that sets it to ``false`` to keep tracing off
  despite an endpoint on a shared config map (``hope-harness-config``, which
  ``hope-harness-worker`` also consumes) must keep working until the manifest
  is updated (``docs/operations/deprecation-register.md``). Setting it to
  ``true`` is a no-op under R-2 (the endpoint alone already enables tracing),
  and either spelling being present at all logs one deprecation line.

Left DELIBERATELY unchanged by this module, per the TASK-987 lane G brief:
``temporal/client.py``'s ``_tracing_interceptors`` still gates the Temporal
``TracingInterceptor`` on ``Settings.otel_tracing_enabled`` — the pre-R-2 AND
of ``otel_enabled`` and ``otel_exporter_endpoint``. In the live `dev` overlay
both conditions already agree (TASK-987 lane D1 set both), so this is a
transitional divergence between the FastAPI/worker tracer (R-2 gated) and the
Temporal interceptor (old AND-gated), not a regression. Migrating
``client.py`` to the same R-2 gate is out of this lane's scope — determinism
and replay compatibility live in Temporal-adjacent code this ticket does not
touch, and the brief was explicit: "keep `TracingInterceptor` wiring in
`temporal/client.py` exactly as it is".
"""

from __future__ import annotations

import os
from dataclasses import replace
from typing import TYPE_CHECKING

from hope_obs import ObservabilityConfig, get_logger

if TYPE_CHECKING:
    from harness.core.config import Settings

_SERVICE_VERSION = "0.1.0"

#: The deprecated flag this module still honours, for one release, as a veto.
OTEL_ENABLED_ENV_VAR = "HARNESS_OTEL_ENABLED"


def build_observability_config(settings: Settings) -> ObservabilityConfig:
    """Resolve harness's ``ObservabilityConfig`` from ``Settings``.

    Endpoint presence (``settings.otel_exporter_endpoint``) is the enable
    signal (R-2). The deprecated ``HARNESS_OTEL_ENABLED=false`` is honoured
    as a veto — see the module docstring — so a manifest that still sets it
    keeps its current, deliberately-off behaviour until it migrates.
    """
    base = ObservabilityConfig.from_env("harness", service_version=_SERVICE_VERSION)
    config = replace(
        base,
        # Only an EXPLICIT `HARNESS_OTEL_SERVICE_NAME` overrides the name the
        # deployment chose. This used to be unconditional, so the generic
        # `OTEL_SERVICE_NAME` that `from_env` resolves — the variable every
        # other service honours, and the one a Deployment sets — could never
        # win against the non-empty `"harness"` default. In the dev cluster
        # harness and harness-worker were the only workloads reporting a bare
        # `service.name` in logs and traces while the fleet reported `hope-*`,
        # which breaks Grafana's trace->logs link: it keys on Loki's
        # `service_name` label, `hope-harness`.
        service_name=(
            settings.otel_service_name
            if "otel_service_name" in settings.model_fields_set
            else base.service_name
        ),
        service_namespace=settings.otel_service_namespace,
        deployment_environment=settings.otel_deployment_environment,
        # `or base.otlp_endpoint`, never `or None` (TASK-987 F-22). R-2 makes the
        # canonical `OTEL_EXPORTER_OTLP_ENDPOINT` the enable signal, and
        # `from_env` has already resolved it. Overwriting with `None` when
        # HARNESS_OTEL_EXPORTER_ENDPOINT happens to be unset would discard it and
        # take the app AND the Temporal worker dark — which is exactly why lane D2
        # could not retire that variable from the dev overlay.
        otlp_endpoint=settings.otel_exporter_endpoint or base.otlp_endpoint,
        log_level=settings.log_level,
    )

    if otel_enabled_flag_is_set() and not settings.otel_enabled and config.otlp_endpoint:
        config = replace(config, otlp_endpoint=None)

    return config


def otel_enabled_flag_is_set() -> bool:
    """Whether the deprecated ``HARNESS_OTEL_ENABLED`` var is set at all (any value)."""
    return os.getenv(OTEL_ENABLED_ENV_VAR) is not None


def warn_if_otel_enabled_flag_set() -> None:
    """Emit one deprecation line when the retired flag is still set. Never raises.

    Call AFTER ``configure_observability``/``configure_worker_observability``
    so the line itself is structured JSON through the chain it just installed,
    rather than an unconfigured stdlib default.
    """
    if not otel_enabled_flag_is_set():
        return
    get_logger(__name__).warning(
        "harness.observability.otel_enabled_deprecated",
        variable=OTEL_ENABLED_ENV_VAR,
        detail=(
            "HARNESS_OTEL_EXPORTER_ENDPOINT presence alone now enables tracing "
            "(TASK-987 R-2); HARNESS_OTEL_ENABLED will be removed in a future release."
        ),
    )
