"""Undecodable audio must fail once, with its own error code.

Previously an unreadable upload surfaced as a generic
``TRANSCRIPTION_ERROR`` (retryable, four attempts) and the client saw
libsndfile's "Unspecified internal error". Audio-processing failures now carry
their own error code and skip the retry loop.
"""

import importlib
from typing import Any

import pytest

from stt.core.exceptions import NON_RETRYABLE_EXCEPTIONS, AudioCorruptedError
from stt.core.messaging.broker import should_retry

pytestmark = pytest.mark.unit

TENANT = "50000000-0000-0000-0000-000000000001"


class TestUndecodableAudioJobFailure:
    """The worker's handling of AudioProcessingError."""

    @pytest.mark.asyncio
    async def test_fails_job_with_audio_error_code(self, monkeypatch) -> None:
        mod = importlib.import_module("stt.transcription.workers.transcribe_file")

        seen: dict[str, Any] = {}

        class FakeClient:
            async def get_job_status(self, job_id: str, tenant_id: str | None = None) -> str:
                return "PROCESSING"

            async def start_job(
                self, job_id: str, worker_id: str, tenant_id: str | None = None
            ) -> dict[str, Any]:
                return {}

            async def update_progress(self, **kwargs: Any) -> dict[str, Any]:
                return {}

            async def fail_job(self, **kwargs: Any) -> dict[str, Any]:
                seen["error_code"] = kwargs.get("error_code")
                seen["error_message"] = kwargs.get("error_message") or kwargs.get("error")
                return {}

            async def close(self) -> None:
                return None

        _install_worker_stubs(monkeypatch, mod, FakeClient())

        with pytest.raises(AudioCorruptedError):
            await mod._transcribe_file_async(
                job_id="job-607",
                tenant_id=TENANT,
                pipeline_id="p-1",
                audio_uri="s3://bucket/SDK_ORTHO.mp3",
            )

        assert seen["error_code"] == "AUDIO_CORRUPTED"
        # The user-facing message must be readable, not decoder jargon.
        assert "Unspecified internal error" not in str(seen["error_message"])

    def test_audio_errors_are_not_retried_by_the_broker(self) -> None:
        error = AudioCorruptedError("Audio file could not be decoded.")

        assert isinstance(error, NON_RETRYABLE_EXCEPTIONS)
        assert should_retry(retries_so_far=0, exception=error) is False


def _install_worker_stubs(monkeypatch, mod: Any, api_client: Any) -> None:
    """Stub every collaborator; the batch service raises AudioCorruptedError."""

    class FakeResolver:
        def set_tenant_storage(self, *a: Any, **k: Any) -> None: ...
        def set_tenant_bucket(self, *a: Any, **k: Any) -> None: ...

    class FakeBlobService:
        _resolver = FakeResolver()

        async def download_audio(self, uri: str, tenant_id: str | None = None) -> bytes:
            return b"not audio at all"

    class FakeInference:
        language: str | None = None

    class FakeSpec:
        inference = FakeInference()

    class FakePipelineConfig:
        spec = FakeSpec()

    class FakePipelineReader:
        async def get_pipeline(self, pipeline_id: str) -> FakePipelineConfig:
            return FakePipelineConfig()

    class FakeBatchService:
        async def transcribe(self, **kwargs: Any) -> Any:
            raise AudioCorruptedError(
                "Audio file could not be decoded. "
                "The format is unsupported or the file is damaged.",
                details={"soundfile_error": "LibsndfileError: Unspecified internal error."},
            )

    class FakePublisher:
        async def connect(self) -> None: ...
        async def publish_status(self, *a: Any, **k: Any) -> None: ...
        async def publish_progress(self, *a: Any, **k: Any) -> None: ...
        async def publish_chunk(self, *a: Any, **k: Any) -> None: ...
        async def publish_transcript(self, *a: Any, **k: Any) -> None: ...
        async def publish_error(self, *a: Any, **k: Any) -> None: ...
        async def close(self) -> None: ...

    class FakeEffectiveConfigClient:
        async def get_provider_overrides(self, tenant_id: str) -> dict[str, Any]:
            return {}

    async def _noop_refresh() -> None:
        return None

    monkeypatch.setattr(mod, "refresh_job_concurrency_limit", _noop_refresh)
    monkeypatch.setattr(mod, "get_api_client", lambda: api_client)
    monkeypatch.setattr(mod, "get_blob_service", lambda: FakeBlobService())
    monkeypatch.setattr(mod, "get_pipeline_reader", lambda: FakePipelineReader())
    monkeypatch.setattr(mod, "get_batch_service", lambda: FakeBatchService())
    monkeypatch.setattr(mod, "TranscriptionEventPublisher", FakePublisher)
    monkeypatch.setattr(mod, "get_effective_config_client", lambda: FakeEffectiveConfigClient())
