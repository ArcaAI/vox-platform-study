"""Unit tests for API Gateway client.

These tests focus on behavior verification rather than mock verification.
Tests verify actual outcomes and transformations, not just that mocks were called.
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from stt_v2.core.api_client.gateway import APIGatewayClient, get_api_client
from stt_v2.core.exceptions import APIGatewayError

# =============================================================================
# Complete Response Fixtures (Anti-Pattern #4 Prevention)
# =============================================================================

def create_complete_api_response(data: dict, status_code: int = 200) -> MagicMock:
    """Create a complete mock response matching real httpx.Response structure.

    This prevents incomplete mock anti-pattern by including all fields
    that production code might access.
    """
    response = MagicMock()
    response.status_code = status_code
    response.headers = {
        "content-type": "application/json",
        "x-request-id": "req-12345",
        "date": "Mon, 01 Jan 2024 00:00:00 GMT",
    }
    response.json.return_value = data
    response.text = str(data)
    response.content = str(data).encode()
    response.is_success = 200 <= status_code < 300
    response.raise_for_status = MagicMock()

    if status_code >= 400:
        response.raise_for_status.side_effect = httpx.HTTPStatusError(
            f"HTTP {status_code}",
            request=MagicMock(),
            response=response,
        )

    return response


class TestAPIGatewayClient:
    """Tests for APIGatewayClient.

    Focus on testing actual behavior outcomes, not mock invocations.
    """

    @pytest.fixture
    def client(self):
        """Create API gateway client."""
        return APIGatewayClient(
            base_url="http://localhost:8868/api/v1",
            api_key="test-api-key",
            timeout=30,
        )

    # =========================================================================
    # Initialization Tests - Test actual state, not mocks
    # =========================================================================

    def test_initialization_sets_correct_state(self, client):
        """Verify client initializes with correct configuration state."""
        # Test actual state values, not mock calls
        assert client.base_url == "http://localhost:8868/api/v1"
        assert client.api_key == "test-api-key"
        assert client.timeout == 30
        assert client._client is None  # Lazy initialization

    def test_base_url_normalization_removes_trailing_slash(self):
        """Verify base URL normalization actually transforms the URL."""
        # Test the actual transformation behavior
        inputs_and_expected = [
            ("http://localhost:8868/api/v1/", "http://localhost:8868/api/v1"),
            ("http://localhost:8868/api/v1///", "http://localhost:8868/api/v1"),
            ("http://localhost:8868/api/v1", "http://localhost:8868/api/v1"),
        ]

        for input_url, expected in inputs_and_expected:
            client = APIGatewayClient(base_url=input_url, api_key="key")
            assert client.base_url == expected, f"Failed for input: {input_url}"

    # =========================================================================
    # Client Lifecycle Tests - Test behavior outcomes
    # =========================================================================

    @pytest.mark.asyncio
    async def test_get_client_lazy_initialization(self, client):
        """Verify client is created lazily and only once."""
        assert client._client is None, "Client should start as None"

        with patch("stt_v2.core.api_client.gateway.httpx.AsyncClient") as mock_class:
            mock_instance = AsyncMock()
            mock_class.return_value = mock_instance

            # First call should create
            result1 = await client._get_client()
            assert client._client is not None
            assert result1 is mock_instance

            # Second call should reuse (NOT create new)
            result2 = await client._get_client()
            assert result2 is result1

            # Verify only created once
            assert mock_class.call_count == 1

    @pytest.mark.asyncio
    async def test_close_cleans_up_resources(self, client):
        """Verify close actually releases the HTTP client."""
        # Setup: client with active connection
        mock_http_client = AsyncMock()
        client._client = mock_http_client

        # Action
        await client.close()

        # Verify actual state change (the important part)
        assert client._client is None
        # Also verify cleanup was called
        mock_http_client.aclose.assert_called_once()

    @pytest.mark.asyncio
    async def test_close_is_idempotent(self, client):
        """Verify close can be called multiple times safely."""
        # Close without any client
        await client.close()
        await client.close()  # Should not raise

        assert client._client is None

    # =========================================================================
    # Request Tests - Test actual data transformation and error handling
    # =========================================================================

    @pytest.mark.asyncio
    async def test_request_returns_parsed_json_data(self, client):
        """Verify request returns actual parsed response data."""
        expected_data = {
            "id": "job-123",
            "status": "completed",
            "result": {"text": "Hello world"},
            "metadata": {"duration_ms": 1500},
        }

        mock_response = create_complete_api_response(expected_data)
        mock_http_client = AsyncMock()
        mock_http_client.request = AsyncMock(return_value=mock_response)

        with patch.object(client, "_get_client", return_value=mock_http_client):
            result = await client._request("GET", "/jobs/123")

            # Test actual returned data, not mock calls
            assert result == expected_data
            assert result["id"] == "job-123"
            assert result["result"]["text"] == "Hello world"

    @pytest.mark.asyncio
    async def test_request_passes_json_body_correctly(self, client):
        """Verify JSON body is correctly passed to the HTTP client."""
        input_data = {"name": "test", "value": 42, "nested": {"key": "value"}}

        mock_response = create_complete_api_response({"id": "created"})
        mock_http_client = AsyncMock()
        mock_http_client.request = AsyncMock(return_value=mock_response)

        with patch.object(client, "_get_client", return_value=mock_http_client):
            await client._request("POST", "/items", json=input_data)

            # Verify the actual arguments passed
            call_kwargs = mock_http_client.request.call_args.kwargs
            assert call_kwargs["json"] == input_data

    @pytest.mark.asyncio
    async def test_request_transforms_http_error_to_domain_error(self, client):
        """Verify HTTP errors are transformed to APIGatewayError with details."""
        mock_response = create_complete_api_response(
            {"error": "Internal Server Error"},
            status_code=500
        )
        mock_http_client = AsyncMock()
        mock_http_client.request = AsyncMock(return_value=mock_response)

        with patch.object(client, "_get_client", return_value=mock_http_client):
            with pytest.raises(APIGatewayError) as exc_info:
                await client._request("GET", "/fail")

            # Test the actual error transformation
            error = exc_info.value
            assert error.error_code == "API_GATEWAY_ERROR"
            assert "500" in str(error) or "status_code" in str(error.details)

    @pytest.mark.asyncio
    async def test_request_transforms_connection_error_to_domain_error(self, client):
        """Verify connection errors are transformed to APIGatewayError."""
        mock_http_client = AsyncMock()
        mock_http_client.request = AsyncMock(
            side_effect=httpx.RequestError("Connection refused", request=MagicMock())
        )

        with patch.object(client, "_get_client", return_value=mock_http_client):
            with pytest.raises(APIGatewayError) as exc_info:
                await client._request("GET", "/test")

            # Test actual error content
            error = exc_info.value
            assert "connection" in str(error).lower() or "refused" in str(error).lower()


class TestAPIGatewayClientMethods:
    """Tests for API Gateway client business methods.

    Focus: Test the actual payload construction and response handling,
    not just that _request was called.
    """

    @pytest.fixture
    def client(self):
        return APIGatewayClient(
            base_url="http://localhost:8868/api/v1",
            api_key="test-key",
        )

    # =========================================================================
    # Job Status Update - Test payload construction behavior
    # =========================================================================

    @pytest.mark.asyncio
    async def test_update_job_status_constructs_correct_payload(self, client):
        """Verify update_job_status builds the correct API payload structure."""
        captured_payload = None

        async def capture_request(method, path, json=None, params=None):
            nonlocal captured_payload
            captured_payload = json
            return {"status": "updated", "job_id": "j-123"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.update_job_status(
                job_id="j-123",
                status="PROCESSING",
                progress=50,
                worker_id="worker-1",
            )

            # Test actual payload construction (the behavior we care about)
            assert captured_payload["status"] == "PROCESSING"
            assert captured_payload["progress"] == 50
            assert captured_payload["workerId"] == "worker-1"

    @pytest.mark.asyncio
    async def test_update_job_status_serializes_datetime_to_iso(self, client):
        """Verify datetime fields are correctly serialized to ISO format."""
        captured_payload = None

        async def capture_request(method, path, json=None, params=None):
            nonlocal captured_payload
            captured_payload = json
            return {"status": "ok"}

        started = datetime(2024, 1, 1, 12, 0, 0)
        completed = datetime(2024, 1, 1, 12, 5, 0)

        with patch.object(client, "_request", side_effect=capture_request):
            await client.update_job_status(
                job_id="j-123",
                status="COMPLETED",
                started_at=started,
                completed_at=completed,
            )

            # Test actual serialization behavior
            assert captured_payload["startedAt"] == "2024-01-01T12:00:00"
            assert captured_payload["completedAt"] == "2024-01-01T12:05:00"

    @pytest.mark.asyncio
    async def test_update_job_status_omits_none_fields(self, client):
        """Verify None optional fields are NOT included in payload."""
        captured_payload = None

        async def capture_request(method, path, json=None, params=None):
            nonlocal captured_payload
            captured_payload = json
            return {"status": "ok"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.update_job_status(
                job_id="j-123",
                status="PENDING",
                # All optional fields left as None
            )

            # Test that only required fields are present
            assert "status" in captured_payload
            assert "progress" not in captured_payload
            assert "errorCode" not in captured_payload
            assert "workerId" not in captured_payload

    # =========================================================================
    # Transcript Creation - Test payload structure
    # =========================================================================

    @pytest.mark.asyncio
    async def test_create_transcript_constructs_correct_payload(self, client):
        """Verify create_transcript builds payload matching CreateTranscriptRequest DTO."""
        captured_payload = None

        async def capture_request(method, path, json=None, params=None):
            nonlocal captured_payload
            captured_payload = json
            return {
                "contextItemId": "ctx-123",
            }

        with patch.object(client, "_request", side_effect=capture_request):
            result = await client.create_transcript(
                job_id="job-123",
                transcript_text="Hello world transcription",
                metadata={"language": "en", "confidence": 0.95},
                consultation_id="c-123",
            )

            # Test payload construction matches NestJS CreateTranscriptRequest
            assert captured_payload["jobId"] == "job-123"
            assert captured_payload["transcriptText"] == "Hello world transcription"
            assert captured_payload["metadata"] == {"language": "en", "confidence": 0.95}
            assert captured_payload["consultationId"] == "c-123"

            # Test that response is returned correctly
            assert result["contextItemId"] == "ctx-123"

    # =========================================================================
    # Audio Recording Creation - Test complete payload
    # =========================================================================

    @pytest.mark.asyncio
    async def test_create_audio_recording_includes_all_metadata(self, client):
        """Verify audio recording includes all audio metadata fields."""
        captured_payload = None

        async def capture_request(method, path, json=None, params=None):
            nonlocal captured_payload
            captured_payload = json
            return {"id": "ar-123"}

        with patch.object(client, "_request", side_effect=capture_request):
            await client.create_audio_recording(
                context_item_id="ctx-123",
                media_id="m-456",
                tenant_id="t-789",
                duration=60,
                format="wav",
                sample_rate=16000,
                channels=1,
                bitrate=256000,
                language="en",
                sequence_number=2,
            )

            # Test all audio metadata is included
            assert captured_payload["contextItemId"] == "ctx-123"
            assert captured_payload["mediaId"] == "m-456"
            assert captured_payload["duration"] == 60
            assert captured_payload["format"] == "wav"
            assert captured_payload["sampleRate"] == 16000
            assert captured_payload["channels"] == 1
            assert captured_payload["bitrate"] == 256000
            assert captured_payload["language"] == "en"
            assert captured_payload["sequenceNumber"] == 2

    # =========================================================================
    # Media Creation - Test complete payload
    # =========================================================================

    @pytest.mark.asyncio
    async def test_create_media_includes_file_metadata(self, client):
        """Verify media creation includes all file metadata."""
        captured_payload = None

        async def capture_request(method, path, json=None, params=None):
            nonlocal captured_payload
            captured_payload = json
            return {"id": "m-123", "uri": "s3://bucket/path/recording.wav"}

        with patch.object(client, "_request", side_effect=capture_request):
            _result = await client.create_media(
                tenant_id="t-123",
                name="recording.wav",
                uri="s3://bucket/path/recording.wav",
                extension="wav",
                mime_type="audio/wav",
                size=1024000,
                hash="sha256:abc123def456",
                created_by="user-123",
            )

            # Test complete file metadata
            assert captured_payload["name"] == "recording.wav"
            assert captured_payload["uri"] == "s3://bucket/path/recording.wav"
            assert captured_payload["extension"] == "wav"
            assert captured_payload["mimeType"] == "audio/wav"
            assert captured_payload["size"] == 1024000
            assert captured_payload["hash"] == "sha256:abc123def456"
            assert captured_payload["createdBy"] == "user-123"

    # =========================================================================
    # Health Check - Test actual behavior outcomes
    # =========================================================================

    @pytest.mark.asyncio
    async def test_health_check_returns_true_on_successful_response(self, client):
        """Verify health_check correctly interprets successful response."""
        with patch.object(client, "_request", new_callable=AsyncMock) as mock_request:
            mock_request.return_value = {
                "status": "ok",
                "service": "api",
                "version": "1.0.0",
            }

            result = await client.health_check()

            assert result is True

    @pytest.mark.asyncio
    async def test_health_check_returns_false_on_api_error(self, client):
        """Verify health_check correctly handles API failures."""
        with patch.object(client, "_request", new_callable=AsyncMock) as mock_request:
            mock_request.side_effect = APIGatewayError(
                "Connection failed",
                details={"status_code": 503}
            )

            result = await client.health_check()

            # Verify boolean conversion of error state
            assert result is False

    @pytest.mark.asyncio
    async def test_health_check_returns_false_on_timeout(self, client):
        """Verify health_check handles timeout gracefully."""
        with patch.object(client, "_request", new_callable=AsyncMock) as mock_request:
            mock_request.side_effect = APIGatewayError("Request timeout")

            result = await client.health_check()

            assert result is False


class TestGetAPIClient:
    """Tests for get_api_client singleton factory."""

    def test_creates_client_with_settings(self):
        """Verify factory creates client with correct settings."""
        with patch("stt_v2.core.api_client.gateway.settings") as mock_settings:
            mock_settings.api_gateway_url = "http://api.example.com:8868/api/v1"
            mock_settings.api_gateway_key = "production-key-123"
            mock_settings.api_gateway_timeout = 60

            # Clear cache for fresh test
            get_api_client.cache_clear()

            client = get_api_client()

            # Test actual client configuration
            assert isinstance(client, APIGatewayClient)
            assert client.base_url == "http://api.example.com:8868/api/v1"
            assert client.api_key == "production-key-123"
            assert client.timeout == 60

    def test_returns_same_instance_on_repeated_calls(self):
        """Verify singleton pattern - same instance returned."""
        with patch("stt_v2.core.api_client.gateway.settings") as mock_settings:
            mock_settings.api_gateway_url = "http://localhost:8868/api/v1"
            mock_settings.api_gateway_key = "test-key"
            mock_settings.api_gateway_timeout = 30

            get_api_client.cache_clear()

            client1 = get_api_client()
            client2 = get_api_client()

            # Test actual identity, not mock calls
            assert client1 is client2
