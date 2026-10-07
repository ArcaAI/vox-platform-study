#!/usr/bin/env python3
"""TASK-1049 Track P — evaluate PII/PHI detectors and masking (offline, CPU).

Modes
  build   [--out DIR] [--cache DIR] [--seed N]
          Generate the deterministic synthetic dataset (dev.jsonl, test.jsonl, manifest.json).
  score   --data DIR --split dev|test --detector SPEC --out DIR [--max-docs N] [--rss-probe 2000,8000]
          Detect over every document at the production window geometry (2,000 / 256), write
          <out>/<name>.detections.jsonl (resumable) and <name>.meta.json.
  report  --data DIR --split dev|test --detections FILE --out PREFIX
          Span P/R/F1 (strict, relaxed), residual PHI after the production Pseudonymizer,
          clinical over-mask, restore round trip, surrogate consistency, latency, OD-30 verdict;
          writes PREFIX.json and PREFIX.md.

Detector SPEC: regex | gliner2:<slug> | presidio | hf:<repo-id> | <spec>+regex
  gliner2:<slug> takes labels and threshold from the SEEDED row (`seed/ai-models/nlp.ts`),
  e.g. gliner2:gliner2-privacy-filter-pii-multi.

Every spec except `regex` LOADS A MODEL and is refused unless HOPE_1049_ALLOW_MODEL_LOAD=1,
which is set only after the owner approves the load. Model runs sit behind the 1049 memory
guard (free-memory gate, RSS ceiling, swap growth, macOS pressure), imported from
bench_injection_classifiers. Synthetic data only; never calls a HOPE service.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bench_injection_classifiers import (  # noqa: E402
    _current_rss_mib,
    _guard,
    assert_free_memory,
)
from pii_eval import generate  # noqa: E402
from pii_eval.detectors import (  # noqa: E402
    Detector,
    Gliner2Detector,
    HfTokenClassDetector,
    HybridDetector,
    PresidioDetector,
    RegexDetector,
)
from pii_eval.metrics import latency_summary  # noqa: E402
from pii_eval.report import decide, render_markdown  # noqa: E402
from pii_eval.runner import (  # noqa: E402
    OVERLAP,
    WINDOW,
    detect_document,
    evaluate_detections,
    rss_probe,
)
from pii_eval.spans import Detection  # noqa: E402
from pii_eval.taxonomy import seeded_row  # noqa: E402


def make_detector(spec: str) -> Detector:
    if spec.endswith("+regex"):
        return HybridDetector(make_detector(spec[: -len("+regex")]), RegexDetector())
    if spec == "regex":
        return RegexDetector()
    if spec == "presidio":
        return PresidioDetector()
    kind, _, arg = spec.partition(":")
    if kind == "gliner2" and arg:
        row = seeded_row(arg)
        return Gliner2Detector(row["sourceUri"], labels=row["labels"], threshold=row["threshold"])
    if kind == "hf" and arg:
        return HfTokenClassDetector(arg)
    raise SystemExit(f"unknown detector spec: {spec}")


def load_split(data_dir: Path, split: str) -> list[dict]:
    with (data_dir / f"{split}.jsonl").open() as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _slug(spec: str) -> str:
    return "".join(c if c.isalnum() or c in "-+." else "_" for c in spec)


def _dump(d: Detection) -> dict:
    return {
        "label": d.label,
        "start": d.start,
        "end": d.end,
        "score": d.score,
        "raw_label": d.raw_label,
    }


def _probe_texts(docs: list[dict], sizes: list[int]) -> list[str]:
    """Texts of (at least) each size, built by joining test documents; shortest first."""
    joined = "\n".join(d["text"] for d in docs)
    return [joined[: max(size, 1)] for size in sorted(sizes) if size <= len(joined)]


def cmd_build(a: argparse.Namespace) -> int:
    argv = ["--out", a.out, "--cache", a.cache, "--seed", str(a.seed)]
    if a.builtin_skeleton:
        argv.append("--builtin-skeleton")
    return generate.main(argv)


def cmd_score(a: argparse.Namespace) -> int:
    docs = load_split(Path(a.data), a.split)
    if a.max_docs:
        docs = docs[: a.max_docs]
    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{_slug(a.detector)}.{a.split}"
    target = out_dir / f"{name}.detections.jsonl"
    partial = out_dir / f"{name}.detections.jsonl.partial"
    detector = make_detector(a.detector)
    loads_model = hasattr(detector, "load")
    guard = None
    load_s = 0.0
    if loads_model:
        assert_free_memory(min_free_pct=a.min_free_pct)
        guard = _guard(a)
        guard.start()
        started = time.perf_counter()
        detector.load()
        load_s = time.perf_counter() - started
    done: dict[str, str] = {}
    if partial.exists() and not a.force:
        done = {json.loads(line)["id"]: line for line in partial.read_text().splitlines() if line}
    elif partial.exists():
        partial.unlink()
    t0 = time.perf_counter()
    with partial.open("a") as fh:
        for i, doc in enumerate(docs):
            if doc["id"] in done:
                continue
            timings: list[float] = []
            dets = detect_document(detector, doc["text"], timings=timings)
            row = {"id": doc["id"], "detections": [_dump(d) for d in dets], "window_s": timings}
            line = json.dumps(row)
            fh.write(line + "\n")
            fh.flush()
            done[doc["id"]] = line
            if (i + 1) % 10 == 0:
                print(
                    f"[{name}] {i + 1}/{len(docs)} docs, rss {_current_rss_mib():.0f} MiB",
                    flush=True,
                )
    score_s = time.perf_counter() - t0
    target.write_text("".join(done[d["id"]] + "\n" for d in docs))
    partial.unlink()
    meta = {
        "detector": detector.name,
        "spec": a.detector,
        "split": a.split,
        "documents": len(docs),
        "window": {"size": WINDOW, "overlap": OVERLAP},
        "load_s": round(load_s, 2),
        "score_s": round(score_s, 2),
        "peak_rss_mib": round(max(guard.peak_mib if guard else 0.0, _current_rss_mib()), 1),
    }
    if a.rss_probe:
        sizes = [int(s) for s in a.rss_probe.split(",")]
        meta["rss_probe"] = rss_probe(
            detector, _probe_texts(docs, sizes), rss_mib=_current_rss_mib, windowed=not a.rss_whole
        )
    (out_dir / f"{name}.meta.json").write_text(json.dumps(meta, indent=2))
    print(f"[done] {name}: {len(docs)} docs in {score_s:.1f}s", flush=True)
    return 0


def cmd_report(a: argparse.Namespace) -> int:
    docs = load_split(Path(a.data), a.split)
    det_path = Path(a.detections)
    rows = {}
    for line in det_path.read_text().splitlines():
        if line:
            row = json.loads(line)
            rows[row["id"]] = row
    docs = [d for d in docs if d["id"] in rows]
    preds = [
        [
            Detection(x["label"], x["start"], x["end"], x["score"], raw_label=x["raw_label"])
            for x in rows[d["id"]]["detections"]
        ]
        for d in docs
    ]
    report = evaluate_detections(docs, preds)
    timings = [t for d in docs for t in rows[d["id"]]["window_s"]]
    meta_path = det_path.with_name(det_path.name.replace(".detections.jsonl", ".meta.json"))
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    report["detector"] = meta.get("detector", det_path.stem)
    report["window"] = {"size": WINDOW, "overlap": OVERLAP}
    if timings:
        report["latency_per_window"] = latency_summary(timings)
    if "rss_probe" in meta:
        report["rss_probe"] = meta["rss_probe"]
    manifest_path = Path(a.data) / "manifest.json"
    report["meta"] = {
        "split": a.split,
        "dataset_manifest_sha256": _file_sha(manifest_path) if manifest_path.exists() else "n/a",
        "load_s": meta.get("load_s", "n/a"),
        "peak_rss_mib": meta.get("peak_rss_mib", "n/a"),
    }
    report["decision"] = decide(report)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # not `with_suffix`: a prefix like "regex.dev" would lose its ".dev"
    Path(f"{out}.json").write_text(json.dumps(report, indent=2, sort_keys=True))
    Path(f"{out}.md").write_text(render_markdown(report))
    print(f"[report] {out}.md")
    return 0


def _file_sha(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--out", default=str(generate.DEFAULT_OUT))
    b.add_argument("--cache", default=str(generate.DEFAULT_CACHE))
    b.add_argument("--seed", type=int, default=generate.SEED)
    b.add_argument("--builtin-skeleton", action="store_true")
    b.set_defaults(fn=cmd_build)
    s = sub.add_parser("score")
    s.add_argument("--data", required=True)
    s.add_argument("--split", choices=("dev", "test"), required=True)
    s.add_argument("--detector", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--max-docs", type=int, default=0)
    s.add_argument(
        "--rss-probe", default="", help="comma list of char lengths, e.g. 2000,8000,16000"
    )
    s.add_argument(
        "--rss-whole", action="store_true", help="probe a single un-windowed call (quadratic case)"
    )
    s.add_argument("--max-rss-mib", type=float, default=4608)
    s.add_argument("--min-free-pct", type=int, default=35)
    s.add_argument("--min-sys-free-pct", type=float, default=5.0)
    s.add_argument("--max-swap-growth-mib", type=float, default=1024)
    s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_score)
    r = sub.add_parser("report")
    r.add_argument("--data", required=True)
    r.add_argument("--split", choices=("dev", "test"), required=True)
    r.add_argument("--detections", required=True)
    r.add_argument("--out", required=True)
    r.set_defaults(fn=cmd_report)
    return p


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
