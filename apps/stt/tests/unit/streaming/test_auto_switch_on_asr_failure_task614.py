"""The failure-driven auto-switch must arm from an ASR error.

``EngineSwitchController.record_failure`` — the only thing that arms automatic
outage-driven fallback — has exactly ONE production call site: the inference
loop's ``except`` block (``session_manager.py``). That ``except`` can only fire
if ``StreamingInferenceWorker.process_utterance`` raises. But
``process_utterance`` wrapped the embedding + ASR gather in a broad
``except Exception`` that converted ANY inference failure into an empty
``_InferenceResult`` and returned normally.

So a cloud auth rejection, an exhausted quota, or a model error was logged as
"Inference failed", produced an empty transcript, and never reached
``record_failure``: the consecutive-failure counter never incremented and the
session went quiet instead of switching engines — deaf to exactly the failure
class auto-switch exists for.

These tests drive a RAISING ASR callable through the REAL inference worker and
the REAL inference loop (only the manager's heavy assembly is mocked), so they
assert the actual chain rather than a controller called by hand — which is what
``test_session_manager_auto_switch_task614.py`` does, and why the break survived
that suite.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest
from test_session_manager_start_on import _create, _make_manager  # noqa: E402

from stt.core.exceptions import (
    CloudASRAuthError,
    CloudASRTranscriptionError,
    EmbeddingExtractionError,
)
from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance
from stt.streaming.session_manager import SessionManager

pytestmark = pytest.mark.asyncio


def _utterance(index: int = 0) -> AudioUtterance:
    """A one-second final utterance (content is irrelevant — the ASR raises)."""
    return AudioUtterance(
        samples=np.zeros(16_000, dtype=np.float32),
        sample_rate=16_000,
        start_time=float(index),
        end_time=float(index) + 1.0,
        utterance_index=index,
        is_final=True,
    )


def _raising_asr(exc: BaseException) -> Any:
    """An ASR callable that fails the way a real cloud/local engine fails."""

    def _call(samples, sample_rate, prompt=None):  # noqa: ANN001, ARG001
        raise exc

    return _call


def _worker(asr: Any) -> StreamingInferenceWorker:
    """A real worker with no publisher/diarizer — only the ASR seam matters."""
    return StreamingInferenceWorker(asr_pipeline=asr, active_pipeline_id="primary-pipe")


async def _arm_and_drive(mgr, worker: StreamingInferenceWorker, count: int) -> None:
    """Run *count* utterances through the REAL inference loop for session ``s1``.

    Registers the worker where the switch controller's ``_apply`` closure looks
    for it, so a swap that fires genuinely lands on this worker's ASR reference.
    """
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


# ---------------------------------------------------------------------------
# The worker seam — a classified ASR failure must not be swallowed
# ---------------------------------------------------------------------------


async def test_process_utterance_propagates_a_cloud_auth_failure():
    """An immediate-switch-class failure reaches the caller (was: empty result)."""
    worker = _worker(_raising_asr(CloudASRAuthError("401 invalid key")))

    with pytest.raises(CloudASRAuthError):
        await worker.process_utterance("s1", _utterance())


async def test_process_utterance_propagates_a_transcription_failure():
    """A threshold-switch-class failure reaches the caller too."""
    worker = _worker(_raising_asr(CloudASRTranscriptionError("503 upstream")))

    with pytest.raises(CloudASRTranscriptionError):
        await worker.process_utterance("s1", _utterance())


async def test_process_utterance_still_degrades_on_a_non_asr_failure():
    """Regression lock: only ASR-ENGINE failures propagate.

    A failure the switch controller classifies as ``ignore`` keeps the
    pre-existing degrade-to-empty behaviour — swapping engines would not fix it,
    and raising would newly kill utterances that survive today.
    """
    worker = _worker(_raising_asr(EmbeddingExtractionError("diarizer blip")))

    result = await worker.process_utterance("s1", _utterance())

    assert result.text == ""
    assert result.is_final is True


# ---------------------------------------------------------------------------
# The full chain — raising ASR callable → real loop → controller arms
# ---------------------------------------------------------------------------


async def test_cloud_auth_failure_through_the_real_loop_switches_immediately():
    mgr = _make_manager()
    await _create(mgr, fallback_pipeline_id="fb-pipe")
    ctrl = mgr._switch_controllers["s1"]
    worker = _worker(_raising_asr(CloudASRAuthError("401 invalid key")))

    await _arm_and_drive(mgr, worker, count=1)

    assert ctrl.switched is True
    assert ctrl.active_engine == "fallback"
    # The swap landed on THIS worker: both the callable and its provenance
    # stamp now name the fallback engine.
    assert worker._active_pipeline_id == "fb-pipe"


async def test_transcription_failures_through_the_real_loop_switch_at_the_threshold():
    mgr = _make_manager()
    await _create(mgr, fallback_pipeline_id="fb-pipe", consecutive_failure_threshold=2)
    ctrl = mgr._switch_controllers["s1"]
    worker = _worker(_raising_asr(CloudASRTranscriptionError("503 upstream")))

    # One failure is a blip — the primary is kept.
    await _arm_and_drive(mgr, worker, count=1)
    assert ctrl.switched is False

    # The second consecutive failure meets the tenant's threshold.
    await _arm_and_drive(mgr, worker, count=1)
    assert ctrl.switched is True


async def test_a_tenant_who_disabled_auto_switch_still_gets_no_switch():
    """The propagation must not bypass the tenant's governance."""
    mgr = _make_manager()
    await _create(mgr, fallback_pipeline_id="fb-pipe", auto_switch_enabled=False)
    ctrl = mgr._switch_controllers["s1"]
    worker = _worker(_raising_asr(CloudASRAuthError("401 invalid key")))

    await _arm_and_drive(mgr, worker, count=3)

    assert ctrl.switched is False
    assert ctrl.active_engine == "primary"
