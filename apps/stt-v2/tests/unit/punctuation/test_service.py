"""Unit tests for the PunctuationService module (model registry)."""

from unittest.mock import MagicMock, patch

import pytest

from stt_v2.punctuation import service


@pytest.fixture(autouse=True)
def _reset_models():
    """Reset the module-level model registry before and after each test."""
    service._models.clear()
    service._default_model_name = None
    service._enabled = True
    service._suppression_warned = False
    yield
    service._models.clear()
    service._default_model_name = None
    service._enabled = True
    service._suppression_warned = False


class TestInitialize:
    @patch("stt_v2.punctuation.service.get_settings")
    def test_initialize_loads_default_model(self, mock_settings):
        mock_instance = MagicMock()
        settings = MagicMock()
        settings.punctuation_model_name = "Cadence-Fast"
        settings.punctuation_model_cache_dir = None
        settings.punctuation_device = "cpu"
        settings.punctuation_max_length = 300
        mock_settings.return_value = settings

        MockModel = MagicMock(return_value=mock_instance)
        with patch.dict("sys.modules", {"cadence": MagicMock(PunctuationModel=MockModel)}):
            service.initialize()

        assert service._models["Cadence-Fast"] is mock_instance
        assert service._default_model_name == "Cadence-Fast"

    @patch("stt_v2.punctuation.service.get_settings")
    def test_initialize_idempotent(self, mock_settings):
        existing_model = MagicMock()
        service._models["Cadence-Fast"] = existing_model
        settings = MagicMock()
        settings.punctuation_model_name = "Cadence-Fast"
        mock_settings.return_value = settings

        service.initialize()

        assert service._models["Cadence-Fast"] is existing_model

    @patch("stt_v2.punctuation.service.get_settings")
    def test_initialize_returns_true_when_model_loaded(self, mock_settings):
        """TASK-348 MIN-12: callers condition their 'initialized' log on the outcome."""
        settings = MagicMock()
        settings.punctuation_model_name = "Cadence-Fast"
        settings.punctuation_model_cache_dir = None
        settings.punctuation_device = "cpu"
        settings.punctuation_max_length = 300
        mock_settings.return_value = settings

        with patch.dict("sys.modules", {"cadence": MagicMock(PunctuationModel=MagicMock())}):
            assert service.initialize() is True

    @patch("stt_v2.punctuation.service.get_settings")
    def test_initialize_returns_true_when_already_initialized(self, mock_settings):
        service._models["Cadence-Fast"] = MagicMock()
        settings = MagicMock()
        settings.punctuation_model_name = "Cadence-Fast"
        mock_settings.return_value = settings

        assert service.initialize() is True

    @patch("stt_v2.punctuation.service.logger.info")
    @patch("stt_v2.punctuation.service.get_settings")
    def test_initialize_enables_bidirectional_without_transformers_patch(
        self,
        mock_settings,
        mock_logger_info,
    ):
        settings = MagicMock()
        settings.punctuation_model_name = "Cadence-Fast"
        settings.punctuation_model_cache_dir = None
        settings.punctuation_device = "cpu"
        settings.punctuation_max_length = 300
        mock_settings.return_value = settings

        config = MagicMock()
        config.use_bidirectional_attention = False

        inner = MagicMock()
        inner.config = config

        outer = MagicMock()
        outer.model = inner

        model_instance = MagicMock()
        model_instance.model = outer

        mock_model_cls = MagicMock(return_value=model_instance)
        with patch.dict("sys.modules", {"cadence": MagicMock(PunctuationModel=mock_model_cls)}):
            service.initialize()

        assert config.use_bidirectional_attention is True
        monkey_patch_calls = [
            call
            for call in mock_logger_info.call_args_list
            if call.args
            and call.args[0] == "Monkey-patched gemma3 mask creation for bidirectional attention"
        ]
        assert not monkey_patch_calls


