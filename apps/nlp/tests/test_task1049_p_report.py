"""TASK-1049 Track P — report, OD-30 verdicts, seeded taxonomy and the bench CLI (no model)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import bench_pii  # noqa: E402
from pii_eval.detectors import ModelLoadNotApproved  # noqa: E402
from pii_eval.generate import builtin_skeleton, generate_dataset  # noqa: E402
from pii_eval.report import decide, render_markdown  # noqa: E402
from pii_eval.runner import evaluate_detections  # noqa: E402
from pii_eval.spans import Detection  # noqa: E402
from pii_eval.taxonomy import seeded_row  # noqa: E402


@pytest.fixture(scope="module")
def docs():
    return generate_dataset(seed=5, n_dev=0, n_test=10, skeleton=builtin_skeleton())["test"]


def _gold_report(docs, drop=()):
    preds = [
        [Detection(s["label"], s["start"], s["end"]) for s in d["spans"] if s["label"] not in drop]
        for d in docs
    ]
    return evaluate_detections(docs, preds)


def test_decide_passes_when_nothing_leaks_and_nothing_is_overmasked(docs):
    report = _gold_report(docs)
    verdict = decide(report)
    assert verdict["residual_direct"]["verdict"] in ("pass", "inconclusive")
    assert verdict["residual_direct"]["rate"] == 0.0
    assert verdict["overmask"]["rate"] == 0.0


def test_decide_fails_when_a_direct_identifier_label_is_never_found(docs):
    verdict = decide(_gold_report(docs, drop=("PHONE", "PATIENT_NAME")))
    assert verdict["residual_direct"]["verdict"] == "fail"
    assert verdict["residual_direct"]["rate"] > 0.05


def test_decide_is_inconclusive_when_the_sample_is_too_small_to_clear_the_bar():
    report = {
        "masking": {
            "residual": {"direct": {"spans": 20, "leaked_any": 0}},
            "overmask": {"overall": {"negatives": 0, "overmasked": 0}},
        }
    }
    v = decide(report)
    assert v["residual_direct"]["verdict"] == "inconclusive"  # 0/20: upper bound ~13 %
    assert v["overmask"]["verdict"] == "no-data"


def test_markdown_renders_every_section(docs):
    report = _gold_report(docs)
    report["detector"] = "gold-oracle"
    report["latency_per_window"] = {"n": 3, "p50_ms": 5.0, "p95_ms": 9.0, "mean_ms": 6.0}
    md = render_markdown(report)
    for heading in (
        "Decision rule (OD-30)",
        "Residual PHI after masking",
        "Clinical over-mask",
        "Masking contract",
        "Span detection, strict",
        "Span detection, relaxed",
        "Latency per window",
    ):
        assert heading in md


def test_seeded_taxonomy_matches_the_production_rows():
    for slug in ("gliner2-privacy-filter-pii-multi", "gliner2-guardrails-pii-multi"):
        row = seeded_row(slug)
        assert len(row["labels"]) == 48 and "person" in row["labels"]
        assert "medical_record_number" in row["labels"]
        assert row["threshold"] == 0.5
        assert row["sourceUri"].lower().startswith("fastino/")


def test_model_specs_are_refused_without_approval(monkeypatch):
    monkeypatch.delenv("HOPE_1049_ALLOW_MODEL_LOAD", raising=False)
    for spec in (
        "gliner2:gliner2-privacy-filter-pii-multi",
        "presidio",
        "hf:obi/deid_roberta_i2b2",
    ):
        det = bench_pii.make_detector(spec)
        with pytest.raises(ModelLoadNotApproved):
            det.load()


def test_unknown_spec_exits():
    with pytest.raises(SystemExit):
        bench_pii.make_detector("nonsense")


def test_cli_end_to_end_with_the_regex_detector(tmp_path):
    data = tmp_path / "data"
    assert (
        bench_pii.main(
            ["build", "--out", str(data), "--cache", str(tmp_path / "none"), "--builtin-skeleton"]
        )
        == 0
    )
    assert (data / "manifest.json").exists()
    scores = tmp_path / "scores"
    assert (
        bench_pii.main(
            [
                "score",
                "--data",
                str(data),
                "--split",
                "dev",
                "--detector",
                "regex",
                "--out",
                str(scores),
                "--max-docs",
                "6",
                "--rss-probe",
                "2000,4000",
            ]
        )
        == 0
    )
    det_file = scores / "regex.dev.detections.jsonl"
    assert len(det_file.read_text().splitlines()) == 6
    assert (
        bench_pii.main(
            [
                "report",
                "--data",
                str(data),
                "--split",
                "dev",
                "--detections",
                str(det_file),
                "--out",
                str(tmp_path / "rep.dev"),
            ]
        )
        == 0
    )
    report = json.loads((tmp_path / "rep.dev.json").read_text())
    assert report["detector"] == "regex"
    assert report["documents"] == 6
    assert report["rss_probe"] and report["decision"]["residual_direct"]["verdict"] in (
        "fail",
        "inconclusive",
    )
    assert "RSS growth" in (tmp_path / "rep.dev.md").read_text()
