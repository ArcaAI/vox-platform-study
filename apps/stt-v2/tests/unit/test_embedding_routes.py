"""Unit tests for embedding API routes (TASK-033).

Covers:
- ``POST /internal/embeddings/upsert`` — upload audio, extract embedding, store in Qdrant
- ``GET /internal/embeddings/{speaker_id}`` — retrieve embedding status
- ``DELETE /internal/embeddings/{speaker_id}`` — remove speaker embedding

Uses FastAPI TestClient with mocked EmbeddingService and SpeakerEmbeddingStore
to avoid requiring real Pyannote model or Qdrant connections.
"""

from __future__ import annotations

import io
import struct
import wave
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from stt_v2.diarization.dto import SpeakerEmbedding


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_wav_bytes(duration_s: float = 5.0, sample_rate: int = 16000) -> bytes:
    """Generate a minimal valid WAV file in memory."""
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
    svc.extract_from_samples = AsyncMock(return_value=_make_speaker_embedding())
    svc.is_loaded = True
    return svc


@pytest.fixture
def mock_speaker_store():
    store = AsyncMock()
    store.upsert_embedding.return_value = "emb-uuid-001"
    store.get_speakers_for_tenant.return_value = [
        {"speaker_id": "user-123", "embedding_count": 1},
    ]
    store.delete_speaker.return_value = 1
    return store


@pytest.fixture
def embedding_app(mock_embedding_service, mock_speaker_store):
    """Create a FastAPI app with the embedding router and mocked deps."""
    from stt_v2.embedding.api.routes import (
        get_embedding_service,
        get_speaker_store,
        router,
    )

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_embedding_service] = lambda: mock_embedding_service
    app.dependency_overrides[get_speaker_store] = lambda: mock_speaker_store
    return app


@pytest.fixture
def client(embedding_app):
    return TestClient(embedding_app)


# ---------------------------------------------------------------------------
# POST /internal/embeddings/upsert
# ---------------------------------------------------------------------------