class TestInitializeFailure:
    """MIN-10 (TASK-348): a failed model load must flip the service to
    disabled/passthrough. Leaving ``_enabled=True`` after a failed
    ``initialize()`` makes every subsequent utterance re-attempt the failing
    Cadence load (latent crash-loop, dodged today only because the global
    default is off)."""

    @staticmethod
    def _enabled_settings():
        settings = MagicMock()
        settings.punctuation_enabled = True
        settings.punctuation_model_name = "Cadence"
        settings.punctuation_model_cache_dir = None
        settings.punctuation_device = "cpu"
        settings.punctuation_max_length = 300
        return settings

    @patch(
        "stt_v2.punctuation.service._load_model",
        side_effect=RuntimeError("cadence load failed"),
    )
    @patch("stt_v2.punctuation.service.get_settings")
    def test_failed_initialize_disables_punctuation(self, mock_settings, mock_load):
        mock_settings.return_value = self._enabled_settings()

        with pytest.raises(RuntimeError, match="cadence load failed"):
            service.initialize()

        assert service._enabled is False
        assert service._models == {}
        assert service._default_model_name is None

    @pytest.mark.asyncio
    @patch(
        "stt_v2.punctuation.service._load_model",
        side_effect=RuntimeError("cadence load failed"),
    )
    @patch("stt_v2.punctuation.service.get_settings")
    async def test_punctuate_passthrough_no_reload_after_failed_initialize(
        self, mock_settings, mock_load
    ):
        mock_settings.return_value = self._enabled_settings()
        with pytest.raises(RuntimeError):
            service.initialize()

        result = await service.punctuate("hello world how are you")

        assert result == "hello world how are you"
        # one attempt from initialize() -- punctuate() must NOT retry the load
        assert mock_load.call_count == 1

    @pytest.mark.asyncio
    @patch(
        "stt_v2.punctuation.service._load_model",
        side_effect=RuntimeError("cadence load failed"),
    )
    @patch("stt_v2.punctuation.service.get_settings")
    async def test_punctuate_batch_passthrough_no_reload_after_failed_initialize(
        self, mock_settings, mock_load
    ):
        mock_settings.return_value = self._enabled_settings()
        with pytest.raises(RuntimeError):
            service.initialize()

        result = await service.punctuate_batch(["hello", "world"])

        assert result == ["hello", "world"]
        assert mock_load.call_count == 1

    @patch(
        "stt_v2.punctuation.service._load_model",
        side_effect=RuntimeError("cadence load failed"),
    )
    @patch("stt_v2.punctuation.service.get_settings")
    def test_punctuate_sync_passthrough_no_reload_after_failed_initialize(
        self, mock_settings, mock_load
    ):
        mock_settings.return_value = self._enabled_settings()
        with pytest.raises(RuntimeError):
            service.initialize()

        result = service.punctuate_sync(["hello", "world"])

        assert result == ["hello", "world"]
        assert mock_load.call_count == 1

    @pytest.mark.asyncio
    @patch(
        "stt_v2.punctuation.service._load_model",
        side_effect=RuntimeError("cadence load failed"),
    )
    @patch("stt_v2.punctuation.service.get_settings")
    async def test_repeated_calls_never_reattempt_load(self, mock_settings, mock_load):
        """The crash-loop regression guard: many utterances, still one load attempt."""
        mock_settings.return_value = self._enabled_settings()
        with pytest.raises(RuntimeError):
            service.initialize()

        for _ in range(5):
            assert await service.punctuate("hello world") == "hello world"
            assert service.punctuate_sync(["hello"]) == ["hello"]
            assert await service.punctuate_batch(["hello"]) == ["hello"]

        assert mock_load.call_count == 1


