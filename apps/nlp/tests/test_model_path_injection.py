"""The gateway-injected `model_path` reaches `from_pretrained`.

NLP is deliberately stateless (no DB), so `AiModel.localPath` can only arrive by
request injection. `_MODEL_IDENTITY_FIELDS` in `nlp/core/config.py` already
blocks the environment from setting `model_path`, making the request the single
sanctioned identity lane — these tests lock that in.
"""

from __future__ import annotations

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
