"""Unit tests for TranscriptionEventPublisher.

Tests verify event serialization, channel key construction, Redis publish
calls, and graceful degradation when Redis is unavailable.
"""

import json
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.core.messaging.pubsub import (
    TranscriptionEventPublisher,
    _channel_key,
    _utc_iso,
)

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def mock_settings():
    """Mock settings with pub/sub configuration."""
    settings = MagicMock()
    settings.pubsub_channel_prefix = "stt:transcription:"
    settings.pubsub_enabled = True
    settings.redis_url = "redis://localhost:6379/0"
    return settings


@pytest.fixture
def mock_redis():
    """Mock async Redis client."""
    redis = AsyncMock()
    redis.ping = AsyncMock()
    redis.publish = AsyncMock(return_value=1)
    redis.aclose = AsyncMock()
    return redis


@pytest.fixture
async def connected_publisher(mock_settings, mock_redis):
    """Publisher with a mocked connected Redis client."""
    publisher = TranscriptionEventPublisher()
    publisher._redis = mock_redis
    publisher._connected = True
    yield publisher
    publisher._connected = False
    publisher._redis = None


# =============================================================================
# Channel Key Tests
# =============================================================================


class TestChannelKey:
    """Tests for channel key construction."""

    def test_channel_key_format(self, mock_settings):
        """Verify channel key follows {prefix}{job_id} format."""
        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            key = _channel_key("job-abc-123")
            assert key == "stt:transcription:job-abc-123"

    def test_channel_key_uses_settings_prefix(self, mock_settings):
        """Verify channel key uses the configured prefix."""
        mock_settings.pubsub_channel_prefix = "custom:prefix:"
        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            key = _channel_key("my-job")
            assert key == "custom:prefix:my-job"

    def test_utc_iso_returns_valid_iso_format(self):
        """Verify _utc_iso returns a valid ISO 8601 timestamp."""
        ts = _utc_iso()
        assert "T" in ts
        assert "+" in ts or "Z" in ts  # Has timezone info


# =============================================================================
# Connection Tests
# =============================================================================


class TestConnection:
    """Tests for publisher connect/close lifecycle."""

    @pytest.mark.asyncio
    async def test_connect_establishes_redis_connection(self, mock_settings):
        """Verify connect creates Redis client and pings."""
        mock_redis_instance = AsyncMock()
        mock_redis_instance.ping = AsyncMock()

        with (
            patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings),
            patch("redis.asyncio.from_url", return_value=mock_redis_instance) as mock_from_url,
        ):
            publisher = TranscriptionEventPublisher()
            await publisher.connect()

            assert publisher.is_connected is True
            mock_from_url.assert_called_once_with(
                "redis://localhost:6379/0",
                decode_responses=True,
            )
            mock_redis_instance.ping.assert_awaited_once()

            # Cleanup
            publisher._connected = False
            publisher._redis = None

    @pytest.mark.asyncio
    async def test_connect_is_idempotent(self, mock_settings):
        """Verify calling connect twice does not create a second connection."""
        mock_redis_instance = AsyncMock()
        mock_redis_instance.ping = AsyncMock()

        with (
            patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings),
            patch("redis.asyncio.from_url", return_value=mock_redis_instance) as mock_from_url,
        ):
            publisher = TranscriptionEventPublisher()
            await publisher.connect()
            await publisher.connect()  # Second call should be no-op

            assert mock_from_url.call_count == 1
            publisher._connected = False
            publisher._redis = None

    @pytest.mark.asyncio
    async def test_connect_skips_when_disabled(self, mock_settings):
        """Verify connect is no-op when pubsub_enabled is False."""
        mock_settings.pubsub_enabled = False

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            publisher = TranscriptionEventPublisher()
            await publisher.connect()

            assert publisher.is_connected is False

    @pytest.mark.asyncio
    async def test_connect_degrades_on_redis_failure(self, mock_settings):
        """Verify connect handles Redis connection failure gracefully."""
        with (
            patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings),
            patch("redis.asyncio.from_url", side_effect=ConnectionError("Redis unavailable")),
        ):
            publisher = TranscriptionEventPublisher()
            # Should NOT raise
            await publisher.connect()

            assert publisher.is_connected is False

    @pytest.mark.asyncio
    async def test_close_releases_resources(self, connected_publisher, mock_redis):
        """Verify close disconnects and resets state."""
        await connected_publisher.close()

        assert connected_publisher.is_connected is False
        mock_redis.aclose.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_close_is_idempotent(self):
        """Verify close can be called multiple times safely."""
        publisher = TranscriptionEventPublisher()
        await publisher.close()
        await publisher.close()  # Should not raise

        assert publisher.is_connected is False


