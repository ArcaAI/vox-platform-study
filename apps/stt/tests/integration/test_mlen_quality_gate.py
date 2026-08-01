"""Malayalam-English code-switch STT regression gate (TASK-594).

Runs the shipped whisper.cpp adapter path over a private labeled fixture set and
asserts CER has not regressed past the committed baseline
(``mlen_scorecard_baseline.json``).

PHI/PII: the fixtures are real clinical audio (+ reference transcripts) and live
OUTSIDE git. This test SELF-SKIPS unless both are provided, mirroring
``test_streaming_quality_scorecard`` — it never fails off-fixture / in CI:

    STT_MLEN_EVAL_DIR   dir of <id>.wav + <id>-label.{txt,wav} (label is text)
    WHISPER_MLEN_GGUF   path to the whisper.cpp GGUF (the ml-en fine-tune)

Run:
    STT_MLEN_EVAL_DIR=/path/to/ml-test WHISPER_MLEN_GGUF=/path/to/model.gguf \
      pnpm py:stt:test:integration -- -k mlen_quality_gate

The scorecard decodes each clip as ONE utterance (isolates model/adapter quality
from the streaming loop) — it is a MODEL-quality gate, not a streaming-path test.
"""

from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
import wave
from pathlib import Path

import numpy as np
import pytest

_EVAL_DIR = os.environ.get("STT_MLEN_EVAL_DIR")
_GGUF = os.environ.get("WHISPER_MLEN_GGUF")
_BASELINE = Path(__file__).parent / "mlen_scorecard_baseline.json"

pytestmark = pytest.mark.skipif(
    not (_EVAL_DIR and _GGUF and Path(_EVAL_DIR).is_dir() and Path(_GGUF).is_file()),
    reason="ml-en eval fixtures/model absent (set STT_MLEN_EVAL_DIR + WHISPER_MLEN_GGUF)",
)


@pytest.fixture(scope="session")
def verify_test_environment():  # noqa: D401 — fixture override
    """Neutralize the integration conftest's docker-compose gate — this gate needs
    no monorepo infrastructure, only the private fixtures + GGUF (guarded above)."""
    yield


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()


def _cer(ref: str, hyp: str) -> float:
    r, h = _norm(ref), _norm(hyp)
    dp = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        prev, dp[0] = dp[0], i
        for j, hc in enumerate(h, 1):
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (rc != hc))
            prev = cur
    return dp[len(h)] / max(1, len(r))


def _read_wav(path: str) -> np.ndarray:
    with wave.open(path) as w:
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def _discover(clips_dir: str) -> list[tuple[str, str, str]]:
    import glob

    labels: dict[str, str] = {}
    for lp in glob.glob(os.path.join(clips_dir, "*label*")):
        m = re.search(r"(\d+)", os.path.basename(lp))
        if m:
            labels[m.group(1)] = lp
    out = []
    for wp in sorted(glob.glob(os.path.join(clips_dir, "*.wav"))):
        if "label" in os.path.basename(wp):
            continue
        m = re.search(r"(\d+)", os.path.basename(wp))
        if m and m.group(1) in labels:
            out.append((m.group(1), wp, labels[m.group(1)]))
    return sorted(out, key=lambda c: int(c[0]))


@pytest.fixture(scope="module")
def scores() -> dict[str, float]:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
    from pywhispercpp.model import Model

    from stt.models.base_loader import LoadedModel
    from stt.pipeline.dto import AiModelFormat
    from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter

    assert _GGUF is not None and _EVAL_DIR is not None
    model = Model(model=_GGUF, context_params={"use_gpu": True},
                  print_progress=False, print_realtime=False)
    loaded = LoadedModel(model_id="mlen", model_slug="arcaai-whisper-large-ml-en-gguf",
                         model=model, format=AiModelFormat.WHISPER_CPP, device="auto",
                         extra={"model_path": _GGUF, "num_threads": 4})
    adapter = WhisperCppAsrAdapter(
        loaded, type("C", (), {"language": "ml-en"})(), want_word_timestamps=False
    )
    out: dict[str, float] = {}
    for cid, wav, lab in _discover(_EVAL_DIR):
        ref = Path(lab).read_text(encoding="utf-8").strip()
        hyp = adapter(_read_wav(wav), 16000)["text"]
        out[cid] = _cer(ref, hyp)
    assert out, "no labeled clips discovered in STT_MLEN_EVAL_DIR"
    return out


def _baseline() -> dict:
    return json.loads(_BASELINE.read_text(encoding="utf-8"))


def test_mean_cer_within_ceiling(scores: dict[str, float]) -> None:
    base = _baseline()
    mean = sum(scores.values()) / len(scores)
    assert mean <= base["mean_cer_ceiling"], (
        f"mean CER {mean:.3f} exceeds ceiling {base['mean_cer_ceiling']}"
    )


def test_no_clip_regresses_past_baseline(scores: dict[str, float]) -> None:
    base = _baseline()
    tol = base["per_clip_tolerance"]
    regressed = {
        cid: (cer, base["clips"][cid])
        for cid, cer in scores.items()
        if cid in base["clips"] and cer > base["clips"][cid] + tol
    }
    assert not regressed, (
        "clips regressed past baseline+tolerance "
        + ", ".join(f"{c}: {now:.3f} (was {was:.3f})" for c, (now, was) in regressed.items())
    )