class TestPunctuationDisabled:
    """When PUNCTUATION_ENABLED is false, Cadence must never be loaded and all
    punctuation entry points must pass text through unchanged. This keeps the
    boot log free of Cadence's FATAL traceback under the pinned transformers
    5.x (incompatible with cadence-punctuation 1.1.0)."""

    @patch("stt_v2.punctuation.service.get_settings")
    def test_initialize_skips_cadence_when_disabled(self, mock_settings):
        settings = MagicMock()
        settings.punctuation_enabled = False
        mock_settings.return_value = settings

        model_cls = MagicMock()
        with patch.dict("sys.modules", {"cadence": MagicMock(PunctuationModel=model_cls)}):
            service.initialize()

        model_cls.assert_not_called()
        assert service._models == {}
        assert service._enabled is False

    @patch("stt_v2.punctuation.service.logger")
    @patch("stt_v2.punctuation.service.get_settings")
    def test_initialize_returns_false_and_logs_disabled_message(self, mock_settings, mock_logger):
        """TASK-348 TG-5/MIN-12: the disabled path logs the disabled message and
        returns False so callers don't log a contradictory 'initialized' line."""
        settings = MagicMock()
        settings.punctuation_enabled = False
        mock_settings.return_value = settings

        result = service.initialize()

        assert result is False
        info_messages = [c.args[0] for c in mock_logger.info.call_args_list if c.args]
        assert any("Punctuation restoration disabled" in m for m in info_messages)
        assert not any("Punctuation service initialized" in m for m in info_messages)

    @pytest.mark.asyncio
    @patch("stt_v2.punctuation.service.get_settings")
    async def test_punctuate_passthrough_when_disabled(self, mock_settings):
        settings = MagicMock()
        settings.punctuation_enabled = False
        mock_settings.return_value = settings

        service.initialize()
        result = await service.punctuate("hello world how are you")

        assert result == "hello world how are you"

    @pytest.mark.asyncio
    @patch("stt_v2.punctuation.service.get_settings")
    async def test_punctuate_batch_passthrough_when_disabled(self, mock_settings):
        settings = MagicMock()
        settings.punctuation_enabled = False
        mock_settings.return_value = settings

        service.initialize()
        result = await service.punctuate_batch(["hello", "world"])

        assert result == ["hello", "world"]

    @patch("stt_v2.punctuation.service.get_settings")
    def test_punctuate_sync_passthrough_when_disabled(self, mock_settings):
        settings = MagicMock()
        settings.punctuation_enabled = False
        mock_settings.return_value = settings

        service.initialize()
        result = service.punctuate_sync(["hello", "world"])

        assert result == ["hello", "world"]


class TestSuppressionWarning:
    """TASK-348 MIN-11: the global kill-switch silently overrides per-pipeline
    `punctuation.enabled: true` YAML. A pipeline-requested punctuation call that
    gets suppressed must emit exactly one warning per process documenting the
    precedence -- not zero (silent) and not one per utterance (log spam)."""

    @staticmethod
    def _suppression_warnings(mock_logger):
        return [
            c
            for c in mock_logger.warning.call_args_list
            if c.args and "suppressed" in c.args[0].lower()
        ]

    @pytest.mark.asyncio
    @patch("stt_v2.punctuation.service.logger")
    @patch("stt_v2.punctuation.service.get_settings")
    async def test_suppressed_pipeline_request_warns_exactly_once(self, mock_settings, mock_logger):
        settings = MagicMock()
        settings.punctuation_enabled = False
        mock_settings.return_value = settings
        service.initialize()

        # Callers only invoke these entry points when the pipeline YAML
        # requested punctuation -- repeat across all three entry points.
        await service.punctuate("hello world")
        await service.punctuate("hello again")
        service.punctuate_sync(["hello"])
        await service.punctuate_batch(["hello", "world"])

        assert len(self._suppression_warnings(mock_logger)) == 1

    @pytest.mark.asyncio
    @patch("stt_v2.punctuation.service.logger")
    async def test_no_suppression_warning_when_enabled(self, mock_logger):
        mock_model = MagicMock()
        mock_model.punctuate.return_value = ["Hello."]
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = mock_model

        await service.punctuate("hello")

        assert self._suppression_warnings(mock_logger) == []


