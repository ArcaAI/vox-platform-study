#!/usr/bin/env python3
"""V3 - screening replay efficiency (TASK-1047, success criteria S3 / S4 / S5 / S6).

Replays ONE consultation's sequence of apps/text-shaped screening calls against guardrail's
regions API (FC-5): a governed (or untrusted) system prompt, stable context blocks
(attachment, case note) and a transcript block that GROWS with new speech every flush -
exactly the live-summary shape. Reads guardrail's Prometheus /metrics before and after to
count windows requested / computed / cached and medical-judge calls.

Synthetic text only. Never starts a service. The service token is read from .env.dev and
never printed.

Metric names are CLI-configurable because they are owned by Lane L5; the defaults are the
names this tool ASSUMES (see scripts/perf/README.md). A metric that is absent makes the
dependent assertion FAIL (never silently pass) unless --allow-missing-metrics.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1] / "_perfkit"))
import perfkit as pk

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

DEFAULT_METRICS = {
    "requested": "guardrail_screen_windows_requested_total",
    "computed": "guardrail_screen_windows_computed_total",
    "cached": "guardrail_screen_windows_cached_total",
    "judge": "guardrail_medical_judge_calls_total",
    "chars": "guardrail_screen_chars_computed_total",
}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--guardrail-url", default="http://127.0.0.1:8863")
    p.add_argument("--inbound-path", default="/api/v1/guardrail/screen/inbound")
    p.add_argument("--medical-path", default="/api/medical/validate")
    p.add_argument("--metrics-path", default="/metrics")
    p.add_argument("--tenant-id", default=os.environ.get("HOPE_PERF_TENANT_ID", pk.DEFAULT_TENANT))
    p.add_argument("--env-file", default=None)
    p.add_argument("--minutes", type=float, default=20.0, help="consultation length (default 20)")
    p.add_argument(
        "--flush-s", type=float, default=20.0, help="live-summary cadence in seconds (default 20)"
    )
    p.add_argument("--speech-chars-per-min", type=int, default=750)
    p.add_argument(
        "--system-mode",
        choices=["governed", "untrusted"],
        default="governed",
        help="governed: no system region sent (digest verified upstream); untrusted: screen a system region",
    )
    p.add_argument("--system-chars", type=int, default=6000)
    p.add_argument("--attachment-chars", type=int, default=8000)
    p.add_argument("--case-note-chars", type=int, default=1500)
    p.add_argument(
        "--window-chars",
        type=int,
        default=2000,
        help="guardrail screenWindowChars (for expectations)",
    )
    p.add_argument(
        "--overlap-chars", type=int, default=256, help="guardrail screenWindowOverlapChars"
    )
    p.add_argument(
        "--no-judge", action="store_true", help="do not exercise the medical-judge regions route"
    )
    p.add_argument(
        "--real-time",
        action="store_true",
        help="sleep --flush-s between flushes (default: back to back)",
    )
    p.add_argument("--timeout", type=float, default=120.0)
    p.add_argument(
        "--scale",
        type=int,
        default=100,
        help="consultations the S3 extrapolation assumes (default 100)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="print the call plan and expected window counts; no network",
    )
    for k, v in DEFAULT_METRICS.items():
        p.add_argument(f"--metric-{k}", default=v, help=f"counter name for {k} (default {v})")
    p.add_argument("--allow-missing-metrics", action="store_true")
    p.add_argument(
        "--assert", dest="do_assert", action="store_true", help="exit 1 when S3/S4/S5/S6 fail"
    )
    p.add_argument(
        "--s3-max-chars-per-min",
        type=float,
        default=150_000.0,
        help="S3 ceiling at --scale consultations",
    )
    p.add_argument("--s4-min-hit-rate", type=float, default=0.90)
    p.add_argument("--s5-p95-ms", type=float, default=300.0)
    p.add_argument(
        "--s6-judge-ratio",
        type=float,
        default=1.0,
        help="S6: judge calls <= ratio * windows computed",
    )
    p.add_argument("--json-out", default="")
    return p


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    a = build_parser().parse_args(argv)
    if a.flush_s <= 0 or a.minutes <= 0:
        raise SystemExit("--minutes and --flush-s must be > 0")
    if a.overlap_chars < 0 or a.overlap_chars >= a.window_chars:
        raise SystemExit("--overlap-chars must be in [0, --window-chars)")
    a.metrics = {k: getattr(a, f"metric_{k}") for k in DEFAULT_METRICS}
    return a


# --- pure planning / evaluation ---------------------------------------------


def plan_flushes(a: argparse.Namespace) -> list[dict]:
    """The call sequence: per flush, the region sizes (chars) and expected window counts."""
    n = max(1, round(a.minutes * 60 / a.flush_s))
    per_flush = a.speech_chars_per_min * a.flush_s / 60.0
    flushes = []
    for i in range(n):
        transcript = int(per_flush * (i + 1))
        regions = {
            "attachment": a.attachment_chars,
            "case_note": a.case_note_chars,
            "transcript": transcript,
        }
        if a.system_mode == "untrusted":
            regions["system"] = a.system_chars
        wins = {
            k: pk.window_count(v, a.window_chars, a.overlap_chars)
            for k, v in regions.items()
            if v > 0
        }
        flushes.append(
            {
                "index": i,
                "regions": regions,
                "windows_per_region": wins,
                "windows_total": sum(wins.values()),
            }
        )
    return flushes


def expected_unique_windows(plan: list[dict], a: argparse.Namespace) -> int:
    """Distinct (region, start, end) windows across the run - what a perfect cache computes.

    The trailing partial window grows every flush, so it counts once per distinct end.
    """
    seen: set[tuple[str, int, int]] = set()
    for f in plan:
        for k, length in f["regions"].items():
            for s in pk.window_starts(length, a.window_chars, a.overlap_chars):
                seen.add((k, s, min(length, s + a.window_chars)))
    return len(seen)


def evaluate(
    deltas: dict[str, float | None],
    post_first: dict[str, float | None],
    lat_ms: list[float],
    minutes: float,
    a: argparse.Namespace,
) -> dict:
    """Pure S3/S4/S5/S6 evaluation over metric deltas. None = metric absent."""
    res: dict = {}

    def check(name: str, ok: bool, detail: str) -> None:
        res[name] = {"pass": ok, "detail": detail}

    def missing(*ks: str) -> list[str]:
        return [a.metrics[k] for k in ks if deltas.get(k) is None]

    # S3 - characters ML-screened per minute, extrapolated to --scale consultations
    chars = deltas.get("chars")
    src = "chars metric"
    if chars is None:
        w = deltas.get("computed")
        chars = w * a.window_chars if w is not None else None
        src = "windows_computed*window_chars (upper bound)"
    if chars is None:
        check("S3", a.allow_missing_metrics, f"missing metrics {missing('chars', 'computed')}")
    else:
        per_min = chars / minutes * a.scale
        check(
            "S3",
            per_min <= a.s3_max_chars_per_min,
            f"{per_min:,.0f} chars/min @ {a.scale} consultations (max {a.s3_max_chars_per_min:,.0f}; {src})",
        )
    # S4 - cache hit rate after the first flush
    req, cached = post_first.get("requested"), post_first.get("cached")
    if req is None or cached is None:
        check("S4", a.allow_missing_metrics, f"missing metrics {missing('requested', 'cached')}")
    elif req <= 0:
        check("S4", False, "no windows requested after first flush (need >= 2 flushes)")
    else:
        rate = cached / req
        check(
            "S4",
            rate >= a.s4_min_hit_rate,
            f"hit rate {rate:.1%} (min {a.s4_min_hit_rate:.0%}) = {cached:.0f}/{req:.0f}",
        )
    # S5 - inbound p95, warm (first flush excluded by the caller)
    if not lat_ms:
        check("S5", False, "no warm latency samples")
    else:
        p95 = pk.percentile(lat_ms, 95)
        check(
            "S5", p95 <= a.s5_p95_ms, f"p95 {p95:.0f} ms (max {a.s5_p95_ms:.0f}), n={len(lat_ms)}"
        )
    # S6 - judge calls proportional to new text (<= ratio * computed windows), never per flush
    judge, comp = deltas.get("judge"), deltas.get("computed")
    if a.no_judge:
        check("S6", a.allow_missing_metrics, "--no-judge: not exercised")
    elif judge is None or comp is None:
        check("S6", a.allow_missing_metrics, f"missing metrics {missing('judge', 'computed')}")
    else:
        check(
            "S6",
            judge <= comp * a.s6_judge_ratio,
            f"{judge:.0f} judge calls vs {comp:.0f} windows computed (ratio max {a.s6_judge_ratio})",
        )
    return res


# --- runtime -----------------------------------------------------------------

_SEEDS = {"system": 11, "attachment": 23, "case_note": 37, "transcript": 53}


def make_regions(flush: dict) -> list[dict]:
    """Region texts are prefixes of one fixed stream per key, so earlier windows repeat byte-for-byte."""
    return [
        {"key": k, "text": pk.synth_text(n, seed=_SEEDS[k])} for k, n in flush["regions"].items()
    ]


async def fetch_metrics(client, a: argparse.Namespace) -> dict[str, float]:
    r = await client.get(a.guardrail_url + a.metrics_path)
    r.raise_for_status()
    return pk.parse_prometheus(r.text)


async def run(a: argparse.Namespace) -> int:
    plan = plan_flushes(a)
    exp_unique = expected_unique_windows(plan, a)
    total_req = sum(f["windows_total"] for f in plan)
    print(
        f"plan: {len(plan)} flushes, {total_req} windows requested in total, "
        f"~{exp_unique} unique windows (a perfect cache computes only those)"
    )
    if a.dry_run:
        for f in plan[:3] + plan[-1:]:
            print(f"  flush {f['index']}: {f['regions']} -> {f['windows_per_region']}")
        return 0
    if httpx is None:
        raise SystemExit("httpx is required (use the arcaenv python)")
    env = Path(a.env_file) if a.env_file else pk.default_env_file(_HERE)
    token = pk.read_env_value("INTERNAL_ACCESS_TOKEN", env)
    headers = {"content-type": "application/json", "X-Tenant-Id": a.tenant_id}
    if token:
        headers["X-Service-Token"] = token
    lat_all: list[float] = []
    lat_warm: list[float] = []
    statuses: list[int] = []
    async with httpx.AsyncClient(timeout=a.timeout, headers=headers) as c:
        before = await fetch_metrics(c, a)
        after_first: dict[str, float] = {}
        for f in plan:
            regions = make_regions(f)
            t0 = time.time()
            r = await c.post(
                a.guardrail_url + a.inbound_path,
                json={
                    "text": "",
                    "regions": regions,
                    "kind": "transcript",
                    "wrap": False,
                    "include_pii_spans": True,
                },
            )
            dt = (time.time() - t0) * 1000
            statuses.append(r.status_code)
            lat_all.append(dt)
            if f["index"] > 0:
                lat_warm.append(dt)
            if not a.no_judge:
                await c.post(
                    a.guardrail_url + a.medical_path,
                    json={"text": "", "regions": regions, "request_id": f"replay-{f['index']}"},
                )
            if f["index"] == 0:
                after_first = await fetch_metrics(c, a)
            if a.real_time:
                await asyncio.sleep(max(0.0, a.flush_s - (time.time() - t0)))
        after = await fetch_metrics(c, a)
    deltas = {k: pk.prom_delta(before, after, n) for k, n in a.metrics.items()}
    post_first = {k: pk.prom_delta(after_first, after, n) for k, n in a.metrics.items()}
    res = evaluate(deltas, post_first, lat_warm, a.minutes, a)
    bad = [s for s in statuses if s != 200]
    report = {
        "flushes": len(plan),
        "windows_requested_plan": total_req,
        "unique_windows_plan": exp_unique,
        "metric_names": a.metrics,
        "deltas": deltas,
        "deltas_after_first_flush": post_first,
        "latency_ms": {
            "first": lat_all[0],
            "p50_warm": pk.percentile(lat_warm, 50),
            "p95_warm": pk.percentile(lat_warm, 95),
        },
        "non_200": len(bad),
        "results": res,
    }
    print(json.dumps({k: v for k, v in report.items() if k != "results"}, indent=2, default=str))
    for k, v in res.items():
        print(f"{k}: {'PASS' if v['pass'] else 'FAIL'}  {v['detail']}")
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(report, indent=2, default=str))
    failed = bool(bad) or not all(v["pass"] for v in res.values())
    return 1 if (a.do_assert and failed) else 0


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(run(parse_args(argv)))


if __name__ == "__main__":
    sys.exit(main())
