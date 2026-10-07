#!/usr/bin/env python3
"""TASK-1049 — render the granite concurrency matrix into one self-contained HTML page.

Reads <results>/<config>/{requests.jsonl,system.jsonl,summary.json} for every config and
writes an HTML page (inline SVG drawn by inline JS, no external libraries) with:
summary table + SLO verdicts, a 25-session lane chart per config, requests-in-flight
over time, latency-vs-time scatter, and a latency CDF across configs.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

CONFIG_ORDER = ["p4-c8192", "p10-c8192", "p10-c16384", "p10-c32768", "p32-c8192"]


def load(results: Path) -> dict:
    data = {}
    for cfg in CONFIG_ORDER:
        d = results / cfg
        if not (d / "summary.json").exists():
            continue
        reqs = [json.loads(x) for x in (d / "requests.jsonl").read_text().splitlines() if x]
        sysd = [json.loads(x) for x in (d / "system.jsonl").read_text().splitlines() if x]
        data[cfg] = {
            "summary": json.loads((d / "summary.json").read_text()),
            # compact: [session, phase(0 steady/1 burst), check idx, submit, end, ok, flush]
            "req": [
                [r["session"], 0 if r["phase"] == "steady" else 1,
                 ["harm", "jailbreak", "medical_scope"].index(r["check"]),
                 r["submit_s"], r["end_s"], 1 if r["ok"] else 0, r["flush"]]
                for r in reqs
            ],
            "sys": [[s["t"], s["in_flight"], s["llama_rss_mib"], s["pressure_level"],
                     s["swap_used_mib"]] for s in sysd],
        }
    return data


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    ap.add_argument("--template", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--meta", default="{}", help="JSON with host/model notes")
    a = ap.parse_args()
    data = load(Path(a.results))
    html = Path(a.template).read_text()
    html = html.replace("/*__DATA__*/null", json.dumps(data, separators=(",", ":")))
    html = html.replace("/*__META__*/null", a.meta)
    Path(a.out).write_text(html)
    print(f"wrote {a.out} with configs {list(data)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
