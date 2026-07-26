"""Unit tests for the pluggable storage providers.

Covers:
* ``factory.build_provider`` returning S3 vs Azure providers per ``provider``.
* Descriptor parsing tolerating missing optional keys.
* Provider caching by descriptor identity.
* ``default_provider`` (global MinIO wrapper vs Azure when configured).
* S3 and Azure provider method behaviour with the vendor SDKs mocked.
* ``StoragePathResolver.set_tenant_storage`` / ``resolve_tenant_storage``.

No network is touched: ``minio.Minio`` and ``azure.storage.blob.BlobServiceClient``
are mocked.
"""

from unittest.mock import MagicMock, patch

import pytest
from pydantic import SecretStr

from stt.core.storage.providers import (
    AzureBlobStorageProvider,
    S3BlobStorageProvider,
    build_provider,
    clear_provider_cache,
    default_provider,
)
from stt.core.storage.providers.factory import _GlobalMinioProvider
from stt.storage.path_resolver import StoragePathResolver


@pytest.fixture(autouse=True)
def _clear_cache():
    """Ensure the provider cache never leaks between tests."""
    clear_provider_cache()
    yield
    clear_provider_cache()


# =========================================================================
# build_provider — provider selection
# =========================================================================


class TestBuildProviderSelection:
    """build_provider returns the correct provider type per descriptor."""

    def test_minio_provider(self):
        with patch("minio.Minio") as mock_minio:
            provider = build_provider(
                {
                    "provider": "minio",
                    "bucket": "b",
                    "endpoint": "http://localhost:9000",
                    "access_key_id": "ak",
                    "secret_access_key": "sk",
                }
            )

        assert isinstance(provider, S3BlobStorageProvider)
        kwargs = mock_minio.call_args.kwargs
        assert kwargs["endpoint"] == "localhost:9000"
        assert kwargs["secure"] is False
        assert kwargs["access_key"] == "ak"
        assert kwargs["secret_key"] == "sk"

    def test_aws_s3_provider_with_https_endpoint(self):
        with patch("minio.Minio") as mock_minio:
            provider = build_provider(
                {
                    "provider": "aws_s3",
                    "bucket": "b",
                    "endpoint": "https://s3.custom.example.com",
                    "region": "eu-west-1",
                    "access_key_id": "ak",
                    "secret_access_key": "sk",
                }
            )

        assert isinstance(provider, S3BlobStorageProvider)
        kwargs = mock_minio.call_args.kwargs
        assert kwargs["endpoint"] == "s3.custom.example.com"
        assert kwargs["secure"] is True
        assert kwargs["region"] == "eu-west-1"

    def test_aws_s3_provider_real_aws_no_endpoint(self):
        """No endpoint => derive s3.<region>.amazonaws.com with TLS."""
        with patch("minio.Minio") as mock_minio:
            build_provider(
                {
                    "provider": "aws_s3",
                    "bucket": "b",
                    "region": "us-west-2",
                    "access_key_id": "ak",
                    "secret_access_key": "sk",
                }
            )

        kwargs = mock_minio.call_args.kwargs
        assert kwargs["endpoint"] == "s3.us-west-2.amazonaws.com"
        assert kwargs["secure"] is True
        assert kwargs["region"] == "us-west-2"

    def test_azure_provider_via_connection_string(self):
        with patch("azure.storage.blob.BlobServiceClient") as mock_bsc:
            provider = build_provider(
                {
                    "provider": "azure_blob",
                    "bucket": "container",
                    "connection_string": "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=k",
                }
            )

        assert isinstance(provider, AzureBlobStorageProvider)
        mock_bsc.from_connection_string.assert_called_once()

    def test_azure_provider_via_account_key(self):
        with patch("azure.storage.blob.BlobServiceClient") as mock_bsc:
            build_provider(
                {
                    "provider": "azure_blob",
                    "bucket": "container",
                    "account_name": "acct",
                    "account_key": "key",
                    "endpoint_suffix": "core.windows.net",
                }
            )

        kwargs = mock_bsc.call_args.kwargs
        assert kwargs["account_url"] == "https://acct.blob.core.windows.net"
        assert kwargs["credential"] == "key"


# =========================================================================
# build_provider — error handling
# =========================================================================


class TestBuildProviderErrors:
    """build_provider validates the descriptor."""

    def test_empty_descriptor_raises(self):
        with pytest.raises(ValueError):
            build_provider({})

    def test_missing_provider_raises(self):
        with pytest.raises(ValueError):
            build_provider({"bucket": "b"})

    def test_unsupported_provider_raises(self):
        with pytest.raises(ValueError, match="Unsupported storage provider"):
            build_provider({"provider": "gcs", "bucket": "b"})

    def test_azure_without_credentials_raises(self):
        with patch("azure.storage.blob.BlobServiceClient"):
            with pytest.raises(ValueError, match="Azure storage provider requires"):
                build_provider({"provider": "azure_blob", "bucket": "c"})


