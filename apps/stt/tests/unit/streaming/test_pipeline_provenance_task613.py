"""Per-utterance pipeline provenance (TASK-613 AC-1, lanes A3/A4).

Every transcript result must carry the pipeline id that produced *that*
utterance, so a mid-session engine switch is visible per-utterance rather than
session-wide. The stamp is taken at ``SegmentResult`` construction time inside
``StreamingInferenceWorker``; the engine switch carries the new pipeline id
through the SAME seam that swaps the ASR callable
(``SessionManager._make_switch_controller._apply``), so the two can never
diverge.

Covered here:

* a result produced on the primary carries the primary id (final + partial)
* a result produced after a switch carries the TARGET id (both directions)
* ``created_on_fallback`` (primary ASR failed to load) stamps the fallback id
* ``started_on_fallback`` (``start_on='fallback'``) stamps the fallback id
* the ``gloss`` follow-up inherits its originating final's stamp
* the switch-RETRY utterance (re-run on the freshly-swapped engine) carries the
  NEW engine's id — the case that proves per-utterance beats session-level
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest
from test_session_manager_start_on import _create, _make_manager  # noqa: E402

from stt.core.exceptions import CloudASRAuthError
from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance
from stt.streaming.session_manager import SessionManager

PRIMARY = "primary-pipe"
FALLBACK = "fb-pipe"


def _utterance(index: int = 0, *, is_final: bool = True) -> AudioUtterance:
    samples = np.random.randn(16000 * 2).astype(np.float32) * 0.1
    return AudioUtterance(
        samples=samples,
        sample_rate=16000,
        start_time=float(index * 2),
        end_time=float((index + 1) * 2),
        utterance_index=index,
        is_final=is_final,
    )


async def _drain_gloss_tasks(worker: StreamingInferenceWorker) -> None:
    for _ in range(20):
        if not worker._gloss_tasks:
            return
        await asyncio.sleep(0)
    await asyncio.gather(*list(worker._gloss_tasks), return_exceptions=True)


def _controller_for(worker: StreamingInferenceWorker, fallback_callable) -> tuple:
    """Build the REAL ``EngineSwitchController`` through the REAL manager
    factory, wired to *worker* — so the ``_apply`` seam under test is the
    production one, not a hand-rolled double."""
    mgr = MagicMock(spec=SessionManager)
    mgr._inference_workers = {"s1": worker}
    mgr._publishers = {}
    mgr._build_fallback_asr_callable = AsyncMock(return_value=fallback_callable)
    mgr._build_primary_asr_callable = AsyncMock(return_value=lambda samples, sr: "primary again")
    controller = SessionManager._make_switch_controller(
        mgr,
        session_id="s1",
        tenant_id="t1",
        primary_pipeline_id=PRIMARY,
        fallback_pipeline_id=FALLBACK,
    )
    return mgr, controller


# =========================================================================
# 1. A result produced on the primary carries the primary id
# =========================================================================


class TestPrimaryStamp:
    @pytest.mark.asyncio
    async def test_final_carries_the_active_pipeline_id(self):
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: "hello world",
            active_pipeline_id=PRIMARY,
        )

        result = await worker.process_utterance("s1", _utterance())

        assert result.text == "hello world"
        assert result.pipeline_id == PRIMARY

    @pytest.mark.asyncio
    async def test_partial_carries_the_active_pipeline_id(self):
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: "hello world",
            active_pipeline_id=PRIMARY,
        )

        result = await worker.process_partial("s1", _utterance(is_final=False))

        assert result.pipeline_id == PRIMARY

    @pytest.mark.asyncio
    async def test_unstamped_worker_leaves_the_field_none(self):
        """Backward compatibility: a worker built without an id emits results
        whose ``pipeline_id`` is None, so ``to_redis_dict`` omits the key."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda samples, sr: "hello world")

        result = await worker.process_utterance("s1", _utterance())

        assert result.pipeline_id is None
        assert "pipeline_id" not in result.to_redis_dict()


# =========================================================================
# 2. A result produced after a switch carries the TARGET id
# =========================================================================


