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

from guardrail.core.config import GlinerConfig, OpenAICompatConfig
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.providers.gliner import GlinerProvider
from guardrail.providers.openai_compat import (
    OpenAICompatGuardianProvider,
    OpenAICompatProvider,
)


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


def _content_provider(client: Any) -> OpenAICompatProvider:
    return OpenAICompatProvider(
        settings=OpenAICompatConfig(),
        http_client=client,  # type: ignore[arg-type]
    )


def _guardian(client: Any) -> OpenAICompatGuardianProvider:
    return OpenAICompatGuardianProvider(
        settings=OpenAICompatConfig(),
        http_client=client,  # type: ignore[arg-type]
    )


# ── 1. engines raise rather than fabricate ─────────────────────────────────


@pytest.mark.asyncio
async def test_llm_timeout_raises_instead_of_returning_safe() -> None:
    """THE P0. A timeout must not yield a `safe` verdict."""
    provider = _content_provider(_RaisingClient(httpx.TimeoutException("boom")))

    with pytest.raises(GuardrailUndeterminedError) as exc:
        await provider.analyze_content("text", "content_safety")

    assert exc.value.reason == "timeout"


@pytest.mark.asyncio
async def test_llm_transport_error_raises_instead_of_returning_safe() -> None:
    provider = _content_provider(_RaisingClient(ValueError("kaboom")))

    with pytest.raises(GuardrailUndeterminedError) as exc:
        await provider.analyze_content("text", "content_safety")

    assert exc.value.reason == "engine_error"


@pytest.mark.asyncio
async def test_unparseable_granite_score_raises_instead_of_returning_safe() -> None:
    """A model that answered without a <score> tag rendered NO verdict."""
    provider = _content_provider(_FakeChatClient("the model rambled without a score tag"))

    with pytest.raises(GuardrailUndeterminedError) as exc:
        await provider.analyze_content("text", "prompt_injection")

    assert exc.value.reason == "invalid_response"


@pytest.mark.asyncio
async def test_comprehensive_does_not_survive_one_undetermined_check() -> None:
    """`comprehensive` merges three checks; one unknown makes the whole merge unknown."""
    provider = _content_provider(_RaisingClient(httpx.TimeoutException("boom")))

    with pytest.raises(GuardrailUndeterminedError):
        await provider.analyze_content("text", "comprehensive")


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
async def test_gliner_runtime_error_raises_instead_of_returning_safe() -> None:
    provider = GlinerProvider(config=GlinerConfig())
    provider.runtime = MagicMock()
    provider.runtime.classify.side_effect = RuntimeError("onnx exploded")

    with pytest.raises(GuardrailUndeterminedError) as exc:
        await provider.analyze_content("text", "content_safety")

    assert exc.value.reason == "engine_error"


# ── 2. a DECLARED disable is still a bypass (the line we are NOT crossing) ──


@pytest.mark.asyncio
async def test_declared_disable_remains_a_bypass_not_a_failure() -> None:
    """`enabled=False` is an operator decision, not an inability to answer."""
    provider = OpenAICompatProvider(
        settings=OpenAICompatConfig(enabled=False),
        http_client=_RaisingClient(ValueError("never called")),  # type: ignore[arg-type]
    )

    result = await provider.analyze_content("text", "content_safety")

    assert result["safe"] is True
    assert "disabled" in result["error"]


# ── 3. endpoints translate an undetermined verdict fail-closed ─────────────


class _UndeterminedGliner:
    async def analyze_content(self, text: str, guardrail_type: str = "comprehensive") -> Any:
        raise GuardrailUndeterminedError("timeout", "engine timed out")

    async def batch_analyze(
        self, texts: list[str], guardrail_type: str = "comprehensive"
    ) -> list[Any]:
        return [GuardrailUndeterminedError("timeout", "engine timed out") for _ in texts]


def _app_state_with(provider: Any) -> Any:
    """A minimal `app.state` whose pinned-GLiNER cache yields `provider`."""
    from guardrail.services.model_cache import ModelCache

    async def factory(model_id: str) -> Any:
        return provider

    state = MagicMock()
    state.gliner_cache = ModelCache(factory=factory)
    state.effective_config_client = None
    return state


@pytest.mark.asyncio
async def test_analyze_endpoint_503s_rather_than_answering_safe() -> None:
    from guardrail.api.endpoints.guardrails import GuardrailRequest, analyze_content

    http_request = MagicMock()
    http_request.app.state = _app_state_with(_UndeterminedGliner())
    http_request.headers = {"X-Tenant-Id": "11111111-1111-1111-1111-111111111111"}

    with pytest.raises(HTTPException) as exc:
        await analyze_content(
            GuardrailRequest(text="x", guardrail_type="content_safety"),
            http_request,
            model_id="some-model",
        )

    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_analyze_batch_marks_the_item_undetermined_not_safe() -> None:
    from guardrail.api.endpoints.guardrails import BatchGuardrailRequest, analyze_batch

    http_request = MagicMock()
    http_request.app.state = _app_state_with(_UndeterminedGliner())
    http_request.headers = {"X-Tenant-Id": "11111111-1111-1111-1111-111111111111"}

    responses = await analyze_batch(
        BatchGuardrailRequest(texts=["a", "b"], guardrail_type="content_safety"),
        http_request,
        model_id="some-model",
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