# =========================================================================
# Descriptor parsing tolerance + caching
# =========================================================================


class TestDescriptorParsing:
    """Optional keys may be missing/None without crashing."""

    def test_s3_tolerates_missing_optional_keys(self):
        with patch("minio.Minio") as mock_minio:
            provider = build_provider({"provider": "aws_s3", "bucket": "b"})

        assert isinstance(provider, S3BlobStorageProvider)
        kwargs = mock_minio.call_args.kwargs
        # Missing endpoint => real AWS default region.
        assert kwargs["endpoint"] == "s3.us-east-1.amazonaws.com"
        # Missing creds collapse to None for the SDK.
        assert kwargs["access_key"] is None
        assert kwargs["secret_key"] is None

    def test_s3_tolerates_explicit_null_values(self):
        with patch("minio.Minio") as mock_minio:
            build_provider(
                {
                    "provider": "minio",
                    "bucket": "b",
                    "endpoint": None,
                    "region": None,
                    "force_path_style": None,
                    "access_key_id": None,
                    "secret_access_key": None,
                }
            )

        kwargs = mock_minio.call_args.kwargs
        assert kwargs["endpoint"] == "s3.us-east-1.amazonaws.com"

    def test_azure_defaults_endpoint_suffix_when_absent(self):
        with patch("azure.storage.blob.BlobServiceClient") as mock_bsc:
            build_provider(
                {
                    "provider": "azure_blob",
                    "bucket": "c",
                    "account_name": "acct",
                    "account_key": "key",
                }
            )

        assert mock_bsc.call_args.kwargs["account_url"] == "https://acct.blob.core.windows.net"

    def test_identical_descriptors_are_cached(self):
        descriptor = {
            "provider": "minio",
            "bucket": "b",
            "endpoint": "http://x:9000",
            "access_key_id": "ak",
            "secret_access_key": "sk",
        }
        with patch("minio.Minio") as mock_minio:
            p1 = build_provider(descriptor)
            p2 = build_provider(dict(descriptor))  # equal content, distinct dict

        assert p1 is p2
        assert mock_minio.call_count == 1

    def test_different_credentials_are_not_cached_together(self):
        with patch("minio.Minio") as mock_minio:
            build_provider(
                {"provider": "minio", "bucket": "b", "endpoint": "http://x:9000",
                 "access_key_id": "ak1", "secret_access_key": "sk1"}
            )
            build_provider(
                {"provider": "minio", "bucket": "b", "endpoint": "http://x:9000",
                 "access_key_id": "ak2", "secret_access_key": "sk2"}
            )

        assert mock_minio.call_count == 2


# =========================================================================
# default_provider
# =========================================================================


class TestDefaultProvider:
    """default_provider wraps MinIO unless STORAGE_PROVIDER=azure_blob."""

    def test_default_is_global_minio_wrapper(self):
        with patch("stt.core.storage.providers.factory.get_settings") as mock_settings:
            mock_settings.return_value = MagicMock(storage_provider="minio")
            provider = default_provider()

        assert isinstance(provider, _GlobalMinioProvider)

    def test_default_azure_when_configured(self):
        with (
            patch("stt.core.storage.providers.factory.get_settings") as mock_settings,
            patch("azure.storage.blob.BlobServiceClient") as mock_bsc,
        ):
            mock_settings.return_value = MagicMock(
                storage_provider="azure_blob",
                azure_storage_connection_string=SecretStr(""),
                azure_storage_account="acct",
                azure_storage_account_key=SecretStr("key"),
                azure_storage_endpoint_suffix="core.windows.net",
            )
            provider = default_provider()

        assert isinstance(provider, AzureBlobStorageProvider)
        assert mock_bsc.call_args.kwargs["account_url"] == "https://acct.blob.core.windows.net"

    def test_global_minio_wrapper_delegates_to_global_client(self):
        provider = _GlobalMinioProvider()
        mock_client = MagicMock()
        mock_client.client.bucket_exists.return_value = False
        with patch(
            "stt.core.storage.minio_client.get_minio_client",
            return_value=mock_client,
        ):
            provider.ensure_bucket("bk")
            provider.put_bytes("bk", "key", b"data", "text/plain")

        mock_client.client.make_bucket.assert_called_once_with("bk")
        mock_client.client.put_object.assert_called_once()


# =========================================================================
# S3 provider method behaviour
# =========================================================================


