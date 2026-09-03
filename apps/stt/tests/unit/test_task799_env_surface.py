"""lane C — the rest of stt's env-surface reduction.

Four separate defects, each with its own mechanism, grouped here because they
all answer the same question: *is this variable still reachable from the
environment, and should it be?*

  • a DEAD knob an operator can still set (`PRELOAD_PIPELINES`)
  • a value configured TWICE, in code and in the database schema
    (`VOICE_PROFILE_EMBEDDING_DIM`)
  • BUILD IDENTITY masquerading as configuration (`APP_NAME` / `APP_VERSION`)
  • a DUAL ALIAS with no rule for when the second name would differ
    (`STT_V2_MODEL_S3_*`)
  • a real CREDENTIAL as a code default (`minio_admin`)
"""

from __future__ import annotations

import re
from pathlib import Path

from stt.core.config.settings import Settings

_REPO_ROOT = Path(__file__).resolve().parents[4]
_USER_PRISMA = _REPO_ROOT / "packages/database/src/prisma/db_main/user.prisma"


class TestDeadAndDuplicatedKnobsAreGone:
    def test_preload_pipelines_is_removed(self) -> None:
        """A DEPRECATED knob an operator can still set is worse than no knob.

        Its own description said "DEPRECATED … Not used for provider/model/
        pipeline selection", and it shipped anyway. Setting it looked like it
        did something.
        """
        assert "preload_pipelines" not in Settings.model_fields

    def test_voice_profile_embedding_dim_is_not_configurable(self) -> None:
        """The dimension is a property of the deployed column, not a knob.

        Its own docstring conceded the point — "must match the deployed
        `UserVoiceProfile.embedding vector(N)` column" — while remaining an
        independently settable env var. Two sources for one fact, one of which
        can be changed without the other, is a guaranteed mismatch: setting it
        to 192 against a `vector(256)` column does not perform the ECAPA
        cutover, it just makes enrollment reject every embedding.
        """
        assert "voice_profile_embedding_dim" not in Settings.model_fields

    def test_the_embedding_dim_constant_matches_the_prisma_column(self) -> None:
        """The remaining single source is GATED against the schema.

        Parsed, not transcribed: a hand-copied number would reintroduce exactly
        the drift this test exists to prevent.
        """
        from stt.voice_profile.extraction_service import EXPECTED_EMBEDDING_DIM

        schema = _USER_PRISMA.read_text(encoding="utf-8")
        match = re.search(r'embedding\s+Unsupported\("vector\((\d+)\)"\)', schema)
        assert match is not None, f'no `embedding Unsupported("vector(N)")` in {_USER_PRISMA}'
        assert EXPECTED_EMBEDDING_DIM == int(match.group(1))


class TestBuildIdentityIsNotConfiguration:
    def test_app_name_and_version_are_not_settable_from_env(self, monkeypatch) -> None:
        """Rule 09: build identity "must never be made settable from an env file".

        `APP_VERSION` was a plain field defaulting to `"2.0.0"`, so the service
        would happily report whatever version an environment variable claimed —
        the same defect class as `apps/api` reporting `0.1.0` everywhere. The
        real answer lives in the image's `build-info.json`.
        """
        monkeypatch.setenv("APP_NAME", "not-stt")
        monkeypatch.setenv("APP_VERSION", "9.9.9")
        monkeypatch.setenv("STT_APP_NAME", "not-stt")
        monkeypatch.setenv("STT_APP_VERSION", "9.9.9")

        settings = Settings(_env_file=None)

        assert settings.app_name == "stt"
        assert settings.app_version == "2.0.0"


class TestModelS3AliasCollapsed:
    def test_the_v2_alias_is_gone(self, monkeypatch) -> None:
        """`STT_V2_MODEL_S3_*` was a second spelling with no rule of its own.

        Nothing in the codebase documented when `STT_V2_…` would carry a
        different value from `STT_…`, so it was a coin-flip which one an
        operator set and a coin-flip which one won. One name, one value.
        """
        monkeypatch.setenv("STT_V2_MODEL_S3_ENDPOINT", "v2-endpoint:9000")
        monkeypatch.setenv("STT_V2_MODEL_S3_ACCESS_KEY", "v2-key")

        settings = Settings(_env_file=None)

        assert settings.model_s3_endpoint is None
        assert settings.model_s3_access_key is None

    def test_the_canonical_name_is_now_CLOSED_TOO(self, monkeypatch) -> None:
        """The surviving canonical spelling has since been closed as well.

        Collapsing the `STT_V2_` alias left ONE env name for the model-store
        credential; removed that one too. Endpoint, access key id and
        secret key are ONE credential and moved together onto
        `AiProviderConnection` (`model-registry` / `s3`), resolved for the
        tenant that OWNS the model being fetched.

        The endpoint moved WITH the pair rather than staying behind in env: a
        tenant bringing its own weights bucket brings its own host, and keeping
        the host in a different tier from the key is how a credential ends up
        pointed at the wrong endpoint. Detail in
        `test_settings.py::test_model_s3_credential_env_paths_are_CLOSED`.
        """
        monkeypatch.setenv("STT_MODEL_S3_ENDPOINT", "minio:9000")
        settings = Settings(_env_file=None)
        assert settings.model_s3_endpoint is None


class TestNoCredentialHasARealCodeDefault:
    def test_minio_credentials_default_to_empty(self) -> None:
        """`SecretStr("minio_admin")` was a working credential compiled in.

        Rule 00: "a credential … is NOT a literal in code". A credential default
        that authenticates against the dev stack is also the reason nobody
        notices when the real one fails to load — the service keeps working on
        the built-in one, right up until the environment where it does not.
        """
        settings = Settings(_env_file=None)
        assert settings.minio_access_key.get_secret_value() == ""
        assert settings.minio_secret_key.get_secret_value() == ""

    def test_every_secret_field_defaults_empty_or_none(self) -> None:
        """The general form, so the next credential added cannot regress."""
        from pydantic import SecretStr

        offenders = []
        for name, field in Settings.model_fields.items():
            default = field.default
            if isinstance(default, SecretStr) and default.get_secret_value():
                offenders.append(name)
        assert offenders == [], f"credential fields with a real code default: {offenders}"
