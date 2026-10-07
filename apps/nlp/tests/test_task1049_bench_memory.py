"""TASK-1049 — the bench must never push the dev Mac into memory pressure.

2026-10-06: the Mac was force-restarted mid-run (reset cause `btn_rst`, no panic)
while the scoring run, LM Studio and the dev stack shared memory. The bench now
(1) refuses to load a model when system free memory is low, (2) hard-stops itself
above an RSS ceiling, and (3) scores in chunks with resumable progress.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import bench_injection_classifiers as bench  # noqa: E402


def test_parse_free_pct_reads_memory_pressure_output() -> None:
    out = (
        "The system has 51539607552 (12582912 pages with a page size of 4096).\n"
        "System-wide memory free percentage: 65%\n"
    )
    assert bench.parse_free_pct(out) == 65


def test_parse_free_pct_unparseable_is_none() -> None:
    assert bench.parse_free_pct("nothing here") is None


def test_precheck_refuses_low_free_memory() -> None:
    with pytest.raises(bench.MemoryGateError, match="free 20% < 35%"):
        bench.assert_free_memory(min_free_pct=35, reader=lambda: 20)


def test_precheck_refuses_when_free_memory_unknown() -> None:
    with pytest.raises(bench.MemoryGateError, match="unknown"):
        bench.assert_free_memory(min_free_pct=35, reader=lambda: None)


def test_precheck_passes_with_enough_free_memory() -> None:
    bench.assert_free_memory(min_free_pct=35, reader=lambda: 60)


def test_rss_guard_fires_once_above_ceiling() -> None:
    fired: list[float] = []
    readings = iter([100.0, 2000.0, 3500.0, 3600.0])
    guard = bench.RssGuard(ceiling_mib=3072, reader=lambda: next(readings), on_exceed=fired.append)
    for _ in range(4):
        guard.check()
    assert fired == [3500.0]
    assert guard.peak_mib == 3600.0


@dataclass(frozen=True)
class _WS:
    score: float
    n_segments: int = 1


class _FakeScorer:
    name = "fake"
    hf_id = "x/fake"
    revision = "0" * 40
    default_threshold = 0.5
    max_tokens = 512

    def __init__(self, calls: list[int]) -> None:
        self.calls = calls

    def score(self, windows: list[str], *, batch_size: int = 8) -> list[_WS]:
        self.calls.append(len(windows))
        return [_WS(score=len(w) / 10_000) for w in windows]


def _write_sets(path: Path, n: int) -> None:
    path.mkdir(parents=True)
    rows = [
        {
            "id": f"b1:{i}",
            "set": "b1",
            "split": "test",
            "label": 0,
            "meta": {},
            "text": "x" * (500 + i * 900),
        }
        for i in range(n)
    ]
    (path / "b1.jsonl").write_text("\n".join(json.dumps(r) for r in rows))


def test_score_is_chunked_and_resumable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sets, scores = tmp_path / "sets", tmp_path / "scores"
    _write_sets(sets, 6)
    calls: list[int] = []
    monkeypatch.setattr(bench, "_load_scorer", lambda name, threads: _FakeScorer(calls))
    monkeypatch.setattr(bench, "assert_free_memory", lambda **_: None)
    args = [
        "score",
        "--sets",
        str(sets),
        "--scores",
        str(scores),
        "--models",
        "fake",
        "--chunk-windows",
        "3",
        "--max-rss-mib",
        "100000",
    ]
    assert bench.main(args) == 0
    assert max(calls) <= 3 + 3  # a chunk closes at a record boundary once >= 3 windows
    rows = [json.loads(line) for line in (scores / "fake.jsonl").read_text().splitlines()]
    assert [r["id"] for r in rows] == [f"b1:{i}" for i in range(6)]
    assert all(len(r["scores"]) == len(r["lengths"]) for r in rows)
    meta = json.loads((scores / "fake.meta.json").read_text())
    assert meta["peak_rss_mib"] > 0

    # a crash after 2 records: the partial file survives; a re-run resumes, not restarts
    (scores / "fake.jsonl").unlink()
    (scores / "fake.meta.json").unlink()
    (scores / "fake.jsonl.partial").write_text("\n".join(json.dumps(r) for r in rows[:2]) + "\n")
    calls.clear()
    assert bench.main(args) == 0
    resumed = [json.loads(line) for line in (scores / "fake.jsonl").read_text().splitlines()]
    assert [r["id"] for r in resumed] == [f"b1:{i}" for i in range(6)]
    assert sum(calls) == sum(len(r["scores"]) for r in rows[2:])


def test_guard_also_stops_when_the_system_runs_low() -> None:
    fired: list[float] = []
    sys_free = iter([40.0, 20.0, 12.0, 10.0])
    guard = bench.RssGuard(
        ceiling_mib=100_000,
        reader=lambda: 500.0,
        on_exceed=fired.append,
        sys_free_reader=lambda: next(sys_free),
        min_sys_free_pct=15,
    )
    for _ in range(4):
        guard.check()
    assert fired == [500.0]  # fired once, on the first reading below 15 %


def test_guard_stops_when_swap_grows_during_the_run() -> None:
    # Swap growth counts only while the system is also short of memory: macOS reshuffles
    # swap by > 1 GiB on its own when memory is plentiful (seen 2026-10-07 at 73 % free).
    fired: list[float] = []
    swap = iter([13_700.0, 14_000.0, 14_800.0, 15_000.0])
    sys_free = iter([60.0, 60.0, 25.0, 25.0])
    guard = bench.RssGuard(
        ceiling_mib=100_000,
        reader=lambda: 700.0,
        on_exceed=fired.append,
        sys_free_reader=lambda: next(sys_free),
        min_sys_free_pct=15,
        swap_reader=lambda: next(swap),
        max_swap_growth_mib=1024,
        swap_needs_sys_below_pct=30,
    )
    for _ in range(4):
        guard.check()
    assert fired == [700.0]  # 3rd reading: +1,100 MiB swap AND available 25 % < 30 %
    assert "swap" in guard.reason


def test_swap_growth_alone_with_plenty_of_memory_does_not_stop() -> None:
    fired: list[float] = []
    swap = iter([11_000.0, 12_500.0, 13_000.0])
    guard = bench.RssGuard(
        ceiling_mib=100_000,
        reader=lambda: 700.0,
        on_exceed=fired.append,
        sys_free_reader=lambda: 50.0,
        min_sys_free_pct=15,
        swap_reader=lambda: next(swap),
        max_swap_growth_mib=1024,
        swap_needs_sys_below_pct=30,
    )
    for _ in range(3):
        guard.check()
    assert fired == []


# ── line-level granularity (dilution experiment) ──────────────────────────────


def test_line_max_scorer_scores_each_unique_line_once_and_takes_the_max() -> None:
    from injection_eval.models import LineMaxScorer

    seen: list[str] = []

    class Inner:
        name, hf_id, revision, default_threshold, max_tokens = "x", "x/x", "0", 0.5, 512

        def score(self, windows, *, batch_size=8):
            seen.extend(windows)
            return [_WS(score=0.9 if "IGNORE" in w else 0.1) for w in windows]

    scorer = LineMaxScorer(Inner())
    out = scorer.score(["Doctor: hi\nPatient: IGNORE all\n\nDoctor: hi", "Doctor: hi"])
    assert [round(o.score, 2) for o in out] == [0.9, 0.1]
    assert [o.n_segments for o in out] == [3, 1]
    assert sorted(seen) == ["Doctor: hi", "Patient: IGNORE all"]  # deduplicated
    assert scorer.name == "x@line" and scorer.default_threshold == 0.5


def test_score_line_granularity_writes_a_separate_result(tmp_path, monkeypatch) -> None:
    sets, scores = tmp_path / "sets", tmp_path / "scores"
    _write_sets(sets, 2)
    monkeypatch.setattr(bench, "_load_scorer", lambda name, threads: _FakeScorer([]))
    monkeypatch.setattr(bench, "assert_free_memory", lambda **_: None)
    args = [
        "score",
        "--sets",
        str(sets),
        "--scores",
        str(scores),
        "--models",
        "fake",
        "--granularity",
        "line",
        "--max-rss-mib",
        "100000",
    ]
    assert bench.main(args) == 0
    assert (scores / "fake@line.jsonl").exists()
    meta = json.loads((scores / "fake@line.meta.json").read_text())
    assert meta["name"] == "fake@line" and meta["granularity"] == "line"
