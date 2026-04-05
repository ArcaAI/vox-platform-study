from unittest.mock import MagicMock

import numpy as np
import pytest
import torch


class TestSessionManagerAsrCallable:

    @pytest.mark.asyncio
    async def test_make_asr_callable_returns_text_and_timestamps(self):
        from stt_v2.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)

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
