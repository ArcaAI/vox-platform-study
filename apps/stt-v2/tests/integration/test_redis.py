"""Integration tests for Redis operations."""

import json

import pytest


@pytest.mark.integration
class TestRedisConnection:
    """Test Redis connection and basic operations."""

    def test_ping(self, redis_client):
        """Test Redis ping."""
        assert redis_client.ping() is True

    def test_set_and_get(self, redis_client):
        """Test basic set and get."""
        redis_client.set("test_key", "test_value")

        value = redis_client.get("test_key")

        assert value == b"test_value"

    def test_set_with_ttl(self, redis_client):
        """Test set with TTL."""
        redis_client.setex("ttl_key", 60, "ttl_value")

        ttl = redis_client.ttl("ttl_key")

        assert ttl > 0
        assert ttl <= 60

    def test_delete(self, redis_client):
        """Test delete key."""
        redis_client.set("delete_key", "value")
        redis_client.delete("delete_key")

        value = redis_client.get("delete_key")

        assert value is None


@pytest.mark.integration
class TestRedisQueue:
    """Test Redis as queue (for Dramatiq)."""

    def test_lpush_and_rpop(self, redis_client):
        """Test basic queue operations."""
        queue = "test_queue"

        # Push items
        redis_client.lpush(queue, "item1")
        redis_client.lpush(queue, "item2")
        redis_client.lpush(queue, "item3")

        # Pop items (FIFO)
        item = redis_client.rpop(queue)
        assert item == b"item1"

        item = redis_client.rpop(queue)
        assert item == b"item2"

    def test_json_message(self, redis_client):
        """Test JSON message in queue."""
        queue = "json_queue"
        message = {
            "job_id": "j-123",
            "pipeline_id": "p-456",
            "audio_uri": "s3://bucket/file.wav",
        }

        # Push JSON
        redis_client.lpush(queue, json.dumps(message))

        # Pop and parse
        raw = redis_client.rpop(queue)
        parsed = json.loads(raw)

        assert parsed["job_id"] == "j-123"
        assert parsed["pipeline_id"] == "p-456"


@pytest.mark.integration
class TestRedisPubSub:
    """Test Redis Pub/Sub (for streaming events)."""

    def test_publish_subscribe(self, redis_client):
        """Test basic pub/sub."""
        import threading
        import time

        channel = "test_channel"
        received_messages = []

        def subscriber():
            pubsub = redis_client.pubsub()
            pubsub.subscribe(channel)

            for message in pubsub.listen():
                if message["type"] == "message":
                    received_messages.append(message["data"])
                    if len(received_messages) >= 2:
                        break

            pubsub.unsubscribe()
            pubsub.close()

        # Start subscriber in thread
        thread = threading.Thread(target=subscriber)
        thread.start()

        # Wait for subscription
        time.sleep(0.1)

        # Publish messages
        redis_client.publish(channel, "message1")
        redis_client.publish(channel, "message2")

        # Wait for thread
        thread.join(timeout=2.0)

        assert len(received_messages) == 2
        assert b"message1" in received_messages
        assert b"message2" in received_messages


@pytest.mark.integration
class TestRedisHash:
    """Test Redis hash operations (for job state)."""

    def test_hset_and_hget(self, redis_client):
        """Test hash operations."""
        key = "job:j-123"

        redis_client.hset(key, mapping={
            "status": "PROCESSING",
            "progress": "50",
            "worker_id": "worker-1",
        })

        status = redis_client.hget(key, "status")
        progress = redis_client.hget(key, "progress")

        assert status == b"PROCESSING"
        assert progress == b"50"

    def test_hgetall(self, redis_client):
        """Test getting all hash fields."""
        key = "job:j-456"

        redis_client.hset(key, mapping={
            "status": "COMPLETED",
            "result": "transcription text",
        })

        data = redis_client.hgetall(key)

        assert data[b"status"] == b"COMPLETED"
        assert data[b"result"] == b"transcription text"

    def test_hincrby(self, redis_client):
        """Test incrementing hash field."""
        key = "job:j-789"

        redis_client.hset(key, "progress", 0)
        redis_client.hincrby(key, "progress", 10)
        redis_client.hincrby(key, "progress", 20)

        progress = redis_client.hget(key, "progress")

        assert progress == b"30"
