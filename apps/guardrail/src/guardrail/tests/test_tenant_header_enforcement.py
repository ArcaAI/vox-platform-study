"""``X-Tenant-Id`` is MANDATORY on every tenant-scoped guardrail request.

Owner directive (2026-08-16, `.claude/rules/00-project-context.md`): guardrail
decisions must be ATTRIBUTABLE. An absent header is a defect in the CALLER, not
something the callee papers over — and papering over is exactly what guardrail did:
six read sites were ``request.headers.get("X-Tenant-Id")`` with no None-check, so an
absent header silently resolved the SYSTEM floor. Because a tenant may only TIGHTEN
relative to SYSTEM, that silently downgraded a strict tenant's safety posture with no
error anywhere.

Guardrail already owned the vocabulary for the fix (``TENANTLESS_PREFIX``,
``is_tenantless_marker``) and never gated on it. This suite gates on it, matching
``apps/nlp`` and ``apps/text``: **428** (a missing request PRECONDITION, the same
status the gateway's ``RequiresIfMatch`` uses) for an absent header, and a DECLARED
``tenantless:<reason>`` marker accepted as the legitimate exception.

428 fires BEFORE any model selection or engine call, so a mis-attributed request never
resolves a credential from the wrong tier.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from guardrail.core.dependencies import (
    acquire_groundedness_verifier,
    get_resolved_guardian_provider,
    get_safety_analyzer,
)

TENANT = "11111111-1111-1111-1111-111111111111"
TENANTLESS = "tenantless:job-queue"


def _request(headers: dict[str, str]) -> Any:
    request = MagicMock()
    request.headers = headers
    return request


# ── the three dependency-level read sites ──────────────────────────────────


@pytest.mark.asyncio
async def test_safety_analyzer_refuses_an_absent_tenant_header() -> None:
    with pytest.raises(HTTPException) as exc:
        await get_safety_analyzer(_request({}))

    assert exc.value.status_code == 428


@pytest.mark.asyncio
async def test_safety_analyzer_refuses_a_blank_tenant_header() -> None:
    """Whitespace is absence wearing a costume."""
    with pytest.raises(HTTPException) as exc:
        await get_safety_analyzer(_request({"X-Tenant-Id": "   "}))

    assert exc.value.status_code == 428


@pytest.mark.asyncio
async def test_guardian_resolver_refuses_an_absent_tenant_header() -> None:
    with pytest.raises(HTTPException) as exc:
        await get_resolved_guardian_provider(_request({}))

    assert exc.value.status_code == 428


@pytest.mark.asyncio
async def test_groundedness_refuses_an_absent_tenant_header() -> None:
    request = _request({})
    request.app.state.groundedness_verifier = object()

    with pytest.raises(HTTPException) as exc:
        async with acquire_groundedness_verifier(request):
            pass

    assert exc.value.status_code == 428


# ── the declared exception still works ─────────────────────────────────────


@pytest.mark.asyncio
async def test_declared_tenantless_marker_is_accepted() -> None:
    """Genuinely tenant-less internal work DECLARES itself and is let through."""
    request = _request({"X-Tenant-Id": TENANTLESS})
    # No resolver wired — the same fail-closed path the retired
    # `db_config_enabled=False` flag used to reach (TASK-799 lane D).
    request.app.state.tenant_config_resolver = None

    # The marker passes the 428 gate; the call then fails CLOSED on SELECTION
    # (503) because guardrail names no model in code — which is the point: the
    # declared exception buys attribution, never a hardcoded fallback.
    with pytest.raises(HTTPException) as exc:
        await get_safety_analyzer(request)

    assert exc.value.status_code == 503


# ── the async job plane carries its tenant instead of dropping it ───────────


@pytest.mark.asyncio
async def test_async_analyze_refuses_an_absent_tenant_header() -> None:
    from guardrail.api.endpoints.guardrails import (
        GuardrailRequest,
        analyze_content_async,
    )

    with pytest.raises(HTTPException) as exc:
        await analyze_content_async(
            GuardrailRequest(text="x"),
            _request({}),
            job_processor=AsyncMock(),
        )

    assert exc.value.status_code == 428


@pytest.mark.asyncio
async def test_async_analyze_records_the_submitting_tenant_on_the_job() -> None:
    """A job that outlives its request must still say whose decision it was."""
    from guardrail.api.endpoints.guardrails import (
        GuardrailRequest,
        analyze_content_async,
    )

    job_processor = AsyncMock()
    job_processor.submit_job = AsyncMock(return_value="job-1")

    await analyze_content_async(
        GuardrailRequest(text="x"),
        _request({"X-Tenant-Id": TENANT}),
        job_processor=job_processor,
    )

    assert job_processor.submit_job.await_args.kwargs["tenant_id"] == TENANT


@pytest.mark.asyncio
async def test_job_processor_resolves_the_model_for_the_jobs_tenant() -> None:
    """The stored tenant reaches model selection — not ``None``."""
    import json

    from guardrail.services.job_processor import JobProcessor

    seen: list[str | None] = []

    class _Provider:
        async def analyze_content(self, text: str, guardrail_type: str) -> dict[str, Any]:
            return {"safe": True, "issues": [], "confidence": 1.0}

    class _Resolver:
        def __call__(self, tenant_id: str | None) -> Any:
            seen.append(tenant_id)
            from contextlib import nullcontext

            return nullcontext(_Provider())

    redis = AsyncMock()
    redis.hgetall = AsyncMock(
        return_value={
            "job_id": "job-1",
            "text": "x",
            "guardrail_type": "content_safety",
            "status": "pending",
            "tenant_id": TENANT,
        }
    )
    processor = JobProcessor(
        redis=redis,
        analyzer_resolver=_Resolver(),  # type: ignore[arg-type]
        max_concurrent=1,
    )

    await processor._process_job("job-1")

    assert seen == [TENANT]
    assert json.loads(redis.hset.await_args.kwargs["mapping"]["result"])["safe"] is True
