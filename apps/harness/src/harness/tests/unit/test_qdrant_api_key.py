"""Qdrant API-key auth (TASK-624 Q-03/Q-04).

Qdrant ships with NO authentication. Deploying it into the cluster without an
API key means any pod in the namespace can read or delete the tenant knowledge
corpus. The store must therefore be ABLE to present a key — and must keep
working without one, since local dev runs an unauthenticated Qdrant.
"""

from __future__ import annotations

from unittest.mock import patch

from harness.core.config import RetrievalConfig
from harness.guides.retrieval.qdrant_store import KnowledgeQdrantStore


class TestRetrievalConfigApiKey:
    def test_api_key_defaults_to_none(self):
        """Unset must stay unset — local dev Qdrant is unauthenticated."""
        cfg = RetrievalConfig()
        assert cfg.qdrant_api_key is None

    def test_api_key_reads_its_env_var(self, monkeypatch):
        monkeypatch.setenv("HARNESS_RETRIEVAL_QDRANT_API_KEY", "s3cret-key")
        cfg = RetrievalConfig()
        assert cfg.qdrant_api_key is not None
        assert cfg.qdrant_api_key.get_secret_value() == "s3cret-key"

    def test_api_key_is_not_printed_by_repr(self, monkeypatch):
        """SecretStr, not str — the config is logged at startup."""
        monkeypatch.setenv("HARNESS_RETRIEVAL_QDRANT_API_KEY", "s3cret-key")
        assert "s3cret-key" not in repr(RetrievalConfig())


class TestStorePassesApiKey:
    def test_api_key_is_forwarded_to_the_client(self):
        with patch("qdrant_client.QdrantClient") as mock_client:
            KnowledgeQdrantStore(
                url="http://q:6333", collection="knowledge_chunks", api_key="s3cret-key"
            )
        assert mock_client.call_args.kwargs.get("api_key") == "s3cret-key"

    def test_no_api_key_passes_none_not_empty_string(self):
        """An empty string is a CREDENTIAL to Qdrant; absent must mean absent."""
        with patch("qdrant_client.QdrantClient") as mock_client:
            KnowledgeQdrantStore(url="http://q:6333", collection="knowledge_chunks")
        assert mock_client.call_args.kwargs.get("api_key") is None

    def test_injected_client_is_untouched(self):
        """An explicitly supplied client wins — tests and callers own it."""
        sentinel = object()
        store = KnowledgeQdrantStore(
            url="http://q:6333", collection="c", client=sentinel, api_key="k"
        )
        assert store._client is sentinel
