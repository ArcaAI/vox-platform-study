"""Integration tests for the Speaker Voice Embedding API (TASK-033).

Tests the full HTTP request/response cycle through the real FastAPI app
with mocked EmbeddingService and SpeakerEmbeddingStore dependencies.
Validates middleware, routing, dependency injection, and JSON serialization
end-to-end via ``httpx.AsyncClient`` against the ASGI transport.
"""

from __future__ import annotations

import asyncio
import io
import struct
import wave
from unittest.mock import AsyncMock, MagicMock

import httpx
import numpy as np
import pytest
from fastapi import FastAPI

from stt_v2.diarization.dto import SpeakerEmbedding
from stt_v2.embedding.api.routes import router as embedding_router


@pytest.fixture(scope="session", autouse=True)
def verify_test_environment():
    """Override the parent conftest's verify_test_environment.

    These integration tests run the ASGI app in-process with mocked services
    so no external infrastructure (DB, Redis, MinIO) is needed.
    """
    pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_wav_bytes(duration_s: float = 5.0, sample_rate: int = 16000) -> bytes:
    """Generate a minimal valid mono 16-bit WAV file in memory."""
    n_samples = int(sample_rate * duration_s)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack(f"<{n_samples}h", *([0] * n_samples)))
    return buf.getvalue()


def _make_speaker_embedding(dim: int = 512) -> SpeakerEmbedding:
    return SpeakerEmbedding(
        embedding=np.random.rand(dim).tolist(),
        segment_start=0.0,
        segment_end=5.0,
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_embedding_service():
    svc = MagicMock()
    svc.is_loaded = True
    svc.extract_from_samples = AsyncMock(return_value=_make_speaker_embedding())
    return svc


@pytest.fixture
def mock_speaker_store():
    store = AsyncMock()
    store.upsert_embedding.return_value = "emb-uuid-001"
    store.get_speakers_for_tenant.return_value = []
    store.delete_speaker.return_value = 1
    return store


@pytest.fixture
def embedding_app(mock_embedding_service, mock_speaker_store):
    """Create a fresh FastAPI app with the embedding router and overridden deps."""
    from stt_v2.core.vectorstore.speaker_store import get_speaker_store
    from stt_v2.diarization.embedding_service import get_embedding_service

    app = FastAPI()
    app.include_router(embedding_router)
    app.dependency_overrides[get_embedding_service] = lambda: mock_embedding_service
    app.dependency_overrides[get_speaker_store] = lambda: mock_speaker_store
    return app


@pytest.fixture
async def client(embedding_app):
    transport = httpx.ASGITransport(app=embedding_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ---------------------------------------------------------------------------
# Integration tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestFullUpsertFlow:
    """POST valid WAV -> 201; response has all fields; both services called."""

    @pytest.mark.asyncio
    async def test_upsert_returns_201_with_all_fields(
        self, client, mock_embedding_service, mock_speaker_store
    ):
        wav = _make_wav_bytes(duration_s=6.0)

        resp = await client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "spk-001"},
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["speaker_id"] == "spk-001"
        assert body["embedding_id"] == "emb-uuid-001"
        assert body["dimensions"] == 512
        assert "created_at" in body

        mock_embedding_service.extract_from_samples.assert_called_once()
        mock_speaker_store.upsert_embedding.assert_called_once()
        call_kw = mock_speaker_store.upsert_embedding.call_args.kwargs
        assert call_kw["tenant_id"] == "tenant-001"
        assert call_kw["speaker_id"] == "spk-001"


@pytest.mark.integration
class TestUpsertThenGetStatus:
    """POST upsert -> GET status -> verify exists=True."""

    @pytest.mark.asyncio
    async def test_get_returns_exists_true_after_upsert(self, client, mock_speaker_store):
        wav = _make_wav_bytes(duration_s=5.0)

        upsert_resp = await client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "spk-002"},
        )
        assert upsert_resp.status_code == 201

        mock_speaker_store.get_speakers_for_tenant.return_value = [
            {"speaker_id": "spk-002", "embedding_count": 1, "created_at": 1708473600},
        ]

        get_resp = await client.get(
            "/internal/embeddings/spk-002",
            params={"tenant_id": "tenant-001"},
        )

        assert get_resp.status_code == 200
        body = get_resp.json()
        assert body["speaker_id"] == "spk-002"
        assert body["exists"] is True
        assert body["dimensions"] == 512
        assert "created_at" in body


