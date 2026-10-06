import argparse
import json

import bench_guard_memory as bench
import perfkit as pk
import pytest
import screening_load as load
import screening_replay as replay

# --- V2 ----------------------------------------------------------------------


def test_bench_parse_defaults_and_modes():
    a = bench.parse_args([])
    assert a.mode == "direct" and a.size_list == [
        1000,
        2000,
        4000,
        8000,
        16000,
        32000,
        64000,
        200000,
    ]
    assert bench.parse_args(["--via-guardrail", "--sizes", "4k"]).mode == "via-guardrail"
    with pytest.raises(SystemExit):
        bench.parse_args(["--direct", "--via-guardrail"])
    with pytest.raises(SystemExit):
        bench.parse_args(["--window-sweep", "1000", "--overlap", "1000"])


def test_bench_evaluate_size_413_and_budget():
    a = bench.parse_args(["--budget-mib", "1024", "--expect-cap-chars", "8192"])
    assert bench.evaluate_size(16000, 413, 0, a)["ok"]
    assert not bench.evaluate_size(16000, 200, 5000, a)["ok"]  # should have been refused
    assert bench.evaluate_size(4000, 200, 300, a)["ok"]
    assert not bench.evaluate_size(4000, 200, 2000, a)["ok"]
    g = bench.parse_args(["--via-guardrail"])
    assert bench.evaluate_size(200000, 200, 800, g)["ok"]  # via guardrail every size is accepted
    assert not bench.evaluate_size(200000, 413, 0, g)["ok"]


def test_bench_plateau():
    flat = [5000.0] * 12
    assert bench.plateau(flat, 64)["ok"]
    leak = [5000.0 + 50 * i for i in range(12)]
    assert not bench.plateau(leak, 64)["ok"]
    assert bench.plateau([1, 2], 64)["ok"]


def test_bench_golden_scoring_windowed_vs_whole():
    docs = bench.generate_golden(n_docs=3)
    for d in docs:
        for s in d["spans"]:
            assert 0 <= s["start"] < s["end"] <= len(d["text"])

    def oracle(text):  # perfect detector: knows the spans of the doc it is looking at
        out = []
        for d in docs:
            if text and text in d["text"]:
                off = d["text"].index(text)
                out = [
                    {**s, "start": s["start"] - off, "end": s["end"] - off}
                    for s in d["spans"]
                    if s["start"] >= off and s["end"] <= off + len(text)
                ]
                break
        return out

    whole = bench.score_golden(docs, oracle, 0, 256, 0.5)
    assert whole["f1"] == 1.0
    win = bench.score_golden(docs, oracle, 1000, 256, 0.5)
    assert win["precision"] == 1.0  # overlap duplicates are merged, not double counted
    assert win["recall"] >= 0.9  # only spans straddling a cut can be lost


def test_committed_golden_sample_is_valid():
    docs = bench.load_golden(bench.DEFAULT_GOLDEN)
    assert len(docs) >= 10 and all(d["spans"] for d in docs)
    assert "@example.invalid" in "".join(d["text"] for d in docs)  # synthetic only


def test_bench_render_table():
    t = bench.render_table([{"a": 1, "b": "xx"}], [("a", "A"), ("b", "B")])
    assert t.splitlines()[0].startswith("A") and "xx" in t


# --- V3 ----------------------------------------------------------------------


def test_replay_plan_grows_and_governed_has_no_system_region():
    a = replay.parse_args(["--minutes", "2", "--flush-s", "20"])
    plan = replay.plan_flushes(a)
    assert len(plan) == 6
    assert "system" not in plan[0]["regions"]
    assert plan[-1]["regions"]["transcript"] > plan[0]["regions"]["transcript"]
    u = replay.parse_args(["--system-mode", "untrusted"])
    assert "system" in replay.plan_flushes(u)[0]["regions"]


def test_replay_unique_windows_far_below_requested():
    a = replay.parse_args([])
    plan = replay.plan_flushes(a)
    requested = sum(f["windows_total"] for f in plan)
    assert replay.expected_unique_windows(plan, a) < requested / 2


def test_replay_arg_validation():
    with pytest.raises(SystemExit):
        replay.parse_args(["--overlap-chars", "4000"])
    a = replay.parse_args(["--metric-computed", "my_metric_total"])
    assert a.metrics["computed"] == "my_metric_total"


def _lat(n=20, v=100.0):
    return [v] * n


