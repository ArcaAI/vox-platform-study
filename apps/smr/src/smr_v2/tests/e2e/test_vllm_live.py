"""Live E2E for the vLLM provider.

OWNER-RUN on GPU hardware only. This whole module is SKIPPED unless
``SMR_E2E_VLLM_BASE_URL`` is set (e.g. ``http://localhost:8000/v1``), so it never
runs in hermetic CI or on a laptop without a GPU-backed vLLM. It exercises the
REAL engine end-to-end through ``VllmProvider`` and asserts the AD-1 contract
holds against a live server (engine-native stats, drained streaming usage).

Run (from the monorepo root, with the `inference` compose profile up):

    SMR_E2E_VLLM_BASE_URL=http://localhost:8000/v1 \
    SMR_E2E_VLLM_MODEL=Qwen/Qwen3-8B \
    conda run -n arcaenv --no-capture-output \
      pytest apps/smr/src/smr_v2/tests/e2e/test_vllm_live.py -q -m e2e
"""

from __future__ import annotations

import os

import pytest

_BASE_URL = os.environ.get("SMR_E2E_VLLM_BASE_URL")
_MODEL = os.environ.get("SMR_E2E_VLLM_MODEL", "Qwen/Qwen3-8B")

pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(
        not _BASE_URL,
        reason="SMR_E2E_VLLM_BASE_URL not set — owner-run on GPU hardware only.",
    ),
]


def _provider():
    from smr_v2.core.config import VllmConfig
    from smr_v2.providers.vllm import VllmProvider

    return VllmProvider(VllmConfig(base_url=_BASE_URL or "", default_model=_MODEL))


def _request(**overrides):
    from smr_v2.models.requests import GenerateRequest

    payload = {"prompt": "Say hello in exactly one word.", "model": _MODEL, "max_tokens": 32}
    payload.update(overrides)
    return GenerateRequest(**payload)


async def test_vllm_health_check_live() -> None:
    assert await _provider().health_check() is True


async def test_vllm_generate_live_populates_ad1_stats() -> None:
    content, _reasoning, stats = await _provider().generate(_request())

    assert isinstance(content, str) and content.strip()
    assert stats.provider == "vllm"
    assert stats.model == _MODEL
    # engine-native counts came back (not the null-safe zeros of the degraded path).
    assert stats.prompt_tokens > 0
    assert stats.predicted_tokens > 0
    assert stats.total_tokens >= stats.prompt_tokens + stats.predicted_tokens
    assert stats.stop_reason in {"stop", "length"}
    assert stats.stop_reason_raw


async def test_vllm_stream_live_drains_chunk_usage_done() -> None:
    types: list[str] = []
    usage_payload: dict | None = None
    async for chunk in _provider().generate_stream(_request(stream=True)):
        types.append(chunk.type)
        if chunk.type == "usage":
            usage_payload = chunk.data

    assert types.count("usage") == 1
    assert types[-1] == "done"
    assert types.index("usage") < types.index("done")
    assert any(t == "chunk" for t in types[: types.index("usage")])
    assert usage_payload is not None
    assert usage_payload.get("predicted_tokens", 0) > 0
    assert "stop_reason" in usage_payload
