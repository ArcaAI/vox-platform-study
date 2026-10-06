#!/usr/bin/env python3
"""V2 - NLP memory benchmark for the guard routes (TASK-1047, success criterion S1).

Ported from the TASK-1045 e2e probe that found GLiNER2 memory growing quadratically with
input length. Synthetic text only. Never starts or restarts a service.

Modes
  --direct         POST apps/nlp /api/v1/guard/{pii,classify} (expects 413 above the cap, FC-8)
  --via-guardrail  POST guardrail /api/v1/guardrail/screen/inbound with regions (FC-5)

Extras
  --repeat N       N identical requests; RSS plateau check (no per-request leak)
  --concurrent K   K parallel requests at --repeat-size
  --window-sweep   1000,2000,4000: PII accuracy / latency / peak RSS on a golden JSONL set
  --generate-golden PATH   write the small synthetic golden sample and exit

Safety: RSS of the target pid is sampled every 200 ms; above --ceiling-mib the target is
SIGKILLed and the tool exits 2.  The service token is read from .env.dev and never printed.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import random
import signal
import sys
import threading
import time
from pathlib import Path

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[3] / "scripts" / "perf" / "_perfkit"))
import perfkit as pk  # noqa: E402

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

DEFAULT_SIZES = "1k,2k,4k,8k,16k,32k,64k,200k"
PII_MODEL = "fastino/gliner2-privacy-filter-PII-multi"
CLS_MODEL = "fastino/gliguard-LLMGuardrails-300M"
PII_LABELS = [
    "person",
    "full_name",
    "date_of_birth",
    "email",
    "phone_number",
    "address",
    "government_id",
    "passport_number",
    "bank_account",
    "payment_card",
    "medical_record_number",
    "age",
]
CLS_TASKS = {
    "prompt_safety": {"labels": ["safe", "unsafe"], "multi_label": False},
    "jailbreak_detection": {"labels": ["benign", "jailbreak"], "multi_label": False},
}
DEFAULT_GOLDEN = _HERE.parent / "data" / "pii_golden_sample.jsonl"


# --- args --------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--direct", action="store_true", help="call NLP /guard directly (default)")
    mode.add_argument(
        "--via-guardrail", action="store_true", help="call guardrail /screen/inbound with regions"
    )
    p.add_argument(
        "--sizes", default=DEFAULT_SIZES, help=f"input sizes in chars (default {DEFAULT_SIZES})"
    )
    p.add_argument(
        "--endpoint", choices=["pii", "classify", "both"], default="pii", help="--direct only"
    )
    p.add_argument("--nlp-url", default="http://127.0.0.1:8864")
    p.add_argument("--guardrail-url", default="http://127.0.0.1:8863")
    p.add_argument("--nlp-port", type=int, default=8864, help="port used to find the NLP pid")
    p.add_argument(
        "--pid", type=int, default=None, help="target pid to sample/kill (default: NLP listener)"
    )
    p.add_argument("--tenant-id", default=os.environ.get("HOPE_PERF_TENANT_ID", pk.DEFAULT_TENANT))
    p.add_argument(
        "--env-file", default=None, help="env file holding INTERNAL_ACCESS_TOKEN (default .env.dev)"
    )
    p.add_argument(
        "--ceiling-mib",
        type=float,
        default=12 * 1024,
        help="SIGKILL target above this RSS (default 12288)",
    )
    p.add_argument(
        "--budget-mib",
        type=float,
        default=1024,
        help="S1: max peak above warm baseline per request",
    )
    p.add_argument(
        "--expect-cap-chars",
        type=int,
        default=8192,
        help="--direct: sizes above this must return 413",
    )
    p.add_argument("--timeout", type=float, default=600.0)
    p.add_argument(
        "--repeat",
        type=int,
        default=0,
        help="N identical requests at --repeat-size (plateau check)",
    )
    p.add_argument("--repeat-size", type=int, default=4000)
    p.add_argument("--plateau-tol-mib", type=float, default=64.0)
    p.add_argument(
        "--concurrent", default="", help="CSV of parallelism levels at --repeat-size, e.g. 4,8"
    )
    p.add_argument(
        "--window-sweep",
        default="",
        help="CSV of window sizes, e.g. 1000,2000,4000 (0=unwindowed baseline added)",
    )
    p.add_argument("--overlap", type=int, default=256, help="window overlap for --window-sweep")
    p.add_argument(
        "--golden",
        default=str(DEFAULT_GOLDEN),
        help="golden JSONL {text, spans:[{label,start,end}]}",
    )
    p.add_argument("--iou", type=float, default=0.5)
    p.add_argument(
        "--generate-golden",
        default="",
        metavar="PATH",
        help="write the synthetic golden sample and exit",
    )
    p.add_argument("--json-out", default="", help="write the JSON report here")
    p.add_argument(
        "--assert",
        dest="do_assert",
        action="store_true",
        help="exit 1 when S1 / 413 / plateau checks fail",
    )
    return p


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    a = build_parser().parse_args(argv)
    a.mode = "via-guardrail" if a.via_guardrail else "direct"
    a.size_list = pk.parse_sizes(a.sizes)
    a.concurrent_list = [int(x) for x in a.concurrent.split(",") if x.strip()]
    a.window_list = [int(x) for x in a.window_sweep.split(",") if x.strip()]
    if a.overlap < 0:
        raise SystemExit("--overlap must be >= 0")
    for w in a.window_list:
        if w and a.overlap >= w:
            raise SystemExit(f"--overlap {a.overlap} must be smaller than window {w}")
    return a


# --- pure helpers ------------------------------------------------------------


def evaluate_size(size: int, status: int, delta_mib: float, a: argparse.Namespace) -> dict:
    """Verdict for one size: expected 413 above the cap in --direct, otherwise S1 budget."""
    expect_413 = a.mode == "direct" and size > a.expect_cap_chars
    if expect_413:
        ok = status == 413
        reason = "413 above cap" if ok else f"expected 413, got {status}"
    else:
        ok = status == 200 and delta_mib <= a.budget_mib
        reason = (
            "within budget"
            if ok
            else (
                f"status {status}"
                if status != 200
                else f"+{delta_mib:.0f} MiB > {a.budget_mib:.0f}"
            )
        )
    return {"ok": ok, "expected_413": expect_413, "reason": reason}


def plateau(rss_after: list[float], tol_mib: float) -> dict:
    """Plateau check on RSS-after-each-request: last third vs the middle third's mean (first third = warm-up)."""
    n = len(rss_after)
    if n < 6:
        return {"ok": True, "growth_mib": 0.0, "note": "too few samples"}
    third = n // 3
    mid = rss_after[third : 2 * third]
    last = rss_after[-third:]
    growth = sum(last) / len(last) - sum(mid) / len(mid)
    return {"ok": growth <= tol_mib, "growth_mib": growth}