def test_replay_evaluate_pass_and_fail():
    a = replay.parse_args([])
    good = {
        "requested": 1000.0,
        "computed": 40.0,
        "cached": 960.0,
        "judge": 30.0,
        "chars": 25_000.0,
    }  # ~1.25k chars/min x 100 = 125k/min
    res = replay.evaluate(good, good, _lat(), 20, a)
    assert all(v["pass"] for v in res.values()), res
    low_hit = {**good, "cached": 500.0}
    assert not replay.evaluate(good, low_hit, _lat(), 20, a)["S4"]["pass"]
    heavy = {**good, "chars": 5_000_000.0}
    assert not replay.evaluate(heavy, good, _lat(), 20, a)["S3"]["pass"]
    assert not replay.evaluate(good, good, _lat(v=400.0), 20, a)["S5"]["pass"]
    per_flush_judge = {**good, "judge": 400.0}
    assert not replay.evaluate(per_flush_judge, good, _lat(), 20, a)["S6"]["pass"]


def test_replay_missing_metric_fails_unless_allowed():
    a = replay.parse_args([])
    none = {k: None for k in replay.DEFAULT_METRICS}
    res = replay.evaluate(none, none, _lat(), 20, a)
    assert not res["S3"]["pass"] and not res["S4"]["pass"] and not res["S6"]["pass"]
    b = replay.parse_args(["--allow-missing-metrics"])
    assert replay.evaluate(none, none, _lat(), 20, b)["S3"]["pass"]


def test_replay_regions_are_prefix_stable_between_flushes():
    a = replay.parse_args([])
    plan = replay.plan_flushes(a)
    r0 = {r["key"]: r["text"] for r in replay.make_regions(plan[0])}
    r1 = {r["key"]: r["text"] for r in replay.make_regions(plan[1])}
    assert r1["transcript"].startswith(r0["transcript"]) and r1["attachment"] == r0["attachment"]


# --- V4 ----------------------------------------------------------------------


def test_load_parse_defaults():
    a = load.parse_args([])
    assert a.consultations == 100 and a.duration == 7200
    assert load.parse_args(["--duration", "120", "--consultations", "5"]).duration == 120
    with pytest.raises(SystemExit):
        load.parse_args(["--attachment-chars", "9,3"])
    with pytest.raises(SystemExit):
        load.parse_args(["--consultations", "0"])


def test_consultation_grows_and_rolls_over():
    import random

    a = load.parse_args(
        ["--cadence-s", "20", "--consultation-minutes", "1", "--attachment-share", "1"]
    )
    c = load.Consultation(0, 0, a, random.Random(1))
    r1 = {x["key"]: len(x["text"]) for x in c.next_regions()}
    r2 = {x["key"]: len(x["text"]) for x in c.next_regions()}
    assert r2["transcript"] > r1["transcript"]
    assert any(k.startswith("attachment_") for k in r1)
    c.next_regions()
    assert c.done  # 1 minute / 20 s = 3 flushes


def _series(start, end, n=300, span=1800):
    return [(i * span / n, start + (end - start) * i / n) for i in range(n)]


def test_summarize_pass_and_drift_fail():
    a = load.parse_args(["--duration", "1800", "--drift-window-s", "300"])
    lat = [100.0] * 95 + [250.0] * 5
    good = load.summarize(lat, [200] * 100, _series(5000, 5050), a, [])
    assert good["all_pass"], good["verdicts"]
    drifting = load.summarize(lat, [200] * 100, _series(5000, 5600), a, [])
    assert not drifting["verdicts"]["S2_rss_flat"]["pass"]
    over = load.summarize(lat, [200] * 100, _series(7000, 7000), a, [])
    assert not over["verdicts"]["S2_rss_ceiling"]["pass"]


def test_summarize_shed_errors_and_crash():
    a = load.parse_args(["--duration", "1800"])
    st = [200] * 90 + [503] * 10
    s = load.summarize([100.0] * 100, st, _series(5000, 5000), a, [])
    assert s["shed_rate"] == pytest.approx(0.1) and not s["verdicts"]["shed"]["pass"]
    s2 = load.summarize([100.0] * 3, [200, 500, 200], _series(5000, 5000), a, ["nlp"])
    assert not s2["verdicts"]["no_crash"]["pass"]
    json.dumps(s2)  # serialisable


def test_namespace_is_argparse():
    assert isinstance(load.parse_args([]), argparse.Namespace) and pk.DEFAULT_TENANT
