#!/usr/bin/env python
"""TASK-994 lane L-OFFLINE — whisper.cpp decode-geometry + decode-param sweep.

Sweeps ``max_decode_window_sec`` (the chunk geometry) and decode hyper-parameter
sets over a labeled code-switched Malayalam-English clip set, through the REAL
``WhisperCppAsrAdapter`` — the same object the streaming session drives — so every
number here is produced by the shipped split / language / prompt / polish
behaviour and not by a re-implementation of it.

Reuse, not copy: ``cer`` / ``_norm`` / ``_read_wav`` are imported from
``apps/stt/scripts/mlen_scorecard.py`` and ``latin_letter_ratio`` from
``stt.pipeline.language_modes``, so a change to either lands here too.

How a decode block reaches the engine (verified against
``apps/stt/src/stt/streaming/whisper_cpp_asr.py`` on 2026-09-20):

* ``InferenceConfig.decode_final`` / ``decode_partial`` are the ONLY dict channels
  the adapter reads (``_resolve_decode_config``, whisper_cpp_asr.py:750-762), and
  the pass is selected per call by ``adapter(..., pass_kind="final")``.
* ``InferenceConfig.decode_base`` is NOT read by this adapter — see ``--help`` and
  the lane report. Everything a sweep wants to vary is therefore written into the
  chosen pass block.
* Keys are matched FLATTENED (lowercased, ``_``/``-`` dropped) against
  ``_WIRE_TO_ENGINE_PARAM`` (whisper_cpp_asr.py:470-481), so the wire spelling
  (``entropyThreshold``, ``logprobThreshold``, ``singleSegment``, ``maxTokens``,
  ``audioCtx``, ``suppressBlank``, ``suppressNst`` /
  ``suppressNonSpeechTokens``, ``noSpeechThreshold``, ``temperature``,
  ``wordTimestamps``) is what this script sends.

The audio is real clinical/lecture recording of a named clinician: it is never
copied anywhere, and stdout carries progress + scores only.

Usage:
    <conda python> mlen_chunk_sweep.py --clips-dir <dir> --out-dir <dir> \
        [--models f16,q8_0] [--windows 7,3] [--param-set NAME=JSON] ...
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import re
import signal
import statistics
import sys
import time
from pathlib import Path
from typing import Any

# --- where the repo is -------------------------------------------------------
# Resolved from the environment so a spawned worker (which re-imports THIS file
# before any initializer runs) sees the same answer as the parent.
DEFAULT_STT_APP_DIR = str(Path(__file__).resolve().parents[1])  # apps/stt, wherever the checkout is

_MODEL_REPO_DIR = "models--taphuynh--whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF"
_MODEL_FILES: dict[str, str] = {
    "f16": "ggml-whisper-turbo-ml-en-codeswitch-f16.bin",
    "q8_0": "ggml-whisper-turbo-ml-en-codeswitch-q8_0.bin",
    "q5_0": "ggml-whisper-turbo-ml-en-codeswitch-q5_0.bin",
}


def _hf_cache_dir() -> Path:
    """The HF-style cache the STT runtime reads: ``HOPE_HF_CACHE``, else ``HF_HOME``,
    else ``~/.cache/hope-hf`` (the local-dev default)."""
    for var in ("HOPE_HF_CACHE", "HF_HOME"):
        value = os.environ.get(var)
        if value:
            return Path(value).expanduser()
    return Path("~/.cache/hope-hf").expanduser()


def _default_model_path(alias: str) -> str | None:
    """Latest cached snapshot of the codeswitch GGUF for ``alias``; ``None`` when absent
    (``--model-path alias=path`` then names it explicitly)."""
    filename = _MODEL_FILES.get(alias)
    if filename is None:
        return None
    hits = sorted((_hf_cache_dir() / _MODEL_REPO_DIR / "snapshots").glob(f"*/{filename}"))
    return str(hits[-1]) if hits else None


DEFAULT_MODEL_PATHS: dict[str, str] = {
    alias: path for alias in _MODEL_FILES if (path := _default_model_path(alias)) is not None
}
#: For the record only — the catalog slug each GGUF is served under.
MODEL_SLUGS: dict[str, str] = {
    "f16": "arcaai-whisper-large-ml-en-gguf",
    "q8_0": "arcaai-whisper-large-ml-en-gguf-q8_0",
    "q5_0": "arcaai-whisper-large-ml-en-gguf-q5_0",
}

MAX_WORKERS = 4


def _stt_app_dir() -> Path:
    return Path(os.environ.get("HOPE_STT_APP_DIR", DEFAULT_STT_APP_DIR))


def _ensure_repo_importable() -> None:
    """Put ``apps/stt/src`` and ``apps/stt/scripts`` on ``sys.path``, idempotently."""
    app = _stt_app_dir()
    for entry in (str(app / "src"), str(app / "scripts")):
        if entry not in sys.path:
            sys.path.insert(0, entry)


def _repo_helpers() -> dict[str, Any]:
    """The repo's OWN scoring/IO helpers — imported, never re-implemented."""
    _ensure_repo_importable()
    import mlen_scorecard  # the committed offline driver

    from stt.pipeline.language_modes import latin_letter_ratio

    return {
        "cer": mlen_scorecard.cer,
        "norm": mlen_scorecard._norm,
        "read_wav": mlen_scorecard._read_wav,
        "latin_letter_ratio": latin_letter_ratio,
    }


