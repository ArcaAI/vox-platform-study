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
    @pytest.mark.asyncio
    async def test_happy_path(self):
        client = _mock_client(status_code=200, text="ok", payload={"transcript": "hello"})
        with patch("stt.streaming.sarvam_asr.httpx.AsyncClient", return_value=client):
            result = await sarvam_recognize_utterance(_config("sarvam"), SAMPLES, SR, "en-IN")
        assert result == {"text": "hello", "word_timestamps": []}
        # language_code forwarded, key sent in header
        _, kwargs = client.post.call_args
        assert kwargs["data"]["language_code"] == "en-IN"
        assert kwargs["headers"]["api-subscription-key"] == "secret-key"

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
        assert result == {"text": "world", "word_timestamps": []}
        _, kwargs = client.post.call_args
        # BCP-47 reduced to ISO-639-1 primary, bearer auth
        assert kwargs["data"]["language"] == "en"
        assert kwargs["headers"]["Authorization"] == "Bearer secret-key"

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