# =============================================================================
# Event Serialization Tests
# =============================================================================


class TestPublishStatus:
    """Tests for publish_status event."""

    @pytest.mark.asyncio
    async def test_publishes_status_event(self, connected_publisher, mock_redis, mock_settings):
        """Verify status event has correct type and data structure."""
        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_status("job-1", "PROCESSING", worker_id="w-42")

        # Extract published message
        mock_redis.publish.assert_awaited_once()
        channel, message = mock_redis.publish.call_args.args
        event = json.loads(message)

        assert channel == "stt:transcription:job-1"
        assert event["type"] == "status"
        assert event["data"]["jobId"] == "job-1"
        assert event["data"]["status"] == "PROCESSING"
        assert event["data"]["workerId"] == "w-42"
        assert "timestamp" in event["data"]

    @pytest.mark.asyncio
    async def test_status_omits_worker_id_when_none(
        self, connected_publisher, mock_redis, mock_settings
    ):
        """Verify workerId is omitted when not provided."""
        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_status("job-1", "COMPLETED")

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        assert "workerId" not in event["data"]
        assert event["data"]["status"] == "COMPLETED"


class TestPublishProgress:
    """Tests for publish_progress event."""

    @pytest.mark.asyncio
    async def test_publishes_progress_event(self, connected_publisher, mock_redis, mock_settings):
        """Verify progress event structure."""
        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_progress("job-1", 45, stage="inference")

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        assert event["type"] == "progress"
        assert event["data"]["jobId"] == "job-1"
        assert event["data"]["progress"] == 45
        assert event["data"]["stage"] == "inference"

    @pytest.mark.asyncio
    async def test_progress_omits_stage_when_empty(
        self, connected_publisher, mock_redis, mock_settings
    ):
        """Verify stage is omitted when empty string."""
        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_progress("job-1", 80)

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        assert "stage" not in event["data"]


class TestPublishChunk:
    """Tests for publish_chunk event."""

    @dataclass
    class MockChunk:
        """Mimics ChunkTranscriptionResult.to_dict() output."""

        chunk_index: int = 3
        text: str = "The patient reports mild discomfort."
        start_time: float = 12.5
        end_time: float = 17.3
        is_final: bool = False
        word_timestamps: list[dict[str, Any]] = field(default_factory=list)
        vad_segment_index: int = -1

        def to_dict(self) -> dict[str, Any]:
            return {
                "chunk_index": self.chunk_index,
                "text": self.text,
                "start_time": self.start_time,
                "end_time": self.end_time,
                "is_final": self.is_final,
                "word_timestamps": self.word_timestamps,
                "vad_segment_index": self.vad_segment_index,
            }

    @pytest.mark.asyncio
    async def test_publishes_chunk_event(self, connected_publisher, mock_redis, mock_settings):
        """Verify chunk event serializes ChunkTranscriptionResult correctly."""
        chunk = self.MockChunk(
            word_timestamps=[
                {"word": "The", "start_time": 12.5, "end_time": 12.7, "confidence": 0.99},
            ],
        )

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_chunk("job-1", chunk)

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        assert event["type"] == "chunk"
        assert event["data"]["jobId"] == "job-1"
        assert event["data"]["chunkIndex"] == 3
        assert event["data"]["text"] == "The patient reports mild discomfort."
        assert event["data"]["startTime"] == 12.5
        assert event["data"]["endTime"] == 17.3
        assert event["data"]["isFinal"] is False
        assert len(event["data"]["wordTimestamps"]) == 1
        assert event["data"]["wordTimestamps"][0]["word"] == "The"
        assert event["data"]["wordTimestamps"][0]["confidence"] == 0.99

    @pytest.mark.asyncio
    async def test_chunk_without_word_timestamps(
        self, connected_publisher, mock_redis, mock_settings
    ):
        """Verify chunk event works without word timestamps."""
        chunk = self.MockChunk()

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_chunk("job-1", chunk)

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        assert "wordTimestamps" not in event["data"]