# --- clip discovery ----------------------------------------------------------


def _detect_layout(clips_dir: Path) -> str:
    if list(clips_dir.glob("*/audio.wav")):
        return "woodman"
    return "mlen"


def _discover_woodman(clips_dir: Path) -> list[dict[str, str]]:
    """``<NNNN_start_end>/{audio.wav,transcript.txt}``. Dirs without audio are skipped."""
    clips: list[dict[str, str]] = []
    for sub in sorted(p for p in clips_dir.iterdir() if p.is_dir()):
        wav, ref = sub / "audio.wav", sub / "transcript.txt"
        if not wav.is_file() or not ref.is_file():
            continue
        match = re.match(r"(\d+)", sub.name)
        clips.append(
            {
                "clip_id": match.group(1) if match else sub.name,
                "wav": str(wav),
                "ref": str(ref),
            }
        )
    return clips


def _discover_mlen(clips_dir: Path) -> list[dict[str, str]]:
    """``<id>.wav`` + ``<id>-label.txt`` — the ``mlen_scorecard.py`` layout."""
    _ensure_repo_importable()
    import mlen_scorecard

    return [
        {"clip_id": cid, "wav": wav, "ref": label}
        for cid, wav, label in mlen_scorecard._discover(str(clips_dir))
    ]


def discover_clips(clips_dir: Path, layout: str) -> list[dict[str, str]]:
    resolved = _detect_layout(clips_dir) if layout == "auto" else layout
    clips = _discover_woodman(clips_dir) if resolved == "woodman" else _discover_mlen(clips_dir)
    return sorted(clips, key=lambda c: c["clip_id"])


# --- worker ------------------------------------------------------------------

_WORKER: dict[str, Any] = {}


