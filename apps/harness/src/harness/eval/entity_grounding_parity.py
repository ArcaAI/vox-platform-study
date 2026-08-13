"""Two-arm calibration for the entity-grounding escalation.

Scores the :class:`~harness.sensors.inferential.entity_grounding.EntityGroundingSensor`
over :mod:`harness.eval.entity_grounding_corpus` with a real entailment backend, and
reports the **joint** criterion. Both halves are required, because
either alone is trivially gameable:

* **recovery** — of the abstraction arm (16 entities the incumbent flags), how many does the
  escalation recover to grounded? A mechanism that recovers nothing has not fixed anything.
* **retention** — of the fabrication arm (12 entities), how many stay flagged? This inherits
  the ``inferential_judge_parity`` R-8 bar verbatim: **an unsafe flip is a stop, not a tuning
  input**. Recovery bought by grounding fabrications is not a result.

The incumbent flags 100% of both arms (proved by the P1 control test), so the incumbent's
scores are constants here rather than a second live run: recovery starts at 0/16 and
retention starts at 12/12. Everything measured is attributable to entailment.

Every unsafe flip is printed in full for clinician adjudication **before** any threshold
moves — a disagreement is evidence to read, not a number to optimize against.

Run it (the configured judge must be reachable — LM Studio by default)::

    conda run -n arcaenv python -m harness.eval.entity_grounding_parity \\
      --output entity-grounding-parity.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from harness.core.config import get_runtime_judge_config
from harness.eval.entity_grounding_corpus import CASES, GroundingCase
from harness.eval.jsonio import loads_json
from harness.eval.judge.base import JudgeClient
from harness.eval.judge.providers import build_judge_client
from harness.sensors.base import NEREntity, SensorContext
from harness.sensors.inferential.entity_grounding import Direction, EntityGroundingSensor

_SYSTEM_PROMPT = (
    "You are a meticulous clinical fact-checking judge. Decide whether the HYPOTHESIS is "
    "supported by the PREMISE. The hypothesis is supported only if the premise states it or "
    "directly entails it — a different clinical term for the SAME thing the premise "
    "describes counts as supported (a brand name and its generic, a lay description and its "
    "clinical term, a normalised measurement and its spoken form). A DIFFERENT clinical "
    "entity, a further diagnosis the premise does not establish, or a changed value is NOT "
    'supported. Respond ONLY with a JSON object: {"supported": true} or {"supported": false}.'
)


class JudgeEntailer:
    """Adapts a :class:`JudgeClient` to the ``NliEntailer`` interface.

    The ``NliEntailer`` protocol asks for a *deterministic* backend (MiniCheck/AlignScore
    class). An LLM judge at temperature 0 is only approximately that, so this adapter is
    **eval-only** — it exists to calibrate the escalation against the backend that is
    actually reachable today. It is deliberately NOT wired into the durable loop; the
    production entailer stays the deterministic self-hosted NLI.
    """

    def __init__(self, judge: JudgeClient) -> None:
        self._judge = judge
        self.calls = 0

    async def entail(self, premise: str, hypothesis: str) -> bool:
        self.calls += 1
        raw = await self._judge.complete(
            [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": f"PREMISE:\n{premise}\n\nHYPOTHESIS:\n{hypothesis}"},
            ],
            json_mode=True,
            temperature=0.0,
        )
        try:
            obj = loads_json(raw)
        except ValueError:
            return False  # unparseable -> conservative: not entailed
        if not isinstance(obj, dict):
            return False
        value = obj.get("supported", obj.get("entailed", obj.get("grounded")))
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"true", "yes", "supported", "entailed", "grounded"}
        return False


def _ents(texts: tuple[str, ...]) -> list[NEREntity]:
    return [NEREntity(text=t, type="CLINICAL") for t in texts]


def _context(case: GroundingCase, note_entities: tuple[str, ...]) -> SensorContext:
    """A context whose NOTE carries ``note_entities`` and whose transcript is the case's."""
    return SensorContext(
        note_text=" ".join(f"{e}." for e in note_entities),
        transcript_text=case.transcript,
        note_entities=_ents(note_entities),
        transcript_entities=_ents(case.transcript_entities),
    )


class BackendUnavailable(RuntimeError):
    """The entailment backend could not be reached, so no verdict is measurable.

    Raised loudly rather than reported as a score. The sensor's own fallback is to the
    LEXICAL verdict, which is correct for production but catastrophic for a calibration
    run: a dead backend produces *exactly* the numbers a perfectly safe, perfectly useless
    mechanism would (retention 100%, recovery 0%). An instrument that cannot tell those two
    apart is not an instrument.
    """


async def _grounded_set(
    case: GroundingCase, entities: tuple[str, ...], *, entailer: JudgeEntailer
) -> set[str]:
    """Which of ``entities`` the escalation grounds, in the faithfulness direction."""
    sensor = EntityGroundingSensor(entailer, direction=Direction.FAITHFULNESS, threshold=1.0)
    result = await sensor.arun(_context(case, entities))
    if result.details.get("escalation_unavailable"):
        raise BackendUnavailable(
            f"{case.name}: the sensor fell back to lexical — the entailment backend is "
            "unreachable. Fix the backend; do not read the scores from this run."
        )
    return set(result.details.get("recovered_by_entailment", []))


