"""Guardrail per-model metrics.

Proves the standardized cross-service ``model_running_instances`` gauge and
``model_inference_latency_seconds`` histogram increment on the real guardian
validation path — now the DELEGATED one (TASK-735 Phase 2b): guardrail times the
judgement it asked `apps/text` for, under the model it selected from
``AiTaskDefault``. The metric belongs to the caller that waits on the inference,
not to whichever process hosts the weights.
"""

from __future__ import annotations

from typing import Any

import pytest
from prometheus_client import REGISTRY

from guardrail.core import metrics as m
from guardrail.services.external_text_client import TextJudgeClient


def _val(name: str, labels: dict[str, str] | None = None) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


class _FakeResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return {
            "content": (
                '{"is_medical": true, "confidence": 0.9, '
                '"context_type": "clinical", "reasoning": "ok"}'
            ),
            "provider": "lm-studio",
            "model": "guardian-1",
            "latency_ms": 5,
            "finish_reason": "stop",
            "stats": {
                "prompt_tokens": 3,
                "completion_tokens": 1,
                "stop_reason": "stop",
            },
        }


class _FakeChatClient:
    async def post(
        self, url: str, json=None, headers=None, timeout=None
    ) -> _FakeResponse:
        return _FakeResponse()


class TestTrackModelInference:
    def test_gauge_bumped_then_restored_and_latency_observed(self):
        labels = {"service": "guardrail", "model": "guardian-1"}
        before_gauge = _val("model_running_instances", labels)
        before_count = _val("model_inference_latency_seconds_count", labels)

        with m.track_model_inference("guardian-1"):
            assert _val("model_running_instances", labels) == before_gauge + 1

        assert _val("model_running_instances", labels) == before_gauge
        assert _val("model_inference_latency_seconds_count", labels) == before_count + 1


class TestGuardianProviderEmitsPerModelMetrics:
    @pytest.mark.asyncio
    async def test_validate_medical_context_observes_latency(self):
        provider = TextJudgeClient(
            base_url="http://text:8862",
            http_client=_FakeChatClient(),
            service_token="tok",
            provider="lm-studio",
            model="guardian-1",
            tenant_id="11111111-1111-1111-1111-111111111111",
            criteria="you are a medical context validator",
        )
        labels = {"service": "guardrail", "model": provider.model}
        before_count = _val("model_inference_latency_seconds_count", labels)
        before_gauge = _val("model_running_instances", labels)

        result = await provider.validate_medical_context(
            "patient presents with chest pain"
        )

        assert result["is_medical"] is True
        # one inference observed, gauge restored (no leak)
        assert _val("model_inference_latency_seconds_count", labels) == before_count + 1
        assert _val("model_running_instances", labels) == before_gauge
