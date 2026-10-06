"""Shared pure helpers for the TASK-1047 validation tools (V2/V3/V4).

Stdlib only. Everything here is network-free except the thin `rss_mib` / `pid_for_port`
process probes (``ps`` / ``lsof``). Synthetic text only - no patient data.
"""

from __future__ import annotations

import math
import os
import re
import subprocess
from collections import defaultdict
from pathlib import Path

DEFAULT_TENANT = "50000000-0000-0000-0000-000000000001"  # test tenant, overridable (--tenant-id)

# --- math -------------------------------------------------------------------


def percentile(values: list[float], pct: float) -> float:
    """Linear-interpolated percentile (pct in 0..100). Empty -> nan."""
    if not values:
        return float("nan")
    xs = sorted(values)
    if len(xs) == 1:
        return xs[0]
    k = (len(xs) - 1) * pct / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def drift_pct(samples: list[tuple[float, float]], window_s: float) -> float:
    """RSS drift: mean(last `window_s`) vs mean(first `window_s`), in percent.

    `samples` = [(t_seconds, value)]. The window is clamped to a third of the span so
    short smoke runs never compare overlapping halves. nan when not computable.
    """
    if len(samples) < 2:
        return float("nan")
    t0, t1 = samples[0][0], samples[-1][0]
    w = min(window_s, (t1 - t0) / 3.0)
    if w <= 0:
        return float("nan")
    first = [v for t, v in samples if t - t0 <= w]
    last = [v for t, v in samples if t1 - t <= w]
    if not first or not last:
        return float("nan")
    a, b = sum(first) / len(first), sum(last) / len(last)
    return (b - a) / a * 100.0 if a else float("nan")


def window_starts(length: int, size: int, overlap: int) -> list[int]:
    """Start offsets of region-aligned windows cut from the region's start (FC-5)."""
    if size <= 0:
        raise ValueError("window size must be > 0")
    if overlap < 0 or overlap >= size:
        raise ValueError("overlap must be in [0, size)")
    if length <= size:
        return [0]
    stride = size - overlap
    starts, s = [], 0
    while True:
        starts.append(s)
        if s + size >= length:
            return starts
        s += stride


def split_windows(text: str, size: int, overlap: int) -> list[tuple[int, str]]:
    return [(s, text[s : s + size]) for s in window_starts(len(text), size, overlap)]


def window_count(length: int, size: int, overlap: int) -> int:
    return len(window_starts(length, size, overlap))


def parse_size(token: str) -> int:
    """'4k' -> 4000, '200k' -> 200000, '8192' -> 8192."""
    t = token.strip().lower()
    mult = 1000 if t.endswith("k") else 1
    return int(float(t[:-1] if mult == 1000 else t) * mult)


def parse_sizes(csv: str) -> list[int]:
    return [parse_size(p) for p in csv.split(",") if p.strip()]


# --- Prometheus text ---------------------------------------------------------

_PROM_LINE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([-+0-9.eE]+|NaN|[+-]Inf)\s*$")


def parse_prometheus(text: str) -> dict[str, float]:
    """Sum every sample of a metric across its label sets -> {name: total}."""
    out: dict[str, float] = defaultdict(float)
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        m = _PROM_LINE.match(line)
        if m:
            try:
                out[m.group(1)] += float(m.group(3))
            except ValueError:
                continue
    return dict(out)


def prom_delta(before: dict[str, float], after: dict[str, float], name: str) -> float | None:
    """after-before for a counter; None when the metric is absent from `after`."""
    if name not in after:
        return None
    return after[name] - before.get(name, 0.0)


# --- process probes ----------------------------------------------------------


