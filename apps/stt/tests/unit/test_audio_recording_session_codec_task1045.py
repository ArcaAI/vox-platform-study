"""``create_audio_recording`` names the STT session and the stored codec.

The gateway's ``CreateAudioRecordRequest`` accepts ``sttSessionId`` (which session captured the
part) and ``codec`` (``opus`` / ``pcm_s16le``); the recording timeline reads both. A caller that
does not know them sends neither key, exactly as before.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from stt.core.api_client.gateway import APIGatewayClient


@pytest.fixture
def client() -> APIGatewayClient:
    return APIGatewayClient(base_url="http://localhost:8868/api/v1", api_key="k", timeout=30)


async def _payload(client: APIGatewayClient, **kwargs: Any) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    async def capture(method, path, json=None, params=None, headers=None):  # noqa: ANN001
        captured.update(json or {})
        return {"id": "ar-1"}

    with patch.object(client, "_request", side_effect=capture):
        await client.create_audio_recording(**kwargs)
    return captured


@pytest.mark.asyncio
async def test_the_session_and_codec_are_forwarded(client: APIGatewayClient) -> None:
    payload = await _payload(
        client,
        tenant_id="t-1",
        consultation_id="c-1",
        media_id="m-1",
        stt_session_id="sess-42",
        codec="opus",
    )
    assert payload["sttSessionId"] == "sess-42"
    assert payload["codec"] == "opus"


@pytest.mark.asyncio
async def test_neither_key_is_sent_when_the_caller_does_not_know_them(
    client: APIGatewayClient,
) -> None:
    payload = await _payload(client, tenant_id="t-1", consultation_id="c-1")
    assert "sttSessionId" not in payload
    assert "codec" not in payload


# ---------------------------------------------------------------------------
# The streaming finalize path (dual capture) names its session and codec.
# ---------------------------------------------------------------------------

_SID = "sess_codec"


def _manager_and_session(*, opus_ok: bool):  # noqa: ANN202
    from unittest.mock import AsyncMock, MagicMock

    from stt.pipeline.dto import DualCaptureConfig
    from stt.streaming.execution_profile import ExecutionProfile, PlatformType
    from stt.streaming.schemas import SessionMetadata, SessionStatus
    from stt.streaming.session import StreamSession
    from stt.streaming.session_manager import SessionManager

    profile = ExecutionProfile(
        platform=PlatformType.CPU,
        device_name="cpu-test",
        gpu_count=0,
        total_vram_gb=0,
        total_ram_gb=16,
        cpu_cores=4,
        asr_device="cpu",
        asr_compute_type="float32",
        asr_max_batch_size=2,
        asr_model_quantization="fp16",
        embedding_device="cpu",
        embedding_batch_size=2,
        preprocess_pool_size=2,
        max_concurrent_streams=10,
        batch_scheduler_max_wait_ms=500,
        multi_gpu_strategy="none",
    )
    redis = AsyncMock()
    redis.scan = AsyncMock(return_value=(0, []))
    mgr = SessionManager(redis=redis, profile=profile, worker_id="test-worker")

    session = StreamSession(
        metadata=SessionMetadata(
            session_id=_SID,
            tenant_id="t1",
            pipeline_id="p1",
            consultation_id="c1",
            status=SessionStatus.ACTIVE,
            sample_rate=16000,
        ),
        redis=AsyncMock(),
        persist_interval_s=5.0,
    )
    session.record_frame(0, b"\x10\x00" * 16000, 16000)
    mgr._dual_capture[_SID] = DualCaptureConfig(enabled=True, capture_raw=True)

    blob = MagicMock()
    if opus_ok:
        blob.upload_audio = AsyncMock(return_value="s3://audio/t1/c1/sess_codec-raw.ogg")
    else:
        blob.upload_audio = AsyncMock(side_effect=RuntimeError("upload down"))
    mgr._blob_service = blob
    gateway = MagicMock()
    gateway.create_media = AsyncMock(return_value={"id": "m1"})
    gateway.create_audio_recording = AsyncMock(return_value={})
    mgr._get_api_client = lambda: gateway
    return mgr, session, gateway


@pytest.mark.asyncio
async def test_dual_capture_names_the_session_and_the_opus_codec() -> None:
    mgr, session, gateway = _manager_and_session(opus_ok=True)

    await mgr._register_dual_capture(session, "s3://audio/raw/complete.wav", None)

    kwargs = gateway.create_audio_recording.await_args.kwargs
    assert kwargs["media_id"] == "m1"
    assert kwargs["stt_session_id"] == _SID
    assert kwargs["codec"] == "opus"


@pytest.mark.asyncio
async def test_dual_capture_wav_fallback_reports_pcm() -> None:
    mgr, session, gateway = _manager_and_session(opus_ok=False)

    await mgr._register_dual_capture(session, "s3://audio/raw/complete.wav", None)

    assert gateway.create_media.await_args.kwargs["extension"] == "wav"
    kwargs = gateway.create_audio_recording.await_args.kwargs
    assert kwargs["stt_session_id"] == _SID
    assert kwargs["codec"] == "pcm_s16le"
