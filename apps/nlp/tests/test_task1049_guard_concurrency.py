"""TASK-1049 — the 25-consultation concurrency load test for the single guardrail judge."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import bench_guard_concurrency as gc  # noqa: E402


def test_guardian_block_matches_the_model_card_no_think_template() -> None:
    block = gc.guardian_block("CRITERIA TEXT")
    assert block.startswith(
        "<guardian><no-think>As a judge agent, assess whether the provided text"
    )
    assert "Provide your score immediately without explanation." in block
    assert "\n\n### Criteria: CRITERIA TEXT\n\n" in block
    assert block.endswith(
        "### Scoring Schema: If the last user's text meets the criteria, return 'yes'; "
        "otherwise, return 'no'."
    )


def test_parse_score_reads_the_score_tag_after_empty_think() -> None:
    assert gc.parse_score("<think>\n</think>\n<score>yes</score>") == "yes"
    assert gc.parse_score("<think>\n</think><score> No </score>") == "no"
    assert gc.parse_score("garbage") is None


def test_schedule_is_deterministic_and_shaped_as_specified() -> None:
    a = gc.build_schedule(
        sessions=25, steady_s=160, flush_s=20, burst_at_s=165, burst_windows=4, seed=1049
    )
    b = gc.build_schedule(
        sessions=25, steady_s=160, flush_s=20, burst_at_s=165, burst_windows=4, seed=1049
    )
    assert a == b
    steady = [e for e in a if e.phase == "steady"]
    burst = [e for e in a if e.phase == "burst"]
    # every session flushes every 20 s from its own offset in [0, 20)
    per_session = {s: sorted(e.t for e in steady if e.session == s) for s in range(25)}
    for times in per_session.values():
        assert 0 <= times[0] < 20
        assert all(abs((y - x) - 20) < 1e-9 for x, y in zip(times, times[1:], strict=False))
        assert times[-1] < 160
    assert len(burst) == 25 * 4
    assert all(165 <= e.t < 170 for e in burst)
    assert len(a) == len(steady) + len(burst)
    assert a == sorted(a, key=lambda e: e.t)


def test_each_flush_issues_one_request_per_check() -> None:
    assert [c.name for c in gc.CHECKS] == ["harm", "jailbreak", "medical_scope"]
    msgs = gc.request_messages("WINDOW", gc.CHECKS[0])
    assert msgs[0] == {"role": "user", "content": "WINDOW"}
    assert msgs[1]["role"] == "user" and msgs[1]["content"].startswith("<guardian>")


def test_percentiles_and_summary() -> None:
    rows = [
        {
            "phase": "steady",
            "flush": f"f{i // 3}",
            "ok": True,
            "latency_s": float(i + 1),
            "ttft_s": 0.5,
            "submit_s": float(i),
            "end_s": float(i) + i + 1,
            "prompt_tokens": 700,
            "completion_tokens": 10,
        }
        for i in range(9)
    ] + [
        {
            "phase": "burst",
            "flush": "fb",
            "ok": False,
            "latency_s": 9.0,
            "ttft_s": None,
            "submit_s": 10.0,
            "end_s": 19.0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "error": "HTTP 400",
        }
    ]
    s = gc.summarize(rows)
    assert s["requests"] == 10 and s["errors"] == 1
    assert s["latency_p50_s"] == pytest.approx(5.0)
    assert s["flush_latency_p50_s"] == pytest.approx(6.0)  # flush = max of its 3 checks
    assert s["by_phase"]["burst"]["errors"] == 1


def test_abort_rule_continues_through_warn_but_stops_on_critical_swap_or_rss() -> None:
    # owner decision 2026-10-07: run through macOS "warn"; stop on critical, swap growth
    # > 1 GiB, or LM Studio RSS > 10 GiB
    assert gc.abort_reason(level=2, swap_growth_mib=0, llama_rss_mib=6_200) is None
    assert "critical" in gc.abort_reason(level=4, swap_growth_mib=0, llama_rss_mib=6_200)
    assert "swap" in gc.abort_reason(level=2, swap_growth_mib=1_100, llama_rss_mib=6_200)
    assert "rss" in gc.abort_reason(level=1, swap_growth_mib=0, llama_rss_mib=10_300)


def test_summary_counts_unfinished_requests_as_backlog() -> None:
    rows = [
        {
            "phase": "steady",
            "flush": "f0",
            "ok": True,
            "latency_s": 1.0,
            "ttft_s": 0.5,
            "submit_s": 0.0,
            "end_s": 1.0,
            "prompt_tokens": 700,
            "completion_tokens": 10,
        }
    ]
    s = gc.summarize(rows, unfinished=7)
    assert s["unfinished"] == 7


def test_system_sample_is_what_the_loop_decides_with(monkeypatch) -> None:
    # Regression 2026-10-07: abort_reason existed but the sampler still stopped on warn.
    monkeypatch.setattr(gc, "_llama_server_rss_mib", lambda: 6_200.0)
    monkeypatch.setattr(gc, "_swap_used_mib", lambda: 11_600.0)
    monkeypatch.setattr(gc, "_sysctl_int", lambda name: 2)
    sample, reason = gc.system_sample(swap0=11_576.0, t=3.2, in_flight=12, done=0)
    assert reason is None and sample["pressure_level"] == 2
    monkeypatch.setattr(gc, "_sysctl_int", lambda name: 4)
    _, reason = gc.system_sample(swap0=11_576.0, t=4.2, in_flight=12, done=0)
    assert reason and "critical" in reason


def test_the_sampler_loop_has_no_private_stop_rule() -> None:
    src = Path(gc.__file__).read_text()
    assert "level > 1" not in src
    assert src.count("system_sample(") >= 2  # definition + the loop's call
