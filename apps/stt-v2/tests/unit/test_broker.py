"""Unit tests for Dramatiq broker configuration.

Tests cover broker setup, retry logic, and lifecycle management.
"""

import pytest
from unittest.mock import MagicMock, patch, AsyncMock


class TestRetryLogic:
    """Tests for should_retry function."""

    def test_should_retry_non_retryable_exception(self):
        """Test that non-retryable exceptions are not retried."""
        from stt_v2.core.messaging.broker import should_retry
        from stt_v2.core.exceptions import ConfigurationError

        # ConfigurationError is in NON_RETRYABLE_EXCEPTIONS
        exception = ConfigurationError("Bad config")

        result = should_retry(retries_so_far=0, exception=exception)

        assert result is False

    def test_should_retry_retryable_exception_under_limit(self):
        """Test retryable exception under retry limit."""
        from stt_v2.core.messaging.broker import should_retry

        with patch("stt_v2.core.messaging.broker.settings") as mock_settings:
            mock_settings.worker_max_retries = 3

            result = should_retry(retries_so_far=1, exception=Exception("Temp error"))

            assert result is True

    def test_should_retry_retryable_exception_at_limit(self):
        """Test retryable exception at retry limit."""
        from stt_v2.core.messaging.broker import should_retry

        with patch("stt_v2.core.messaging.broker.settings") as mock_settings:
            mock_settings.worker_max_retries = 3

            result = should_retry(retries_so_far=3, exception=Exception("Temp error"))

            assert result is False

    def test_should_retry_retryable_exception_over_limit(self):
        """Test retryable exception over retry limit."""
        from stt_v2.core.messaging.broker import should_retry

        with patch("stt_v2.core.messaging.broker.settings") as mock_settings:
            mock_settings.worker_max_retries = 3

            result = should_retry(retries_so_far=5, exception=Exception("Temp error"))

            assert result is False


class TestBrokerConfiguration:
    """Tests for broker configuration."""

    def test_configure_broker_creates_new_broker(self):
        """Test that configure_broker creates a new broker."""
        from stt_v2.core.messaging import broker as broker_module

        # Reset module state
        original_broker = broker_module._broker
        broker_module._broker = None

        mock_broker = MagicMock()
        mock_backend = MagicMock()

        try:
            with patch("stt_v2.core.messaging.broker.RedisBroker", return_value=mock_broker), \
                 patch("stt_v2.core.messaging.broker.RedisBackend", return_value=mock_backend), \
                 patch("stt_v2.core.messaging.broker.dramatiq") as mock_dramatiq, \
                 patch("stt_v2.core.messaging.broker.settings") as mock_settings:

                mock_settings.transcription_timeout_seconds = 300
                mock_settings.worker_max_retries = 3

                result = broker_module.configure_broker("redis://localhost:6379")

                assert result is mock_broker
                mock_broker.add_middleware.assert_called()
                mock_dramatiq.set_broker.assert_called_once_with(mock_broker)
        finally:
            broker_module._broker = original_broker

    def test_configure_broker_returns_existing_broker(self):
        """Test that configure_broker returns existing broker."""
        from stt_v2.core.messaging import broker as broker_module

        original_broker = broker_module._broker
        mock_existing = MagicMock()
        broker_module._broker = mock_existing

        try:
            result = broker_module.configure_broker("redis://localhost:6379")

            assert result is mock_existing
        finally:
            broker_module._broker = original_broker


class TestBrokerGetter:
    """Tests for get_broker function."""

    def test_get_broker_returns_configured_broker(self):
        """Test get_broker returns configured broker."""
        from stt_v2.core.messaging import broker as broker_module

        original_broker = broker_module._broker
        mock_broker = MagicMock()
        broker_module._broker = mock_broker

        try:
            result = broker_module.get_broker()

            assert result is mock_broker
        finally:
            broker_module._broker = original_broker

    def test_get_broker_raises_if_not_configured(self):
        """Test get_broker raises if broker not configured."""
        from stt_v2.core.messaging import broker as broker_module

        original_broker = broker_module._broker
        broker_module._broker = None

        try:
            with pytest.raises(RuntimeError, match="Broker not configured"):
                broker_module.get_broker()
        finally:
            broker_module._broker = original_broker


class TestBrokerLifecycle:
    """Tests for broker lifecycle methods."""

    @pytest.mark.asyncio
    async def test_initialize_redis(self):
        """Test initialize_redis configures broker."""
        from stt_v2.core.messaging import broker as broker_module

        original_broker = broker_module._broker
        broker_module._broker = None

        mock_broker = MagicMock()

        try:
            with patch.object(broker_module, "configure_broker", return_value=mock_broker) as mock_configure, \
                 patch("stt_v2.core.messaging.broker.settings") as mock_settings:

                mock_settings.redis_url = "redis://localhost:6379"

                await broker_module.initialize_redis()

                mock_configure.assert_called_once_with("redis://localhost:6379")
        finally:
            broker_module._broker = original_broker

    @pytest.mark.asyncio
    async def test_close_redis(self):
        """Test close_redis closes and clears broker."""
        from stt_v2.core.messaging import broker as broker_module

        original_broker = broker_module._broker
        mock_broker = MagicMock()
        broker_module._broker = mock_broker

        try:
            await broker_module.close_redis()

            mock_broker.close.assert_called_once()
            assert broker_module._broker is None
        finally:
            broker_module._broker = original_broker

    @pytest.mark.asyncio
    async def test_close_redis_when_not_configured(self):
        """Test close_redis handles None broker."""
        from stt_v2.core.messaging import broker as broker_module

        original_broker = broker_module._broker
        broker_module._broker = None

        try:
            # Should not raise
            await broker_module.close_redis()
        finally:
            broker_module._broker = original_broker


class TestNonRetryableExceptions:
    """Tests for non-retryable exception handling."""

    def test_validation_error_not_retryable(self):
        """Test ValidationError is not retried."""
        from stt_v2.core.messaging.broker import should_retry
        from stt_v2.core.exceptions import ValidationError

        exception = ValidationError("Invalid input")

        result = should_retry(retries_so_far=0, exception=exception)

        assert result is False

    def test_audio_processing_error_not_retryable(self):
        """Test AudioProcessingError is not retried."""
        from stt_v2.core.messaging.broker import should_retry
        from stt_v2.core.exceptions import AudioProcessingError

        exception = AudioProcessingError("Bad audio")

        result = should_retry(retries_so_far=0, exception=exception)

        assert result is False

    def test_job_cancelled_error_not_retryable(self):
        """Test JobCancelledError is not retried."""
        from stt_v2.core.messaging.broker import should_retry
        from stt_v2.core.exceptions import JobCancelledError

        exception = JobCancelledError("Job was cancelled")

        result = should_retry(retries_so_far=0, exception=exception)

        assert result is False
