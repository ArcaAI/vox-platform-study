"""Claim-check store configuration tests.

The claim-check needs a ``HARNESS_CLAIM_CHECK_*`` sub-config: the store selector
(``s3`` self-hosted MinIO | ``memory`` dev/test), the offload byte threshold, the
bucket, and the MinIO endpoint + ``SecretStr`` creds. Env-driven, offline (no
network at construction), self-hosted only (no cloud egress).
"""

from __future__ import annotations

import pytest
from pydantic import SecretStr, ValidationError

from harness.core.config import ClaimCheckConfig, Settings

_CLAIM_CHECK_ENV = (
    "HARNESS_CLAIM_CHECK_ENABLED",
    "HARNESS_CLAIM_CHECK_STORE",
    "HARNESS_CLAIM_CHECK_MIN_BYTES",
    "HARNESS_CLAIM_CHECK_BUCKET",
    "HARNESS_CLAIM_CHECK_ENDPOINT_URL",
    "HARNESS_CLAIM_CHECK_ACCESS_KEY",
    "HARNESS_CLAIM_CHECK_SECRET_KEY",
    "HARNESS_CLAIM_CHECK_REGION",
    "HARNESS_CLAIM_CHECK_SECURE",
    "HARNESS_CLAIM_CHECK_TTL_SECONDS",
)


class TestClaimCheckConfig:
    def test_defaults_offload_on_threshold_set_self_hosted(self, monkeypatch: pytest.MonkeyPatch):
        for var in _CLAIM_CHECK_ENV:
            monkeypatch.delenv(var, raising=False)
        c = ClaimCheckConfig()
        # Offload ON with a threshold set (protect the history budget by default).
        assert c.enabled is True
        assert c.min_bytes > 0
        # Dev/test default store is the process-local in-memory fake; prod sets s3.
        assert c.store == "memory"
        # Creds are SecretStr (never plain str).
        assert isinstance(c.access_key, SecretStr)
        assert isinstance(c.secret_key, SecretStr)
        assert c.access_key.get_secret_value() == ""
        assert c.secret_key.get_secret_value() == ""
        # Self-hosted MinIO endpoint by default (no cloud host).
        assert "amazonaws.com" not in c.endpoint_url
        assert c.bucket

    def test_env_override_selects_s3_minio(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_CLAIM_CHECK_STORE", "s3")
        monkeypatch.setenv("HARNESS_CLAIM_CHECK_MIN_BYTES", "1024")
        monkeypatch.setenv("HARNESS_CLAIM_CHECK_BUCKET", "harness-blobs")
        monkeypatch.setenv("HARNESS_CLAIM_CHECK_ENDPOINT_URL", "http://minio:9000")
        monkeypatch.setenv("HARNESS_CLAIM_CHECK_ACCESS_KEY", "minio_admin")
        monkeypatch.setenv("HARNESS_CLAIM_CHECK_SECRET_KEY", "minio_secret")
        monkeypatch.setenv("HARNESS_CLAIM_CHECK_SECURE", "true")
        c = ClaimCheckConfig()
        assert c.store == "s3"
        assert c.min_bytes == 1024
        assert c.bucket == "harness-blobs"
        assert c.endpoint_url == "http://minio:9000"
        assert c.access_key.get_secret_value() == "minio_admin"
        assert c.secret_key.get_secret_value() == "minio_secret"
        assert c.secure is True

    def test_store_must_be_known_backend(self):
        with pytest.raises(ValidationError):
            ClaimCheckConfig(store="s4")

    def test_min_bytes_must_be_positive(self):
        with pytest.raises(ValidationError):
            ClaimCheckConfig(min_bytes=0)


class TestSettingsWiring:
    def test_settings_expose_claim_check_subconfig(self, monkeypatch: pytest.MonkeyPatch):
        for var in _CLAIM_CHECK_ENV:
            monkeypatch.delenv(var, raising=False)
        s = Settings()
        assert isinstance(s.claim_check, ClaimCheckConfig)
        assert s.claim_check.enabled is True

    def test_claim_check_subconfig_reads_its_prefix_through_settings(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("HARNESS_CLAIM_CHECK_BUCKET", "kb-blobs")
        assert Settings().claim_check.bucket == "kb-blobs"