def rss_mib(pid: int) -> float:
    out = subprocess.run(
        ["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, check=False
    ).stdout.strip()
    return int(out) / 1024 if out else 0.0


def cpu_pct(pid: int) -> float:
    out = subprocess.run(
        ["ps", "-o", "%cpu=", "-p", str(pid)], capture_output=True, text=True, check=False
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def pid_for_port(port: int) -> int | None:
    """PID LISTENing on a TCP port (lsof). Prefers the process that is not `conda run`."""
    out = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.split()
    return int(out[0]) if out else None


# --- secrets (never printed) -------------------------------------------------


def read_env_value(key: str, env_file: Path) -> str:
    """Value of KEY from an env file, '' if absent. Host env wins (repo contract)."""
    if os.environ.get(key):
        return os.environ[key]
    try:
        for line in env_file.read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def repo_root(start: Path) -> Path:
    for p in [start, *start.parents]:
        if (p / "pnpm-workspace.yaml").exists() or (p / ".git").exists():
            return p
    return start


def default_env_file(start: Path) -> Path:
    """.env.dev of this tree, else of the primary checkout (worktrees do not carry it)."""
    root = repo_root(start)
    cand = root / ".env.dev"
    if cand.exists():
        return cand
    # worktree: <primary>/.claude/worktrees/x or sibling ../hope-v2
    for alt in (root.parent / "hope-v2" / ".env.dev",):
        if alt.exists():
            return alt
    return cand


# --- synthetic text ----------------------------------------------------------

_SPEECH = [
    "The patient reports a dull ache in the lower back that started three days ago.",
    "No fever, no chills, and the pain does not radiate down either leg.",
    "She has been taking paracetamol twice daily with partial relief.",
    "On examination the range of movement is mildly restricted on forward flexion.",
    "We discussed gentle stretching, heat packs and a review in two weeks.",
    "He asked whether a scan is needed and the doctor explained the usual red flags.",
    "Blood pressure was one hundred and twenty over eighty, pulse seventy two and regular.",
    "The plan is to continue current medication and arrange a follow up appointment.",
    "Sleep has been disturbed but appetite is normal and mood is reportedly fine.",
    "Allergies were confirmed as none known and the medication list was reviewed.",
]


def synth_text(n_chars: int, seed: int = 0) -> str:
    """Deterministic synthetic clinical-sounding text of exactly n_chars characters."""
    if n_chars <= 0:
        return ""
    parts, total, i = [], 0, seed
    while total < n_chars:
        s = _SPEECH[i % len(_SPEECH)] + f" ({i}) "
        parts.append(s)
        total += len(s)
        i += 1
    return "".join(parts)[:n_chars]


# --- golden-set scoring ------------------------------------------------------


def _iou(a: tuple[int, int], b: tuple[int, int]) -> float:
    inter = max(0, min(a[1], b[1]) - max(a[0], b[0]))
    union = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return inter / union if union > 0 else 0.0


def score_spans(gold: list[dict], pred: list[dict], iou_min: float = 0.5) -> tuple[int, int, int]:
    """(tp, fp, fn) with greedy one-to-one matching on same label and IoU >= iou_min."""
    used: set[int] = set()
    tp = 0
    for g in gold:
        best, best_i = 0.0, -1
        for i, p in enumerate(pred):
            if i in used or p["label"] != g["label"]:
                continue
            v = _iou((g["start"], g["end"]), (p["start"], p["end"]))
            if v >= iou_min and v > best:
                best, best_i = v, i
        if best_i >= 0:
            used.add(best_i)
            tp += 1
    return tp, len(pred) - tp, len(gold) - tp


def prf(tp: int, fp: int, fn: int) -> dict[str, float]:
    p = tp / (tp + fp) if tp + fp else 1.0
    r = tp / (tp + fn) if tp + fn else 1.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return {"precision": p, "recall": r, "f1": f}


def merge_window_spans(
    window_spans: list[tuple[int, list[dict]]], iou_min: float = 0.5
) -> list[dict]:
    """Shift each window's spans by its start offset and drop overlap duplicates."""
    merged: list[dict] = []
    for start, spans in window_spans:
        for sp in spans:
            cand = {**sp, "start": sp["start"] + start, "end": sp["end"] + start}
            dup = any(
                m["label"] == cand["label"]
                and _iou((m["start"], m["end"]), (cand["start"], cand["end"])) >= iou_min
                for m in merged
            )
            if not dup:
                merged.append(cand)
    return merged
