"""``GET /v1/models`` — what this replica can answer for NOW (C-3).

Lists resident engines and the pool's pins (a pin before its engine is resident shows
``resident: false``). Tenant-scoped like every ``/v1/*`` route: a resident engine owned by
ANOTHER tenant (a BYO row) is never listed — its slug is that tenant's business. SYSTEM rows
and pins (always SYSTEM) are listed for everyone.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from hope_vllm.engine.pool import SYSTEM_TENANT_ID, EnginePool

router = APIRouter(tags=["openai"])


@router.get("/v1/models")
async def list_models(request: Request) -> dict[str, Any]:
    tenant_id: str = request.state.tenant_id
    pool: EnginePool = request.app.state.engine_pool
    entries: dict[str, dict[str, Any]] = {}
    for spec, pinned in pool.resident_specs():
        if spec.tenant_id not in (tenant_id, SYSTEM_TENANT_ID):
            continue
        entry = entries.setdefault(spec.slug, _entry(spec.slug, spec.kind, pinned=pinned))
        entry["x_hope"]["resident"] = True
        entry["x_hope"]["pinned"] = entry["x_hope"]["pinned"] or pinned
    for slug, kind in pool.pending_pins():
        entries.setdefault(slug, _entry(slug, kind, pinned=True, resident=False))
    return {"object": "list", "data": list(entries.values())}


def _entry(slug: str, kind: str, *, pinned: bool, resident: bool = True) -> dict[str, Any]:
    return {
        "id": slug,
        "object": "model",
        "owned_by": "hope",
        "x_hope": {"kind": kind, "resident": resident, "pinned": pinned},
    }
