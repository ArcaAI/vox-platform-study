"""MinIO TLS certificate verification — the ``MINIO_CERT_CHECK`` relaxation.

Owner ruling (2026-08-30): there is no private CA. MinIO keeps HTTPS on :9000
and authenticates with a service account (access key + secret), so every
S3/MinIO client in this service must be able to SKIP certificate verification,
and the default must match how the platform is actually deployed today — which
is "no CA, so no verification".

These tests pin three things:
  1. the default of the one knob (`Settings.minio_cert_check`),
  2. that `S3BlobStorageProvider` honours it, and
  3. that the model-source resolver's S3 client honours it.

`MinIOClient` already had the knob and is covered by `test_minio_client.py`;
only its DEFAULT is asserted here.
"""

from unittest.mock import MagicMock, patch

from stt.core.config.settings import Settings
from stt.core.storage.providers.s3_provider import S3BlobStorageProvider
from stt.models.source_resolver import ModelSourceConfig, _make_s3_client


class TestCertCheckDefault:
    def test_settings_default_is_off(self, monkeypatch):
        """Absent `MINIO_CERT_CHECK` ⇒ verification OFF (the deployed posture)."""
        monkeypatch.delenv("MINIO_CERT_CHECK", raising=False)
        assert Settings(_env_file=None).minio_cert_check is False

    def test_settings_opt_in(self, monkeypatch):
        monkeypatch.setenv("MINIO_CERT_CHECK", "true")
        assert Settings(_env_file=None).minio_cert_check is True

    def test_model_source_config_default_is_off(self):
        assert ModelSourceConfig(cache_dir="/tmp/x").s3_cert_check is False


class TestS3BlobStorageProviderCertCheck:
    def test_secure_without_cert_check_disables_verification(self):
        with patch("stt.core.storage.providers.s3_provider.minio.Minio") as mock_minio:
            S3BlobStorageProvider(
                endpoint="minio.internal:9000",
                access_key="ak",
                secret_key="sk",
                secure=True,
                cert_check=False,
            )
        kwargs = mock_minio.call_args.kwargs
        assert kwargs["http_client"].connection_pool_kw["cert_reqs"] == "CERT_NONE"

    def test_secure_with_cert_check_keeps_the_default_pool(self):
        with patch("stt.core.storage.providers.s3_provider.minio.Minio") as mock_minio:
            S3BlobStorageProvider(
                endpoint="minio.internal:9000",
                access_key="ak",
                secret_key="sk",
                secure=True,
                cert_check=True,
            )
        assert "http_client" not in mock_minio.call_args.kwargs

    def test_plaintext_never_installs_a_pool(self):
        """No TLS ⇒ nothing to relax; the knob must not change the client."""
        with patch("stt.core.storage.providers.s3_provider.minio.Minio") as mock_minio:
            S3BlobStorageProvider(
                endpoint="localhost:9000",
                access_key="ak",
                secret_key="sk",
                secure=False,
                cert_check=False,
            )
        assert "http_client" not in mock_minio.call_args.kwargs


class TestModelSourceResolverCertCheck:
    def _config(self, **overrides) -> ModelSourceConfig:
        return ModelSourceConfig(
            cache_dir="/tmp/cache",
            s3_endpoint="minio.internal:9000",
            s3_access_key="ak",
            s3_secret_key="sk",
            s3_secure=True,
            **overrides,
        )

    def test_secure_without_cert_check_disables_verification(self):
        with patch("minio.Minio") as mock_minio:
            mock_minio.return_value = MagicMock()
            _make_s3_client(self._config(s3_cert_check=False))
        kwargs = mock_minio.call_args.kwargs
        assert kwargs["http_client"].connection_pool_kw["cert_reqs"] == "CERT_NONE"

    def test_secure_with_cert_check_keeps_the_default_pool(self):
        with patch("minio.Minio") as mock_minio:
            mock_minio.return_value = MagicMock()
            _make_s3_client(self._config(s3_cert_check=True))
        assert "http_client" not in mock_minio.call_args.kwargs
