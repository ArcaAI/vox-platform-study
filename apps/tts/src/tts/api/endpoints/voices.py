"""Voice catalog endpoint — stable internal voice IDs and their providers."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(tags=["voices"])


@router.get("/voices")
async def list_voices(request: Request) -> dict[str, Any]:
    catalog = request.app.state.voice_catalog
    return {
        "voices": [
            {"id": v.id, "locale": v.locale, "providers": sorted(v.bindings.keys())}
            for v in catalog.list_voices()
        ]
    }
