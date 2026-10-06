#!/usr/bin/env python3
"""V4 - load + soak of the LLM-free screening plane (TASK-1047, success criteria S2 / S5).

N concurrent synthetic consultations (default 100) each flush every --cadence-s seconds with a
transcript that grows by realistic speech, plus attachments on a share of consultations,
against guardrail's regions API (FC-5) - which fans out to NLP. No LLM is involved. A consultation
that reaches --consultation-minutes is replaced by a fresh one, so load stays flat for the
whole soak. RSS / CPU of the NLP and guardrail processes (found by listening port) are sampled
every --sample-s seconds.

Writes <out-dir>/samples.csv (resource timeline), requests.csv (every call) and summary.json.
Safety: --ceiling-mib SIGKILLs the NLP pid above that RSS and exits 2.
Synthetic text only; the service token comes from .env.dev and is never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import os
import random
import signal
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


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--consultations", type=int, default=100)
    p.add_argument(
        "--duration",
        type=float,
        default=7200.0,
        help="seconds (default 7200 = 2 h soak; 120 for smoke)",
    )
    p.add_argument("--cadence-s", type=float, default=20.0, help="per-consultation flush interval")
    p.add_argument("--consultation-minutes", type=float, default=20.0)
    p.add_argument("--speech-chars-per-min", type=int, default=750)
    p.add_argument(
        "--attachment-share",
        type=float,
        default=0.3,
        help="fraction of consultations with attachments",
    )
    p.add_argument("--attachment-chars", default="2000,20000", help="min,max chars per attachment")
    p.add_argument("--max-attachments", type=int, default=3)
    p.add_argument("--case-note-chars", type=int, default=1500)
    p.add_argument("--guardrail-url", default="http://127.0.0.1:8863")
    p.add_argument("--inbound-path", default="/api/v1/guardrail/screen/inbound")
    p.add_argument("--nlp-port", type=int, default=8864)
    p.add_argument("--guardrail-port", type=int, default=8863)
    p.add_argument("--nlp-pid", type=int, default=None)
    p.add_argument("--guardrail-pid", type=int, default=None)
    p.add_argument("--tenant-id", default=os.environ.get("HOPE_PERF_TENANT_ID", pk.DEFAULT_TENANT))
    p.add_argument("--env-file", default=None)
    p.add_argument("--sample-s", type=float, default=5.0)
    p.add_argument(
        "--drift-window-s",
        type=float,
        default=600.0,
        help="first-vs-last window for RSS drift (default 10 min)",
    )
    p.add_argument(
        "--ceiling-mib", type=float, default=12 * 1024, help="SIGKILL NLP above this RSS (safety)"
    )
    p.add_argument("--timeout", type=float, default=60.0)
    p.add_argument("--seed", type=int, default=1047)
    p.add_argument("--out-dir", default="perf-load-out")
    p.add_argument("--dry-run", action="store_true", help="print the plan; no network")
    p.add_argument(
        "--assert", dest="do_assert", action="store_true", help="exit 1 when S2/S5/no-crash fail"
    )
    p.add_argument("--s2-max-nlp-rss-mib", type=float, default=6 * 1024)
    p.add_argument("--s2-max-drift-pct", type=float, default=5.0)
    p.add_argument("--s5-p95-ms", type=float, default=300.0)
    p.add_argument(
        "--max-shed-rate", type=float, default=0.01, help="503 share above which --assert fails"
    )
    return p


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    a = build_parser().parse_args(argv)
    if a.consultations < 1 or a.duration <= 0 or a.cadence_s <= 0:
        raise SystemExit("--consultations, --duration and --cadence-s must be positive")
    lo, hi = (int(x) for x in a.attachment_chars.split(","))
    if lo > hi:
        raise SystemExit("--attachment-chars must be min,max")
    a.attachment_range = (lo, hi)
    return a


# --- pure model --------------------------------------------------------------


class Consultation:
    """One synthetic consultation: stable context + a transcript that grows each flush."""

    def __init__(self, idx: int, gen: int, a: argparse.Namespace, rng: random.Random):
        self.id = f"c{idx}-g{gen}"
        self.seed = idx * 1000 + gen
        self.flushes = 0
        self.per_flush = a.speech_chars_per_min * a.cadence_s / 60.0
        self.max_flushes = max(1, int(a.consultation_minutes * 60 / a.cadence_s))
        self.case_note = a.case_note_chars
        self.attachments: list[int] = []
        if rng.random() < a.attachment_share:
            k = rng.randint(1, a.max_attachments)
            self.attachments = [rng.randint(*a.attachment_range) for _ in range(k)]

    @property
    def done(self) -> bool:
        return self.flushes >= self.max_flushes

    def next_regions(self) -> list[dict]:
        self.flushes += 1
        regions = [
            {"key": "case_note", "text": pk.synth_text(self.case_note, seed=self.seed + 1)},
            {
                "key": "transcript",
                "text": pk.synth_text(int(self.per_flush * self.flushes), seed=self.seed + 2),
            },
        ]
        for i, n in enumerate(self.attachments):
            regions.append(
                {"key": f"attachment_{i}", "text": pk.synth_text(n, seed=self.seed + 10 + i)}
            )
        return regions


def summarize(
    latencies_ms: list[float],
    statuses: list[int],
    nlp_samples: list[tuple[float, float]],
    a: argparse.Namespace,
    crashed: list[str],
) -> dict:
    """Pure summary + S2/S5 verdicts from raw measurements."""
    n = len(statuses)
    shed = sum(1 for s in statuses if s == 503)
    errors = sum(1 for s in statuses if s not in (200, 503))
    ok_lat = [l for l, s in zip(latencies_ms, statuses) if s == 200]
    peak = max((v for _, v in nlp_samples), default=float("nan"))
    drift = pk.drift_pct(nlp_samples, a.drift_window_s)
    p95 = pk.percentile(ok_lat, 95)
    s2_mem = peak <= a.s2_max_nlp_rss_mib
    s2_drift = not math.isnan(drift) and drift < a.s2_max_drift_pct  # nan -> not proven
    shed_rate = shed / n if n else float("nan")
    summary = {
        "requests": n,
        "ok": len(ok_lat),
        "shed_503": shed,
        "shed_rate": shed_rate,
        "errors": errors,
        "latency_ms": {
            "p50": pk.percentile(ok_lat, 50),
            "p95": p95,
            "p99": pk.percentile(ok_lat, 99),
        },
        "nlp_rss_mib": {
            "peak": peak,
            "drift_pct": drift,
            "drift_window_s": min(a.drift_window_s, a.duration / 3),
        },
        "crashed": crashed,
        "verdicts": {
            "S2_rss_ceiling": {
                "pass": s2_mem,
                "detail": f"peak {peak:.0f} MiB (max {a.s2_max_nlp_rss_mib:.0f})",
            },
            "S2_rss_flat": {
                "pass": s2_drift,
                "detail": f"drift {drift:.2f}% (max {a.s2_max_drift_pct}%)",
            },
            "S5_p95": {
                "pass": not math.isnan(p95) and p95 <= a.s5_p95_ms,
                "detail": f"p95 {p95:.0f} ms (max {a.s5_p95_ms:.0f})",
            },
            "no_crash": {
                "pass": not crashed and errors == 0,
                "detail": f"crashed={crashed} non-200/503 errors={errors}",
            },
            "shed": {
                "pass": not math.isnan(shed_rate) and shed_rate <= a.max_shed_rate,
                "detail": f"{shed_rate:.2%} (max {a.max_shed_rate:.0%})",
            },
        },
    }
    summary["all_pass"] = all(v["pass"] for v in summary["verdicts"].values())
    return summary


# --- runtime -----------------------------------------------------------------


async def consultation_loop(
    idx: int, a, client, t_end: float, rows: list, rng: random.Random
) -> None:
    await asyncio.sleep(rng.uniform(0, a.cadence_s))  # spread the first flushes
    gen = 0
    c = Consultation(idx, gen, a, rng)
    while time.time() < t_end:
        tick = time.time()
        regions = c.next_regions()
        chars = sum(len(r["text"]) for r in regions)
        try:
            r = await client.post(
                a.guardrail_url + a.inbound_path,
                json={
                    "text": "",
                    "regions": regions,
                    "kind": "transcript",
                    "wrap": False,
                    "include_pii_spans": True,
                },
            )
            status = r.status_code
        except httpx.HTTPError:
            status = 0
        rows.append((tick, c.id, c.flushes, chars, status, (time.time() - tick) * 1000))
        if c.done:
            gen += 1
            c = Consultation(idx, gen, a, rng)
        await asyncio.sleep(max(0.0, a.cadence_s - (time.time() - tick)))


async def sampler(
    a, pids: dict[str, int], t0: float, t_end: float, samples: list, crashed: list, state: dict
) -> None:
    while time.time() < t_end and not state.get("killed"):
        now = time.time()
        row = {"t": round(now - t0, 1)}
        for name, pid in pids.items():
            if not pk.pid_alive(pid):
                if name not in crashed:
                    crashed.append(name)
                continue
            row[f"{name}_rss_mib"] = round(pk.rss_mib(pid), 1)
            row[f"{name}_cpu_pct"] = pk.cpu_pct(pid)
        samples.append(row)
        nlp = row.get("nlp_rss_mib", 0)
        if nlp > a.ceiling_mib and "nlp" in pids:
            os.kill(pids["nlp"], signal.SIGKILL)
            state["killed"] = True
            crashed.append("nlp(ceiling-killed)")
        await asyncio.sleep(a.sample_s)


def write_outputs(out: Path, samples: list[dict], rows: list[tuple]) -> None:
    cols = sorted({k for s in samples for k in s}, key=lambda k: (k != "t", k))
    with open(out / "samples.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(samples)
    with open(out / "requests.csv", "w", newline="") as f:
        cw = csv.writer(f)
        cw.writerow(["t_epoch", "consultation", "flush", "chars", "status", "latency_ms"])
        cw.writerows(rows)


async def run(a: argparse.Namespace) -> int:
    per_min = a.consultations * 60 / a.cadence_s
    print(
        f"plan: {a.consultations} consultations, flush every {a.cadence_s:g}s (~{per_min:.0f} screen calls/min), "
        f"{a.duration:g}s, attachments on {a.attachment_share:.0%}, ceiling {a.ceiling_mib:.0f} MiB"
    )
    if a.dry_run:
        return 0
    if httpx is None:
        raise SystemExit("httpx is required (use the arcaenv python)")
    nlp_pid = a.nlp_pid or pk.pid_for_port(a.nlp_port)
    gr_pid = a.guardrail_pid or pk.pid_for_port(a.guardrail_port)
    if not nlp_pid or not gr_pid:
        raise SystemExit(
            "could not find nlp/guardrail pids (are they running? or pass --nlp-pid/--guardrail-pid)"
        )
    env = Path(a.env_file) if a.env_file else pk.default_env_file(_HERE)
    token = pk.read_env_value("INTERNAL_ACCESS_TOKEN", env)
    headers = {"content-type": "application/json", "X-Tenant-Id": a.tenant_id}
    if token:
        headers["X-Service-Token"] = token
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(a.seed)
    rows: list[tuple] = []
    samples: list[dict] = []
    crashed: list[str] = []
    state: dict = {}
    t0 = time.time()
    t_end = t0 + a.duration
    limits = httpx.Limits(max_connections=a.consultations + 10)
    async with httpx.AsyncClient(timeout=a.timeout, headers=headers, limits=limits) as client:
        tasks = [
            asyncio.create_task(
                consultation_loop(i, a, client, t_end, rows, random.Random(rng.random()))
            )
            for i in range(a.consultations)
        ]
        samp = asyncio.create_task(
            sampler(a, {"nlp": nlp_pid, "guardrail": gr_pid}, t0, t_end, samples, crashed, state)
        )
        await asyncio.gather(samp)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    write_outputs(out, samples, rows)
    nlp_series = [(s["t"], s["nlp_rss_mib"]) for s in samples if "nlp_rss_mib" in s]
    summary = summarize([r[5] for r in rows], [r[4] for r in rows], nlp_series, a, crashed)
    summary["guardrail_rss_mib_peak"] = max(
        (s.get("guardrail_rss_mib", 0) for s in samples), default=None
    )
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != "verdicts"}, indent=2))
    for k, v in summary["verdicts"].items():
        print(f"{k}: {'PASS' if v['pass'] else 'FAIL'}  {v['detail']}")
    print(f"wrote {out}/samples.csv requests.csv summary.json")
    if state.get("killed"):
        return 2
    return 1 if (a.do_assert and not summary["all_pass"]) else 0


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(run(parse_args(argv)))


if __name__ == "__main__":
    sys.exit(main())
