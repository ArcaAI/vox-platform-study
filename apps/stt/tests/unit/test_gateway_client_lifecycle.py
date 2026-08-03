"""Unit tests for gateway client lifecycle methods (start, progress, complete, fail).

Tests verify actual payload construction and HTTP request behavior for the
new lifecycle methods added to match NestJS SttInternalController endpoints.
"""

from datetime import UTC
from unittest.mock import AsyncMock, patch

import pytest

from stt.core.api_client.gateway import APIGatewayClient
from stt.core.exceptions import APIGatewayError


class TestStartJob:
    """Tests for APIGatewayClient.start_job()."""

    @pytest.fixture
    def client(self):
        return APIGatewayClient(
            base_url="http://localhost:8868/api/v1",
            api_key="test-key",
        )

    @pytest.mark.asyncio
    async def test_start_job_sends_correct_payload(self, client):
        """Verify start_job constructs payload matching InternalStartJobRequest."""
        captured = {}

        async def capture_request(method, path, json=None, params=None, headers=None):
            captured["method"] = method
            captured["path"] = path
            captured["json"] = json
            return {"id": "job-123", "status": "PROCESSING"}

        with patch.object(client, "_request", side_effect=capture_request):
            result = await client.start_job("job-123", "worker-42")

            assert captured["method"] == "PATCH"
            assert captured["path"] == "/internal/stt/jobs/job-123/start"
            assert captured["json"] == {"workerId": "worker-42"}
            assert result["status"] == "PROCESSING"

    @pytest.mark.asyncio
    async def test_start_job_propagates_api_error(self, client):
        """Verify API errors propagate correctly."""
        with patch.object(client, "_request", new_callable=AsyncMock) as mock:
            mock.side_effect = APIGatewayError("Not found", details={"status_code": 404})

            with pytest.raises(APIGatewayError):
                await client.start_job("missing-job", "worker-1")


class TestUpdateJobProgress:
    """Tests for APIGatewayClient.update_job_progress()."""

    @pytest.fixture
    def client(self):
        return APIGatewayClient(
            base_url="http://localhost:8868/api/v1",
            api_key="test-key",
        )

    @pytest.mark.asyncio
    async def test_update_progress_sends_correct_payload(self, client):
        """Verify update_job_progress constructs payload matching InternalUpdateProgressRequest."""
        captured = {}

        async def capture_request(method, path, json=None, params=None, headers=None):
            captured["method"] = method
            captured["path"] = path
            captured["json"] = json
            return {"id": "job-123", "progress": 75}

        with patch.object(client, "_request", side_effect=capture_request):
            result = await client.update_job_progress("job-123", 75)

            assert captured["method"] == "PATCH"
            assert captured["path"] == "/internal/stt/jobs/job-123/progress"
            assert captured["json"] == {"progress": 75}
            assert result["progress"] == 75

    @pytest.mark.asyncio
    @pytest.mark.parametrize("progress", [0, 50, 100])
    async def test_update_progress_accepts_boundary_values(self, client, progress):
        """Verify progress accepts valid boundary values (0, 50, 100)."""
        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"progress": progress}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.update_job_progress("job-123", progress)
            assert captured_json["progress"] == progress


class TestCompleteJob:
    """Tests for APIGatewayClient.complete_job()."""

    @pytest.fixture
    def client(self):
        return APIGatewayClient(
            base_url="http://localhost:8868/api/v1",
            api_key="test-key",
        )

    @pytest.mark.asyncio
    async def test_complete_job_sends_correct_payload(self, client):
        """Verify complete_job constructs payload matching InternalCompleteJobRequest."""
        captured = {}

        async def capture_request(method, path, json=None, params=None, headers=None):
            captured["method"] = method
            captured["path"] = path
            captured["json"] = json
            return {"id": "job-123", "status": "COMPLETED"}

        metadata = {"language": "en", "duration_seconds": 120.5}

        with patch.object(client, "_request", side_effect=capture_request):
            result = await client.complete_job(
                "job-123",
                result_text="Full transcript text.",
                result_metadata=metadata,
            )

            assert captured["method"] == "PATCH"
            assert captured["path"] == "/internal/stt/jobs/job-123/complete"
            assert captured["json"]["resultText"] == "Full transcript text."
            assert captured["json"]["resultMetadata"] == metadata
            assert result["status"] == "COMPLETED"

    @pytest.mark.asyncio
    async def test_complete_job_omits_metadata_when_none(self, client):
        """Verify resultMetadata is omitted when None."""
        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"status": "COMPLETED"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.complete_job("job-123", result_text="Hello")

            assert "resultText" in captured_json
            assert "resultMetadata" not in captured_json

    @pytest.mark.asyncio
    async def test_complete_job_includes_empty_metadata(self, client):
        """Verify empty dict metadata IS included (not same as None)."""
        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"status": "COMPLETED"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.complete_job("job-123", result_text="Hi", result_metadata={})

            assert captured_json["resultMetadata"] == {}


