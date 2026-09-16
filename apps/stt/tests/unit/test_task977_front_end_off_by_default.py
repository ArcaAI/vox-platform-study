"""TASK-977 lane 2 — the runtime half of "a disabled stage costs nothing, and
`resample` means something".

Stage EXECUTION was already gated on `enabled` on both paths; these tests cover the
two places where it was not:

* **D-4** — the model WARM. `_warm_and_pin_pipeline_models` (streaming) and
  `_load_models` (batch) keyed the load on REF PRESENCE alone, so a session that
  would never run VAD still fetched and pinned Silero's weights. The gateway lane
  stops shipping a ref for a disabled stage; this half refuses to load one even if a
  ref arrives, so neither side alone has to be trusted.
* **D-5** — `PreprocessingConfig.resample_enabled` never reached the STREAMING
  preprocessor at all (the batch path has honoured it since it was introduced). The
  contract is the batch path's: disabling resampling is honoured only when it is a
  no-op, and a genuine rate mismatch WARNS and resamples anyway, because VAD and ASR
  require the target rate. Wrong-rate audio is never passed through, and nothing raises.
"""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest
import structlog

from stt.pipeline.dto import (
    DenoiseConfig,
    DiarizationConfig,
    InferenceConfig,
    ModelRef,
    ModelRefs,
    PipelineConfig,
    PipelineSpec,
    PostprocessingConfig,
    PreprocessingConfig,
    VadConfig,
)
from stt.streaming.preprocessor import StreamingPreprocessor
from stt.streaming.session_manager import SessionManager

ASR_SLUG = "arcaai-whisper-large-ml-en-gguf"
VAD_SLUG = "silero-vad"
DENOISE_SLUG = "rnnoise"
EMBEDDING_SLUG = "ecapa-tdnn-voxceleb"


def _spec(
    *,
    vad_enabled: bool,
    denoise_enabled: bool,
    diarization_enabled: bool,
    resample_enabled: bool = True,
    target_sample_rate: int = 16000,
) -> PipelineSpec:
    """A spec that BINDS all four models — the case the gate has to decide.

    A stage with no model bound proves nothing here: the ref-presence check already
    skipped it. The defect is a bound model on a stage nobody enabled.
    """
    return PipelineSpec(
        version="agent/1",
        models=ModelRefs(
            asr=ModelRef(slug=ASR_SLUG),
            vad=ModelRef(slug=VAD_SLUG),
            denoise=ModelRef(slug=DENOISE_SLUG),
            embedding=ModelRef(slug=EMBEDDING_SLUG),
        ),
        preprocessing=PreprocessingConfig(
            target_sample_rate=target_sample_rate,
            resample_enabled=resample_enabled,
            vad=VadConfig(enabled=vad_enabled),
            denoise=DenoiseConfig(enabled=denoise_enabled),
        ),
        inference=InferenceConfig(),
        postprocessing=PostprocessingConfig(),
        diarization=DiarizationConfig(enabled=diarization_enabled),
    )


# ---------------------------------------------------------------------------
# D-4 — the streaming cache warm
# ---------------------------------------------------------------------------


class _RecordingCache:
    """Only what `_warm_and_pin_pipeline_models` touches, plus a load ledger."""

    def __init__(self) -> None:
        self.attempted: list[str] = []
        self.pinned: list[str] = []

    async def get_or_load_from_ref(self, *, model_ref, task_type, db_model_config):
        del task_type, db_model_config
        self.attempted.append(model_ref.slug)
        return SimpleNamespace(model_slug=model_ref.slug)

    async def pin_many(self, slugs):
        self.pinned.extend(slugs)


def _warm_manager(session_id: str = "sess-977") -> Any:
    """A bare `self` carrying only what the warm helper reads.

    `_session_specs` must hold the session id: without it `_load_optional` falls
    through to the deprecated (and disabled) registry reader instead of the cache.
    """
    return SimpleNamespace(_session_specs={session_id: SimpleNamespace(model_configs={})})


async def _warm(spec: PipelineSpec, cache: _RecordingCache) -> list[str]:
    return await SessionManager._warm_and_pin_pipeline_models(
        _warm_manager(),
        cache,
        spec,
        tenant_id=None,
        session_id="sess-977",
    )


