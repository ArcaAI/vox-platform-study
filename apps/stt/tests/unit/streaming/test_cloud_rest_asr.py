"""REST recognize + error-mapping tests for the cloud BYOK engines (TASK-567).

Mocked-httpx tier (test tier 2): validates the happy path and the
status -> CloudASR* taxonomy mapping for both Sarvam and OpenAI without any
real network or credentials.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import numpy as np
import pytest
from pydantic import SecretStr

from stt.core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
)
from stt.models.cloud_asr import CloudRestConfig
from stt.streaming.openai_asr import openai_recognize_utterance
from stt.streaming.sarvam_asr import sarvam_recognize_utterance

SAMPLES = np.zeros(1600, dtype=np.float32)
SR = 16000


def _config(provider: str) -> CloudRestConfig:
    return CloudRestConfig(
        provider=provider,
        api_key=SecretStr("secret-key"),
        base_url="https://api.example.test",
        model_name="model-x",
    )


def _mock_client(*, status_code: int, text: str, payload: dict | None = None):
    response = MagicMock(status_code=status_code, text=text)
    response.json.return_value = payload or {}
    client = MagicMock()
    client.post = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


def _mock_client_raising(exc: Exception):
    client = MagicMock()
    client.post = AsyncMock(side_effect=exc)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


# =============================================================================
# Sarvam
# =============================================================================


class TestSarvamRecognize:
    @pytest.mark.parametrize(
        ("language", "expected"),
        [
            ("en-IN", "en-IN"),
            ("en", "en-IN"),
            ("en-US", "en-IN"),
            ("ml", "ml-IN"),
        ],
    )
    @pytest.mark.asyncio
    async def test_happy_path(self, language, expected):
        client = _mock_client(status_code=200, text="ok", payload={"transcript": "hello"})
        with patch("stt.streaming.sarvam_asr.httpx.AsyncClient", return_value=client):
            result = await sarvam_recognize_utterance(_config("sarvam"), SAMPLES, SR, language)
        # No `language_code` in the payload → detected language is absent (None).
        assert result == {"text": "hello", "word_timestamps": [], "language": None}
        _, kwargs = client.post.call_args
        assert kwargs["data"]["language_code"] == expected
        assert kwargs["headers"]["api-subscription-key"] == "secret-key"

    @pytest.mark.parametrize("language", ["ml", "ml-IN", "ml-en"])
    @pytest.mark.asyncio
    async def test_code_switching_malayalam_pins_ml_in_with_codemix(self, language):
        # A Malayalam code-switch pipeline (ml / ml-*) must select Saaras'
        # code-mixed output (mode="codemix") and pin language_code="ml-IN".
        client = _mock_client(status_code=200, text="ok", payload={"transcript": "hello"})
        with patch("stt.streaming.sarvam_asr.httpx.AsyncClient", return_value=client):
            await sarvam_recognize_utterance(
                _config("sarvam"), SAMPLES, SR, language, code_switching=True
            )
        _, kwargs = client.post.call_args
        assert kwargs["data"]["mode"] == "codemix"
        assert kwargs["data"]["language_code"] == "ml-IN"

    @pytest.mark.asyncio
    async def test_code_switching_without_language_falls_back_to_unknown(self):
        # Defensive: no pipeline language -> codemix with auto-detect.
        client = _mock_client(status_code=200, text="ok", payload={"transcript": "hello"})
        with patch("stt.streaming.sarvam_asr.httpx.AsyncClient", return_value=client):
            await sarvam_recognize_utterance(
                _config("sarvam"), SAMPLES, SR, None, code_switching=True
            )
        _, kwargs = client.post.call_args
        assert kwargs["data"]["mode"] == "codemix"
        assert kwargs["data"]["language_code"] == "unknown"

    @pytest.mark.asyncio
    async def test_detected_language_code_is_surfaced(self):
        # Sarvam echoes the detected source language in `language_code`; it must
        # flow into the result so downstream metadata reports the REAL language.
        client = _mock_client(
            status_code=200, text="ok", payload={"transcript": "ഒരു", "language_code": "ml-IN"}
        )
        with patch("stt.streaming.sarvam_asr.httpx.AsyncClient", return_value=client):
            result = await sarvam_recognize_utterance(_config("sarvam"), SAMPLES, SR, "ml-en")
        assert result["language"] == "ml-IN"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("status", "exc"),
        [
            (401, CloudASRAuthError),
            (403, CloudASRAuthError),
            (429, CloudASRQuotaError),
            (500, CloudASRTranscriptionError),
            (400, CloudASRTranscriptionError),
        ],
    )
    async def test_status_maps_to_taxonomy(self, status, exc):
        client = _mock_client(status_code=status, text="boom")
        with patch("stt.streaming.sarvam_asr.httpx.AsyncClient", return_value=client):
            with pytest.raises(exc):
                await sarvam_recognize_utterance(_config("sarvam"), SAMPLES, SR)

    @pytest.mark.asyncio
    async def test_transport_error_is_transcription_error(self):
        client = _mock_client_raising(httpx.ConnectError("down"))
        with patch("stt.streaming.sarvam_asr.httpx.AsyncClient", return_value=client):
            with pytest.raises(CloudASRTranscriptionError):
                await sarvam_recognize_utterance(_config("sarvam"), SAMPLES, SR)


# =============================================================================
# OpenAI
# =============================================================================


class TestOpenAIRecognize:
    @pytest.mark.asyncio
    async def test_happy_path(self):
        client = _mock_client(status_code=200, text="ok", payload={"text": "world"})
        with patch("stt.streaming.openai_asr.httpx.AsyncClient", return_value=client):
            result = await openai_recognize_utterance(_config("openai"), SAMPLES, SR, "en-US")
        # Default json response carries no `language` → detected language is None.
        assert result == {"text": "world", "word_timestamps": [], "language": None}
        _, kwargs = client.post.call_args
        # BCP-47 reduced to ISO-639-1 primary, bearer auth
        assert kwargs["data"]["language"] == "en"
        assert kwargs["headers"]["Authorization"] == "Bearer secret-key"

    @pytest.mark.asyncio
    async def test_detected_language_is_surfaced_when_present(self):
        # verbose_json responses include `language`; carry it through.
        client = _mock_client(status_code=200, text="ok", payload={"text": "hola", "language": "es"})
        with patch("stt.streaming.openai_asr.httpx.AsyncClient", return_value=client):
            result = await openai_recognize_utterance(_config("openai"), SAMPLES, SR, "en-US")
        assert result["language"] == "es"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("status", "exc"),
        [
            (401, CloudASRAuthError),
            (429, CloudASRQuotaError),
            (503, CloudASRTranscriptionError),
        ],
    )
    async def test_status_maps_to_taxonomy(self, status, exc):
        client = _mock_client(status_code=status, text="boom")
        with patch("stt.streaming.openai_asr.httpx.AsyncClient", return_value=client):
            with pytest.raises(exc):
                await openai_recognize_utterance(_config("openai"), SAMPLES, SR)

    @pytest.mark.asyncio
    async def test_transport_error_is_transcription_error(self):
        client = _mock_client_raising(httpx.ReadTimeout("slow"))
        with patch("stt.streaming.openai_asr.httpx.AsyncClient", return_value=client):
            with pytest.raises(CloudASRTranscriptionError):
                await openai_recognize_utterance(_config("openai"), SAMPLES, SR)