class TestSwitchStamp:
    @pytest.mark.asyncio
    async def test_result_after_switch_to_fallback_carries_fallback_id(self):
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: "primary text",
            active_pipeline_id=PRIMARY,
        )
        _, controller = _controller_for(worker, lambda samples, sr: "fallback text")

        before = await worker.process_utterance("s1", _utterance(0))
        assert before.pipeline_id == PRIMARY

        assert await controller.switch_manual("fallback") is True

        after = await worker.process_utterance("s1", _utterance(1))
        # The SAME seam swapped the callable and the stamp — proven by both
        # moving together.
        assert after.text == "fallback text"
        assert after.pipeline_id == FALLBACK

    @pytest.mark.asyncio
    async def test_switch_back_to_primary_restores_the_primary_id(self):
        """The switch is bidirectional (TASK-586); the stamp must follow it
        back, not latch on the fallback."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: "primary text",
            active_pipeline_id=PRIMARY,
        )
        _, controller = _controller_for(worker, lambda samples, sr: "fallback text")

        assert await controller.switch_manual("fallback") is True
        assert (await worker.process_utterance("s1", _utterance(0))).pipeline_id == FALLBACK

        controller._last_manual_switch_at = None  # skip the debounce cooldown
        assert await controller.switch_manual("primary") is True

        back = await worker.process_utterance("s1", _utterance(1))
        assert back.text == "primary again"
        assert back.pipeline_id == PRIMARY


# =========================================================================
# 3 + 4. Create-time effective pipeline id (D3 started_on / D4 created_on)
# =========================================================================


def _assembled_pipeline_ids(mgr) -> list:
    return [
        c.kwargs.get("active_pipeline_id") for c in mgr._assemble_session_runtime.call_args_list
    ]


class TestCreateTimeEffectiveId:
    @pytest.mark.asyncio
    async def test_primary_session_stamps_the_primary_id(self):
        mgr = _make_manager()

        await _create(mgr, fallback_pipeline_id=FALLBACK)

        assert _assembled_pipeline_ids(mgr) == [PRIMARY]

    @pytest.mark.asyncio
    async def test_started_on_fallback_stamps_the_fallback_id(self):
        """D3 — the caller asked to open on the fallback, so the first result
        must name the fallback, not the requested primary."""
        mgr = _make_manager()

        await _create(mgr, fallback_pipeline_id=FALLBACK, start_on="fallback")

        assert _assembled_pipeline_ids(mgr) == [FALLBACK]

    @pytest.mark.asyncio
    async def test_created_on_fallback_stamps_the_fallback_id(self):
        """D4 — the primary ASR failed to load and the session silently opened
        on the fallback. The sharpest case: the client was told 'active' and
        never selected this engine."""
        mgr = _make_manager()
        # note_switched_at_create() publishes the observable event, so the
        # runtime's publisher must be awaitable on this path.
        fallback_runtime = MagicMock()
        fallback_runtime.publisher.publish_provider_switched = AsyncMock()
        mgr._assemble_session_runtime = AsyncMock(
            side_effect=[RuntimeError("primary ASR load failed"), fallback_runtime]
        )

        await _create(mgr, fallback_pipeline_id=FALLBACK)

        # The primary attempt was stamped primary; the surviving fallback
        # assembly — the one whose worker is registered — is stamped fallback.
        assert _assembled_pipeline_ids(mgr) == [PRIMARY, FALLBACK]
        assert mgr._switch_controllers["s1"].active_engine == "fallback"


# =========================================================================
# 5. The gloss follow-up inherits its originating final's stamp
# =========================================================================


class TestGlossStamp:
    @pytest.mark.asyncio
    async def test_gloss_inherits_the_finals_pipeline_id(self):
        publisher = AsyncMock()

        async def _gloss(samples, sample_rate):
            return {"text": "I have a fever"}

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda samples, sr: "enikku pani undu",
            gloss_callable=_gloss,
            active_pipeline_id=PRIMARY,
        )

        await worker.process_utterance("s1", _utterance(5))
        await _drain_gloss_tasks(worker)

        assert publisher.publish.await_count == 2
        final = publisher.publish.call_args_list[0][0][0]
        gloss = publisher.publish.call_args_list[1][0][0]
        assert gloss.result_type == "gloss"
        assert final.pipeline_id == PRIMARY
        assert gloss.pipeline_id == final.pipeline_id

    @pytest.mark.asyncio
    async def test_gloss_keeps_its_finals_id_when_the_engine_switched_after(self):
        """The gloss is fire-and-forget AFTER the final is published, so a
        switch can land in between. Its transcript came from the final's
        engine — the stamp must follow the final, not the live worker."""
        publisher = AsyncMock()
        gate = asyncio.Event()

        async def _gloss(samples, sample_rate):
            await gate.wait()
            return {"text": "I have a fever"}

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda samples, sr: "enikku pani undu",
            gloss_callable=_gloss,
            active_pipeline_id=PRIMARY,
        )
        _, controller = _controller_for(worker, lambda samples, sr: "fallback text")

        await worker.process_utterance("s1", _utterance(5))
        assert await controller.switch_manual("fallback") is True
        gate.set()
        await _drain_gloss_tasks(worker)

        gloss = publisher.publish.call_args_list[1][0][0]
        assert gloss.result_type == "gloss"
        assert gloss.pipeline_id == PRIMARY


# =========================================================================
# 6. The switch-RETRY utterance carries the NEW engine's id
# =========================================================================


class _FailFirstWorker:
    """Delegating proxy whose FIRST ``process_utterance`` raises, so the
    inference loop's switch + re-run path executes. The re-run hits the REAL
    worker, so the stamp under assertion is produced by production code."""

    def __init__(self, worker: StreamingInferenceWorker) -> None:
        self._worker = worker
        self.calls = 0

    async def process_utterance(self, session_id, utterance):
        self.calls += 1
        if self.calls == 1:
            raise CloudASRAuthError("bad api key")
        return await self._worker.process_utterance(session_id, utterance)


class TestSwitchRetryStamp:
    @pytest.mark.asyncio
    async def test_reran_utterance_carries_the_new_engines_id(self):
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: "primary text",
            active_pipeline_id=PRIMARY,
        )
        mgr, controller = _controller_for(worker, lambda samples, sr: "fallback text")
        mgr._switch_controllers = {"s1": controller}
        mgr._final_published_gates = {}

        session = MagicMock()
        session.session_id = "s1"
        queue: asyncio.Queue = asyncio.Queue()

        task = SessionManager._start_inference_loop(mgr, session, _FailFirstWorker(worker), queue)
        await queue.put(_utterance(0))
        await queue.put(None)
        await task

        assert controller.active_engine == "fallback"
        session.add_result.assert_called_once()
        retried = session.add_result.call_args[0][0]
        assert retried.text == "fallback text"
        assert retried.pipeline_id == FALLBACK
