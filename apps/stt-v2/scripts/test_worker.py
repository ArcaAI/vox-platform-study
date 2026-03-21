#!/usr/bin/env python3
"""
Direct test script for STT-v2 worker without using the API Gateway.

Usage:
    # List registered actors
    python scripts/test_worker.py --list

    # Test with a simple mock job (no real transcription)
    python scripts/test_worker.py --mock

    # Test with real audio file
    python scripts/test_worker.py --file /path/to/audio.wav --pipeline <pipeline-id>

Prerequisites:
    1. Worker must be running: stt-v2-worker
    2. Redis must be running
    3. For real tests: PostgreSQL with pipeline data, MinIO with audio file
"""

import argparse
import asyncio
import uuid
from pathlib import Path

# Use uuid7 package if available, otherwise fall back to uuid4
try:
    from uuid7 import uuid7
except ImportError:
    uuid7 = uuid.uuid4

# Configure broker FIRST (before importing actors)
from stt_v2.core.config.settings import get_settings
from stt_v2.core.messaging.broker import configure_broker

settings = get_settings()
broker = configure_broker(settings.redis_url)

# Now import actors
from stt_v2.transcription.workers import transcribe_file


def list_actors():
    """List all registered Dramatiq actors."""
    print("\n" + "=" * 60)
    print("📋 Registered Dramatiq Actors")
    print("=" * 60)

    for actor_name in broker.actors:
        actor = broker.actors[actor_name]
        print(f"\n  🎯 {actor_name}")
        print(f"     Queue: {actor.queue_name}")
        print(f"     Max Retries: {actor.options.get('max_retries', 'default')}")
        print(f"     Time Limit: {actor.options.get('time_limit', 'default')} ms")
        print(f"     Min Backoff: {actor.options.get('min_backoff', 'default')} ms")
        print(f"     Max Backoff: {actor.options.get('max_backoff', 'default')} ms")

    print("\n" + "=" * 60)


def test_mock_job():
    """Send a mock job to test worker connectivity."""
    print("\n" + "=" * 60)
    print("🧪 Testing Worker Connectivity (Mock Job)")
    print("=" * 60)

    job_id = str(uuid7())
    tenant_id = "50000000-0000-0000-0000-000000000000"

    print(f"\n📤 Sending mock batch transcription job...")
    print(f"   Job ID: {job_id}")
    print(f"   Tenant ID: {tenant_id}")
    print(f"   Pipeline ID: mock-pipeline-id")
    print(f"   Audio URI: mock://test/audio.wav")

    # Send the job - it will fail (no real data) but tests connectivity
    message = transcribe_file.send(
        job_id=job_id,
        tenant_id=tenant_id,
        pipeline_id="mock-pipeline-id",
        audio_uri="mock://test/audio.wav",
        consultation_id=None,
        media_id=None,
    )

    print(f"\n✅ Job enqueued successfully!")
    print(f"   Message ID: {message.message_id}")
    print(f"   Queue: {message.queue_name}")
    print(f"\n⚠️  Note: This job will FAIL because it uses mock data.")
    print(f"   Check the worker logs to see the failure message.")
    print(f"   This confirms the worker is receiving messages from Redis.")

    print("\n" + "=" * 60)


def test_real_file(audio_path: str, pipeline_id: str):
    """Test with a real audio file."""
    print("\n" + "=" * 60)
    print("🎤 Testing with Real Audio File")
    print("=" * 60)

    audio_file = Path(audio_path)
    if not audio_file.exists():
        print(f"\n❌ Error: Audio file not found: {audio_path}")
        return

    job_id = str(uuid7())
    tenant_id = "50000000-0000-0000-0000-000000000000"

    # For real test, audio must be in MinIO
    # This example assumes the file is already uploaded
    audio_uri = f"hope-audio/test/{audio_file.name}"

    print(f"\n📤 Sending real transcription job...")
    print(f"   Job ID: {job_id}")
    print(f"   Pipeline ID: {pipeline_id}")
    print(f"   Audio File: {audio_path}")
    print(f"   Audio URI: {audio_uri}")

    print(f"\n⚠️  Note: The audio file must be uploaded to MinIO at: {audio_uri}")
    print(f"   You can upload using MinIO Console or mc CLI:")
    print(f"   mc cp {audio_path} myminio/hope-audio/test/")

    # Uncomment to actually send the job:
    # message = transcribe_file.send(
    #     job_id=job_id,
    #     tenant_id=tenant_id,
    #     pipeline_id=pipeline_id,
    #     audio_uri=audio_uri,
    # )
    # print(f"\n✅ Job enqueued: {message.message_id}")

    print("\n" + "=" * 60)


async def check_pipeline_exists():
    """Check if any pipelines exist in the database."""
    from stt_v2.core.database.connection import get_session, initialize_database

    print("\n📊 Checking database for pipelines...")

    try:
        await initialize_database()

        from sqlalchemy import select, text
        from stt_v2.core.database.models import AsrPipelineRead

        async with get_session() as session:
            result = await session.execute(
                select(AsrPipelineRead).where(
                    AsrPipelineRead.resource_status == "ENABLED"
                ).limit(5)
            )
            pipelines = result.scalars().all()

            if pipelines:
                print(f"\n✅ Found {len(pipelines)} enabled pipeline(s):")
                for p in pipelines:
                    print(f"   - {p.slug} (ID: {p.id})")
            else:
                print("\n⚠️  No enabled pipelines found in database.")
                print("   You need to create a pipeline via the API Gateway first.")

    except Exception as e:
        print(f"\n❌ Database error: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="Test STT-v2 worker directly without API Gateway"
    )
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List registered Dramatiq actors"
    )
    parser.add_argument(
        "--mock", "-m",
        action="store_true",
        help="Send a mock job to test worker connectivity"
    )
    parser.add_argument(
        "--check-db",
        action="store_true",
        help="Check database for available pipelines"
    )
    parser.add_argument(
        "--file", "-f",
        type=str,
        help="Path to audio file for real transcription test"
    )
    parser.add_argument(
        "--pipeline", "-p",
        type=str,
        help="Pipeline ID to use for transcription"
    )

    args = parser.parse_args()

    if args.list:
        list_actors()
    elif args.mock:
        test_mock_job()
    elif args.check_db:
        asyncio.run(check_pipeline_exists())
    elif args.file and args.pipeline:
        test_real_file(args.file, args.pipeline)
    else:
        parser.print_help()
        print("\n" + "=" * 60)
        print("Quick Start:")
        print("  1. Start worker:  stt-v2-worker")
        print("  2. List actors:   python scripts/test_worker.py --list")
        print("  3. Test mock job: python scripts/test_worker.py --mock")
        print("  4. Check DB:      python scripts/test_worker.py --check-db")
        print("=" * 60)


if __name__ == "__main__":
    main()
