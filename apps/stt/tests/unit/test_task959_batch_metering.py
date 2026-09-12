"""TASK-959 §3.2/§4.2 — the batch completion callback carries compute + network.

`processingTimeSeconds` has ridden this callback since TASK-874 and the gateway
stores it, but it emitted only an `AUDIO_SECOND` row, so the occupancy seconds
were dropped on the floor. Two things make them billable, and both are wire
fields on `APIGatewayClient.complete_job` (TASK-959 §10.2):

* `device` — which decides the UNIT (`cuda`/`mps` -> GPU_SECOND, `cpu` ->
  CPU_SECOND). Without it the seconds are unattributable to any rate.
* `requestBytes` / `responseBytes` / `byteSource` — the only per-tenant network
  figures that can exist, since the pod-level cAdvisor network series are
  dropped at scrape.

Each is omitted from the JSON body when `None`, never sent as `null`, so an
un-upgraded gateway sees an unchanged request shape — the same contract the
TASK-874/958 fields already keep.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest
from pydantic import SecretStr

from stt.core.api_client.gateway import APIGatewayClient
from stt.core.metering import BYTE_SOURCE_APP, BYTE_SOURCE_WIRE
from stt.models.base_loader import LoadedModel
from stt.models.cloud_asr import CloudRestConfig
from stt.pipeline.dto import AiModelFormat
from stt.transcription.batch_service import BatchTranscriptionService
from stt.transcription.dto import RawTranscription, TranscriptionResult

SAMPLES = np.zeros(1600, dtype=np.float32)
SR = 16000


@pytest.fixture
def client():
    return APIGatewayClient(base_url="http://localhost:8868/api/v1", api_key="test-key")


def _capture(client):
    captured: dict = {}

    async def capture_request(method, path, json=None, params=None, headers=None):
        captured["json"] = json
        return {"id": "job-123", "status": "COMPLETED"}

    return captured, patch.object(client, "_request", side_effect=capture_request)


class TestCompleteJobCarriesTheComputeAndNetworkFields:
    @pytest.mark.asyncio
    async def test_device_and_bytes_reach_the_gateway_as_typed_top_level_fields(self, client):
        captured, patched = _capture(client)
        with patched:
            await client.complete_job(
                "job-123",
                result_text="text",
                processing_time_seconds=12.5,
                device="cuda",
                request_bytes=4096,
                response_bytes=512,
                byte_source=BYTE_SOURCE_WIRE,
            )

        body = captured["json"]
        assert body["processingTimeSeconds"] == 12.5
        assert body["device"] == "cuda"
        assert body["requestBytes"] == 4096
        assert body["responseBytes"] == 512
        assert body["byteSource"] == "wire"

    @pytest.mark.asyncio
    async def test_the_new_fields_are_omitted_not_nulled_when_unknown(self, client):
        """A self-hosted engine made no network call: the ABSENCE of the byte
        keys is the signal, and it keeps the shape an older gateway accepts."""
        captured, patched = _capture(client)
        with patched:
            await client.complete_job(
                "job-123", result_text="text", processing_time_seconds=3.0, device="cpu"
            )

        body = captured["json"]
        assert body["device"] == "cpu"
        assert "requestBytes" not in body
        assert "responseBytes" not in body
        assert "byteSource" not in body

    @pytest.mark.asyncio
    async def test_zero_bytes_is_a_real_measurement_and_is_sent(self, client):
        captured, patched = _capture(client)
        with patched:
            await client.complete_job(
                "job-123",
                result_text="text",
                request_bytes=0,
                response_bytes=0,
                byte_source=BYTE_SOURCE_WIRE,
            )

        assert captured["json"]["requestBytes"] == 0
        assert captured["json"]["responseBytes"] == 0

    @pytest.mark.asyncio
    async def test_task958_connection_id_is_untouched_beside_them(self, client):
        captured, patched = _capture(client)
        with patched:
            await client.complete_job(
                "job-123",
                result_text="text",
                engine="sarvam",
                deployment="BYOK",
                connection_id="conn-1",
                device="cpu",
            )

        body = captured["json"]
        assert body["connectionId"] == "conn-1"
        assert body["engine"] == "sarvam"
        assert body["deployment"] == "BYOK"


class TestTheResultCarriesThemFromThePipelineToTheCallback:
    def test_raw_transcription_declares_the_byte_counters(self):
        raw = RawTranscription(text="x", request_bytes=10, response_bytes=20, byte_source="wire")
        assert (raw.request_bytes, raw.response_bytes, raw.byte_source) == (10, 20, "wire")

    def test_a_self_hosted_run_leaves_them_none(self):
        raw = RawTranscription(text="x")
        assert raw.request_bytes is None
        assert raw.response_bytes is None
        assert raw.byte_source is None

    def test_transcription_result_declares_device_and_the_byte_counters(self):
        result = TranscriptionResult(text="x")
        assert result.device is None
        assert result.request_bytes is None
        assert result.response_bytes is None
        assert result.byte_source is None

    def test_the_metering_fields_stay_out_of_the_encrypted_metadata_blob(self):
        """Like engine/deployment/connection_id: anything trapped only inside
        `resultMetadata` is unqueryable once the gateway encrypts that blob."""
        result = TranscriptionResult(
            text="x", device="cuda", request_bytes=1, response_bytes=2, byte_source="wire"
        )
        dumped = result.to_dict()
        for key in ("device", "request_bytes", "response_bytes", "byte_source"):
            assert key not in dumped


class TestTheCloudBatchAdaptersForwardTheirByteCounts:
    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    def _cloud_model(self, fmt: AiModelFormat) -> LoadedModel:
        return LoadedModel(
            model_id="m1",
            model_slug="slug",
            model=CloudRestConfig(
                provider="sarvam",
                api_key=SecretStr("k"),
                base_url="https://api.example.test",
                model_name="model-x",
            ),
            format=fmt,
            device="cloud",
        )

    @pytest.mark.asyncio
    async def test_sarvam_batch_inference_copies_the_adapter_counters(self, service):
        with patch(
            "stt.streaming.sarvam_asr.sarvam_recognize_utterance",
            AsyncMock(
                return_value={
                    "text": "hello",
                    "word_timestamps": [],
                    "request_bytes": 4096,
                    "response_bytes": 128,
                    "byte_source": BYTE_SOURCE_WIRE,
                }
            ),
        ):
            raw = await service._run_sarvam_inference(
                SAMPLES, SR, self._cloud_model(AiModelFormat.SARVAM), MagicMock(language="ml")
            )

        assert raw.request_bytes == 4096
        assert raw.response_bytes == 128
        assert raw.byte_source == BYTE_SOURCE_WIRE

    @pytest.mark.asyncio
    async def test_openai_batch_inference_copies_the_adapter_counters(self, service):
        with patch(
            "stt.streaming.openai_asr.openai_recognize_utterance",
            AsyncMock(
                return_value={
                    "text": "hello",
                    "word_timestamps": [],
                    "request_bytes": 2048,
                    "response_bytes": 64,
                    "byte_source": BYTE_SOURCE_WIRE,
                }
            ),
        ):
            raw = await service._run_openai_inference(
                SAMPLES, SR, self._cloud_model(AiModelFormat.OPENAI), MagicMock(language="en")
            )

        assert raw.request_bytes == 2048
        assert raw.response_bytes == 64
        assert raw.byte_source == BYTE_SOURCE_WIRE

    @pytest.mark.asyncio
    async def test_azure_foundry_counts_the_wav_it_posted_and_the_body_it_read(self, service):
        body = b'{"combinedPhrases":[{"text":"hi"}],"phrases":[]}'
        response = MagicMock(status_code=200, text=body.decode())
        response.content = body
        response.json.return_value = {"combinedPhrases": [{"text": "hi"}], "phrases": []}
        http = MagicMock()
        http.post = AsyncMock(return_value=response)
        http.__aenter__ = AsyncMock(return_value=http)
        http.__aexit__ = AsyncMock(return_value=False)

        model = LoadedModel(
            model_id="m1",
            model_slug="slug",
            model={"endpoint": "https://foundry.example.test", "api_key": "k"},
            format=AiModelFormat.AZURE_FOUNDRY,
            device="cloud",
        )

        with patch("httpx.AsyncClient", return_value=http):
            raw = await service._run_azure_foundry_inference(
                SAMPLES, SR, model, MagicMock(language=None)
            )

        assert raw.response_bytes == len(body)
        # A 16 kHz PCM_16 WAV of 1600 frames: 3200 data bytes plus the header.
        assert raw.request_bytes > 3200
        assert raw.byte_source == BYTE_SOURCE_WIRE

    def test_azure_speech_batch_reports_application_level_proxies(self, service):
        """The conversation transcriber gives no HTTP layer either, so the WAV we
        fed it and the result JSON it emitted are labelled `app`."""
        import json as _json

        from azure.cognitiveservices.speech import ResultReason

        result_json = _json.dumps({"NBest": [{"Confidence": 0.9, "Words": []}]})

        azure_result = MagicMock()
        azure_result.reason = ResultReason.RecognizedSpeech
        azure_result.text = "hello"
        azure_result.offset = 0
        azure_result.duration = 10_000_000
        azure_result.speaker_id = "Guest-1"
        azure_result.json = result_json
        evt = MagicMock()
        evt.result = azure_result

        transcriber = MagicMock()

        def start(mock=transcriber):
            for call in mock.transcribed.connect.call_args_list:
                call[0][0](evt)
            for call in mock.session_stopped.connect.call_args_list:
                call[0][0](MagicMock())

        transcriber.start_transcribing_async = start

        with (
            patch("stt.transcription.batch_service.audio.AudioConfig", MagicMock()),
            patch(
                "stt.transcription.batch_service.transcription.ConversationTranscriber",
                return_value=transcriber,
            ),
        ):
            raw = service._azure_transcribe_sync(MagicMock(), SAMPLES, SR, "en-US")

        assert raw.text == "hello"
        assert raw.request_bytes > 3200  # the WAV we handed the SDK
        assert raw.response_bytes == len(result_json)
        assert raw.byte_source == BYTE_SOURCE_APP
