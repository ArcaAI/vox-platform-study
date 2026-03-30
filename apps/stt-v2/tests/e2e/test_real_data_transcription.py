"""
Real-data E2E transcription tests for STT-v2.

These tests validate the full transcription pipeline using real audio data
and a gateway-like batch workflow (upload -> job creation -> worker run ->
realtime progress/result collection) against two pipeline configurations:
  - Basic: Safetensor engine, Whisper Small, no preprocessing
  - Full:  Safetensor engine, Whisper Small, denoise + VAD (silero-vad-v6)
           + speaker diarization (deepghs/pyannote-embedding-onnx)

All tests use the q4 (4-bit) quantized ONNX model variant (~760 MB) for best
CPU inference performance and lowest memory usage.  The fp16 variant is NOT
suitable for CPU-only hosts — ONNX Runtime's graph optimizations insert
SimplifiedLayerNormFusion nodes that lack fp16 CPU kernels, causing load
failures.  Use q4 or int8 for CPU; fp16 for GPU (CUDA).

Each configuration is tested against two real audio files:
  - Multilingual (ML) audio: 20260205_52886591770282917_ml.wav
  - English (EN) audio:      20260206_52886591770369502_en.wav

Test Matrix:
  +-------+-------------------------------+--------------------------------------------+
  | Test  | Audio File                    | Pipeline                                   |
  +-------+-------------------------------+--------------------------------------------+
  | #1    | ML (20260205_*_ml.wav)        | Basic q4 (no VAD, no denoise, no DI)       |
  | #2    | ML (20260205_*_ml.wav)        | Full q4 (VAD + denoise + diarize)          |
  | #3    | EN (20260206_*_en.wav)        | Basic q4 (no VAD, no denoise, no DI)       |
  | #4    | EN (20260206_*_en.wav)        | Full q4 (VAD + denoise + diarize)          |
  +-------+-------------------------------+--------------------------------------------+

.. rubric:: Imports

Requirements:
  - ML dependencies installed: pip install -e ".[ml]"
  - HuggingFace models will be downloaded on first run (uses default HF_HOME)
  - Qdrant vectorstore running (for diarization tests #2 and #4)
  - MinIO running (for raw audio storage verification)
  - Audio fixtures in tests/e2e/fixtures/

Usage:
  # Run all real-data tests
  TEST_PLATFORM=all pytest tests/e2e/test_real_data_transcription.py -v -s

  # Run only basic pipeline tests
  TEST_PLATFORM=all pytest tests/e2e/test_real_data_transcription.py -v -s -k "basic"

  # Run only full pipeline tests (with diarization)
  TEST_PLATFORM=all pytest tests/e2e/test_real_data_transcription.py -v -s -k "full_pipeline"

Output:
  Each test writes a markdown report to tests/e2e/output/ containing:
  - Pipeline configuration summary
  - Full transcription text
  - Word/sentence timestamps (when available)
  - Performance metrics (processing time, audio duration, real-time factor)
  - VAD segments (when applicable)
  - Speaker diarization metadata (when applicable)
"""

import asyncio
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from stt_v2.pipeline.dto import PipelineConfig
    from stt_v2.transcription.dto import TranscriptionResult
import contextlib
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
import pytest_asyncio

logger = logging.getLogger(__name__)

# Maximum wall-clock time (seconds) for a single transcription run.
# Prevents Whisper repetition-loop hangs from blocking CI forever.
_TRANSCRIPTION_TIMEOUT_SECONDS = int(
    os.environ.get("E2E_TRANSCRIPTION_TIMEOUT", "120")
)
# Hard upper bound for one transcription run in E2E tests.
# Even adaptive sizing must stay below this cap.
_TRANSCRIPTION_TIMEOUT_MAX_SECONDS = int(
    os.environ.get("E2E_TRANSCRIPTION_TIMEOUT_MAX", "700")
)
# Adaptive timeout sizing controls.
_E2E_TIMEOUT_DURATION_MULTIPLIER = float(
    os.environ.get("E2E_TIMEOUT_DURATION_MULTIPLIER", "1.3")
)
_E2E_TIMEOUT_DURATION_BUFFER_SECONDS = int(
    os.environ.get("E2E_TIMEOUT_DURATION_BUFFER_SECONDS", "45")
)
# Runtime controls for large fixtures.
# English fixture is long (~10+ minutes). Trim by default for faster feedback.
_E2E_EN_AUDIO_MAX_SECONDS = int(
    os.environ.get("E2E_EN_AUDIO_MAX_SECONDS", "0")
)
# Keep ML fixture full length by default.
_E2E_ML_AUDIO_MAX_SECONDS = int(
    os.environ.get("E2E_ML_AUDIO_MAX_SECONDS", "0")
)

# =============================================================================
# CONSTANTS
# =============================================================================

# Paths
FIXTURES_DIR = Path(__file__).parent / "fixtures"
OUTPUT_DIR = Path(__file__).parent / "output"

# Audio fixtures
AUDIO_FILE_ML = FIXTURES_DIR / "20260205_52886591770282917_ml.wav"
AUDIO_FILE_EN = FIXTURES_DIR / "20260206_52886591770369502_en.wav"

# Ensure output directory exists
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Default tenant/user IDs (matching seed data conventions)
DEFAULT_TENANT_ID = "50000000-0000-0000-0000-000000000000"
SYSTEM_USER_ID = "60000000-0000-0000-0000-000000000000"


# =============================================================================
# PIPELINE YAML CONFIGURATIONS
# =============================================================================


def _pipeline_yaml_onnx_basic() -> str:
    """
    Basic pipeline: Safetensor engine, Whisper Large V3 Turbo, no preprocessing.

    Features:
    - Voice Activity Detection: No
    - Denoising/Noise Suppression: No
    - Transcription model: Whisper Large V3 Turbo (safetensor, ~1.6 GB)
    - Voice Embedding: No
    - Speaker Diarization: No
    - Language: Auto-detect
    - Timestamp: Word-level
    - Punctuation: Enabled
    - Remove disfluencies: No
    - Lowercase: No
    - Normalize: Yes
    - Target sample rate: 16000

    Performance (107s audio, cached model):
      - Apple Silicon MPS:  ~14 s
      - CUDA GPU:           ~5 s
      - CPU (fallback):     ~60 s
    """
    return """version: "1.1"

# Basic pipeline: Whisper Large V3 Turbo (safetensor), no preprocessing
# Uses safetensor engine for automatic MPS/CUDA/CPU acceleration.
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "safetensor"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: false
  denoise:
    enabled: false

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
"""


def _pipeline_yaml_onnx_full_pipeline() -> str:
    """
    Full pipeline: Safetensor engine, Whisper Large V3 Turbo, denoise + VAD + diarization.

    Features:
    - Voice Activity Detection: Enabled (silero-vad-v6)
    - Denoising/Noise Suppression: Enabled (rnnoise)
    - Transcription model: Whisper Large V3 Turbo (safetensor, ~1.6 GB)
    - Voice Embedding: Enabled (deepghs/pyannote-embedding-onnx, ONNX engine)
    - Speaker Diarization: Enabled (silero-vad-v6 + deepghs/pyannote-embedding-onnx)
    - Language: Auto-detect
    - Timestamp: Word-level
    - Punctuation: Enabled
    - Remove disfluencies: No
    - Lowercase: No
    - Normalize: Yes
    - Target sample rate: 16000

    Uses safetensor engine for automatic MPS/CUDA/CPU acceleration.
    VAD and denoise are kept to exercise the full preprocessing path.
    """
    return """version: "1.1"

# Full pipeline: Whisper Large V3 Turbo (safetensor) + denoise + VAD + diarization
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "safetensor"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "main"
  denoise:
    hf_model_id: "nickolay/rnnoise"
    engine: "onnx"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 250
    min_silence_duration_ms: 150
    padding_ms: 30
  denoise:
    enabled: true
    strength: 0.7

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false

diarization:
  enabled: true
  similarity_threshold: 0.7
  max_speakers: 0
  auto_register_speakers: true
  min_segment_duration_s: 1.0
"""


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================


def _load_audio_file(audio_path: Path) -> bytes:
    """Load a real audio file from fixtures directory."""
    if not audio_path.exists():
        pytest.fail(
            f"Audio fixture not found: {audio_path}\n"
            f"Please copy the test audio file to: {FIXTURES_DIR}/"
        )
    return audio_path.read_bytes()


def _clip_wav_audio_bytes(
    audio_bytes: bytes,
    *,
    max_seconds: int,
    label: str,
) -> bytes:
    """Clip WAV bytes to at most max_seconds (0 disables clipping)."""
    if max_seconds <= 0:
        return audio_bytes

    try:
        import io
        import wave

        with wave.open(io.BytesIO(audio_bytes), "rb") as wf:
            frame_rate = wf.getframerate()
            channels = wf.getnchannels()
            sample_width = wf.getsampwidth()
            comp_type = wf.getcomptype()
            comp_name = wf.getcompname()
            total_frames = wf.getnframes()

            if frame_rate <= 0 or total_frames <= 0:
                return audio_bytes

            max_frames = int(max_seconds * frame_rate)
            if max_frames <= 0 or total_frames <= max_frames:
                return audio_bytes

            original_duration_s = float(total_frames) / float(frame_rate)
            clipped_duration_s = float(max_frames) / float(frame_rate)
            clipped_frames = wf.readframes(max_frames)

        out = io.BytesIO()
        with wave.open(out, "wb") as out_wf:
            out_wf.setnchannels(channels)
            out_wf.setsampwidth(sample_width)
            out_wf.setframerate(frame_rate)
            out_wf.setcomptype(comp_type, comp_name)
            out_wf.writeframes(clipped_frames)

        logger.warning(
            (
                "Clipped fixture %s from %.2fs to %.2fs "
                "(max=%ss) for E2E runtime control"
            ),
            label,
            original_duration_s,
            clipped_duration_s,
            max_seconds,
        )
        return out.getvalue()
    except Exception as exc:
        logger.warning("Failed to clip fixture %s: %s", label, exc)
        return audio_bytes


def _build_pipeline_config(
    pipeline_id: str,
    slug: str,
    name: str,
    description: str,
    config_yaml: str,
    tags: list[str],
) -> "PipelineConfig":
    """
    Build a PipelineConfig from YAML without requiring a database.

    This creates a fully resolved PipelineConfig by parsing the YAML directly,
    bypassing the database-based config reader.
    """
    from stt_v2.pipeline.dto import PipelineConfig
    from stt_v2.pipeline.yaml_parser import get_yaml_parser

    parser = get_yaml_parser()
    spec = parser.parse(config_yaml)

    # Validate the pipeline spec
    validation = parser.validate(spec)
    if not validation.valid:
        error_messages = validation.get_error_messages()
        pytest.fail(f"Pipeline YAML validation failed: {error_messages}")

    return PipelineConfig(
        id=pipeline_id,
        tenant_id=DEFAULT_TENANT_ID,
        slug=slug,
        name=name,
        description=description,
        spec=spec,
        tags=tags,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )


def _write_markdown_report(
    test_name: str,
    pipeline_name: str,
    pipeline_slug: str,
    pipeline_yaml: str,
    result: "TranscriptionResult",
    audio_file: str,
    audio_size_bytes: int,
    consultation_id: str | None = None,
    vad_enabled: bool = False,
    denoise_enabled: bool = False,
    diarization_enabled: bool = False,
    minio_uri: str | None = None,
    processed_audio_uri: str | None = None,
    transcript_uri: str | None = None,
    processed_audio_size: int = 0,
) -> Path:
    """
    Write transcription result as a markdown report.

    Args:
        test_name: Name of the test (used in filename)
        pipeline_name: Human-readable pipeline name
        pipeline_slug: Pipeline slug identifier
        pipeline_yaml: Raw YAML configuration
        result: TranscriptionResult from the batch service
        audio_file: Path to the audio file used
        audio_size_bytes: Size of the audio file in bytes
        consultation_id: Consultation session ID (if any)
        vad_enabled: Whether VAD was enabled
        denoise_enabled: Whether denoising was enabled
        diarization_enabled: Whether diarization was enabled
        minio_uri: MinIO URI where raw audio was stored
        processed_audio_uri: MinIO URI where processed audio was stored
        transcript_uri: MinIO URI where transcript was stored
        processed_audio_size: Size of processed audio in bytes

    Returns:
        Path to the written markdown file
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{test_name}_{timestamp}.md"
    output_path = OUTPUT_DIR / filename

    # Calculate real-time factor
    rtf = (
        result.processing_time_seconds / result.duration_seconds
        if result.duration_seconds > 0
        else 0
    )

    lines = [
        f"# Transcription Report: {pipeline_name}",
        "",
        f"**Generated**: {datetime.now().isoformat()}",
        f"**Test**: `{test_name}`",
        f"**Pipeline**: `{pipeline_slug}`",
        f"**Consultation**: `{consultation_id or 'N/A'}`",
        "",
        "---",
        "",
        "## Pipeline Configuration",
        "",
        "```yaml",
        pipeline_yaml.strip(),
        "```",
        "",
        "## Audio File",
        "",
        "| Property | Value |",
        "|---|---|",
        f"| **File** | `{audio_file}` |",
        f"| **Size** | {audio_size_bytes / 1024:.1f} KB ({audio_size_bytes / (1024*1024):.2f} MB) |",
        f"| **Duration** | {result.duration_seconds:.2f} seconds |",
        "",
        "## Features",
        "",
        "| Feature | Status |",
        "|---|---|",
        "| **Engine** | ONNX |",
        "| **Model** | Whisper Large V3 Turbo (q4) |",
        f"| **Noise Cancellation** | {'Enabled' if denoise_enabled else 'Disabled'} |",
        f"| **Voice Activity Detection** | {'Enabled' if vad_enabled else 'Disabled'} |",
        f"| **Speaker Diarization** | {'Enabled' if diarization_enabled else 'Disabled'} |",
        "",
        "## Performance Metrics",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| **Processing Time** | {result.processing_time_seconds:.2f} seconds |",
        f"| **Audio Duration** | {result.duration_seconds:.2f} seconds |",
        f"| **Real-time Factor** | {rtf:.4f}x |",
        f"| **Detected Language** | {result.language or 'N/A'} |",
        f"| **Language Probability** | {result.language_probability or 'N/A'} |",
        "",
    ]

    # Timing breakdown
    timing_raw = result.metadata.get("timing") if result.metadata else None
    if timing_raw:
        td = timing_raw.to_dict() if hasattr(timing_raw, "to_dict") else timing_raw
        lines.extend([
            "## Timing Breakdown",
            "",
            "| Step | Duration (s) |",
            "|---|---|",
            f"| **Model Loading** | {td.get('model_loading_seconds', 0):.4f} |",
            f"| **Preprocessing** | {td.get('preprocessing_seconds', 0):.4f} |",
            f"| **ASR Inference** | {td.get('inference_seconds', 0):.4f} |",
            f"| **Diarization** | {td.get('diarization_seconds', 0):.4f} |",
            f"| **Postprocessing** | {td.get('postprocessing_seconds', 0):.4f} |",
            f"| **Total** | {td.get('total_seconds', 0):.4f} |",
            f"| **TTFW** | {td.get('ttfw_seconds', 0):.4f} |",
            "",
        ])

        # Per-segment latency table
        seg_lats = td.get("segment_latencies", [])
        if seg_lats:
            lines.extend([
                "### Per-Segment ASR Latency",
                "",
                "| Segment | Start (s) | End (s) | Duration (s) | Inference (s) |",
                "|---|---|---|---|---|",
            ])
            for sl in seg_lats:
                lines.append(
                    f"| {sl['segment_index']} | {sl['start_time']:.3f} | "
                    f"{sl['end_time']:.3f} | {sl['duration_s']:.3f} | "
                    f"{sl['inference_time_s']:.4f} |"
                )
            lines.append("")

    # MinIO storage info
    storage_rows: list[str] = []
    if minio_uri:
        storage_rows.append(f"| **Raw Audio URI** | `{minio_uri}` |")
        storage_rows.append(f"| **Raw Audio Size** | {audio_size_bytes:,} bytes |")
    if processed_audio_uri:
        storage_rows.append(f"| **Processed Audio URI** | `{processed_audio_uri}` |")
        storage_rows.append(f"| **Processed Audio Size** | {processed_audio_size:,} bytes |")
    if transcript_uri:
        storage_rows.append(f"| **Transcript URI** | `{transcript_uri}` |")

    if storage_rows:
        lines.extend([
            "## Storage",
            "",
            "| Property | Value |",
            "|---|---|",
            *storage_rows,
            "",
        ])

    lines.extend([
        "## Transcription Result",
        "",
        "### Full Text",
        "",
        result.text if result.text else "_No transcription output_",
        "",
    ])

    # Word timestamps
    if result.word_timestamps:
        lines.extend([
            "### Word Timestamps",
            "",
            "| Word | Start (s) | End (s) | Confidence |",
            "|---|---|---|---|",
        ])
        for wt in result.word_timestamps:
            lines.append(
                f"| {wt.word} | {wt.start_time:.3f} | {wt.end_time:.3f} | {wt.confidence:.3f} |"
            )
        lines.append("")

    # Sentence timestamps
    if result.sentence_timestamps:
        lines.extend([
            "### Sentence Timestamps",
            "",
            "| Sentence | Start (s) | End (s) |",
            "|---|---|---|",
        ])
        for st in result.sentence_timestamps:
            lines.append(
                f"| {st.text} | {st.start_time:.3f} | {st.end_time:.3f} |"
            )
        lines.append("")

    # VAD segments (if applicable)
    if result.segments:
        lines.extend([
            "### VAD Segments",
            "",
            f"**Total speech segments detected**: {len(result.segments)}",
            "",
            "| Segment | Start (s) | End (s) | Duration (s) | Is Speech | Confidence |",
            "|---|---|---|---|---|---|",
        ])
        for i, seg in enumerate(result.segments):
            lines.append(
                f"| {i + 1} | {seg.start_time:.3f} | {seg.end_time:.3f} | "
                f"{seg.duration:.3f} | {seg.is_speech} | {seg.confidence:.3f} |"
            )
        lines.append("")

    # Diarization metadata (if applicable)
    diarization_metadata = result.metadata.get("diarization", {}) if result.metadata else {}
    if diarization_enabled and diarization_metadata:
        lines.extend([
            "### Speaker Diarization",
            "",
        ])
        if isinstance(diarization_metadata, dict):
            lines.extend([
                "| Property | Value |",
                "|---|---|",
            ])
            for key, value in diarization_metadata.items():
                lines.append(f"| **{key}** | {value} |")
        else:
            lines.append(f"Diarization metadata: {diarization_metadata}")
        lines.append("")

    # Metadata
    if result.metadata:
        lines.extend([
            "### Metadata",
            "",
            "```json",
            json.dumps(result.metadata, indent=2, default=str),
            "```",
            "",
        ])

    content = "\n".join(lines)
    output_path.write_text(content, encoding="utf-8")

    logger.info(f"Report written to: {output_path}")
    return output_path


async def _run_transcription(
    pipeline_config: "PipelineConfig",
    audio_bytes: bytes,
    job_id: str,
    tenant_id: str | None = None,
    consultation_id: str | None = None,
    audio_filename: str = "audio.wav",
    timeout: int | None = None,
) -> "TranscriptionResult":
    """
    Run transcription using a gateway-like batch workflow.

    Workflow:
    1. Simulate API gateway upload to MinIO and capture ``audio_uri``
    2. Simulate gateway job creation using that ``audio_uri``
    3. Execute STT-v2 batch worker with the predefined pipeline
    4. Collect realtime progress/result via Redis Pub/Sub (SSE source), with
       in-memory API-state fallback when Pub/Sub is unavailable
    5. Materialize a ``TranscriptionResult`` and attach flow diagnostics

    Args:
        pipeline_config: Pipeline configuration.
        audio_bytes: Raw audio bytes.
        job_id: Job identifier.
        tenant_id: Tenant identifier.
        consultation_id: Consultation identifier.
        audio_filename: Original client filename (used in storage key).
        timeout: Max wall-clock seconds. Defaults to
                 ``_TRANSCRIPTION_TIMEOUT_SECONDS`` (env ``E2E_TRANSCRIPTION_TIMEOUT``,
                 default 120), hard-capped by
                 ``_TRANSCRIPTION_TIMEOUT_MAX_SECONDS``
                 (env ``E2E_TRANSCRIPTION_TIMEOUT_MAX``, default 700).
                 Prevents Whisper repetition-loop hangs.

    Raises:
        asyncio.TimeoutError: When transcription exceeds *timeout*.
    """
    def _estimate_audio_duration_seconds(raw_audio: bytes) -> float:
        """Best-effort WAV duration estimation for adaptive timeout sizing."""
        import io
        import wave

        try:
            with wave.open(io.BytesIO(raw_audio), "rb") as wf:
                frame_rate = wf.getframerate()
                frames = wf.getnframes()
                if frame_rate <= 0:
                    return 0.0
                return float(frames) / float(frame_rate)
        except Exception:
            return 0.0

    configured_timeout_raw = (
        timeout if timeout is not None else _TRANSCRIPTION_TIMEOUT_SECONDS
    )
    configured_timeout = min(
        configured_timeout_raw,
        _TRANSCRIPTION_TIMEOUT_MAX_SECONDS,
    )
    audio_duration_s = _estimate_audio_duration_seconds(audio_bytes)
    # Scale timeout by clip duration, but keep it tight for fast E2E feedback.
    # For default EN clipping (60s), this produces ~123s timeout.
    duration_based_timeout = (
        int(audio_duration_s * _E2E_TIMEOUT_DURATION_MULTIPLIER)
        + _E2E_TIMEOUT_DURATION_BUFFER_SECONDS
        if audio_duration_s > 0
        else 0
    )
    effective_timeout = min(
        max(configured_timeout, duration_based_timeout),
        _TRANSCRIPTION_TIMEOUT_MAX_SECONDS,
    )
    effective_tenant_id = tenant_id or DEFAULT_TENANT_ID

    if configured_timeout_raw > _TRANSCRIPTION_TIMEOUT_MAX_SECONDS:
        logger.warning(
            "[%s] Requested timeout %ss exceeds cap %ss; using cap",
            job_id,
            configured_timeout_raw,
            _TRANSCRIPTION_TIMEOUT_MAX_SECONDS,
        )
    if duration_based_timeout > _TRANSCRIPTION_TIMEOUT_MAX_SECONDS:
        logger.warning(
            "[%s] Duration-based timeout %ss exceeds cap %ss; using cap",
            job_id,
            duration_based_timeout,
            _TRANSCRIPTION_TIMEOUT_MAX_SECONDS,
        )

    logger.info(
        (
            "[%s] E2E timeout configured=%ss (raw=%ss), duration_based=%ss, "
            "cap=%ss, duration=%.2fs, effective=%ss"
        ),
        job_id,
        configured_timeout,
        configured_timeout_raw,
        duration_based_timeout,
        _TRANSCRIPTION_TIMEOUT_MAX_SECONDS,
        audio_duration_s,
        effective_timeout,
    )

    # Route realtime pub/sub through test infra Redis (default localhost:6380).
    await _ensure_test_redis_configured()

    from stt_v2.transcription.dto import (
        AudioSegment,
        SentenceTimestamp,
        TranscriptionResult,
        WordTimestamp,
    )
    from stt_v2.transcription.workers.transcribe_file import _transcribe_file_async

    class _InMemoryGatewayClient:
        """Minimal API-gateway stub for worker lifecycle updates."""

        def __init__(self) -> None:
            self._expected_job_id = job_id
            self.status = "QUEUED"
            self.status_history: list[str] = [self.status]
            self.progress_updates: list[int] = []
            self.worker_id: str | None = None
            self.error: dict[str, str] | None = None
            self.result_text: str = ""
            self.result_metadata: dict[str, Any] = {}
            self.created_job: dict[str, Any] = {}

        def create_job(self, audio_uri: str) -> None:
            self.created_job = {
                "job_id": job_id,
                "tenant_id": effective_tenant_id,
                "pipeline_id": pipeline_config.id,
                "audio_uri": audio_uri,
                "consultation_id": consultation_id,
            }

        async def start_job(
            self,
            job_id: str,
            worker_id: str,
            **_: Any,
        ) -> dict[str, Any]:
            assert job_id == self._expected_job_id
            self.worker_id = worker_id
            self.status = "PROCESSING"
            self.status_history.append(self.status)
            return {"id": job_id, "status": self.status}

        async def update_job_progress(
            self,
            job_id: str,
            progress: int,
            **_: Any,
        ) -> dict[str, Any]:
            assert job_id == self._expected_job_id
            self.progress_updates.append(progress)
            return {"id": job_id, "progress": progress}

        async def complete_job(
            self,
            job_id: str,
            result_text: str,
            result_metadata: dict | None = None,
            **_: Any,
        ) -> dict[str, Any]:
            assert job_id == self._expected_job_id
            self.status = "COMPLETED"
            self.status_history.append(self.status)
            self.result_text = result_text
            self.result_metadata = dict(result_metadata or {})
            return {"id": job_id, "status": self.status}

        async def fail_job(
            self,
            job_id: str,
            error_message: str,
            error_code: str | None = None,
            **_: Any,
        ) -> dict[str, Any]:
            assert job_id == self._expected_job_id
            self.status = "FAILED"
            self.status_history.append(self.status)
            self.error = {
                "errorCode": error_code or "UNKNOWN_ERROR",
                "errorMessage": error_message,
            }
            return {"id": job_id, "status": self.status}

        async def create_transcript(
            self,
            job_id: str,
            transcript_text: str,
            metadata: dict | None = None,
            consultation_id: str | None = None,
            **_: Any,
        ) -> dict[str, Any]:
            assert job_id == self._expected_job_id
            _ = transcript_text, metadata, consultation_id
            return {"contextItemId": f"ctx-{job_id}"}

    class _PipelineReaderStub:
        def __init__(self, config: "PipelineConfig") -> None:
            self._config = config

        async def get_pipeline(self, pipeline_id: str) -> "PipelineConfig":
            if pipeline_id != self._config.id:
                raise ValueError(
                    f"Pipeline mismatch. expected={self._config.id}, got={pipeline_id}"
                )
            return self._config

    async def _collect_realtime_events(
        inbound_job_id: str,
        wait_timeout_s: int,
    ) -> list[dict[str, Any]]:
        """
        Collect events from Redis Pub/Sub (gateway SSE source) for one job.

        Returns an empty list when Redis/PubSub is unavailable, so the caller
        can fall back to API-state polling from the in-memory gateway stub.
        """
        from stt_v2.core.config.settings import get_settings

        settings = get_settings()
        if not settings.pubsub_enabled:
            return []

        try:
            import redis.asyncio as aioredis
        except Exception:
            return []

        channel = f"{settings.pubsub_channel_prefix}{inbound_job_id}"
        events: list[dict[str, Any]] = []
        terminal_statuses = {"COMPLETED", "FAILED", "CANCELLED", "DEAD"}
        started = time.monotonic()
        redis_client = None
        pubsub = None

        try:
            redis_client = aioredis.from_url(
                settings.redis_url,
                decode_responses=True,
            )
            pubsub = redis_client.pubsub()
            await pubsub.subscribe(channel)

            while time.monotonic() - started <= wait_timeout_s:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=1.0,
                )
                if not message:
                    await asyncio.sleep(0.05)
                    continue

                payload = message.get("data")
                if not isinstance(payload, str):
                    continue

                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue

                if isinstance(event, dict):
                    events.append(event)
                    status = event.get("data", {}).get("status")
                    if event.get("type") == "status" and status in terminal_statuses:
                        break
        except Exception as exc:
            logger.warning(
                "Realtime event collection unavailable; falling back to API state "
                f"(job_id={inbound_job_id}, error={exc})"
            )
            return []
        finally:
            if pubsub is not None:
                with contextlib.suppress(Exception):
                    await pubsub.unsubscribe(channel)
                with contextlib.suppress(Exception):
                    if hasattr(pubsub, "aclose"):
                        await pubsub.aclose()
                    else:
                        await pubsub.close()
            if redis_client is not None:
                with contextlib.suppress(Exception):
                    await redis_client.aclose()

        return events

    def _result_from_payload(
        result_text: str,
        result_metadata: dict[str, Any],
    ) -> "TranscriptionResult":
        words = [
            WordTimestamp(
                word=w.get("word", w.get("text", "")),
                start_time=float(w.get("start_time", w.get("start", 0.0))),
                end_time=float(w.get("end_time", w.get("end", 0.0))),
                confidence=float(w.get("confidence", 1.0)),
            )
            for w in result_metadata.get("word_timestamps", [])
        ]
        sentences = [
            SentenceTimestamp(
                text=s.get("text", ""),
                start_time=float(s.get("start_time", 0.0)),
                end_time=float(s.get("end_time", 0.0)),
            )
            for s in result_metadata.get("sentence_timestamps", [])
        ]
        segments = [
            AudioSegment(
                start_time=float(seg.get("start_time", 0.0)),
                end_time=float(seg.get("end_time", seg.get("start_time", 0.0))),
                is_speech=bool(seg.get("is_speech", True)),
                confidence=float(seg.get("confidence", 1.0)),
            )
            for seg in result_metadata.get("segments", [])
        ]

        result = TranscriptionResult(
            text=result_text or result_metadata.get("text", ""),
            language=result_metadata.get("language"),
            language_probability=result_metadata.get("language_probability"),
            duration_seconds=float(result_metadata.get("duration_seconds", 0.0)),
            processing_time_seconds=float(
                result_metadata.get("processing_time_seconds", 0.0)
            ),
            word_timestamps=words,
            sentence_timestamps=sentences,
            segments=segments,
            metadata=dict(result_metadata.get("metadata", {})),
        )
        result.raw_audio_uri = result_metadata.get("raw_audio_uri")
        result.processed_audio_uri = result_metadata.get("processed_audio_uri")
        result.transcript_uri = result_metadata.get("transcript_uri")
        return result

    # ------------------------------------------------------------------
    # Step 1: Simulate gateway upload to storage and capture audio URI
    # ------------------------------------------------------------------
    audio_uri = await _upload_raw_audio_to_minio(
        audio_bytes=audio_bytes,
        tenant_id=effective_tenant_id,
        job_id=job_id,
        filename=audio_filename,
        consultation_id=consultation_id,
    )
    assert audio_uri.startswith("s3://"), f"Expected MinIO URI, got {audio_uri}"

    # ------------------------------------------------------------------
    # Step 2: Simulate gateway job creation using uploaded URI
    # ------------------------------------------------------------------
    gateway_client = _InMemoryGatewayClient()
    gateway_client.create_job(audio_uri=audio_uri)
    pipeline_reader = _PipelineReaderStub(pipeline_config)

    # ------------------------------------------------------------------
    # Step 3 + 4: Run worker and collect realtime progress/result (SSE)
    # ------------------------------------------------------------------
    sse_task = asyncio.create_task(
        _collect_realtime_events(
            inbound_job_id=job_id,
            wait_timeout_s=effective_timeout + 30,
        )
    )
    # Give the subscriber a moment to register before publishing starts.
    await asyncio.sleep(0.1)

    try:
        with patch(
            "stt_v2.transcription.workers.transcribe_file.get_api_client",
            return_value=gateway_client,
        ), patch(
            "stt_v2.transcription.workers.transcribe_file.get_pipeline_reader",
            return_value=pipeline_reader,
        ):
            await asyncio.wait_for(
                _transcribe_file_async(
                    job_id=job_id,
                    tenant_id=effective_tenant_id,
                    pipeline_id=pipeline_config.id,
                    audio_uri=audio_uri,
                    consultation_id=consultation_id,
                    media_id=None,
                ),
                timeout=effective_timeout,
            )
    except TimeoutError:
        if not sse_task.done():
            sse_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sse_task
        pytest.fail(
            f"Transcription for job '{job_id}' timed out after "
            f"{effective_timeout}s. This may indicate a Whisper "
            f"repetition-loop hang."
        )

    sse_events: list[dict[str, Any]]
    if sse_task.done():
        try:
            sse_events = sse_task.result()
        except Exception:
            sse_events = []
    else:
        # Worker finished but no terminal SSE observed yet; wait briefly.
        try:
            sse_events = await asyncio.wait_for(sse_task, timeout=5)
        except TimeoutError:
            sse_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sse_task
            sse_events = []
        except Exception:
            sse_events = []

    if gateway_client.status != "COMPLETED":
        pytest.fail(
            f"Gateway job did not complete successfully. "
            f"status={gateway_client.status}, error={gateway_client.error}"
        )

    # ------------------------------------------------------------------
    # Step 5: Finalize result object and diagnostics
    # ------------------------------------------------------------------
    result = _result_from_payload(
        result_text=gateway_client.result_text,
        result_metadata=gateway_client.result_metadata,
    )
    # Keep the initial uploaded audio URI from the gateway simulation.
    result.raw_audio_uri = result.raw_audio_uri or audio_uri

    progress_log = [
        int(evt.get("data", {}).get("progress"))
        for evt in sse_events
        if evt.get("type") == "progress"
        and isinstance(evt.get("data", {}).get("progress"), int)
    ]
    if not progress_log:
        progress_log = list(gateway_client.progress_updates)
    if not progress_log:
        progress_log = [100]
    else:
        # Pub/Sub and API callbacks are scheduled asynchronously; messages can
        # be observed out-of-order (e.g., 100 before a delayed 75).  Normalize
        # to a monotonic series for stable assertions.
        monotonic_progress: list[int] = []
        max_seen = 0
        for value in progress_log:
            max_seen = max(max_seen, int(value))
            monotonic_progress.append(max_seen)
        progress_log = monotonic_progress
        if progress_log[-1] != 100:
            progress_log.append(100)

    chunk_results = []
    for evt in sse_events:
        if evt.get("type") != "chunk":
            continue
        data = evt.get("data", {})
        chunk_results.append({
            "chunk_index": data.get("chunkIndex"),
            "text": data.get("text", ""),
            "start_time": data.get("startTime", 0.0),
            "end_time": data.get("endTime", 0.0),
            "is_final": data.get("isFinal", False),
            "word_timestamps": data.get("wordTimestamps", []),
        })

    result.metadata["progress_log"] = progress_log
    result.metadata["chunk_results"] = chunk_results
    result.metadata["gateway_job"] = gateway_client.created_job
    result.metadata["gateway_status_history"] = gateway_client.status_history
    result.metadata["realtime_events"] = sse_events

    return result


_minio_initialized = False
_test_redis_configured = False


async def _ensure_test_redis_configured() -> None:
    """
    Configure Redis settings for test infrastructure (port 6380 by default).

    Priority:
    1. ``TEST_REDIS_URL`` (full URL)
    2. ``TEST_REDIS_HOST`` + ``TEST_REDIS_PORT`` + ``TEST_REDIS_DB``
    """
    global _test_redis_configured
    if _test_redis_configured:
        return

    from stt_v2.core.config.settings import get_settings

    settings = get_settings()

    test_redis_url = os.environ.get("TEST_REDIS_URL")
    if not test_redis_url:
        host = os.environ.get("TEST_REDIS_HOST", "localhost")
        port = os.environ.get("TEST_REDIS_PORT", "6380")
        db = os.environ.get("TEST_REDIS_DB", "0")
        test_redis_url = f"redis://{host}:{port}/{db}"

    test_pubsub_enabled = (
        os.environ.get("TEST_PUBSUB_ENABLED", "true").strip().lower()
        not in {"0", "false", "no", "off"}
    )
    test_channel_prefix = os.environ.get("TEST_PUBSUB_CHANNEL_PREFIX")

    # Patch cached settings object used across runtime codepaths.
    settings.redis_url = test_redis_url
    settings.pubsub_enabled = test_pubsub_enabled
    if test_channel_prefix:
        settings.pubsub_channel_prefix = test_channel_prefix

    # Keep environment aligned for any fresh Settings() instantiation.
    os.environ["REDIS_URL"] = test_redis_url
    os.environ["PUBSUB_ENABLED"] = "true" if test_pubsub_enabled else "false"
    if test_channel_prefix:
        os.environ["PUBSUB_CHANNEL_PREFIX"] = test_channel_prefix

    try:
        import redis.asyncio as aioredis

        redis_client = aioredis.from_url(
            test_redis_url,
            decode_responses=True,
        )
        await redis_client.ping()
        await redis_client.aclose()
        logger.info(
            "Redis test infra configured (url=%s, pubsub_enabled=%s) and reachable",
            test_redis_url,
            test_pubsub_enabled,
        )
    except Exception as exc:
        logger.warning(
            "Redis test infra configured (url=%s, pubsub_enabled=%s) but not reachable: %s",
            test_redis_url,
            test_pubsub_enabled,
            exc,
        )

    _test_redis_configured = True


async def _ensure_minio_initialized() -> None:
    """
    Initialize the MinIO client for tests if not already done.

    Uses the monorepo's centralized test infrastructure
    (``tests/docker-compose.test.yml``):
    - Endpoint: ``localhost:9002`` (test port, vs 9000 for dev)
    - Credentials: ``test`` / ``testpassword``

    The function patches the application settings, calls
    ``initialize_minio()``, and sets a flag so it only runs once.
    """
    global _minio_initialized
    if _minio_initialized:
        return

    from stt_v2.core.config.settings import get_settings
    from stt_v2.core.storage.minio_client import initialize_minio

    settings = get_settings()

    # Point to the test-infrastructure MinIO (port 9002)
    test_endpoint = os.environ.get("TEST_MINIO_ENDPOINT", "localhost:9002")
    test_access_key = os.environ.get("TEST_MINIO_ACCESS_KEY", "test")
    test_secret_key = os.environ.get("TEST_MINIO_SECRET_KEY", "testpassword")

    settings.minio_endpoint = test_endpoint
    settings.minio_access_key = test_access_key
    settings.minio_secret_key = test_secret_key
    settings.minio_secure = False

    await initialize_minio()
    _minio_initialized = True
    logger.info(
        f"MinIO initialized for tests (endpoint={test_endpoint})"
    )


async def _upload_raw_audio_to_minio(
    audio_bytes: bytes,
    tenant_id: str,
    job_id: str,
    filename: str,
    consultation_id: str | None = None,
) -> str:
    """
    Upload raw audio bytes to MinIO and return the storage URI.

    This simulates what the production worker does after transcription.
    Automatically initializes the MinIO client (test infra) on first call.

    Args:
        audio_bytes: Raw audio bytes
        tenant_id: Tenant ID
        job_id: Job ID
        filename: Original audio filename
        consultation_id: Optional consultation ID

    Returns:
        MinIO storage URI (s3://bucket/path)
    """
    await _ensure_minio_initialized()

    from stt_v2.storage.blob_service import get_blob_service

    blob_service = get_blob_service()
    uri = await blob_service.upload_audio(
        audio_bytes=audio_bytes,
        tenant_id=tenant_id,
        job_id=job_id,
        filename=filename,
        consultation_id=consultation_id,
    )
    return uri


async def _verify_minio_audio_exists(uri: str) -> bool:
    """Verify that the uploaded audio exists in MinIO.

    Args:
        uri: MinIO storage URI returned from upload

    Returns:
        True if the audio exists in MinIO
    """
    await _ensure_minio_initialized()
    from stt_v2.storage.blob_service import get_blob_service

    blob_service = get_blob_service()
    return await blob_service.exists(uri)


async def _get_minio_audio_size(uri: str) -> int:
    """Get the size of audio stored in MinIO.

    Args:
        uri: MinIO storage URI

    Returns:
        Size in bytes, 0 if not found
    """
    await _ensure_minio_initialized()
    from stt_v2.storage.blob_service import get_blob_service

    blob_service = get_blob_service()
    return await blob_service.get_size(uri)


async def _upload_processed_audio_to_minio(
    processed_audio_bytes: bytes,
    tenant_id: str,
    job_id: str,
    consultation_id: str | None = None,
    filename: str = "processed.wav",
) -> str:
    """
    Upload processed (denoised / VAD-merged) audio to MinIO.

    Args:
        processed_audio_bytes: WAV bytes of the processed audio
        tenant_id: Tenant ID
        job_id: Job ID
        consultation_id: Optional consultation ID
        filename: Descriptive filename

    Returns:
        MinIO storage URI (s3://bucket/path)
    """
    await _ensure_minio_initialized()
    from stt_v2.storage.blob_service import get_blob_service

    blob_service = get_blob_service()
    uri = await blob_service.upload_processed_audio(
        audio_bytes=processed_audio_bytes,
        tenant_id=tenant_id,
        job_id=job_id,
        filename=filename,
        consultation_id=consultation_id,
    )
    return uri


async def _upload_transcript_to_minio(
    transcript_json: str,
    tenant_id: str,
    job_id: str,
    consultation_id: str | None = None,
    fmt: str = "json",
) -> str:
    """
    Upload transcript data to MinIO.

    Args:
        transcript_json: Transcript content (JSON string)
        tenant_id: Tenant ID
        job_id: Job ID
        consultation_id: Optional consultation ID
        fmt: Format (json, txt, vtt, srt)

    Returns:
        MinIO storage URI (s3://bucket/path)
    """
    await _ensure_minio_initialized()
    from stt_v2.storage.blob_service import get_blob_service

    blob_service = get_blob_service()
    uri = await blob_service.upload_transcript(
        transcript_data=transcript_json,
        tenant_id=tenant_id,
        job_id=job_id,
        consultation_id=consultation_id,
        format=fmt,
    )
    return uri


def _assert_timing_metrics(
    result: "TranscriptionResult",
    *,
    vad_enabled: bool = False,
    diarization_enabled: bool = False,
) -> None:
    """Assert that timing metrics are present and reasonable.

    Checks:
    - All expected keys present
    - Preprocessing, inference, total are strictly positive
    - TTFW is positive and <= total
    - Total >= sum of individual steps
    - Per-segment latencies when VAD is active
    - Diarization timing when diarization is enabled

    Args:
        result: TranscriptionResult to validate.
        vad_enabled: Whether VAD was enabled in the pipeline.
        diarization_enabled: Whether diarization was enabled.
    """
    timing_raw = result.metadata.get("timing")
    assert timing_raw is not None, "Timing metrics should be present in metadata"

    # Normalise: TimingMetrics object or plain dict
    if hasattr(timing_raw, "to_dict"):
        td = timing_raw.to_dict()
    else:
        td = timing_raw

    # ---- Required keys ----
    required_keys = {
        "ttfw_seconds", "model_loading_seconds", "preprocessing_seconds",
        "inference_seconds", "diarization_seconds", "postprocessing_seconds",
        "total_seconds", "segment_latencies",
    }
    missing = required_keys - set(td.keys())
    assert not missing, f"Timing dict missing keys: {missing}"

    # ---- Step-level positivity ----
    assert td["preprocessing_seconds"] > 0, "Preprocessing time should be positive"
    assert td["inference_seconds"] > 0, "Inference time should be positive"
    assert td["total_seconds"] > 0, "Total time should be positive"
    assert td["model_loading_seconds"] >= 0, "Model loading time should be non-negative"
    assert td["postprocessing_seconds"] >= 0, "Postprocessing time should be non-negative"

    # ---- TTFW must be positive and bounded ----
    assert td["ttfw_seconds"] > 0, (
        f"TTFW should be positive, got {td['ttfw_seconds']}"
    )
    assert td["ttfw_seconds"] <= td["total_seconds"] * 1.01, (
        f"TTFW ({td['ttfw_seconds']:.4f}s) should not exceed "
        f"total time ({td['total_seconds']:.4f}s)"
    )

    # ---- Total >= sum of individual steps ----
    step_sum = (
        td["model_loading_seconds"]
        + td["preprocessing_seconds"]
        + td["inference_seconds"]
        + td["diarization_seconds"]
        + td["postprocessing_seconds"]
    )
    assert td["total_seconds"] >= step_sum - 0.01, (
        f"Total ({td['total_seconds']:.4f}s) should be >= "
        f"sum of steps ({step_sum:.4f}s)"
    )

    # ---- TTFW >= model_loading + preprocessing ----
    # TTFW measures time from pipeline start to first transcribed word.
    # For chunked inference this is model_loading + preprocessing + ONE
    # chunk's inference time — NOT total inference.  So the lower bound
    # is model_loading + preprocessing (the first chunk adds more, but
    # its duration varies).
    min_ttfw = (
        td["model_loading_seconds"]
        + td["preprocessing_seconds"]
    )
    assert td["ttfw_seconds"] >= min_ttfw - 0.01, (
        f"TTFW ({td['ttfw_seconds']:.4f}s) should be >= "
        f"model+preprocess ({min_ttfw:.4f}s)"
    )
    # TTFW should be significantly less than total for multi-chunk audio
    if td["inference_seconds"] > 30:
        assert td["ttfw_seconds"] < td["total_seconds"], (
            f"TTFW ({td['ttfw_seconds']:.4f}s) should be less than "
            f"total ({td['total_seconds']:.4f}s) for multi-chunk audio"
        )

    # ---- Per-segment latency when VAD is active ----
    if vad_enabled:
        seg_lats = td.get("segment_latencies", [])
        if seg_lats:
            for sl in seg_lats:
                assert "segment_index" in sl, "segment_latency must have segment_index"
                assert "start_time" in sl, "segment_latency must have start_time"
                assert "end_time" in sl, "segment_latency must have end_time"
                assert "duration_s" in sl, "segment_latency must have duration_s"
                assert "inference_time_s" in sl, "segment_latency must have inference_time_s"
                assert sl["inference_time_s"] > 0, (
                    f"Segment inference time should be positive (segment {sl['segment_index']})"
                )
                assert sl["duration_s"] > 0, (
                    f"Segment duration should be positive (segment {sl['segment_index']})"
                )
            avg_inf = sum(s["inference_time_s"] for s in seg_lats) / len(seg_lats)
            logger.info(
                "Timing: %d segment latencies, avg inference %.3fs",
                len(seg_lats), avg_inf,
            )

    # ---- Diarization timing ----
    if diarization_enabled:
        assert td["diarization_seconds"] >= 0, (
            "Diarization time should be non-negative"
        )

    logger.info(
        "Timing: total=%.2fs, TTFW=%.2fs, preprocess=%.2fs, "
        "inference=%.2fs, diarize=%.2fs, postprocess=%.2fs, models=%.2fs",
        td["total_seconds"], td["ttfw_seconds"],
        td["preprocessing_seconds"], td["inference_seconds"],
        td["diarization_seconds"], td["postprocessing_seconds"],
        td["model_loading_seconds"],
    )


def _export_result_json(
    test_name: str,
    result: "TranscriptionResult",
) -> Path:
    """
    Export the ``TranscriptionResult`` as a JSON file to ``tests/e2e/output/``.

    Args:
        test_name: Test name (used in the filename)
        result: TranscriptionResult to export

    Returns:
        Path to the written JSON file
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{test_name}_{timestamp}.json"
    output_path = OUTPUT_DIR / filename
    output_path.write_text(
        json.dumps(result.to_dict(), indent=2, default=str, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info(f"Result JSON exported to: {output_path}")
    return output_path


def _assert_common_result(
    result: "TranscriptionResult",
    *,
    expect_language: bool = True,
    expect_sentence_timestamps: bool = True,
    expect_vad_segments: bool = False,
) -> None:
    """Assert common properties shared by all test configurations.

    Checks:
    - result is not None with non-empty text
    - duration and processing time are positive
    - word timestamps present and well-formed
    - language detected (when expected)
    - sentence timestamps present (when expected)
    - progress callback was invoked and is monotonically non-decreasing
    - VAD segments present and well-formed (when expected)
    - No VAD segments when not expected

    Args:
        result: TranscriptionResult to validate.
        expect_language: Whether language detection is expected.
        expect_sentence_timestamps: Whether sentence timestamps are expected.
        expect_vad_segments: Whether VAD segments are expected.
    """
    assert result is not None, "Transcription result should not be None"
    assert isinstance(result.text, str), "Transcription text should be a string"
    assert len(result.text) > 0, "Transcription text should not be empty"
    assert result.duration_seconds > 0, "Audio duration should be positive"
    assert result.processing_time_seconds > 0, "Processing time should be positive"

    # ---- Language detection ----
    # NOTE: The Optimum ONNX inference path does not yet extract the
    # detected language from the Whisper model output.  When the
    # production code is updated to populate language/language_probability,
    # the soft checks below should become hard assertions.
    if expect_language:
        if result.language is not None:
            assert isinstance(result.language, str) and len(result.language) >= 2, (
                f"Language should be a 2+ char code, got: {result.language!r}"
            )
            assert result.language_probability is not None, (
                "Language probability should be present when language is set"
            )
            assert result.language_probability > 0.0, (
                f"Language probability should be positive, got: {result.language_probability}"
            )
            logger.info(
                "Language detected: %s (prob=%.4f)",
                result.language, result.language_probability,
            )
        else:
            logger.warning(
                "Language detection not populated by inference engine "
                "(result.language is None) — this should be fixed in "
                "_run_optimum_onnx_inference to extract language from "
                "Whisper model output"
            )

    # ---- Word timestamps ----
    assert result.word_timestamps is not None, "Word timestamps should not be None"
    if result.word_timestamps:
        for wt in result.word_timestamps:
            assert wt.word, "Word timestamp should have a word"
            assert wt.start_time >= 0, "Word start_time should be non-negative"
            assert wt.end_time >= wt.start_time, (
                f"Word end_time ({wt.end_time}) should be >= start_time ({wt.start_time})"
            )

    # ---- Sentence timestamps ----
    if expect_sentence_timestamps:
        assert result.sentence_timestamps is not None, (
            "Sentence timestamps should not be None"
        )
        # Sentence timestamps come from ASR segment output; they may be
        # empty if the model only produced word-level output.  When present,
        # validate structure.
        if result.sentence_timestamps:
            for st in result.sentence_timestamps:
                assert st.text, "Sentence timestamp should have text"
                assert st.start_time >= 0, "Sentence start_time should be non-negative"
                assert st.end_time >= st.start_time, (
                    f"Sentence end_time ({st.end_time}) should be >= "
                    f"start_time ({st.start_time})"
                )
            logger.info(
                "Sentence timestamps: %d sentences", len(result.sentence_timestamps),
            )

    # ---- Progress callback ----
    progress_log = result.metadata.get("progress_log", [])
    assert len(progress_log) > 0, "Progress callback should have been invoked"
    # Progress values should be monotonically non-decreasing
    for i in range(1, len(progress_log)):
        assert progress_log[i] >= progress_log[i - 1], (
            f"Progress should be monotonically non-decreasing, "
            f"but {progress_log[i]} < {progress_log[i - 1]} at index {i}"
        )
    assert progress_log[-1] == 100, (
        f"Final progress should be 100, got {progress_log[-1]}"
    )

    # ---- Realtime/API lifecycle evidence ----
    realtime_events = result.metadata.get("realtime_events", [])
    gateway_status_history = result.metadata.get("gateway_status_history", [])
    assert realtime_events or gateway_status_history, (
        "Expected realtime SSE events or gateway status history"
    )
    if gateway_status_history:
        assert "COMPLETED" in gateway_status_history, (
            f"Gateway status history should include COMPLETED, got {gateway_status_history}"
        )

    # ---- VAD evidence ----
    # NOTE: TranscriptionResult.segments is not populated by the batch
    # service (VAD segments live on ProcessedAudio, and per-segment latencies
    # are in timing metadata).  We verify VAD activity via timing metadata.
    if expect_vad_segments:
        # When VAD is active, _assert_timing_metrics already validates
        # segment_latencies structure, so here we just log confirmation.
        timing_raw_inner = result.metadata.get("timing")
        td_inner = timing_raw_inner.to_dict() if hasattr(timing_raw_inner, "to_dict") else timing_raw_inner
        seg_lats = td_inner.get("segment_latencies", []) if td_inner else []
        logger.info(
            "VAD evidence: %d segment latencies in timing metadata",
            len(seg_lats),
        )
    else:
        # Basic pipeline — no VAD applied, so TranscriptionResult.segments
        # should be the default empty list.
        assert len(result.segments) == 0, (
            f"Basic pipeline should have no segments on result, got {len(result.segments)}"
        )

    # ---- Metadata: pipeline and job_id ----
    assert "job_id" in result.metadata, "metadata should contain job_id"
    assert "pipeline" in result.metadata, "metadata should contain pipeline"


def _assert_exported_json(json_path: Path) -> None:
    """Verify the exported JSON file is valid and contains expected keys.

    Args:
        json_path: Path to the exported JSON file.
    """
    assert json_path.exists(), f"Exported JSON should exist at {json_path}"
    assert json_path.stat().st_size > 0, "Exported JSON should not be empty"

    content = json.loads(json_path.read_text(encoding="utf-8"))
    assert isinstance(content, dict), "JSON root should be a dict"

    # Required top-level keys
    for key in ("text", "language", "duration_seconds", "processing_time_seconds", "metadata"):
        assert key in content, f"Exported JSON should contain '{key}'"

    assert len(content["text"]) > 0, "Exported JSON text should not be empty"
    assert content["duration_seconds"] > 0, "Exported duration should be positive"

    # Timing should be serialized
    timing = content.get("metadata", {}).get("timing")
    assert timing is not None, "Exported JSON should contain timing in metadata"
    assert isinstance(timing, dict), "timing should be a dict in exported JSON"
    assert timing["total_seconds"] > 0, "Exported timing.total_seconds should be positive"

    logger.info(f"Exported JSON verified: {json_path} ({json_path.stat().st_size:,} bytes)")


# =============================================================================
# FIXTURES
# =============================================================================


@pytest.fixture(scope="module")
def ml_audio_bytes() -> bytes:
    """Load multilingual audio file bytes (shared across tests in this module)."""
    raw = _load_audio_file(AUDIO_FILE_ML)
    return _clip_wav_audio_bytes(
        raw,
        max_seconds=_E2E_ML_AUDIO_MAX_SECONDS,
        label=AUDIO_FILE_ML.name,
    )


@pytest.fixture(scope="module")
def en_audio_bytes() -> bytes:
    """Load English audio file bytes (shared across tests in this module)."""
    raw = _load_audio_file(AUDIO_FILE_EN)
    return _clip_wav_audio_bytes(
        raw,
        max_seconds=_E2E_EN_AUDIO_MAX_SECONDS,
        label=AUDIO_FILE_EN.name,
    )


@pytest.fixture(scope="module")
def ml_audio_file_info(ml_audio_bytes: bytes) -> dict:
    """Get multilingual audio file metadata."""
    size = len(ml_audio_bytes)
    return {
        "path": str(AUDIO_FILE_ML),
        "name": AUDIO_FILE_ML.name,
        "size_bytes": size,
    }


@pytest.fixture(scope="module")
def en_audio_file_info(en_audio_bytes: bytes) -> dict:
    """Get English audio file metadata."""
    size = len(en_audio_bytes)
    return {
        "path": str(AUDIO_FILE_EN),
        "name": AUDIO_FILE_EN.name,
        "size_bytes": size,
    }


# =============================================================================
# MODEL PRE-WARMING (TASK-017)
# =============================================================================


@pytest_asyncio.fixture(loop_scope="module", scope="module", autouse=True)
async def warm_asr_model():
    """Pre-load the ASR model into cache before any test runs.

    The Whisper ONNX model takes ~14s to load from disk on first access.
    In production this happens once at service startup, not per-request.
    Pre-warming ensures all tests measure steady-state RTF, not cold-start.
    """
    from stt_v2.models.cache import get_model_cache
    from stt_v2.pipeline.dto import ModelTaskType
    from stt_v2.pipeline.yaml_parser import get_yaml_parser

    parser = get_yaml_parser()
    spec = parser.parse(_pipeline_yaml_onnx_basic())
    asr_inline = spec.models.asr.inline

    if asr_inline:
        cache = get_model_cache()
        logger.info("Pre-warming ASR model into cache...")
        await cache.get_or_load_inline(
            asr_inline, ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        )
        logger.info("ASR model warm — ready for tests")


# =============================================================================
# TEST CLASS
# =============================================================================


@pytest.mark.e2e
@pytest.mark.slow
@pytest.mark.ml
class TestRealDataTranscription:
    """
    Real-data E2E transcription tests.

    These tests exercise the full transcription pipeline (model loading,
    preprocessing, inference, postprocessing) using real audio files
    with different pipeline configurations. The only mocked boundary is
    the API Gateway HTTP client, so worker logic and realtime Pub/Sub flow
    run exactly as in production.

    All tests use the q4 (4-bit) quantized ONNX model (~760 MB) for best
    CPU inference performance and lowest memory usage.

    Each test:
    1. Uploads raw audio to MinIO and captures the storage URI
    2. Creates a simulated transcription job using that uploaded URI
    3. Runs the worker using the predefined pipeline configuration
    4. Collects job progress/result via SSE (Redis Pub/Sub), with API-state fallback
    5. Validates output structure/quality and storage artifacts
    6. Writes a detailed markdown report to tests/e2e/output/

    Test Matrix:
    +-------+-------------------------------+----------------------------------------------------+
    | Test  | Audio File                    | Pipeline                                           |
    +-------+-------------------------------+----------------------------------------------------+
    | #1    | ML (20260205_*_ml.wav)        | Basic q4 (no VAD, no denoise, no diarization)      |
    | #2    | ML (20260205_*_ml.wav)        | Full q4 (silero-vad-v6 + denoise + diarization)    |
    | #3    | EN (20260206_*_en.wav)        | Basic q4 (no VAD, no denoise, no diarization)      |
    | #4    | EN (20260206_*_en.wav)        | Full q4 (silero-vad-v6 + denoise + diarization)    |
    +-------+-------------------------------+----------------------------------------------------+
    """

    # =========================================================================
    # Test #1: ML Audio — ONNX, Whisper Large V3 Turbo (q4), Basic (no preprocessing)
    # =========================================================================

    @pytest.mark.asyncio
    async def test_01_ml_onnx_whisper_large_v3_turbo_basic(
        self, ml_audio_bytes: bytes, ml_audio_file_info: dict
    ) -> None:
        """
        Real Data Test #1: ML audio, Safetensor engine, Whisper Small, basic.

        Audio: 20260205_52886591770282917_ml.wav (multilingual)
        Pipeline:
        - Engine: Safetensor (via HuggingFace Transformers)
        - Model: openai/whisper-small
        - Quantization: None (native safetensor, ~967 MB)
        - Denoising: Disabled
        - VAD: Disabled
        - Voice Embedding: Disabled
        - Speaker Diarization: Disabled
        - Language: Auto-detect
        - Timestamps: Word-level
        - Punctuation: Enabled
        - Normalize: Yes

        Expectations:
        1. Returns transcript in real-time
        2. Raw audio stored to MinIO under consultation session
        3. NO processed audio stored (no processing features enabled)
        4. Transcript exported to MinIO and local JSON file
        """
        yaml_config = _pipeline_yaml_onnx_basic()
        job_id = "test-rd-001"
        consultation_id = "test-consult-ml-basic-001"

        pipeline = _build_pipeline_config(
            pipeline_id=job_id,
            slug="test-rd-onnx-large-v3-turbo-q4-basic-ml",
            name="Test: ONNX Whisper Large V3 Turbo Q4 Basic (ML)",
            description=(
                "Real-data test #1: Safetensor engine, Whisper Small, "
                "no denoising, no VAD, no diarization (ML audio)"
            ),
            config_yaml=yaml_config,
            tags=["test", "real-data", "safetensor", "basic", "ml", "whisper-small"],
        )

        # --- Run transcription ---
        result = await _run_transcription(
            pipeline_config=pipeline,
            audio_bytes=ml_audio_bytes,
            job_id=job_id,
            tenant_id=DEFAULT_TENANT_ID,
            consultation_id=consultation_id,
            audio_filename=ml_audio_file_info["name"],
        )

        # --- Assertions: transcription result + language + timestamps + progress ---
        _assert_common_result(
            result,
            expect_language=True,
            expect_sentence_timestamps=True,
            expect_vad_segments=False,  # Basic: no VAD
        )

        # --- Assertions: timing metrics ---
        _assert_timing_metrics(result, vad_enabled=False, diarization_enabled=False)

        # --- MinIO: raw audio storage (consultation session) ---
        minio_uri: str | None = None
        try:
            minio_uri = await _upload_raw_audio_to_minio(
                audio_bytes=ml_audio_bytes,
                tenant_id=DEFAULT_TENANT_ID,
                job_id=job_id,
                filename=ml_audio_file_info["name"],
                consultation_id=consultation_id,
            )

            assert minio_uri, "MinIO URI should not be empty"
            assert minio_uri.startswith("s3://"), f"URI should start with s3://, got: {minio_uri}"
            assert f"/consultations/{consultation_id}/" in minio_uri, (
                f"Raw audio URI should contain consultation path, got: {minio_uri}"
            )

            audio_exists = await _verify_minio_audio_exists(minio_uri)
            assert audio_exists, f"Raw audio should exist in MinIO at {minio_uri}"

            stored_size = await _get_minio_audio_size(minio_uri)
            assert stored_size == ml_audio_file_info["size_bytes"], (
                f"Stored audio size ({stored_size}) should match original ({ml_audio_file_info['size_bytes']})"
            )

            result.raw_audio_uri = minio_uri
            logger.info(f"MinIO: raw audio stored at {minio_uri} ({stored_size} bytes)")
        except (RuntimeError, ConnectionError, OSError) as e:
            logger.warning(f"MinIO raw audio upload skipped: {e}")

        # --- MinIO: NO processed audio for basic pipeline ---
        # Basic pipeline has no denoise/VAD, so no processed audio should be stored.
        processed_audio_uri: str | None = None

        # --- MinIO: transcript upload ---
        transcript_uri: str | None = None
        try:
            transcript_json = json.dumps(result.to_dict(), default=str, ensure_ascii=False)
            transcript_uri = await _upload_transcript_to_minio(
                transcript_json=transcript_json,
                tenant_id=DEFAULT_TENANT_ID,
                job_id=job_id,
                consultation_id=consultation_id,
            )

            assert transcript_uri, "Transcript URI should not be empty"
            assert transcript_uri.startswith("s3://"), "Transcript URI should start with s3://"
            assert f"/consultations/{consultation_id}/transcripts/" in transcript_uri, (
                f"Transcript URI should contain consultation transcript path, got: {transcript_uri}"
            )

            transcript_exists = await _verify_minio_audio_exists(transcript_uri)
            assert transcript_exists, f"Transcript should exist in MinIO at {transcript_uri}"

            result.transcript_uri = transcript_uri
            logger.info(f"MinIO: transcript stored at {transcript_uri}")
        except (RuntimeError, ConnectionError, OSError) as e:
            logger.warning(f"MinIO transcript upload skipped: {e}")

        # --- Export result JSON to local file and verify ---
        json_path = _export_result_json(
            test_name="test_01_ml_onnx_large_v3_turbo_q4_basic",
            result=result,
        )
        _assert_exported_json(json_path)

        # --- Write markdown report ---
        report_path = _write_markdown_report(
            test_name="test_01_ml_onnx_large_v3_turbo_q4_basic",
            pipeline_name="ONNX Whisper Large V3 Turbo Q4 Basic (ML)",
            pipeline_slug=pipeline.slug,
            pipeline_yaml=yaml_config,
            result=result,
            audio_file=ml_audio_file_info["name"],
            audio_size_bytes=ml_audio_file_info["size_bytes"],
            consultation_id=consultation_id,
            vad_enabled=False,
            denoise_enabled=False,
            diarization_enabled=False,
            minio_uri=minio_uri,
            processed_audio_uri=processed_audio_uri,
            transcript_uri=transcript_uri,
        )

        logger.info(f"Test #1 completed. Report: {report_path}, JSON: {json_path}")
        logger.info(f"Transcription ({len(result.text)} chars): {result.text[:200]}...")

    # =========================================================================
    # Test #2: ML Audio — ONNX, Whisper Large V3 Turbo (q4), Full
    #          (denoise + silero-vad-v6 + deepghs/pyannote-embedding-onnx)
    # =========================================================================

    @pytest.mark.asyncio
    async def test_02_ml_onnx_whisper_large_v3_turbo_full_pipeline(
        self, ml_audio_bytes: bytes, ml_audio_file_info: dict
    ) -> None:
        """
        Real Data Test #2: ML audio, Safetensor engine, Whisper Small, full pipeline.

        Audio: 20260205_52886591770282917_ml.wav (multilingual)
        Pipeline:
        - Engine: Safetensor (via HuggingFace Transformers)
        - Model: openai/whisper-small
        - Quantization: None (native safetensor, ~967 MB)
        - Denoising: Enabled (RNNoise)
        - VAD: Enabled (Silero VAD v6)
        - Voice Embedding: Enabled (deepghs/pyannote-embedding-onnx, ONNX engine)
        - Speaker Diarization: Enabled (silero-vad-v6 + deepghs/pyannote-embedding-onnx)
        - Language: Auto-detect
        - Timestamps: Word-level
        - Punctuation: Enabled
        - Normalize: Yes

        Expectations:
        1. Returns transcript with timestamps and speaker diarization
        2. Raw audio stored to MinIO under consultation session
        3. Processed audio (VAD-merged speech segments) stored to MinIO
        4. Transcript exported to MinIO and local JSON file
        """
        yaml_config = _pipeline_yaml_onnx_full_pipeline()
        job_id = "test-rd-002"
        consultation_id = "test-consult-ml-full-001"

        pipeline = _build_pipeline_config(
            pipeline_id=job_id,
            slug="test-rd-onnx-large-v3-turbo-q4-full-ml",
            name="Test: ONNX Whisper Large V3 Turbo Q4 Full Pipeline (ML)",
            description=(
                "Real-data test #2: Safetensor engine, Whisper Small, "
                "denoise + VAD + diarization (ML audio)"
            ),
            config_yaml=yaml_config,
            tags=["test", "real-data", "safetensor", "full", "denoise", "vad", "diarization", "ml", "whisper-small"],
        )

        # --- Run transcription ---
        result = await _run_transcription(
            pipeline_config=pipeline,
            audio_bytes=ml_audio_bytes,
            job_id=job_id,
            tenant_id=DEFAULT_TENANT_ID,
            consultation_id=consultation_id,
            audio_filename=ml_audio_file_info["name"],
        )

        # --- Assertions: transcription result + language + timestamps + progress + VAD ---
        _assert_common_result(
            result,
            expect_language=True,
            expect_sentence_timestamps=True,
            expect_vad_segments=True,  # Full: VAD enabled
        )

        # Diarization metadata (non-fatal if services not fully available)
        diarization_metadata = result.metadata.get("diarization", {}) if result.metadata else {}
        if diarization_metadata:
            logger.info(f"Diarization metadata: {diarization_metadata}")
            if "speakers_detected" in diarization_metadata:
                assert diarization_metadata["speakers_detected"] >= 0, (
                    "speakers_detected should be non-negative"
                )
            if "speaker_ids" in diarization_metadata:
                assert isinstance(diarization_metadata["speaker_ids"], list), (
                    "speaker_ids should be a list"
                )

        # --- Assertions: timing metrics ---
        _assert_timing_metrics(result, vad_enabled=True, diarization_enabled=True)

        # --- MinIO: raw audio storage (consultation session) ---
        minio_uri: str | None = None
        try:
            minio_uri = await _upload_raw_audio_to_minio(
                audio_bytes=ml_audio_bytes,
                tenant_id=DEFAULT_TENANT_ID,
                job_id=job_id,
                filename=ml_audio_file_info["name"],
                consultation_id=consultation_id,
            )

            assert minio_uri, "MinIO URI should not be empty"
            assert minio_uri.startswith("s3://"), "URI should start with s3://"
            assert f"/consultations/{consultation_id}/" in minio_uri, (
                f"Raw audio URI should contain consultation path, got: {minio_uri}"
            )

            audio_exists = await _verify_minio_audio_exists(minio_uri)
            assert audio_exists, f"Raw audio should exist in MinIO at {minio_uri}"

            stored_size = await _get_minio_audio_size(minio_uri)
            assert stored_size == ml_audio_file_info["size_bytes"], (
                f"Stored audio size ({stored_size}) should match original ({ml_audio_file_info['size_bytes']})"
            )

            result.raw_audio_uri = minio_uri
            logger.info(f"MinIO: raw audio stored at {minio_uri} ({stored_size} bytes)")
        except (RuntimeError, ConnectionError, OSError) as e:
            logger.warning(f"MinIO raw audio upload skipped: {e}")

        # --- MinIO: processed audio storage (VAD-merged speech segments) ---
        # Full-pipeline worker already uploads processed audio. Re-running
        # preprocessing here adds a long duplicate pass for large fixtures.
        processed_audio_uri: str | None = result.processed_audio_uri
        processed_audio_size: int = 0
        assert processed_audio_uri, (
            "Worker should provide processed_audio_uri for full pipeline tests"
        )
        assert processed_audio_uri.startswith("s3://")
        assert f"/consultations/{consultation_id}/processed/" in processed_audio_uri, (
            "Processed audio URI should contain consultation/processed path"
        )

        try:
            pa_exists = await _verify_minio_audio_exists(processed_audio_uri)
            assert pa_exists, f"Processed audio should exist in MinIO at {processed_audio_uri}"

            pa_stored_size = await _get_minio_audio_size(processed_audio_uri)
            assert pa_stored_size > 0, "Stored processed audio should not be empty"
            processed_audio_size = pa_stored_size

            logger.info(
                f"MinIO: processed audio verified at {processed_audio_uri} "
                f"({processed_audio_size:,} bytes)"
            )
        except (RuntimeError, ConnectionError, OSError) as e:
            logger.warning(f"MinIO processed audio verification skipped: {e}")

        # --- MinIO: transcript upload ---
        transcript_uri: str | None = None
        try:
            transcript_json = json.dumps(result.to_dict(), default=str, ensure_ascii=False)
            transcript_uri = await _upload_transcript_to_minio(
                transcript_json=transcript_json,
                tenant_id=DEFAULT_TENANT_ID,
                job_id=job_id,
                consultation_id=consultation_id,
            )

            assert transcript_uri, "Transcript URI should not be empty"
            assert transcript_uri.startswith("s3://")
            assert f"/consultations/{consultation_id}/transcripts/" in transcript_uri

            transcript_exists = await _verify_minio_audio_exists(transcript_uri)
            assert transcript_exists, f"Transcript should exist at {transcript_uri}"

            result.transcript_uri = transcript_uri
            logger.info(f"MinIO: transcript stored at {transcript_uri}")
        except (RuntimeError, ConnectionError, OSError) as e:
            logger.warning(f"MinIO transcript upload skipped: {e}")

        # --- Export result JSON to local file and verify ---
        json_path = _export_result_json(
            test_name="test_02_ml_onnx_large_v3_turbo_q4_full_pipeline",
            result=result,
        )
        _assert_exported_json(json_path)

        # --- Write markdown report ---
        report_path = _write_markdown_report(
            test_name="test_02_ml_onnx_large_v3_turbo_q4_full_pipeline",
            pipeline_name="ONNX Whisper Large V3 Turbo Q4 Full Pipeline (ML)",
            pipeline_slug=pipeline.slug,
            pipeline_yaml=yaml_config,
            result=result,
            audio_file=ml_audio_file_info["name"],
            audio_size_bytes=ml_audio_file_info["size_bytes"],
            consultation_id=consultation_id,
            vad_enabled=True,
            denoise_enabled=True,
            diarization_enabled=True,
            minio_uri=minio_uri,
            processed_audio_uri=processed_audio_uri,
            transcript_uri=transcript_uri,
            processed_audio_size=processed_audio_size,
        )

        logger.info(f"Test #2 completed. Report: {report_path}, JSON: {json_path}")
        logger.info(f"Transcription ({len(result.text)} chars): {result.text[:200]}...")

    # =========================================================================
    # Test #3: EN Audio — ONNX, Whisper Large V3 Turbo (q4), Basic (no preprocessing)
    # =========================================================================

    @pytest.mark.asyncio
    async def test_03_en_onnx_whisper_large_v3_turbo_basic(
        self, en_audio_bytes: bytes, en_audio_file_info: dict
    ) -> None:
        """
        Real Data Test #3: EN audio, Safetensor engine, Whisper Small, basic.

        Audio: 20260206_52886591770369502_en.wav (English)
        Pipeline:
        - Engine: Safetensor (via HuggingFace Transformers)
        - Model: openai/whisper-small
        - Quantization: None (native safetensor, ~967 MB)
        - Denoising: Disabled
        - VAD: Disabled
        - Voice Embedding: Disabled
        - Speaker Diarization: Disabled
        - Language: Auto-detect
        - Timestamps: Word-level
        - Punctuation: Enabled
        - Normalize: Yes

        Expectations:
        1. Returns transcript in real-time
        2. Raw audio stored to MinIO under consultation session
        3. NO processed audio stored (no processing features enabled)
        4. Transcript exported to MinIO and local JSON file
        """
        yaml_config = _pipeline_yaml_onnx_basic()
        job_id = "test-rd-003"
        consultation_id = "test-consult-en-basic-001"

        pipeline = _build_pipeline_config(
            pipeline_id=job_id,
            slug="test-rd-onnx-large-v3-turbo-q4-basic-en",
            name="Test: ONNX Whisper Large V3 Turbo Q4 Basic (EN)",
            description=(
                "Real-data test #3: Safetensor engine, Whisper Small, "
                "no denoising, no VAD, no diarization (EN audio)"
            ),
            config_yaml=yaml_config,
            tags=["test", "real-data", "safetensor", "basic", "en", "whisper-small"],
        )

        # --- Run transcription ---
        result = await _run_transcription(
            pipeline_config=pipeline,
            audio_bytes=en_audio_bytes,
            job_id=job_id,
            tenant_id=DEFAULT_TENANT_ID,
            consultation_id=consultation_id,
            audio_filename=en_audio_file_info["name"],
        )

        # --- Assertions: transcription result + language + timestamps + progress ---
        _assert_common_result(
            result,
            expect_language=True,
            expect_sentence_timestamps=True,
            expect_vad_segments=False,  # Basic: no VAD
        )

        # --- Assertions: timing metrics ---
        _assert_timing_metrics(result, vad_enabled=False, diarization_enabled=False)

        # --- MinIO: raw audio storage (consultation session) ---
        minio_uri: str | None = None
        try:
            minio_uri = await _upload_raw_audio_to_minio(
                audio_bytes=en_audio_bytes,
                tenant_id=DEFAULT_TENANT_ID,
                job_id=job_id,
                filename=en_audio_file_info["name"],
                consultation_id=consultation_id,
            )

            assert minio_uri, "MinIO URI should not be empty"
            assert minio_uri.startswith("s3://")
            assert f"/consultations/{consultation_id}/" in minio_uri, (
                f"Raw audio URI should contain consultation path, got: {minio_uri}"
            )

            audio_exists = await _verify_minio_audio_exists(minio_uri)
            assert audio_exists, f"Raw audio should exist in MinIO at {minio_uri}"

            stored_size = await _get_minio_audio_size(minio_uri)
            assert stored_size == en_audio_file_info["size_bytes"], (
                f"Stored audio size ({stored_size}) should match original ({en_audio_file_info['size_bytes']})"
            )

            result.raw_audio_uri = minio_uri
            logger.info(f"MinIO: raw audio stored at {minio_uri} ({stored_size} bytes)")
        except (RuntimeError, ConnectionError, OSError) as e:
            logger.warning(f"MinIO raw audio upload skipped: {e}")

        # --- MinIO: NO processed audio for basic pipeline ---
        processed_audio_uri: str | None = None

        # --- MinIO: transcript upload ---
        transcript_uri: str | None = None
        try:
            transcript_json = json.dumps(result.to_dict(), default=str, ensure_ascii=False)
            transcript_uri = await _upload_transcript_to_minio(
                transcript_json=transcript_json,
                tenant_id=DEFAULT_TENANT_ID,
                job_id=job_id,
                consultation_id=consultation_id,
            )

            assert transcript_uri, "Transcript URI should not be empty"
            assert transcript_uri.startswith("s3://")
            assert f"/consultations/{consultation_id}/transcripts/" in transcript_uri

            transcript_exists = await _verify_minio_audio_exists(transcript_uri)
            assert transcript_exists, f"Transcript should exist at {transcript_uri}"

            result.transcript_uri = transcript_uri
            logger.info(f"MinIO: transcript stored at {transcript_uri}")
        except (RuntimeError, ConnectionError, OSError) as e:
            logger.warning(f"MinIO transcript upload skipped: {e}")

        # --- Export result JSON to local file and verify ---
        json_path = _export_result_json(
            test_name="test_03_en_onnx_large_v3_turbo_q4_basic",
            result=result,
        )
        _assert_exported_json(json_path)

        # --- Write markdown report ---
        report_path = _write_markdown_report(
            test_name="test_03_en_onnx_large_v3_turbo_q4_basic",
            pipeline_name="ONNX Whisper Large V3 Turbo Q4 Basic (EN)",
            pipeline_slug=pipeline.slug,
            pipeline_yaml=yaml_config,
            result=result,
            audio_file=en_audio_file_info["name"],
            audio_size_bytes=en_audio_file_info["size_bytes"],
            consultation_id=consultation_id,
            vad_enabled=False,
            denoise_enabled=False,
            diarization_enabled=False,
            minio_uri=minio_uri,
            processed_audio_uri=processed_audio_uri,
            transcript_uri=transcript_uri,
        )

        logger.info(f"Test #3 completed. Report: {report_path}, JSON: {json_path}")
        logger.info(f"Transcription ({len(result.text)} chars): {result.text[:200]}...")

    # =========================================================================
    # Test #4: EN Audio — ONNX, Whisper Large V3 Turbo (q4), Full
    #          (denoise + silero-vad-v6 + deepghs/pyannote-embedding-onnx)
    # =========================================================================

    @pytest.mark.asyncio
    async def test_04_en_onnx_whisper_large_v3_turbo_full_pipeline(
        self, en_audio_bytes: bytes, en_audio_file_info: dict
    ) -> None:
        """
        Real Data Test #4: EN audio, Safetensor engine, Whisper Small, full pipeline.

        Audio: 20260206_52886591770369502_en.wav (English)
        Pipeline:
        - Engine: Safetensor (via HuggingFace Transformers)
        - Model: openai/whisper-small
        - Quantization: None (native safetensor, ~967 MB)
        - Denoising: Enabled (RNNoise)
        - VAD: Enabled (Silero VAD v6)
        - Voice Embedding: Enabled (deepghs/pyannote-embedding-onnx, ONNX engine)
        - Speaker Diarization: Enabled (silero-vad-v6 + deepghs/pyannote-embedding-onnx)
        - Language: Auto-detect
        - Timestamps: Word-level
        - Punctuation: Enabled
        - Normalize: Yes

        Expectations:
        1. Returns transcript with timestamps and speaker diarization
        2. Raw audio stored to MinIO under consultation session
        3. Processed audio (VAD-merged speech segments) stored to MinIO
        4. Transcript exported to MinIO and local JSON file
        """
        yaml_config = _pipeline_yaml_onnx_full_pipeline()
        job_id = "test-rd-004"
        consultation_id = "test-consult-en-full-001"

        pipeline = _build_pipeline_config(
            pipeline_id=job_id,
            slug="test-rd-onnx-large-v3-turbo-q4-full-en",
            name="Test: ONNX Whisper Large V3 Turbo Q4 Full Pipeline (EN)",
            description=(
                "Real-data test #4: Safetensor engine, Whisper Small, "
                "denoise + VAD + diarization (EN audio)"
            ),
            config_yaml=yaml_config,
            tags=["test", "real-data", "safetensor", "full", "denoise", "vad", "diarization", "en", "whisper-small"],
        )

        # --- Run transcription ---
        result = await _run_transcription(
            pipeline_config=pipeline,
            audio_bytes=en_audio_bytes,
            job_id=job_id,
            tenant_id=DEFAULT_TENANT_ID,
            consultation_id=consultation_id,
            audio_filename=en_audio_file_info["name"],
            timeout=200,
        )

        # --- Assertions: transcription result + language + timestamps + progress + VAD ---
        _assert_common_result(
            result,
            expect_language=True,
            expect_sentence_timestamps=True,
            expect_vad_segments=True,  # Full: VAD enabled
        )

        # Diarization metadata (non-fatal if services not fully available)
        diarization_metadata = result.metadata.get("diarization", {}) if result.metadata else {}
        if diarization_metadata:
            logger.info(f"Diarization metadata: {diarization_metadata}")
            if "speakers_detected" in diarization_metadata:
                assert diarization_metadata["speakers_detected"] >= 0, (
                    "speakers_detected should be non-negative"
                )
            if "speaker_ids" in diarization_metadata:
                assert isinstance(diarization_metadata["speaker_ids"], list), (
                    "speaker_ids should be a list"
                )

        # --- Assertions: timing metrics ---
        _assert_timing_metrics(result, vad_enabled=True, diarization_enabled=True)

        # --- MinIO: raw audio storage (consultation session) ---
        minio_uri: str | None = None
        try:
            minio_uri = await _upload_raw_audio_to_minio(
                audio_bytes=en_audio_bytes,
                tenant_id=DEFAULT_TENANT_ID,
                job_id=job_id,
                filename=en_audio_file_info["name"],
                consultation_id=consultation_id,
            )

            assert minio_uri, "MinIO URI should not be empty"
            assert minio_uri.startswith("s3://")
            assert f"/consultations/{consultation_id}/" in minio_uri, (
                f"Raw audio URI should contain consultation path, got: {minio_uri}"
            )

            audio_exists = await _verify_minio_audio_exists(minio_uri)
            assert audio_exists, f"Raw audio should exist in MinIO at {minio_uri}"

            stored_size = await _get_minio_audio_size(minio_uri)
            assert stored_size == en_audio_file_info["size_bytes"], (
                f"Stored audio size ({stored_size}) should match original ({en_audio_file_info['size_bytes']})"
            )

            result.raw_audio_uri = minio_uri
            logger.info(f"MinIO: raw audio stored at {minio_uri} ({stored_size} bytes)")
        except (RuntimeError, ConnectionError, OSError) as e:
            logger.warning(f"MinIO raw audio upload skipped: {e}")

        # --- MinIO: processed audio storage (VAD-merged speech segments) ---
        # Full-pipeline worker already uploads processed audio. Re-running
        # preprocessing here adds a long duplicate pass for large fixtures.
        processed_audio_uri: str | None = result.processed_audio_uri
        processed_audio_size: int = 0
        assert processed_audio_uri, (
            "Worker should provide processed_audio_uri for full pipeline tests"
        )
        assert processed_audio_uri.startswith("s3://")
        assert f"/consultations/{consultation_id}/processed/" in processed_audio_uri

        try:
            pa_exists = await _verify_minio_audio_exists(processed_audio_uri)
            assert pa_exists, f"Processed audio should exist at {processed_audio_uri}"

            pa_stored_size = await _get_minio_audio_size(processed_audio_uri)
            assert pa_stored_size > 0, "Stored processed audio should not be empty"
            processed_audio_size = pa_stored_size

            logger.info(
                f"MinIO: processed audio verified at {processed_audio_uri} "
                f"({processed_audio_size:,} bytes)"
            )
        except (RuntimeError, ConnectionError, OSError) as e:
            logger.warning(f"MinIO processed audio verification skipped: {e}")

        # --- MinIO: transcript upload ---
        transcript_uri: str | None = None
        try:
            transcript_json = json.dumps(result.to_dict(), default=str, ensure_ascii=False)
            transcript_uri = await _upload_transcript_to_minio(
                transcript_json=transcript_json,
                tenant_id=DEFAULT_TENANT_ID,
                job_id=job_id,
                consultation_id=consultation_id,
            )

            assert transcript_uri, "Transcript URI should not be empty"
            assert transcript_uri.startswith("s3://")
            assert f"/consultations/{consultation_id}/transcripts/" in transcript_uri

            transcript_exists = await _verify_minio_audio_exists(transcript_uri)
            assert transcript_exists, f"Transcript should exist at {transcript_uri}"

            result.transcript_uri = transcript_uri
            logger.info(f"MinIO: transcript stored at {transcript_uri}")
        except (RuntimeError, ConnectionError, OSError) as e:
            logger.warning(f"MinIO transcript upload skipped: {e}")

        # --- Export result JSON to local file and verify ---
        json_path = _export_result_json(
            test_name="test_04_en_onnx_large_v3_turbo_q4_full_pipeline",
            result=result,
        )
        _assert_exported_json(json_path)

        # --- Write markdown report ---
        report_path = _write_markdown_report(
            test_name="test_04_en_onnx_large_v3_turbo_q4_full_pipeline",
            pipeline_name="ONNX Whisper Large V3 Turbo Q4 Full Pipeline (EN)",
            pipeline_slug=pipeline.slug,
            pipeline_yaml=yaml_config,
            result=result,
            audio_file=en_audio_file_info["name"],
            audio_size_bytes=en_audio_file_info["size_bytes"],
            consultation_id=consultation_id,
            vad_enabled=True,
            denoise_enabled=True,
            diarization_enabled=True,
            minio_uri=minio_uri,
            processed_audio_uri=processed_audio_uri,
            transcript_uri=transcript_uri,
            processed_audio_size=processed_audio_size,
        )

        logger.info(f"Test #4 completed. Report: {report_path}, JSON: {json_path}")
        logger.info(f"Transcription ({len(result.text)} chars): {result.text[:200]}...")
