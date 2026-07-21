#!/usr/bin/env python
"""Per-hardware pipeline benchmark harness.

Runs the seeded matrix pipelines against a WAV corpus and reports latency,
realtime factor, and (with a reference transcript) WER — evidence for
default-pipeline decisions (e.g. promoting the CT2
pipeline once it beats the transformers default).

ENV-GATED by design: this downloads/loads real models and is NOT part of any
CI suite. Run it manually inside the arcaenv conda env:

    STT_BENCH_CORPUS=/path/to/wavs \\
    STT_BENCH_PIPELINES=production-whisper-large-v3,production-faster-whisper-turbo-int8 \\
    python apps/stt-v2/scripts/benchmark_pipelines.py

Optional: STT_BENCH_REFERENCE_DIR with <name>.txt per <name>.wav enables WER
(via jiwer when installed). Results print as a markdown table for pasting
into the ticket README.
"""

import asyncio
import os
import sys
import time
from pathlib import Path


def _require_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"ERROR: {name} is required (env-gated harness). See module docstring.")
        sys.exit(2)
    return value


async def _run() -> None:
    corpus_dir = Path(_require_env("STT_BENCH_CORPUS"))
    pipeline_slugs = [
        s.strip()
        for s in _require_env("STT_BENCH_PIPELINES").split(",")
        if s.strip()
    ]
    reference_dir_raw = os.environ.get("STT_BENCH_REFERENCE_DIR", "")
    reference_dir = Path(reference_dir_raw) if reference_dir_raw else None

    wavs = sorted(corpus_dir.glob("*.wav"))
    if not wavs:
        print(f"ERROR: no .wav files in {corpus_dir}")
        sys.exit(2)

    import soundfile as sf

    from stt_v2.core.platform import detect_platform
    from stt_v2.pipeline.config_reader import get_pipeline_reader
    from stt_v2.transcription.batch_service import get_batch_service

    try:
        from jiwer import wer as compute_wer
    except ImportError:
        compute_wer = None

    platform = detect_platform().value
    reader = get_pipeline_reader()
    service = get_batch_service()

    print(f"\n## TASK-505 benchmark — platform={platform}, corpus={corpus_dir.name} ({len(wavs)} files)\n")
    print("| pipeline | file | audio_s | wall_s | RTF | WER |")
    print("|---|---|---|---|---|---|")

    for slug in pipeline_slugs:
        pipeline = await reader.get_pipeline_by_slug(slug)
        for wav in wavs:
            info = sf.info(str(wav))
            audio_s = info.frames / info.samplerate
            audio_bytes = wav.read_bytes()

            start = time.monotonic()
            result = await service.transcribe(
                job_id=f"bench-{slug}-{wav.stem}",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
            )
            wall_s = time.monotonic() - start

            wer_cell = "—"
            if compute_wer is not None and reference_dir is not None:
                ref_path = reference_dir / (wav.stem + ".txt")
                if ref_path.exists():
                    reference = ref_path.read_text().strip().lower()
                    hypothesis = (result.text or "").strip().lower()
                    if reference:
                        wer_cell = f"{compute_wer(reference, hypothesis):.3f}"

            print(
                f"| {slug} | {wav.name} | {audio_s:.1f} | {wall_s:.1f} "
                f"| {wall_s / max(audio_s, 0.001):.2f} | {wer_cell} |"
            )

    print("\nPaste this table into docs/implementation/TASK-505-.../README.md (Phase 6 evidence).")


if __name__ == "__main__":
    asyncio.run(_run())