class TestFailJob:
    """Tests for APIGatewayClient.fail_job()."""

    @pytest.fixture
    def client(self):
        return APIGatewayClient(
            base_url="http://localhost:8868/api/v1",
            api_key="test-key",
        )

    @pytest.mark.asyncio
    async def test_fail_job_sends_correct_payload(self, client):
        """Verify fail_job constructs payload matching InternalFailJobRequest."""
        captured = {}

        async def capture_request(method, path, json=None, params=None, headers=None):
            captured["method"] = method
            captured["path"] = path
            captured["json"] = json
            return {"id": "job-123", "status": "FAILED"}

        with patch.object(client, "_request", side_effect=capture_request):
            result = await client.fail_job(
                "job-123",
                error_message="Audio file corrupted",
                error_code="AUDIO_CORRUPT",
            )

            assert captured["method"] == "PATCH"
            assert captured["path"] == "/internal/stt/jobs/job-123/fail"
            assert captured["json"]["errorMessage"] == "Audio file corrupted"
            assert captured["json"]["errorCode"] == "AUDIO_CORRUPT"
            assert result["status"] == "FAILED"

    @pytest.mark.asyncio
    async def test_fail_job_omits_error_code_when_none(self, client):
        """Verify errorCode is omitted when not provided."""
        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"status": "FAILED"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.fail_job("job-123", error_message="Something failed")

            assert captured_json["errorMessage"] == "Something failed"
            assert "errorCode" not in captured_json


class TestCreateTranscriptUpdated:
    """Tests for the updated create_transcript() signature.

    The method now accepts (job_id, transcript_text, metadata, consultation_id)
    matching the NestJS CreateTranscriptRequest DTO.
    """

    @pytest.fixture
    def client(self):
        return APIGatewayClient(
            base_url="http://localhost:8868/api/v1",
            api_key="test-key",
        )

    @pytest.mark.asyncio
    async def test_create_transcript_sends_correct_payload(self, client):
        """Verify create_transcript constructs correct payload."""
        captured = {}

        async def capture_request(method, path, json=None, params=None, headers=None):
            captured["method"] = method
            captured["path"] = path
            captured["json"] = json
            return {"contextItemId": "ctx-456"}

        with patch.object(client, "_request", side_effect=capture_request):
            result = await client.create_transcript(
                job_id="job-123",
                transcript_text="Hello world transcription.",
                metadata={"language": "en", "confidence": 0.95},
                consultation_id="consult-789",
            )

            assert captured["method"] == "POST"
            assert captured["path"] == "/internal/stt/transcripts"
            assert captured["json"]["jobId"] == "job-123"
            assert captured["json"]["transcriptText"] == "Hello world transcription."
            assert captured["json"]["metadata"]["language"] == "en"
            assert captured["json"]["consultationId"] == "consult-789"
            assert result["contextItemId"] == "ctx-456"

    @pytest.mark.asyncio
    async def test_create_transcript_omits_optional_fields(self, client):
        """Verify optional fields are omitted when not provided."""
        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"contextItemId": "ctx-456"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.create_transcript(
                job_id="job-123",
                transcript_text="Hello",
            )

            assert "jobId" in captured_json
            assert "transcriptText" in captured_json
            assert "metadata" not in captured_json
            assert "consultationId" not in captured_json

    @pytest.mark.asyncio
    async def test_create_transcript_includes_metadata_when_provided(self, client):
        """Verify metadata is included as-is when provided."""
        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"contextItemId": "ctx-456"}

        metadata = {
            "word_timestamps": [{"word": "Hello", "start": 0.0, "end": 0.5}],
            "timing": {"total_seconds": 5.0},
        }

        with patch.object(client, "_request", side_effect=capture_request):
            await client.create_transcript(
                job_id="job-123",
                transcript_text="Hello",
                metadata=metadata,
            )

            assert captured_json["metadata"] == metadata


# =============================================================================
# Legacy update_job_status — cover datetime branches (lines 192-198)
# =============================================================================


