"""`GET /api/v1/guardrail/policy-version` — the caller tenant's screening policy version.

TASK-1047 FC-3: the gateway's governed-prompt registry stamps every authoring-time
verdict with this value and treats a piece screened under another version as not
governed. The same value keys the window-verdict cache (FC-7). Definition and
composition: `core/policy_version.py`.

Tenant-scoped (428 without `X-Tenant-Id`), behind the `X-Service-Token`
middleware like every other non-health route, and 503 when the tenant's policy
cannot be read — never a guessed version.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from guardrail.core.dependencies import require_tenant_id
from guardrail.core.logging import get_logger
from guardrail.core.policy_version import PolicyVersionUnavailableError, resolve_policy_version

logger = get_logger(__name__)

router = APIRouter()


@router.get("/guardrail/policy-version")
async def get_policy_version(http_request: Request) -> dict[str, Any]:
    """`{ "policyVersion": "<sha256 hex>" }` for the `X-Tenant-Id` caller."""
    tenant_id = require_tenant_id(http_request)
    try:
        version = await resolve_policy_version(http_request.app.state, tenant_id)
    except PolicyVersionUnavailableError as exc:
        logger.warning("guardrail.policy_version.unavailable", tenant_id=tenant_id)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"policyVersion": version}
