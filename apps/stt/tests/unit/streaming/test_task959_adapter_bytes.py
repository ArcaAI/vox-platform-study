"""TASK-959 §4.2 — the cloud ASR adapters count the bytes they actually moved.

Per-tenant network bytes can ONLY come from the application: there is no
Cilium/Hubble/Istio on this deployment, `NetworkPolicy` enforces without
counting, and the per-pod cAdvisor `container_network_*_bytes_total` series are
dropped at scrape by the cardinality keep-list. So each adapter reports its own
two numbers, and says WHICH kind of number it is:

* the REST adapters (Sarvam, OpenAI) see the real request and response, so
  `byte_source == "wire"`;
* the Azure Speech SDK talks over its own websocket and never shows us an HTTP
  layer, so the PCM we handed it and the result JSON it handed back are an
  application-level PROXY — `byte_source == "app"`, which is what stops a later
  exact figure from silently changing the meaning of rows written today.

A failed attempt reports nothing (TASK-959 §6.2, stated blind spot): these
counts ride the SUCCESS return value, so a raised `CloudASR*` carries none.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest
from pydantic import SecretStr

from stt.core.metering import BYTE_SOURCE_APP, BYTE_SOURCE_WIRE
from stt.models.cloud_asr import CloudRestConfig, wav_bytes_from_samples

SAMPLES = np.zeros(1600, dtype=np.float32)
SR = 16000
#: What the adapters will actually POST — asserted against, not approximated.
WAV_LEN = len(wav_bytes_from_samples(SAMPLES, SR))
RESPONSE_BODY = b'{"transcript":"hello there","text":"hello there"}'


def _config(provider: str) -> CloudRestConfig:
    return CloudRestConfig(
        provider=provider,
        api_key=SecretStr("secret-key"),
        base_url="https://api.example.test",
        model_name="model-x",
    )


def _mock_client(payload: dict, *, content: bytes = RESPONSE_BODY):
    response = MagicMock(status_code=200, text=content.decode())
    response.content = content
    response.json.return_value = payload
    client = MagicMock()
    client.post = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


class TestSarvamCountsItsWireBytes:
    @pytest.mark.asyncio
    async def test_request_and_response_bytes_are_the_real_payload_lengths(self):
        from stt.streaming.sarvam_asr import sarvam_recognize_utterance

        with patch("httpx.AsyncClient", return_value=_mock_client({"transcript": "hello there"})):
            result = await sarvam_recognize_utterance(_config("sarvam"), SAMPLES, SR, "ml")

        assert result["request_bytes"] == WAV_LEN
        assert result["response_bytes"] == len(RESPONSE_BODY)
        assert result["byte_source"] == BYTE_SOURCE_WIRE
        # The counting must not disturb what the adapter already returns.
        assert result["text"] == "hello there"

    @pytest.mark.asyncio
    async def test_an_empty_body_counts_zero_rather_than_omitting_the_key(self):
        """`0` is a real measurement; a missing key would read as "unknown"."""
        from stt.streaming.sarvam_asr import sarvam_recognize_utterance

        with patch("httpx.AsyncClient", return_value=_mock_client({"transcript": ""}, content=b"")):
            result = await sarvam_recognize_utterance(_config("sarvam"), SAMPLES, SR, "ml")

        assert result["response_bytes"] == 0
        assert result["request_bytes"] == WAV_LEN


class TestOpenAiCountsItsWireBytes:
    @pytest.mark.asyncio
    async def test_request_and_response_bytes_are_the_real_payload_lengths(self):
        from stt.streaming.openai_asr import openai_recognize_utterance

        with patch("httpx.AsyncClient", return_value=_mock_client({"text": "hello there"})):
            result = await openai_recognize_utterance(_config("openai"), SAMPLES, SR, "en")

        assert result["request_bytes"] == WAV_LEN
        assert result["response_bytes"] == len(RESPONSE_BODY)
        assert result["byte_source"] == BYTE_SOURCE_WIRE
        assert result["text"] == "hello there"


class TestAzureSpeechReportsApplicationLevelProxies:
    """The SDK's encoded wire bytes are opaque, so we report what we can see and
    label it — never a wire figure we did not measure."""

    def _speech_config(self):
        return MagicMock()

    def _patched_recognizer(self, *, text: str, result_json: str):
        import azure.cognitiveservices.speech as speechsdk

        result = MagicMock()
        result.reason = speechsdk.ResultReason.RecognizedSpeech
        result.text = text
        result.json = result_json

        recognizer = MagicMock()
        recognizer.recognize_once_async.return_value.get.return_value = result
        return recognizer

    def test_pcm_in_and_result_json_out_are_labelled_app(self):
        from stt.streaming.azure_asr import azure_recognize_utterance

        result_json = '{"NBest":[{"Confidence":0.9,"Words":[]}]}'
        recognizer = self._patched_recognizer(text="hello", result_json=result_json)

        with (
            patch("azure.cognitiveservices.speech.SpeechRecognizer", return_value=recognizer),
            patch("azure.cognitiveservices.speech.audio.PushAudioInputStream"),
            patch("azure.cognitiveservices.speech.audio.AudioConfig"),
            patch("azure.cognitiveservices.speech.audio.AudioStreamFormat"),
        ):
            out = azure_recognize_utterance(self._speech_config(), SAMPLES, SR, "en-US")

        # 1600 float32 samples -> 1600 int16 frames -> 3200 bytes of PCM.
        assert out["request_bytes"] == SAMPLES.size * 2
        assert out["response_bytes"] == len(result_json)
        assert out["byte_source"] == BYTE_SOURCE_APP
        assert out["text"] == "hello"

    def test_a_no_match_still_reports_the_pcm_it_sent(self):
        """Azure was paid for the audio whether or not it recognised anything."""
        import azure.cognitiveservices.speech as speechsdk

        from stt.streaming.azure_asr import azure_recognize_utterance

        result = MagicMock()
        result.reason = speechsdk.ResultReason.NoMatch
        recognizer = MagicMock()
        recognizer.recognize_once_async.return_value.get.return_value = result

        with (
            patch("azure.cognitiveservices.speech.SpeechRecognizer", return_value=recognizer),
            patch("azure.cognitiveservices.speech.audio.PushAudioInputStream"),
            patch("azure.cognitiveservices.speech.audio.AudioConfig"),
            patch("azure.cognitiveservices.speech.audio.AudioStreamFormat"),
        ):
            out = azure_recognize_utterance(self._speech_config(), SAMPLES, SR, "en-US")

        assert out["text"] == ""
        assert out["request_bytes"] == SAMPLES.size * 2
        assert out["response_bytes"] == 0
        assert out["byte_source"] == BYTE_SOURCE_APP