class TestPublishTranscript:
    """Tests for publish_transcript event."""

    @dataclass
    class MockResult:
        """Mimics TranscriptionResult.to_dict() output."""

        def to_dict(self) -> dict[str, Any]:
            return {
                "text": "Full transcript text here.",
                "language": "en",
                "language_probability": 0.95,
                "duration_seconds": 120.5,
                "processing_time_seconds": 8.3,
                "word_timestamps": [
                    {"word": "Full", "start_time": 0.0, "end_time": 0.3, "confidence": 0.99},
                ],
                "sentence_timestamps": [
                    {"text": "Full transcript text here.", "start_time": 0.0, "end_time": 2.5},
                ],
                "metadata": {"timing": {"total_seconds": 8.3}},
            }

    @pytest.mark.asyncio
    async def test_publishes_transcript_event(self, connected_publisher, mock_redis, mock_settings):
        """Verify transcript event serializes TranscriptionResult correctly."""
        result = self.MockResult()

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_transcript("job-1", result)

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        assert event["type"] == "transcript"
        assert event["data"]["jobId"] == "job-1"
        assert event["data"]["text"] == "Full transcript text here."
        assert event["data"]["language"] == "en"
        assert event["data"]["languageProbability"] == 0.95
        assert event["data"]["durationSeconds"] == 120.5
        assert event["data"]["processingTimeSeconds"] == 8.3
        assert len(event["data"]["wordTimestamps"]) == 1
        assert event["data"]["wordTimestamps"][0]["word"] == "Full"
        assert len(event["data"]["sentenceTimestamps"]) == 1
        assert event["data"]["metadata"]["timing"]["total_seconds"] == 8.3


class TestPublishError:
    """Tests for publish_error event."""

    @pytest.mark.asyncio
    async def test_publishes_error_event(self, connected_publisher, mock_redis, mock_settings):
        """Verify error event structure."""
        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_error(
                "job-1",
                error_code="TRANSCRIPTION_ERROR",
                message="ASR model inference failed",
            )

        message_str = mock_redis.publish.call_args.args[1]
        event = json.loads(message_str)

        assert event["type"] == "error"
        assert event["data"]["jobId"] == "job-1"
        assert event["data"]["errorCode"] == "TRANSCRIPTION_ERROR"
        assert event["data"]["message"] == "ASR model inference failed"


# =============================================================================
# Graceful Degradation Tests
# =============================================================================


class TestGracefulDegradation:
    """Tests for best-effort publishing — errors should not propagate."""

    @pytest.mark.asyncio
    async def test_publish_silently_returns_when_not_connected(self):
        """Verify publish methods are no-op when not connected."""
        publisher = TranscriptionEventPublisher()
        # Should NOT raise
        await publisher.publish_status("job-1", "PROCESSING")
        await publisher.publish_progress("job-1", 50)
        await publisher.publish_error("job-1", "ERR", "msg")

    @pytest.mark.asyncio
    async def test_publish_silently_handles_redis_error(self, mock_settings, mock_redis):
        """Verify publish handles Redis publish failures gracefully."""
        mock_redis.publish.side_effect = ConnectionError("Redis went away")

        publisher = TranscriptionEventPublisher()
        publisher._redis = mock_redis
        publisher._connected = True

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            # Should NOT raise
            await publisher.publish_status("job-1", "PROCESSING")

        publisher._connected = False
        publisher._redis = None

    @pytest.mark.asyncio
    async def test_publish_handles_serialization_edge_cases(
        self, connected_publisher, mock_redis, mock_settings
    ):
        """Verify publish handles non-standard types via default=str."""
        from datetime import datetime

        @dataclass
        class WeirdResult:
            def to_dict(self):
                return {
                    "text": "hello",
                    "language": None,
                    "language_probability": None,
                    "duration_seconds": 0,
                    "processing_time_seconds": 0,
                    "word_timestamps": [],
                    "sentence_timestamps": [],
                    "metadata": {"created_at": datetime(2026, 1, 1)},
                }

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            # Should NOT raise — datetime is handled by default=str
            await connected_publisher.publish_transcript("job-1", WeirdResult())

        mock_redis.publish.assert_awaited_once()


