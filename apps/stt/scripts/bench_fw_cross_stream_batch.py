#!/usr/bin/env python
"""TASK-1009 — serial vs cross-stream-batched faster-whisper decode, on real weights.

Takes N windows of ``--window-sec`` seconds from N DIFFERENT fixture clips (N
concurrent "sessions") and decodes them two ways through the SHIPPED code:

* **serial**  — ``FasterWhisperAsrAdapter`` with batching off: one per-call
  ``BatchedInferencePipeline.transcribe`` after another, which is what N
  sessions on one model get today (CTranslate2 with one worker queues them).
* **batched** — N adapters sharing the model's ``CrossStreamBatcher`` with
  ``max_batch_size = N``: one flush, one encoder pass, the production decoder.

and reports wall time, speed-up, real-time factor and serial-vs-batched
agreement (exact text, and word timings). ``--prompts mixed`` gives every other
window a carry-forward prompt, which exercises the split ``generate`` path (the
encoder still runs once; ``generate`` runs once per prompt shape).

CPU numbers are RELATIVE only: they show whether batching helps and how the
curve bends, not what a GPU will do. Nothing here writes hypothesis text — the
fixtures are real clinical audio, so only aggregates are printed or saved.

Usage (from the repo root, arcaenv)::

    python apps/stt/scripts/bench_fw_cross_stream_batch.py \\
        --model /path/to/ct2-model-dir \\
        --fixtures-dir /path/to/output_aligned/<recording> \\
        --ns 1,2,4,8 --compute-type int8 --cpu-threads 4 --out bench.json

Fixture layout: one sub-directory per clip holding ``audio.wav`` (16 kHz mono);
clips shorter than ``--window-sec`` are skipped.
"""

from __future__ import annotations

import argparse
import difflib
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from stt.models.base_loader import LoadedModel  # noqa: E402
from stt.pipeline.dto import AiModelFormat, InferenceConfig  # noqa: E402
from stt.streaming.faster_whisper_asr import (  # noqa: E402
    CrossStreamBatching,
    FasterWhisperAsrAdapter,
    close_model_batcher,
)

_SR = 16000
_CARRY = "probiotic foods gut health fermented curd"


def _windows(fixtures: Path, seconds: float, count: int) -> list[np.ndarray]:
    out: list[np.ndarray] = []
    for clip in sorted(p for p in fixtures.iterdir() if (p / "audio.wav").exists()):
        audio, sr = sf.read(clip / "audio.wav", dtype="float32")
        if sr != _SR or audio.ndim != 1:
            continue
        need = int(seconds * _SR)
        if len(audio) >= need:
            out.append(audio[:need])
        if len(out) == count:
            return out
    raise SystemExit(f"only {len(out)} clips >= {seconds}s in {fixtures}; need {count}")


def _words(result: dict) -> list[tuple]:
    return [(w["word"], w["start"], w["end"]) for w in result["word_timestamps"]]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--model", required=True, help="CT2 model dir or HF id")
    ap.add_argument("--fixtures-dir", required=True, type=Path)
    ap.add_argument("--ns", default="1,2,4,8")
    ap.add_argument("--window-sec", type=float, default=7.0)
    ap.add_argument("--language", default="ml")
    ap.add_argument("--beam-size", type=int, default=1)
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--cpu-threads", type=int, default=4)
    ap.add_argument("--prompts", choices=("none", "mixed"), default="none")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    from faster_whisper import BatchedInferencePipeline, WhisperModel

    ns = [int(n) for n in args.ns.split(",")]
    windows = _windows(args.fixtures_dir, args.window_sec, max(ns))
    prompts = [
        (_CARRY if (args.prompts == "mixed" and i % 2 == 1) else None) for i in range(max(ns))
    ]

    t0 = time.perf_counter()
    model = WhisperModel(
        args.model, device="cpu", compute_type=args.compute_type, cpu_threads=args.cpu_threads
    )
    load_s = time.perf_counter() - t0
    loaded = LoadedModel(
        model_id="bench",
        model_slug="bench",
        model=model,
        format=AiModelFormat.FASTER_WHISPER,
        device="cpu",
        extra={"batched_pipeline": BatchedInferencePipeline(model=model)},
    )
    config = InferenceConfig(language=args.language, beam_size=args.beam_size, temperature=0.0)
    serial_adapter = FasterWhisperAsrAdapter(loaded, config)
    serial_adapter(windows[0], _SR)  # warm-up

    rows = []
    for n in ns:
        wins, pr = windows[:n], prompts[:n]

        t = time.perf_counter()
        serial = [serial_adapter(w, _SR, prompt=p) for w, p in zip(wins, pr, strict=True)]
        serial_s = time.perf_counter() - t

        batching = CrossStreamBatching(max_batch_size=n, max_wait_ms=60_000, max_queue=4 * n)
        sessions = [FasterWhisperAsrAdapter(loaded, config, batching=batching) for _ in range(n)]
        t = time.perf_counter()
        futures = [s.submit(w, _SR, prompt=p) for s, w, p in zip(sessions, wins, pr, strict=True)]
        batched = [f.result() for f in futures]
        batched_s = time.perf_counter() - t

        same_text = sum(a["text"] == b["text"] for a, b in zip(serial, batched, strict=True))
        similarity = float(
            np.mean(
                [
                    difflib.SequenceMatcher(None, a["text"], b["text"]).ratio()
                    for a, b in zip(serial, batched, strict=True)
                ]
            )
        )
        words = [(_words(a), _words(b)) for a, b in zip(serial, batched, strict=True)]
        same_words = sum(x == y for x, y in words)
        word_total = sum(len(x) for x, _ in words)
        word_same_pos = sum(sum(1 for p, q in zip(x, y, strict=False) if p == q) for x, y in words)
        audio_s = n * args.window_sec
        row = {
            "n": n,
            "serial_s": round(serial_s, 2),
            "batched_s": round(batched_s, 2),
            "speedup": round(serial_s / batched_s, 2),
            "serial_rtf": round(serial_s / audio_s, 3),
            "batched_rtf": round(batched_s / audio_s, 3),
            "text_identical": f"{same_text}/{n}",
            "text_similarity": round(similarity, 4),
            "word_timings_identical_windows": f"{same_words}/{n}",
            "word_timings_identical_share": round(word_same_pos / max(1, word_total), 4),
        }
        rows.append(row)
        print(json.dumps(row), flush=True)

    close_model_batcher(loaded)
    report = {
        "model": args.model,
        "compute_type": args.compute_type,
        "cpu_threads": args.cpu_threads,
        "window_sec": args.window_sec,
        "language": args.language,
        "beam_size": args.beam_size,
        "prompts": args.prompts,
        "model_multilingual": bool(model.model.is_multilingual),
        "load_s": round(load_s, 2),
        "rows": rows,
    }
    if args.out:
        args.out.write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k != "rows"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
