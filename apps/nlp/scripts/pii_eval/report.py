"""Report assembly (JSON) and rendering (markdown), plus the OD-30 decision rule."""

from __future__ import annotations

from collections.abc import Mapping

from injection_eval.core import clopper_pearson

#: OD-30 (TASK-1050 §10.9): residual direct-identifier PHI <= 1 % (recall >= 99 %),
#: clinical over-mask <= 2 %, CPU p95 <= 400 ms per 2k window.
DECISION_RULE = {"residual_direct_max": 0.01, "overmask_max": 0.02, "p95_ms_max": 400.0}


def decide(report: Mapping) -> dict:
    """Pass / fail per OD-30 criterion, using the one-sided 95 % upper bound for the rates.

    A rate is only `pass` when its upper bound clears the bar; a point estimate under the
    bar with a bound above it is `inconclusive` (too few examples to claim it).
    """
    res = report["masking"]["residual"]["direct"]
    over = report["masking"]["overmask"]["overall"]

    def judge(k: int, n: int, bar: float) -> dict:
        if n == 0:
            return {"verdict": "no-data", "rate": None, "upper95": None}
        upper = clopper_pearson(k, n)[1]
        rate = k / n
        verdict = "pass" if upper <= bar else ("inconclusive" if rate <= bar else "fail")
        return {"verdict": verdict, "rate": rate, "upper95": upper, "k": k, "n": n}

    out = {
        "residual_direct": judge(
            res["leaked_any"], res["spans"], DECISION_RULE["residual_direct_max"]
        ),
        "overmask": judge(over["overmasked"], over["negatives"], DECISION_RULE["overmask_max"]),
    }
    lat = report.get("latency_per_window")
    if lat:
        out["latency_p95"] = {
            "verdict": "pass" if lat["p95_ms"] <= DECISION_RULE["p95_ms_max"] else "fail",
            "p95_ms": lat["p95_ms"],
        }
    return out


def _pct(x: float | None, digits: int = 2) -> str:
    return "n/a" if x is None else f"{100 * x:.{digits}f}%"


def _row(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def render_markdown(report: Mapping) -> str:
    meta = report.get("meta", {})
    out = [f"# PII evaluation: {report.get('detector', meta.get('detector', '?'))}", ""]
    if meta:
        out += [f"- {k}: {v}" for k, v in sorted(meta.items())] + [""]
    out += [
        f"Documents {report['documents']}, gold spans {report['gold_spans']}, "
        f"hard negatives {report['hard_negatives']}.",
        "",
        "## Decision rule (OD-30)",
        "",
        _row(["criterion", "verdict", "rate", "upper 95%", "bar"]),
        _row(["---"] * 5),
    ]
    bars = {
        "residual_direct": f"<= {_pct(DECISION_RULE['residual_direct_max'], 0)}",
        "overmask": f"<= {_pct(DECISION_RULE['overmask_max'], 0)}",
        "latency_p95": f"<= {DECISION_RULE['p95_ms_max']:.0f} ms",
    }
    for name, d in decide(report).items():
        if name == "latency_p95":
            out.append(_row([name, d["verdict"], f"{d['p95_ms']} ms", "", bars[name]]))
        else:
            out.append(_row([name, d["verdict"], _pct(d["rate"]), _pct(d["upper95"]), bars[name]]))
    res = report["masking"]["residual"]
    out += ["", "## Residual PHI after masking (production Pseudonymizer)", ""]
    out += [
        _row(["group", "spans", "leaked (any char)", "rate", "leaked (substantive)", "rate"]),
        _row(["---"] * 6),
    ]
    for name in ("overall", "direct", "quasi"):
        r = res[name]
        out.append(
            _row(
                [
                    name,
                    str(r["spans"]),
                    str(r["leaked_any"]),
                    _pct(r["rate_any"]),
                    str(r["leaked_substantive"]),
                    _pct(r["rate_substantive"]),
                ]
            )
        )
    out += [
        "",
        f"Verbatim survivors: {res['verbatim_survivors']} of {res['verbatim_values']} distinct values.",
        "",
    ]
    out += [_row(["label", "spans", "leaked (any)", "rate"]), _row(["---"] * 4)]
    for label, r in res["by_label"].items():
        out.append(_row([label, str(r["spans"]), str(r["leaked_any"]), _pct(r["rate_any"])]))
    over = report["masking"]["overmask"]
    out += ["", "## Clinical over-mask (hard negatives touched by a mask)", ""]
    out += [_row(["kind", "negatives", "over-masked", "rate"]), _row(["---"] * 4)]
    for kind, r in over["by_kind"].items():
        out.append(_row([kind, str(r["negatives"]), str(r["overmasked"]), _pct(r["rate"])]))
    o = over["overall"]
    out.append(_row(["**all**", str(o["negatives"]), str(o["overmasked"]), _pct(o["rate"])]))
    cl = report["masking"]["clinician"]
    out += ["", f"Clinician names masked (neutral): {cl['masked']} of {cl['spans']}.", ""]
    rs, su = report["masking"]["restore"], report["masking"]["surrogate"]
    out += [
        "## Masking contract",
        "",
        f"- Restore round trip exact: {rs['exact']} of {rs['documents']} documents ({_pct(rs['rate'])}).",
        f"- Surrogate consistency: {su['entities']} multi-mention entities, {su['inconsistent']} "
        f"got more than one token ({_pct(su['consistent_rate'])} consistent); "
        f"{su['surface_inconsistent']} same-spelling splits; {su['collisions']} shared tokens.",
        "",
    ]
    for mode in ("strict", "relaxed"):
        t = report["spans"][mode]
        m = t["micro"]
        out += [f"## Span detection, {mode}", ""]
        out += [
            f"Micro P {_pct(m['precision'])} / R {_pct(m['recall'])} / F1 {_pct(m['f1'])} "
            f"(tp {m['tp']}, fp {m['fp']}, fn {m['fn']}).",
            "",
            _row(["label", "gold", "recall", "emitted", "precision", "F1"]),
            _row(["---"] * 6),
        ]
        for label, r in t["labels"].items():
            out.append(
                _row(
                    [
                        label,
                        str(r["gold"]),
                        _pct(r["recall"]),
                        str(r["emitted"]),
                        _pct(r["precision"]),
                        _pct(r["f1"]),
                    ]
                )
            )
        out.append("")
    if "latency_per_window" in report:
        lat = report["latency_per_window"]
        out += [
            "## Latency per window (single-window calls)",
            "",
            f"n {lat['n']}, p50 {lat['p50_ms']} ms, p95 {lat['p95_ms']} ms, mean {lat['mean_ms']} ms.",
            "",
        ]
    if "rss_probe" in report:
        out += [
            "## RSS growth on long inputs",
            "",
            _row(["chars", "windowed", "before MiB", "after MiB", "growth MiB", "seconds"]),
            _row(["---"] * 6),
        ]
        for r in report["rss_probe"]:
            out.append(
                _row(
                    [
                        str(r["chars"]),
                        str(r["windowed"]),
                        str(r["rss_before_mib"]),
                        str(r["rss_after_mib"]),
                        str(r["growth_mib"]),
                        str(r["seconds"]),
                    ]
                )
            )
        out.append("")
    return "\n".join(out)
