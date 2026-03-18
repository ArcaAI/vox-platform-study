"""Streaming Architecture Phase 1 — Foundation.

This module implements the foundational components for real-time streaming
transcription as designed in TASK-014. It provides:

- **ExecutionProfile**: Hardware auto-detection and adaptive tuning
- **StreamSession**: Redis-backed session state with two-tier persistence
- **SessionManager**: Session lifecycle, recovery, and background reaper
- **CapacityGuard**: Concurrent stream limiting based on hardware profile
- **Redis Streams**: IngestionConsumer, ResultPublisher, ControlListener
- **Schemas**: AudioFrame, SegmentResult, SessionControl data models
"""