class TestGetModel:
    def test_get_model_before_init_raises(self):
        with pytest.raises(RuntimeError, match="not initialized"):
            service.get_model()

    def test_get_model_returns_default(self):
        mock_model = MagicMock()
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = mock_model

        result = service.get_model()

        assert result is mock_model

    def test_get_model_returns_specific(self):
        default_model = MagicMock()
        other_model = MagicMock()
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = default_model
        service._models["Cadence"] = other_model

        result = service.get_model("Cadence")

        assert result is other_model

    def test_get_model_none_uses_default(self):
        mock_model = MagicMock()
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = mock_model

        result = service.get_model(None)

        assert result is mock_model

    @patch("stt_v2.punctuation.service._load_model")
    def test_get_model_lazy_loads_unknown(self, mock_load):
        new_model = MagicMock()
        mock_load.return_value = new_model
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = MagicMock()

        result = service.get_model("Cadence")

        assert result is new_model
        mock_load.assert_called_once_with("Cadence")
        assert service._models["Cadence"] is new_model


class TestPunctuate:
    @pytest.mark.asyncio
    async def test_punctuate_empty_returns_empty(self):
        result = await service.punctuate("")
        assert result == ""

    @pytest.mark.asyncio
    async def test_punctuate_whitespace_returns_whitespace(self):
        result = await service.punctuate("   ")
        assert result == "   "

    @pytest.mark.asyncio
    async def test_punctuate_returns_punctuated(self):
        mock_model = MagicMock()
        mock_model.punctuate.return_value = ["Hello world, how are you?"]
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = mock_model

        result = await service.punctuate("hello world how are you")

        assert result == "Hello world, how are you?"
        mock_model.punctuate.assert_called_once_with(
            ["hello world how are you"], batch_size=1
        )

    @pytest.mark.asyncio
    async def test_punctuate_with_specific_model(self):
        default_model = MagicMock()
        other_model = MagicMock()
        other_model.punctuate.return_value = ["Hello."]
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = default_model
        service._models["Cadence"] = other_model

        result = await service.punctuate("hello", model_name="Cadence")

        assert result == "Hello."
        other_model.punctuate.assert_called_once_with(["hello"], batch_size=1)
        default_model.punctuate.assert_not_called()


class TestPunctuateBatch:
    @pytest.mark.asyncio
    async def test_punctuate_batch_empty_returns_empty(self):
        result = await service.punctuate_batch([])
        assert result == []

    @pytest.mark.asyncio
    async def test_punctuate_batch(self):
        mock_model = MagicMock()
        mock_model.punctuate.return_value = ["Hello.", "World."]
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = mock_model

        result = await service.punctuate_batch(["hello", "world"])

        assert result == ["Hello.", "World."]
        mock_model.punctuate.assert_called_once_with(
            ["hello", "world"], batch_size=8
        )

    @pytest.mark.asyncio
    async def test_punctuate_batch_with_model_name(self):
        other_model = MagicMock()
        other_model.punctuate.return_value = ["Hello.", "World."]
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = MagicMock()
        service._models["Cadence"] = other_model

        result = await service.punctuate_batch(["hello", "world"], model_name="Cadence")

        assert result == ["Hello.", "World."]
        other_model.punctuate.assert_called_once()


class TestPunctuateSync:
    def test_punctuate_sync_empty_returns_empty(self):
        result = service.punctuate_sync([])
        assert result == []

    def test_punctuate_sync(self):
        mock_model = MagicMock()
        mock_model.punctuate.return_value = ["Hello.", "World."]
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = mock_model

        result = service.punctuate_sync(["hello", "world"])

        assert result == ["Hello.", "World."]

    def test_punctuate_sync_with_model_name(self):
        other_model = MagicMock()
        other_model.punctuate.return_value = ["Hello.", "World."]
        service._default_model_name = "Cadence-Fast"
        service._models["Cadence-Fast"] = MagicMock()
        service._models["Cadence"] = other_model

        result = service.punctuate_sync(["hello", "world"], model_name="Cadence")

        assert result == ["Hello.", "World."]
        other_model.punctuate.assert_called_once()


class TestShutdown:
    def test_shutdown_clears_all_models(self):
        service._models["Cadence-Fast"] = MagicMock()
        service._models["Cadence"] = MagicMock()
        service._default_model_name = "Cadence-Fast"

        service.shutdown()

        assert len(service._models) == 0
        assert service._default_model_name is None
