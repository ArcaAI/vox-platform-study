"""Text cross-service per-model metrics.

Proves the standardized ``model_running_instances`` gauge and
``model_inference_latency_seconds`` histogram (emitted alongside Text's existing
``text_generation_*`` metrics) increment via the shared tracker. The generate
endpoint inc/dec/observe these with model = the request model (e.g. gemma-4-e4b).
"""

from __future__ import annotations

from prometheus_client import REGISTRY

from text.core import metrics as m


def _val(name: str, labels: dict[str, str] | None = None) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def test_service_name_is_text():
    assert m.SERVICE_NAME == "text"


def test_track_model_inference_bumps_then_restores_and_observes():
    labels = {"service": "text", "model": "gemma-4-e4b"}
    before_gauge = _val("model_running_instances", labels)
    before_count = _val("model_inference_latency_seconds_count", labels)

    with m.track_model_inference("gemma-4-e4b"):
        assert _val("model_running_instances", labels) == before_gauge + 1

    assert _val("model_running_instances", labels) == before_gauge
    assert _val("model_inference_latency_seconds_count", labels) == before_count + 1


def test_track_model_inference_decrements_gauge_on_error():
    labels = {"service": "text", "model": "gemma-4-e4b"}
    before_gauge = _val("model_running_instances", labels)

    try:
        with m.track_model_inference("gemma-4-e4b"):
            raise RuntimeError("boom")
    except RuntimeError:
        pass

    assert _val("model_running_instances", labels) == before_gauge