class TestUpsertEmbedding:
    """Tests for POST /internal/embeddings/upsert."""

    def test_returns_201_with_valid_audio(self, client, mock_embedding_service, mock_speaker_store):
        wav_data = _make_wav_bytes(duration_s=5.0)

        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )

        assert resp.status_code == 201
        data = resp.json()
        assert data["speaker_id"] == "user-123"
        assert data["dimensions"] == 512
        assert "embedding_id" in data
        assert "created_at" in data

    def test_calls_embedding_service_extract(self, client, mock_embedding_service):
        wav_data = _make_wav_bytes(duration_s=6.0)

        client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )

        mock_embedding_service.extract_from_samples.assert_called_once()

    def test_calls_speaker_store_upsert(self, client, mock_speaker_store):
        wav_data = _make_wav_bytes(duration_s=5.0)

        client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-456"},
        )

        mock_speaker_store.upsert_embedding.assert_called_once()
        call_args = mock_speaker_store.upsert_embedding.call_args
        assert call_args.kwargs.get("tenant_id") == "tenant-001" or call_args.args[0] == "tenant-001"

    def test_returns_422_when_missing_tenant_id(self, client):
        wav_data = _make_wav_bytes()
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={"speaker_id": "user-123"},
        )
        assert resp.status_code == 422

    def test_returns_422_when_missing_speaker_id(self, client):
        wav_data = _make_wav_bytes()
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001"},
        )
        assert resp.status_code == 422

    def test_returns_422_when_no_file(self, client):
        resp = client.post(
            "/internal/embeddings/upsert",
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 422

    def test_returns_400_for_audio_shorter_than_5_seconds(self, client):
        wav_data = _make_wav_bytes(duration_s=0.5)
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("short.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 400
        assert "duration" in resp.json()["detail"].lower()

    def test_returns_400_for_audio_at_4_seconds(self, client):
        wav_data = _make_wav_bytes(duration_s=4.0)
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("borderline.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 400

    def test_accepts_audio_at_exactly_5_seconds(self, client):
        wav_data = _make_wav_bytes(duration_s=5.0)
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("exact.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 201

    def test_returns_500_when_embedding_extraction_fails(self, client, mock_embedding_service):
        mock_embedding_service.extract_from_samples = AsyncMock(
            side_effect=RuntimeError("model not loaded")
        )
        wav_data = _make_wav_bytes()
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 500

    def test_returns_503_when_embedding_service_not_initialized(self, client, mock_embedding_service):
        mock_embedding_service.is_loaded = False
        wav_data = _make_wav_bytes()
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 503

    def test_forwards_metadata_to_speaker_store(self, client, mock_speaker_store):
        wav_data = _make_wav_bytes(duration_s=5.0)
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={
                "tenant_id": "tenant-001",
                "speaker_id": "user-123",
                "metadata": '{"source": "web-recorder"}',
            },
        )
        assert resp.status_code == 201
        call_kwargs = mock_speaker_store.upsert_embedding.call_args.kwargs
        assert call_kwargs.get("metadata") == {"source": "web-recorder"}

    def test_returns_500_when_qdrant_store_fails(self, client, mock_speaker_store, mock_embedding_service):
        mock_speaker_store.upsert_embedding.side_effect = RuntimeError("Qdrant unavailable")
        wav_data = _make_wav_bytes(duration_s=5.0)
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 500

    def test_returns_400_for_corrupted_wav_bytes(self, client, mock_embedding_service):
        """Non-WAV bytes should fail duration check (returns -1.0) and be rejected."""
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("corrupt.wav", b"not-a-wav-file", "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 400

    def test_returns_400_for_empty_file(self, client, mock_embedding_service):
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("empty.wav", b"", "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 400

    def test_handles_stereo_wav(self, client, mock_embedding_service, mock_speaker_store):
        """Stereo WAV should be downmixed to mono and processed successfully."""
        n_samples = int(16000 * 6.0)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(struct.pack(f"<{n_samples * 2}h", *([0] * n_samples * 2)))
        stereo_wav = buf.getvalue()

        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("stereo.wav", stereo_wav, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 201

    def test_ignores_invalid_metadata_json(self, client, mock_speaker_store):
        """Non-dict JSON or broken JSON should be treated as None, not error."""
        wav_data = _make_wav_bytes(duration_s=5.0)
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={
                "tenant_id": "tenant-001",
                "speaker_id": "user-123",
                "metadata": "not-valid-json{{{",
            },
        )
        assert resp.status_code == 201
        call_kwargs = mock_speaker_store.upsert_embedding.call_args.kwargs
        assert call_kwargs.get("metadata") is None

    def test_ignores_metadata_that_is_json_array(self, client, mock_speaker_store):
        """JSON array metadata should be treated as None (only dicts accepted)."""
        wav_data = _make_wav_bytes(duration_s=5.0)
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={
                "tenant_id": "tenant-001",
                "speaker_id": "user-123",
                "metadata": '["not", "a", "dict"]',
            },
        )
        assert resp.status_code == 201
        call_kwargs = mock_speaker_store.upsert_embedding.call_args.kwargs
        assert call_kwargs.get("metadata") is None

    def test_passes_none_metadata_when_omitted(self, client, mock_speaker_store):
        wav_data = _make_wav_bytes(duration_s=5.0)
        resp = client.post(
            "/internal/embeddings/upsert",
            files={"file": ("sample.wav", wav_data, "audio/wav")},
            data={"tenant_id": "tenant-001", "speaker_id": "user-123"},
        )
        assert resp.status_code == 201
        call_kwargs = mock_speaker_store.upsert_embedding.call_args.kwargs
        assert call_kwargs.get("metadata") is None


# ---------------------------------------------------------------------------
# GET /internal/embeddings/{speaker_id}
# ---------------------------------------------------------------------------


class TestGetEmbeddingStatus:
    """Tests for GET /internal/embeddings/{speaker_id}."""

    def test_returns_200_when_embedding_exists(self, client, mock_speaker_store):
        mock_speaker_store.get_speakers_for_tenant.return_value = [
            {"speaker_id": "user-123", "embedding_count": 1},
        ]

        resp = client.get(
            "/internal/embeddings/user-123",
            params={"tenant_id": "tenant-001"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["speaker_id"] == "user-123"
        assert data["exists"] is True
        assert data["dimensions"] == 512

    def test_returns_200_with_exists_false_when_not_found(self, client, mock_speaker_store):
        mock_speaker_store.get_speakers_for_tenant.return_value = []

        resp = client.get(
            "/internal/embeddings/user-999",
            params={"tenant_id": "tenant-001"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["speaker_id"] == "user-999"
        assert data["exists"] is False

    def test_returns_created_at_when_embedding_exists(self, client, mock_speaker_store):
        mock_speaker_store.get_speakers_for_tenant.return_value = [
            {"speaker_id": "user-123", "embedding_count": 1, "created_at": 1708473600},
        ]

        resp = client.get(
            "/internal/embeddings/user-123",
            params={"tenant_id": "tenant-001"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert "created_at" in data

    def test_tenant_isolation_only_returns_own_tenant_speakers(self, client, mock_speaker_store):
        mock_speaker_store.get_speakers_for_tenant.return_value = [
            {"speaker_id": "user-other", "embedding_count": 1},
        ]

        resp = client.get(
            "/internal/embeddings/user-123",
            params={"tenant_id": "tenant-002"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["exists"] is False
        mock_speaker_store.get_speakers_for_tenant.assert_called_once_with("tenant-002")

    def test_picks_correct_speaker_from_multiple_in_tenant(self, client, mock_speaker_store):
        mock_speaker_store.get_speakers_for_tenant.return_value = [
            {"speaker_id": "user-AAA", "embedding_count": 3},
            {"speaker_id": "user-BBB", "embedding_count": 1, "created_at": 1708473600},
            {"speaker_id": "user-CCC", "embedding_count": 2},
        ]

        resp = client.get(
            "/internal/embeddings/user-BBB",
            params={"tenant_id": "tenant-001"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["speaker_id"] == "user-BBB"
        assert data["exists"] is True

    def test_created_at_is_none_when_not_in_store_payload(self, client, mock_speaker_store):
        mock_speaker_store.get_speakers_for_tenant.return_value = [
            {"speaker_id": "user-123", "embedding_count": 1},
        ]

        resp = client.get(
            "/internal/embeddings/user-123",
            params={"tenant_id": "tenant-001"},
        )

        data = resp.json()
        assert data["exists"] is True
        assert data.get("created_at") is None

    def test_created_at_passes_through_if_already_string(self, client, mock_speaker_store):
        mock_speaker_store.get_speakers_for_tenant.return_value = [
            {"speaker_id": "user-123", "embedding_count": 1, "created_at": "2026-02-21T00:00:00+00:00"},
        ]

        resp = client.get(
            "/internal/embeddings/user-123",
            params={"tenant_id": "tenant-001"},
        )

        data = resp.json()
        assert data["created_at"] == "2026-02-21T00:00:00+00:00"

    def test_does_not_return_dimensions_when_not_found(self, client, mock_speaker_store):
        mock_speaker_store.get_speakers_for_tenant.return_value = []

        resp = client.get(
            "/internal/embeddings/user-999",
            params={"tenant_id": "tenant-001"},
        )

        data = resp.json()
        assert "dimensions" not in data

    def test_returns_422_when_missing_tenant_id(self, client):
        resp = client.get("/internal/embeddings/user-123")
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# DELETE /internal/embeddings/{speaker_id}
# ---------------------------------------------------------------------------


class TestDeleteEmbedding:
    """Tests for DELETE /internal/embeddings/{speaker_id}."""

    def test_returns_200_on_successful_delete(self, client, mock_speaker_store):
        resp = client.delete(
            "/internal/embeddings/user-123",
            params={"tenant_id": "tenant-001"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["deleted"] is True
        assert data["speaker_id"] == "user-123"

    def test_calls_speaker_store_delete(self, client, mock_speaker_store):
        client.delete(
            "/internal/embeddings/user-456",
            params={"tenant_id": "tenant-001"},
        )

        mock_speaker_store.delete_speaker.assert_called_once_with("tenant-001", "user-456")

    def test_returns_422_when_missing_tenant_id(self, client):
        resp = client.delete("/internal/embeddings/user-123")
        assert resp.status_code == 422

    def test_returns_200_even_when_speaker_not_found(self, client, mock_speaker_store):
        mock_speaker_store.delete_speaker.return_value = 0

        resp = client.delete(
            "/internal/embeddings/user-123",
            params={"tenant_id": "tenant-001"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["deleted"] is True

    def test_returns_500_when_store_delete_fails(self, client, mock_speaker_store):
        mock_speaker_store.delete_speaker.side_effect = RuntimeError("Qdrant timeout")

        resp = client.delete(
            "/internal/embeddings/user-123",
            params={"tenant_id": "tenant-001"},
        )

        assert resp.status_code == 500