def render_table(rows: list[dict], cols: list[tuple[str, str]]) -> str:
    widths = [
        max(len(h), *(len(str(r.get(k, ""))) for r in rows)) if rows else len(h) for k, h in cols
    ]
    line = "  ".join(h.ljust(w) for (_, h), w in zip(cols, widths, strict=True))
    body = [
        "  ".join(str(r.get(k, "")).ljust(w) for (k, _), w in zip(cols, widths, strict=True))
        for r in rows
    ]
    return "\n".join([line, "  ".join("-" * w for w in widths), *body])


def score_golden(docs: list[dict], predict, window: int, overlap: int, iou: float) -> dict:
    """Score `predict(window_text) -> spans` over docs. window == 0 => whole text (baseline)."""
    tp = fp = fn = 0
    for d in docs:
        wins = [(0, d["text"])] if window == 0 else pk.split_windows(d["text"], window, overlap)
        merged = pk.merge_window_spans([(s, predict(t)) for s, t in wins], iou)
        a, b, c = pk.score_spans(d["spans"], merged, iou)
        tp, fp, fn = tp + a, fp + b, fn + c
    return {"tp": tp, "fp": fp, "fn": fn, **pk.prf(tp, fp, fn)}


def load_golden(path: Path) -> list[dict]:
    docs = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    for d in docs:
        for s in d["spans"]:
            if not (0 <= s["start"] < s["end"] <= len(d["text"])):
                raise ValueError("golden span out of range")
    return docs


