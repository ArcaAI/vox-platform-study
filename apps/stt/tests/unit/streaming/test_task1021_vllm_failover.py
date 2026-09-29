"""TASK-1021 L3.3 — a `vllm` 503 fails the session over to the agent's fallback chain.

The REAL vLLM streaming callable (over a mocked wire answering 503 with
``Retry-After: 0``) is driven through the REAL inference worker and loop — the
harness of ``test_auto_switch_on_asr_failure_task614.py``. Exhausted retries raise
``CloudASRTranscriptionError``, which is a threshold-class switchable error.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import numpy as np
import pytest
from pydantic import SecretStr
from test_session_manager_start_on import _create, _make_manager  # noqa: E402

from stt.core.config.settings import get_settings
from stt.models.base_loader import LoadedModel
from stt.models.vllm_loader import VllmAsrConfig
from stt.pipeline.dto import AiModelFormat, InferenceConfig
from stt.streaming import vllm_asr
from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance
from stt.streaming.session_manager import SessionManager

pytestmark = pytest.mark.asyncio


def _utterance(index: int) -> AudioUtterance:
    return AudioUtterance(
        samples=np.zeros(16_000, dtype=np.float32),
        sample_rate=16_000,
        start_time=float(index),
        end_time=float(index) + 1.0,
        utterance_index=index,
        is_final=True,
    )


@pytest.fixture
def saturated_vllm(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        # Saturated: the one 503 code (with drain / spec-read) the client retries (F5).
        return httpx.Response(
            503, headers={"Retry-After": "0"}, json={"error": {"code": "engine_capacity"}}
        )

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        vllm_asr,
        "_http_client",
        lambda timeout_s: httpx.AsyncClient(transport=transport, timeout=timeout_s),
    )
    monkeypatch.setattr(get_settings(), "internal_access_token", SecretStr("svc-token"))
    return seen


def _vllm_callable(mgr: Any) -> Any:
    loaded = LoadedModel(
        model_id="m",
        model_slug="ml-en-vllm",
        model=VllmAsrConfig(
            base_url="http://vllm.test/v1",
            model_slug="ml-en-vllm",
            max_concurrent=None,
            timeout_s=5.0,
        ),
        format=AiModelFormat.VLLM,
        device="remote",
    )
    return SessionManager._make_vllm_callable(
        mgr, loaded, InferenceConfig(language="ml"), tenant_id="t1"
    )


async def _drive(mgr: Any, worker: StreamingInferenceWorker, count: int) -> None:
    fallback_callable = MagicMock(return_value={"text": "from the fallback engine"})
    mgr._build_fallback_asr_callable = AsyncMock(return_value=fallback_callable)
    mgr._build_primary_asr_callable = AsyncMock(return_value=MagicMock())
    mgr._inference_workers["s1"] = worker
    mgr._final_published_gates = {}
    session = SimpleNamespace(session_id="s1", utterance_count=0, add_result=lambda _r: None)
    queue: asyncio.Queue[AudioUtterance | None] = asyncio.Queue()
    task = SessionManager._start_inference_loop(mgr, session, worker, queue)
    for index in range(count):
        await queue.put(_utterance(index))
    await queue.put(None)
    await asyncio.wait_for(task, timeout=5.0)


async def test_a_vllm_503_fails_the_session_over_to_the_fallback_chain(saturated_vllm) -> None:
    mgr = _make_manager()
    await _create(mgr, fallback_pipeline_id="fb-pipe", consecutive_failure_threshold=2)
    ctrl = mgr._switch_controllers["s1"]
    worker = StreamingInferenceWorker(
        asr_pipeline=_vllm_callable(mgr), active_pipeline_id="primary-pipe"
    )

    await _drive(mgr, worker, count=2)

    assert len(saturated_vllm) == 6  # two utterances × (one call + two retries)
    assert ctrl.switched is True
    assert ctrl.active_engine == "fallback"
    assert worker._active_pipeline_id == "fb-pipe"
