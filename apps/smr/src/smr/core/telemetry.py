"""Compatibility shim — re-exports from observability.py.

All OTel setup logic has moved to ``smr.core.observability``.
This file preserves backward-compatible imports for existing code
that does ``from smr.core.telemetry import get_tracer`` or
``from smr.core.telemetry import setup_telemetry``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from smr.core.observability import get_tracer, setup_opentelemetry

if TYPE_CHECKING:
    from fastapi import FastAPI
    from opentelemetry.sdk.trace import TracerProvider

__all__ = ["get_tracer", "setup_telemetry", "setup_opentelemetry"]


def setup_telemetry(
    app: FastAPI,
    *,
    endpoint: str = "http://localhost:4317",
    service_name: str = "smr",
    service_namespace: str = "hope",
    deployment_environment: str = "production",
    insecure: bool = True,
) -> TracerProvider:
    """Legacy wrapper — delegates to setup_opentelemetry.

    Returns the TracerProvider for backward compatibility.
    """
    setup_opentelemetry(
        app,
        endpoint=endpoint,
        service_name=service_name,
        service_namespace=service_namespace,
        deployment_environment=deployment_environment,
        insecure=insecure,
        logs_enabled=False,
    )
    return cast("TracerProvider", app.state.tracer_provider)
