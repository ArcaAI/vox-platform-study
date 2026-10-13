"""A configured-but-down self-hosted engine is probed by the readiness sweep every
interval; its failure is a WARNING once per outage, DEBUG on every repeat, and an
INFO when it answers again — not a warning per provider per minute.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from openai import APIConnectionError

from text.models.probe import ProbeConnection
from text.providers import probe_log


class _Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def _rec(self, level: str):
        def emit(event: str, **kw: Any) -> None:
            self.calls.append((level, event, kw))

        return emit

    def __getattr__(self, level: str):
        return self._rec(level)

    def levels(self, event_prefix: str = "get_info.") -> list[tuple[str, str]]:
        return [(lvl, ev) for lvl, ev, _ in self.calls if ev.startswith(event_prefix)]


@pytest.fixture(autouse=True)
def _reset():
    probe_log.reset()
    yield
    probe_log.reset()


def test_repeated_failure_warns_once_then_debug_then_recovers_at_info():
    rec = _Recorder()
    for _ in range(3):
        probe_log.probe_failed(rec, "vllm", "http://hope-vllm:8000/v1", "Connection error.")
    probe_log.probe_succeeded(rec, "vllm", "http://hope-vllm:8000/v1")
    probe_log.probe_succeeded(rec, "vllm", "http://hope-vllm:8000/v1")
    assert rec.levels() == [
        ("warning", "get_info.failed"),
        ("debug", "get_info.failed"),
        ("debug", "get_info.failed"),
        ("info", "get_info.recovered"),
    ]


def test_outage_state_is_per_provider_and_address():
    rec = _Recorder()
    probe_log.probe_failed(rec, "vllm", "http://a", "x")
    probe_log.probe_failed(rec, "vllm", "http://b", "x")
    probe_log.probe_failed(rec, "ollama", "http://a", "x")
    assert [lvl for lvl, _ in rec.levels()] == ["warning", "warning", "warning"]


def test_a_changed_error_warns_again():
    rec = _Recorder()
    probe_log.probe_failed(rec, "ollama", "http://a", "refused")
    probe_log.probe_failed(rec, "ollama", "http://a", "Name or service not known")
    assert [lvl for lvl, _ in rec.levels()] == ["warning", "warning"]


async def test_ollama_discovery_failure_is_deduplicated(monkeypatch):
    from text.providers import ollama

    rec = _Recorder()
    monkeypatch.setattr(ollama, "logger", rec)
    http = MagicMock()
    http.get = AsyncMock(side_effect=httpx.ConnectError("All connection attempts failed"))
    provider = ollama.OllamaProvider(http)
    conn = ProbeConnection(base_url="http://hope-ollama:11434")
    for _ in range(3):
        await provider.discover_models(conn)
    assert rec.levels() == [
        ("warning", "get_info.failed"),
        ("debug", "get_info.failed"),
        ("debug", "get_info.failed"),
    ]


async def test_llama_cpp_discovery_failure_is_deduplicated(monkeypatch):
    from text.providers import llama_cpp

    rec = _Recorder()
    monkeypatch.setattr(llama_cpp, "logger", rec)
    http = MagicMock()
    http.get = AsyncMock(side_effect=httpx.ConnectError("Name or service not known"))
    provider = llama_cpp.LlamaCppProvider(http)
    conn = ProbeConnection(base_url="http://hope-llama-cpp:8080")
    for _ in range(2):
        await provider.discover_models(conn)
    assert rec.levels() == [("warning", "get_info.failed"), ("debug", "get_info.failed")]


async def test_openai_compat_listing_failure_is_deduplicated(monkeypatch):
    from text.providers import openai_compat

    rec = _Recorder()
    monkeypatch.setattr(openai_compat, "logger", rec)
    client = MagicMock()
    client.models.list = AsyncMock(
        side_effect=APIConnectionError(request=httpx.Request("GET", "http://hope-vllm/v1/models"))
    )
    provider = openai_compat.OpenAICompatProvider.__new__(openai_compat.OpenAICompatProvider)
    provider._provider_name = "vllm"
    provider._display_name = "vLLM"
    for _ in range(2):
        await provider._list_models(client, "http://hope-vllm:8000/v1")
    assert rec.levels() == [("warning", "get_info.failed"), ("debug", "get_info.failed")]