# --- golden sample generator (synthetic, deterministic) ----------------------

_FIRST = ["Alana", "Bram", "Chidi", "Dara", "Elio", "Fenna", "Gus", "Hana"]
_LAST = ["Quillfeather", "Ormsby", "Vantongeren", "Dlamini", "Ashcombe", "Ruiz-Okafor"]


def generate_golden(n_docs: int = 12, seed: int = 1047) -> list[dict]:
    rng = random.Random(seed)
    docs = []
    for d in range(n_docs):
        text, spans = "", []
        target = rng.choice([1500, 2500, 4000, 6000])
        i = 0
        while len(text) < target:
            if rng.random() < 0.25:
                name = f"{rng.choice(_FIRST)} {rng.choice(_LAST)}"
                kind = rng.choice(
                    ["person", "email", "phone_number", "date_of_birth", "medical_record_number"]
                )
                val = {
                    "person": name,
                    "email": f"{name.split()[0].lower()}{rng.randint(1, 99)}@example.invalid",
                    "phone_number": f"+1 555 01{rng.randint(10, 99)} {rng.randint(1000, 9999)}",
                    "date_of_birth": f"{rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}/{rng.randint(1950, 2005)}",
                    "medical_record_number": f"MRN-{rng.randint(100000, 999999)}",
                }[kind]
                lead = {
                    "person": "The patient is ",
                    "email": "Contact email ",
                    "phone_number": "Call back on ",
                    "date_of_birth": "Date of birth ",
                    "medical_record_number": "Record number ",
                }[kind]
                text += lead
                spans.append({"label": kind, "start": len(text), "end": len(text) + len(val)})
                text += val + ". "
            else:
                text += pk.synth_text(120, seed=d * 100 + i).split(" (")[0] + ". "
            i += 1
        docs.append({"id": f"synthetic-{d:02d}", "text": text, "spans": spans})
    return docs


# --- runtime (network) -------------------------------------------------------


class Target:
    def __init__(self, a: argparse.Namespace):
        self.a = a
        self.pid = a.pid or pk.pid_for_port(a.nlp_port)
        if not self.pid:
            raise SystemExit(
                "target process not found (is NLP running on --nlp-port? or pass --pid)"
            )
        env = Path(a.env_file) if a.env_file else pk.default_env_file(_HERE)
        token = pk.read_env_value("INTERNAL_ACCESS_TOKEN", env)
        self.headers = {"content-type": "application/json", "X-Tenant-Id": a.tenant_id}
        if token:
            self.headers["X-Service-Token"] = token
        self.client = httpx.Client(timeout=a.timeout)
        self.killed = False

    def rss(self) -> float:
        return pk.rss_mib(self.pid)

    def post(self, url: str, body: dict) -> tuple[int, float]:
        t0 = time.time()
        try:
            r = self.client.post(url, json=body, headers=self.headers)
            return r.status_code, time.time() - t0
        except httpx.HTTPError:
            return 0, time.time() - t0

    def post_json(self, url: str, body: dict) -> tuple[int, dict | None, float]:
        t0 = time.time()
        r = self.client.post(url, json=body, headers=self.headers)
        try:
            data = r.json()
        except ValueError:
            data = None
        return r.status_code, data, time.time() - t0


class PeakSampler:
    def __init__(self, tgt: Target, ceiling_mib: float):
        self.tgt, self.ceiling, self.peak, self._stop = tgt, ceiling_mib, 0.0, threading.Event()
        self.th = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            v = self.tgt.rss()
            self.peak = max(self.peak, v)
            if v > self.ceiling:
                os.kill(self.tgt.pid, signal.SIGKILL)
                self.tgt.killed = True
                return
            self._stop.wait(0.2)

    def __enter__(self):
        self.peak = self.tgt.rss()
        self.th.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self.th.join()


