"""E9 (stt) — the durable-outbox log lines carry stable events, hashed ids and error types only."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from hope_obs import redact_id
from structlog.testing import capture_logs

from stt.core.exceptions import APIGatewayError
from tests.unit.test_streaming_recording import _make_manager

OUTBOX_KEY = "stt:transcript_outbox"
CONSULTATION = "consultation-99887-john-smith"
SECRET = "raw-persist-failure-detail"


def _entry() -> dict:
    return {
        "transcript_text": "Hello world",
        "consultation_id": CONSULTATION,
        "tenant_id": "t1",
        "transcription_source": "streaming",
        "idempotency_key": f"{CONSULTATION}:sess_rec",
        "attempts": 0,
        "lease_expiry": 0,
    }


@pytest.mark.asyncio
async def test_permanent_drop_logs_hashed_ids_and_error_type_only() -> None:
    mgr = _make_manager()
    mgr._redis.hgetall = AsyncMock(return_value={"k": json.dumps(_entry())})
    mgr._redis.hset = AsyncMock()
    mgr._redis.hdel = AsyncMock()
    gateway = MagicMock()
    gateway.create_transcript = AsyncMock(
        side_effect=APIGatewayError(SECRET, details={"status_code": 422})
    )
    mgr._get_api_client = MagicMock(return_value=gateway)

    with capture_logs() as logs:
        await mgr._drain_transcript_outbox()

    (line,) = [e for e in logs if e["event"] == "stt.transcript.outbox_permanent_drop"]
    assert line["consultation"] == redact_id(CONSULTATION)
    assert line["error_type"] == "APIGatewayError"
    assert CONSULTATION not in str(logs)
    assert SECRET not in str(logs)


@pytest.mark.asyncio
async def test_failed_outbox_delete_is_logged_not_swallowed() -> None:
    mgr = _make_manager()
    mgr._redis.hgetall = AsyncMock(return_value={"k": json.dumps(_entry())})
    mgr._redis.hset = AsyncMock()
    mgr._redis.hdel = AsyncMock(side_effect=ConnectionError(SECRET))
    gateway = MagicMock()
    gateway.create_transcript = AsyncMock(
        side_effect=APIGatewayError("bad", details={"status_code": 422})
    )
    mgr._get_api_client = MagicMock(return_value=gateway)

    with capture_logs() as logs:
        await mgr._drain_transcript_outbox()

    (line,) = [e for e in logs if e["event"] == "stt.transcript.outbox_delete_failed"]
    assert line["log_level"] == "debug"
    assert line["error_type"] == "ConnectionError"
    assert SECRET not in str(logs)
