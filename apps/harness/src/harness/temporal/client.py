"""Temporal client factory.

Centralises how the FastAPI app, the worker, and (later) the API gateway
connect to the Temporal frontend, using the env-configured address/namespace.
"""

from __future__ import annotations

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter

from harness.core.config import Settings, get_settings


async def get_temporal_client(settings: Settings | None = None) -> Client:
    """Connect to the Temporal frontend using the configured address/namespace.

    Uses Temporal's Pydantic data converter so the document workflow's Pydantic
    payloads (inputs, signal args, activity I/O) round-trip natively. The
    converter is a superset of the default JSON converter, so the existing
    dataclass-based ping workflow keeps working.
    """
    settings = settings or get_settings()
    return await Client.connect(
        settings.temporal.address,
        namespace=settings.temporal.namespace,
        data_converter=pydantic_data_converter,
    )