# =============================================================================
# Settings Integration Tests
# =============================================================================


class TestPubSubSettings:
    """Tests for pub/sub settings in Settings model."""

    def test_default_channel_prefix(self):
        """Verify default channel prefix is stt:transcription:."""
        with patch.dict("os.environ", {}, clear=False):
            from stt.core.config.settings import Settings

            settings = Settings()
            assert settings.pubsub_channel_prefix == "stt:transcription:"

    def test_default_pubsub_enabled(self):
        """Verify pub/sub is enabled by default."""
        with patch.dict("os.environ", {}, clear=False):
            from stt.core.config.settings import Settings

            settings = Settings()
            assert settings.pubsub_enabled is True

    def test_pubsub_is_no_longer_settable_from_env(self):
        """TASK-799: both pub/sub knobs are control-plane owned.

        `PUBSUB_ENABLED` / `PUBSUB_CHANNEL_PREFIX` used to be environment
        variables, which meant retuning the relay channel — or turning the
        real-time event feed off during an incident — required a redeploy.
        They are now registry keys (`stt.pubsub.*`), and the env path is closed
        STRUCTURALLY so an operator cannot set a value the next config pull
        would silently overwrite.
        """
        with patch.dict(
            "os.environ",
            {"PUBSUB_ENABLED": "false", "PUBSUB_CHANNEL_PREFIX": "custom:prefix:"},
            clear=False,
        ):
            from stt.core.config.settings import Settings

            settings = Settings()
            assert settings.pubsub_enabled is True
            assert settings.pubsub_channel_prefix == "stt:transcription:"

    def test_pubsub_is_settable_from_the_control_plane(self):
        """The replacement path: a served value reaches the running service."""
        from stt.core.config.settings import Settings
        from stt.core.control_plane import apply_control_plane

        settings = Settings(_env_file=None)
        apply_control_plane(
            settings,
            {
                "settings": {
                    "stt.pubsub.enabled": {
                        "value": False,
                        "dataType": "boolean",
                        "source": "db",
                    },
                    "stt.pubsub.channelPrefix": {
                        "value": "custom:prefix:",
                        "dataType": "string",
                        "source": "db",
                    },
                }
            },
        )
        assert settings.pubsub_enabled is False
        assert settings.pubsub_channel_prefix == "custom:prefix:"


# =============================================================================
# Edge Case Tests — coverage gaps and boundary conditions
# =============================================================================


class TestPublishChunkEdgeCases:
    """Edge cases for chunk serialization."""

    @pytest.mark.asyncio
    async def test_chunk_as_dict_without_to_dict(
        self, connected_publisher, mock_redis, mock_settings
    ):
        """Verify chunk works with a plain dict (no to_dict method)."""
        plain_dict_chunk = {
            "chunk_index": 5,
            "text": "Plain dict chunk",
            "start_time": 10.0,
            "end_time": 12.0,
            "is_final": True,
            "word_timestamps": [],
        }

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_chunk("job-1", plain_dict_chunk)

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        assert event["data"]["chunkIndex"] == 5
        assert event["data"]["text"] == "Plain dict chunk"
        assert event["data"]["isFinal"] is True

    @pytest.mark.asyncio
    async def test_chunk_with_word_timestamps_using_start_end_keys(
        self, connected_publisher, mock_redis, mock_settings
    ):
        """Verify word timestamp fallback keys (start/end vs start_time/end_time)."""
        chunk = MagicMock()
        chunk.to_dict.return_value = {
            "chunk_index": 0,
            "text": "Fallback keys",
            "start_time": 0.0,
            "end_time": 1.0,
            "is_final": False,
            "word_timestamps": [
                {"word": "Fallback", "start": 0.0, "end": 0.4, "confidence": 0.9},
            ],
        }

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_chunk("job-1", chunk)

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        # Should use 'start'/'end' fallback keys
        wt = event["data"]["wordTimestamps"][0]
        assert wt["start"] == 0.0
        assert wt["end"] == 0.4

    @pytest.mark.asyncio
    async def test_chunk_missing_optional_fields_uses_defaults(
        self, connected_publisher, mock_redis, mock_settings
    ):
        """Verify chunk with minimal fields uses sane defaults."""
        chunk = MagicMock()
        chunk.to_dict.return_value = {
            "text": "Minimal chunk",
        }

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_chunk("job-1", chunk)

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        assert event["data"]["chunkIndex"] == 0
        assert event["data"]["startTime"] == 0.0
        assert event["data"]["endTime"] == 0.0
        assert event["data"]["isFinal"] is False


