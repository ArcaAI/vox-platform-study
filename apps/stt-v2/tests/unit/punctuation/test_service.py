"""Unit tests for the PunctuationService module (model registry)."""

from unittest.mock import MagicMock, patch

import pytest

from stt_v2.punctuation import service


@pytest.fixture(autouse=True)
def _reset_models():
    """Reset the module-level model registry before and after each test."""
    service._models.clear()
    service._default_model_name = None
    yield
    service._models.clear()
    service._default_model_name = None


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
