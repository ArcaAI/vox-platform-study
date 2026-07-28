"""Streaming Sortformer diarizer wired into the stt hot path.

These lock the wiring of the already-built :class:`StreamingSortformerDiarizer`
(``stt.diarization.streaming_sortformer``) into the streaming inference loop:

  * ``StreamingInferenceWorker`` accepts a ``sortformer_diarizer=`` and, when
    present, attaches the max-overlap turn label to ``result.speaker_id`` on BOTH
    finals (Step 3) and partials — reusing the existing wire field (no new DTO
    field; a richer label surface is a future scope).
  * The sortformer path is fail-safe: a degraded/erroring diarizer never crashes
    the hot path and simply leaves ``speaker_id=None``.
  * ``SessionManager`` builds the diarizer for ``backend == "sortformer"`` sessions
    (open + recovery) via the ``_build_sortformer_diarizer`` helper, passing it
    INSTEAD of the embedding ``SpeakerIdentifier``.
  * The default ``backend == "embedding"`` path is unchanged.

Hermetic: a tiny deterministic ``SortformerBackend`` stub stands in for the NeMo
model (real GPU-model validation is out of scope on this host).
"""

from __future__ import annotations

import threading
import time
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt.diarization.streaming_sortformer import (
    SortformerModelUnavailableError,
    StreamingSortformerDiarizer,
)
from stt.pipeline.dto import DiarizationConfig
from stt.streaming.inference import StreamingInferenceWorker, _InferenceResult
from stt.streaming.preprocessor import AudioUtterance
from stt.streaming.schemas import SessionStatus

# S0 dominant for the first 3 frames, S1 dominant for the next 7 (0.08 s frames).
# Over an 0.8 s window: S0 turn [0.0, 0.24], S1 turn [0.24, 0.8] -> S1 wins overlap.
_TWO_SPEAKER_ACT = [[0.9, 0.1]] * 3 + [[0.1, 0.9]] * 7


class _StubBackend:
    """Deterministic ``SortformerBackend`` returning a fixed T×S matrix."""

    def __init__(self, activities: list[list[float]]) -> None:
        self._activities = activities
        self.calls = 0

    def infer_activities(self, audio, sample_rate):  # noqa: ANN001
        self.calls += 1
        return self._activities


class _RaisingBackend:
    """Backend whose forward raises — exercises the diarizer degrade path."""

    def infer_activities(self, audio, sample_rate):  # noqa: ANN001
        raise RuntimeError("boom")


def _sortformer_config() -> DiarizationConfig:
    return DiarizationConfig(
        enabled=True,
        backend="sortformer",
        enable_segmentation_refinement=False,
    )


def _make_utterance(
    *, duration_s: float = 0.8, is_final: bool = True, sample_rate: int = 16000, idx: int = 0
) -> AudioUtterance:
    n = int(duration_s * sample_rate)
    rng = np.random.default_rng(0)
    samples = (rng.standard_normal(n) * 0.1).astype(np.float32)
    return AudioUtterance(
        samples=samples,
        sample_rate=sample_rate,
        start_time=0.0,
        end_time=duration_s,
        utterance_index=idx,
        is_final=is_final,
    )


