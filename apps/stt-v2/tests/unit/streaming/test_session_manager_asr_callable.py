from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt_v2.transcription.dto import RawTranscription


class TestSessionManagerAsrCallable:

    @pytest.mark.asyncio
    async def test_make_asr_callable_uses_matching_translated_segment(self):
        from stt_v2.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)

        mock_raw = RawTranscription(
            text="Xin chào.",
            language="vi",
            segments=[
                {
                    "text": "Hello.",
                    "english_text": "Hello.",
                    "start": 0.0,
                    "end": 0.5,
                },
                {
                    "text": "Xin chào.",
                    "english_text": "Hello.",
                    "start": 0.5,
                    "end": 1.0,
                },
            ],
            word_timestamps=[{"word": "Xin", "start": 0.5, "end": 0.7}],
        )

        mock_batch_service = MagicMock()
        mock_batch_service._run_inference = AsyncMock(return_value=mock_raw)

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.transcription.batch_service": MagicMock(
                    BatchTranscriptionService=lambda: mock_batch_service
                ),
            },
        ):
            run_inference = SessionManager._make_asr_callable(
                mgr,
                asr_model=MagicMock(),
                inference_config=MagicMock(),
            )

        result = await run_inference(MagicMock(), 16000)

        assert result["text"] == "Xin chào."
        assert result["english_text"] == "Hello."
        assert result["language"] == "vi"
        assert result["word_timestamps"] == [{"word": "Xin", "start": 0.5, "end": 0.7}]
