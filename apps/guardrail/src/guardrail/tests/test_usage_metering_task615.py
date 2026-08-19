"""Guardrail's own token spend stops being invisible.

``GuardrailCallStats`` was computed for every LLM call and then **thrown away**:
the endpoint never read ``result["stats"]``, so guardrail — a service that runs
an LLM on every single generation the platform serves — reported zero cost to
anyone. Guardrail is also a peer service with no gateway in front of it, so the
ONLY route its usage has to the billing plane is riding back on the SMR response
that triggered it.

Metered in full, never quota-blocked, never invoiced to a tenant (D16): a safety
check the platform mandates belongs in per-encounter margin, not on a bill.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from guardrail.services.external_text_client import TextJudgeClient


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    async def post(self, url: str, **_kwargs: Any) -> _FakeResponse:
        return _FakeResponse(self.payload)


def _judge_client(payload: dict[str, Any]) -> TextJudgeClient:
    """The judge is a DELEGATION since TASK-735 Phase 2b — the metering guarantee
    is unchanged: guardrail's spend still rides back on its own verdict, because
    guardrail is still the peer service with no gateway in front of it."""
    return TextJudgeClient(
        base_url="http://text:8862",
        http_client=_FakeClient(payload),
        service_token="tok",
        provider="lm-studio",
        model="guardian-1",
        tenant_id="11111111-1111-1111-1111-111111111111",
    )


_VALID_JSON = (
    '{"is_medical": true, "confidence": 0.95, "context_type": "clinical", "reasoning": "note"}'
)


def _judge_body(usage: dict[str, Any] | None = None) -> dict[str, Any]:
    """One `text` judge response. `usage` is spelled the way `text`'s
    `GenerationStats` spells it (`prompt_tokens` / `completion_tokens`)."""
    body: dict[str, Any] = {
        "content": _VALID_JSON,
        "provider": "lm-studio",
        "model": "guardian-1",
        "latency_ms": 12,
        "finish_reason": "stop",
    }
    if usage is not None:
        body["stats"] = {"stop_reason": "stop", **usage}
    return body


# ---------------------------------------------------------------------------
# 1. The endpoint threw the stats away
#
# (The Ollama-guardian arm of this suite went with the engine in TASK-736, and the
# OpenAI-compat arm with TASK-735 Phase 2b. The guarantee they carried — a stats
# problem must never fail a safety check — is engine-independent and now lives on
# the delegating client, whose stats mapping is null-safe by contract.)
# ---------------------------------------------------------------------------


def _validation_result(prompt_tokens: int = 100, predicted: int = 5) -> dict[str, Any]:
    return {
        "is_medical": True,
        "confidence": 0.9,
        "context_type": "clinical",
        "reasoning": "why",
        "stats": {
            "provider": "lm-studio",
            "model": "granite-guardian",
            "prompt_tokens": prompt_tokens,
            "predicted_tokens": predicted,
            "total_tokens": prompt_tokens + predicted,
            "total_ms": 42,
            "stop_reason": "stop",
        },
    }


@pytest.mark.asyncio
async def test_validate_endpoint_surfaces_stats() -> None:
    from guardrail.api.endpoints.medical import (
        MedicalValidationRequest,
        validate_medical_context,
    )

    guardian = AsyncMock()
    guardian.validate_medical_context = AsyncMock(return_value=_validation_result())

    response = await validate_medical_context(
        MedicalValidationRequest(text="chest pain", request_id="req-1"),
        settings=MagicMock(),
        guardian_provider=guardian,
    )

    assert response.stats is not None, "guardrail's token spend must leave the service"
    assert response.stats["prompt_tokens"] == 100
    assert response.stats["predicted_tokens"] == 5
    assert response.stats["provider"] == "lm-studio"


@pytest.mark.asyncio
async def test_batch_endpoint_surfaces_stats_per_text() -> None:
    from guardrail.api.endpoints.medical import (
        BatchMedicalValidationRequest,
        validate_batch_medical_context,
    )

    guardian = AsyncMock()
    guardian.batch_validate = AsyncMock(
        return_value=[_validation_result(10, 1), _validation_result(20, 2)]
    )

    responses = await validate_batch_medical_context(
        BatchMedicalValidationRequest(texts=["a", "b"], request_id="batch-1"),
        settings=MagicMock(),
        guardian_provider=guardian,
    )

    assert [r.stats["prompt_tokens"] for r in responses] == [10, 20]


@pytest.mark.asyncio
async def test_failed_validation_reports_no_stats_rather_than_zeros() -> None:
    """A validation that never reached a model spent nothing, and it also rendered no
    verdict — so there is no 200 body to carry stats at all.

    This used to assert a 200 with ``error`` set and ``stats=None``. That 200 was the
    fail-open (``is_medical=True  # Fail open``); the honest answer is now a 503, and the
    "never report zero tokens for a call that never happened" guarantee survives as
    "report no body at all". The positive half of the guarantee — a REAL call always
    carries its stats — is covered by the tests above.
    """
    from fastapi import HTTPException

    from guardrail.api.endpoints.medical import (
        MedicalValidationRequest,
        validate_medical_context,
    )

    guardian = AsyncMock()
    guardian.validate_medical_context = AsyncMock(side_effect=RuntimeError("engine down"))

    with pytest.raises(HTTPException) as exc:
        await validate_medical_context(
            MedicalValidationRequest(text="x"),
            settings=MagicMock(),
            guardian_provider=guardian,
        )

    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_judge_path_stats_reach_the_endpoint_shape() -> None:
    """End-to-end over the delegated judge: `text` response → verdict → DTO."""
    from guardrail.api.endpoints.medical import (
        MedicalValidationRequest,
        validate_medical_context,
    )

    provider = _judge_client(
        _judge_body({"prompt_tokens": 77, "completion_tokens": 9, "total_tokens": 86})
    )

    response = await validate_medical_context(
        MedicalValidationRequest(text="patient reports fever"),
        settings=MagicMock(),
        guardian_provider=provider,
    )

    assert response.stats["prompt_tokens"] == 77
    assert response.stats["predicted_tokens"] == 9


# ---------------------------------------------------------------------------
# 2. Prometheus — bounded labels, NEVER a tenant label
# ---------------------------------------------------------------------------


def test_guardrail_token_metrics_are_bounded_and_tenant_free() -> None:
    from guardrail.core.metrics import GUARDRAIL_REQUESTS_TOTAL, GUARDRAIL_TOKENS_TOTAL

    assert set(GUARDRAIL_REQUESTS_TOTAL._labelnames) == {"provider", "model", "status"}
    # Per-tenant analytics come from Postgres. A tenant label here would make
    # cardinality grow with the customer list and put tenant identity in a
    # scrape target that has no access controls (D7/D16).
    assert set(GUARDRAIL_TOKENS_TOTAL._labelnames) == {"provider", "model", "direction"}


def test_record_guardrail_call_counts_both_directions() -> None:
    from guardrail.core.metrics import (
        GUARDRAIL_REQUESTS_TOTAL,
        GUARDRAIL_TOKENS_TOTAL,
        record_guardrail_call,
    )

    def _read(direction: str) -> float:
        return GUARDRAIL_TOKENS_TOTAL.labels(
            provider="lm-studio", model="granite-guardian", direction=direction
        )._value.get()

    before_in, before_out = _read("input"), _read("output")
    before_req = GUARDRAIL_REQUESTS_TOTAL.labels(
        provider="lm-studio", model="granite-guardian", status="success"
    )._value.get()

    record_guardrail_call(
        provider="lm-studio",
        model="granite-guardian",
        status="success",
        prompt_tokens=30,
        completion_tokens=4,
    )

    assert _read("input") == before_in + 30
    assert _read("output") == before_out + 4
    assert (
        GUARDRAIL_REQUESTS_TOTAL.labels(
            provider="lm-studio", model="granite-guardian", status="success"
        )._value.get()
        == before_req + 1
    )


@pytest.mark.asyncio
async def test_judge_call_increments_the_token_counter() -> None:
    from guardrail.core.metrics import GUARDRAIL_TOKENS_TOTAL

    provider = _judge_client(_judge_body({"prompt_tokens": 50, "completion_tokens": 6}))
    model = provider.model

    def _read(direction: str) -> float:
        return GUARDRAIL_TOKENS_TOTAL.labels(
            provider="lm-studio", model=model, direction=direction
        )._value.get()

    before_in, before_out = _read("input"), _read("output")

    await provider.validate_medical_context("patient reports fever")

    assert _read("input") == before_in + 50
    assert _read("output") == before_out + 6


def test_record_guardrail_call_never_raises_on_odd_input() -> None:
    """Telemetry must never take down a safety check."""
    from guardrail.core.metrics import record_guardrail_call

    record_guardrail_call(
        provider="", model=None, status="error", prompt_tokens=None, completion_tokens=-3
    )
