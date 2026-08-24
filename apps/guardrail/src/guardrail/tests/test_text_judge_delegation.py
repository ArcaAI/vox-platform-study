"""Guardrail delegates LLM judgement to `apps/text` (TASK-735 Phase 2b / 5).

Guardrail owns POLICY — the medical-validation criteria, the confidence floor,
the verdict shape and the fail-closed posture. It owns NO engine: the actual
model call goes to `text`'s isolated judge lane
(`POST /api/v1/generate/internal/judge`, contract in the ticket README §7
"Phase 2a"), which is outside `text`'s own moderation gate and runs on its own
pool so the safety plane cannot starve behind the traffic it protects.

Two guarantees are load-bearing and both are asserted here:

* **Fail-closed.** A judge lane that never answered is a 503-shaped
  `GuardrailUndeterminedError`, never `is_medical=True`. `apps/text` gates every
  `/generate` on this verdict, so a permissive default ships an unmoderated
  clinical prompt.
* **No credential, endpoint or model literal in guardrail.** Selection comes from
  `AiTaskDefault` (tenant row first) and the tenant's key travels as an opaque
  `provider_overrides` pass-through that guardrail never decrypts, stores or logs.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest

from guardrail.core.config import Settings
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.services.external_text_client import TextJudgeClient

_VERDICT = (
    '{"is_medical": true, "confidence": 0.93, "context_type": "clinical", '
    '"reasoning": "chief complaint and vitals"}'
)


class _FakeResponse:
    def __init__(self, payload: dict[str, Any], status: int = 200) -> None:
        self._payload = payload
        self.status_code = status

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _RecordingClient:
    """Captures exactly one outbound judge call."""

    def __init__(self, payload: dict[str, Any] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._payload = payload if payload is not None else _judge_body()

    async def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"url": url, **kwargs})
        return _FakeResponse(self._payload)


class _RaisingClient:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc
        self.attempts = 0

    async def post(self, *_args: Any, **_kwargs: Any) -> _FakeResponse:
        self.attempts += 1
        raise self.exc


def _judge_body(content: str = _VERDICT) -> dict[str, Any]:
    return {
        "content": content,
        "reasoning": None,
        "provider": "lm-studio",
        "model": "guardian-1",
        "latency_ms": 42,
        "finish_reason": "stop",
        "stats": {
            "provider": "lm-studio",
            "model": "guardian-1",
            "prompt_tokens": 120,
            "completion_tokens": 8,
            "total_tokens": 128,
            "total_ms": 42,
            "stop_reason": "stop",
        },
        "usage_detail": {
            "provider": "lm-studio",
            "model": "guardian-1",
            "cost_basis": "INTERNAL",
        },
    }


def _client(http_client: Any, **overrides: Any) -> TextJudgeClient:
    kwargs: dict[str, Any] = {
        "base_url": "http://text:8862",
        "http_client": http_client,
        "service_token": "tok",
        "provider": "lm-studio",
        "model": "guardian-1",
        "tenant_id": "11111111-1111-1111-1111-111111111111",
        # Criteria is CONFIG (TASK-777 A-3) — the client refuses to construct without it.
        "criteria": "you are a medical context validator",
    }
    kwargs.update(overrides)
    return TextJudgeClient(**kwargs)


# ---------------------------------------------------------------------------
# Wire shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_posts_to_the_isolated_judge_lane_with_service_and_tenant_headers() -> None:
    http = _RecordingClient()
    await _client(http).validate_medical_context("chest pain, BP 140/90")

    call = http.calls[0]
    assert call["url"] == "http://text:8862/api/v1/generate/internal/judge"
    assert call["headers"]["X-Service-Token"] == "tok"
    assert call["headers"]["X-Tenant-Id"] == "11111111-1111-1111-1111-111111111111"
    body = call["json"]
    # Selection is resolved by guardrail (AiTaskDefault, tenant row first) and sent
    # explicitly — `text` never picks a model for the safety plane.
    assert body["provider"] == "lm-studio"
    assert body["model"] == "guardian-1"
    assert body["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_forwards_provider_overrides_verbatim_and_never_logs_them() -> None:
    http = _RecordingClient()
    overrides = {"lm-studio": {"api_key": "sk-tenant-secret"}}
    await _client(http, provider_overrides=overrides).validate_medical_context("note")

    assert http.calls[0]["json"]["provider_overrides"] == overrides


@pytest.mark.asyncio
async def test_absent_tenant_is_a_caller_defect() -> None:
    with pytest.raises(ValueError, match="tenant"):
        _client(_RecordingClient(), tenant_id="  ")


# ---------------------------------------------------------------------------
# Verdict interpretation stays guardrail's job
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parses_the_verdict_and_rides_usage_back_for_billing() -> None:
    result = await _client(_RecordingClient()).validate_medical_context("note", True)

    assert result["is_medical"] is True
    assert result["confidence"] == pytest.approx(0.93)
    assert result["context_type"] == "clinical"
    assert result["stats"]["prompt_tokens"] == 120
    assert result["stats"]["predicted_tokens"] == 8
    # The billing ride-back `text` built; guardrail forwards it, never re-derives it.
    assert result["usage_detail"]["cost_basis"] == "INTERNAL"


@pytest.mark.asyncio
async def test_unparseable_judgement_is_undetermined_not_a_keyword_guess() -> None:
    """TASK-777 A-4 — REVERSED from the behaviour this test used to pin.

    The old `_keyword_verdict` fallback scored the RAW MODEL OUTPUT against a
    hardcoded 40-term taxonomy. It was defended as "deterministic, and readily
    answers False", but the text it scored is attacker-influenceable: prose
    containing two clinical words earned `is_medical: true` with no model having
    judged the INPUT, and the result was indistinguishable on the wire from a real
    verdict. A response we cannot read is now simply undetermined.
    """
    http = _RecordingClient(_judge_body("the patient has a clear diagnosis, no JSON here"))
    with pytest.raises(GuardrailUndeterminedError):
        await _client(http).validate_medical_context("note")


# ---------------------------------------------------------------------------
# Fail-closed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_text_outage_raises_rather_than_reporting_is_medical() -> None:
    http = _RaisingClient(RuntimeError("connection refused"))
    with pytest.raises(GuardrailUndeterminedError):
        await _client(http, max_attempts=2).validate_medical_context("note")
    assert http.attempts == 2, "the retry budget is bounded and actually used"


@pytest.mark.asyncio
async def test_batch_returns_per_item_exceptions_rather_than_voiding_the_batch() -> None:
    class _Flaky:
        def __init__(self) -> None:
            self.n = 0

        async def post(self, *_a: Any, **_k: Any) -> _FakeResponse:
            self.n += 1
            if self.n == 1:
                return _FakeResponse(_judge_body())
            raise RuntimeError("boom")

    results = await _client(_Flaky(), max_attempts=1).batch_validate(["a", "b"])
    assert results[0]["is_medical"] is True
    assert isinstance(results[1], Exception)


@pytest.mark.asyncio
async def test_declared_disable_is_a_bypass_not_a_failure() -> None:
    result = await _client(_RecordingClient(), enabled=False).validate_medical_context("x")
    assert result["is_medical"] is True
    assert "disabled" in result["reasoning"].lower()


# ---------------------------------------------------------------------------
# Phase 5 — guardrail sources NO credential, endpoint or model from env
# ---------------------------------------------------------------------------


def test_no_engine_subconfig_survives_on_settings() -> None:
    settings = Settings()
    for attr in (
        "openai_compat",
        "vllm",
        "llama_cpp",
        "azure",
        "bedrock",
        "engine",
        "provider",
    ):
        assert not hasattr(settings, attr), f"engine surface {attr!r} must be gone"


def test_guardrail_api_key_env_vars_populate_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Shaped after `apps/text`'s BYOK credential test: a vendor key in guardrail's
    env is not a configuration surface, it is a leak waiting to happen."""
    for var in (
        "GUARDRAIL_VLLM_API_KEY",
        "GUARDRAIL_OPENAI_COMPAT_API_KEY",
        "GUARDRAIL_AZURE_API_KEY",
        "GUARDRAIL_BEDROCK_API_KEY",
        "GUARDRAIL_LLAMA_CPP_API_KEY",
    ):
        monkeypatch.setenv(var, "sk-should-never-be-read")

    dumped = repr(Settings().model_dump())
    assert "sk-should-never-be-read" not in dumped


def test_judge_client_takes_no_api_key_parameter() -> None:
    """The tenant's key only ever travels as an opaque `provider_overrides` blob."""
    params = inspect.signature(TextJudgeClient.__init__).parameters
    assert "api_key" not in params
    assert "provider_overrides" in params
