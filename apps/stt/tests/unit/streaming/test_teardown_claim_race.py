"""The gateway's DELETE must carry the teardown summary even when it loses the race.

Seen live: the client's ``stop`` wrote a control ``FINALIZE``, that finalizer
claimed the tail flush, and the gateway's
``DELETE /internal/streaming/sessions/{id}`` arrived while it was still running.
The DELETE waited for the tail, found the session CLOSED by the other finalizer
and answered **204** — while that finalizer stashed the summary for a claim that
never came. Two minutes later the stash expired (``teardown_stash_unclaimed``)
and metering fell to the push-back backstop.

The DELETE now claims that summary once the other finalizer is done — after the
recording upload, never instead of it — and answers 204 only when there is
genuinely nothing to claim. Its wait on the other finalizer is bounded and never
cuts that finalizer's upload short.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi import FastAPI

_PCM = b"\x00\x01" * 1600  # 100 ms at 16 kHz


def _make_session(session_id: str = "sess_claim_race"):
    from stt.streaming.schemas import SessionMetadata, SessionStatus
    from stt.streaming.session import StreamSession

    meta = SessionMetadata(
        session_id=session_id,
        tenant_id="t1",
        pipeline_id="p1",
        consultation_id="c1",
        status=SessionStatus.ACTIVE,
        sample_rate=16000,
    )
    return StreamSession(metadata=meta, redis=AsyncMock(), persist_interval_s=5.0)


def _make_manager():
    from stt.streaming.execution_profile import ExecutionProfile, PlatformType
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
    redis_mock = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    return SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")


class _Harness:
    """A real manager behind the real DELETE route, with every side effect logged in order."""

    def __init__(self) -> None:
        self.mgr = _make_manager()
        self.session = _make_session()
        self.sid = self.session.session_id
        self.mgr._sessions[self.sid] = self.session
        for seq in range(1, 4):
            self.session.record_frame(seq=seq, data=_PCM, sample_rate=16000)

        self.order: list[str] = []
        self.upload_gate: asyncio.Event | None = None

        publisher = MagicMock()

        async def _status(status: str) -> str:
            self.order.append(f"status:{status}")
            return "0-1"

        publisher.publish_status = AsyncMock(side_effect=_status)
        publisher.publish = AsyncMock()
        self.mgr._publishers[self.sid] = publisher

        def _upload(name: str):
            async def _inner(**_kwargs):
                if name == "raw_complete" and self.upload_gate is not None:
                    await self.upload_gate.wait()
                self.order.append(f"upload:{name}")
                return f"s3://bucket/{name}"

            return AsyncMock(side_effect=_inner)

        blob = MagicMock()
        blob.upload_streaming_raw_chunk = _upload("raw_chunk")
        blob.upload_streaming_raw_complete = _upload("raw_complete")
        blob.upload_streaming_processed_complete = _upload("processed_complete")
        blob.upload_streaming_transcript = _upload("transcript")
        blob.upload_streaming_metadata = _upload("metadata")
        self.mgr._blob_service = blob
        self.mgr._register_dual_capture = AsyncMock()
        self.mgr._persist_streaming_transcript = AsyncMock()

        original_claim = self.mgr.claim_teardown_summary

        def _claim(session_id: str):
            claimed = original_claim(session_id)
            self.order.append("claim" if claimed is not None else "claim:none")
            return claimed

        self.mgr.claim_teardown_summary = _claim  # type: ignore[method-assign]

    def client(self) -> httpx.AsyncClient:
        from stt.streaming.api.routes import router

        app = FastAPI()
        app.include_router(router)
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://stt")

    async def delete(self, client: httpx.AsyncClient) -> httpx.Response:
        return await client.delete(f"/internal/streaming/sessions/{self.sid}")

    def control_finalize(self):
        from stt.streaming.schemas import ControlAction, SessionControl

        handler = self.mgr._make_control_handler(self.session, preprocessor=None)
        return handler(SessionControl(action=ControlAction.FINALIZE))


@pytest.fixture
def harness():
    from stt.streaming._runtime import set_session_manager

    h = _Harness()
    set_session_manager(h.mgr)
    yield h
    set_session_manager(None)  # type: ignore[arg-type]


async def _yield(times: int = 10) -> None:
    for _ in range(times):
        await asyncio.sleep(0)


class TestDeleteDuringAnInFlightTeardown:
    @pytest.mark.asyncio
    async def test_delete_during_the_tail_flush_returns_the_summary_after_the_upload(self, harness):
        tail_gate = asyncio.Event()

        async def _slow_tail(session, preprocessor):  # noqa: ANN001 - test double
            harness.order.append("tail_flush")
            await tail_gate.wait()

        harness.mgr._flush_final_utterance = _slow_tail  # type: ignore[method-assign]

        control = asyncio.create_task(harness.control_finalize())
        await _yield()
        assert harness.order == ["status:finalizing", "tail_flush"]

        async with harness.client() as client:
            deleting = asyncio.create_task(harness.delete(client))
            await _yield()
            tail_gate.set()
            response = await asyncio.wait_for(deleting, timeout=2.0)
        await asyncio.wait_for(control, timeout=2.0)

        assert response.status_code == 200
        assert response.json()["session_id"] == harness.sid
        # The recording is stored BEFORE the summary is handed over.
        claim_at = harness.order.index("claim")
        for upload in ("upload:raw_complete", "upload:transcript", "upload:metadata"):
            assert harness.order.index(upload) < claim_at
        # Nothing left for the push-back sweep to find.
        assert harness.sid not in harness.mgr._pending_teardown_summaries

    @pytest.mark.asyncio
    async def test_delete_with_nothing_in_flight_and_nothing_stashed_is_204(self, harness):
        harness.mgr._sessions.pop(harness.sid)

        async with harness.client() as client:
            response = await harness.delete(client)

        assert response.status_code == 204

    @pytest.mark.asyncio
    async def test_delete_on_a_live_session_finalizes_and_uploads_never_cancels(self, harness):
        """The superseded-session path: the gateway's DELETE is a FINALIZE."""
        async with harness.client() as client:
            response = await harness.delete(client)

        assert response.status_code == 200
        assert response.json()["session_id"] == harness.sid
        assert "upload:raw_complete" in harness.order
        assert "status:closed" in harness.order
        assert "status:cancelled" not in harness.order

    @pytest.mark.asyncio
    async def test_the_wait_is_bounded_and_never_cuts_the_other_finalizers_upload_short(
        self, harness
    ):
        harness.upload_gate = asyncio.Event()
        harness.mgr._tail_wait_timeout_s = 0.05

        control = asyncio.create_task(harness.control_finalize())
        await _yield()
        # The control finalizer holds the finalize lock, mid-upload.
        assert "status:closed" in harness.order
        assert "upload:raw_complete" not in harness.order

        async with harness.client() as client:
            response = await asyncio.wait_for(harness.delete(client), timeout=2.0)

        # Gave up waiting: nothing to hand over yet.
        assert response.status_code == 204

        harness.upload_gate.set()
        await asyncio.wait_for(control, timeout=2.0)

        # The upload the DELETE stopped waiting for still completed...
        assert "upload:raw_complete" in harness.order
        # ...and its summary is stashed for the push-back backstop, not lost.
        assert harness.sid in harness.mgr._pending_teardown_summaries