class _TimedModel:
    """Pass-through proxy over ``pywhispercpp.model.Model`` that TIMES each decode.

    Instrumentation only: ``transcribe`` forwards its arguments untouched and
    returns the engine's own result, so no adapter behaviour changes. It exists
    because the adapter decodes each span internally, and per-span latency is the
    quantity the geometry sweep is measuring. It also records the LAST kwargs the
    adapter passed, which is what ``--dump-kwargs`` prints.

    A Metal-poison recovery replaces ``LoadedModel.model`` with a fresh ``Model``
    (whisper_cpp_asr.py:1250), which drops this proxy — timings for the rest of
    that process are then lost. It is recorded in the row as ``proxy_lost``.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.spans_ms: list[float] = []
        self.last_kwargs: dict[str, Any] | None = None

    def transcribe(self, audio: Any, **kwargs: Any) -> Any:
        self.last_kwargs = dict(kwargs)
        started = time.perf_counter()
        try:
            return self._inner.transcribe(audio, **kwargs)
        finally:
            self.spans_ms.append((time.perf_counter() - started) * 1000.0)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _worker_init(cfg: dict[str, Any]) -> None:
    # SIGINT belongs to the parent: a worker that raises KeyboardInterrupt mid
    # decode leaves the pool wedged instead of shutting down cleanly.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    _ensure_repo_importable()
    from stt.pipeline import language_modes

    # Module state does not cross a spawn boundary — set the priming-prompt
    # switches HERE or the worker silently decodes at the defaults.
    language_modes.WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED = cfg["pair_priming_prompt"]
    language_modes.WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED = cfg["single_priming_prompt"]
    _WORKER.clear()
    _WORKER.update(
        cfg=cfg,
        models={},
        adapters={},
        helpers=_repo_helpers(),
        dumped=set(),
        resolved=_resolve_language(cfg["language_mode"], cfg["agent_prompt"]),
    )


def _resolve_language(mode_id: str, agent_prompt: str | None) -> dict[str, Any]:
    """Mode id -> (decode language, composed initial prompt), the session's own way."""
    _ensure_repo_importable()
    from stt.core.initial_prompt import compose_prompt
    from stt.pipeline import language_modes
    from stt.pipeline.dto import AiModelFormat

    try:
        resolved = language_modes.resolve_mode_for_engine(mode_id, AiModelFormat.WHISPER_CPP)
        language, priming = resolved.language, resolved.initial_prompt
    except (KeyError, language_modes.LanguageModeUnsupportedError):
        # Not a catalog mode id (a raw "ml-IN"): hand it to the adapter as-is,
        # exactly as mlen_scorecard.py does.
        language, priming = mode_id, None
    # The language mode's priming prompt is composed AHEAD of the agent's own
    # instruction (whisper_cpp_asr.py:82-88).
    return {"language": language, "prompt": compose_prompt(priming, agent_prompt)}


def _loaded_model(alias: str) -> Any:
    loaded = _WORKER["models"].get(alias)
    if loaded is not None:
        return loaded
    _ensure_repo_importable()
    from pywhispercpp.model import Model

    from stt.models.base_loader import LoadedModel
    from stt.pipeline.dto import AiModelFormat

    cfg = _WORKER["cfg"]
    path = cfg["model_paths"][alias]
    # Same construction as whisper_cpp_asr._construct_whisper_model / mlen_scorecard.
    model = Model(
        model=path,
        context_params={"use_gpu": True},
        print_progress=False,
        print_realtime=False,
        n_threads=cfg["num_threads"],
    )
    loaded = LoadedModel(
        model_id=f"sweep-{alias}-{os.getpid()}",
        model_slug=MODEL_SLUGS.get(alias, alias),
        model=_TimedModel(model),
        format=AiModelFormat.WHISPER_CPP,
        device="auto",
        extra={"model_path": path, "num_threads": cfg["num_threads"]},
    )
    _WORKER["models"][alias] = loaded
    return loaded


def _build_inference_config(param_block: dict[str, Any]) -> Any:
    """A REAL ``InferenceConfig`` carrying *param_block* on the swept pass.

    The four fields pinned below are pinned so a DEFAULT run stamps nothing on
    ``adapter.unsupported_decode_knobs``: the dataclass defaults (``beam_size=5``,
    ``compression_ratio_threshold=2.4``, ``no_repeat_ngram_size=3``) are knobs
    whisper.cpp cannot honour and would be reported as configured-but-refused.
    """
    _ensure_repo_importable()
    from stt.pipeline.dto import InferenceConfig

    cfg = _WORKER["cfg"]
    kwargs: dict[str, Any] = {
        "language": _WORKER["resolved"]["language"],
        # 0.0 = no window on the INSTANCE; every call passes its own window.
        "max_decode_window_sec": 0.0,
        "temperature": [0.0],
        "beam_size": 1,
        "compression_ratio_threshold": None,
        "no_repeat_ngram_size": 0,
        "condition_on_prev_tokens": False,
        "hotwords": [],
        "hotwords_in_prompt": False,
    }
    if param_block:
        kwargs["decode_partial" if cfg["pass_kind"] == "partial" else "decode_final"] = dict(
            param_block
        )
    return InferenceConfig(**kwargs)