class TestLegacyUpdateJobStatus:
    """Tests for legacy update_job_status covering all optional field paths."""

    @pytest.fixture
    def client(self):
        return APIGatewayClient(
            base_url="http://localhost:8868/api/v1",
            api_key="test-key",
        )

    @pytest.mark.asyncio
    async def test_minimal_status_update_only_sends_status(self, client):
        """Verify payload with only required 'status' field."""
        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"id": "j-1", "status": "QUEUED"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.update_job_status("j-1", "QUEUED")

        assert captured_json == {"status": "QUEUED"}

    @pytest.mark.asyncio
    async def test_started_at_datetime_serialized_to_iso(self, client):
        """Verify started_at datetime is converted to ISO 8601 string."""
        from datetime import datetime

        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"id": "j-1"}

        started = datetime(2026, 2, 10, 14, 30, 0, tzinfo=UTC)

        with patch.object(client, "_request", side_effect=capture_request):
            await client.update_job_status(
                "j-1",
                "PROCESSING",
                started_at=started,
                worker_id="w-1",
            )

        assert captured_json["startedAt"] == "2026-02-10T14:30:00+00:00"
        assert captured_json["workerId"] == "w-1"
        assert "completedAt" not in captured_json

    @pytest.mark.asyncio
    async def test_completed_at_datetime_serialized_to_iso(self, client):
        """Verify completed_at datetime is converted to ISO 8601 string."""
        from datetime import datetime

        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"id": "j-1"}

        completed = datetime(2026, 2, 10, 15, 0, 0, tzinfo=UTC)

        with patch.object(client, "_request", side_effect=capture_request):
            await client.update_job_status(
                "j-1",
                "COMPLETED",
                completed_at=completed,
                progress=100,
            )

        assert captured_json["completedAt"] == "2026-02-10T15:00:00+00:00"
        assert captured_json["progress"] == 100

    @pytest.mark.asyncio
    async def test_all_optional_fields_included(self, client):
        """Verify all optional fields are included when provided."""
        from datetime import datetime

        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"id": "j-1"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.update_job_status(
                "j-1",
                "FAILED",
                progress=50,
                started_at=datetime(2026, 1, 1, tzinfo=UTC),
                completed_at=datetime(2026, 1, 1, 0, 5, 0, tzinfo=UTC),
                error_code="TIMEOUT",
                error_message="Processing timed out after 10m",
                worker_id="w-42",
            )

        assert captured_json["status"] == "FAILED"
        assert captured_json["progress"] == 50
        assert captured_json["startedAt"] == "2026-01-01T00:00:00+00:00"
        assert captured_json["completedAt"] == "2026-01-01T00:05:00+00:00"
        assert captured_json["errorCode"] == "TIMEOUT"
        assert captured_json["errorMessage"] == "Processing timed out after 10m"
        assert captured_json["workerId"] == "w-42"

    @pytest.mark.asyncio
    async def test_sends_to_correct_endpoint(self, client):
        """Verify the legacy endpoint path is /internal/stt/jobs/{id}/status."""
        captured_path = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_path
            captured_path = path
            return {"id": "j-abc"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.update_job_status("j-abc", "PROCESSING")

        assert captured_path == "/internal/stt/jobs/j-abc/status"

    @pytest.mark.asyncio
    async def test_error_code_without_error_message(self, client):
        """Verify error_code alone is included; error_message omitted."""
        captured_json = None

        async def capture_request(method, path, json=None, params=None, headers=None):
            nonlocal captured_json
            captured_json = json
            return {"id": "j-1"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.update_job_status("j-1", "FAILED", error_code="FATAL")

        assert captured_json["errorCode"] == "FATAL"
        assert "errorMessage" not in captured_json


# =============================================================================
# HTTP client lifecycle edge cases
# =============================================================================


class TestHTTPClientEdgeCases:
    """Edge cases for HTTP client initialization and cleanup."""

    @pytest.fixture
    def client(self):
        return APIGatewayClient(
            base_url="http://localhost:8868/api/v1/",
            api_key="test-key",
            timeout=15,
        )

    @pytest.mark.asyncio
    async def test_base_url_trailing_slash_stripped(self, client):
        """Verify trailing slash is stripped from base_url."""
        assert client.base_url == "http://localhost:8868/api/v1"

    @pytest.mark.asyncio
    async def test_close_without_prior_request(self, client):
        """Verify close() is safe when no request was ever made."""
        # _client is None; close should not raise
        await client.close()
        assert client._client is None

    @pytest.mark.asyncio
    async def test_close_after_close_is_idempotent(self, client):
        """Verify double-close does not raise."""
        await client.close()
        await client.close()
        assert client._client is None

    @pytest.mark.asyncio
    async def test_health_check_returns_true_on_success(self, client):
        """Verify health_check returns True when API is reachable."""

        async def mock_request(method, path, json=None, params=None):
            return {"status": "ok"}

        with patch.object(client, "_request", side_effect=mock_request):
            result = await client.health_check()

        assert result is True

    @pytest.mark.asyncio
    async def test_health_check_returns_false_on_failure(self, client):
        """Verify health_check returns False when API is unreachable."""
        with patch.object(client, "_request", side_effect=APIGatewayError("down")):
            result = await client.health_check()

        assert result is False