class TestPublishTranscriptEdgeCases:
    """Edge cases for transcript serialization."""

    @pytest.mark.asyncio
    async def test_transcript_as_dict_without_to_dict(
        self, connected_publisher, mock_redis, mock_settings
    ):
        """Verify transcript works with a plain dict (no to_dict method)."""
        plain_result = {
            "text": "Dict result",
            "language": "ml",
            "language_probability": 0.8,
            "duration_seconds": 30.0,
            "processing_time_seconds": 5.0,
            "word_timestamps": [],
            "sentence_timestamps": [],
            "metadata": {},
        }

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_transcript("job-1", plain_result)

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        assert event["data"]["language"] == "ml"
        assert event["data"]["durationSeconds"] == 30.0

    @pytest.mark.asyncio
    async def test_transcript_with_empty_result(
        self, connected_publisher, mock_redis, mock_settings
    ):
        """Verify transcript handles empty/minimal result gracefully."""
        empty_result = MagicMock()
        empty_result.to_dict.return_value = {
            "text": "",
            "word_timestamps": [],
            "sentence_timestamps": [],
            "metadata": {},
        }

        with patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings):
            await connected_publisher.publish_transcript("job-1", empty_result)

        message = mock_redis.publish.call_args.args[1]
        event = json.loads(message)

        assert event["data"]["text"] == ""
        assert event["data"]["durationSeconds"] == 0.0
        assert event["data"]["processingTimeSeconds"] == 0.0


class TestCloseEdgeCases:
    """Edge cases for publisher close."""

    @pytest.mark.asyncio
    async def test_close_handles_aclose_exception(self, mock_settings):
        """Verify close swallows exceptions from Redis aclose."""
        mock_redis = AsyncMock()
        mock_redis.aclose = AsyncMock(side_effect=ConnectionError("already closed"))

        publisher = TranscriptionEventPublisher()
        publisher._redis = mock_redis
        publisher._connected = True

        # Should NOT raise
        await publisher.close()

        assert publisher.is_connected is False
        assert publisher._redis is None

    @pytest.mark.asyncio
    async def test_close_after_failed_connect(self, mock_settings):
        """Verify close works after connect() failed."""
        publisher = TranscriptionEventPublisher()
        # Simulate failed connect: _redis is None, _connected is False
        assert publisher._redis is None
        assert publisher.is_connected is False

        # Should NOT raise
        await publisher.close()
        assert publisher.is_connected is False


class TestConnectEdgeCases:
    """Edge cases for publisher connect."""

    @pytest.mark.asyncio
    async def test_connect_handles_ping_failure(self, mock_settings):
        """Verify connect degrades when ping fails after connection."""
        mock_redis_instance = AsyncMock()
        mock_redis_instance.ping = AsyncMock(side_effect=ConnectionError("ping failed"))

        with (
            patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings),
            patch("redis.asyncio.from_url", return_value=mock_redis_instance),
        ):
            publisher = TranscriptionEventPublisher()
            await publisher.connect()

            assert publisher.is_connected is False

    @pytest.mark.asyncio
    async def test_publish_after_connect_failure_is_silent(self, mock_settings):
        """Verify publish is no-op after connect failure (no exceptions)."""
        with (
            patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings),
            patch("redis.asyncio.from_url", side_effect=OSError("no route")),
        ):
            publisher = TranscriptionEventPublisher()
            await publisher.connect()

            assert publisher.is_connected is False

            # All publish methods should be silent no-ops
            await publisher.publish_status("j-1", "PROCESSING")
            await publisher.publish_progress("j-1", 50)
            await publisher.publish_chunk("j-1", {"text": "hi", "chunk_index": 0})
            await publisher.publish_transcript("j-1", {"text": "result"})
            await publisher.publish_error("j-1", "ERR", "msg")
