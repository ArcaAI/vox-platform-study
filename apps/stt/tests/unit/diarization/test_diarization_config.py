"""Unit tests for session-based diarization config."""

from stt.pipeline.dto import DiarizationConfig, ModelRef, ModelRefs


class TestDiarizationConfigDefaults:
    """Test new DiarizationConfig fields have correct defaults."""

    def test_default_values(self):
        config = DiarizationConfig()
        assert config.enabled is False
        assert config.high_threshold == 0.7
        assert config.low_threshold == 0.4
        assert config.max_speakers == 2
        assert config.min_segment_duration_s == 1.0
        assert config.segment_silence_padding_ms == 100
        assert config.min_update_confidence == 0.8
        assert config.enable_segmentation_refinement is True
        assert config.max_embeddings_per_speaker == 8
        # Embedding clustering is the only diarization backend (TASK-980).
        assert config.backend == "embedding"

    def test_removed_fields_do_not_exist(self):
        config = DiarizationConfig()
        assert not hasattr(config, "similarity_threshold")
        assert not hasattr(config, "auto_register_speakers")
        assert not hasattr(config, "ema_alpha")
        assert not hasattr(config, "ema_min_confidence")


class TestModelRefsSegmentation:
    """Test segmentation model ref added to ModelRefs."""

    def test_segmentation_none_by_default(self):
        refs = ModelRefs(asr=ModelRef(slug="whisper"))
        assert refs.segmentation is None

    def test_segmentation_in_get_all_refs(self):
        seg_ref = ModelRef(slug="segmentation-3.0")
        refs = ModelRefs(asr=ModelRef(slug="whisper"), segmentation=seg_ref)
        role_names = [r[0] for r in refs.get_all_refs()]
        assert "segmentation" in role_names

    def test_segmentation_in_get_all_slugs(self):
        seg_ref = ModelRef(slug="segmentation-3.0")
        refs = ModelRefs(asr=ModelRef(slug="whisper"), segmentation=seg_ref)
        assert "segmentation-3.0" in refs.get_all_slugs()

    def test_segmentation_in_get_inline_models(self):
        from stt.pipeline.dto import AiModelFormat, InlineModelDef

        inline = InlineModelDef(
            hf_model_id="pyannote/segmentation-3.0",
            engine=AiModelFormat.PYTORCH,
        )
        seg_ref = ModelRef(inline=inline)
        refs = ModelRefs(asr=ModelRef(slug="whisper"), segmentation=seg_ref)
        inlines = refs.get_inline_models()
        role_names = [r[0] for r in inlines]
        assert "segmentation" in role_names


class TestDiarizationBackendSelector:
    """``backend`` stays a declared key, but ``embedding`` is its only value (TASK-980)."""

    def test_backend_defaults_to_embedding(self):
        assert DiarizationConfig().backend == "embedding"
