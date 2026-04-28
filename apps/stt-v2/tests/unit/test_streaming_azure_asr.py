"""Unit tests for Azure Speech SDK streaming ASR helper.

Tests cover:
- azure_recognize_utterance: PCM conversion, push stream setup,
  recognized speech, no-match (silence), cancellation error mapping,
  word timestamp extraction
- _extract_word_timestamps: JSON parsing, empty/missing NBest
- _raise_for_cancellation: auth, quota, generic error mapping
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from stt_v2.core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
)
from stt_v2.streaming.azure_asr import (
    _extract_word_timestamps,
    _raise_for_cancellation,
    azure_recognize_utterance,
)

# =============================================================================
# Helpers
# =============================================================================

def _make_samples(duration_s: float = 0.5, sample_rate: int = 16000) -> np.ndarray:
    """Generate a short sine wave as float32 samples."""
    t = np.linspace(0, duration_s, int(sample_rate * duration_s), endpoint=False)
    return (np.sin(2 * np.pi * 440 * t) * 0.8).astype(np.float32)


def _nbest_json(words: list[dict] | None = None, confidence: float = 0.95) -> str:
    """Build a realistic Azure NBest JSON payload."""
    entry: dict[str, Any] = {"Confidence": confidence}
    if words is not None:
        entry["Words"] = words
    else:
        entry["Words"] = [
            {"Word": "hello", "Offset": 5_000_000, "Duration": 3_000_000, "Confidence": 0.97},
            {"Word": "world", "Offset": 9_000_000, "Duration": 4_000_000, "Confidence": 0.93},
        ]
    return json.dumps({"NBest": [entry]})


# =============================================================================
# azure_recognize_utterance — happy path
# =============================================================================


class TestAzureRecognizeUtterance:
    """Tests for the main azure_recognize_utterance function."""

    @patch("stt_v2.streaming.azure_asr.speechsdk")
    def test_recognized_speech_returns_text_and_timestamps(self, mock_sdk: MagicMock) -> None:
        """Recognized speech returns dict with text and word_timestamps."""
        # Set up result
        result = MagicMock()
        result.reason = mock_sdk.ResultReason.RecognizedSpeech
        result.text = "hello world"
        result.json = _nbest_json()

        recognizer = MagicMock()
        recognizer.recognize_once_async.return_value.get.return_value = result
        mock_sdk.SpeechRecognizer.return_value = recognizer

        speech_config = MagicMock()
        samples = _make_samples()

        out = azure_recognize_utterance(speech_config, samples, 16000, "en-US")

        assert out["text"] == "hello world"
        assert len(out["word_timestamps"]) == 2
        assert out["word_timestamps"][0]["word"] == "hello"
        assert out["word_timestamps"][1]["word"] == "world"

    @patch("stt_v2.streaming.azure_asr.speechsdk")
    def test_no_match_returns_empty(self, mock_sdk: MagicMock) -> None:
        """NoMatch result returns empty text and no timestamps."""
        result = MagicMock()
        result.reason = mock_sdk.ResultReason.NoMatch

        recognizer = MagicMock()
        recognizer.recognize_once_async.return_value.get.return_value = result
        mock_sdk.SpeechRecognizer.return_value = recognizer

        speech_config = MagicMock()
        samples = _make_samples()

        out = azure_recognize_utterance(speech_config, samples, 16000, "en-US")

        assert out["text"] == ""
        assert out["word_timestamps"] == []

    @patch("stt_v2.streaming.azure_asr.speechsdk")
    def test_canceled_auth_error_raises(self, mock_sdk: MagicMock) -> None:
        """Canceled with 401 raises CloudASRAuthError."""
        result = MagicMock()
        result.reason = mock_sdk.ResultReason.Canceled
        result.cancellation_details.error_details = "401 Unauthorized"
        result.cancellation_details.reason = "Error"

        recognizer = MagicMock()
        recognizer.recognize_once_async.return_value.get.return_value = result
        mock_sdk.SpeechRecognizer.return_value = recognizer

        speech_config = MagicMock()
        samples = _make_samples()

        with pytest.raises(CloudASRAuthError):
            azure_recognize_utterance(speech_config, samples, 16000, "en-US")

    @patch("stt_v2.streaming.azure_asr.speechsdk")
    def test_canceled_quota_error_raises(self, mock_sdk: MagicMock) -> None:
        """Canceled with 429 raises CloudASRQuotaError."""
        result = MagicMock()
        result.reason = mock_sdk.ResultReason.Canceled
        result.cancellation_details.error_details = "429 throttled"
        result.cancellation_details.reason = "Error"

        recognizer = MagicMock()
        recognizer.recognize_once_async.return_value.get.return_value = result
        mock_sdk.SpeechRecognizer.return_value = recognizer

        speech_config = MagicMock()
        samples = _make_samples()

        with pytest.raises(CloudASRQuotaError):
            azure_recognize_utterance(speech_config, samples, 16000, "en-US")

    @patch("stt_v2.streaming.azure_asr.speechsdk")
    def test_canceled_generic_error_raises(self, mock_sdk: MagicMock) -> None:
        """Canceled with unknown error raises CloudASRTranscriptionError."""
        result = MagicMock()
        result.reason = mock_sdk.ResultReason.Canceled
        result.cancellation_details.error_details = "Connection lost"
        result.cancellation_details.reason = "Error"

        recognizer = MagicMock()
        recognizer.recognize_once_async.return_value.get.return_value = result
        mock_sdk.SpeechRecognizer.return_value = recognizer

        speech_config = MagicMock()
        samples = _make_samples()

        with pytest.raises(CloudASRTranscriptionError):
            azure_recognize_utterance(speech_config, samples, 16000, "en-US")

    @patch("stt_v2.streaming.azure_asr.speechsdk")
    def test_push_stream_receives_pcm_bytes(self, mock_sdk: MagicMock) -> None:
        """Verify PCM bytes are written to the push stream."""
        result = MagicMock()
        result.reason = mock_sdk.ResultReason.RecognizedSpeech
        result.text = "test"
        result.json = _nbest_json(words=[])

        recognizer = MagicMock()
        recognizer.recognize_once_async.return_value.get.return_value = result
        mock_sdk.SpeechRecognizer.return_value = recognizer

        push_stream = MagicMock()
        mock_sdk.audio.PushAudioInputStream.return_value = push_stream

        samples = _make_samples(duration_s=0.1, sample_rate=16000)
        speech_config = MagicMock()

        azure_recognize_utterance(speech_config, samples, 16000, "en-US")

        # Verify write was called with bytes of correct length
        push_stream.write.assert_called_once()
        written_bytes = push_stream.write.call_args[0][0]
        expected_len = len(samples) * 2  # 16-bit = 2 bytes per sample
        assert len(written_bytes) == expected_len
        push_stream.close.assert_called_once()

    @patch("stt_v2.streaming.azure_asr.speechsdk")
    def test_code_switching_uses_auto_detect(self, mock_sdk: MagicMock) -> None:
        """When code_switching=True, AutoDetectSourceLanguageConfig is used."""
        result = MagicMock()
        result.reason = mock_sdk.ResultReason.RecognizedSpeech
        result.text = "test"
        result.json = _nbest_json(words=[])

        recognizer = MagicMock()
        recognizer.recognize_once_async.return_value.get.return_value = result
        mock_sdk.SpeechRecognizer.return_value = recognizer

        speech_config = MagicMock()
        samples = _make_samples()

        azure_recognize_utterance(speech_config, samples, 16000, "en-US", code_switching=True)

        # AutoDetectSourceLanguageConfig should have been created
        mock_sdk.languageconfig.AutoDetectSourceLanguageConfig.assert_called_once()
        # SpeechRecognizer should have been called with auto_detect kwarg
        call_kwargs = mock_sdk.SpeechRecognizer.call_args
        assert "auto_detect_source_language_config" in call_kwargs.kwargs

    @patch("stt_v2.streaming.azure_asr.speechsdk")
    def test_no_code_switching_sets_language(self, mock_sdk: MagicMock) -> None:
        """When code_switching=False, speech_recognition_language is set."""
        result = MagicMock()
        result.reason = mock_sdk.ResultReason.RecognizedSpeech
        result.text = "test"
        result.json = _nbest_json(words=[])

        recognizer = MagicMock()
        recognizer.recognize_once_async.return_value.get.return_value = result
        mock_sdk.SpeechRecognizer.return_value = recognizer

        speech_config = MagicMock()
        samples = _make_samples()

        azure_recognize_utterance(speech_config, samples, 16000, "ml-IN", code_switching=False)

        assert speech_config.speech_recognition_language == "ml-IN"


# =============================================================================
# _extract_word_timestamps
# =============================================================================


class TestExtractWordTimestamps:
    """Tests for word timestamp extraction from Azure result."""

    def test_parses_valid_nbest_json(self) -> None:
        """Correctly parses word timestamps from NBest JSON."""
        result = MagicMock()
        result.json = _nbest_json()

        timestamps = _extract_word_timestamps(result)

        assert len(timestamps) == 2
        assert timestamps[0]["word"] == "hello"
        assert timestamps[0]["start"] == pytest.approx(0.5)  # 5_000_000 / 10_000_000
        assert timestamps[0]["end"] == pytest.approx(0.8)    # (5M + 3M) / 10M
        assert timestamps[1]["word"] == "world"

    def test_empty_json_returns_empty_list(self) -> None:
        """Empty JSON string returns empty list."""
        result = MagicMock()
        result.json = ""

        assert _extract_word_timestamps(result) == []

    def test_no_nbest_returns_empty_list(self) -> None:
        """JSON without NBest key returns empty list."""
        result = MagicMock()
        result.json = json.dumps({"other": "data"})

        assert _extract_word_timestamps(result) == []

    def test_malformed_json_returns_empty_list(self) -> None:
        """Malformed JSON returns empty list without raising."""
        result = MagicMock()
        result.json = "not json"

        assert _extract_word_timestamps(result) == []


# =============================================================================
# _raise_for_cancellation
# =============================================================================


class TestRaiseForCancellation:
    """Tests for cancellation error mapping."""

    def test_auth_error(self) -> None:
        cancellation = MagicMock()
        cancellation.error_details = "401 Unauthorized access"
        cancellation.reason = "Error"
        with pytest.raises(CloudASRAuthError):
            _raise_for_cancellation(cancellation)

    def test_quota_error(self) -> None:
        cancellation = MagicMock()
        cancellation.error_details = "429 throttled"
        cancellation.reason = "Error"
        with pytest.raises(CloudASRQuotaError):
            _raise_for_cancellation(cancellation)

    def test_generic_error(self) -> None:
        cancellation = MagicMock()
        cancellation.error_details = "Something went wrong"
        cancellation.reason = "Error"
        with pytest.raises(CloudASRTranscriptionError):
            _raise_for_cancellation(cancellation)

    def test_empty_error_details(self) -> None:
        cancellation = MagicMock()
        cancellation.error_details = ""
        cancellation.reason = "Error"
        with pytest.raises(CloudASRTranscriptionError):
            _raise_for_cancellation(cancellation)
