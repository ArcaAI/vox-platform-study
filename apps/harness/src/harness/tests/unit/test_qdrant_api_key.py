"""Qdrant API-key auth.

Qdrant ships with NO authentication. Deploying it into the cluster without an
API key means any pod in the namespace can read or delete the tenant knowledge
corpus. The store must therefore be ABLE to present a key — and must keep
working without one, since local dev runs an unauthenticated Qdrant.
"""

from __future__ import annotations

from unittest.mock import patch

from pydantic import SecretStr

from harness.core.config import RetrievalConfig
from harness.guides.retrieval.qdrant_store import KnowledgeQdrantStore


class TestRetrievalConfigApiKey:
    def test_api_key_defaults_to_none(self):
        """Unset must stay unset — local dev Qdrant is unauthenticated."""
        cfg = RetrievalConfig()
        assert cfg.qdrant_api_key is None

    def test_api_key_no_longer_reads_its_env_var(self, monkeypatch):
        """lane B — the env path is CLOSED; the key is BYO-only now.

        This assertion is INVERTED from what it was, deliberately. The Qdrant key
        is a provider credential and lives on
        `AiProviderConnection(service='vector', provider='qdrant')`, tenant →
        SYSTEM; `qdrant_api_key` carries a dead `validation_alias` so no
        environment variable can populate it. The FIELD survives (deleting it
        would remove the only way to authenticate, the defect this file exists to
        pin) — it is now written by injection only. Full contract:
        `test_task799_byo_credentials.py`.
        """
        monkeypatch.setenv("HARNESS_RETRIEVAL_QDRANT_API_KEY", "s3cret-key")
        assert RetrievalConfig().qdrant_api_key is None

    def test_api_key_is_not_printed_by_repr(self):
        """SecretStr, not str — the config is logged at startup."""
        cfg = RetrievalConfig().model_copy(update={"qdrant_api_key": SecretStr("s3cret-key")})
        assert "s3cret-key" not in repr(cfg)


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


class TestFactoriesPassApiKey:
    """The two places that actually BUILD a store from settings.

    The classes above prove each half in isolation — the config can hold a key,
    and the store can present one. Neither proves they are CONNECTED, and for a
    while they were not: both factories dropped the key on the floor, so
    ``HARNESS_RETRIEVAL_QDRANT_API_KEY`` was parsed, validated, logged as
    configured and never sent. `pnpm env:python-dead` is what found it.
    """

    @staticmethod
    def _settings_with_key(key: str | None):
        from harness.core.config import Settings

        settings = Settings()
        settings.retrieval.qdrant_api_key = SecretStr(key) if key is not None else None
        return settings

    def test_temporal_retriever_factory_forwards_the_key(self):
        from harness.temporal.activities import _hybrid_retriever

        with patch("qdrant_client.QdrantClient") as mock_client:
            _hybrid_retriever(self._settings_with_key("s3cret-key"))
        assert mock_client.call_args.kwargs.get("api_key") == "s3cret-key"

    def test_knowledge_endpoint_factory_forwards_the_key(self):
        from harness.api.endpoints.knowledge import _qdrant_store

        with patch("qdrant_client.QdrantClient") as mock_client:
            _qdrant_store(self._settings_with_key("s3cret-key"))
        assert mock_client.call_args.kwargs.get("api_key") == "s3cret-key"

    def test_absent_key_still_builds_an_unauthenticated_store(self):
        """Local dev Qdrant is unauthenticated — absence must not become ""."""
        from harness.api.endpoints.knowledge import _qdrant_store

        with patch("qdrant_client.QdrantClient") as mock_client:
            _qdrant_store(self._settings_with_key(None))
        assert mock_client.call_args.kwargs.get("api_key") is None
