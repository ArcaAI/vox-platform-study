"""FastAPI dependency accessors backed by app.state."""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from fastapi import Request

if TYPE_CHECKING:
    from tts.core.config import Settings


def get_settings(request: Request) -> Settings:
    """Retrieve settings from app.state (set in create_app)."""
    return cast("Settings", request.app.state.settings)