def _adapter(alias: str, param_set: str) -> Any:
    key = (alias, param_set)
    adapter = _WORKER["adapters"].get(key)
    if adapter is not None:
        return adapter
    _ensure_repo_importable()
    from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter

    cfg = _WORKER["cfg"]
    adapter = WhisperCppAsrAdapter(
        _loaded_model(alias),
        _build_inference_config(cfg["param_sets"][param_set]),
        want_word_timestamps=False,
    )
    _WORKER["adapters"][key] = adapter
    return adapter


def _script_stats(text: str) -> tuple[float, int]:
    ratio = _WORKER["helpers"]["latin_letter_ratio"](text)
    return round(float(ratio), 4), sum(1 for ch in text if ch.isalpha())


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(pct * len(ordered)) - 1))
    return round(ordered[index], 2)


def _run_job(job: dict[str, Any]) -> dict[str, Any]:
    """Decode ONE (model, window, param_set, clip) tuple. Never raises."""
    cfg = _WORKER["cfg"]
    helpers = _WORKER["helpers"]
    row: dict[str, Any] = {
        "model": job["model"],
        "model_slug": MODEL_SLUGS.get(job["model"], job["model"]),
        "window": job["window"],
        "param_set": job["param_set"],
        "clip_id": job["clip_id"],
        "language_mode": cfg["language_mode"],
        "pass_kind": cfg["pass_kind"],
        "workers": cfg["workers"],
        "contended": cfg["workers"] > 1,
        "num_threads": cfg["num_threads"],
        "pid": os.getpid(),
        "ts": round(time.time(), 3),
    }
    try:
        adapter = _adapter(job["model"], job["param_set"])
        audio, sample_rate = helpers["read_wav"](job["wav"])
        ref = Path(job["ref"]).read_text(encoding="utf-8").strip()
        duration = len(audio) / float(sample_rate)
        window = float(job["window"])

        model = adapter._loaded.model
        proxy = model if isinstance(model, _TimedModel) else None
        if proxy is not None:
            proxy.spans_ms = []
        # Read-only: the adapter's own partition, so n_spans is what it will decode.
        n_spans = len(adapter._split_spans(audio, sample_rate, window))

        started = time.perf_counter()
        result = adapter(
            audio,
            sample_rate,
            prompt=_WORKER["resolved"]["prompt"],
            max_decode_window_sec=window,
            pass_kind=cfg["pass_kind"],
        )
        wall_ms = (time.perf_counter() - started) * 1000.0

        hyp = result.get("text", "")
        spans_ms = [round(v, 2) for v in (proxy.spans_ms if proxy is not None else [])]
        decode_ms_total = round(sum(spans_ms), 2) if spans_ms else round(wall_ms, 2)
        segments = result.get("segments") or []
        probs = [
            float(s["probability"])
            for s in segments
            if isinstance(s, dict) and isinstance(s.get("probability"), (int, float))
        ]
        ref_norm, hyp_norm = helpers["norm"](ref), helpers["norm"](hyp)
        ref_latin, ref_letters = _script_stats(ref_norm)
        hyp_latin, hyp_letters = _script_stats(hyp_norm)
        row.update(
            duration_s=round(duration, 2),
            cer=round(helpers["cer"](ref, hyp), 4),
            ref_chars=len(ref_norm),
            hyp_chars=len(hyp_norm),
            yield_ratio=round(len(hyp_norm) / max(1, len(ref_norm)), 4),
            ref_latin_ratio=ref_latin,
            hyp_latin_ratio=hyp_latin,
            ref_letters=ref_letters,
            hyp_letters=hyp_letters,
            n_spans=n_spans,
            n_transcribe_calls=len(spans_ms),
            n_empty_span_retries=max(0, len(spans_ms) - n_spans),
            decode_ms_total=decode_ms_total,
            decode_ms_spans=spans_ms,
            decode_ms_per_span_max=round(max(spans_ms), 2) if spans_ms else None,
            wall_ms=round(wall_ms, 2),
            rtf=round((decode_ms_total / 1000.0) / duration, 4) if duration else None,
            language=result.get("language"),
            n_segments=len(segments),
            mean_segment_probability=round(sum(probs) / len(probs), 4) if probs else None,
            unsupported_decode_knobs=sorted(adapter.unsupported_decode_knobs),
            proxy_lost=proxy is None,
            hyp=hyp,
        )
        if cfg["include_ref"]:
            row["ref"] = ref
        if cfg["dump_kwargs"]:
            key = (job["model"], job["param_set"])
            if key not in _WORKER["dumped"] and proxy is not None and proxy.last_kwargs:
                _WORKER["dumped"].add(key)
                row["transcribe_kwargs"] = {
                    k: (v if isinstance(v, (str, int, float, bool, type(None))) else str(v))
                    for k, v in proxy.last_kwargs.items()
                }
    except Exception as exc:  # noqa: BLE001 — one clip must never stop the sweep
        row["error"] = f"{type(exc).__name__}: {exc}"
    return row


