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
