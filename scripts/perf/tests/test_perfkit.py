import math

import perfkit as pk
import pytest


def test_percentile_basics():
    assert pk.percentile([1, 2, 3, 4, 5], 50) == 3
    assert pk.percentile([10], 95) == 10
    assert pk.percentile([0, 100], 95) == pytest.approx(95)
    assert math.isnan(pk.percentile([], 50))


def test_drift_pct_first_vs_last():
    samples = [(t, 4000.0) for t in range(100)] + [(t, 4200.0) for t in range(100, 200)]
    # window 30 s: first mean 4000, last mean 4200 -> +5 %
    assert pk.drift_pct(samples, 30) == pytest.approx(5.0)


def test_drift_pct_clamps_window_and_flat():
    flat = [(t, 5000.0) for t in range(60)]
    assert pk.drift_pct(flat, 600) == 0.0  # window clamped to a third of the span
    assert math.isnan(pk.drift_pct([(0, 1.0)], 10))


def test_window_starts_and_count():
    assert pk.window_starts(100, 4000, 256) == [0]
    assert pk.window_starts(4000, 4000, 256) == [0]
    assert pk.window_starts(4001, 4000, 256) == [0, 3744]
    assert pk.window_count(200_000, 4000, 256) == len(pk.window_starts(200_000, 4000, 256))
    starts = pk.window_starts(10_000, 4000, 256)
    assert starts == [0, 3744, 7488]  # last window reaches the end: 7488+4000 >= 10000
    with pytest.raises(ValueError):
        pk.window_starts(10, 100, 100)


def test_split_windows_covers_text_with_overlap():
    text = pk.synth_text(9000)
    wins = pk.split_windows(text, 4000, 256)
    assert wins[0][1] == text[:4000]
    assert wins[1][0] == 3744
    assert "".join(w[: len(w)] for _, w in wins)[0:1] == text[0]
    assert wins[-1][0] + len(wins[-1][1]) == len(text)


def test_synth_text_deterministic_prefix_stable():
    a, b = pk.synth_text(5000, seed=3), pk.synth_text(8000, seed=3)
    assert len(a) == 5000 and b.startswith(a)  # growing transcript keeps earlier bytes identical


def test_parse_sizes():
    assert pk.parse_sizes("1k,2k, 200k,8192") == [1000, 2000, 200000, 8192]


def test_parse_prometheus_sums_label_sets():
    text = (
        "# HELP x\n# TYPE x counter\n"
        'guardrail_screen_windows_computed_total{task="pii"} 10\n'
        'guardrail_screen_windows_computed_total{task="cls"} 5.5\n'
        "other 3\n"
    )
    m = pk.parse_prometheus(text)
    assert m["guardrail_screen_windows_computed_total"] == 15.5
    assert pk.prom_delta({"a": 1.0}, {"a": 4.0}, "a") == 3.0
    assert pk.prom_delta({}, {}, "a") is None


def test_score_spans_and_prf():
    gold = [{"label": "email", "start": 10, "end": 20}, {"label": "person", "start": 30, "end": 40}]
    pred = [
        {"label": "email", "start": 10, "end": 20},
        {"label": "person", "start": 31, "end": 40},
        {"label": "phone_number", "start": 50, "end": 60},
    ]
    assert pk.score_spans(gold, pred) == (2, 1, 0)
    assert pk.score_spans(gold, [{"label": "person", "start": 10, "end": 20}]) == (
        0,
        1,
        2,
    )  # wrong label
    r = pk.prf(2, 1, 0)
    assert r["recall"] == 1.0 and r["precision"] == pytest.approx(2 / 3)


def test_merge_window_spans_offsets_and_dedupes_overlap():
    a = [{"label": "email", "start": 3740, "end": 3760}]
    b = [{"label": "email", "start": 0 - 0, "end": 16}]  # same span seen again from window at 3744
    merged = pk.merge_window_spans([(0, a), (3744, [{"label": "email", "start": -4, "end": 16}])])
    assert len(merged) == 1
    assert pk.merge_window_spans([(0, b), (100, b)])[1]["start"] == 100