@pytest.mark.unit
class TestADisabledStageCostsZeroModelLoads:
    async def test_all_three_stages_disabled_warms_nothing_but_asr(self) -> None:
        """The owner's rule, stated as a cost: "disabled" must not fetch weights.

        Silero is not a runtime-owned library, so its weights are genuinely
        downloaded and pinned — on every session of every tenant that never asked
        for segmentation.
        """
        cache = _RecordingCache()
        pinned = await _warm(
            _spec(vad_enabled=False, denoise_enabled=False, diarization_enabled=False), cache
        )

        assert cache.attempted == []
        assert pinned == [ASR_SLUG]
        assert cache.pinned == [ASR_SLUG]

    async def test_an_enabled_stage_still_warms_its_model(self) -> None:
        """The inverse defect: the gate must not become "never warm anything"."""
        cache = _RecordingCache()
        pinned = await _warm(
            _spec(vad_enabled=True, denoise_enabled=True, diarization_enabled=True), cache
        )

        assert cache.attempted == [VAD_SLUG, DENOISE_SLUG, EMBEDDING_SLUG]
        assert set(pinned) == {ASR_SLUG, VAD_SLUG, DENOISE_SLUG, EMBEDDING_SLUG}

    @pytest.mark.parametrize(
        ("vad", "denoise", "diarization", "expected"),
        [
            (True, False, False, [VAD_SLUG]),
            (False, True, False, [DENOISE_SLUG]),
            (False, False, True, [EMBEDDING_SLUG]),
        ],
    )
    async def test_each_stage_is_gated_on_its_own_flag(
        self, vad: bool, denoise: bool, diarization: bool, expected: list[str]
    ) -> None:
        """Three independent decisions — enabling one must not warm the others.

        The embedding model belongs to DIARIZATION, whose flag lives on
        `PipelineSpec.diarization`, not under `preprocessing`; reading it off the
        wrong block is how a "gated" warm stays unconditional.
        """
        cache = _RecordingCache()
        await _warm(
            _spec(vad_enabled=vad, denoise_enabled=denoise, diarization_enabled=diarization), cache
        )

        assert cache.attempted == expected

    async def test_a_config_without_a_preprocessing_block_falls_back_to_the_dataclass_defaults(
        self,
    ) -> None:
        """The gate reads defensively, and its fallback is a DECLARED one.

        A config with no `preprocessing`/`diarization` block must behave exactly
        like a default `PipelineSpec` rather than raising. Since TASK-977 moved
        `VadConfig.enabled` to False, every stage's dataclass default is OFF — so
        the expectation is DERIVED from the dataclasses, not written down: a blanket
        "everything off" in the gate would pass a hardcoded `[]` today and silently
        stop following a default the day one of them changes.
        """
        cache = _RecordingCache()
        await _warm(
            SimpleNamespace(  # type: ignore[arg-type]
                models=ModelRefs(
                    asr=ModelRef(slug=ASR_SLUG),
                    vad=ModelRef(slug=VAD_SLUG),
                    denoise=ModelRef(slug=DENOISE_SLUG),
                    embedding=ModelRef(slug=EMBEDDING_SLUG),
                )
            ),
            cache,
        )

        expected = [
            slug
            for slug, on in (
                (VAD_SLUG, VadConfig().enabled),
                (DENOISE_SLUG, DenoiseConfig().enabled),
                (EMBEDDING_SLUG, DiarizationConfig().enabled),
            )
            if on
        ]
        assert cache.attempted == expected


# ---------------------------------------------------------------------------
# D-4 — the batch model load
# ---------------------------------------------------------------------------


def _batch_pipeline(**kwargs: bool) -> PipelineConfig:
    return PipelineConfig(
        id="p-977",
        tenant_id="t-977",
        slug="task-977",
        name="TASK-977",
        description=None,
        spec=_spec(diarization_enabled=False, **kwargs),  # type: ignore[arg-type]
        tags=[],
        created_at=datetime(2026, 9, 16),
        updated_at=datetime(2026, 9, 16),
    )


async def _load_batch_models(pipeline: PipelineConfig) -> tuple[dict[str, Any], MagicMock]:
    from stt.transcription.batch_service import BatchTranscriptionService

    cache = AsyncMock()
    cache.get_or_load = AsyncMock(side_effect=lambda cfg: SimpleNamespace(slug=cfg.slug))
    model_configs = {
        slug: SimpleNamespace(slug=slug, format="ONNX")
        for slug in (ASR_SLUG, VAD_SLUG, DENOISE_SLUG, EMBEDDING_SLUG)
    }

    with patch("stt.transcription.batch_service.get_model_cache", return_value=cache):
        models = await BatchTranscriptionService._load_models(
            MagicMock(), pipeline, model_configs=model_configs  # type: ignore[arg-type]
        )
    return models, cache


@pytest.mark.unit
class TestTheBatchPathAlsoSkipsDisabledStages:
    async def test_a_disabled_vad_and_denoise_load_no_weights(self) -> None:
        models, cache = await _load_batch_models(
            _batch_pipeline(vad_enabled=False, denoise_enabled=False)
        )

        assert models["vad"] is None
        assert models["denoise"] is None
        loaded = [call.args[0].slug for call in cache.get_or_load.await_args_list]
        assert loaded == [ASR_SLUG]

    async def test_enabled_stages_still_load(self) -> None:
        models, cache = await _load_batch_models(
            _batch_pipeline(vad_enabled=True, denoise_enabled=True)
        )

        assert models["vad"] is not None
        assert models["denoise"] is not None
        loaded = [call.args[0].slug for call in cache.get_or_load.await_args_list]
        assert loaded == [ASR_SLUG, VAD_SLUG, DENOISE_SLUG]


