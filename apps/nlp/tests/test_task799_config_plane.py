"""TASK-799 lane C — the shared `hope_env` precedence chain, CORS, and dead config.

Three separate defects, one file because they all pin the SHAPE of
`nlp/core/config.py` rather than any runtime behaviour:

* C.1 (F-09) — `NLPServiceConfig.__init__` used to `kwargs.setdefault(...)` from
  bare `os.getenv` for 11 fields. `init_settings` is the HIGHEST-precedence
  source in `build_hope_sources`, so those values outranked host env, the Vault
  `secrets_dir` tier AND the env file — the module-scope env-read pattern
  TASK-558 removed, reintroduced through a different door.
* C.5 (F-12) — wildcard origins with `allow_credentials=True` is a cross-origin
  credential-leak posture, and the declared `cors_allow_credentials` knob that
  would have disabled it was never read.
* C.6 (F-13) — two entire never-instantiated settings classes.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from nlp.core.config import NLPServiceConfig, SecurityConfig


class TestPrecedenceChainApplies:
    """Host env > secrets_dir (Vault Agent) > .env file > code default.

    Each case uses a field the `setdefault` block used to pin, so a regression
    to `init_settings` fails here rather than in production.
    """

    def test_host_env_beats_the_code_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NLP_PORT", "9999")
        assert NLPServiceConfig().port == 9999

    def test_the_unprefixed_name_still_works(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """`PORT`/`HOST`/`WORKERS` were the names the removed block read; the
        deployment sets them, so they stay accepted as explicit aliases."""
        monkeypatch.delenv("NLP_PORT", raising=False)
        monkeypatch.setenv("PORT", "9998")
        monkeypatch.setenv("HOST", "127.0.0.1")
        monkeypatch.setenv("WORKERS", "7")

        config = NLPServiceConfig()
        assert (config.port, config.host, config.workers) == (9998, "127.0.0.1", 7)

    def test_prefixed_name_wins_over_the_unprefixed_one(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`turbo.json#globalEnv` declares `NLP_PORT`; it must be the reachable
        name, not a phantom (F-15)."""
        monkeypatch.setenv("NLP_PORT", "9001")
        monkeypatch.setenv("PORT", "9002")
        assert NLPServiceConfig().port == 9001

    def test_host_env_reaches_the_boolean_switches(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("NLP_TRACES_ENABLED", "false")
        monkeypatch.setenv("NLP_OTEL_ENABLED", "true")
        config = NLPServiceConfig()
        assert config.traces_enabled is False
        assert config.otel_enabled is True

    def test_a_vault_secrets_dir_file_beats_the_code_default(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The whole point of F-09: a Vault-Agent-rendered file was silently
        ignored for every field the `setdefault` block pinned."""
        monkeypatch.delenv("NLP_PORT", raising=False)
        monkeypatch.delenv("PORT", raising=False)
        secrets = tmp_path / "vault-secrets"
        secrets.mkdir()
        (secrets / "NLP_PORT").write_text("9997")
        monkeypatch.setenv("HOPE_SECRETS_DIR", str(secrets))

        assert NLPServiceConfig().port == 9997

    def test_host_env_beats_the_vault_secrets_dir_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        secrets = tmp_path / "vault-secrets"
        secrets.mkdir()
        (secrets / "NLP_PORT").write_text("9997")
        monkeypatch.setenv("HOPE_SECRETS_DIR", str(secrets))
        monkeypatch.setenv("NLP_PORT", "9996")

        assert NLPServiceConfig().port == 9996

    def test_no_init_override_shadows_the_source_chain(self) -> None:
        """Structural guard: an `__init__` that pre-fills kwargs re-creates F-09
        whatever the behavioural cases above happen to cover."""
        assert "__init__" not in NLPServiceConfig.__dict__


def _cors_middleware(app, cls):
    """The CORS entry Starlette recorded, read before the stack is built."""
    for middleware in app.user_middleware:
        if middleware.cls is cls:
            return middleware
    raise AssertionError("no CORS middleware registered")


class TestCorsIsNotWildcardWithCredentials:
    def test_credentials_are_off_by_default(self) -> None:
        assert SecurityConfig().cors_allow_credentials is False

    def test_wildcard_plus_credentials_is_refused(self) -> None:
        with pytest.raises(ValidationError, match="cors_allow_credentials"):
            SecurityConfig(cors_origins=["*"], cors_allow_credentials=True)

    def test_named_origins_may_carry_credentials(self) -> None:
        config = SecurityConfig(
            cors_origins=["https://console.example.test"], cors_allow_credentials=True
        )
        assert config.cors_allow_credentials is True

    def test_the_declared_field_is_the_one_the_app_applies(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`app.py` hardcoded `allow_credentials=True`, so the knob was inert."""
        from fastapi.middleware.cors import CORSMiddleware

        from nlp.app import get_app
        from nlp.core.config import settings

        monkeypatch.setattr(settings.security, "cors_allow_credentials", True, raising=False)
        monkeypatch.setattr(
            settings.security, "cors_origins", ["https://console.example.test"], raising=False
        )
        cors = _cors_middleware(get_app(), CORSMiddleware)
        assert cors.kwargs["allow_credentials"] is True
        assert cors.kwargs["allow_origins"] == ["https://console.example.test"]

        monkeypatch.setattr(settings.security, "cors_allow_credentials", False, raising=False)
        assert _cors_middleware(get_app(), CORSMiddleware).kwargs["allow_credentials"] is False


class TestDeadSettingsClassesAreGone:
    def test_websocket_config_classes_are_deleted(self) -> None:
        import nlp.core.config as config_module

        assert not hasattr(config_module, "WebSocketConfig")
        assert not hasattr(config_module, "WebSocketTokenClassificationConfig")
