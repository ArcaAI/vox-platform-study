"""Storage path resolver for MinIO."""

import logging
from datetime import datetime
from typing import Literal

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

    def audio_path(
        self,
        tenant_id: str,
        consultation_id: str | None,
        job_id: str,
        filename: str,
        timestamp: datetime | None = None,
    ) -> str:
        """
        Generate path for audio files.

        Format: {tenant_id}/{year}/{month}/consultations/{consultation_id}/{job_id}_{filename}
        Or: {tenant_id}/{year}/{month}/jobs/{job_id}_{filename} (no consultation)

        Args:
            tenant_id: Tenant ID
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

        # Sanitize filename
        safe_filename = self._sanitize_filename(filename)

        if consultation_id:
            return f"{tenant_id}/{year}/{month}/consultations/{consultation_id}/{job_id}_{safe_filename}"
        else:
            return f"{tenant_id}/{year}/{month}/jobs/{job_id}_{safe_filename}"

    def processed_audio_path(
        self,
        tenant_id: str,
        consultation_id: str | None,
        job_id: str,
        filename: str,
        timestamp: datetime | None = None,
    ) -> str:
        """
        Generate path for processed (e.g. denoised / VAD-merged) audio files.

        Format:
            {tenant_id}/{year}/{month}/consultations/{consultation_id}/processed/{job_id}_{filename}
        Or (no consultation):
            {tenant_id}/{year}/{month}/jobs/processed/{job_id}_{filename}

        Args:
            tenant_id: Tenant ID
            consultation_id: Optional consultation ID
            job_id: Transcription job ID
            filename: Descriptive filename (e.g. ``processed.wav``)
            timestamp: Optional timestamp (defaults to now)

        Returns:
            Storage path (without bucket prefix)
        """
        ts = timestamp or datetime.utcnow()
        year = ts.strftime("%Y")
        month = ts.strftime("%m")

        safe_filename = self._sanitize_filename(filename)

        if consultation_id:
            return (
                f"{tenant_id}/{year}/{month}/consultations/"
                f"{consultation_id}/processed/{job_id}_{safe_filename}"
            )
        else:
            return f"{tenant_id}/{year}/{month}/jobs/processed/{job_id}_{safe_filename}"

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

        filename = f"{job_id}_transcript.{format}"

        if consultation_id:
            return f"{tenant_id}/{year}/{month}/consultations/{consultation_id}/transcripts/{filename}"
        else:
            return f"{tenant_id}/{year}/{month}/jobs/transcripts/{filename}"

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