class TestS3Provider:
    """S3BlobStorageProvider against a mocked minio.Minio client."""

    @pytest.fixture
    def s3(self):
        with patch("minio.Minio") as mock_minio:
            mock_client = MagicMock()
            mock_minio.return_value = mock_client
            provider = S3BlobStorageProvider("host:9000", "ak", "sk", secure=False)
            provider._mock_client = mock_client  # type: ignore[attr-defined]
            return provider

    def test_ensure_bucket_creates_when_missing(self, s3):
        s3._mock_client.bucket_exists.return_value = False
        s3.ensure_bucket("bk")
        s3._mock_client.make_bucket.assert_called_once_with("bk")

    def test_ensure_bucket_skips_when_present(self, s3):
        s3._mock_client.bucket_exists.return_value = True
        s3.ensure_bucket("bk")
        s3._mock_client.make_bucket.assert_not_called()

    def test_put_bytes(self, s3):
        s3.put_bytes("bk", "key", b"data", "text/plain")
        args, kwargs = s3._mock_client.put_object.call_args
        assert args[0] == "bk"
        assert args[1] == "key"
        assert kwargs["content_type"] == "text/plain"

    def test_get_bytes_reads_and_releases(self, s3):
        response = MagicMock()
        response.read.return_value = b"payload"
        s3._mock_client.get_object.return_value = response

        assert s3.get_bytes("bk", "key") == b"payload"
        response.close.assert_called_once()
        response.release_conn.assert_called_once()

    def test_object_exists_true(self, s3):
        s3._mock_client.stat_object.return_value = MagicMock()
        assert s3.object_exists("bk", "key") is True

    def test_object_exists_false_on_error(self, s3):
        s3._mock_client.stat_object.side_effect = Exception("missing")
        assert s3.object_exists("bk", "key") is False


# =========================================================================
# Azure provider method behaviour
# =========================================================================


class TestAzureProvider:
    """AzureBlobStorageProvider against a mocked BlobServiceClient."""

    @pytest.fixture
    def azure(self):
        with patch("azure.storage.blob.BlobServiceClient") as mock_bsc:
            mock_service = MagicMock()
            mock_bsc.from_connection_string.return_value = mock_service
            provider = AzureBlobStorageProvider(connection_string="conn")
            provider._mock_service = mock_service  # type: ignore[attr-defined]
            return provider

    def test_ensure_bucket_creates_container(self, azure):
        container = MagicMock()
        azure._mock_service.get_container_client.return_value = container
        azure.ensure_bucket("c")
        container.create_container.assert_called_once()

    def test_ensure_bucket_ignores_already_exists(self, azure):
        from azure.core.exceptions import ResourceExistsError

        container = MagicMock()
        container.create_container.side_effect = ResourceExistsError("exists")
        azure._mock_service.get_container_client.return_value = container
        # Should not raise
        azure.ensure_bucket("c")

    def test_put_bytes(self, azure):
        blob = MagicMock()
        azure._mock_service.get_blob_client.return_value = blob
        azure.put_bytes("c", "k", b"data", "text/plain")
        blob.upload_blob.assert_called_once()
        assert azure._mock_service.get_blob_client.call_args.kwargs == {
            "container": "c",
            "blob": "k",
        }

    def test_get_bytes(self, azure):
        blob = MagicMock()
        downloader = MagicMock()
        downloader.readall.return_value = b"payload"
        blob.download_blob.return_value = downloader
        azure._mock_service.get_blob_client.return_value = blob

        assert azure.get_bytes("c", "k") == b"payload"

    def test_object_exists(self, azure):
        blob = MagicMock()
        blob.exists.return_value = True
        azure._mock_service.get_blob_client.return_value = blob
        assert azure.object_exists("c", "k") is True


# =========================================================================
# StoragePathResolver tenant storage registry
# =========================================================================


class TestTenantStorageResolver:
    """set_tenant_storage / resolve_tenant_storage mirror set_tenant_bucket."""

    def test_resolve_returns_none_by_default(self):
        resolver = StoragePathResolver()
        assert resolver.resolve_tenant_storage("t1") is None

    def test_set_then_resolve_roundtrip(self):
        resolver = StoragePathResolver()
        descriptor = {"provider": "azure_blob", "bucket": "c1"}
        resolver.set_tenant_storage("t1", descriptor)
        assert resolver.resolve_tenant_storage("t1") == descriptor

    def test_descriptor_bucket_pins_audio_bucket(self):
        resolver = StoragePathResolver(audio_bucket="hope-audio")
        resolver.set_tenant_storage("t1", {"provider": "aws_s3", "bucket": "tenant-1-bucket"})
        assert resolver.resolve_tenant_bucket("t1", "audio") == "tenant-1-bucket"

    def test_descriptor_without_bucket_keeps_default(self):
        resolver = StoragePathResolver(audio_bucket="hope-audio")
        resolver.set_tenant_storage("t1", {"provider": "aws_s3"})
        assert resolver.resolve_tenant_bucket("t1", "audio") == "hope-audio"

    def test_registry_is_isolated_per_tenant(self):
        resolver = StoragePathResolver()
        resolver.set_tenant_storage("t1", {"provider": "minio", "bucket": "b1"})
        assert resolver.resolve_tenant_storage("t2") is None