# --- parent ------------------------------------------------------------------


def _parse_param_sets(pairs: list[str], include_default: bool) -> dict[str, dict[str, Any]]:
    sets: dict[str, dict[str, Any]] = {"default": {}} if include_default else {}
    for pair in pairs:
        if "=" not in pair:
            raise SystemExit(f"--param-set expects NAME=JSON, got {pair!r}")
        name, raw = pair.split("=", 1)
        try:
            block = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--param-set {name}: invalid JSON ({exc})") from exc
        if not isinstance(block, dict):
            raise SystemExit(f"--param-set {name}: JSON must be an object")
        sets[name.strip()] = block
    if not sets:
        raise SystemExit("no param sets: pass --param-set or drop --no-default-set")
    return sets


def _done_keys(runs_path: Path) -> set[tuple[str, str, str, str]]:
    done: set[tuple[str, str, str, str]] = set()
    if not runs_path.is_file():
        return done
    for line in runs_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("error"):
            continue  # a failed tuple is re-attempted on resume
        done.add(
            (
                str(row.get("model")),
                str(row.get("window")),
                str(row.get("param_set")),
                str(row.get("clip_id")),
            )
        )
    return done


def _summarize(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[tuple[str, float, str], list[dict[str, Any]]] = {}
    for row in rows:
        buckets.setdefault((row["model"], float(row["window"]), row["param_set"]), []).append(row)

    out: list[dict[str, Any]] = []
    for (model, window, param_set), group in sorted(buckets.items()):
        ok = [r for r in group if not r.get("error")]
        cers = [r["cer"] for r in ok]
        spans = [ms for r in ok for ms in (r.get("decode_ms_spans") or [])]
        latin_delta = [abs(r["hyp_latin_ratio"] - r["ref_latin_ratio"]) for r in ok]
        worst = max(ok, key=lambda r: r["cer"]) if ok else None
        out.append(
            {
                "model": model,
                "window": window,
                "param_set": param_set,
                "n_clips": len(group),
                "n_ok": len(ok),
                "error_count": len(group) - len(ok),
                "mean_cer": round(statistics.fmean(cers), 4) if cers else None,
                "median_cer": round(statistics.median(cers), 4) if cers else None,
                "worst_cer": round(max(cers), 4) if cers else None,
                "worst_clip": worst["clip_id"] if worst else None,
                "mean_yield_ratio": (
                    round(statistics.fmean([r["yield_ratio"] for r in ok]), 4) if ok else None
                ),
                "mean_abs_latin_delta": (
                    round(statistics.fmean(latin_delta), 4) if latin_delta else None
                ),
                "mean_rtf": (
                    round(statistics.fmean([r["rtf"] for r in ok if r.get("rtf")]), 4)
                    if any(r.get("rtf") for r in ok)
                    else None
                ),
                "mean_decode_ms": (
                    round(statistics.fmean([r["decode_ms_total"] for r in ok]), 1) if ok else None
                ),
                "p95_span_ms": _percentile(spans, 0.95),
                "max_span_ms": round(max(spans), 2) if spans else None,
                "mean_spans_per_clip": (
                    round(statistics.fmean([r["n_spans"] for r in ok]), 2) if ok else None
                ),
                "empty_hyp_count": sum(1 for r in ok if not (r.get("hyp") or "").strip()),
                "contended": any(r.get("contended") for r in group),
            }
        )
    return out


def _summary_markdown(summary: list[dict[str, Any]], meta: dict[str, Any]) -> str:
    latency_note = (
        "SERIAL (workers=1) — authoritative latency"
        if meta["workers"] == 1
        else f"CONTENDED (workers={meta['workers']}) — latency is NOT authoritative; "
        "re-run with --serial-latency"
    )
    lines = [
        "# mlen chunk sweep",
        "",
        f"- clips dir: `{meta['clips_dir']}`  ({meta['n_clips']} clips)",
        f"- language mode: `{meta['language_mode']}` -> decode language "
        f"`{meta['decode_language']}`; prompt: "
        f"{'set (' + str(meta['prompt_chars']) + ' chars)' if meta['prompt_chars'] else 'none'}",
        f"- priming prompts: pair={meta['pair_priming_prompt']}, "
        f"single={meta['single_priming_prompt']}",
        f"- pass kind: `{meta['pass_kind']}`; threads/decode: {meta['num_threads']}",
        f"- latency regime: **{latency_note}**",
        "",
        "| model | window | param set | n | mean CER | med CER | worst CER (clip) | "
        "mean yield | mean latin delta | mean RTF | p95 span ms | empty | err |",
        "|---|---:|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|",
    ]
    for entry in summary:
        lines.append(
            "| {model} | {window} | {param_set} | {n_ok} | {mean_cer} | {median_cer} | "
            "{worst_cer} ({worst_clip}) | {mean_yield_ratio} | {mean_abs_latin_delta} | "
            "{mean_rtf} | {p95_span_ms} | {empty_hyp_count} | {error_count} |".format(**entry)
        )
    lines += ["", "## param sets", "", "```json", json.dumps(meta["param_sets"], indent=2), "```"]
    return "\n".join(lines) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mlen_chunk_sweep.py",
        description=(
            "Sweep whisper.cpp decode-chunk geometry (max_decode_window_sec) and decode "
            "hyper-parameters over a labeled ml-en clip set, through the real "
            "WhisperCppAsrAdapter, up to 4 decodes concurrently."
        ),
        epilog=(
            "Decode params reach the engine through InferenceConfig.decode_final / "
            "decode_partial ONLY (selected by --pass-kind); InferenceConfig.decode_base is "
            "not read by this adapter. Wire spellings: entropyThreshold, logprobThreshold, "
            "noSpeechThreshold, singleSegment, suppressBlank, suppressNst, maxTokens, "
            "audioCtx, temperature, wordTimestamps. beamSize / compressionRatioThreshold / "
            "noRepeatNgramSize / conditionOnPrevTokens cannot reach whisper.cpp and are "
            "reported per row as unsupported_decode_knobs."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--clips-dir", required=True, help="directory of labeled clips")
    parser.add_argument("--out-dir", required=True, help="writes runs.jsonl, summary.{md,json}")
    parser.add_argument(
        "--layout",
        choices=("auto", "woodman", "mlen"),
        default="auto",
        help="woodman = <id_start_end>/{audio.wav,transcript.txt}; mlen = <id>.wav + <id>-label.txt",
    )
    parser.add_argument("--limit", type=int, default=None, help="use only the first N clips")
    parser.add_argument("--clip-ids", default=None, help="comma-separated subset, e.g. 0001,0002")
    parser.add_argument("--models", default="f16,q8_0", help="aliases: f16, q8_0, q5_0")
    parser.add_argument(
        "--model-path",
        action="append",
        default=[],
        metavar="ALIAS=PATH",
        help="override/add a GGUF path for an alias (repeatable)",
    )
    parser.add_argument(
        "--windows",
        default="0.5,1,2,3,5,7,10,13,15,20,25,30",
        help="max_decode_window_sec values; 0 = no split guard",
    )
    parser.add_argument(
        "--language-mode",
        default="ml-en",
        help="catalog mode id resolved through resolve_mode_for_engine (ml-en|auto|en|ml)",
    )
    parser.add_argument(
        "--pair-priming-prompt",
        action="store_true",
        help="enable the BILINGUAL priming prompt (measured harmful in TASK-985 2.7)",
    )
    parser.add_argument(
        "--single-priming-prompt",
        action="store_true",
        help="enable the SINGLE-LANGUAGE priming prompt",
    )
    parser.add_argument(
        "--agent-prompt",
        default=None,
        help="agent instruction.initialPrompt, composed after any priming prompt",
    )
    parser.add_argument(
        "--param-set",
        action="append",
        default=[],
        metavar="NAME=JSON",
        help='repeatable, e.g. gates_off=\'{"entropyThreshold":1e9,"logprobThreshold":-1e9}\'',
    )
    parser.add_argument(
        "--no-default-set", action="store_true", help="drop the implicit empty 'default' set"
    )
    parser.add_argument(
        "--pass-kind",
        choices=("final", "partial"),
        default="final",
        help="which per-pass decode block carries the param set",
    )
    parser.add_argument("--num-threads", type=int, default=4, help="whisper.cpp n_threads")
    parser.add_argument(
        "--workers", type=int, default=4, help=f"concurrent decode processes (max {MAX_WORKERS})"
    )
    parser.add_argument(
        "--serial-latency",
        action="store_true",
        help="force workers=1 so the recorded latency is uncontended/authoritative",
    )
    parser.add_argument(
        "--resume", action="store_true", help="skip tuples already present in runs.jsonl"
    )
    parser.add_argument(
        "--dump-kwargs",
        action="store_true",
        help="print the exact model.transcribe kwargs once per (model, param set)",
    )
    parser.add_argument(
        "--include-ref", action="store_true", help="store the reference text in runs.jsonl too"
    )
    parser.add_argument(
        "--stt-app-dir", default=None, help=f"apps/stt checkout (default {DEFAULT_STT_APP_DIR})"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.stt_app_dir:
        os.environ["HOPE_STT_APP_DIR"] = args.stt_app_dir
    _ensure_repo_importable()

    clips_dir = Path(args.clips_dir).expanduser()
    clips = discover_clips(clips_dir, args.layout)
    if args.clip_ids:
        wanted = {c.strip() for c in args.clip_ids.split(",") if c.strip()}
        clips = [c for c in clips if c["clip_id"] in wanted]
    if args.limit:
        clips = clips[: args.limit]
    if not clips:
        print(f"no labeled clips found in {clips_dir}", file=sys.stderr)
        return 2

    model_paths = dict(DEFAULT_MODEL_PATHS)
    for override in args.model_path:
        alias, _, path = override.partition("=")
        if not path:
            raise SystemExit(f"--model-path expects ALIAS=PATH, got {override!r}")
        model_paths[alias.strip()] = path
    aliases = [a.strip() for a in args.models.split(",") if a.strip()]
    for alias in aliases:
        if alias not in model_paths:
            raise SystemExit(f"unknown model alias {alias!r}; known: {sorted(model_paths)}")
        if not Path(model_paths[alias]).is_file():
            raise SystemExit(f"GGUF missing for {alias}: {model_paths[alias]}")

    windows = [float(w) for w in args.windows.split(",") if w.strip()]
    param_sets = _parse_param_sets(args.param_set, not args.no_default_set)
    workers = 1 if args.serial_latency else max(1, min(MAX_WORKERS, args.workers))

    out_dir = Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    runs_path = out_dir / "runs.jsonl"
    done = _done_keys(runs_path) if args.resume else set()

    # Jobs ordered model-major so every job for one model is contiguous and a
    # worker reloads weights as rarely as possible.
    jobs: list[dict[str, Any]] = []
    for alias in aliases:
        for window in windows:
            for param_set in param_sets:
                for clip in clips:
                    key = (alias, str(window), param_set, clip["clip_id"])
                    if key in done:
                        continue
                    jobs.append(
                        {
                            "model": alias,
                            "window": window,
                            "param_set": param_set,
                            "clip_id": clip["clip_id"],
                            "wav": clip["wav"],
                            "ref": clip["ref"],
                        }
                    )

    resolved = _resolve_language(args.language_mode, args.agent_prompt)
    cfg = {
        "model_paths": model_paths,
        "param_sets": param_sets,
        "language_mode": args.language_mode,
        "agent_prompt": args.agent_prompt,
        "pair_priming_prompt": args.pair_priming_prompt,
        "single_priming_prompt": args.single_priming_prompt,
        "pass_kind": args.pass_kind,
        "num_threads": args.num_threads,
        "workers": workers,
        "dump_kwargs": args.dump_kwargs,
        "include_ref": args.include_ref,
    }
    print(
        f"[sweep] {len(jobs)} jobs ({len(aliases)} models x {len(windows)} windows x "
        f"{len(param_sets)} sets x {len(clips)} clips); skipped {len(done)} done; "
        f"workers={workers} threads={args.num_threads} pass={args.pass_kind}",
        file=sys.stderr,
    )

    rows: list[dict[str, Any]] = []
    if jobs:
        ctx = mp.get_context("spawn")
        pool = ctx.Pool(processes=workers, initializer=_worker_init, initargs=(cfg,))
        total = len(jobs)
        try:
            with runs_path.open("a", encoding="utf-8") as sink:
                for index, row in enumerate(pool.imap_unordered(_run_job, jobs, chunksize=1), 1):
                    sink.write(json.dumps(row, ensure_ascii=False) + "\n")
                    sink.flush()
                    rows.append(row)
                    if row.get("error"):
                        detail = f"ERROR {row['error']}"
                    else:
                        detail = (
                            f"cer={row['cer']:.3f} yield={row['yield_ratio']:.2f} "
                            f"latin={row['hyp_latin_ratio']:.2f} spans={row['n_spans']} "
                            f"ms={row['decode_ms_total']:.0f}"
                        )
                    print(
                        f"[{index}/{total}] model={row['model']} window={row['window']} "
                        f"set={row['param_set']} clip={row['clip_id']} {detail}",
                        file=sys.stderr,
                    )
                    if "transcribe_kwargs" in row:
                        print(
                            f"[kwargs] model={row['model']} set={row['param_set']} "
                            f"{json.dumps(row['transcribe_kwargs'], sort_keys=True)}",
                            file=sys.stderr,
                        )
            pool.close()
            pool.join()
        except KeyboardInterrupt:
            pool.terminate()
            pool.join()
            print("[sweep] interrupted — partial results are in runs.jsonl", file=sys.stderr)
        finally:
            del pool

    # The summary always covers the WHOLE file, so --resume runs summarize everything.
    all_rows = [
        json.loads(line)
        for line in runs_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    summary = _summarize(all_rows)
    meta = {
        "clips_dir": str(clips_dir),
        "n_clips": len(clips),
        "language_mode": args.language_mode,
        "decode_language": resolved["language"],
        "prompt_chars": len(resolved["prompt"] or ""),
        "pair_priming_prompt": args.pair_priming_prompt,
        "single_priming_prompt": args.single_priming_prompt,
        "pass_kind": args.pass_kind,
        "num_threads": args.num_threads,
        "workers": workers,
        "serial_latency": args.serial_latency,
        "param_sets": param_sets,
        "models": {a: model_paths[a] for a in aliases},
        "windows": windows,
        "rows_in_file": len(all_rows),
        "rows_this_run": len(rows),
    }
    (out_dir / "summary.json").write_text(
        json.dumps({"meta": meta, "summary": summary}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out_dir / "summary.md").write_text(_summary_markdown(summary, meta), encoding="utf-8")
    print(_summary_markdown(summary, meta))
    print(f"[sweep] wrote {runs_path}, summary.json, summary.md", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
