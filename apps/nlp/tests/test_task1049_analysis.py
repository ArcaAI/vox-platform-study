"""TASK-1049 — the statistics that turn per-window scores into the verdict."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from injection_eval.analysis import (  # noqa: E402
    Criteria,
    auc,
    decide,
    record_recall,
    window_fp,
)


def _rec(rid: str, set_: str, split: str, label: int, scores: list[float], **meta) -> dict:
    return {"id": rid, "set": set_, "split": split, "label": label, "scores": scores, "meta": meta}


def test_window_fp_counts_windows_not_records() -> None:
    recs = [
        _rec("1", "b1", "test", 0, [0.1, 0.9, 0.2]),  # one record, three windows, one flagged
        _rec("2", "b1", "test", 0, [0.1]),
        _rec("3", "b1", "dev", 0, [0.99]),  # dev is excluded when split="test"
    ]
    r = window_fp(recs, threshold=0.5, sets={"b1"}, split="test")
    assert (r.flagged, r.total) == (1, 4)
    assert r.rate == pytest.approx(0.25)
    assert 0.25 < r.upper <= 1.0


def test_record_recall_counts_a_record_caught_if_any_window_flags() -> None:
    recs = [
        _rec("a", "c2", "test", 1, [0.1, 0.7], carrier="patient_speech"),
        _rec("b", "c2", "test", 1, [0.2, 0.3], carrier="attachment"),
        _rec("c", "c2", "test", 1, [0.8], carrier="attachment"),
    ]
    r = record_recall(recs, threshold=0.5, sets={"c2"}, split="test")
    assert (r.caught, r.total) == (2, 3)
    by = record_recall(recs, threshold=0.5, sets={"c2"}, split="test", by="carrier")
    assert by["attachment"].caught == 1 and by["attachment"].total == 2
    assert by["patient_speech"].caught == 1


def test_auc_perfect_and_tied() -> None:
    assert auc([0.1, 0.2], [0.8, 0.9]) == 1.0
    assert auc([0.5, 0.5], [0.5, 0.5]) == pytest.approx(0.5)
    assert auc([0.9], [0.1]) == 0.0


def test_decide_applies_every_criterion() -> None:
    c = Criteria()
    ok = decide(
        fp_rate=0.005,
        fp_upper=0.012,
        recall=0.97,
        recall_lower=0.93,
        worst_carrier_recall=0.92,
        p95_ms=100.0,
        added_rss_mib=500.0,
        criteria=c,
    )
    assert ok.passed and not ok.failures
    bad = decide(
        fp_rate=0.011,
        fp_upper=0.02,
        recall=0.94,
        recall_lower=0.90,
        worst_carrier_recall=0.85,
        p95_ms=200.0,
        added_rss_mib=700.0,
        criteria=c,
    )
    assert not bad.passed
    assert len(bad.failures) == 7


def test_decide_without_cpu_measurements_reports_pending_not_pass() -> None:
    r = decide(
        fp_rate=0.0,
        fp_upper=0.005,
        recall=1.0,
        recall_lower=0.98,
        worst_carrier_recall=1.0,
        p95_ms=None,
        added_rss_mib=None,
        criteria=Criteria(),
    )
    assert not r.passed and r.pending == ["p95_ms", "added_rss_mib"]


def test_report_end_to_end_on_fake_scores(tmp_path: Path) -> None:
    import json

    import bench_injection_classifiers as bench

    rows = []
    for i in range(400):  # clinical benign: dev + test
        rows.append(
            {
                "id": f"b1:{i}",
                "set": "b1",
                "split": "dev" if i < 120 else "test",
                "label": 0,
                "meta": {},
                "scores": [i / 4000],
            }
        )
    for i in range(75):
        rows.append(
            {"id": f"a:{i}", "set": "a", "split": "test", "label": 0, "meta": {}, "scores": [0.01]}
        )
    for i in range(60):
        rows.append(
            {
                "id": f"c2:{i}",
                "set": "c2",
                "split": "test",
                "label": 1,
                "meta": {"carrier": "patient_speech", "class": "x"},
                "scores": [0.02, 0.97],
            }
        )
    (tmp_path / "m.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    (tmp_path / "m.meta.json").write_text(json.dumps({"name": "m", "default_threshold": 0.5}))
    out = tmp_path / "report.json"
    assert bench.main(["report", "--scores", str(tmp_path), "--out", str(out)]) == 0
    m = json.loads(out.read_text())["models"]["m"]
    op = m["at"][m["operating_point"]]
    assert op["recall_c2"]["caught"] == 60
    assert op["fp_gate"]["total"] == 280 + 75
    assert m["verdict"]["pending"] == ["p95_ms", "added_rss_mib"]


def test_window_fp_by_length_bucket() -> None:
    from injection_eval.analysis import window_fp_by_length

    recs = [
        {
            "id": "1",
            "set": "a",
            "split": "test",
            "label": 0,
            "meta": {},
            "scores": [0.9, 0.1, 0.9],
            "lengths": [120, 2000, 900],
        },
    ]
    by = window_fp_by_length(recs, threshold=0.5, sets={"a"}, split="test")
    assert (by["<500"].flagged, by["<500"].total) == (1, 1)
    assert (by["500-1499"].flagged, by["500-1499"].total) == (1, 1)
    assert (by[">=1500"].flagged, by[">=1500"].total) == (0, 1)


def test_report_ignores_appledouble_sidecars(tmp_path: Path) -> None:
    import json

    import bench_injection_classifiers as bench

    row = {"id": "a:0", "set": "a", "split": "test", "label": 0, "meta": {}, "scores": [0.1]}
    (tmp_path / "m.jsonl").write_text(json.dumps(row))
    (tmp_path / "m.meta.json").write_text(json.dumps({"name": "m", "default_threshold": 0.5}))
    (tmp_path / "._m.meta.json").write_bytes(b"\x00\x05\x16\x07\xb0 binary resource fork")
    assert list(bench._load_scores(tmp_path)) == ["m"]


def test_task_report_for_safety_and_scope(tmp_path: Path) -> None:
    import json

    import bench_injection_classifiers as bench

    rows = []
    for i in range(100):
        rows.append(
            {
                "id": f"b1:{i}",
                "set": "b1",
                "split": "dev" if i < 30 else "test",
                "label": 0,
                "meta": {},
                "scores": [i / 1000],
                "lengths": [2000],
            }
        )
    for i in range(20):
        rows.append(
            {
                "id": f"s:p{i}",
                "set": "s",
                "split": "test",
                "label": 1,
                "meta": {"medical_topic": i < 5},
                "scores": [0.9 if i < 15 else 0.1],
            }
        )
        rows.append(
            {
                "id": f"s:n{i}",
                "set": "s",
                "split": "test",
                "label": 0,
                "meta": {},
                "scores": [0.6 if i < 2 else 0.05],
            }
        )
    (tmp_path / "m@safety.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    (tmp_path / "m@safety.meta.json").write_text(
        json.dumps({"name": "m@safety", "default_threshold": 0.5})
    )
    out = tmp_path / "r.json"
    assert (
        bench.main(
            ["report-tasks", "--scores", str(tmp_path), "--positive-set", "s", "--out", str(out)]
        )
        == 0
    )
    m = json.loads(out.read_text())["models"]["m@safety"]
    v = m["at"]["vendor_default"]
    assert v["fp_clinical"]["total"] == 70 and v["fp_clinical"]["flagged"] == 0
    assert (v["recall"]["caught"], v["recall"]["total"]) == (15, 20)
    assert (v["fp_positive_set_negatives"]["flagged"], v["fp_positive_set_negatives"]["total"]) == (
        2,
        20,
    )
    assert v["recall_by"]["medical_topic"]["True"]["caught"] == 5
