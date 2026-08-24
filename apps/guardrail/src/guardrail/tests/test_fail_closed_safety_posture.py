"""The safety gate must NEVER answer "safe" for a verdict it could not compute.

Product brief §1 item 4: *"Guardrails: PII, safety, medical validation) fail-closed
on generation"*. Before this suite, every engine path in ``apps/guardrail`` did the
exact inverse — an LLM timeout returned ``{"safe": True, "issues": ["timeout"]}`` —
so the gate opened precisely when the system was most stressed.

The posture this suite pins (see ``guardrail.core.errors``):

1. **Engines RAISE.** A provider that cannot compute a verdict raises
   :class:`GuardrailUndeterminedError`. It never fabricates one. This is rule 06's
   *"a generated label must raise, never be fabricated"*.
2. **Single-item endpoints answer 503.** HTTP 200 is reserved for a verdict that was
   actually computed, so ``safe: true`` on the wire always means a model said so.
   503 (not a 200 with ``safe=false``) because an undetermined verdict is RETRYABLE:
   ``apps/text``'s gate maps a not-allowed 200 to a 422 *content rejection* and a
   transport failure to a retryable 503 — reporting "content rejected" for an engine
   timeout would be a lie to the clinician.
3. **Batch endpoints stay 200 and mark the individual item.** A batch is a multiplex
   and cannot collapse to one status code, so an unresolved element is
   ``safe=False, issues=["undetermined"]`` — fail-closed, and distinguishable from a
   genuine content violation by the issue tag.
4. **A DECLARED ``enabled=False`` bypass is untouched.** An operator disabling an
   engine is a configuration decision; a FAILURE is never a bypass. That line is the
   whole distinction this suite enforces.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi import HTTPException

from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.services.external_text_client import TextJudgeClient


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeChatClient:
    def __init__(self, content: str) -> None:
        self.content = content

    async def post(self, *args: Any, **kwargs: Any) -> _FakeResponse:
        return _FakeResponse({"choices": [{"message": {"content": self.content}}]})


class _RaisingClient:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc

    async def post(self, *args: Any, **kwargs: Any) -> _FakeResponse:
        raise self.exc


def _guardian(client: Any, enabled: bool = True) -> TextJudgeClient:
    """The guardian is now a DELEGATION to `apps/text` (TASK-735 Phase 2b).

    The posture this suite pins is unchanged by that move — which is the point:
    the fail-closed rule belongs to guardrail's policy layer, not to whichever
    engine happened to be behind it.
    """
    return TextJudgeClient(
        base_url="http://text:8862",
        http_client=client,
        service_token="tok",
        provider="lm-studio",
        model="guardian-1",
        tenant_id="11111111-1111-1111-1111-111111111111",
        criteria="you are a medical context validator",
        max_attempts=1,
        enabled=enabled,
    )


# ── 1. engines raise rather than fabricate ─────────────────────────────────


# The four LLM content-analysis tests that stood here went with
# `providers/openai_compat.py` in TASK-735 Phase 2b: that stack had zero
# production callers (`/guardrail/analyze` runs GLiNER), and the LIVE LLM path —
# the guardian behind `/medical/validate` — is covered below against the
# delegating client that replaced it.


@pytest.mark.asyncio
async def test_guardian_timeout_raises_instead_of_is_medical_true() -> None:
    guardian = _guardian(_RaisingClient(httpx.TimeoutException("boom")))

    with pytest.raises(GuardrailUndeterminedError) as exc:
        await guardian.validate_medical_context("text")

    assert exc.value.reason == "timeout"


@pytest.mark.asyncio
async def test_guardian_error_raises_instead_of_is_medical_true() -> None:
    guardian = _guardian(_RaisingClient(ValueError("kaboom")))

    with pytest.raises(GuardrailUndeterminedError) as exc:
        await guardian.validate_medical_context("text")

    assert exc.value.reason == "engine_error"


@pytest.mark.asyncio
async def test_delegated_classification_error_raises_instead_of_returning_safe() -> None:
    """TASK-735 Phase 3 — the same posture now that `apps/nlp` runs the model."""
    from guardrail.services.safety_analyzer import SafetyAnalyzer, SafetyPolicy

    class _RaisingNlp:
        async def classify(self, tasks: Any, text: str) -> Any:
            raise GuardrailUndeterminedError("engine_error", "nlp exploded")

    analyzer = SafetyAnalyzer(
        SafetyPolicy(tasks={"prompt_safety": {"labels": ["safe", "unsafe"]}}),
        safety_client=_RaisingNlp(),  # type: ignore[arg-type]
    )

    with pytest.raises(GuardrailUndeterminedError) as exc:
        await analyzer.analyze_content("text", "content_safety")

    assert exc.value.reason == "engine_error"


# ── 2. a DECLARED disable is still a bypass (the line we are NOT crossing) ──


@pytest.mark.asyncio
async def test_declared_disable_remains_a_bypass_not_a_failure() -> None:
    """`enabled=False` is an operator decision, not an inability to answer."""
    guardian = _guardian(_RaisingClient(ValueError("never called")), enabled=False)

    result = await guardian.validate_medical_context("text")

    assert result["is_medical"] is True
    assert "disabled" in result["reasoning"].lower()


# ── 3. endpoints translate an undetermined verdict fail-closed ─────────────


class _UndeterminedAnalyzer:
    async def analyze_content(self, text: str, guardrail_type: str = "comprehensive") -> Any:
        raise GuardrailUndeterminedError("timeout", "engine timed out")

    async def batch_analyze(
        self,
        texts: list[str],
        guardrail_type: str = "comprehensive",
        gate: Any = None,  # TASK-777 B-4: batch fan-out is bounded by a gate
    ) -> list[Any]:
        return [GuardrailUndeterminedError("timeout", "engine timed out") for _ in texts]


def _app_state_with(provider: Any) -> Any:
    """A minimal `app.state` (kept for the redact/job call sites)."""
    state = MagicMock()
    state.effective_config_client = None
    return state


@pytest.mark.asyncio
async def test_analyze_endpoint_503s_rather_than_answering_safe() -> None:
    from guardrail.api.endpoints.guardrails import GuardrailRequest, analyze_content

    http_request = MagicMock()
    http_request.app.state = _app_state_with(None)
    http_request.headers = {"X-Tenant-Id": "11111111-1111-1111-1111-111111111111"}

    with pytest.raises(HTTPException) as exc:
        await analyze_content(
            GuardrailRequest(text="x", guardrail_type="content_safety"),
            http_request,
            analyzer=_UndeterminedAnalyzer(),  # type: ignore[arg-type]
        )

    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_analyze_batch_marks_the_item_undetermined_not_safe() -> None:
    from guardrail.api.endpoints.guardrails import BatchGuardrailRequest, analyze_batch

    http_request = MagicMock()
    http_request.app.state = _app_state_with(None)
    http_request.headers = {"X-Tenant-Id": "11111111-1111-1111-1111-111111111111"}

    responses = await analyze_batch(
        BatchGuardrailRequest(texts=["a", "b"], guardrail_type="content_safety"),
        http_request,
        analyzer=_UndeterminedAnalyzer(),  # type: ignore[arg-type]
    )

    assert [r.safe for r in responses] == [False, False]
    assert all("undetermined" in r.issues for r in responses)


@pytest.mark.asyncio
async def test_medical_validate_503s_rather_than_answering_is_medical() -> None:
    from guardrail.api.endpoints.medical import (
        MedicalValidationRequest,
        validate_medical_context,
    )

    guardian = AsyncMock()
    guardian.validate_medical_context = AsyncMock(
        side_effect=GuardrailUndeterminedError("timeout", "engine timed out")
    )

    with pytest.raises(HTTPException) as exc:
        await validate_medical_context(
            MedicalValidationRequest(text="x"),
            settings=MagicMock(),
            guardian_provider=guardian,
        )

    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_medical_validate_batch_marks_the_item_not_medical() -> None:
    from guardrail.api.endpoints.medical import (
        BatchMedicalValidationRequest,
        validate_batch_medical_context,
    )

    guardian = AsyncMock()
    guardian.batch_validate = AsyncMock(
        return_value=[GuardrailUndeterminedError("timeout", "engine timed out")]
    )

    responses = await validate_batch_medical_context(
        BatchMedicalValidationRequest(texts=["a"]),
        settings=MagicMock(),
        guardian_provider=guardian,
    )

    assert responses[0].is_medical is False
