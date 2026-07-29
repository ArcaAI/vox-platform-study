"""Storage path resolver for MinIO."""

import logging
import re
from datetime import datetime
from typing import Any, Literal

logger = logging.getLogger(__name__)


class StoragePathResolver:
    """Generate MinIO storage paths with consistent naming."""

    def __init__(
        self,
        audio_bucket: str = "hope-audio",
        chunk_bucket: str = "hope-audio-chunks",
        model_bucket: str = "hope-models",
    ):
        """
        Initialize path resolver.

        Args:
            audio_bucket: Bucket for audio files
            chunk_bucket: Bucket for streaming chunks
            model_bucket: Bucket for model files
        """
        self.audio_bucket = audio_bucket
        self.chunk_bucket = chunk_bucket
        self.model_bucket = model_bucket
        self._tenant_bucket_cache: dict[str, str] = {}
        self._tenant_storage_cache: dict[str, dict[str, Any]] = {}

    def audio_path(
        self,
        tenant_id: str,
        consultation_id: str | None,
        job_id: str,
        filename: str,
        timestamp: datetime | None = None,
    ) -> str:
        """
        Generate path for raw audio files.

        Format:
            {year}/{month}/{day}/consultations/{consultation_id}/{job_id}/raw/{filename}
        Or:
            {year}/{month}/{day}/jobs/{job_id}/raw/{filename}

        Args:
            tenant_id: Tenant ID (used for bucket resolution, not in path)
            consultation_id: Optional consultation ID
            job_id: Transcription job ID
            filename: Original filename
            timestamp: Optional timestamp (defaults to now)

        Returns:
            Storage path (without bucket prefix)
        """
        ts = timestamp or datetime.utcnow()
        year = ts.strftime("%Y")
        month = ts.strftime("%m")
        day = ts.strftime("%d")

        # Sanitize filename
        safe_filename = self._sanitize_filename(filename)

        if consultation_id:
            return (
                f"{year}/{month}/{day}/consultations/{consultation_id}/{job_id}/raw/{safe_filename}"
            )
        else:
            return f"{year}/{month}/{day}/jobs/{job_id}/raw/{safe_filename}"

    def processed_audio_path(
        self,
        tenant_id: str,
        consultation_id: str | None,
        job_id: str,
        filename: str = "complete.wav",
        timestamp: datetime | None = None,
    ) -> str:
        """
        Generate path for processed (e.g. denoised / VAD-merged) audio files.

        Format:
            {year}/{month}/{day}/consultations/{consultation_id}/{job_id}/processed/{filename}
        Or (no consultation):
            {year}/{month}/{day}/jobs/{job_id}/processed/{filename}

        Args:
            tenant_id: Tenant ID (used for bucket resolution, not in path)
            consultation_id: Optional consultation ID
            job_id: Transcription job ID
            filename: Descriptive filename (default ``complete.wav``)
            timestamp: Optional timestamp (defaults to now)

        Returns:
            Storage path (without bucket prefix)
        """
        ts = timestamp or datetime.utcnow()
        year = ts.strftime("%Y")
        month = ts.strftime("%m")
        day = ts.strftime("%d")

        safe_filename = self._sanitize_filename(filename)

        if consultation_id:
            return (
                f"{year}/{month}/{day}/consultations/"
                f"{consultation_id}/{job_id}/processed/{safe_filename}"
            )
        else:
            return f"{year}/{month}/{day}/jobs/{job_id}/processed/{safe_filename}"

    def chunk_path(
        self,
        session_id: str,
        chunk_index: int,
        timestamp: datetime | None = None,
    ) -> str:
        """
        Generate path for streaming audio chunks.

        Format: sessions/{session_id}/chunk_{index:06d}.wav

        Args:
            session_id: Streaming session ID
            chunk_index: Chunk sequence number
            timestamp: Optional timestamp

        Returns:
            Storage path
        """
        return f"sessions/{session_id}/chunk_{chunk_index:06d}.wav"

    def transcript_path(
        self,
        tenant_id: str,
        consultation_id: str | None,
        job_id: str,
        format: Literal["txt", "json", "vtt", "srt"] = "json",
        timestamp: datetime | None = None,
    ) -> str:
        """
        Generate path for transcript files.

        Format:
            {year}/{month}/{day}/consultations/{consultation_id}/{job_id}/transcript.{format}
        Or:
            {year}/{month}/{day}/jobs/{job_id}/transcript.{format}

        Args:
            tenant_id: Tenant ID
            consultation_id: Optional consultation ID
            job_id: Job ID
            format: Output format
            timestamp: Optional timestamp

        Returns:
            Storage path
        """
        ts = timestamp or datetime.utcnow()
        year = ts.strftime("%Y")
        month = ts.strftime("%m")
        day = ts.strftime("%d")

        filename = f"transcript.{format}"

        if consultation_id:
            return f"{year}/{month}/{day}/consultations/{consultation_id}/{job_id}/{filename}"
        else:
            return f"{year}/{month}/{day}/jobs/{job_id}/{filename}"

    def batch_metadata_path(
        self,
        tenant_id: str,
        consultation_id: str | None,
        job_id: str,
        timestamp: datetime | None = None,
    ) -> str:
        """Generate path for batch job metadata.

        Format:
            {year}/{month}/{day}/consultations/{consultation_id}/{job_id}/metadata.json
        Or:
            {year}/{month}/{day}/jobs/{job_id}/metadata.json

        Args:
            tenant_id: Tenant ID.
            consultation_id: Optional consultation ID.
            job_id: Job ID.
            timestamp: Optional timestamp.

        Returns:
            Storage path (without bucket prefix).
        """
        ts = timestamp or datetime.utcnow()
        year = ts.strftime("%Y")
        month = ts.strftime("%m")
        day = ts.strftime("%d")

        if consultation_id:
            return f"{year}/{month}/{day}/consultations/{consultation_id}/{job_id}/metadata.json"
        else:
            return f"{year}/{month}/{day}/jobs/{job_id}/metadata.json"

    def _streaming_base(
        self,
        tenant_id: str,
        session_id: str,
        timestamp: datetime | None = None,
    ) -> str:
        """Return the common prefix for all streaming paths.

        Format: ``{year}/{month}/{day}/streams/{session_id}``
        """
        safe_session = self._sanitize_path_segment(session_id)
        ts = timestamp or datetime.utcnow()
        year = ts.strftime("%Y")
        month = ts.strftime("%m")
        day = ts.strftime("%d")
        return f"{year}/{month}/{day}/streams/{safe_session}"

    def streaming_raw_chunk_path(
        self,
        tenant_id: str,
        session_id: str,
        chunk_index: int,
        timestamp: datetime | None = None,
    ) -> str:
        """Generate path for a periodic raw PCM chunk.

        Format: ``{tenant_id}/{year}/{month}/streaming/{session_id}/raw/chunk_{NNNN}.pcm``

        Args:
            tenant_id: Tenant ID.
            session_id: Streaming session ID.
            chunk_index: Zero-based chunk sequence number.
            timestamp: Optional timestamp for year/month partitioning.

        Returns:
            Storage path (without bucket prefix).
        """
        base = self._streaming_base(tenant_id, session_id, timestamp)
        return f"{base}/raw/chunk_{chunk_index:04d}.pcm"

    def streaming_processed_chunk_path(
        self,
        tenant_id: str,
        session_id: str,
        chunk_index: int,
        timestamp: datetime | None = None,
    ) -> str:
        """Generate path for a processed audio chunk.

        Format: ``{tenant_id}/{year}/{month}/streaming/{session_id}/processed/chunk_{NNNN}.pcm``

        Args:
            tenant_id: Tenant ID.
            session_id: Streaming session ID.
            chunk_index: Zero-based chunk sequence number.
            timestamp: Optional timestamp for year/month partitioning.

        Returns:
            Storage path (without bucket prefix).
        """
        base = self._streaming_base(tenant_id, session_id, timestamp)
        return f"{base}/processed/chunk_{chunk_index:04d}.pcm"

    def streaming_raw_complete_path(
        self,
        tenant_id: str,
        session_id: str,
        timestamp: datetime | None = None,
    ) -> str:
        """Generate path for the final combined WAV.

        Format: ``{tenant_id}/{year}/{month}/streaming/{session_id}/raw/complete.wav``

        Args:
            tenant_id: Tenant ID.
            session_id: Streaming session ID.
            timestamp: Optional timestamp for year/month partitioning.

        Returns:
            Storage path (without bucket prefix).
        """
        base = self._streaming_base(tenant_id, session_id, timestamp)
        return f"{base}/raw/complete.wav"

    def streaming_processed_complete_path(
        self,
        tenant_id: str,
        session_id: str,
        timestamp: datetime | None = None,
    ) -> str:
        """Generate path for the processed (post-denoise) combined WAV.

        Format: ``{tenant_id}/{year}/{month}/streaming/{session_id}/processed/complete.wav``

        Args:
            tenant_id: Tenant ID.
            session_id: Streaming session ID.
            timestamp: Optional timestamp for year/month partitioning.

        Returns:
            Storage path (without bucket prefix).
        """
        base = self._streaming_base(tenant_id, session_id, timestamp)
        return f"{base}/processed/complete.wav"

    def streaming_transcript_path(
        self,
        tenant_id: str,
        session_id: str,
        timestamp: datetime | None = None,
    ) -> str:
        """Generate path for the session transcript.

        Format: ``{tenant_id}/{year}/{month}/streaming/{session_id}/transcript.json``

        Args:
            tenant_id: Tenant ID.
            session_id: Streaming session ID.
            timestamp: Optional timestamp for year/month partitioning.

        Returns:
            Storage path (without bucket prefix).
        """
        base = self._streaming_base(tenant_id, session_id, timestamp)
        return f"{base}/transcript.json"

    def streaming_metadata_path(
        self,
        tenant_id: str,
        session_id: str,
        timestamp: datetime | None = None,
    ) -> str:
        """Generate path for the session metadata.

        Format: ``{tenant_id}/{year}/{month}/streaming/{session_id}/metadata.json``

        Args:
            tenant_id: Tenant ID.
            session_id: Streaming session ID.
            timestamp: Optional timestamp for year/month partitioning.

        Returns:
            Storage path (without bucket prefix).
        """
        base = self._streaming_base(tenant_id, session_id, timestamp)
        return f"{base}/metadata.json"

    def model_cache_path(
        self,
        model_slug: str,
        revision: str | None = None,
        filename: str | None = None,
    ) -> str:
        """
        Generate path for cached model files.

        Format: models/{model_slug}/{revision}/{filename}

        Args:
            model_slug: Model slug
            revision: Model revision/version
            filename: Specific file within model

        Returns:
            Storage path
        """
        parts = ["models", model_slug]

        if revision:
            parts.append(revision)
        else:
            parts.append("default")

        if filename:
            parts.append(filename)

        return "/".join(parts)

    def temp_path(
        self,
        prefix: str = "temp",
        suffix: str = "",
    ) -> str:
        """
        Generate temporary storage path.

        Args:
            prefix: Path prefix
            suffix: File suffix

        Returns:
            Temporary storage path
        """
        ts = datetime.utcnow()
        timestamp_str = ts.strftime("%Y%m%d_%H%M%S_%f")
        return f"temp/{prefix}_{timestamp_str}{suffix}"

    def get_full_uri(
        self,
        bucket: str,
        path: str,
    ) -> str:
        """
        Get full MinIO URI for a path.

        Args:
            bucket: Bucket name
            path: Storage path

        Returns:
            Full URI (s3://{bucket}/{path})
        """
        return f"s3://{bucket}/{path}"

    def resolve_tenant_bucket(self, tenant_id: str, bucket_type: str) -> str:
        """Resolve the bucket name for a given tenant and bucket type.

        Checks an in-memory cache first, then falls back to the default
        bucket for the requested type.

        Args:
            tenant_id: Tenant ID.
            bucket_type: One of ``"audio"``, ``"chunk"``, ``"model"``.

        Returns:
            Bucket name string.
        """
        cache_key = f"{tenant_id}:{bucket_type}"
        if cache_key in self._tenant_bucket_cache:
            return self._tenant_bucket_cache[cache_key]

        defaults = {
            "audio": self.audio_bucket,
            "chunk": self.chunk_bucket,
            "model": self.model_bucket,
        }
        bucket = defaults.get(bucket_type, self.audio_bucket)
        logger.debug(
            "resolve_tenant_bucket fallback tenant=%s type=%s -> %s",
            tenant_id,
            bucket_type,
            bucket,
        )
        return bucket

    def set_tenant_bucket(self, tenant_id: str, bucket_type: str, bucket_name: str) -> None:
        """Cache a tenant-specific bucket name.

        Args:
            tenant_id: Tenant ID.
            bucket_type: One of ``"audio"``, ``"chunk"``, ``"model"``.
            bucket_name: The resolved bucket name.
        """
        cache_key = f"{tenant_id}:{bucket_type}"
        self._tenant_bucket_cache[cache_key] = bucket_name

    def set_tenant_storage(self, tenant_id: str, descriptor: dict[str, Any]) -> None:
        """Register a per-tenant storage provider descriptor.

        Mirrors :meth:`set_tenant_bucket`.  When the descriptor carries a
        ``bucket`` it also wins as the tenant's audio bucket, so existing
        bucket-resolution logic transparently routes to the right
        bucket/container for that provider.

        Args:
            tenant_id: Tenant ID.
            descriptor: Snake_case storage descriptor (provider, bucket, creds).
        """
        self._tenant_storage_cache[tenant_id] = descriptor
        bucket = descriptor.get("bucket")
        if bucket:
            self.set_tenant_bucket(tenant_id, "audio", bucket)

    def resolve_tenant_storage(self, tenant_id: str) -> dict[str, Any] | None:
        """Return the registered storage descriptor for a tenant, if any.

        Args:
            tenant_id: Tenant ID.

        Returns:
            The descriptor dict, or ``None`` when the tenant uses the platform
            default storage client.
        """
        return self._tenant_storage_cache.get(tenant_id)

    def parse_uri(self, uri: str) -> tuple[str, str]:
        """
        Parse MinIO URI into bucket and path.

        Args:
            uri: Full URI (s3://{bucket}/{path})

        Returns:
            Tuple of (bucket, path)
        """
        if uri.startswith("s3://"):
            uri = uri[5:]
        elif uri.startswith("minio://"):
            uri = uri[8:]

        parts = uri.split("/", 1)
        bucket = parts[0]
        path = parts[1] if len(parts) > 1 else ""

        return bucket, path

    _SAFE_SEGMENT_RE = re.compile(r"[^A-Za-z0-9_\-.]")

    def _sanitize_path_segment(self, segment: str) -> str:
        """Strip characters unsafe for S3 object-key segments.

        Only ``[A-Za-z0-9_-.]`` are kept; everything else is replaced
        with ``_``.  Empty or whitespace-only inputs become ``_unknown``.
        """
        cleaned = self._SAFE_SEGMENT_RE.sub("_", segment.strip())
        return cleaned or "_unknown"

    def _sanitize_filename(self, filename: str) -> str:
        """
        Sanitize filename for storage.

        Args:
            filename: Original filename

        Returns:
            Sanitized filename
        """
        # Remove path components
        filename = filename.replace("\\", "/").split("/")[-1]

        # Replace problematic characters
        replacements = {
            " ": "_",
            "'": "",
            '"': "",
            "&": "_",
            "?": "",
            "#": "",
            "%": "",
            "*": "",
            ":": "",
            "|": "",
            "<": "",
            ">": "",
        }

        for old, new in replacements.items():
            filename = filename.replace(old, new)

        # Ensure reasonable length
        if len(filename) > 200:
            name, ext = filename.rsplit(".", 1) if "." in filename else (filename, "")
            filename = name[:190] + ("." + ext if ext else "")

        return filename


# Singleton instance
_resolver: StoragePathResolver | None = None


def get_path_resolver() -> StoragePathResolver:
    """Get singleton path resolver instance."""
    global _resolver
    if _resolver is None:
        from ..core.config.settings import get_settings

        settings = get_settings()
        _resolver = StoragePathResolver(
            audio_bucket=settings.minio_audio_bucket,
            chunk_bucket=settings.minio_chunk_bucket,
        )
    return _resolver
