"""TASK-386 — Guardrail per-model metrics.

Proves the standardized cross-service ``model_running_instances`` gauge and
``model_inference_latency_seconds`` histogram increment on the real guardian
validation path (model = granite-guardian-4.1-8b by default).
"""

from __future__ import annotations

from typing import Any

import pytest
from prometheus_client import REGISTRY

from guardrail.core import metrics as m
from guardrail.core.config import OpenAICompatConfig
from guardrail.providers.openai_compat import OpenAICompatGuardianProvider


def _val(name: str, labels: dict[str, str] | None = None) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


class _FakeResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return {
            "choices": [
                {
                    "message": {
                        "content": (
                            '{"is_medical": true, "confidence": 0.9, '
                            '"context_type": "clinical", "reasoning": "ok"}'
                        )
                    }
                }
            ]
        }


class _FakeChatClient:
    async def post(self, url: str, json=None, headers=None, timeout=None) -> _FakeResponse:
        return _FakeResponse()


class TestTrackModelInference:
    def test_gauge_bumped_then_restored_and_latency_observed(self):
        labels = {"service": "guardrail", "model": "granite-guardian-4.1-8b"}
        before_gauge = _val("model_running_instances", labels)
        before_count = _val("model_inference_latency_seconds_count", labels)

        with m.track_model_inference("granite-guardian-4.1-8b"):
            assert _val("model_running_instances", labels) == before_gauge + 1

        assert _val("model_running_instances", labels) == before_gauge
        assert _val("model_inference_latency_seconds_count", labels) == before_count + 1


class TestGuardianProviderEmitsPerModelMetrics:
    @pytest.mark.asyncio
    async def test_validate_medical_context_observes_latency(self):
        provider = OpenAICompatGuardianProvider(
            settings=OpenAICompatConfig(),  # default guardian_model = granite-guardian-4.1-8b
            http_client=_FakeChatClient(),  # type: ignore[arg-type]
        )
        labels = {"service": "guardrail", "model": provider.model}
        before_count = _val("model_inference_latency_seconds_count", labels)
        before_gauge = _val("model_running_instances", labels)

        result = await provider.validate_medical_context("patient presents with chest pain")

        assert result["is_medical"] is True
        # one inference observed, gauge restored (no leak)
        assert _val("model_inference_latency_seconds_count", labels) == before_count + 1
        assert _val("model_running_instances", labels) == before_gauge
