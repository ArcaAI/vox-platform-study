#!/usr/bin/env python
"""Malayalam-English code-switch STT quality scorecard (TASK-594).

Runs each labeled clip in a directory through the REAL ``WhisperCppAsrAdapter``
(so it exercises the shipped greedy / language / prompt / clean-text / length-guard
behaviour), reports transliteration-agnostic **CER** per clip and the mean, and
writes a scorecard JSON. Use it to tune ``WHISPER_CPP_MAX_AUDIO_SECONDS`` and the
other whisper.cpp knobs as the labeled set grows.

Clips dir layout (audio is NOT committed — clinical audio is PHI):
    <id>.wav            16 kHz mono
    <id>-label.txt      reference transcript (a ``-label.wav`` text sidecar also works)
ids are matched by the first integer in each filename.

Usage:
    python apps/stt/scripts/mlen_scorecard.py --clips-dir /path/to/ml-test \
        --gguf /path/to/ggml-...-f16.bin [--max-audio-seconds 7.0] [--out scorecard.json]

``--gguf`` may be omitted if ``WHISPER_MLEN_GGUF`` is set.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import unicodedata
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from stt.models.base_loader import LoadedModel  # noqa: E402
from stt.pipeline.dto import AiModelFormat  # noqa: E402
from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter  # noqa: E402


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()


def cer(ref: str, hyp: str) -> float:
    """Character error rate (NFC-normalized, whitespace-collapsed)."""
    r, h = _norm(ref), _norm(hyp)
    dp = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        prev, dp[0] = dp[0], i
        for j, hc in enumerate(h, 1):
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (rc != hc))
            prev = cur
    return dp[len(h)] / max(1, len(r))


def _read_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path) as w:
        frames = w.readframes(w.getnframes())
        sr = w.getframerate()
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0, sr


def _discover(clips_dir: str) -> list[tuple[str, str, str]]:
    labels: dict[str, str] = {}
    for lp in glob.glob(os.path.join(clips_dir, "*label*")):
        m = re.search(r"(\d+)", os.path.basename(lp))
        if m:
            labels[m.group(1)] = lp
    out: list[tuple[str, str, str]] = []
    for wp in sorted(glob.glob(os.path.join(clips_dir, "*.wav"))):
        if "label" in os.path.basename(wp):
            continue
        m = re.search(r"(\d+)", os.path.basename(wp))
        if m and m.group(1) in labels:
            out.append((m.group(1), wp, labels[m.group(1)]))
    return sorted(out, key=lambda c: int(c[0]))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--clips-dir", required=True)
    ap.add_argument("--gguf", default=os.environ.get("WHISPER_MLEN_GGUF"))
    ap.add_argument("--language", default="ml-en")
    ap.add_argument("--max-audio-seconds", type=float, default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if not args.gguf:
        ap.error("--gguf (or WHISPER_MLEN_GGUF) is required")
    if args.max_audio_seconds is not None:
        os.environ["WHISPER_CPP_MAX_AUDIO_SECONDS"] = str(args.max_audio_seconds)

    from pywhispercpp.model import Model

    model = Model(model=args.gguf, context_params={"use_gpu": True},
                  print_progress=False, print_realtime=False)
    loaded = LoadedModel(
        model_id="mlen", model_slug="arcaai-whisper-large-ml-en-gguf", model=model,
        format=AiModelFormat.WHISPER_CPP, device="auto",
        extra={"model_path": args.gguf, "num_threads": 4},
    )
    adapter = WhisperCppAsrAdapter(
        loaded, type("C", (), {"language": args.language})(), want_word_timestamps=False
    )

    clips = _discover(args.clips_dir)
    if not clips:
        print(f"No labeled clips found in {args.clips_dir}", file=sys.stderr)
        return 2

    rows = []
    for cid, wav, lab in clips:
        audio, sr = _read_wav(wav)
        ref = Path(lab).read_text(encoding="utf-8").strip()
        hyp = adapter(audio, sr)["text"]
        score = cer(ref, hyp)
        rows.append({"id": cid, "clip": os.path.basename(wav),
                     "duration_s": round(len(audio) / sr, 1), "cer": round(score, 4),
                     "ref": ref, "hyp": hyp})
        print("=" * 92)
        print(f"[{cid}] {os.path.basename(wav)}  {len(audio)/sr:4.1f}s  CER={score:.3f}")
        print(f"  REF: {ref}")
        print(f"  HYP: {hyp}")

    mean = sum(r["cer"] for r in rows) / len(rows)
    print("=" * 92)
    print(f"MEAN CER over {len(rows)} clips: {mean:.3f}")

    scorecard = {"model": os.path.basename(args.gguf), "language": args.language,
                 "max_audio_seconds": os.environ.get("WHISPER_CPP_MAX_AUDIO_SECONDS", "default"),
                 "mean_cer": round(mean, 4), "clips": rows}
    if args.out:
        Path(args.out).write_text(json.dumps(scorecard, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
