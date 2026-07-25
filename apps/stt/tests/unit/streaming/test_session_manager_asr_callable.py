from unittest.mock import MagicMock

import numpy as np
import pytest

from stt.pipeline.dto import AiModelFormat

torch = pytest.importorskip("torch")


def _bind_asr_dispatch(mgr):
    """_make_asr_callable dispatches through registry adapters
    that call back into per-engine builder methods on the manager; bind the
    real ones onto MagicMock(spec=SessionManager) harnesses."""
    from stt.streaming.session_manager import SessionManager

    for _name in (
        "_make_nemo_callable",
        "_make_faster_whisper_callable",
        "_make_azure_callable",
        "_make_transformers_callable",
        "_make_multimodal_lm_callable",
    ):
        setattr(mgr, _name, getattr(SessionManager, _name).__get__(mgr))
    return mgr


class TestSessionManagerAsrCallable:

    @pytest.mark.asyncio
    async def test_make_asr_callable_returns_text_and_timestamps(self):
        from stt.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)

        _bind_asr_dispatch(mgr)

        # Build a mock LoadedModel with .model, .processor, .device
        fake_output = torch.tensor([[1, 2, 3]])
        mock_model = MagicMock()
        mock_model.dtype = torch.float32
        mock_model.generate.return_value = fake_output

        mock_processor = MagicMock()
        mock_processor.batch_decode.return_value = ["  Xin chào.  "]
        mock_processor.decode.return_value = {
            "offsets": [
                {"text": "Xin", "timestamp": (0.5, 0.7)},
                {"text": "chào.", "timestamp": (0.7, 1.0)},
            ]
        }

        mock_asr_model = MagicMock()
        mock_asr_model.model = mock_model
        mock_asr_model.processor = mock_processor
        mock_asr_model.feature_extractor = None
        mock_asr_model.device = torch.device("cpu")
        mock_asr_model.format = AiModelFormat.SAFETENSOR

        run_inference = SessionManager._make_asr_callable(
            mgr,
            asr_model=mock_asr_model,
            inference_config=MagicMock(beam_size=1, code_switching=False, language="vi"),
        )

        samples = np.zeros(16000, dtype=np.float32)
        result = await run_inference(samples, 16000)

        assert result["text"] == "Xin chào."
        assert len(result["word_timestamps"]) == 2
        assert result["word_timestamps"][0]["word"] == "Xin"
        assert result["word_timestamps"][0]["start"] == 0.5

    @staticmethod
    def _make_mock_asr_model():
        fake_output = torch.tensor([[1, 2, 3]])
        mock_model = MagicMock()
        mock_model.dtype = torch.float32
        mock_model.generate.return_value = fake_output

        mock_processor = MagicMock()
        mock_processor.batch_decode.return_value = ["text"]
        mock_processor.decode.return_value = {"offsets": []}

        mock_asr_model = MagicMock()
        mock_asr_model.model = mock_model
        mock_asr_model.processor = mock_processor
        mock_asr_model.feature_extractor = None
        mock_asr_model.device = torch.device("cpu")
        mock_asr_model.format = AiModelFormat.SAFETENSOR
        return mock_asr_model, mock_model

    @pytest.mark.asyncio
    async def test_code_switching_with_language_pins_language(self):
        """CS + language set means PINNED matrix language:
        the language kwarg must reach generate() (previously omitted)."""
        from stt.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)

        _bind_asr_dispatch(mgr)
        mock_asr_model, mock_model = self._make_mock_asr_model()

        run_inference = SessionManager._make_asr_callable(
            mgr,
            asr_model=mock_asr_model,
            inference_config=MagicMock(
                beam_size=1, code_switching=True, language="ml"
            ),
        )
        await run_inference(np.zeros(16000, dtype=np.float32), 16000)

        gen_kwargs = mock_model.generate.call_args.kwargs
        assert gen_kwargs["language"] == "ml"

    @pytest.mark.asyncio
    async def test_code_switching_without_language_keeps_auto_lid(self):
        """language: null + code_switching keeps auto-LID (no language kwarg)."""
        from stt.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)

        _bind_asr_dispatch(mgr)
        mock_asr_model, mock_model = self._make_mock_asr_model()

        run_inference = SessionManager._make_asr_callable(
            mgr,
            asr_model=mock_asr_model,
            inference_config=MagicMock(
                beam_size=1, code_switching=True, language=None
            ),
        )
        await run_inference(np.zeros(16000, dtype=np.float32), 16000)

        gen_kwargs = mock_model.generate.call_args.kwargs
        assert "language" not in gen_kwargs
