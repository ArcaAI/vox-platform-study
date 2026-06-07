"""Phase-3 retrieval configuration tests (TASK-330 Phase 3, Lane A).

Phase 3 needs a **retrieval** sub-config (``HARNESS_RETRIEVAL_*``) for the hybrid
JIT retriever (LM Studio dense embeddings + fastembed BM25 sparse -> Qdrant
``knowledge_chunks`` -> TEI rerank) and a dedicated internal service token
(``HARNESS_INTERNAL_SERVICE_TOKEN``) for the ingest endpoint. Everything is
env-driven, offline (no network at construction time), and DISABLED by default
(``enabled=False``) so Phase 1/2 behaviour is unchanged out of the box.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from harness.core.config import RetrievalConfig, Settings

_RETRIEVAL_ENV = (
    "HARNESS_RETRIEVAL_ENABLED",
    "HARNESS_RETRIEVAL_QDRANT_URL",
    "HARNESS_RETRIEVAL_COLLECTION",
    "HARNESS_RETRIEVAL_EMBEDDINGS_BASE_URL",
    "HARNESS_RETRIEVAL_EMBEDDINGS_MODEL",
    "HARNESS_RETRIEVAL_EMBEDDINGS_DIM",
    "HARNESS_RETRIEVAL_RERANKER_BASE_URL",
    "HARNESS_RETRIEVAL_TOP_K_RETRIEVAL",
    "HARNESS_RETRIEVAL_TOP_K_RERANK",
    "HARNESS_RETRIEVAL_RRF_K",
)


class TestRetrievalConfig:
    def test_defaults_are_disabled_and_self_hosted(self, monkeypatch: pytest.MonkeyPatch):
        for var in _RETRIEVAL_ENV:
            monkeypatch.delenv(var, raising=False)
        c = RetrievalConfig()
        # Flag-gated OFF by default: Phase 1/2 behaviour is unchanged out of the box.
        assert c.enabled is False
        # Dedicated knowledge collection (NOT the consultation-scoped context_items).
        assert c.collection == "knowledge_chunks"
        assert c.qdrant_url == "http://localhost:6333"
        # Dense embeddings + query stay on the self-hosted LM Studio path (PHI-safe).
        assert c.embeddings_base_url.endswith("/v1")
        assert c.embeddings_model
        # BAAI/bge-m3 default dim (1536 only if a 1536-dim model is loaded).
        assert c.embeddings_dim == 1024
        assert c.reranker_base_url
        # Hybrid knobs: RRF(60), retrieve 20 -> rerank to top-5.
        assert c.top_k_retrieval == 20
        assert c.top_k_rerank == 5
        assert c.rrf_k == 60

    def test_env_override(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_RETRIEVAL_ENABLED", "true")
        monkeypatch.setenv("HARNESS_RETRIEVAL_QDRANT_URL", "http://qdrant:6333")
        monkeypatch.setenv("HARNESS_RETRIEVAL_COLLECTION", "kb")
        monkeypatch.setenv("HARNESS_RETRIEVAL_EMBEDDINGS_BASE_URL", "http://lmstudio:1234/v1")
        monkeypatch.setenv("HARNESS_RETRIEVAL_EMBEDDINGS_MODEL", "BAAI/bge-m3")
        monkeypatch.setenv("HARNESS_RETRIEVAL_EMBEDDINGS_DIM", "1536")
        monkeypatch.setenv("HARNESS_RETRIEVAL_RERANKER_BASE_URL", "http://reranker:80")
        monkeypatch.setenv("HARNESS_RETRIEVAL_TOP_K_RETRIEVAL", "30")
        monkeypatch.setenv("HARNESS_RETRIEVAL_TOP_K_RERANK", "8")
        monkeypatch.setenv("HARNESS_RETRIEVAL_RRF_K", "42")
        c = RetrievalConfig()
        assert c.enabled is True
        assert c.qdrant_url == "http://qdrant:6333"
        assert c.collection == "kb"
        assert c.embeddings_base_url == "http://lmstudio:1234/v1"
        assert c.embeddings_model == "BAAI/bge-m3"
        assert c.embeddings_dim == 1536
        assert c.reranker_base_url == "http://reranker:80"
        assert c.top_k_retrieval == 30
        assert c.top_k_rerank == 8
        assert c.rrf_k == 42

    def test_dim_must_be_positive(self):
        with pytest.raises(ValidationError):
            RetrievalConfig(embeddings_dim=0)


class TestSettingsWiring:
    def test_settings_expose_retrieval_subconfig(self, monkeypatch: pytest.MonkeyPatch):
        for var in _RETRIEVAL_ENV:
            monkeypatch.delenv(var, raising=False)
        s = Settings()
        assert isinstance(s.retrieval, RetrievalConfig)
        assert s.retrieval.enabled is False

    def test_retrieval_subconfig_reads_its_prefix_through_settings(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("HARNESS_RETRIEVAL_COLLECTION", "kb-2")
        assert Settings().retrieval.collection == "kb-2"

    def test_internal_service_token_is_separate_secret(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_INTERNAL_SERVICE_TOKEN", "ingest-secret")
        s = Settings()
        assert s.internal_service_token.get_secret_value() == "ingest-secret"
        # Default empty (local dev / falls back to the shared service token).
        monkeypatch.delenv("HARNESS_INTERNAL_SERVICE_TOKEN", raising=False)
        assert Settings().internal_service_token.get_secret_value() == ""
