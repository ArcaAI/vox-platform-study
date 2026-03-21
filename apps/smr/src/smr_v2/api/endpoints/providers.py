"""Provider listing endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from smr_v2.core.dependencies import get_provider_registry
from smr_v2.models.provider import ProviderInfo
from smr_v2.providers.base import ProviderRegistry

router = APIRouter(tags=["providers"])


@router.get("/providers", response_model=list[ProviderInfo])
async def list_providers(
    registry: ProviderRegistry = Depends(get_provider_registry),
) -> list[dict]:
    results = []
    for name in registry.list_providers():
        provider = registry.get(name)
        info = await provider.get_info()
        results.append(info.model_dump())
    return results