async def preflight(entailer: JudgeEntailer) -> None:
    """Prove the backend answers at all before spending a corpus on it.

    Sends one pair whose verdict we do not assert (a judge is allowed its own opinion) —
    the check is only that a call completes and parses.
    """
    try:
        await entailer.entail(
            "The patient has a cough.", "The consultation record includes cough."
        )
    except Exception as exc:  # noqa: BLE001 — surfaced as a hard stop, not a score
        raise BackendUnavailable(f"entailment backend preflight failed: {exc}") from exc


async def score_case(case: GroundingCase, *, entailer: JudgeEntailer) -> dict[str, Any]:
    """Run both arms of one case and return the per-entity verdicts."""
    recovered = await _grounded_set(case, case.abstracted_entities, entailer=entailer)
    leaked = await _grounded_set(case, case.fabricated_entities, entailer=entailer)
    return {
        "case_id": case.name,
        "abstraction": case.abstraction,
        "n_abstracted": len(case.abstracted_entities),
        "n_recovered": len(recovered),
        "recovered": sorted(recovered),
        "missed": sorted(set(case.abstracted_entities) - recovered),
        "n_fabricated": len(case.fabricated_entities),
        "n_retained": len(case.fabricated_entities) - len(leaked),
        "unsafe_flips": sorted(leaked),
        "fabrication_basis": case.fabrication_basis,
    }


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Corpus aggregate + the joint go/no-go gate."""
    abstracted = sum(r["n_abstracted"] for r in results)
    recovered = sum(r["n_recovered"] for r in results)
    fabricated = sum(r["n_fabricated"] for r in results)
    retained = sum(r["n_retained"] for r in results)
    unsafe = [f"{r['case_id']}::{e}" for r in results for e in r["unsafe_flips"]]
    return {
        "n_cases": len(results),
        "abstracted_total": abstracted,
        "recovered_total": recovered,
        "recovery_rate": round(recovered / abstracted, 4) if abstracted else None,
        "fabricated_total": fabricated,
        "retained_total": retained,
        "retention_rate": round(retained / fabricated, 4) if fabricated else None,
        "unsafe_flips": unsafe,
        # Joint criterion: retention is absolute (zero unsafe flips); recovery must be
        # non-trivial or the escalation has not earned its cost.
        "retention_passed": not unsafe,
        "recovery_passed": recovered > 0,
        "passed": (not unsafe) and recovered > 0,
        # Incumbent constants, proved by the P1 control test.
        "incumbent_recovery_rate": 0.0,
        "incumbent_retention_rate": 1.0,
    }


async def run_parity() -> dict[str, Any]:
    judge = build_judge_client(get_runtime_judge_config())
    entailer = JudgeEntailer(judge)
    await preflight(entailer)
    results: list[dict[str, Any]] = []
    for case in CASES:
        res = await score_case(case, entailer=entailer)
        results.append(res)
        print(
            f"  - {res['case_id']:<28} recovered {res['n_recovered']}/{res['n_abstracted']}"
            f"   retained {res['n_retained']}/{res['n_fabricated']}"
            + ("   UNSAFE!" if res["unsafe_flips"] else ""),
            flush=True,
        )
    return {
        "judge_model": judge.model,
        "entailment_calls": entailer.calls,
        "aggregate": summarize(results),
        "cases": results,
    }


def _run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="", help="Optional path to write the JSON report.")
    args = parser.parse_args(argv)

    print(f"[entity-grounding-parity] cases={len(CASES)}", flush=True)
    try:
        report = asyncio.run(run_parity())
    except BackendUnavailable as exc:
        print(f"\n[entity-grounding-parity] ABORTED — {exc}")
        print("  No scores are reported. A dead backend and a useless mechanism produce")
        print("  identical numbers here, so reporting either would be a false result.")
        return 2
    agg = report["aggregate"]

    print("\n[entity-grounding-parity] aggregate:")
    print(json.dumps({k: v for k, v in agg.items() if k != "unsafe_flips"}, indent=2))

    print(
        f"\n  RECOVERY  : {agg['recovered_total']}/{agg['abstracted_total']} "
        f"({(agg['recovery_rate'] or 0) * 100:.1f}%)   incumbent: 0.0%"
    )
    print(
        f"  RETENTION : {agg['retained_total']}/{agg['fabricated_total']} "
        f"({(agg['retention_rate'] or 0) * 100:.1f}%)   incumbent: 100.0%"
    )
    if agg["unsafe_flips"]:
        print("\n  UNSAFE FLIPS — fabrications the escalation grounded. Adjudicate each")
        print("  before any threshold moves; these are the reason the gate is joint.")
        for flip in agg["unsafe_flips"]:
            print(f"    {flip}")
    verdict = "PASS ✅" if agg["passed"] else "FAIL ❌"
    print(f"\n[entity-grounding-parity] joint gate: {verdict}")

    if args.output:
        Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"[entity-grounding-parity] wrote report -> {args.output}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    sys.exit(_run())
