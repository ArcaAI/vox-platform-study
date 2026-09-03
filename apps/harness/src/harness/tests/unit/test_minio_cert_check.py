"""MinIO TLS certificate verification — the ``MINIO_CERT_CHECK`` relaxation.

Owner ruling (2026-08-30): there is no private CA. MinIO keeps HTTPS and
authenticates with a service account (access key + secret), so the harness's
two S3-compatible clients — the claim-check blob store and the model-source
resolver — must be able to SKIP certificate verification, with a default that
matches how the platform is deployed today (no CA ⇒ no verification).

The knob is the PLATFORM-WIDE ``MINIO_CERT_CHECK``, not a
``HARNESS_CLAIM_CHECK_*`` variable of its own: one object store, one trust
decision, and it is the same variable apps/stt and apps/api already read.
"""

from unittest.mock import MagicMock, patch

from harness.core.config import ClaimCheckConfig
from harness.models.source_resolver import ModelSourceConfig, _make_s3_client
from harness.temporal.claim_check import S3BlobStore, build_blob_store


class TestCertCheckDefault:
    def test_claim_check_default_is_off(self, monkeypatch):
        """Absent `MINIO_CERT_CHECK` ⇒ verification OFF (the deployed posture)."""
        monkeypatch.delenv("MINIO_CERT_CHECK", raising=False)
        assert ClaimCheckConfig(_env_file=None).cert_check is False

    def test_claim_check_opt_in_reads_the_bare_platform_variable(self, monkeypatch):
        """Opt-in is `MINIO_CERT_CHECK`, NOT `HARNESS_CLAIM_CHECK_CERT_CHECK`."""
        monkeypatch.setenv("MINIO_CERT_CHECK", "true")
        monkeypatch.delenv("HARNESS_CLAIM_CHECK_CERT_CHECK", raising=False)
        assert ClaimCheckConfig(_env_file=None).cert_check is True

    def test_model_source_config_default_is_off(self):
        assert ModelSourceConfig(cache_dir="/tmp/x").s3_cert_check is False


class TestS3BlobStoreCertCheck:
    def _build(
        self, *, secure: bool, cert_check: bool, endpoint_url: str = "https://minio.internal:9000"
    ) -> MagicMock:
        boto3 = MagicMock()
        with patch.dict("sys.modules", {"boto3": boto3}):
            S3BlobStore(
                endpoint_url=endpoint_url,
                access_key="ak",
                secret_key="sk",
                region="us-east-1",
                secure=secure,
                cert_check=cert_check,
            )
        return boto3

    def test_secure_without_cert_check_passes_verify_false(self):
        boto3 = self._build(secure=True, cert_check=False)
        assert boto3.client.call_args.kwargs["verify"] is False

    def test_secure_with_cert_check_does_not_disable_verification(self):
        boto3 = self._build(secure=True, cert_check=True)
        assert boto3.client.call_args.kwargs.get("verify") is not False

    def test_plaintext_never_disables_verification(self):
        """No TLS ⇒ nothing to relax; the knob must not change the client."""
        boto3 = self._build(
            secure=False, cert_check=False, endpoint_url="http://minio.internal:9000"
        )
        assert boto3.client.call_args.kwargs.get("verify") is not False

    def test_https_endpoint_is_secure_even_when_the_flag_says_otherwise(self):
        """TASK-858 — boto3 takes the scheme from ``endpoint_url``, so an https URL with
        ``secure=False`` was never plaintext: it verified MinIO's internal-CA leaf against
        the system store and every claim-check read failed (`interpreter.load_config`,
        the whole governed run FAILED) on any deployment that set the URL but not
        ``HARNESS_CLAIM_CHECK_SECURE``. The URL is the truth; the flag cannot demote it."""
        boto3 = self._build(secure=False, cert_check=False)
        assert boto3.client.call_args.kwargs["verify"] is False
        assert boto3.client.call_args.kwargs["use_ssl"] is True


class TestBuildBlobStorePropagation:
    def test_build_blob_store_threads_the_config_knob(self):
        config = ClaimCheckConfig(
            _env_file=None,
            store="s3",
            endpoint_url="https://minio.internal:9000",
            secure=True,
            cert_check=False,
        )
        boto3 = MagicMock()
        with patch.dict("sys.modules", {"boto3": boto3}):
            build_blob_store(config)
        assert boto3.client.call_args.kwargs["verify"] is False


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

    def test_secure_without_cert_check_passes_verify_false(self):
        boto3 = MagicMock()
        with patch.dict("sys.modules", {"boto3": boto3}):
            _make_s3_client(self._config(s3_cert_check=False))
        assert boto3.client.call_args.kwargs["verify"] is False

    def test_secure_with_cert_check_does_not_disable_verification(self):
        boto3 = MagicMock()
        with patch.dict("sys.modules", {"boto3": boto3}):
            _make_s3_client(self._config(s3_cert_check=True))
        assert boto3.client.call_args.kwargs.get("verify") is not False
