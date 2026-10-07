"""TASK-1050 P-F1 — the cloud-egress Pseudonymizer must round-trip exactly.

Finding P-F1 (TASK-1049 Track P, pinned by `apps/nlp/tests/test_task1049_p_metrics.py`):

(a) case/whitespace variants of ONE value share one token (co-reference, TASK-1035),
    and restoring the masked text gave every occurrence the FIRST spelling seen;
(b) a source text that already contains a token-shaped string (``[PERSON_1]``) was
    indistinguishable from a minted token, so restore rewrote the literal.

The fix keeps one token per entity, restores a masked text the Pseudonymizer produced
by POSITION (each occurrence gets its own original surface), and never mints a token
that already occurs in the request's source text.
"""

from __future__ import annotations

from text.models.requests import GenerateRequest, KnownPhi
from text.services.egress import prepare_egress, prepare_text_egress
from text.services.pseudonymizer import TOKEN_PATTERN, Pseudonymizer, Span


def _spans(text: str, *values: str, label: str = "PERSON") -> list[Span]:
    spans: list[Span] = []
    cursor = 0
    for value in values:
        start = text.index(value, cursor)
        spans.append(Span(label, start, start + len(value)))
        cursor = start + len(value)
    return spans


# ── (a) case variants ────────────────────────────────────────────────────────


def test_case_variants_share_one_token_and_round_trip_exactly() -> None:
    text = "ANIL KUMAR came. later anil kumar left."
    p = Pseudonymizer([])

    masked = p.pseudonymize(text, _spans(text, "ANIL KUMAR", "anil kumar"))

    assert masked == "[PERSON_1] came. later [PERSON_1] left."  # co-reference kept
    restored, count = p.restore(masked)
    assert restored == text
    assert count == 2


def test_whitespace_variants_round_trip_exactly() -> None:
    p = Pseudonymizer([("patient_name", "John Doe")])
    text = "john  doe came in. JOHN DOE has a cough."

    masked = p.pseudonymize(text, [])

    assert masked == "[PATIENT_NAME_1] came in. [PATIENT_NAME_1] has a cough."
    assert p.restore(masked)[0] == text


def test_variants_across_several_texts_of_one_request_each_round_trip() -> None:
    p = Pseudonymizer([])
    first = "Anil Kumar arrived."
    second = "Later ANIL KUMAR and anil kumar were both written."

    masked_first = p.pseudonymize(first, _spans(first, "Anil Kumar"))
    masked_second = p.pseudonymize(second, _spans(second, "ANIL KUMAR", "anil kumar"))

    assert p.restore(masked_first)[0] == first
    assert p.restore(masked_second)[0] == second


def test_model_output_restores_each_token_to_the_first_spelling_seen() -> None:
    p = Pseudonymizer([])
    text = "Anil Kumar came. later ANIL KUMAR left."
    p.pseudonymize(text, _spans(text, "Anil Kumar", "ANIL KUMAR"))

    # Text the model wrote is not a masked source: a token restores to one value.
    assert p.restore("Summary: [PERSON_1] is stable.") == ("Summary: Anil Kumar is stable.", 1)


# ── (b) token-shaped source text ─────────────────────────────────────────────


def test_a_token_shaped_literal_in_the_source_is_never_minted_and_round_trips() -> None:
    text = "Ref [PERSON_1] is Anil."
    p = Pseudonymizer([])

    masked = p.pseudonymize(text, _spans(text, "Anil"))

    assert masked == "Ref [PERSON_1] is [PERSON_2]."  # the literal is left, a fresh token minted
    assert p.restore(masked)[0] == text


def test_model_output_never_turns_a_source_literal_into_a_value() -> None:
    text = "Ref [PERSON_1] is Anil."
    p = Pseudonymizer([])
    p.pseudonymize(text, _spans(text, "Anil"))

    restored, count = p.restore("[PERSON_1] belongs to [PERSON_2].")

    assert restored == "[PERSON_1] belongs to Anil."
    assert count == 1


def test_sources_given_up_front_are_reserved_for_every_later_text() -> None:
    later = "Dr Smith saw the patient."
    p = Pseudonymizer([], sources=["Template mentions [PERSON_1] literally.", later])

    masked = p.pseudonymize(later, _spans(later, "Dr Smith"))

    assert masked == "[PERSON_2] saw the patient."
    assert p.restore("[PERSON_1]") == ("[PERSON_1]", 0)


def test_a_variant_index_token_is_never_minted_over_a_literal_either() -> None:
    # A reserved literal of every shape the minted grammar can produce is skipped.
    text = "codes [MRN_1] [MRN_2] then MRN-77 and MRN-88"
    p = Pseudonymizer([])

    masked = p.pseudonymize(text, _spans(text, "MRN-77", "MRN-88", label="mrn"))

    minted = {m.group(0) for m in TOKEN_PATTERN.finditer(masked)} - {"[MRN_1]", "[MRN_2]"}
    assert minted == {"[MRN_3]", "[MRN_4]"}
    assert p.restore(masked)[0] == text


# ── the egress call sites reserve every segment ──────────────────────────────


def test_prepare_egress_reserves_literals_from_every_segment_before_minting() -> None:
    request = GenerateRequest(
        prompt="John Doe reports a cough.",
        system_prompt="Write the note. Example placeholder: [PATIENT_NAME_1].",
        provider="openai",
        model="gpt-x",
        known_phi=[KnownPhi(label="patient_name", value="John Doe")],
    )

    egress = prepare_egress(request, spans_by_segment=None)

    assert egress.provider_request.prompt == "[PATIENT_NAME_2] reports a cough."
    assert "[PATIENT_NAME_1]" in egress.provider_request.system_prompt
    assert egress.restore("[PATIENT_NAME_1] / [PATIENT_NAME_2]") == "[PATIENT_NAME_1] / John Doe"


def test_prepare_text_egress_reserves_literals_from_every_text() -> None:
    context, outgoing = prepare_text_egress(
        ["Anil Kumar is here.", "see [PATIENT_NAME_1]"],
        provider="openai",
        provider_locality=None,
        known_phi=[KnownPhi(label="patient_name", value="Anil Kumar")],
        spans_by_segment=None,
    )

    assert outgoing == ["[PATIENT_NAME_2] is here.", "see [PATIENT_NAME_1]"]
    assert [context.restore(t) for t in outgoing] == ["Anil Kumar is here.", "see [PATIENT_NAME_1]"]
