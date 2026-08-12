"""TASK-671 P0 — ontology-code population and the code-identity bridge rate.

Records the measurement that **refuted** this ticket's most promising hypothesis, and keeps
it reproducible. `NEREntity` carries `umls_cui` / `snomed_code` / `rxnorm_code` /
`icd_code` / `loinc_code`, populated by the NLP service's deterministic `OntologyLinker` and
already consumed elsewhere in the harness — yet both lexical entity sensors compare only
normalized surface text. Code identity looked like a way to ground `paracetamol` against a
transcript saying `Tylenol` **without loosening the string match by one character**, which is
the constraint TASK-664 §1.4 imposed.

It measured 14.3% code population and a **0% bridge rate on genuine abstraction** — the one
"bridge" is an entity that was already lexically identical. `Tylenol`, `paracetamol` and
`acetaminophen` are all absent from the 67-alias curated vocabulary, so the flagship case has
no codes on either side. P2 was deferred on this evidence (ticket §2.6).

Kept in the tree because a number recorded in a README whose script lives in ``/tmp`` is not
a reproducible measurement, and because re-running this is the check that tells you when the
conclusion has expired: if the vocabulary is ever replaced with a real self-hosted
UMLS/MedCAT install, the bridge rate is the number that decides whether P2 comes back.

Cross-service note: this imports ``nlp`` directly, which the harness runtime never does — in
production the codes arrive over the wire on the NER contract. That is why this lives in
``eval/`` (an offline instrument) rather than anywhere the durable loop can reach.

Run::

    PYTHONPATH="apps/harness/src:apps/nlp/src" \\
      conda run -n arcaenv python -m harness.eval.entity_code_population
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from harness.eval.entity_grounding_corpus import CASES


@dataclass(frozen=True)
class CodePopulation:
    """The P0 measurement. ``non_trivial_bridges == 0`` is the finding that deferred P2."""

    vocabulary_aliases: int
    coded: int
    total: int
    bridged: int
    checked: int
    trivial_bridges: int
    residue: list[str] = field(default_factory=list)

    @property
    def population_pct(self) -> float:
        return round(self.coded / self.total * 100, 1) if self.total else 0.0

    @property
    def bridge_pct(self) -> float:
        return round(self.bridged / self.checked * 100, 1) if self.checked else 0.0

    @property
    def non_trivial_bridges(self) -> int:
        """Bridges on entities the lexical floor did NOT already ground — the decisive number.

        A bridge on an already-lexical match proves nothing; counting it would inflate the
        headline rate with entities the incumbent handles unaided.
        """
        return self.bridged - self.trivial_bridges


def _codeset(linker: Any, text: str) -> set[str]:
    """The populated ``field:value`` codes for one surface form."""
    codes = linker.link(text)
    return {
        f"{field}:{value}"
        for field, value in (
            ("umls", codes.umls_cui),
            ("snomed", codes.snomed_code),
            ("rxnorm", codes.rxnorm_code),
            ("icd", codes.icd_code),
            ("loinc", codes.loinc_code),
        )
        if value
    }


def measure() -> CodePopulation:
    """Population + bridge rates over the corpus. Deterministic — an exact result."""
    # Local import: eval-only cross-service dependency, never reachable from the durable loop.
    from nlp.services.ontology_linker import OntologyLinker  # type: ignore[import-untyped]

    linker = OntologyLinker()

    coded = total = 0
    bridged = checked = 0
    trivial = 0
    residue: list[str] = []

    for case in CASES:
        transcript = {t: _codeset(linker, t) for t in case.transcript_entities}
        abstracted = {t: _codeset(linker, t) for t in case.abstracted_entities}
        for group in (transcript, abstracted):
            for codes in group.values():
                total += 1
                coded += 1 if codes else 0

        transcript_union: set[str] = set()
        for codes in transcript.values():
            transcript_union |= codes

        for text, codes in abstracted.items():
            checked += 1
            if codes & transcript_union:
                bridged += 1
                # A "bridge" on an entity the lexical floor already grounds proves nothing —
                # counted separately so the headline rate is not inflated by it.
                if text in case.transcript_entities:
                    trivial += 1
            else:
                residue.append(f"{case.name}: {text}")

    return CodePopulation(
        vocabulary_aliases=len(linker._vocabulary),  # noqa: SLF001 — reporting the subset size
        coded=coded,
        total=total,
        bridged=bridged,
        checked=checked,
        trivial_bridges=trivial,
        residue=residue,
    )


def _run() -> int:
    result = measure()
    print("=" * 88)
    print("TASK-671 P0 — ontology-code population + code-identity bridge rate")
    print("=" * 88)
    print(f"  vocabulary                 : {result.vocabulary_aliases} normalized aliases")
    print(
        f"  code population            : {result.coded}/{result.total} "
        f"({result.population_pct}%)"
    )
    print(
        f"  bridge rate                : {result.bridged}/{result.checked} "
        f"({result.bridge_pct}%)"
    )
    print(f"    of which trivial         : {result.trivial_bridges} (already lexical matches)")
    print(f"    genuine abstraction      : {result.non_trivial_bridges}")
    print(f"  residue (needs inference)  : {len(result.residue)}")
    for entry in result.residue:
        print(f"     {entry}")
    print()
    print("  A non_trivial_bridges of 0 is why P2 was deferred (ticket §2.6). If the linker")
    print("  vocabulary is ever widened, re-run this before reconsidering.")
    print("=" * 88)
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    sys.exit(_run())