@pytest.mark.integration
class TestUpsertDeleteThenGet:
    """POST -> DELETE -> GET -> verify exists=False."""

    @pytest.mark.asyncio
    async def test_get_returns_exists_false_after_delete(self, client, mock_speaker_store):
        wav = _make_wav_bytes(duration_s=5.0)

        upsert_resp = await client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "spk-003"},
        )
        assert upsert_resp.status_code == 201

        del_resp = await client.delete(
            "/internal/embeddings/spk-003",
            params={"tenant_id": "tenant-001"},
        )
        assert del_resp.status_code == 200
        assert del_resp.json()["deleted"] is True

        mock_speaker_store.get_speakers_for_tenant.return_value = []

        get_resp = await client.get(
            "/internal/embeddings/spk-003",
            params={"tenant_id": "tenant-001"},
        )
        assert get_resp.status_code == 200
        body = get_resp.json()
        assert body["speaker_id"] == "spk-003"
        assert body["exists"] is False


@pytest.mark.integration
class TestGetNonExistentSpeaker:
    """GET for a speaker that was never upserted -> exists=False."""

    @pytest.mark.asyncio
    async def test_get_non_existent_returns_exists_false(self, client, mock_speaker_store):
        mock_speaker_store.get_speakers_for_tenant.return_value = []

        resp = await client.get(
            "/internal/embeddings/spk-ghost",
            params={"tenant_id": "tenant-001"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["speaker_id"] == "spk-ghost"
        assert body["exists"] is False
        assert "dimensions" not in body


@pytest.mark.integration
class TestConcurrentUpsertsForDifferentTenants:
    """Two upserts with different tenant_ids; each GET only returns its own."""

    @pytest.mark.asyncio
    async def test_tenant_isolation(self, client, mock_speaker_store):
        wav = _make_wav_bytes(duration_s=5.0)

        resp_a, resp_b = await asyncio.gather(
            client.post(
                "/internal/embeddings/upsert",
                files={"file": ("a.wav", wav, "audio/wav")},
                data={"tenant_id": "tenant-A", "speaker_id": "spk-iso"},
            ),
            client.post(
                "/internal/embeddings/upsert",
                files={"file": ("b.wav", wav, "audio/wav")},
                data={"tenant_id": "tenant-B", "speaker_id": "spk-iso"},
            ),
        )
        assert resp_a.status_code == 201
        assert resp_b.status_code == 201

        mock_speaker_store.get_speakers_for_tenant.side_effect = lambda tid: (
            [{"speaker_id": "spk-iso", "embedding_count": 1}] if tid == "tenant-A" else []
        )

        get_a = await client.get(
            "/internal/embeddings/spk-iso",
            params={"tenant_id": "tenant-A"},
        )
        get_b = await client.get(
            "/internal/embeddings/spk-iso",
            params={"tenant_id": "tenant-B"},
        )

        assert get_a.json()["exists"] is True
        assert get_b.json()["exists"] is False

        assert mock_speaker_store.upsert_embedding.call_count == 2
        tenant_ids = [
            c.kwargs["tenant_id"] for c in mock_speaker_store.upsert_embedding.call_args_list
        ]
        assert set(tenant_ids) == {"tenant-A", "tenant-B"}


@pytest.mark.integration
class TestDeleteIdempotency:
    """DELETE the same speaker twice; both return 200."""

    @pytest.mark.asyncio
    async def test_double_delete_returns_200_both_times(self, client, mock_speaker_store):
        resp1 = await client.delete(
            "/internal/embeddings/spk-idem",
            params={"tenant_id": "tenant-001"},
        )
        assert resp1.status_code == 200
        assert resp1.json()["deleted"] is True

        mock_speaker_store.delete_speaker.return_value = 0

        resp2 = await client.delete(
            "/internal/embeddings/spk-idem",
            params={"tenant_id": "tenant-001"},
        )
        assert resp2.status_code == 200
        assert resp2.json()["deleted"] is True
        assert mock_speaker_store.delete_speaker.call_count == 2
