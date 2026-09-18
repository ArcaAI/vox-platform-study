"""TASK-985 M-24 — make the declared fallback chain reachable.

Three independent links were broken, and the chain is only as good as its
weakest:

1. pywhispercpp discards `whisper_full`'s return code, so an engine failure is
   an empty segment list — "silently indistinguishable from genuine silence at
   the Python level", as the adapter's own docstring puts it.
2. `_decode_recover_locked` returns `[]` on both terminal branches (a failed
   context rebuild, and still-poisoned-after-rebuild). It never raises.
3. `record_success()` fired on every non-exception result INCLUDING `text == ''`,
   so the consecutive-failure run that arms the threshold switch was reset by
   the very silence the failure produced.

`EngineSwitchController` arms only on `CloudASRAuthError` / `CloudASRQuotaError`
(immediate) or `CloudASRTranscriptionError` / `ModelError` (threshold), and
whisper.cpp — the primary engine class for every served session — can raise none
of those four. So today only a CLOUD primary can ever fail over.

This file covers the session-side half: links 2 and 3 as seen from the inference
loop, plus the tail-path hole (N-3). Link 1's two unambiguous conditions live in
the adapter and are L-DECODE's half.

THE DISTINCTION THE WHOLE DESIGN RESTS ON: an empty decode is evidence of
failure only when the buffer carried SPEECH. A silent utterance decoding to
nothing is correct, and a failover triggered by a quiet room would swap the
engine mid-consultation for no reason.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import numpy as np
import pytest


def _make_manager():
    from stt.streaming.execution_profile import ExecutionProfile, PlatformType
    from stt.streaming.session_manager import SessionManager

    profile = ExecutionProfile(
        platform=PlatformType.CPU,
        device_name="cpu-test",
        gpu_count=0,
        total_vram_gb=0,
        total_ram_gb=16,
        cpu_cores=4,
        asr_device="cpu",
        asr_compute_type="float32",
        asr_max_batch_size=2,
        asr_model_quantization="fp16",
        embedding_device="cpu",
        embedding_batch_size=2,
        preprocess_pool_size=2,
        max_concurrent_streams=10,
        batch_scheduler_max_wait_ms=500,
        multi_gpu_strategy="none",
    )
    redis_mock = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    return SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")


def _utterance(*, speech: bool, index: int = 0):
    """A final utterance carrying speech-level or room-tone-level audio."""
    from stt.streaming.preprocessor import AudioUtterance

    amplitude = 0.3 if speech else 0.0005
    rng = np.random.default_rng(seed=index)
    samples = (rng.standard_normal(16000).astype(np.float32) * amplitude).astype(np.float32)
    return AudioUtterance(
        samples=samples,
        sample_rate=16000,
        start_time=float(index),
        end_time=float(index) + 1.0,
        utterance_index=index,
        is_final=True,
    )


def _result(text: str):
    return SimpleNamespace(text=text, is_final=True)


class TestEmptyDecodeHeuristic:
    def test_empty_decodes_with_speech_raise_on_the_nth_not_the_n_minus_first(self):
        from stt.core.exceptions import ModelError
        from stt.streaming.session_manager import _EMPTY_DECODE_FAILURE_STREAK

        mgr = _make_manager()
        for index in range(_EMPTY_DECODE_FAILURE_STREAK - 1):
            assert (
                mgr._note_decode_outcome("s1", _utterance(speech=True, index=index), _result(""))
                is True
            )

        with pytest.raises(ModelError):
            mgr._note_decode_outcome(
                "s1",
                _utterance(speech=True, index=_EMPTY_DECODE_FAILURE_STREAK),
                _result(""),
            )

    def test_silence_never_raises_however_long_it_lasts(self):
        """A quiet consultation room must not cost the clinician an engine swap."""
        from stt.streaming.session_manager import _EMPTY_DECODE_FAILURE_STREAK

        mgr = _make_manager()
        for index in range(_EMPTY_DECODE_FAILURE_STREAK * 3):
            assert (
                mgr._note_decode_outcome("s1", _utterance(speech=False, index=index), _result(""))
                is False
            )
        assert "s1" not in mgr._empty_decode_streaks

    def test_a_non_empty_decode_resets_the_streak(self):
        from stt.streaming.session_manager import _EMPTY_DECODE_FAILURE_STREAK

        mgr = _make_manager()
        for index in range(_EMPTY_DECODE_FAILURE_STREAK - 1):
            mgr._note_decode_outcome("s1", _utterance(speech=True, index=index), _result(""))
        mgr._note_decode_outcome("s1", _utterance(speech=True, index=99), _result("chest pain"))
        assert "s1" not in mgr._empty_decode_streaks

        # ...and the count starts again from zero rather than tripping at once.
        assert (
            mgr._note_decode_outcome("s1", _utterance(speech=True, index=100), _result(""))
            is True
        )

    def test_the_adapters_own_verdict_wins_when_it_supplies_one(self):
        """`empty_with_speech` from the adapter can exclude the dead-zone retry.

        The known-benign 4.50-4.70 s span is retried with a pulled-back boundary
        inside the adapter, so only the adapter knows whether an empty result is
        the retry ALSO coming back empty. When it says so, believe it over the
        local RMS test.
        """
        mgr = _make_manager()
        declared_benign = SimpleNamespace(text="", is_final=True, empty_with_speech=False)
        assert (
            mgr._note_decode_outcome("s1", _utterance(speech=True), declared_benign) is False
        )

        declared_failure = SimpleNamespace(text="", is_final=True, empty_with_speech=True)
        assert (
            mgr._note_decode_outcome("s2", _utterance(speech=False), declared_failure) is True
        )


class TestInferenceLoopArmsTheSwitch:
    @pytest.mark.asyncio
    async def test_record_success_is_withheld_for_an_empty_decode_with_speech(self):
        """Link 3: the silence the failure produces must not disarm the switch.

        Without this, an alternating empty/non-empty pattern never reaches the
        threshold even once empty decodes raise.
        """
        mgr = _make_manager()
        controller = SimpleNamespace(successes=0)
        controller.record_success = lambda: setattr(
            controller, "successes", controller.successes + 1
        )
        mgr._switch_controllers["s1"] = controller

        assert mgr._note_decode_outcome("s1", _utterance(speech=True), _result("")) is True
        assert controller.successes == 0

        assert mgr._note_decode_outcome("s1", _utterance(speech=True), _result("ok")) is False


class TestTailPathArmsTheSwitch:
    @pytest.mark.asyncio
    async def test_a_switchable_failure_on_the_tail_reaches_record_failure(self):
        """N-3 — the utterance most worth recovering was the one the switch could not see.

        `_flush_final_utterance` swallows everything and `_run_inline_inference`
        had its own broad `except`, so a `ModelError` raised while decoding the
        TAIL never reached `record_failure`.
        """
        from stt.core.exceptions import ModelError
        from stt.streaming.schemas import SessionMetadata, SessionStatus
        from stt.streaming.session import StreamSession

        mgr = _make_manager()
        meta = SessionMetadata(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
            consultation_id="c1",
            status=SessionStatus.ACTIVE,
            sample_rate=16000,
        )
        session = StreamSession(metadata=meta, redis=AsyncMock(), persist_interval_s=5.0)
        mgr._sessions["s1"] = session

        recorded: list[BaseException] = []

        async def _record_failure(exc, *, utterance_index=None):  # noqa: ANN001 - test double
            recorded.append(exc)
            return False  # no fallback configured

        mgr._switch_controllers["s1"] = SimpleNamespace(record_failure=_record_failure)

        worker = SimpleNamespace()

        async def _process(session_id, utterance):  # noqa: ANN001 - test double
            raise ModelError("whisper.cpp backend poisoned after recreate")

        worker.process_utterance = _process
        mgr._inference_workers["s1"] = worker

        # Must NOT raise: teardown has to complete either way.
        await mgr._run_inline_inference(session, _utterance(speech=True))

        assert len(recorded) == 1
        assert isinstance(recorded[0], ModelError)

    @pytest.mark.asyncio
    async def test_the_tail_utterance_is_re_run_on_the_engine_we_switched_to(self):
        """A switch that rescues nothing rescues nothing — re-run the buffer."""
        from stt.core.exceptions import ModelError
        from stt.streaming.schemas import SessionMetadata, SessionStatus
        from stt.streaming.session import StreamSession

        mgr = _make_manager()
        meta = SessionMetadata(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
            consultation_id="c1",
            status=SessionStatus.ACTIVE,
            sample_rate=16000,
        )
        session = StreamSession(metadata=meta, redis=AsyncMock(), persist_interval_s=5.0)
        mgr._sessions["s1"] = session

        calls: list[str] = []

        async def _record_failure(exc, *, utterance_index=None):  # noqa: ANN001 - test double
            return True  # switched to the fallback

        mgr._switch_controllers["s1"] = SimpleNamespace(record_failure=_record_failure)

        worker = SimpleNamespace()

        async def _process(session_id, utterance):  # noqa: ANN001 - test double
            calls.append("call")
            if len(calls) == 1:
                raise ModelError("primary is gone")
            return SimpleNamespace(text="and the pain radiates", is_final=True)

        worker.process_utterance = _process
        mgr._inference_workers["s1"] = worker

        await mgr._run_inline_inference(session, _utterance(speech=True))

        assert len(calls) == 2
        assert [r.text for r in session.results] == ["and the pain radiates"]
