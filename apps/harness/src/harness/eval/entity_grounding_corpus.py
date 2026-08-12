"""TASK-671 — the two-arm entity-grounding corpus.

TASK-664's corpus has only a **should-pass** arm: six clinically correct, lexically
divergent notes. Calibrating against it alone is trivially gameable — any change that
grounds everything scores 100%. So every case here carries a paired **should-flag** arm:
entities of the *same lexical shape* (absent from the transcript, plausibly clinical) that
are **not** entailed by it.

That pairing is the whole point. Under the incumbent lexical sensors both arms score
identically — neither appears verbatim in the transcript, so both are flagged. A mechanism
that "fixes" the penalty by grounding more things indiscriminately will therefore ground the
fabrications too, and the retention half of the gate (§3.3: **zero unsafe flips**) will catch
it. The corpus is built to make that failure visible, not to make a fix look good.

Directional note: the same case data serves **both** gate directions, because entity
grounding is symmetric in the premise (see
:mod:`harness.sensors.inferential.entity_grounding`):

* **faithfulness** — hypothesis = a *note* entity, premise = the transcript.
* **coverage** — hypothesis = a *transcript* entity, premise = the note.

Transcripts and the abstracted arm are carried over verbatim from
``tests/unit/sensors/test_adjudication_penalty_task664.py`` so the two measurements are
directly comparable. This module is data only — no imports from the test tree.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class GroundingCase:
    """One consultation with a paired should-recover / should-flag entity arm."""

    name: str
    abstraction: str
    transcript: str
    #: Entities the NER pass returns from the transcript.
    transcript_entities: tuple[str, ...]
    #: Clinically correct abstractions of the transcript's content. Lexically absent from
    #: the transcript, but **entailed** by it. The gate MUST recover these.
    abstracted_entities: tuple[str, ...]
    #: Fabrications of the same lexical shape — equally absent, equally plausible, but
    #: **not entailed**. The gate MUST keep flagging these. Zero tolerance.
    fabricated_entities: tuple[str, ...]
    #: Why each fabrication is genuinely unsupported, so the arm can be reviewed.
    fabrication_basis: str

    @property
    def note_text(self) -> str:
        """A minimal note carrying the abstracted entities (premise for coverage)."""
        return " ".join(f"{e}." for e in self.abstracted_entities)


CASES: tuple[GroundingCase, ...] = (
    GroundingCase(
        name="lay-to-clinical",
        abstraction="lay symptom description -> standard clinical term",
        transcript=(
            "Patient says he gets short of breath walking up the stairs and his "
            "ankles have been puffy for about a week."
        ),
        transcript_entities=("short of breath", "ankles have been puffy"),
        abstracted_entities=("exertional dyspnoea", "bilateral peripheral oedema"),
        fabricated_entities=("orthopnoea", "ascites"),
        fabrication_basis=(
            "Breathlessness is exertional, not on lying flat (orthopnoea); swelling is "
            "peripheral, and no abdominal distension is mentioned (ascites). Both are "
            "adjacent findings a plausible hallucination would reach for."
        ),
    ),
    GroundingCase(
        name="brand-to-generic",
        abstraction="brand name -> generic (INN) drug name",
        transcript=(
            "She has been taking Tylenol three times a day and a Ventolin puffer "
            "when she needs it."
        ),
        transcript_entities=("Tylenol", "Ventolin"),
        abstracted_entities=("paracetamol", "salbutamol"),
        fabricated_entities=("tramadol", "tiotropium"),
        fabrication_basis=(
            "The exact failure mode TASK-664 §1.2 names: a different analgesic and a "
            "different inhaled agent are lexically indistinguishable from the correct "
            "generic substitution. If a mechanism grounds paracetamol it must NOT ground "
            "tramadol."
        ),
    ),
    GroundingCase(
        name="findings-to-diagnosis",
        abstraction="raw findings -> named diagnosis (inference, not restatement)",
        transcript=(
            "His sugar reading this morning was 320 and he says he is thirsty all the "
            "time and getting up at night to pass urine."
        ),
        transcript_entities=("sugar reading", "thirsty all the time", "pass urine"),
        abstracted_entities=(
            "capillary blood glucose",
            "hyperglycaemia",
            "polydipsia",
            "nocturia",
        ),
        fabricated_entities=("diabetic ketoacidosis", "peripheral neuropathy"),
        fabrication_basis=(
            "DKA additionally requires ketones and acidosis, neither mentioned; no sensory "
            "symptoms are described at all. Both are one inferential step FURTHER than the "
            "transcript supports — the boundary the gate has to hold."
        ),
    ),
    GroundingCase(
        name="disagreement-adjudicated",
        abstraction="two competing diagnoses -> reconciled term neither specialist used",
        transcript=(
            "Cough for five days with green phlegm, temperature 38.4, some crackles at "
            "the right base on listening."
        ),
        transcript_entities=("cough", "green phlegm", "temperature 38.4", "crackles"),
        abstracted_entities=(
            "lower respiratory tract infection",
            "focal right basal signs",
            "pneumonia",
            "bronchitis",
        ),
        fabricated_entities=("pulmonary embolism", "pleural effusion"),
        fabrication_basis=(
            "Neither specialist proposed either, and nothing in the transcript supports "
            "them. This is the case that most needs reasoning, so it is also the case where "
            "an over-permissive entailer is most dangerous."
        ),
    ),
    GroundingCase(
        name="measurement-normalised",
        abstraction="spoken measurement -> normalised units",
        transcript=(
            "Blood pressure today was a hundred and forty over ninety, pulse eighty-eight."
        ),
        transcript_entities=("a hundred and forty over ninety", "eighty-eight"),
        abstracted_entities=("140/90 mmHg", "88 bpm"),
        fabricated_entities=("150/90 mmHg", "108 bpm"),
        fabrication_basis=(
            "A numeric change wearing an abstraction's clothes: structurally identical to "
            "the correct normalisation, differing only in the value. Any mechanism that "
            "grounds by shape rather than content fails here."
        ),
    ),
    GroundingCase(
        name="temporal-abstraction",
        abstraction="relative time reference -> duration",
        transcript=(
            "The chest pain started last Tuesday and he had a similar episode back in March."
        ),
        transcript_entities=("chest pain", "last Tuesday", "March"),
        # NOTE: TASK-664's arm also carried "chest pain", which the note legitimately
        # retains verbatim. It is dropped here because it is not an abstraction — the
        # lexical sensor grounds it unaided, so including it would give the should-recover
        # arm partial lexical credit and let the incumbent separate the two arms without
        # any inference. The P1 control test asserts exactly that this cannot happen.
        abstracted_entities=("six-day history", "recurrent"),
        fabricated_entities=("three-week history", "crushing central chest pain"),
        fabrication_basis=(
            "The duration contradicts the transcript, and the pain's character is never "
            "described — an invented qualifier attached to a real entity, which is how "
            "clinically dangerous embellishment actually looks."
        ),
    ),
)


def total_abstracted() -> int:
    """Entities the gate must recover (the should-pass arm)."""
    return sum(len(c.abstracted_entities) for c in CASES)


def total_fabricated() -> int:
    """Entities the gate must keep flagging (the should-flag arm)."""
    return sum(len(c.fabricated_entities) for c in CASES)