# ---------------------------------------------------------------------------
# D-5 — the streaming preprocessor honours `resample`
# ---------------------------------------------------------------------------


def _preprocessor(**kwargs: Any) -> StreamingPreprocessor:
    defaults: dict[str, Any] = {
        "session_id": "sess-977",
        "sample_rate": 16000,
        "vad_service": MagicMock(),
    }
    defaults.update(kwargs)
    return StreamingPreprocessor(**defaults)


def _warnings(logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [entry for entry in logs if entry["log_level"] == "warning"]


@pytest.fixture
def _isolate_structlog():
    """`capture_logs()` cannot intercept a logger frozen by an earlier test's
    `setup_logging` (cache_logger_on_first_use)."""
    from stt.streaming import preprocessor

    saved_config = structlog.get_config()
    saved_logger = preprocessor.logger
    structlog.reset_defaults()
    preprocessor.logger = structlog.get_logger("stt.streaming.preprocessor")
    try:
        yield
    finally:
        preprocessor.logger = saved_logger
        structlog.configure(**saved_config)


@pytest.mark.unit
@pytest.mark.usefixtures("_isolate_structlog")
class TestResampleIsOnByDefaultAndTheFlagIsHonest:
    def test_resampling_is_on_by_default(self) -> None:
        """The owner kept resampling ON: this ticket makes the flag truthful, not off."""
        assert PreprocessingConfig().resample_enabled is True

        with structlog.testing.capture_logs() as logs:
            pre = _preprocessor(sample_rate=48000, target_sample_rate=16000)

        assert pre.resample_enabled is True
        assert _warnings(logs) == []

    def test_disabling_it_is_honoured_when_it_is_a_no_op(self) -> None:
        """Input already at the target rate: nothing to skip, so nothing to warn about."""
        with structlog.testing.capture_logs() as logs:
            pre = _preprocessor(
                sample_rate=16000, target_sample_rate=16000, resample_enabled=False
            )

        assert pre.resample_enabled is False
        assert _warnings(logs) == []

        frame = np.random.randn(512).astype(np.float32)
        assert np.array_equal(pre._resample_frame(frame), frame)

    def test_a_rate_mismatch_warns_and_resamples_anyway(self) -> None:
        """`resample: false` must never hand 48 kHz audio to a 16 kHz VAD/ASR.

        The batch path already resolves this the same way (`preprocessing.py`): the
        skip is refused, loudly, rather than honoured into a wrong answer or raised
        into a failed session.
        """
        with structlog.testing.capture_logs() as logs:
            pre = _preprocessor(
                sample_rate=48000, target_sample_rate=16000, resample_enabled=False
            )

        warnings = _warnings(logs)
        assert len(warnings) == 1, f"expected exactly one warning, got {warnings}"
        assert "48000" in str(warnings[0]) and "16000" in str(warnings[0])

        # ...and the audio is still converted: 3:1 decimation, not a passthrough.
        out = pre._resample_frame(np.random.randn(1536).astype(np.float32))
        assert out.shape[0] == pytest.approx(512, abs=2)

    def test_the_warning_is_emitted_once_per_session_not_once_per_frame(self) -> None:
        """A 32 ms frame cadence makes a per-frame warning a log flood, not a signal."""
        with structlog.testing.capture_logs() as logs:
            pre = _preprocessor(
                sample_rate=48000, target_sample_rate=16000, resample_enabled=False
            )
            for _ in range(10):
                pre._resample_frame(np.random.randn(1536).astype(np.float32))

        assert len(_warnings(logs)) == 1


@pytest.mark.unit
class TestTheFlagReachesTheStreamingPreprocessor:
    async def test_assembly_forwards_resample_enabled_from_the_spec(self) -> None:
        """Before this ticket `grep -rn resample_enabled streaming/` returned nothing."""
        from stt.streaming.execution_profile import ExecutionProfile, PlatformType

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
            denoise_enabled_default=False,
            max_concurrent_streams=4,
            batch_scheduler_max_wait_ms=500,
            vad_silence_threshold_ms=700,
            multi_gpu_strategy="none",
        )
        manager = SessionManager(redis=AsyncMock(), profile=profile, worker_id="w-977")
        manager._load_vad_service = AsyncMock(return_value=MagicMock())  # type: ignore[method-assign]
        manager._load_asr_pipeline = AsyncMock(return_value=(AsyncMock(), None))  # type: ignore[method-assign]
        manager._load_gloss_pipeline = AsyncMock(return_value=None)  # type: ignore[method-assign]

        spec = _spec(
            vad_enabled=True,
            denoise_enabled=False,
            diarization_enabled=False,
            resample_enabled=False,
        )

        with patch("stt.streaming.session_manager.ResultPublisher"):
            runtime = await manager._assemble_session_runtime(
                session_id="sess-977",
                tenant_id="t-977",
                consultation_id=None,
                user_id=None,
                sample_rate=16000,
                pipeline_config=spec,
                build_speaker_identifier=False,
            )

        assert runtime.preprocessor.resample_enabled is False
