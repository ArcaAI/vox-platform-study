"""Logging, request context and tracing for Guardrail, via ``hope_obs`` (TASK-987).

Guardrail — the platform's content-safety / PII / prompt-injection engine — is
the most compliance-sensitive service in the fleet: every request carries raw
clinical text on ``/api/guardrail/analyze`` and ``/api/medical/*``. Before
TASK-987 this module hand-rolled its own OTel setup (mirroring
``apps/text/src/text/core/observability.py``) and had NO request-id
middleware, NO access log, and NO ``merge_contextvars`` in its logging chain
(findings F-05, F-06, F-09 in
``docs/implementation/TASK-987-Python-Logging-And-Tracing-Standard/README.md``).
All of that is now ``hope_obs``'s job; this module narrows the two fields
guardrail's own settings disagree with the shared package's defaults on, and
keeps the legacy env contract alive for one more release.

**Two narrowings on top of ``ObservabilityConfig.from_env("guardrail")``:**

1. ``log_level`` — guardrail's root ``Settings`` carries
   ``env_prefix="GUARDRAIL_V2_"`` (``core/config.py``), so the variable an
   operator actually sets is ``GUARDRAIL_V2_LOG_LEVEL``. ``from_env`` derives
   ``<SVC>_LOG_LEVEL`` from the ``service_name`` ARGUMENT it was called with
   ("guardrail" → ``GUARDRAIL_LOG_LEVEL``), which nothing in this fleet sets.
   Reading it through ``settings.log_level`` instead — which pydantic already
   resolved from the correct prefixed variable — is the fix, exactly as R-1's
   own docstring for ``from_env`` prescribes.
2. ``otlp_endpoint`` — the SAME trap one layer down. TASK-987 lane D1 turned
   tracing on in ``hope-v2-dev`` by setting
   ``GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT`` (the name this service's OWN
   ``Settings.otel_exporter_endpoint`` field reads), not the fleet-wide
   ``OTEL_EXPORTER_OTLP_ENDPOINT`` name ``from_env`` looks for. Silently
   preferring only the generic name would leave the already-deployed manifest
   dark again — the exact F-02 shape. ``_resolve_otlp_endpoint`` reads both,
   generic first.

**The default-OFF and never-raises invariants this module's previous version
described are unchanged and are now ``hope_obs``'s guarantee, not this one's:**
tracing is off unless an endpoint resolves, and
``hope_obs.configure_observability`` never raises — a reachable collector is
never a boot- or request-path dependency.

**``GUARDRAIL_V2_OTEL_ENABLED`` — honoured, not read, for one more release.**
Under R-2 there is no enable BOOLEAN any more: endpoint presence alone decides.
But the flag is still live in the deployed manifest (D1 set it to ``true``
alongside the endpoint), and a manifest that instead sets it to a FALSY value
to intentionally keep tracing off must keep working rather than being silently
overridden the moment this service adopts the new contract. So the flag is
read as an explicit OFF-switch only: set and falsy forces ``otlp_endpoint`` to
``None`` regardless of what is otherwise configured, logged once as a
deprecation warning. It can no longer turn tracing ON by itself — only an
endpoint does that now.
"""

from __future__ import annotations

import os
from dataclasses import replace
from typing import TYPE_CHECKING

from hope_obs import (
    ObservabilityConfig,
    configure_observability,
    get_tracer,
    shutdown_observability,
)

from guardrail.core.logging import get_logger

if TYPE_CHECKING:
    from fastapi import FastAPI

    from guardrail.core.config import Settings

logger = get_logger(__name__)

#: The fleet-wide R-2 name, checked first.
_GENERIC_ENDPOINT_VAR = "OTEL_EXPORTER_OTLP_ENDPOINT"
#: What lane D1 actually set in `hope-v2-dev` — guardrail's own legacy name,
#: read by `Settings.otel_exporter_endpoint`. Migrating the manifest itself to
#: the generic name is lane D2's job, after this lane merges and is promoted.
_LEGACY_ENDPOINT_VAR = "GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT"
#: The retired master switch — honoured as an off-switch only, per R-2.
_LEGACY_ENABLED_VAR = "GUARDRAIL_V2_OTEL_ENABLED"

__all__ = [
    "build_observability_config",
    "get_tracer",
    "setup_observability",
    "shutdown_opentelemetry",
]


def _resolve_otlp_endpoint() -> str | None:
    """The endpoint, generic R-2 name first, guardrail's legacy name second."""
    return os.getenv(_GENERIC_ENDPOINT_VAR) or os.getenv(_LEGACY_ENDPOINT_VAR) or None


def build_observability_config(settings: Settings) -> ObservabilityConfig:
    """Resolve the one ``ObservabilityConfig`` guardrail hands to ``hope_obs``."""
    endpoint = _resolve_otlp_endpoint()

    legacy_enabled_raw = os.getenv(_LEGACY_ENABLED_VAR)
    if legacy_enabled_raw is not None:
        logger.warning(
            "guardrail.otel_enabled_flag.deprecated",
            variable=_LEGACY_ENABLED_VAR,
            detail=(
                "tracing now enables on an OTLP endpoint's presence alone "
                "(TASK-987 R-2); this flag is honoured as an explicit "
                "off-switch for one release only and will then be removed"
            ),
        )
        if not settings.otel_enabled:
            # Explicit false: an operator relying on the flag to keep tracing
            # off must not have it silently overridden by an endpoint that
            # happens to be configured beside it.
            endpoint = None

    base = ObservabilityConfig.from_env("guardrail")
    return replace(
        base,
        log_level=settings.log_level,
        otlp_endpoint=endpoint,
        # `service_name` from guardrail's OWN settings (TASK-987, found by the
        # verification lane). `Settings.otel_service_name` reads
        # GUARDRAIL_V2_OTEL_SERVICE_NAME, which `base/guardrail.yaml` sets to
        # `hope-guardrail`. Omitting it here silently renamed this service to
        # `guardrail` in every span and log line while the manifest still said
        # otherwise — and left that manifest variable read by nothing.
        # Only when the prefixed variable was EXPLICITLY set. The field carries
        # a real default (`"guardrail"`), so `or base.service_name` would never
        # fall through and would beat the canonical `OTEL_SERVICE_NAME` that
        # `from_env` already honoured — the F-22 shape again, one field over: a
        # default masking absence.
        service_name=(
            settings.otel_service_name
            if "otel_service_name" in settings.model_fields_set
            else base.service_name
        ),
    )


def setup_observability(app: FastAPI, settings: Settings) -> None:
    """Configure logging, request context and tracing for the app. Never raises."""
    configure_observability(app, build_observability_config(settings))


def shutdown_opentelemetry(app: FastAPI) -> None:
    """Flush spans and uninstrument, in the lifespan teardown. Never raises.

    Kept under its historical name — ``guardrail.main``'s lifespan imports it
    by this name, and TASK-987 does not require renaming every call site.
    """
    shutdown_observability(app)
