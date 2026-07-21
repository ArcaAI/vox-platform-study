"""TDD tests for Prometheus metric definitions."""

from __future__ import annotations

from prometheus_client import REGISTRY, generate_latest

from tts_v2.core import metrics as m


def test_metric_names() -> None:
    assert m.TTS_TTFA._name == "tts_ttfa_seconds"
    assert m.TTS_RTF._name == "tts_rtf"
    assert m.TTS_ACTIVE_STREAMS._name == "tts_active_streams"
    assert m.TTS_REQUESTS._name == "tts_requests"
    assert m.TTS_FAILOVER._name == "tts_failover"
    assert m.TTS_PROVIDER_ERRORS._name == "tts_provider_errors"


def test_metric_labels() -> None:
    assert m.TTS_TTFA._labelnames == ("provider", "locale")
    assert m.TTS_REQUESTS._labelnames == ("provider", "locale", "status")
    assert m.TTS_FAILOVER._labelnames == ("from_provider", "to_provider")
    assert m.TTS_PROVIDER_ERRORS._labelnames == ("provider", "type")


def test_counter_total_suffix_exposed() -> None:
    m.TTS_REQUESTS.labels(provider="x", locale="en-IN", status="ok").inc()
    out = generate_latest(REGISTRY).decode()
    assert "tts_requests_total" in out
