"""Unit tests for BlobService per-tenant provider routing.

Verifies:
* With NO tenant descriptor, BlobService keeps using the global MinIO client
  (unchanged behaviour) for both upload and download.
* With a tenant descriptor registered, BlobService routes I/O to the resolved
  provider and does NOT touch the global MinIO client.
* When the platform default is ``azure_blob`` (no descriptor), the default
  provider is used.
* A full upload path (``upload_transcript``) honours the descriptor's bucket.

The provider factory and vendor SDKs are mocked — no network is touched.
"""

from unittest.mock import MagicMock, patch

import pytest

from stt.storage.blob_service import BlobService
from stt.storage.path_resolver import StoragePathResolver


@pytest.fixture
def resolver():
    return StoragePathResolver(audio_bucket="hope-audio", chunk_bucket="hope-chunks")


def _make_service(resolver, storage_provider="minio"):
    with patch("stt.storage.blob_service.get_settings") as mock_settings:
        mock_settings.return_value = MagicMock(storage_provider=storage_provider)
        return BlobService(path_resolver=resolver)


# =========================================================================
# No descriptor -> global MinIO client (unchanged behaviour)
# =========================================================================


class TestNoDescriptorUsesGlobalMinio:
    @pytest.mark.asyncio
    async def test_upload_uses_global_minio_client(self, resolver):
        service = _make_service(resolver)
        mock_client = MagicMock()
        mock_client.client.bucket_exists.return_value = True

        with patch(
            "stt.storage.blob_service.get_minio_client", return_value=mock_client
        ):
            await service._upload_bytes(
                bucket="hope-audio",
                path="p/o.bin",
                data=b"x",
                content_type="application/octet-stream",
                tenant_id="tenant-without-descriptor",
            )

        mock_client.client.put_object.assert_called_once()

    @pytest.mark.asyncio
    async def test_download_uses_global_minio_client(self, resolver):
        service = _make_service(resolver)
        response = MagicMock()
        response.read.return_value = b"audio"
        mock_client = MagicMock()
        mock_client.client.get_object.return_value = response

        with patch(
            "stt.storage.blob_service.get_minio_client", return_value=mock_client
        ):
            data = await service._download_bytes("hope-audio", "p/o.bin", tenant_id=None)

        assert data == b"audio"
        response.close.assert_called_once()
        response.release_conn.assert_called_once()

    @pytest.mark.asyncio
    async def test_no_descriptor_does_not_build_provider(self, resolver):
        service = _make_service(resolver)
        mock_client = MagicMock()
        mock_client.client.bucket_exists.return_value = True

        with (
            patch("stt.storage.blob_service.get_minio_client", return_value=mock_client),
            patch("stt.storage.blob_service.build_provider") as mock_build,
            patch("stt.storage.blob_service.default_provider") as mock_default,
        ):
            await service._upload_bytes(
                bucket="hope-audio",
                path="p/o.bin",
                data=b"x",
                content_type="application/octet-stream",
                tenant_id="tenant-x",
            )

        mock_build.assert_not_called()
        mock_default.assert_not_called()


# =========================================================================
# Descriptor present -> route to resolved provider
# =========================================================================


class TestDescriptorRoutesToProvider:
    @pytest.mark.asyncio
    async def test_upload_routes_to_provider(self, resolver):
        service = _make_service(resolver)
        resolver.set_tenant_storage(
            "tenant-az",
            {"provider": "azure_blob", "bucket": "c1", "connection_string": "conn"},
        )
        fake_provider = MagicMock()

        with (
            patch(
                "stt.storage.blob_service.build_provider", return_value=fake_provider
            ) as mock_build,
            patch("stt.storage.blob_service.get_minio_client") as mock_minio,
        ):
            await service._upload_bytes(
                bucket="c1",
                path="p/o.bin",
                data=b"x",
                content_type="text/plain",
                tenant_id="tenant-az",
            )

        mock_build.assert_called_once()
        fake_provider.ensure_bucket.assert_called_once_with("c1")
        fake_provider.put_bytes.assert_called_once_with("c1", "p/o.bin", b"x", "text/plain")
        mock_minio.assert_not_called()

    @pytest.mark.asyncio
    async def test_download_routes_to_provider(self, resolver):
        service = _make_service(resolver)
        resolver.set_tenant_storage(
            "tenant-s3",
            {
                "provider": "aws_s3",
                "bucket": "b1",
                "access_key_id": "ak",
                "secret_access_key": "sk",
            },
        )
        fake_provider = MagicMock()
        fake_provider.get_bytes.return_value = b"audio-from-s3"

        with (
            patch("stt.storage.blob_service.build_provider", return_value=fake_provider),
            patch("stt.storage.blob_service.get_minio_client") as mock_minio,
        ):
            data = await service._download_bytes("b1", "p/o.bin", tenant_id="tenant-s3")

        assert data == b"audio-from-s3"
        fake_provider.get_bytes.assert_called_once_with("b1", "p/o.bin")
        mock_minio.assert_not_called()

    @pytest.mark.asyncio
    async def test_upload_transcript_uses_descriptor_bucket_and_provider(self, resolver):
        service = _make_service(resolver)
        resolver.set_tenant_storage(
            "tenant-9",
            {
                "provider": "aws_s3",
                "bucket": "tenant-9-bucket",
                "access_key_id": "ak",
                "secret_access_key": "sk",
            },
        )
        fake_provider = MagicMock()

        with patch(
            "stt.storage.blob_service.build_provider", return_value=fake_provider
        ):
            uri = await service.upload_transcript(
                transcript_data='{"text": "hello"}',
                tenant_id="tenant-9",
                job_id="j-1",
                format="json",
            )

        # The descriptor's bucket wins for this tenant's audio I/O.
        assert "tenant-9-bucket" in uri
        fake_provider.put_bytes.assert_called_once()
        bucket_arg = fake_provider.put_bytes.call_args.args[0]
        assert bucket_arg == "tenant-9-bucket"

    @pytest.mark.asyncio
    async def test_download_audio_threads_tenant_id(self, resolver):
        """download_audio(uri, tenant_id=...) routes to the tenant provider."""
        service = _make_service(resolver)
        resolver.set_tenant_storage(
            "tenant-dl",
            {"provider": "aws_s3", "bucket": "b1", "access_key_id": "ak", "secret_access_key": "sk"},
        )
        fake_provider = MagicMock()
        fake_provider.get_bytes.return_value = b"bytes"

        with patch(
            "stt.storage.blob_service.build_provider", return_value=fake_provider
        ):
            data = await service.download_audio("s3://b1/p/o.bin", tenant_id="tenant-dl")

        assert data == b"bytes"
        fake_provider.get_bytes.assert_called_once_with("b1", "p/o.bin")


# =========================================================================
# Global Azure default (no descriptor, STORAGE_PROVIDER=azure_blob)
# =========================================================================


class TestGlobalAzureDefault:
    @pytest.mark.asyncio
    async def test_upload_uses_default_provider_when_azure_global(self, resolver):
        service = _make_service(resolver, storage_provider="azure_blob")
        fake_provider = MagicMock()

        with (
            patch(
                "stt.storage.blob_service.default_provider", return_value=fake_provider
            ) as mock_default,
            patch("stt.storage.blob_service.get_minio_client") as mock_minio,
        ):
            await service._upload_bytes(
                bucket="c",
                path="p/o.bin",
                data=b"x",
                content_type="text/plain",
                tenant_id="tenant-no-descriptor",
            )

        mock_default.assert_called_once()
        fake_provider.put_bytes.assert_called_once()
        mock_minio.assert_not_called()
