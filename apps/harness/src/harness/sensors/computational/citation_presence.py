"""Citation-presence sensor — every claim must carry >= 1 evidence span.

Provenance gate over ``SummaryMeta.citationsMap``: each claim
(``{id, text, section, status, evidence:[...]}``) must reference at least one
transcript evidence span. Claims with no evidence are flagged (unverifiable). Per
the degradation policy, a generated note with no citations map at all is degraded
(cannot verify -> never auto-PASS); missing provenance is never silently asserted.
"""

from __future__ import annotations

from typing import Any

from harness.sensors.base import SensorContext, SensorResult

NAME = "citation_presence"


def _has_evidence(claim: dict[str, Any]) -> bool:
    evidence = claim.get("evidence")
    if not isinstance(evidence, list):
        return False
    return any(bool(ev) for ev in evidence)


def _claim_ref(claim: dict[str, Any]) -> str:
    return str(claim.get("id") or claim.get("text") or "<unknown-claim>")


class CitationPresenceSensor:
    """Score = evidenced claims / total claims."""

    name = NAME

    def __init__(self, threshold: float = 1.0) -> None:
        self.threshold = threshold

    def run(self, ctx: SensorContext) -> SensorResult:
        claims = ctx.claims()
        if not claims:
            note_exists = bool(ctx.note_text.strip() or ctx.soap_sections)
            if note_exists:
                return SensorResult(
                    name=NAME,
                    score=0.0,
                    passed=False,
                    details={
                        "degraded": True,
                        "reason": "generated note has no citations map",
                        "total": 0,
                        "unevidenced": [],
                    },
                )
            return SensorResult(
                name=NAME,
                score=1.0,
                passed=True,
                details={"total": 0, "evidenced": 0, "unevidenced": []},
            )

        evidenced: list[str] = []
        unevidenced: list[str] = []
        for claim in claims:
            (evidenced if _has_evidence(claim) else unevidenced).append(_claim_ref(claim))

        total = len(claims)
        score = len(evidenced) / total
        return SensorResult(
            name=NAME,
            score=score,
            passed=score >= self.threshold,
            claims_flagged=unevidenced,
            details={"total": total, "evidenced": len(evidenced), "unevidenced": unevidenced},
        )
