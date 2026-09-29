"""TASK-1009 — cross-stream batching wired into the faster-whisper engine.

Covers the seams around the scheduler and the decoder:

* the three control-plane settings, OFF by default, and their mapping to the
  registry keys (the TS descriptor half is asserted by the task-799 parity test);
* ``FasterWhisperAsrAdapter``: default behaviour untouched, batching only when
  configured, the windows it must NOT batch, and the key it groups by;
* one shared batcher per loaded model, reconfigured by a later session and
  closed when the model unloads;
* ``SessionManager._make_faster_whisper_callable`` reading the settings and
  awaiting the batch without holding a worker thread;
* the Prometheus signals a batch leaves behind.

No faster-whisper, no weights: a batcher over a recording fake decode stands in.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from prometheus_client import REGISTRY

from stt.core.config.settings import Settings
from stt.core.control_plane import CONTROL_PLANE_KEYS
from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat, InferenceConfig
from stt.streaming.cross_stream_batcher import CrossStreamBatcher
from stt.streaming.faster_whisper_asr import (
    CrossStreamBatching,
    FasterWhisperAsrAdapter,
    close_model_batcher,
    get_model_batcher,
)
from stt.streaming.faster_whisper_batch_decoder import FwDecodedWindow

_BATCHING = CrossStreamBatching(max_batch_size=4, max_wait_ms=5_000, max_queue=32)


def _fake_whisper_model() -> MagicMock:
    model = MagicMock()
    model.feature_extractor = SimpleNamespace(chunk_length=30)
    return model


def _loaded(slug: str = "fw-test") -> LoadedModel:
    batched = MagicMock()
    batched.transcribe.return_value = (iter([]), SimpleNamespace(language="en"))
    return LoadedModel(
        model_id=f"id-{slug}",
        model_slug=slug,
        model=_fake_whisper_model(),
        format=AiModelFormat.FASTER_WHISPER,
        device="cpu",
        extra={"batched_pipeline": batched},
    )


class _Recorder:
    """Fake ``decode_batch`` returning one decoded window per item."""

    def __init__(self) -> None:
        self.calls: list[tuple[object, list]] = []
        self._lock = threading.Lock()

    def __call__(self, key, items):
        with self._lock:
            self.calls.append((key, list(items)))
        return [
            FwDecodedWindow(
                segments=[
                    SimpleNamespace(
                        text=f" said {item.prompt or 'nothing'} ",
                        start=0.0,
                        end=1.0,
                        words=[SimpleNamespace(word=" said", start=0.1, end=0.4, probability=0.8)],
                    )
                ],
                language="en",
            )
            for item in items
        ]


def _batching(max_batch_size: int) -> CrossStreamBatching:
    return CrossStreamBatching(max_batch_size=max_batch_size, max_wait_ms=5_000, max_queue=32)


def _install(loaded: LoadedModel, decode, batching: CrossStreamBatching) -> CrossStreamBatcher:
    """Pre-seat a batcher over a fake decode, as `get_model_batcher` would have."""
    batcher = CrossStreamBatcher(
        decode,
        name=loaded.model_slug,
        max_batch_size=batching.max_batch_size,
        max_wait_ms=batching.max_wait_ms,
        max_queue=batching.max_queue,
    )
    loaded.extra["cross_stream_batcher"] = batcher
    loaded.extra["cross_stream_batching"] = batching
    return batcher


def _window(seconds: float = 7.0) -> np.ndarray:
    return np.zeros(int(seconds * 16000), dtype=np.float32)


class TestSettings:
    FIELDS = {
        "faster_whisper_batch_enabled": ("stt.fasterWhisper.batch.enabled", False),
        "faster_whisper_batch_max_batch_size": ("stt.fasterWhisper.batch.maxBatchSize", 8),
        "faster_whisper_batch_max_wait_ms": ("stt.fasterWhisper.batch.maxWaitMs", 25),
        "faster_whisper_batch_max_queue": ("stt.fasterWhisper.batch.maxQueue", 256),
    }

    @pytest.mark.parametrize("field", sorted(FIELDS))
    def test_each_knob_is_a_control_plane_key_with_its_default(self, field) -> None:
        key, default = self.FIELDS[field]
        assert CONTROL_PLANE_KEYS[field] == key
        assert Settings.model_fields[field].default == default

    def test_batching_is_off_by_default(self) -> None:
        settings = SimpleNamespace(
            **{f: Settings.model_fields[f].default for f in self.FIELDS},
        )
        assert CrossStreamBatching.from_settings(settings) is None

    def test_enabled_settings_become_the_batching_limits(self) -> None:
        settings = SimpleNamespace(
            faster_whisper_batch_enabled=True,
            faster_whisper_batch_max_batch_size=16,
            faster_whisper_batch_max_wait_ms=40,
            faster_whisper_batch_max_queue=128,
        )
        assert CrossStreamBatching.from_settings(settings) == CrossStreamBatching(
            max_batch_size=16, max_wait_ms=40, max_queue=128
        )


class TestAdapterDefaultUnchanged:
    def test_no_batching_means_no_submit_and_the_per_call_pipeline(self) -> None:
        loaded = _loaded()
        adapter = FasterWhisperAsrAdapter(loaded, InferenceConfig(language="ml"))

        assert adapter.submit(_window(), 16000) is None
        adapter(_window(), 16000, prompt="ctx")

        loaded.extra["batched_pipeline"].transcribe.assert_called_once()
        assert "cross_stream_batcher" not in loaded.extra


class TestAdapterBatching:
    def test_two_sessions_on_one_model_decode_in_one_batch(self) -> None:
        loaded = _loaded()
        recorder = _Recorder()
        pair = _batching(2)
        _install(loaded, recorder, pair)
        a = FasterWhisperAsrAdapter(loaded, InferenceConfig(language="ml"), batching=pair)
        b = FasterWhisperAsrAdapter(loaded, InferenceConfig(language="ml"), batching=pair)

        fa = a.submit(_window(), 16000, prompt="alpha")
        fb = b.submit(_window(), 16000, prompt=None)
        ra, rb = fa.result(timeout=5), fb.result(timeout=5)

        assert len(recorder.calls) == 1 and len(recorder.calls[0][1]) == 2
        assert [item.prompt for item in recorder.calls[0][1]] == ["alpha", None]
        # Mapped exactly like the per-call result; the pinned language wins.
        assert ra == {
            "text": "said alpha",
            "language": "ml",
            "word_timestamps": [{"word": "said", "start": 0.1, "end": 0.4, "confidence": 0.8}],
            "segments": [{"text": "said alpha", "start": 0.0, "end": 1.0}],
        }
        assert rb["text"] == "said nothing"
        loaded.extra["batched_pipeline"].transcribe.assert_not_called()

    def test_the_sync_call_waits_for_its_batch(self) -> None:
        loaded = _loaded()
        _install(loaded, _Recorder(), _batching(1))
        adapter = FasterWhisperAsrAdapter(loaded, InferenceConfig(), batching=_batching(1))

        assert adapter(_window(), 16000, prompt="x")["text"] == "said x"

    @pytest.mark.parametrize(
        ("config", "audio"),
        [
            # VAD inside the engine splits one call into several chunks.
            (InferenceConfig(language="ml", vad_filter=True), _window()),
            # >= 30 s cannot be one window without VAD; the per-call path owns it.
            (InferenceConfig(language="ml"), _window(30.0)),
            (InferenceConfig(language="ml"), _window(0.0)),
        ],
    )
    def test_windows_the_batch_cannot_hold_take_the_per_call_path(self, config, audio) -> None:
        loaded = _loaded()
        recorder = _Recorder()
        _install(loaded, recorder, _batching(1))
        adapter = FasterWhisperAsrAdapter(loaded, config, batching=_batching(1))

        assert adapter.submit(audio, 16000) is None
        adapter(audio, 16000)

        assert recorder.calls == []
        loaded.extra["batched_pipeline"].transcribe.assert_called_once()

    def test_sessions_with_different_decode_settings_never_share_a_key(self) -> None:
        loaded = _loaded()

        def key(config, task="transcribe"):
            return FasterWhisperAsrAdapter(loaded, config, task=task, batching=_BATCHING).batch_key

        base = key(InferenceConfig(language="ml", beam_size=5))
        assert key(InferenceConfig(language="ml", beam_size=5)) == base
        assert key(InferenceConfig(language="ml", beam_size=1)) != base
        assert key(InferenceConfig(language="en", beam_size=5)) != base
        assert key(InferenceConfig(language=None, beam_size=5)) != base
        assert key(InferenceConfig(language="ml", beam_size=5), task="translate") != base


class TestSharedBatcher:
    def test_one_batcher_per_model_reconfigured_by_later_sessions(self) -> None:
        loaded = _loaded()
        try:
            first = get_model_batcher(loaded, _BATCHING)
            again = get_model_batcher(
                loaded, CrossStreamBatching(max_batch_size=12, max_wait_ms=10, max_queue=64)
            )
            other = get_model_batcher(_loaded("other-model"), _BATCHING)

            assert first is again
            assert other is not first
            assert first._max_batch_size == 12  # noqa: SLF001 — the reconfigure landed
        finally:
            close_model_batcher(loaded)

    def test_closing_removes_and_stops_the_models_batcher(self) -> None:
        loaded = _loaded()
        batcher = get_model_batcher(loaded, _BATCHING)

        close_model_batcher(loaded)

        assert "cross_stream_batcher" not in loaded.extra
        with pytest.raises(RuntimeError, match="closed"):
            batcher.submit("k", "late")

    @pytest.mark.asyncio
    async def test_loader_unload_closes_the_batcher(self) -> None:
        from stt.models.faster_whisper_loader import FasterWhisperLoader

        loaded = _loaded()
        batcher = get_model_batcher(loaded, _BATCHING)

        with patch("stt.models.base_loader.cleanup_accelerator_memory"):
            await FasterWhisperLoader().unload(loaded)

        with pytest.raises(RuntimeError, match="closed"):
            batcher.submit("k", "late")


class TestSessionManagerWiring:
    def _manager(self):
        from stt.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)
        mgr._profile = MagicMock(asr_max_batch_size=4)
        mgr._make_faster_whisper_callable = SessionManager._make_faster_whisper_callable.__get__(
            mgr
        )
        return mgr

    @staticmethod
    def _limits() -> CrossStreamBatching:
        return CrossStreamBatching(max_batch_size=2, max_wait_ms=5_000, max_queue=16)

    @classmethod
    def _settings(cls, enabled: bool) -> SimpleNamespace:
        limits = cls._limits()
        return SimpleNamespace(
            faster_whisper_batch_enabled=enabled,
            faster_whisper_batch_max_batch_size=limits.max_batch_size,
            faster_whisper_batch_max_wait_ms=limits.max_wait_ms,
            faster_whisper_batch_max_queue=limits.max_queue,
        )

    @pytest.mark.asyncio
    async def test_off_by_default_the_callable_decodes_per_call(self) -> None:
        loaded = _loaded()
        with patch(
            "stt.streaming.session_manager.get_settings", return_value=self._settings(False)
        ):
            callable_ = self._manager()._make_faster_whisper_callable(
                loaded, InferenceConfig(language="ml")
            )
        await callable_(_window(), 16000, prompt="p")

        loaded.extra["batched_pipeline"].transcribe.assert_called_once()
        assert "cross_stream_batcher" not in loaded.extra

    @pytest.mark.asyncio
    async def test_enabled_concurrent_sessions_share_one_batch(self) -> None:
        loaded = _loaded()
        recorder = _Recorder()
        _install(loaded, recorder, self._limits())
        with patch("stt.streaming.session_manager.get_settings", return_value=self._settings(True)):
            mgr = self._manager()
            s1 = mgr._make_faster_whisper_callable(loaded, InferenceConfig(language="ml"))
            s2 = mgr._make_faster_whisper_callable(loaded, InferenceConfig(language="ml"))

        r1, r2 = await asyncio.gather(
            s1(_window(), 16000, prompt="one"), s2(_window(), 16000, prompt="two")
        )

        assert (r1["text"], r2["text"]) == ("said one", "said two")
        assert len(recorder.calls) == 1
        loaded.extra["batched_pipeline"].transcribe.assert_not_called()


class TestMetrics:
    def test_a_batch_records_size_wait_decode_time_and_depth(self) -> None:
        loaded = _loaded("metrics-model")
        labels = {"model": "metrics-model"}

        def sample(name: str) -> float:
            return REGISTRY.get_sample_value(name, labels) or 0.0

        before = {
            n: sample(n)
            for n in (
                "stt_asr_batch_size_count",
                "stt_asr_batch_size_sum",
                "stt_asr_batch_queue_wait_seconds_count",
                "stt_asr_batch_decode_seconds_count",
            )
        }
        pair = _batching(2)
        try:
            batcher = get_model_batcher(loaded, pair)
            batcher._decode_batch = _Recorder()  # noqa: SLF001 — no weights in a unit test
            futures = [
                FasterWhisperAsrAdapter(
                    loaded, InferenceConfig(language="ml"), batching=pair
                ).submit(_window(), 16000)
                for _ in range(2)
            ]
            concurrent.futures.wait(futures, timeout=5)
        finally:
            close_model_batcher(loaded)

        assert sample("stt_asr_batch_size_count") - before["stt_asr_batch_size_count"] == 1
        assert sample("stt_asr_batch_size_sum") - before["stt_asr_batch_size_sum"] == 2
        assert (
            sample("stt_asr_batch_queue_wait_seconds_count")
            - before["stt_asr_batch_queue_wait_seconds_count"]
            == 2
        )
        assert (
            sample("stt_asr_batch_decode_seconds_count")
            - before["stt_asr_batch_decode_seconds_count"]
            == 1
        )
        assert REGISTRY.get_sample_value("stt_asr_batch_queue_depth", labels) == 0