def _make_worker(*, sortformer_diarizer, diarization_config=None, **kwargs):
    return StreamingInferenceWorker(
        result_publisher=None,
        asr_pipeline=MagicMock(),
        tenant_id="tenant-a",
        consultation_id="cons-1",
        diarization_config=diarization_config or _sortformer_config(),
        sortformer_diarizer=sortformer_diarizer,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# 1. Worker accepts + stores the sortformer diarizer
# ---------------------------------------------------------------------------


def test_worker_accepts_sortformer_diarizer():
    diarizer = StreamingSortformerDiarizer(
        _sortformer_config(), backend=_StubBackend(_TWO_SPEAKER_ACT)
    )
    worker = _make_worker(sortformer_diarizer=diarizer)
    assert worker._sortformer_diarizer is diarizer


# ---------------------------------------------------------------------------
# 2. Finals attach the dominant (longest-turn) speaker label to result.speaker_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_finals_attach_dominant_speaker_label():
    stub = _StubBackend(_TWO_SPEAKER_ACT)
    diarizer = StreamingSortformerDiarizer(_sortformer_config(), backend=stub)
    worker = _make_worker(sortformer_diarizer=diarizer)
    worker._run_inference = AsyncMock(return_value=_InferenceResult(text="hello world"))
    worker._extract_embedding = AsyncMock(return_value=None)

    result = await worker.process_utterance("sess", _make_utterance(is_final=True))

    assert stub.calls == 1
    assert result.speaker_id == "S1"  # dominant over the utterance window
    assert "hello" in result.text


# ---------------------------------------------------------------------------
# 3. Partials run diarization on a sortformer worker (embedding path skips it)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_partials_run_sortformer_diarization():
    stub = _StubBackend(_TWO_SPEAKER_ACT)
    diarizer = StreamingSortformerDiarizer(_sortformer_config(), backend=stub)
    worker = _make_worker(sortformer_diarizer=diarizer)
    worker._run_inference = AsyncMock(return_value=_InferenceResult(text="hello world"))

    result = await worker.process_partial("sess", _make_utterance(is_final=False))

    assert result.is_final is False
    assert result.speaker_id == "S1"
    assert stub.calls == 1


@pytest.mark.asyncio
async def test_partial_empty_text_skips_diarizer_forward():
    # A dropped (empty-text / hallucination-suppressed) partial must NOT pay a
    # diarizer forward — it is discarded by the publish gate anyway (I2/M4).
    stub = _StubBackend(_TWO_SPEAKER_ACT)
    diarizer = StreamingSortformerDiarizer(_sortformer_config(), backend=stub)
    worker = _make_worker(sortformer_diarizer=diarizer)
    worker._run_inference = AsyncMock(return_value=_InferenceResult(text=""))

    result = await worker.process_partial("sess", _make_utterance(is_final=False))

    assert result.speaker_id is None
    assert stub.calls == 0  # no forward on the dropped partial


@pytest.mark.asyncio
async def test_partials_no_label_without_sortformer():
    # An embedding-backend worker (no sortformer diarizer) skips partial diarization.
    worker = _make_worker(
        sortformer_diarizer=None,
        diarization_config=DiarizationConfig(enabled=True, backend="embedding"),
        speaker_identifier=MagicMock(),
    )
    worker._run_inference = AsyncMock(return_value=_InferenceResult(text="hello world"))

    result = await worker.process_partial("sess", _make_utterance(is_final=False))

    assert result.speaker_id is None


# ---------------------------------------------------------------------------
# 4. Fail-safe — a degraded/erroring diarizer never crashes, leaves no label
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_failsafe_backend_error_no_label():
    diarizer = StreamingSortformerDiarizer(_sortformer_config(), backend=_RaisingBackend())
    worker = _make_worker(sortformer_diarizer=diarizer)
    worker._run_inference = AsyncMock(return_value=_InferenceResult(text="hello world"))
    worker._extract_embedding = AsyncMock(return_value=None)

    res_final = await worker.process_utterance("sess", _make_utterance(is_final=True))
    res_partial = await worker.process_partial("sess", _make_utterance(is_final=False))

    assert res_final.speaker_id is None
    assert res_partial.speaker_id is None


@pytest.mark.asyncio
async def test_failsafe_model_unavailable_no_label():
    def _unavailable(_cfg):
        raise SortformerModelUnavailableError("weights not staged")

    diarizer = StreamingSortformerDiarizer(_sortformer_config(), backend_factory=_unavailable)
    worker = _make_worker(sortformer_diarizer=diarizer)
    worker._run_inference = AsyncMock(return_value=_InferenceResult(text="hello world"))
    worker._extract_embedding = AsyncMock(return_value=None)

    result = await worker.process_utterance("sess", _make_utterance(is_final=True))

    assert result.speaker_id is None


# ---------------------------------------------------------------------------
# 5. Regression — the embedding path is unchanged when no sortformer diarizer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_embedding_path_unchanged_without_sortformer():
    worker = _make_worker(
        sortformer_diarizer=None,
        diarization_config=DiarizationConfig(enabled=True, backend="embedding"),
        speaker_identifier=MagicMock(),
    )
    worker._run_inference = AsyncMock(return_value=_InferenceResult(text="hello world"))
    worker._extract_embedding = AsyncMock(return_value=object())
    worker._identify_speaker = AsyncMock(return_value=("spk-1", 0.88))

    result = await worker.process_utterance("sess", _make_utterance(is_final=True))

    worker._identify_speaker.assert_awaited_once()
    assert result.speaker_id == "spk-1"
    assert result.speaker_confidence == pytest.approx(0.88)


# ---------------------------------------------------------------------------
# 6. SessionManager._build_sortformer_diarizer — backend-gated construction
# ---------------------------------------------------------------------------


def test_build_sortformer_diarizer_helper():
    from stt.streaming.session_manager import _build_sortformer_diarizer

    sf = _build_sortformer_diarizer(DiarizationConfig(enabled=True, backend="sortformer"))
    assert isinstance(sf, StreamingSortformerDiarizer)

    assert _build_sortformer_diarizer(DiarizationConfig(enabled=True, backend="embedding")) is None
    assert (
        _build_sortformer_diarizer(DiarizationConfig(enabled=False, backend="sortformer")) is None
    )
    assert _build_sortformer_diarizer(None) is None


# ---------------------------------------------------------------------------
# 7. Open-session construction wires the diarizer (INSTEAD of SpeakerIdentifier)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_session_wires_sortformer_diarizer():
    from stt.streaming.session_manager import SessionManager

    mgr = MagicMock(spec=SessionManager)
    mgr._sessions = {}
    mgr._consumers = {}
    mgr._control_listeners = {}
    mgr._publishers = {}
    mgr._preprocessors = {}
    mgr._inference_workers = {}
    mgr._dual_capture = {}
    mgr._commit_policies = {}
    mgr._switch_controllers = {}
    mgr._provider_overrides = {}
    mgr._fallback_pipeline_ids = {}

    pipeline_config = MagicMock()
    pipeline_config.preprocessing.vad.enabled = True
    pipeline_config.preprocessing.vad.threshold = 0.5
    pipeline_config.preprocessing.vad.min_speech_duration_ms = 250
    pipeline_config.preprocessing.vad.min_silence_duration_ms = 700
    pipeline_config.preprocessing.denoise.enabled = False
    pipeline_config.preprocessing.normalize = False
    pipeline_config.preprocessing.target_sample_rate = 16000
    pipeline_config.diarization = DiarizationConfig(
        enabled=True, backend="sortformer", enable_segmentation_refinement=False
    )

    mock_session = MagicMock()
    mock_session.force_persist = AsyncMock()

    with (
        patch("stt.streaming.session_manager.StreamSession", return_value=mock_session),
        patch("stt.streaming.session_manager.ResultPublisher"),
        patch("stt.streaming.session_manager.StreamingPreprocessor"),
        patch("stt.streaming.session_manager.StreamingInferenceWorker") as worker_cls,
        patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
        patch("stt.streaming.session_manager.ControlListener") as mock_cl,
    ):
        mock_ic.return_value.start = AsyncMock()
        mock_cl.return_value.start = AsyncMock()

        mgr._profile = MagicMock()
        mgr._profile.denoise_enabled_default = False
        mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
        mgr._load_vad_service = AsyncMock(return_value=MagicMock())
        mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
        # Bind the REAL shared assembly (session wiring moved out of
        # create/recover into _assemble_session_runtime).
        mgr._assemble_session_runtime = lambda **kw: SessionManager._assemble_session_runtime(
            mgr, **kw
        )
        mgr._load_gloss_pipeline = AsyncMock(return_value=None)
        mgr._preseed_speaker = AsyncMock()
        mgr._redis = AsyncMock()
        mgr._worker_id = "test-worker"
        mgr._capacity_guard = MagicMock()
        mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
        mgr._register_inference_runtime = MagicMock()
        mgr._make_frame_handler = MagicMock(return_value=lambda x: None)
        mgr._make_control_handler = MagicMock(return_value=lambda x: None)
        mgr._make_commit_policy = MagicMock(return_value=None)
        mgr._resolve_dual_capture = MagicMock(return_value=None)
        mgr.remove_session = AsyncMock()

        await SessionManager.create_session(
            mgr,
            session_id="sess-1",
            tenant_id="tenant-a",
            pipeline_id="p1",
            consultation_id="cons-1",
            sample_rate=16000,
            user_id="user-1",
        )

    worker_cls.assert_called_once()
    kwargs = worker_cls.call_args.kwargs
    assert isinstance(kwargs.get("sortformer_diarizer"), StreamingSortformerDiarizer)
    assert kwargs.get("speaker_identifier") is None
    # sortformer sessions never build the embedding voice-profile preseed
    mgr._preseed_speaker.assert_not_awaited()


# ---------------------------------------------------------------------------
# 9. _max_duration_label — longest turn wins, tie -> earliest, empty -> None (M2/M1)
# ---------------------------------------------------------------------------


def test_max_duration_label_picks_longest_turn():
    # S1 spans 0.56 s vs S0's 0.24 s — longest wins regardless of window length.
    turns = [(0.0, 0.24, "S0"), (0.24, 0.80, "S1")]
    assert StreamingInferenceWorker._max_duration_label(turns) == "S1"


def test_max_duration_label_tie_keeps_earliest():
    # Equal durations -> strict ``>`` keeps the first (earliest) turn.
    turns = [(0.0, 0.30, "S0"), (0.30, 0.60, "S1")]
    assert StreamingInferenceWorker._max_duration_label(turns) == "S0"


def test_max_duration_label_empty_is_none():
    assert StreamingInferenceWorker._max_duration_label([]) is None


# ---------------------------------------------------------------------------
# 10. Concurrent partial/final forwards are serialized on the shared diarizer (I1)
# ---------------------------------------------------------------------------


class _ConcurrencyTrackingBackend:
    """Records the peak number of threads inside ``infer_activities`` at once."""

    def __init__(self, activities: list[list[float]]) -> None:
        self._activities = activities
        self._lock = threading.Lock()
        self._active = 0
        self.max_active = 0

    def infer_activities(self, audio, sample_rate):  # noqa: ANN001
        with self._lock:
            self._active += 1
            self.max_active = max(self.max_active, self._active)
        # Hold the "active" window open long enough that an unserialized second
        # forward would overlap (and push max_active to 2).
        time.sleep(0.02)
        with self._lock:
            self._active -= 1
        return self._activities


@pytest.mark.asyncio
async def test_concurrent_forwards_are_serialized():
    import asyncio

    backend = _ConcurrencyTrackingBackend(_TWO_SPEAKER_ACT)
    diarizer = StreamingSortformerDiarizer(_sortformer_config(), backend=backend)
    worker = _make_worker(sortformer_diarizer=diarizer)

    # Two forwards launched concurrently (mimics a partial task racing the final
    # consume loop) must never enter the shared, non-reentrant model together.
    await asyncio.gather(
        worker._diarize_utterance_sortformer(_make_utterance(is_final=False, idx=1)),
        worker._diarize_utterance_sortformer(_make_utterance(is_final=True, idx=2)),
    )

    assert backend.max_active == 1


# ---------------------------------------------------------------------------
# 8. Recovery reconstructs a fresh diarizer for sortformer sessions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recovery_reconstructs_sortformer_diarizer():
    from stt.streaming.session_manager import SessionManager

    mgr = MagicMock(spec=SessionManager)
    mgr._sessions = {}
    mgr._consumers = {}
    mgr._control_listeners = {}
    mgr._publishers = {}
    mgr._preprocessors = {}
    mgr._inference_workers = {}
    mgr._dual_capture = {}
    mgr._commit_policies = {}
    mgr._switch_controllers = {}
    mgr._provider_overrides = {}
    mgr._fallback_pipeline_ids = {}
    mgr._worker_id = "test-worker"

    meta = MagicMock()
    meta.session_id = "sess-1"
    meta.status = SessionStatus.ACTIVE
    meta.worker_id = None
    meta.tenant_id = "tenant-a"
    meta.consultation_id = "cons-1"
    meta.pipeline_id = "p1"
    meta.sample_rate = 16000
    meta.last_stream_id = "0-0"
    meta.last_seq = 0

    pipeline_config = MagicMock()
    pipeline_config.preprocessing.vad.enabled = False
    pipeline_config.preprocessing.denoise.enabled = False
    pipeline_config.preprocessing.target_sample_rate = 16000
    pipeline_config.preprocessing.normalize = False
    pipeline_config.diarization = DiarizationConfig(
        enabled=True, backend="sortformer", enable_segmentation_refinement=False
    )

    mock_session = MagicMock()
    mock_session.force_persist = AsyncMock()

    mgr._redis = MagicMock()
    mgr._redis.scan = AsyncMock(return_value=(0, ["stt:session:sess-1"]))
    mgr._redis.hgetall = AsyncMock(return_value={"k": "v"})
    mgr._redis.exists = AsyncMock(return_value=0)
    mgr._capacity_guard = MagicMock()
    mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
    mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
    mgr._load_vad_service = AsyncMock(return_value=MagicMock())
    mgr._build_preprocessor_vad_kwargs = MagicMock(return_value={})
    mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
    # Bind the REAL shared assembly (session wiring moved out of
    # create/recover into _assemble_session_runtime).
    mgr._assemble_session_runtime = lambda **kw: SessionManager._assemble_session_runtime(mgr, **kw)
    mgr._load_gloss_pipeline = AsyncMock(return_value=None)
    mgr._register_inference_runtime = MagicMock()
    mgr._make_frame_handler = MagicMock(return_value=lambda x: None)
    mgr._make_batch_handler = MagicMock(return_value=lambda x: None)
    mgr._make_control_handler = MagicMock(return_value=lambda x: None)
    mgr._resolve_dual_capture = MagicMock(return_value=None)
    mgr._make_commit_policy = MagicMock(return_value=None)
    mgr.remove_session = AsyncMock()

    with (
        patch("stt.streaming.session_manager.StreamSession", return_value=mock_session),
        patch("stt.streaming.session_manager.SessionMetadata") as mock_meta_cls,
        patch("stt.streaming.session_manager.ResultPublisher"),
        patch("stt.streaming.session_manager.StreamingPreprocessor"),
        patch("stt.streaming.session_manager.StreamingInferenceWorker") as worker_cls,
        patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
        patch("stt.streaming.session_manager.ControlListener") as mock_cl,
    ):
        mock_meta_cls.from_redis_dict.return_value = meta
        mock_ic.return_value.start = AsyncMock()
        mock_cl.return_value.start = AsyncMock()

        await SessionManager._recover_sessions(mgr)

    worker_cls.assert_called_once()
    kwargs = worker_cls.call_args.kwargs
    assert isinstance(kwargs.get("sortformer_diarizer"), StreamingSortformerDiarizer)
    assert kwargs.get("speaker_identifier") is None
