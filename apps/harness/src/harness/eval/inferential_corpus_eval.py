"""Corpus-level Phase-2 inferential-sensor eval over a curated golden set.

Closes the Phase-2 eval gap. The initial Phase-2 verification ran the live
:class:`~harness.sensors.inferential.groundedness.GroundednessSensor` +
:class:`~harness.sensors.inferential.safety.SafetySensor` over only THREE crafted
micro-cases (see ``apps/harness/eval/README.md``), not a corpus. This module runs
the SAME two inferential sensors over EVERY case of a golden set (e.g.
``curated_v1.json``) using the live calibrated judge (LM Studio
``google/gemma-4-e4b`` via :func:`harness.core.config.get_runtime_judge_config`)
and live IBM Granite Guardian (Ollama), then aggregates a corpus-level delta: the
``groundedness`` + ``ragTriadScore`` distribution, the safety PASS/FLAG tally, and
the agreement of each live signal against the fixture's curated PDSQI reference
labels.

It mirrors the Temporal ``run_inferential_sensors`` activity's context build
(``SensorContext(note_text, transcript_text, citations_map)``) and per-draft
``asyncio.gather(groundedness, safety)`` fan-out (the two sensors hit different
backends — LM Studio vs Ollama — so they are concurrent within a case; cases run
sequentially to be kind to a single local GPU).

**Claim provenance (integrity caveat).** The one input the activity gets upstream
that a golden case lacks is the ``citationsMap``: production derives it from live
NLP NER spans (:func:`harness.services.provenance.build_citations_map`). NLP is
intentionally out of scope here, so claims are derived eval-side by segmenting the
note into sentence-level claims and mapping each inline ``<Note ID:N>`` marker to
its cited ``source_documents[N-1]`` as evidence. The judge / Granite verdicts are
fully live; only the claim SEGMENTATION is eval-side.

Run it (the judge defaults to LM Studio ``google/gemma-4-e4b``; set the json
response-format to ``text`` so LM Studio accepts the ``json_mode`` entailment
calls, and keep ``max_tokens`` ≤ the loaded context window)::

    HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT=text \\
    HARNESS_JUDGE_MAX_TOKENS=3072 \\
    conda run -n arcaenv python -m harness.eval.inferential_corpus_eval \\
      --golden-set apps/harness/src/harness/eval/golden/fixtures/curated_v1.json \\
      --output inferential-corpus-eval.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from harness.core.config import get_runtime_judge_config, get_settings
from harness.eval.golden.sources import JSONFileGoldenSetSource
from harness.eval.judge.base import JudgeClient
from harness.eval.judge.providers import build_judge_client
from harness.eval.models import GoldenCase, GoldenSet
from harness.sensors.base import SensorContext
from harness.sensors.config import SensorThresholds
from harness.sensors.inferential import (
    GraniteGuardianClient,
    GroundednessSensor,
    SafetySensor,
)

# SOAP section header ("Subjective:" …) -> single-letter code (matches the sensors).
_SECTION_HEADERS = {"subjective": "S", "objective": "O", "assessment": "A", "plan": "P"}
_HEADER_RE = re.compile(r"\b(Subjective|Objective|Assessment|Plan)\s*:\s*", re.IGNORECASE)
# Inline citation marker "<Note ID:1>" (tolerant of whitespace/case).
_NOTE_ID_RE = re.compile(r"<\s*Note\s*ID\s*:\s*(\d+)\s*>", re.IGNORECASE)
# Sentence boundary: a period followed by whitespace + a capital letter. Numeric
# decimals ("37.0 C", "8.2 percent") are NOT split (no space+capital follows).
_SENTENCE_SPLIT_RE = re.compile(r"(?<=\.)\s+(?=[A-Z])")
_DEFAULT_SECTION = "A"


def _section_segments(note: str) -> list[tuple[str, str]]:
    """Split a note into ``(section_code, text)`` chunks by its SOAP headers.

    Text before the first header (or a header-less note) is attributed to the
    default ``A`` section, exactly as ``provenance._derive_section`` falls back.
    """
    matches = list(_HEADER_RE.finditer(note))
    if not matches:
        stripped = note.strip()
        return [(_DEFAULT_SECTION, stripped)] if stripped else []

    segments: list[tuple[str, str]] = []
    pre = note[: matches[0].start()].strip()
    if pre:
        segments.append((_DEFAULT_SECTION, pre))
    for i, match in enumerate(matches):
        code = _SECTION_HEADERS[match.group(1).lower()]
        end = matches[i + 1].start() if i + 1 < len(matches) else len(note)
        text = note[match.end() : end].strip()
        if text:
            segments.append((code, text))
    return segments


def _clean_claim_text(sentence: str) -> str:
    """Strip ``<Note ID:N>`` markers and tidy whitespace before punctuation."""
    text = _NOTE_ID_RE.sub("", sentence)
    text = re.sub(r"\s+([.,;:])", r"\1", text)
    return " ".join(text.split())


def derive_citations_map(case: GoldenCase) -> dict[str, Any]:
    """Derive a sentence-level ``{"claims": [...]}`` map for a curated golden case.

    Each sentence becomes one claim attributed to its SOAP section; each inline
    ``<Note ID:N>`` marker attaches ``source_documents[N-1]`` as an evidence quote
    (so ``context_relevance`` reflects which claims are actually cited). This is an
    eval-side proxy for the production NER-derived ``citationsMap`` (see module
    docstring) — the judge entailment that scores it is fully live.
    """
    sources = case.source_documents
    claims: list[dict[str, Any]] = []
    for code, seg_text in _section_segments(case.generated_note):
        for raw_sentence in _SENTENCE_SPLIT_RE.split(seg_text):
            sentence = raw_sentence.strip()
            if not sentence:
                continue
            note_ids = [int(n) for n in _NOTE_ID_RE.findall(sentence)]
            text = _clean_claim_text(sentence)
            if not text:
                continue
            evidence = [{"quote": sources[nid - 1]} for nid in note_ids if 1 <= nid <= len(sources)]
            claims.append(
                {
                    "id": f"{case.case_id}-claim-{len(claims) + 1}",
                    "text": text,
                    "section": code,
                    "status": "verified" if evidence else "unverified",
                    "evidence": evidence,
                }
            )
    return {"claims": claims}


def build_inferential_context(case: GoldenCase) -> SensorContext:
    """Build the per-case ``SensorContext`` the way ``run_inferential_sensors`` does.

    ``transcript_text`` is the joined source documents (the entailment premise),
    ``note_text`` is the generated note (what the safety screen reads), and
    ``citations_map`` is the eval-side-derived claim set.
    """
    return SensorContext(
        note_text=case.generated_note,
        transcript_text="\n\n".join(case.source_documents),
        citations_map=derive_citations_map(case),
    )


class InferentialCaseResult(BaseModel):
    """The live inferential scoring of one golden case."""

    model_config = ConfigDict(extra="forbid")

    case_id: str
    role: str
    n_claims: int
    elapsed_s: float

    # Groundedness (LM Studio judge entailment).
    groundedness: float | None = None
    groundedness_passed: bool | None = None
    groundedness_degraded: bool = False
    rag_triad_score: float | None = None
    context_relevance: float | None = None
    answer_relevance: float | None = None
    ungrounded: list[str] = Field(default_factory=list)
    sections: list[str] = Field(default_factory=list)

    # Safety (Granite Guardian over Ollama).
    safety_unsafe: bool | None = None
    safety_passed: bool | None = None
    safety_degraded: bool = False
    safety_score: float | None = None
    safety_flagged: list[str] = Field(default_factory=list)

    # Curated reference labels (for agreement, NOT real clinician labels).
    accurate_label: int | None = None
    citation_label: int | None = None


async def score_case(
    case: GoldenCase,
    *,
    judge: JudgeClient,
    granite: GraniteGuardianClient,
    threshold: float,
) -> InferentialCaseResult:
    """Run groundedness + safety over one case (concurrently, like the activity)."""
    ctx = build_inferential_context(case)
    n_claims = len(ctx.claims())
    groundedness = GroundednessSensor(threshold=threshold)
    safety = SafetySensor(granite)

    started = time.monotonic()
    g_res, s_res = await asyncio.gather(
        groundedness.arun(ctx, judge=judge),
        safety.arun(ctx, judge=judge),
    )
    elapsed = time.monotonic() - started

    g_details = g_res.details
    s_details = s_res.details
    label = case.clinician_pdsqi
    return InferentialCaseResult(
        case_id=case.case_id,
        role=case.role,
        n_claims=n_claims,
        elapsed_s=round(elapsed, 2),
        groundedness=None if g_res.degraded else round(g_res.score, 6),
        groundedness_passed=None if g_res.degraded else g_res.passed,
        groundedness_degraded=g_res.degraded,
        rag_triad_score=g_details.get("rag_triad_score"),
        context_relevance=(g_details.get("rag_triad") or {}).get("context_relevance"),
        answer_relevance=(g_details.get("rag_triad") or {}).get("answer_relevance"),
        ungrounded=list(g_details.get("ungrounded", [])),
        sections=list(g_details.get("sections", [])),
        safety_unsafe=None if s_res.degraded else bool(s_details.get("unsafe")),
        safety_passed=None if s_res.degraded else s_res.passed,
        safety_degraded=s_res.degraded,
        safety_score=None if s_res.degraded else round(s_res.score, 6),
        safety_flagged=list(s_details.get("flagged_dimensions", [])),
        accurate_label=label.accurate if label else None,
        citation_label=label.citation if label else None,
    )


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 6) if values else None


def aggregate(results: list[InferentialCaseResult]) -> dict[str, Any]:
    """Corpus-level aggregate: distributions, safety tally, label agreement."""
    g_scores = [r.groundedness for r in results if r.groundedness is not None]
    triad = [r.rag_triad_score for r in results if r.rag_triad_score is not None]
    ctx_rel = [r.context_relevance for r in results if r.context_relevance is not None]

    safe_scored = [r for r in results if not r.safety_degraded and r.safety_unsafe is not None]
    flagged = [r for r in safe_scored if r.safety_unsafe]

    # Agreement (calibration lane only): does live groundedness drop where the
    # curated `accurate` label is low, and context_relevance where `citation` is low?
    calib = [r for r in results if r.role == "calibration" and r.groundedness is not None]
    low_acc = [r.groundedness for r in calib if (r.accurate_label or 5) <= 2]
    high_acc = [r.groundedness for r in calib if (r.accurate_label or 0) >= 4]
    calib_ctx = [r for r in results if r.role == "calibration" and r.context_relevance is not None]
    low_cite = [r.context_relevance for r in calib_ctx if (r.citation_label or 5) <= 1]
    high_cite = [r.context_relevance for r in calib_ctx if (r.citation_label or 0) >= 3]

    return {
        "n_cases": len(results),
        "n_groundedness_scored": len(g_scores),
        "n_groundedness_degraded": sum(1 for r in results if r.groundedness_degraded),
        "groundedness_mean": _mean(g_scores),
        "groundedness_min": round(min(g_scores), 6) if g_scores else None,
        "groundedness_max": round(max(g_scores), 6) if g_scores else None,
        "groundedness_pass_count": sum(1 for r in results if r.groundedness_passed),
        "rag_triad_mean": _mean(triad),
        "context_relevance_mean": _mean(ctx_rel),
        "safety_n_scored": len(safe_scored),
        "safety_n_degraded": sum(1 for r in results if r.safety_degraded),
        "safety_pass_count": len(safe_scored) - len(flagged),
        "safety_flag_count": len(flagged),
        "safety_flagged_cases": [r.case_id for r in flagged],
        "agreement": {
            "calib_groundedness_low_accurate_mean": _mean(low_acc),
            "calib_groundedness_high_accurate_mean": _mean(high_acc),
            "calib_context_relevance_low_citation_mean": _mean(low_cite),
            "calib_context_relevance_high_citation_mean": _mean(high_cite),
        },
    }


async def run_eval(
    golden_set: GoldenSet, *, threshold: float, limit: int | None = None
) -> dict[str, Any]:
    """Score every case (sequentially) and return ``{aggregate, cases, judge_model}``."""
    judge = build_judge_client(get_runtime_judge_config())
    granite = GraniteGuardianClient(get_settings().safety)

    cases = golden_set.cases if limit is None else golden_set.cases[:limit]
    results: list[InferentialCaseResult] = []
    for case in cases:
        res = await score_case(case, judge=judge, granite=granite, threshold=threshold)
        results.append(res)
        flagged = ",".join(res.safety_flagged) or "-"
        g_str = "DEGRADED" if res.groundedness_degraded else f"{res.groundedness:.3f}"
        triad_str = "-" if res.rag_triad_score is None else f"{res.rag_triad_score:.3f}"
        print(
            f"  - {res.case_id} [{res.role}] claims={res.n_claims} "
            f"groundedness={g_str} ragTriad={triad_str} "
            f"safety_unsafe={res.safety_unsafe} flagged={flagged} ({res.elapsed_s}s)",
            flush=True,
        )

    return {
        "golden_set_version": golden_set.version,
        "judge_model": judge.model,
        "granite_model": granite.model,
        "groundedness_threshold": threshold,
        "aggregate": aggregate(results),
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
    parser.add_argument(
        "--limit", type=int, default=None, help="Score only the first N cases (smoke test)."
    )
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
        f"[inferential-corpus-eval] golden_set='{golden_set.version}' "
        f"cases={n} threshold={args.threshold}",
        flush=True,
    )
    report = asyncio.run(run_eval(golden_set, threshold=args.threshold, limit=args.limit))

    agg = report["aggregate"]
    print("\n[inferential-corpus-eval] corpus aggregate:")
    print(json.dumps(agg, indent=2))

    if args.output:
        Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\n[inferential-corpus-eval] wrote report -> {args.output}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    sys.exit(_run())
