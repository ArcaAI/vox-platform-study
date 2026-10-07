"""TASK-1049 Track P (P-2/P-3) — the PII scorer harness, driven by FAKE detectors only.

No model is loaded here. These pin the arithmetic of the deciding metrics: span matching
(strict vs relaxed, generic labels), residual PHI after the real `Pseudonymizer`, clinical
over-mask, restore round trip, surrogate consistency, and the production window geometry.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from pii_eval.detectors import (  # noqa: E402
    Detector,
    FakeDetector,
    Gliner2Detector,
    ModelLoadNotApproved,
    RegexDetector,
)
from pii_eval.generate import builtin_skeleton, generate_dataset  # noqa: E402
from pii_eval.masking import mask_consultation  # noqa: E402
from pii_eval.metrics import (  # noqa: E402
    overmask_stats,
    prf_table,
    residual_stats,
    restore_stats,
    surrogate_stats,
)
from pii_eval.runner import detect_document, evaluate, evaluate_detections  # noqa: E402
from pii_eval.spans import Detection, dedupe_longest, match_spans  # noqa: E402


def g(label, start, end, entity="e"):
    return {
        "label": label,
        "start": start,
        "end": end,
        "text": "x" * (end - start),
        "entity": entity,
    }


# ------------------------------------------------------------------ span alignment
def test_strict_needs_exact_boundaries_relaxed_needs_overlap():
    gold = [g("PHONE", 10, 20)]
    pred = [Detection("PHONE", 10, 18)]
    assert len(match_spans(gold, pred, "strict").tp) == 0
    relaxed = match_spans(gold, pred, "relaxed")
    assert len(relaxed.tp) == 1 and relaxed.fn == [] and relaxed.fp == []


def test_generic_person_matches_patient_relative_and_clinician_only():
    for label in ("PATIENT_NAME", "RELATIVE_NAME", "CLINICIAN"):
        assert len(match_spans([g(label, 0, 5)], [Detection("PERSON", 0, 5)], "strict").tp) == 1
    assert len(match_spans([g("PHONE", 0, 5)], [Detection("PERSON", 0, 5)], "strict").tp) == 0


def test_one_to_one_matching_the_second_prediction_is_a_false_positive():
    gold = [g("EMAIL", 0, 10)]
    pred = [Detection("EMAIL", 0, 10), Detection("EMAIL", 2, 8)]
    m = match_spans(gold, pred, "relaxed")
    assert len(m.tp) == 1 and len(m.fp) == 1


def test_label_must_be_compatible_even_when_overlapping():
    m = match_spans([g("MRN", 0, 8)], [Detection("EMAIL", 0, 8)], "relaxed")
    assert m.tp == [] and len(m.fn) == 1 and len(m.fp) == 1


def test_dedupe_longest_keeps_the_longest_and_matches_guardrail_semantics():
    spans = [Detection("PERSON", 0, 4), Detection("PERSON", 0, 9), Detection("PERSON", 20, 25)]
    kept = dedupe_longest(spans)
    assert [(s.start, s.end) for s in kept] == [(0, 9), (20, 25)]


def test_prf_table_precision_is_none_when_label_never_predicted():
    gold_docs = [[g("MRN", 0, 5)]]
    pred_docs = [[]]
    table = prf_table(gold_docs, pred_docs, "relaxed")
    row = table["labels"]["MRN"]
    assert row["recall"] == 0.0 and row["precision"] is None and row["f1"] is None
    assert table["micro"]["recall"] == 0.0


def test_prf_table_perfect_detector():
    gold_docs = [[g("MRN", 0, 5), g("EMAIL", 10, 20)]]
    pred_docs = [[Detection("MRN", 0, 5), Detection("EMAIL", 10, 20)]]
    table = prf_table(gold_docs, pred_docs, "strict")
    assert table["micro"] == {"precision": 1.0, "recall": 1.0, "f1": 1.0, "tp": 2, "fp": 0, "fn": 0}
    assert table["labels"]["MRN"]["f1"] == 1.0


def test_other_label_is_excluded_from_precision():
    table = prf_table([[]], [[Detection("OTHER", 0, 4)]], "relaxed")
    assert table["micro"]["fp"] == 0


# --------------------------------------------------------------- masking and residual
TEXT = "Patient Anil Kumar phoned 98470 12345 about Parkinson disease."


def _gold():
    return [
        {"label": "PATIENT_NAME", "start": 8, "end": 18, "text": "Anil Kumar", "entity": "p"},
        {"label": "PHONE", "start": 26, "end": 37, "text": "98470 12345", "entity": "ph"},
    ]


def _negs():
    return [{"kind": "eponym_disease", "start": 44, "end": 53, "text": "Parkinson"}]


def test_fixture_offsets_are_right():
    assert TEXT[8:18] == "Anil Kumar"
    assert TEXT[26:37] == "98470 12345"
    assert TEXT[44:53] == "Parkinson"


def test_masking_replaces_detected_spans_and_reports_intervals():
    res = mask_consultation([TEXT], [[Detection("PERSON", 8, 18), Detection("PHONE", 26, 37)]])
    assert res.masked[0] == "Patient [PERSON_1] phoned [PHONE_1] about Parkinson disease."
    assert res.intervals[0] == [(8, 18, "PERSON"), (26, 37, "PHONE")]


def test_masking_intervals_reconstruct_the_masked_text():
    # guards the use of the Pseudonymizer's private `_intervals`
    res = mask_consultation([TEXT], [[Detection("PERSON", 8, 18), Detection("PHONE", 20, 37)]])
    rebuilt, cursor = [], 0
    for start, end, label in res.intervals[0]:
        rebuilt.append(TEXT[cursor:start])
        rebuilt.append(res.token_for(label, TEXT[start:end]))
        cursor = end
    rebuilt.append(TEXT[cursor:])
    assert "".join(rebuilt) == res.masked[0]


def test_residual_is_zero_when_everything_is_covered():
    res = mask_consultation([TEXT], [[Detection("PERSON", 8, 18), Detection("PHONE", 26, 37)]])
    stats = residual_stats([TEXT], [_gold()], res.intervals, res.masked)
    assert stats["overall"]["spans"] == 2
    assert stats["overall"]["leaked_any"] == 0
    assert stats["overall"]["rate_any"] == 0.0
    assert stats["verbatim_survivors"] == 0


def test_residual_counts_a_missed_span_and_a_partial_cover():
    # name fully missed, phone only partly covered (last 4 chars survive)
    res = mask_consultation([TEXT], [[Detection("PHONE", 26, 33)]])
    stats = residual_stats([TEXT], [_gold()], res.intervals, res.masked)
    o = stats["overall"]
    assert o["spans"] == 2 and o["leaked_any"] == 2 and o["leaked_substantive"] == 2
    assert stats["by_label"]["PATIENT_NAME"]["leaked_any"] == 1
    assert stats["verbatim_survivors"] >= 1  # "Anil Kumar" is still in the masked text


def test_residual_substantive_ignores_a_single_stray_char():
    # detector span ends one char short of the phone: any-leak yes, substantive no
    res = mask_consultation([TEXT], [[Detection("PERSON", 8, 18), Detection("PHONE", 26, 36)]])
    stats = residual_stats([TEXT], [_gold()], res.intervals, res.masked)
    assert stats["overall"]["leaked_any"] == 1
    assert stats["overall"]["leaked_substantive"] == 0


def test_residual_splits_direct_identifiers_from_quasi_identifiers():
    text = "Anil on 12 March 2024"
    gold = [
        {"label": "PATIENT_NAME", "start": 0, "end": 4, "text": "Anil", "entity": "a"},
        {"label": "DATE", "start": 8, "end": 21, "text": "12 March 2024", "entity": "d"},
    ]
    res = mask_consultation([text], [[Detection("DATE", 8, 21)]])
    stats = residual_stats([text], [gold], res.intervals, res.masked)
    assert stats["direct"]["spans"] == 1 and stats["direct"]["leaked_any"] == 1
    assert stats["quasi"]["spans"] == 1 and stats["quasi"]["leaked_any"] == 0


def test_clinician_is_not_counted_as_phi_in_residual():
    gold = [{"label": "CLINICIAN", "start": 0, "end": 4, "text": "Priya", "entity": "c"}]
    res = mask_consultation(["Priya said"], [[]])
    stats = residual_stats(["Priya said"], [gold], res.intervals, res.masked)
    assert stats["overall"]["spans"] == 0


def test_overmask_counts_hard_negatives_touched_by_a_mask_by_kind():
    res = mask_consultation([TEXT], [[Detection("PERSON", 44, 53)]])
    stats = overmask_stats([TEXT], [_negs()], res.intervals)
    assert stats["overall"] == {"negatives": 1, "overmasked": 1, "rate": 1.0}
    assert stats["by_kind"]["eponym_disease"]["overmasked"] == 1
    clean = mask_consultation([TEXT], [[]])
    assert overmask_stats([TEXT], [_negs()], clean.intervals)["overall"]["overmasked"] == 0


# ---------------------------------------------------------------- round trip, consistency
def test_restore_round_trip_is_exact_for_clean_text():
    res = mask_consultation([TEXT], [[Detection("PERSON", 8, 18), Detection("PHONE", 26, 37)]])
    stats = restore_stats([TEXT], res)
    assert stats == {"documents": 1, "exact": 1, "rate": 1.0}


def test_restore_round_trip_breaks_on_case_variants_of_one_value():
    # the Pseudonymizer keys on casefolded values and restores the FIRST spelling seen
    text = "ANIL KUMAR came. later anil kumar left."
    second = text.index("anil kumar")
    res = mask_consultation(
        [text], [[Detection("PERSON", 0, 10), Detection("PERSON", second, second + 10)]]
    )
    assert restore_stats([text], res)["exact"] == 0


def test_restore_round_trip_breaks_when_text_already_contains_a_token_shape():
    text = "Ref [PERSON_1] is Anil."
    res = mask_consultation([text], [[Detection("PERSON", 18, 22)]])
    # "[PERSON_1]" in the source is indistinguishable from a minted token
    assert restore_stats([text], res)["exact"] == 0


def test_surrogate_consistency_alias_of_one_entity_gets_two_tokens():
    texts = ["Anil Kumar arrived.", "Kumar was seen."]
    golds = [
        [{"label": "PATIENT_NAME", "start": 0, "end": 10, "text": "Anil Kumar", "entity": "p"}],
        [{"label": "PATIENT_NAME", "start": 0, "end": 5, "text": "Kumar", "entity": "p"}],
    ]
    res = mask_consultation(texts, [[Detection("PERSON", 0, 10)], [Detection("PERSON", 0, 5)]])
    stats = surrogate_stats(texts, golds, res)
    assert stats["entities"] == 1 and stats["inconsistent"] == 1 and stats["consistent_rate"] == 0.0


def test_surrogate_consistency_same_value_same_token_and_collision_detected():
    texts = ["Anil met Anil.", "Kumar."]
    golds = [
        [
            {"label": "PATIENT_NAME", "start": 0, "end": 4, "text": "Anil", "entity": "p"},
            {"label": "RELATIVE_NAME", "start": 9, "end": 13, "text": "Anil", "entity": "r"},
        ],
        [],
    ]
    res = mask_consultation(texts, [[Detection("PERSON", 0, 4), Detection("PERSON", 9, 13)], []])
    stats = surrogate_stats(texts, golds, res)
    assert stats["inconsistent"] == 0
    assert stats["collisions"] == 1  # two different people share one token


# --------------------------------------------------------------- windows and detectors
class CountingDetector(FakeDetector):
    def __init__(self):
        super().__init__(lambda text: [])
        self.calls: list[int] = []

    def detect_batch(self, texts):
        self.calls.extend(len(t) for t in texts)
        return [[] for _ in texts]


def test_documents_are_windowed_at_the_production_geometry():
    det = CountingDetector()
    detect_document(det, "a" * 4300)
    # 2000 / 256: starts 0, 1744, 3488 -> sizes 2000, 2000, 812
    assert det.calls == [2000, 2000, 812]


def test_spans_are_rebased_to_document_offsets_and_deduped_across_windows():
    name = "Anil Kumar"
    text = "x" * 1995 + name + " " + "y" * 600  # the name straddles the first window's end
    start = text.index(name)

    def clipped_or_whole(chunk: str):
        i = chunk.find(name)
        if i >= 0:
            return [Detection("PERSON", i, i + len(name), 0.9)]
        for k in range(len(name) - 1, 0, -1):  # a model clipped at the window edge
            if chunk.endswith(name[:k]):
                return [Detection("PERSON", len(chunk) - k, len(chunk), 0.8)]
        return []

    spans = detect_document(FakeDetector(clipped_or_whole), text)
    assert [(s.start, s.end) for s in spans] == [(start, start + len(name))]


def test_evaluate_detections_with_gold_as_prediction_has_zero_residual_and_full_recall():
    ds = generate_dataset(seed=11, n_dev=0, n_test=6, skeleton=builtin_skeleton())
    docs = ds["test"]
    preds = [[Detection(s["label"], s["start"], s["end"], 1.0) for s in d["spans"]] for d in docs]
    report = evaluate_detections(docs, preds)
    assert report["spans"]["strict"]["micro"]["recall"] == 1.0
    assert report["spans"]["strict"]["micro"]["precision"] == 1.0
    assert report["masking"]["residual"]["overall"]["leaked_any"] == 0
    assert report["masking"]["residual"]["verbatim_survivors"] == 0
    assert report["masking"]["overmask"]["overall"]["overmasked"] == 0
    assert report["masking"]["restore"]["rate"] <= 1.0


def test_evaluate_detections_masking_everything_overmasks_every_negative():
    ds = generate_dataset(seed=11, n_dev=0, n_test=4, skeleton=builtin_skeleton())
    docs = ds["test"]
    preds = [[Detection("PERSON", n["start"], n["end"], 1.0) for n in d["negatives"]] for d in docs]
    report = evaluate_detections(docs, preds)
    assert report["masking"]["overmask"]["overall"]["rate"] == 1.0


def test_evaluate_empty_detector_leaks_everything():
    ds = generate_dataset(seed=11, n_dev=0, n_test=4, skeleton=builtin_skeleton())
    report = evaluate(FakeDetector(lambda t: []), ds["test"])
    r = report["masking"]["residual"]["overall"]
    assert r["spans"] > 0 and r["leaked_any"] == r["spans"] and r["rate_any"] == 1.0
    assert report["spans"]["relaxed"]["micro"]["recall"] == 0.0


def test_regex_detector_finds_structured_ids_and_nothing_in_plain_prose():
    det = RegexDetector()
    text = "Mail anil@gmail.com, Aadhaar 2363 1234 5671, PAN ABCPK1234F, call +91 98470 12345."
    found = {(d.label, text[d.start : d.end]) for d in det.detect(text)}
    assert ("EMAIL", "anil@gmail.com") in found
    assert ("PAN", "ABCPK1234F") in found
    assert any(label == "PHONE" for label, _ in found)
    assert det.detect("The patient has a mild headache for three days.") == []


def test_regex_detector_checks_the_aadhaar_checksum():
    from pii_eval.verhoeff import verhoeff_check_digit

    body = "23631234567"
    valid = body + verhoeff_check_digit(body)
    invalid = body + str((int(valid[-1]) + 1) % 10)
    det = RegexDetector()
    assert [d.label for d in det.detect(f"id {valid}")] == ["AADHAAR"]
    assert det.detect(f"batch {invalid}") == []


def test_model_adapters_refuse_to_load_without_approval(monkeypatch):
    monkeypatch.delenv("HOPE_1049_ALLOW_MODEL_LOAD", raising=False)
    det = Gliner2Detector("fastino/gliner2-privacy-filter-PII-multi", labels=["person"])
    with pytest.raises(ModelLoadNotApproved):
        det.load()


def test_detector_protocol_is_satisfied_by_the_builtin_detectors():
    for det in (RegexDetector(), FakeDetector(lambda t: [])):
        assert isinstance(det, Detector)


def test_regex_detector_finds_an_ip_address_at_the_end_of_a_sentence():
    text = "Portal login recorded from IP 103.21.58.114."
    found = [(d.label, text[d.start : d.end]) for d in RegexDetector().detect(text)]
    assert found == [("IP_ADDRESS", "103.21.58.114")]
