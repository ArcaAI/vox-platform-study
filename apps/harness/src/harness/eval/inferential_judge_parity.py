"""E0 — offline dual-judge parity instrument for the R-8 entailment swap.

The decisive gate for R-8 (a faster groundedness judge) is NOT overall accuracy — it is
**conservative-direction parity** against the currently-shipped judge. Phase-B batching was
rejected precisely because it loosened two *stable* verdicts on real clinical content, so
R-8 inherits the same bar: the candidate must not regrade any claim the incumbent calls
*ungrounded* into *grounded*.

This module runs the live :class:`~harness.sensors.inferential.groundedness.GroundednessSensor`
over a golden set TWICE per case — once with the incumbent judge (gemma, the proxy truth)
and once with the R-8a candidate (``GraniteGroundednessJudge``) — over the **same** derived
claims, and emits the per-claim directional confusion matrix:

* **unsafe flip** — incumbent *ungrounded* → candidate *grounded* (candidate LOOSENED; the
  gate forbids these). Each is exported for human adjudication (Q2: gemma is a proxy, not
  truth — a "loosening" may be the candidate correctly overturning a gemma over-flag).
* **safe flip** — incumbent *grounded* → candidate *ungrounded* (candidate stricter;
  tolerable, only noisier).

It reuses ``inferential_corpus_eval.build_inferential_context`` so the claim derivation is
identical to that harness; cases run sequentially to be kind to one local GPU.

Run it (both models must be resident in LM Studio — gemma judge + granite-guardian)::

    HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT=text \\
    HARNESS_JUDGE_MAX_TOKENS=3072 \\
    conda run -n arcaenv python -m harness.eval.inferential_judge_parity \\
      --golden-set apps/harness/src/harness/eval/golden/fixtures/curated_v1.json \\
      --output inferential-judge-parity.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from harness.core.config import get_runtime_judge_config, get_settings
from harness.eval.golden.sources import JSONFileGoldenSetSource
from harness.eval.inferential_corpus_eval import build_inferential_context
from harness.eval.judge.base import JudgeClient
from harness.eval.judge.providers import build_judge_client
from harness.eval.models import GoldenCase, GoldenSet
from harness.sensors.config import SensorThresholds
from harness.sensors.inferential import GraniteGroundednessJudge, GroundednessSensor
from harness.sensors.inferential.groundedness import _claim_ref

_PREMISE_EXCERPT_CHARS = 240


class ClaimDisagreement(BaseModel):
    """One claim where the two judges disagree (the adjudication unit)."""

    model_config = ConfigDict(extra="forbid")

    case_id: str
    claim_ref: str
    claim_text: str
    section: str
    premise_excerpt: str
    incumbent_grounded: bool
    candidate_grounded: bool
    kind: Literal["unsafe_flip", "safe_flip"]


class ParityCaseResult(BaseModel):
    """The dual-judge groundedness comparison for one golden case."""

    model_config = ConfigDict(extra="forbid")

    case_id: str
    role: str
    n_claims: int
    agree: int
    unsafe_flips: int
    safe_flips: int
    incumbent_degraded: bool
    candidate_degraded: bool
    incumbent_elapsed_s: float
    candidate_elapsed_s: float
    disagreements: list[ClaimDisagreement] = Field(default_factory=list)


def diff_verdicts(
    claims: list[dict[str, Any]],
    incumbent_ungrounded: set[str],
    candidate_ungrounded: set[str],
    *,
    case_id: str = "",
    transcript: str = "",
) -> tuple[dict[str, int], list[ClaimDisagreement]]:
    """Per-claim directional confusion of two groundedness verdict sets (pure).

    A claim is *grounded* for a judge iff its ref is NOT in that judge's ungrounded set.
    Only claims with non-empty text are comparable (an empty claim asserts nothing → it is
    grounded for both and carries no signal).
    """
    excerpt = transcript.strip().replace("\n", " ")[:_PREMISE_EXCERPT_CHARS]
    agree = unsafe = safe = n = 0
    disagreements: list[ClaimDisagreement] = []
    for claim in claims:
        text = str(claim.get("text") or "").strip()
        if not text:
            continue
        n += 1
        ref = _claim_ref(claim)
        inc_grounded = ref not in incumbent_ungrounded
        cand_grounded = ref not in candidate_ungrounded
        if inc_grounded == cand_grounded:
            agree += 1
            continue
        if not inc_grounded and cand_grounded:
            unsafe += 1
            kind: Literal["unsafe_flip", "safe_flip"] = "unsafe_flip"
        else:
            safe += 1
            kind = "safe_flip"
        disagreements.append(
            ClaimDisagreement(
                case_id=case_id,
                claim_ref=ref,
                claim_text=text,
                section=str(claim.get("section") or ""),
                premise_excerpt=excerpt,
                incumbent_grounded=inc_grounded,
                candidate_grounded=cand_grounded,
                kind=kind,
            )
        )
    return {
        "n_claims": n,
        "agree": agree,
        "unsafe_flips": unsafe,
        "safe_flips": safe,
    }, disagreements


async def _timed_groundedness(
    ctx: Any, *, judge: JudgeClient, threshold: float
) -> tuple[Any, float]:
    sensor = GroundednessSensor(threshold=threshold)
    started = time.monotonic()
    res = await sensor.arun(ctx, judge=judge)
    return res, round(time.monotonic() - started, 3)


async def score_case_parity(
    case: GoldenCase,
    *,
    incumbent: JudgeClient,
    candidate: JudgeClient,
    threshold: float,
) -> ParityCaseResult:
    """Run groundedness with both judges over one case and diff the per-claim verdicts.

    A degraded run on either side yields no comparable verdicts (the case is recorded
    degraded and contributes nothing to the gate) — a degrade is a backend failure, never
    silently treated as agreement.
    """
    ctx = build_inferential_context(case)
    claims = ctx.claims()
    inc_res, inc_elapsed = await _timed_groundedness(ctx, judge=incumbent, threshold=threshold)
    cand_res, cand_elapsed = await _timed_groundedness(ctx, judge=candidate, threshold=threshold)

    if inc_res.degraded or cand_res.degraded:
        return ParityCaseResult(
            case_id=case.case_id,
            role=case.role,
            n_claims=0,
            agree=0,
            unsafe_flips=0,
            safe_flips=0,
            incumbent_degraded=inc_res.degraded,
            candidate_degraded=cand_res.degraded,
            incumbent_elapsed_s=inc_elapsed,
            candidate_elapsed_s=cand_elapsed,
        )

    inc_ung = set(inc_res.details.get("ungrounded", []))
    cand_ung = set(cand_res.details.get("ungrounded", []))
    counts, dis = diff_verdicts(
        claims, inc_ung, cand_ung, case_id=case.case_id, transcript=ctx.transcript_text
    )
    return ParityCaseResult(
        case_id=case.case_id,
        role=case.role,
        n_claims=counts["n_claims"],
        agree=counts["agree"],
        unsafe_flips=counts["unsafe_flips"],
        safe_flips=counts["safe_flips"],
        incumbent_degraded=False,
        candidate_degraded=False,
        incumbent_elapsed_s=inc_elapsed,
        candidate_elapsed_s=cand_elapsed,
        disagreements=dis,
    )


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


def summarize_parity(results: list[ParityCaseResult]) -> dict[str, Any]:
    """Corpus aggregate + the R-8 go/no-go gate (zero unsafe flips on real evidence)."""
    unsafe_total = sum(r.unsafe_flips for r in results)
    safe_total = sum(r.safe_flips for r in results)
    agree_total = sum(r.agree for r in results)
    compared = sum(r.n_claims for r in results)
    unsafe_dis = [
        d.model_dump() for r in results for d in r.disagreements if d.kind == "unsafe_flip"
    ]
    safe_dis = [d.model_dump() for r in results for d in r.disagreements if d.kind == "safe_flip"]
    return {
        "n_cases": len(results),
        "n_incumbent_degraded": sum(1 for r in results if r.incumbent_degraded),
        "n_candidate_degraded": sum(1 for r in results if r.candidate_degraded),
        "n_claims_compared": compared,
        "agree_total": agree_total,
        "unsafe_flips_total": unsafe_total,
        "safe_flips_total": safe_total,
        "agreement_rate": round(agree_total / compared, 4) if compared else None,
        "incumbent_mean_elapsed_s": _mean([r.incumbent_elapsed_s for r in results]),
        "candidate_mean_elapsed_s": _mean([r.candidate_elapsed_s for r in results]),
        # The R-8 gate: zero unsafe (ungrounded→grounded) flips, computed on real evidence.
        "passed": unsafe_total == 0 and compared > 0,
        "unsafe_flip_disagreements": unsafe_dis,
        "safe_flip_disagreements": safe_dis,
    }


async def run_parity(
    golden_set: GoldenSet, *, threshold: float, limit: int | None = None
) -> dict[str, Any]:
    """Score every case with the incumbent + R-8a candidate judges; return the report."""
    incumbent = build_judge_client(get_runtime_judge_config())
    candidate = GraniteGroundednessJudge(get_settings().safety)

    cases = golden_set.cases if limit is None else golden_set.cases[:limit]
    results: list[ParityCaseResult] = []
    for case in cases:
        res = await score_case_parity(
            case, incumbent=incumbent, candidate=candidate, threshold=threshold
        )
        results.append(res)
        flag = (
            "DEGRADED"
            if (res.incumbent_degraded or res.candidate_degraded)
            else f"unsafe={res.unsafe_flips} safe={res.safe_flips} agree={res.agree}"
        )
        print(
            f"  - {res.case_id} [{res.role}] claims={res.n_claims} {flag} "
            f"(inc {res.incumbent_elapsed_s}s / cand {res.candidate_elapsed_s}s)",
            flush=True,
        )

    return {
        "golden_set_version": golden_set.version,
        "incumbent_model": incumbent.model,
        "candidate_model": candidate.model,
        "groundedness_threshold": threshold,
        "aggregate": summarize_parity(results),
        "cases": [r.model_dump() for r in results],
    }


def _run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--golden-set",
        default=str(Path(__file__).parent / "golden" / "fixtures" / "curated_v1.json"),
        help="Path to the golden-set JSON (default: curated_v1.json).",
    )
    parser.add_argument("--output", default="", help="Optional path to write the JSON report.")
    parser.add_argument("--limit", type=int, default=None, help="Score only the first N cases.")
    parser.add_argument(
        "--threshold",
        type=float,
        default=SensorThresholds().groundedness_threshold,
        help="Groundedness pass threshold (default: SensorThresholds default).",
    )
    args = parser.parse_args(argv)

    golden_set = JSONFileGoldenSetSource(args.golden_set).load()
    n = len(golden_set.cases) if args.limit is None else min(args.limit, len(golden_set.cases))
    print(
        f"[inferential-judge-parity] golden_set='{golden_set.version}' cases={n} "
        f"threshold={args.threshold}",
        flush=True,
    )
    report = asyncio.run(run_parity(golden_set, threshold=args.threshold, limit=args.limit))

    agg = report["aggregate"]
    print("\n[inferential-judge-parity] aggregate:")
    print(json.dumps({k: v for k, v in agg.items() if not k.endswith("disagreements")}, indent=2))

    unsafe = agg["unsafe_flip_disagreements"]
    verdict = (
        "PASS ✅ (zero unsafe flips)"
        if agg["passed"]
        else f"FAIL ❌ ({len(unsafe)} unsafe flip(s) — adjudicate before any swap)"
    )
    print(f"\n[inferential-judge-parity] R-8 gate: {verdict}")
    for d in unsafe:
        print(
            f"  UNSAFE  {d['case_id']} :: {d['claim_ref']} [{d['section']}] "
            f"incumbent=ungrounded candidate=grounded\n          claim: {d['claim_text']!r}",
            flush=True,
        )

    if args.output:
        Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\n[inferential-judge-parity] wrote report -> {args.output}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    sys.exit(_run())