def request_for(a: argparse.Namespace, kind: str, n: int) -> tuple[str, dict]:
    text = pk.synth_text(n)
    if a.mode == "via-guardrail":
        return f"{a.guardrail_url}/api/v1/guardrail/screen/inbound", {
            "text": "",
            "regions": [{"key": "transcript", "text": text}],
            "kind": "transcript",
            "include_pii_spans": True,
            "wrap": False,
        }
    if kind == "pii":
        return f"{a.nlp_url}/api/v1/guard/pii", {
            "text": text,
            "labels": PII_LABELS,
            "threshold": 0.5,
            "model_name": PII_MODEL,
            "tenant_id": a.tenant_id,
            "latency_class": "bulk",
        }
    return f"{a.nlp_url}/api/v1/guard/classify", {
        "text": text,
        "tasks": CLS_TASKS,
        "threshold": 0.5,
        "model_name": CLS_MODEL,
        "tenant_id": a.tenant_id,
        "latency_class": "bulk",
    }


def measure(tgt: Target, label: str, fn) -> dict:
    before = tgt.rss()
    with PeakSampler(tgt, tgt.a.ceiling_mib) as s:
        result = fn()
    time.sleep(1.5)
    after = tgt.rss()
    row = {
        "label": label,
        "before_mib": round(before),
        "peak_mib": round(s.peak),
        "after_mib": round(after),
        "delta_mib": round(s.peak - before),
        "result": result,
        "killed": tgt.killed,
    }
    print(
        f"{label:34} before={before:7.0f} peak={s.peak:7.0f} after={after:7.0f} MiB  result={result}"
        + ("  ** CEILING HIT, TARGET KILLED **" if tgt.killed else ""),
        flush=True,
    )
    if tgt.killed:
        raise CeilingHit(row)
    return row


class CeilingHit(Exception):
    def __init__(self, row: dict):
        super().__init__("ceiling hit")
        self.row = row


