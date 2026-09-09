"""Malayalam-English code-switch STT regression gate.

Runs the shipped whisper.cpp adapter path over a private labeled fixture set and
asserts CER has not regressed past the committed baseline
(``mlen_scorecard_baseline.json`` — schema_version 2, a map of per-model,
per-window profiles keyed ``"<model slug>@<window_s>"``, TASK-934/M).

PHI/PII: the fixtures are real clinical audio (+ reference transcripts) and live
OUTSIDE git. This test SELF-SKIPS unless all three are provided, mirroring
``test_streaming_quality_scorecard`` — it never fails off-fixture / in CI:

    STT_MLEN_EVAL_DIR       dir of <id>.wav + <id>-label.{txt,wav} (label is text)
    WHISPER_MLEN_GGUF       path to the whisper.cpp GGUF (the ml-en fine-tune)
    WHISPER_MLEN_MODEL_SLUG the ``AiModel`` slug this GGUF was registered under —
                            REQUIRED, no default. Selects the baseline profile
                            entry, whose ``window_s`` becomes the decode window
                            (``InferenceConfig.max_decode_window_sec`` — the same
                            wire field a row change reaches, TASK-880) so a
                            profile edit cannot silently change what this gate
                            measures. Unset or unknown → clean skip with a
                            reason naming the known entries.

Run:
    STT_MLEN_EVAL_DIR=/path/to/ml-test WHISPER_MLEN_GGUF=/path/to/model.gguf \
    WHISPER_MLEN_MODEL_SLUG=arcaai-whisper-large-ml-en-gguf-q8_0 \
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
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import numpy as np
import pytest

_EVAL_DIR = os.environ.get("STT_MLEN_EVAL_DIR")
_GGUF = os.environ.get("WHISPER_MLEN_GGUF")
_MODEL_SLUG = os.environ.get("WHISPER_MLEN_MODEL_SLUG")
_BASELINE = Path(__file__).parent / "mlen_scorecard_baseline.json"


def _load_baseline() -> dict[str, Any]:
    return json.loads(_BASELINE.read_text(encoding="utf-8"))


def _select_baseline_entry(
    baseline: Mapping[str, Any], slug: str | None
) -> tuple[dict[str, Any] | None, str | None]:
    """Pick the per-model profile entry for ``slug``. Returns ``(entry, reason)``.

    Exactly one of the pair is ``None``. There is no default model — the row's
    ``window_s`` decides what this gate measures (TASK-934/M), so an absent or
    unrecognised slug must skip with a reason rather than silently pick a row.
    """
    entries = {k: v for k, v in baseline.items() if not k.startswith("_") and k != "schema_version"}
    if not slug:
        known = sorted(entries)
        return (
            None,
            f"WHISPER_MLEN_MODEL_SLUG is not set — no default model; known entries: {known}",
        )
    matches = {k: v for k, v in entries.items() if v.get("model_slug") == slug}
    if not matches:
        known = sorted(entries)
        return (
            None,
            f"no baseline entry for WHISPER_MLEN_MODEL_SLUG {slug!r} — known entries: {known}",
        )
    if len(matches) > 1:
        return (
            None,
            f"ambiguous WHISPER_MLEN_MODEL_SLUG {slug!r} — multiple windows profiled: "
            f"{sorted(matches)}; extend this helper to disambiguate by window",
        )
    (entry,) = matches.values()
    return entry, None


_SELECTED_ENTRY, _SKIP_REASON = _select_baseline_entry(_load_baseline(), _MODEL_SLUG)

# Applied to the LIVE (model-loading) tests only — NOT module-wide — so the pure
# selection/schema self-checks below always run, on-stack or off (mirrors the
# split in test_streaming_quality_scorecard.py between its pure gate and its
# live scorecard test).
_requires_live_fixtures = pytest.mark.skipif(
    not (_EVAL_DIR and _GGUF and Path(_EVAL_DIR).is_dir() and Path(_GGUF).is_file())
    or _SKIP_REASON is not None,
    reason=(
        _SKIP_REASON
        or "ml-en eval fixtures/model absent (set STT_MLEN_EVAL_DIR + WHISPER_MLEN_GGUF"
        " + WHISPER_MLEN_MODEL_SLUG)"
    ),
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

    assert _GGUF is not None and _EVAL_DIR is not None and _SELECTED_ENTRY is not None
    entry = _SELECTED_ENTRY
    model = Model(
        model=_GGUF, context_params={"use_gpu": True}, print_progress=False, print_realtime=False
    )
    loaded = LoadedModel(
        model_id="mlen",
        model_slug=entry["model_slug"],
        model=model,
        format=AiModelFormat.WHISPER_CPP,
        device="auto",
        extra={"model_path": _GGUF, "num_threads": 4},
    )
    # The decode window comes from the SELECTED profile entry, not a literal —
    # the same InferenceConfig.max_decode_window_sec field a row's
    # _metadata.asr.maxDecodeWindowSec reaches (TASK-880), so a profile edit
    # changes what this gate measures instead of being silently ignored.
    inference_config = type(
        "C", (), {"language": "ml-en", "max_decode_window_sec": entry["window_s"]}
    )()
    adapter = WhisperCppAsrAdapter(loaded, inference_config, want_word_timestamps=False)
    out: dict[str, float] = {}
    for cid, wav, lab in _discover(_EVAL_DIR):
        ref = Path(lab).read_text(encoding="utf-8").strip()
        hyp = adapter(_read_wav(wav), 16000)["text"]
        out[cid] = _cer(ref, hyp)
    assert out, "no labeled clips discovered in STT_MLEN_EVAL_DIR"
    return out


@_requires_live_fixtures
def test_mean_cer_within_ceiling(scores: dict[str, float]) -> None:
    assert _SELECTED_ENTRY is not None
    mean = sum(scores.values()) / len(scores)
    ceiling = _SELECTED_ENTRY["mean_cer_ceiling"]
    assert mean <= ceiling, f"mean CER {mean:.3f} exceeds ceiling {ceiling}"


@_requires_live_fixtures
def test_no_clip_regresses_past_baseline(scores: dict[str, float]) -> None:
    assert _SELECTED_ENTRY is not None
    clips = _SELECTED_ENTRY["clips"]
    tol = _SELECTED_ENTRY["per_clip_tolerance"]
    regressed = {
        cid: (cer, clips[cid])
        for cid, cer in scores.items()
        if cid in clips and cer > clips[cid] + tol
    }
    assert not regressed, "clips regressed past baseline+tolerance " + ", ".join(
        f"{c}: {now:.3f} (was {was:.3f})" for c, (now, was) in regressed.items()
    )


# ===========================================================================
# Pure self-checks (TASK-934/M) — always run, no fixtures/GPU/eval dir needed.
# ===========================================================================


def test_baseline_schema_is_v2_keyed_map() -> None:
    baseline = _load_baseline()
    assert baseline["schema_version"] == 2
    entries = {k: v for k, v in baseline.items() if not k.startswith("_") and k != "schema_version"}
    assert entries, "no per-model entries in mlen_scorecard_baseline.json"
    for key, entry in entries.items():
        for field in (
            "model_slug",
            "gguf_file",
            "window_s",
            "mean_cer",
            "mean_cer_ceiling",
            "per_clip_tolerance",
            "clips",
        ):
            assert field in entry, f"{key} is missing required field {field!r}"
        assert (
            key == f"{entry['model_slug']}@{entry['window_s']}"
        ), f"key {key!r} does not match '<model_slug>@<window_s>' for its own fields"
        computed_mean = round(sum(entry["clips"].values()) / len(entry["clips"]), 4)
        assert (
            computed_mean == entry["mean_cer"]
        ), f"{key}: stored mean_cer {entry['mean_cer']} does not match the clips {computed_mean}"


def test_select_baseline_entry_unset_slug_skips_with_reason() -> None:
    entry, reason = _select_baseline_entry(_load_baseline(), None)
    assert entry is None
    assert reason is not None and "WHISPER_MLEN_MODEL_SLUG is not set" in reason


def test_select_baseline_entry_unknown_slug_skips_with_reason() -> None:
    entry, reason = _select_baseline_entry(_load_baseline(), "not-a-real-model-slug")
    assert entry is None
    assert reason is not None and "not-a-real-model-slug" in reason


def test_select_baseline_entry_known_slug_returns_its_window() -> None:
    entry, reason = _select_baseline_entry(_load_baseline(), "arcaai-whisper-large-ml-en-gguf-q8_0")
    assert reason is None
    assert entry is not None
    assert entry["window_s"] == 7
    assert entry["model_slug"] == "arcaai-whisper-large-ml-en-gguf-q8_0"
