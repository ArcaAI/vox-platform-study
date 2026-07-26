"""The gateway-injected `model_path` reaches `from_pretrained`.

NLP is deliberately stateless (no DB), so `AiModel.localPath` can only arrive by
request injection. `_MODEL_IDENTITY_FIELDS` in `nlp/core/config.py` already
blocks the environment from setting `model_path`, making the request the single
sanctioned identity lane — these tests lock that in.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from nlp.schemas.classification import (
    TextClassificationRequest,
    TokenClassificationRequest,
)
from nlp.schemas.diagnosis import DiagnosisSuggestionRequest


class TestSchemaCarriesModelPath:
    def test_token_classification_request_accepts_model_path(self) -> None:
        req = TokenClassificationRequest(
            text="aspirin", model_name="org/ner", model_path="/opt/models/ner"
        )
        assert req.model_path == "/opt/models/ner"

    def test_text_classification_request_accepts_model_path(self) -> None:
        req = TextClassificationRequest(
            text="x", model_name="org/cls", model_path="/opt/models/cls"
        )
        assert req.model_path == "/opt/models/cls"

    def test_diagnosis_request_accepts_model_path(self) -> None:
        req = DiagnosisSuggestionRequest(
            text="x", model_name="org/dx", model_path="/opt/models/dx"
        )
        assert req.model_path == "/opt/models/dx"

    def test_model_path_defaults_to_none(self) -> None:
        """Absent ⇒ None, so every pre-527 payload behaves identically."""
        assert TokenClassificationRequest(text="x", model_name="org/ner").model_path is None


class TestEnvCannotSetModelPath:
    def test_model_path_is_an_identity_field_blocked_from_env(self) -> None:
        """Regression: model identity is never environment-selected."""
        from nlp.core.config import _MODEL_IDENTITY_FIELDS

        assert "model_path" in _MODEL_IDENTITY_FIELDS
        assert "model_name" in _MODEL_IDENTITY_FIELDS


class TestVaultSecretsDirCannotSetModelIdentity:
    """TASK-558-H: the Vault `secrets_dir` tier is filtered too.

    Before 558-H the secrets source was inert (no `secrets_dir` was ever
    configured), so leaving it unfiltered cost nothing. Now that a Vault Agent
    can populate `/vault/secrets`, an unfiltered secrets source would reopen the
    hole `_MODEL_IDENTITY_FIELDS` exists to close.
    """

    def test_a_vault_file_cannot_select_a_model(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from nlp.core.config import TokenClassificationConfig

        secrets = tmp_path / "vault-secrets"
        secrets.mkdir()
        (secrets / "NLP_MODEL_NAME").write_text("attacker/model")
        monkeypatch.setenv("HOPE_SECRETS_DIR", str(secrets))

        assert TokenClassificationConfig().model_name != "attacker/model"

    def test_a_vault_file_still_supplies_a_real_secret(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Control: the filter is identity-specific, not a blanket veto."""
        from nlp.core.config import NLPServiceConfig

        secrets = tmp_path / "vault-secrets"
        secrets.mkdir()
        (secrets / "NLP_SERVICE_TOKEN").write_text("vault-nlp-token")
        monkeypatch.setenv("HOPE_SECRETS_DIR", str(secrets))

        assert NLPServiceConfig().service_token.get_secret_value() == "vault-nlp-token"

    def test_request_injection_remains_the_one_identity_lane(self) -> None:
        from nlp.core.config import TokenClassificationConfig

        assert TokenClassificationConfig(model_name="db/selected").model_name == "db/selected"


class TestCacheKeyIncludesPath:
    """A path flip must be a cache MISS, never a stale hit on the old weights."""

    @pytest.mark.asyncio
    async def test_path_change_creates_a_new_cache_entry(self) -> None:
        from nlp.dependencies import _model_cache_key

        assert _model_cache_key("org/ner", None) != _model_cache_key(
            "org/ner", "/opt/models/ner"
        )
        assert _model_cache_key("org/ner", "/a") != _model_cache_key("org/ner", "/b")

    def test_same_identity_is_a_cache_hit(self) -> None:
        from nlp.dependencies import _model_cache_key

        assert _model_cache_key("org/ner", "/a") == _model_cache_key("org/ner", "/a")
        assert _model_cache_key("org/ner", None) == _model_cache_key("org/ner", None)
