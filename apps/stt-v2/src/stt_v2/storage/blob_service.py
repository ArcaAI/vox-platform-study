"""Blob storage service for MinIO operations."""

import asyncio
import io
import logging
from collections.abc import AsyncGenerator
from datetime import timedelta

from ..core.config.settings import get_settings
from ..core.exceptions import StorageError
from ..core.storage.minio_client import get_minio_client
from .path_resolver import StoragePathResolver, get_path_resolver

logger = logging.getLogger(__name__)


class BlobService:
    """Service for storing and retrieving blobs from MinIO."""

    def __init__(
        self,
        path_resolver: StoragePathResolver | None = None,
    ):
        """
        Initialize blob service.

        Args:
            path_resolver: Optional path resolver instance
        """
        self._resolver = path_resolver or get_path_resolver()
        self._settings = get_settings()

    async def upload_audio(
        self,
        audio_bytes: bytes,
        tenant_id: str,
        job_id: str,
        filename: str,
        consultation_id: str | None = None,
        content_type: str = "audio/wav",
    ) -> str:
        """
        Upload audio file to storage.

        Args:
            audio_bytes: Audio file bytes
            tenant_id: Tenant ID
            job_id: Transcription job ID
            filename: Original filename
            consultation_id: Optional consultation ID
            content_type: MIME type

        Returns:
            Full storage URI
        """
        path = self._resolver.audio_path(
            tenant_id=tenant_id,
            consultation_id=consultation_id,
            job_id=job_id,
            filename=filename,
        )

        await self._upload_bytes(
            bucket=self._resolver.audio_bucket,
            path=path,
            data=audio_bytes,
            content_type=content_type,
        )

        uri = self._resolver.get_full_uri(self._resolver.audio_bucket, path)
        logger.info(f"Uploaded audio to: {uri} ({len(audio_bytes)} bytes)")
        return uri

    async def upload_processed_audio(
        self,
        audio_bytes: bytes,
        tenant_id: str,
        job_id: str,
        filename: str = "processed.wav",
        consultation_id: str | None = None,
        content_type: str = "audio/wav",
    ) -> str:
        """
        Upload processed (denoised / VAD-merged) audio to storage.

        This stores the audio *after* preprocessing has been applied
        (e.g. noise cancellation, VAD segment merging).  It is stored
        separately from the raw audio so that both versions are
        available for audit / playback.

        Args:
            audio_bytes: Processed audio bytes (WAV format)
            tenant_id: Tenant ID
            job_id: Transcription job ID
            filename: Descriptive filename (default ``processed.wav``)
            consultation_id: Optional consultation ID
            content_type: MIME type

        Returns:
            Full storage URI
        """
        path = self._resolver.processed_audio_path(
            tenant_id=tenant_id,
            consultation_id=consultation_id,
            job_id=job_id,
            filename=filename,
        )

        await self._upload_bytes(
            bucket=self._resolver.audio_bucket,
            path=path,
            data=audio_bytes,
            content_type=content_type,
        )

        uri = self._resolver.get_full_uri(self._resolver.audio_bucket, path)
        logger.info(f"Uploaded processed audio to: {uri} ({len(audio_bytes)} bytes)")
        return uri

    async def upload_chunk(
        self,
        chunk_bytes: bytes,
        session_id: str,
        chunk_index: int,
        content_type: str = "audio/wav",
    ) -> str:
        """
        Upload streaming audio chunk.

        Args:
            chunk_bytes: Audio chunk bytes
            session_id: Streaming session ID
            chunk_index: Chunk sequence number
            content_type: MIME type

        Returns:
            Full storage URI
        """
        path = self._resolver.chunk_path(
            session_id=session_id,
            chunk_index=chunk_index,
        )

        await self._upload_bytes(
            bucket=self._resolver.chunk_bucket,
            path=path,
            data=chunk_bytes,
            content_type=content_type,
        )

        return self._resolver.get_full_uri(self._resolver.chunk_bucket, path)

    async def upload_streaming_raw_chunk(
        self,
        chunk_bytes: bytes,
        tenant_id: str,
        session_id: str,
        chunk_index: int,
    ) -> str:
        """Upload a periodic raw PCM chunk to storage.

        Path: ``{tenant_id}/{year}/{month}/streaming/{session_id}/raw/chunk_{NNNN}.pcm``

        Args:
            chunk_bytes: Raw PCM s16le bytes for this chunk.
            tenant_id: Tenant ID.
            session_id: Streaming session ID.
            chunk_index: Zero-based chunk sequence number.

        Returns:
            Full storage URI.
        """
        path = self._resolver.streaming_raw_chunk_path(
            tenant_id=tenant_id,
            session_id=session_id,
            chunk_index=chunk_index,
        )

        await self._upload_bytes(
            bucket=self._resolver.audio_bucket,
            path=path,
            data=chunk_bytes,
            content_type="application/octet-stream",
        )

        uri = self._resolver.get_full_uri(self._resolver.audio_bucket, path)
        logger.info(f"Uploaded streaming raw chunk to: {uri} ({len(chunk_bytes)} bytes)")
        return uri

    async def upload_streaming_processed_chunk(
        self,
        chunk_bytes: bytes,
        tenant_id: str,
        session_id: str,
        chunk_index: int,
    ) -> str:
        """Upload a processed audio chunk to storage.

        Path: ``{tenant_id}/{year}/{month}/streaming/{session_id}/processed/chunk_{NNNN}.pcm``

        Args:
            chunk_bytes: Processed PCM bytes for this chunk.
            tenant_id: Tenant ID.
            session_id: Streaming session ID.
            chunk_index: Zero-based chunk sequence number.

        Returns:
            Full storage URI.
        """
        path = self._resolver.streaming_processed_chunk_path(
            tenant_id=tenant_id,
            session_id=session_id,
            chunk_index=chunk_index,
        )

        await self._upload_bytes(
            bucket=self._resolver.audio_bucket,
            path=path,
            data=chunk_bytes,
            content_type="application/octet-stream",
        )

        uri = self._resolver.get_full_uri(self._resolver.audio_bucket, path)
        logger.info(f"Uploaded streaming processed chunk to: {uri} ({len(chunk_bytes)} bytes)")
        return uri

    async def upload_streaming_raw_complete(
        self,
        wav_bytes: bytes,
        tenant_id: str,
        session_id: str,
    ) -> str:
        """Upload the final combined WAV to storage.

        Path: ``{tenant_id}/{year}/{month}/streaming/{session_id}/raw/complete.wav``

        Args:
            wav_bytes: WAV-encoded audio bytes.
            tenant_id: Tenant ID.
            session_id: Streaming session ID.

        Returns:
            Full storage URI.
        """
        path = self._resolver.streaming_raw_complete_path(
            tenant_id=tenant_id,
            session_id=session_id,
        )

        await self._upload_bytes(
            bucket=self._resolver.audio_bucket,
            path=path,
            data=wav_bytes,
            content_type="audio/wav",
        )

        uri = self._resolver.get_full_uri(self._resolver.audio_bucket, path)
        logger.info(f"Uploaded streaming complete WAV to: {uri} ({len(wav_bytes)} bytes)")
        return uri

    async def upload_streaming_processed_complete(
        self,
        wav_bytes: bytes,
        tenant_id: str,
        session_id: str,
    ) -> str:
        """Upload the processed (post-denoise) combined WAV to storage.

        Path: ``{tenant_id}/{year}/{month}/streaming/{session_id}/processed/complete.wav``

        Args:
            wav_bytes: WAV-encoded processed audio bytes.
            tenant_id: Tenant ID.
            session_id: Streaming session ID.

        Returns:
            Full storage URI.
        """
        path = self._resolver.streaming_processed_complete_path(
            tenant_id=tenant_id,
            session_id=session_id,
        )

        await self._upload_bytes(
            bucket=self._resolver.audio_bucket,
            path=path,
            data=wav_bytes,
            content_type="audio/wav",
        )

        uri = self._resolver.get_full_uri(self._resolver.audio_bucket, path)
        logger.info(f"Uploaded streaming processed WAV to: {uri} ({len(wav_bytes)} bytes)")
        return uri

    async def upload_streaming_transcript(
        self,
        transcript_bytes: bytes,
        tenant_id: str,
        session_id: str,
    ) -> str:
        """Upload streaming session transcript to storage.

        Path: ``{tenant_id}/{year}/{month}/streaming/{session_id}/transcript.json``

        Args:
            transcript_bytes: JSON-encoded transcript bytes.
            tenant_id: Tenant ID.
            session_id: Streaming session ID.

        Returns:
            Full storage URI.
        """
        path = self._resolver.streaming_transcript_path(
            tenant_id=tenant_id,
            session_id=session_id,
        )

        await self._upload_bytes(
            bucket=self._resolver.audio_bucket,
            path=path,
            data=transcript_bytes,
            content_type="application/json",
        )

        uri = self._resolver.get_full_uri(self._resolver.audio_bucket, path)
        logger.info(f"Uploaded streaming transcript to: {uri} ({len(transcript_bytes)} bytes)")
        return uri

    async def upload_streaming_metadata(
        self,
        metadata_bytes: bytes,
        tenant_id: str,
        session_id: str,
    ) -> str:
        """Upload streaming session metadata to storage.

        Path: ``{tenant_id}/{year}/{month}/streaming/{session_id}/metadata.json``

        Args:
            metadata_bytes: JSON-encoded metadata bytes.
            tenant_id: Tenant ID.
            session_id: Streaming session ID.

        Returns:
            Full storage URI.
        """
        path = self._resolver.streaming_metadata_path(
            tenant_id=tenant_id,
            session_id=session_id,
        )

        await self._upload_bytes(
            bucket=self._resolver.audio_bucket,
            path=path,
            data=metadata_bytes,
            content_type="application/json",
        )

        uri = self._resolver.get_full_uri(self._resolver.audio_bucket, path)
        logger.info(f"Uploaded streaming metadata to: {uri} ({len(metadata_bytes)} bytes)")
        return uri

    async def upload_transcript(
        self,
        transcript_data: str | bytes,
        tenant_id: str,
        job_id: str,
        consultation_id: str | None = None,
        format: str = "json",
    ) -> str:
        """
        Upload transcript file.

        Args:
            transcript_data: Transcript content
            tenant_id: Tenant ID
            job_id: Job ID
            consultation_id: Optional consultation ID
            format: Output format (json, txt, vtt, srt)

        Returns:
            Full storage URI
        """
        path = self._resolver.transcript_path(
            tenant_id=tenant_id,
            consultation_id=consultation_id,
            job_id=job_id,
            format=format,
        )

        content_types = {
            "json": "application/json",
            "txt": "text/plain",
            "vtt": "text/vtt",
            "srt": "text/plain",
        }

        if isinstance(transcript_data, str):
            transcript_data = transcript_data.encode("utf-8")

        await self._upload_bytes(
            bucket=self._resolver.audio_bucket,
            path=path,
            data=transcript_data,
            content_type=content_types.get(format, "application/octet-stream"),
        )

        return self._resolver.get_full_uri(self._resolver.audio_bucket, path)

    async def download_audio(self, uri: str) -> bytes:
        """
        Download audio file from storage.

        Args:
            uri: Full storage URI

        Returns:
            Audio bytes
        """
        bucket, path = self._resolver.parse_uri(uri)
        return await self._download_bytes(bucket, path)

    async def download_audio_stream(
        self,
        uri: str,
        chunk_size: int = 1024 * 1024,  # 1MB chunks
    ) -> AsyncGenerator[bytes, None]:
        """
        Download audio file as async stream.

        Args:
            uri: Full storage URI
            chunk_size: Size of each chunk

        Yields:
            Audio bytes chunks
        """
        bucket, path = self._resolver.parse_uri(uri)

        client = get_minio_client()
        try:
            response = client.client.get_object(bucket, path)
            while True:
                chunk = response.read(chunk_size)
                if not chunk:
                    break
                yield chunk
        finally:
            response.close()
            response.release_conn()

    async def get_presigned_url(
        self,
        uri: str,
        expires_in: int = 3600,
    ) -> str:
        """
        Get presigned URL for direct download.

        Args:
            uri: Full storage URI
            expires_in: Expiry time in seconds

        Returns:
            Presigned URL
        """
        bucket, path = self._resolver.parse_uri(uri)

        client = get_minio_client()
        url = client.client.presigned_get_object(
            bucket,
            path,
            expires=timedelta(seconds=expires_in),
        )
        return url

    async def delete(self, uri: str) -> bool:
        """
        Delete blob from storage.

        Args:
            uri: Full storage URI

        Returns:
            True if deleted
        """
        bucket, path = self._resolver.parse_uri(uri)

        try:
            client = get_minio_client()
            client.client.remove_object(bucket, path)
            logger.info(f"Deleted: {uri}")
            return True
        except Exception as e:
            logger.warning(f"Failed to delete {uri}: {e}")
            return False

    async def delete_session_chunks(self, session_id: str) -> int:
        """
        Delete all chunks for a streaming session.

        Args:
            session_id: Session ID

        Returns:
            Number of chunks deleted
        """
        prefix = f"sessions/{session_id}/"
        client = get_minio_client()

        count = 0
        try:
            objects = client.client.list_objects(
                self._resolver.chunk_bucket,
                prefix=prefix,
                recursive=True,
            )

            for obj in objects:
                client.client.remove_object(self._resolver.chunk_bucket, obj.object_name)
                count += 1

            logger.info(f"Deleted {count} chunks for session {session_id}")
            return count

        except Exception as e:
            logger.warning(f"Error deleting session chunks: {e}")
            return count

    async def exists(self, uri: str) -> bool:
        """
        Check if blob exists.

        Args:
            uri: Full storage URI

        Returns:
            True if exists
        """
        bucket, path = self._resolver.parse_uri(uri)

        try:
            client = get_minio_client()
            client.client.stat_object(bucket, path)
            return True
        except Exception:
            return False

    async def get_size(self, uri: str) -> int:
        """
        Get size of blob in bytes.

        Args:
            uri: Full storage URI

        Returns:
            Size in bytes, 0 if not found
        """
        bucket, path = self._resolver.parse_uri(uri)

        try:
            client = get_minio_client()
            stat = client.client.stat_object(bucket, path)
            return stat.size
        except Exception:
            return 0

    async def _upload_bytes(
        self,
        bucket: str,
        path: str,
        data: bytes,
        content_type: str,
    ) -> None:
        """Upload bytes to MinIO.

        The MinIO SDK is synchronous, so the actual I/O is offloaded
        to the default thread-pool executor to avoid blocking the
        event loop (and stalling frame processing / inference).
        """
        client = get_minio_client()

        def _sync_upload() -> None:
            # Ensure bucket exists
            if not client.client.bucket_exists(bucket):
                client.client.make_bucket(bucket)

            # Upload
            client.client.put_object(
                bucket,
                path,
                io.BytesIO(data),
                len(data),
                content_type=content_type,
            )

        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _sync_upload)
        except Exception as e:
            raise StorageError(f"Failed to upload to {bucket}/{path}: {e}") from e

    async def _download_bytes(self, bucket: str, path: str) -> bytes:
        """Download bytes from MinIO."""
        client = get_minio_client()

        try:
            response = client.client.get_object(bucket, path)
            data = response.read()
            response.close()
            response.release_conn()
            return data

        except Exception as e:
            raise StorageError(f"Failed to download {bucket}/{path}: {e}") from e


# Singleton instance
_service: BlobService | None = None


def get_blob_service() -> BlobService:
    """Get singleton blob service instance."""
    global _service
    if _service is None:
        _service = BlobService()
    return _service