def run(a: argparse.Namespace) -> int:
    if a.generate_golden:
        docs = generate_golden()
        Path(a.generate_golden).write_text("".join(json.dumps(d) + "\n" for d in docs))
        print(f"wrote {len(docs)} synthetic docs to {a.generate_golden}")
        return 0
    if httpx is None:
        raise SystemExit("httpx is required (use the arcaenv python)")
    tgt = Target(a)
    report: dict = {
        "mode": a.mode,
        "pid": tgt.pid,
        "ceiling_mib": a.ceiling_mib,
        "budget_mib": a.budget_mib,
        "sizes": [],
        "repeat": None,
        "concurrent": [],
        "window_sweep": [],
        "failures": [],
    }
    kinds = ["pii", "classify"] if a.endpoint == "both" else [a.endpoint]
    print(f"target pid={tgt.pid} start rss={tgt.rss():.0f} MiB mode={a.mode}", flush=True)
    code = 0
    try:
        for kind in (kinds if a.mode == "direct" else ["screen"]):
            url, body = request_for(a, kind, 200)
            measure(tgt, f"warm-up {kind} 200", lambda url=url, body=body: tgt.post(url, body)[0])
            for n in a.size_list:
                url, body = request_for(a, kind, n)
                st = {}

                def go(url=url, body=body, st=st):
                    st["code"], st["lat"] = tgt.post(url, body)
                    return st["code"]

                row = measure(tgt, f"{kind} {n} chars", go)
                v = evaluate_size(n, st["code"], row["delta_mib"], a)
                row.update(kind=kind, size=n, latency_s=round(st["lat"], 3), **v)
                report["sizes"].append(row)
                if not v["ok"]:
                    report["failures"].append(f"{kind} {n}: {v['reason']}")
        kind0 = kinds[0] if a.mode == "direct" else "screen"
        if a.repeat:
            url, body = request_for(a, kind0, a.repeat_size)
            rss_after: list[float] = []

            def rep():
                for _ in range(a.repeat):
                    tgt.post(url, body)
                    rss_after.append(tgt.rss())
                return f"{a.repeat} requests"

            row = measure(tgt, f"repeat x{a.repeat} @{a.repeat_size}", rep)
            pl = plateau(rss_after, a.plateau_tol_mib)
            report["repeat"] = {**row, **pl, "rss_series_mib": [round(x) for x in rss_after]}
            print(
                f"  plateau: ok={pl['ok']} growth={pl['growth_mib']:.0f} MiB (tol {a.plateau_tol_mib:.0f})"
            )
            if not pl["ok"]:
                report["failures"].append(f"repeat plateau growth {pl['growth_mib']:.0f} MiB")
        for k in a.concurrent_list:
            url, body = request_for(a, kind0, a.repeat_size)

            def conc(k=k, url=url, body=body):
                with cf.ThreadPoolExecutor(k) as ex:
                    return [
                        f.result()[0] for f in [ex.submit(tgt.post, url, body) for _ in range(k)]
                    ]

            report["concurrent"].append(
                measure(tgt, f"{kind0} x{k} concurrent @{a.repeat_size}", conc)
            )
        if a.window_list:
            report["window_sweep"] = window_sweep(tgt, a)
    except CeilingHit as e:
        report["failures"].append("ceiling hit - target killed")
        report["ceiling_row"] = e.row
        code = 2
    print()
    print(
        render_table(
            report["sizes"],
            [
                ("kind", "kind"),
                ("size", "chars"),
                ("before_mib", "before"),
                ("peak_mib", "peak"),
                ("delta_mib", "delta"),
                ("latency_s", "lat_s"),
                ("ok", "ok"),
                ("reason", "note"),
            ],
        )
    )
    if report["window_sweep"]:
        print()
        print(
            render_table(
                report["window_sweep"],
                [
                    ("window", "window"),
                    ("precision", "P"),
                    ("recall", "R"),
                    ("f1", "F1"),
                    ("p50_ms", "p50ms"),
                    ("p95_ms", "p95ms"),
                    ("peak_mib", "peakMiB"),
                ],
            )
        )
    s1 = [r for r in report["sizes"] if not r["expected_413"]]
    report["s1_max_delta_mib"] = max((r["delta_mib"] for r in s1), default=None)
    report["s1_pass"] = not report["failures"] and code == 0
    print(
        f"\nS1 (peak <= {a.budget_mib:.0f} MiB above baseline, accepted sizes): "
        f"{'PASS' if report['s1_pass'] else 'FAIL'}  max delta={report['s1_max_delta_mib']}"
    )
    for f in report["failures"]:
        print("  FAIL:", f)
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(report, indent=2))
    if code:
        return code
    return 1 if (a.do_assert and report["failures"]) else 0


def window_sweep(tgt: Target, a: argparse.Namespace) -> list[dict]:
    docs = load_golden(Path(a.golden))
    url = f"{a.nlp_url}/api/v1/guard/pii"
    out = []
    for w in [0, *a.window_list]:
        lat: list[float] = []

        def predict(text: str, lat: list[float] = lat) -> list[dict]:
            body = {
                "text": text,
                "labels": PII_LABELS,
                "threshold": 0.5,
                "model_name": PII_MODEL,
                "tenant_id": a.tenant_id,
                "latency_class": "bulk",
            }
            st, data, dt = tgt.post_json(url, body)
            lat.append(dt * 1000)
            return (data or {}).get("entities", []) if st == 200 else []

        before = tgt.rss()
        with PeakSampler(tgt, a.ceiling_mib) as s:
            sc = score_golden(docs, predict, w, a.overlap, a.iou)
        if tgt.killed:
            raise CeilingHit({"window": w})
        row = {
            "window": w or "unwindowed",
            **{k: round(sc[k], 4) for k in ("precision", "recall", "f1")},
            "tp": sc["tp"],
            "fp": sc["fp"],
            "fn": sc["fn"],
            "p50_ms": round(pk.percentile(lat, 50)),
            "p95_ms": round(pk.percentile(lat, 95)),
            "peak_mib": round(s.peak),
            "delta_mib": round(s.peak - before),
        }
        out.append(row)
        print(
            f"window={row['window']}: P={row['precision']} R={row['recall']} F1={row['f1']} p95={row['p95_ms']}ms peak={row['peak_mib']}MiB",
            flush=True,
        )
    return out


def main(argv: list[str] | None = None) -> int:
    return run(parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
