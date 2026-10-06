#!/usr/bin/env python3
"""TASK-1049 — evaluate injection classifiers on clinical data windows (offline, CPU).

Modes
  score    --sets DIR --scores DIR [--models a,b] [--threads N] [--force]
           Window every record (2,000 / 256, guardrail geometry), score every window,
           write <scores>/<model>.jsonl (records without text, plus `scores`) and
           <scores>/<model>.meta.json (revision, default threshold, wall time).
  latency  --sets DIR --model NAME --threads N --out FILE
           Run in a FRESH process per model: RSS after imports, after load, peak;
           single-window p50/p95 over 200 benign test windows; batch-8 throughput.
  report   --scores DIR [--latency DIR] --out FILE
           Thresholds (vendor default; dev-selected at 0.5 % and 1 % dev FP), test FP per
           window by set, recall per set / carrier / class, AUC, score overlap, §4.3 verdict.

Synthetic and public data only. Never starts or calls a HOPE service.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import re
import resource
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from injection_eval.analysis import (  # noqa: E402
    Criteria,
    auc,
    decide,
    record_recall,
    window_fp,
    window_fp_by_length,
)
from injection_eval.core import iter_windows, select_threshold  # noqa: E402

WINDOW, OVERLAP = 2000, 256
BENIGN_GATE_SETS = {"a", "b1", "b2"}  # the < 1 % bar is judged on these (clinical data)
DEV_BENIGN_SETS = {"b1", "b2"}
SET_ORDER = ("a", "b1", "b2", "b3", "c1", "c2")


def load_sets(sets_dir: Path) -> list[dict]:
    records: list[dict] = []
    for name in SET_ORDER:
        path = sets_dir / f"{name}.jsonl"
        if not path.exists():
            print(f"[warn] missing set {path}", file=sys.stderr)
            continue
        with path.open() as fh:
            records.extend(json.loads(line) for line in fh if line.strip())
    return records


def _rss_mib() -> float:
    # macOS reports ru_maxrss in bytes, Linux in KiB.
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024


def _current_rss_mib() -> float:
    import psutil

    return psutil.Process().memory_info().rss / (1024 * 1024)


# ------------------------------------------------------------------ memory safety
# 2026-10-06: the dev Mac was force-restarted (reset cause `btn_rst`, no panic) while a
# scoring run, LM Studio and the dev stack shared memory. Every model load is now gated
# on system free memory, and the process hard-stops itself above an RSS ceiling.


class MemoryGateError(RuntimeError):
    """Refusing to load a model: the system does not have enough free memory."""


def parse_free_pct(memory_pressure_output: str) -> int | None:
    match = re.search(r"memory free percentage:\s*(\d+)%", memory_pressure_output)
    return int(match.group(1)) if match else None


def _system_free_pct() -> int | None:
    try:
        out = subprocess.run(
            ["memory_pressure"], capture_output=True, text=True, timeout=30, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_free_pct(out)


def assert_free_memory(*, min_free_pct: int, reader=_system_free_pct) -> None:
    free = reader()
    if free is None:
        raise MemoryGateError("system free memory is unknown; refusing to load a model")
    if free < min_free_pct:
        raise MemoryGateError(f"system memory free {free}% < {min_free_pct}%; refusing to load")


class RssGuard:
    """Samples this process's RSS (and, optionally, system free memory); calls
    `on_exceed` ONCE when RSS passes the ceiling or system free memory drops below
    `min_sys_free_pct` (whoever is using it: the stop protects the host)."""

    def __init__(
        self,
        *,
        ceiling_mib: float,
        reader,
        on_exceed,
        sys_free_reader=None,
        min_sys_free_pct: float = 0.0,
        swap_reader=None,
        max_swap_growth_mib: float = float("inf"),
    ) -> None:
        self.ceiling_mib = ceiling_mib
        self.reader = reader
        self.on_exceed = on_exceed
        self.sys_free_reader = sys_free_reader
        self.min_sys_free_pct = min_sys_free_pct
        self.swap_reader = swap_reader
        self.max_swap_growth_mib = max_swap_growth_mib
        self._swap_base: float | None = None
        self.peak_mib = 0.0
        self._fired = False

    def check(self) -> None:
        rss = self.reader()
        self.peak_mib = max(self.peak_mib, rss)
        low_system = (
            self.sys_free_reader is not None and self.sys_free_reader() < self.min_sys_free_pct
        )
        swap_grew = False
        if self.swap_reader is not None:
            swap = self.swap_reader()
            if self._swap_base is None:
                self._swap_base = swap
            swap_grew = swap - self._swap_base > self.max_swap_growth_mib
        if (rss > self.ceiling_mib or low_system or swap_grew) and not self._fired:
            self._fired = True
            self.on_exceed(rss)

    def start(self, interval_s: float = 0.2) -> threading.Thread:
        def loop() -> None:
            while True:
                self.check()
                time.sleep(interval_s)

        thread = threading.Thread(target=loop, daemon=True, name="rss-guard")
        thread.start()
        return thread


def _sys_available_pct() -> float:
    import psutil

    vm = psutil.virtual_memory()
    return 100.0 * vm.available / vm.total


def _swap_used_mib() -> float:
    import psutil

    return psutil.swap_memory().used / (1024 * 1024)


def _guard(a: argparse.Namespace) -> RssGuard:
    return RssGuard(
        ceiling_mib=a.max_rss_mib,
        reader=_current_rss_mib,
        on_exceed=_hard_stop,
        sys_free_reader=_sys_available_pct,
        min_sys_free_pct=a.min_sys_free_pct,
        swap_reader=_swap_used_mib,
        max_swap_growth_mib=a.max_swap_growth_mib,
    )


def _hard_stop(rss_mib: float) -> None:
    # Progress is already on disk (chunked .partial files); a re-run resumes.
    print(
        f"[ABORT] RSS {rss_mib:.0f} MiB above the ceiling; stopping to protect the host",
        file=sys.stderr,
        flush=True,
    )
    os._exit(3)


def _load_scorer(name: str, threads: int):
    from injection_eval.models import load_scorer

    return load_scorer(name, threads=threads)


# --------------------------------------------------------------------------- score
def _chunks(records: list[dict], chunk_windows: int):
    """Yield (records, windows-per-record) closing a chunk once it holds >= chunk_windows."""
    batch: list[tuple[dict, list[str]]] = []
    size = 0
    for r in records:
        ws = [w for _, w in iter_windows(r["text"], WINDOW, OVERLAP)]
        batch.append((r, ws))
        size += len(ws)
        if size >= chunk_windows:
            yield batch
            batch, size = [], 0
    if batch:
        yield batch


def cmd_score(a: argparse.Namespace) -> int:
    from injection_eval.models import CANDIDATES

    records = load_sets(Path(a.sets))
    out_dir = Path(a.scores)
    out_dir.mkdir(parents=True, exist_ok=True)
    names = a.models.split(",") if a.models else list(CANDIDATES)
    guard = _guard(a)
    guard.start()
    for name in names:
        target = out_dir / f"{name}.jsonl"
        partial = out_dir / f"{name}.jsonl.partial"
        if target.exists() and not a.force:
            print(f"[skip] {name}: {target} exists")
            continue
        done: set[str] = set()
        if partial.exists() and not a.force:
            done = {json.loads(line)["id"] for line in partial.read_text().splitlines() if line}
        elif partial.exists():
            partial.unlink()
        todo = [r for r in records if r["id"] not in done]
        assert_free_memory(min_free_pct=a.min_free_pct)
        started = time.perf_counter()
        scorer = _load_scorer(name, a.threads)
        load_s = time.perf_counter() - started
        n_windows = 0
        t0 = time.perf_counter()
        with partial.open("a") as fh:
            for chunk in _chunks(todo, a.chunk_windows):
                flat = [w for _, ws in chunk for w in ws]
                scored = scorer.score(flat, batch_size=a.batch_size)
                pos = 0
                for r, ws in chunk:
                    part = scored[pos : pos + len(ws)]
                    pos += len(ws)
                    row = {k: r[k] for k in ("id", "set", "split", "label", "meta")}
                    row["scores"] = [round(s.score, 6) for s in part]
                    row["segments"] = [s.n_segments for s in part]
                    row["lengths"] = [len(w) for w in ws]
                    fh.write(json.dumps(row) + "\n")
                fh.flush()
                n_windows += len(flat)
                print(f"[{name}] {n_windows} windows, rss {_current_rss_mib():.0f} MiB", flush=True)
        score_s = time.perf_counter() - t0
        by_id = {json.loads(line)["id"]: line for line in partial.read_text().splitlines() if line}
        target.write_text("".join(by_id[r["id"]] + "\n" for r in records))
        partial.unlink()
        meta = {
            "name": name,
            "hf_id": scorer.hf_id,
            "revision": scorer.revision,
            "default_threshold": scorer.default_threshold,
            "max_tokens": scorer.max_tokens,
            "threads": a.threads,
            "load_s": round(load_s, 2),
            "score_s": round(score_s, 2),
            "windows_scored_this_run": n_windows,
            "records": len(records),
            "peak_rss_mib": round(max(guard.peak_mib, _current_rss_mib()), 1),
        }
        (out_dir / f"{name}.meta.json").write_text(json.dumps(meta, indent=2))
        print(f"[done] {name}: {n_windows} windows in {score_s:.1f}s", flush=True)
        del scorer
        gc.collect()
    return 0


# ------------------------------------------------------------------------- latency
def cmd_latency(a: argparse.Namespace) -> int:
    import torch  # noqa: F401  (imports counted in the baseline)
    import transformers  # noqa: F401
    from injection_eval.models import load_scorer

    records = load_sets(Path(a.sets))
    benign = [
        w
        for r in records
        if r["set"] in BENIGN_GATE_SETS and r["split"] == "test" and r["label"] == 0
        for _, w in iter_windows(r["text"], WINDOW, OVERLAP)
    ]
    full = [w for w in benign if len(w) == WINDOW][: a.n]
    assert_free_memory(min_free_pct=a.min_free_pct)
    _guard(a).start()
    base_rss = _current_rss_mib()
    t0 = time.perf_counter()
    scorer = load_scorer(a.model, threads=a.threads)
    load_s = time.perf_counter() - t0
    loaded_rss = _current_rss_mib()
    for w in full[:10]:  # warm-up
        scorer.score([w], batch_size=1)
    lat: list[float] = []
    for w in full:
        t = time.perf_counter()
        scorer.score([w], batch_size=1)
        lat.append((time.perf_counter() - t) * 1000)
    t = time.perf_counter()
    scorer.score(full, batch_size=8)
    batch_s = time.perf_counter() - t
    steady_rss = _current_rss_mib()
    lat.sort()
    result = {
        "model": a.model,
        "threads": a.threads,
        "n_windows": len(full),
        "load_s": round(load_s, 2),
        "p50_ms": round(statistics.median(lat), 1),
        "p95_ms": round(lat[int(0.95 * (len(lat) - 1))], 1),
        "max_ms": round(lat[-1], 1),
        "batch8_windows_per_s": round(len(full) / batch_s, 2),
        "rss_baseline_mib": round(base_rss, 1),
        "rss_loaded_mib": round(loaded_rss, 1),
        "rss_steady_mib": round(steady_rss, 1),
        "rss_peak_mib": round(_rss_mib(), 1),
        "added_rss_mib": round(max(steady_rss, loaded_rss) - base_rss, 1),
        "added_peak_mib": round(_rss_mib() - base_rss, 1),
    }
    Path(a.out).write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
    return 0


def cmd_latency_all(a: argparse.Namespace) -> int:
    """One fresh interpreter per (model, threads) so RSS is not shared between models."""
    from injection_eval.models import CANDIDATES

    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    names = a.models.split(",") if a.models else list(CANDIDATES)
    for name in names:
        for threads in (int(t) for t in a.thread_set.split(",")):
            target = out / f"{name}.t{threads}.json"
            cmd = [
                sys.executable,
                __file__,
                "latency",
                "--sets",
                a.sets,
                "--model",
                name,
                "--threads",
                str(threads),
                "--n",
                str(a.n),
                "--out",
                str(target),
            ]
            print("[run]", name, threads, flush=True)
            subprocess.run(cmd, check=True)
    return 0


# -------------------------------------------------------------------------- report
def _load_scores(scores_dir: Path) -> dict[str, tuple[dict, list[dict]]]:
    out: dict[str, tuple[dict, list[dict]]] = {}
    for meta_path in sorted(scores_dir.glob("*.meta.json")):
        meta = json.loads(meta_path.read_text())
        rows_path = scores_dir / f"{meta['name']}.jsonl"
        with rows_path.open() as fh:
            out[meta["name"]] = (meta, [json.loads(line) for line in fh if line.strip()])
    return out


def _at_threshold(rows: list[dict], t: float) -> dict:
    fp = {s: window_fp(rows, threshold=t, sets={s}, split="test") for s in ("a", "b1", "b2")}
    gate_fp = window_fp(rows, threshold=t, sets=BENIGN_GATE_SETS, split="test")
    b3 = window_fp(rows, threshold=t, sets={"b3"}, split=None)
    c1_benign = window_fp(rows, threshold=t, sets={"c1"}, split=None)
    c2 = record_recall(rows, threshold=t, sets={"c2"}, split="test")
    c1 = record_recall(rows, threshold=t, sets={"c1"}, split=None)
    carriers = record_recall(rows, threshold=t, sets={"c2"}, split="test", by="carrier")
    classes = record_recall(rows, threshold=t, sets={"c2"}, split="test", by="class")
    worst = min((r.rate for r in carriers.values()), default=0.0)
    by_len = (
        window_fp_by_length(rows, threshold=t, sets=BENIGN_GATE_SETS, split="test")
        if all("lengths" in r for r in rows)
        else {}
    )
    return {
        "threshold": t,
        "fp_by_set": {k: _rate(v) for k, v in fp.items()},
        "fp_gate": _rate(gate_fp),
        "fp_gate_by_length": {k: _rate(v) for k, v in by_len.items()},
        "fp_notinject": _rate(b3),
        "fp_public_benign_prompts": _rate(c1_benign),
        "recall_c2": _recall(c2),
        "recall_c1": _recall(c1),
        "recall_c2_by_carrier": {k: _recall(v) for k, v in carriers.items()},
        "recall_c2_by_class": {k: _recall(v) for k, v in classes.items()},
        "worst_carrier_recall": worst,
    }


def _rate(r) -> dict:
    return {
        "flagged": r.flagged,
        "total": r.total,
        "rate": round(r.rate, 4),
        "upper95": round(r.upper, 4),
    }


def _recall(r) -> dict:
    return {
        "caught": r.caught,
        "total": r.total,
        "rate": round(r.rate, 4),
        "lower95": round(r.lower, 4),
    }


def cmd_report(a: argparse.Namespace) -> int:
    scores = _load_scores(Path(a.scores))
    latency_dir = Path(a.latency) if a.latency else None
    report: dict = {"criteria": Criteria().__dict__, "models": {}}
    for name, (meta, rows) in scores.items():
        dev_benign = [
            s
            for r in rows
            if r["set"] in DEV_BENIGN_SETS and r["split"] == "dev" and r["label"] == 0
            for s in r["scores"]
        ]
        benign_test = [
            s
            for r in rows
            if r["set"] in BENIGN_GATE_SETS and r["split"] == "test" and r["label"] == 0
            for s in r["scores"]
        ]
        attack_test = [max(r["scores"]) for r in rows if r["set"] == "c2" and r["split"] == "test"]
        thresholds = {
            "vendor_default": meta["default_threshold"],
            "dev_fp_0.5pct": select_threshold(dev_benign, 0.005) if dev_benign else None,
            "dev_fp_1pct": select_threshold(dev_benign, 0.01) if dev_benign else None,
        }
        at = {k: _at_threshold(rows, t) for k, t in thresholds.items() if t is not None}
        lat = {}
        if latency_dir:
            for p in sorted(latency_dir.glob(f"{name}.t*.json")):
                d = json.loads(p.read_text())
                lat[f"t{d['threads']}"] = d
        op = at.get("dev_fp_0.5pct") or at["vendor_default"]
        t4 = lat.get("t4", {})
        verdict = decide(
            fp_rate=op["fp_gate"]["rate"],
            fp_upper=op["fp_gate"]["upper95"],
            recall=op["recall_c2"]["rate"],
            recall_lower=op["recall_c2"]["lower95"],
            worst_carrier_recall=op["worst_carrier_recall"],
            p95_ms=t4.get("p95_ms"),
            added_rss_mib=t4.get("added_rss_mib"),
            criteria=Criteria(),
        )
        report["models"][name] = {
            "meta": meta,
            "auc_c2_vs_clinical_benign": round(auc(benign_test, attack_test), 4),
            "max_benign_test_score": max(benign_test, default=None),
            "min_attack_test_score": min(attack_test, default=None),
            "at": at,
            "latency": lat,
            "operating_point": "dev_fp_0.5pct" if "dev_fp_0.5pct" in at else "vendor_default",
            "verdict": verdict.__dict__,
        }
    Path(a.out).write_text(json.dumps(report, indent=2))
    print(render_markdown(report))
    return 0


def render_markdown(report: dict) -> str:
    lines = [
        "| Model | Threshold | FP/window a+b1+b2 (upper95) | FP a | FP b2 | NotInject FP | "
        "c2 recall (lower95) | worst carrier | c1 recall | AUC | p95 ms (4t) | +RSS MiB | Verdict |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for name, m in report["models"].items():
        for key, at in m["at"].items():
            t4 = m["latency"].get("t4", {})
            is_op = key == m["operating_point"]
            v = m["verdict"]
            verdict = (
                ("PASS" if v["passed"] else "FAIL" if v["failures"] else "pending") if is_op else ""
            )
            lines.append(
                f"| {name} | {key} {at['threshold']:.4f} | {at['fp_gate']['rate']:.2%} "
                f"({at['fp_gate']['upper95']:.2%}) | {at['fp_by_set']['a']['rate']:.2%} | "
                f"{at['fp_by_set']['b2']['rate']:.2%} | {at['fp_notinject']['rate']:.2%} | "
                f"{at['recall_c2']['rate']:.2%} ({at['recall_c2']['lower95']:.2%}) | "
                f"{at['worst_carrier_recall']:.2%} | {at['recall_c1']['rate']:.2%} | "
                f"{m['auc_c2_vs_clinical_benign']} | {t4.get('p95_ms', '—')} | "
                f"{t4.get('added_rss_mib', '—')} | {verdict} |"
            )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("score")
    s.add_argument("--sets", required=True)
    s.add_argument("--scores", required=True)
    s.add_argument("--models", default="")
    s.add_argument("--threads", type=int, default=4)
    s.add_argument("--batch-size", type=int, default=8)
    s.add_argument("--chunk-windows", type=int, default=128)
    s.add_argument("--max-rss-mib", type=float, default=4608)
    s.add_argument("--min-free-pct", type=int, default=35)
    s.add_argument("--min-sys-free-pct", type=float, default=15.0)
    s.add_argument("--max-swap-growth-mib", type=float, default=1024)
    s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_score)
    lt = sub.add_parser("latency")
    lt.add_argument("--sets", required=True)
    lt.add_argument("--model", required=True)
    lt.add_argument("--threads", type=int, default=4)
    lt.add_argument("--n", type=int, default=200)
    lt.add_argument("--out", required=True)
    lt.add_argument("--max-rss-mib", type=float, default=4608)
    lt.add_argument("--min-free-pct", type=int, default=35)
    lt.add_argument("--min-sys-free-pct", type=float, default=15.0)
    lt.add_argument("--max-swap-growth-mib", type=float, default=1024)
    lt.set_defaults(fn=cmd_latency)
    la = sub.add_parser("latency-all")
    la.add_argument("--sets", required=True)
    la.add_argument("--models", default="")
    la.add_argument("--thread-set", default="4,1")
    la.add_argument("--n", type=int, default=200)
    la.add_argument("--out-dir", required=True)
    la.set_defaults(fn=cmd_latency_all)
    r = sub.add_parser("report")
    r.add_argument("--scores", required=True)
    r.add_argument("--latency", default="")
    r.add_argument("--out", required=True)
    r.set_defaults(fn=cmd_report)
    return p


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
