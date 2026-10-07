"""TASK-1049 Track P (P-1) — the synthetic PHI dataset generator (offline, scripts only).

Pins what would silently corrupt every reported number: gold offsets that are exact by
construction, a checksum-valid Aadhaar, a generator that is byte-deterministic for a seed,
hard negatives that are actually present, and dev/test that do not share names.
"""

from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from pii_eval.generate import (  # noqa: E402
    builtin_skeleton,
    dataset_stats,
    generate_dataset,
    write_dataset,
)
from pii_eval.labels import CLINICIAN, PHI_LABELS  # noqa: E402
from pii_eval.verhoeff import verhoeff_check_digit, verhoeff_valid  # noqa: E402


@pytest.fixture(scope="module")
def dataset():
    return generate_dataset(seed=1049, n_dev=12, n_test=24, skeleton=builtin_skeleton())


def _docs(dataset):
    return [d for split in dataset.values() for d in split]


def test_verhoeff_known_vector_and_roundtrip():
    # Wikipedia's worked example: "236" has check digit 3.
    assert verhoeff_check_digit("236") == "3"
    assert verhoeff_valid("2363")
    assert not verhoeff_valid("2364")
    assert not verhoeff_valid("2336")  # transposition is detected


def test_gold_offsets_are_exact(dataset):
    for doc in _docs(dataset):
        for span in doc["spans"]:
            assert doc["text"][span["start"] : span["end"]] == span["text"], doc["id"]
        for neg in doc["negatives"]:
            assert doc["text"][neg["start"] : neg["end"]] == neg["text"], doc["id"]


def test_gold_spans_do_not_overlap(dataset):
    for doc in _docs(dataset):
        marks = sorted((s["start"], s["end"]) for s in doc["spans"] + doc["negatives"])
        for (_, end), (start, _) in zip(marks, marks[1:], strict=False):
            assert end <= start, doc["id"]


def test_aadhaar_spans_are_verhoeff_valid_and_start_2_to_9(dataset):
    found = [s for d in _docs(dataset) for s in d["spans"] if s["label"] == "AADHAAR"]
    assert found, "no Aadhaar generated"
    for s in found:
        digits = "".join(ch for ch in s["text"] if ch.isdigit())
        assert len(digits) == 12 and digits[0] in "23456789"
        assert verhoeff_valid(digits)


def test_abha_pan_and_pin_shapes(dataset):
    import re

    spans = [s for d in _docs(dataset) for s in d["spans"]]
    abha = [s["text"] for s in spans if s["label"] == "ABHA"]
    pan = [s["text"] for s in spans if s["label"] == "PAN"]
    pin = [s["text"] for s in spans if s["label"] == "PIN_CODE"]
    assert abha and pan and pin
    for text in abha:
        digits = re.sub(r"\D", "", text)
        assert re.fullmatch(r"[\d\- ]+", text) is None or len(digits) == 14 or "@" in text
    assert all(re.fullmatch(r"[A-Z]{5}\d{4}[A-Z]", t) for t in pan)
    assert all(re.fullmatch(r"[1-9]\d{5}", t) for t in pin)


def test_every_phi_label_and_hard_negative_kind_is_present(dataset):
    labels = Counter(s["label"] for d in _docs(dataset) for s in d["spans"])
    for label in (*PHI_LABELS, CLINICIAN):
        assert labels[label] > 0, f"label never generated: {label}"
    kinds = {n["kind"] for d in _docs(dataset) for n in d["negatives"]}
    assert {
        "eponym_disease",
        "eponym_anatomy",
        "drug_name",
        "clinical_interval",
        "dose_number",
        "age_under_90",
    } <= kinds


def test_clinician_is_distinct_from_patient(dataset):
    for doc in _docs(dataset):
        by_entity = {}
        for s in doc["spans"]:
            by_entity.setdefault(s["entity"], set()).add(s["label"])
        for entity, labels in by_entity.items():
            assert len(labels) == 1, (doc["id"], entity, labels)
    patients = {
        s["text"] for d in _docs(dataset) for s in d["spans"] if s["label"] == "PATIENT_NAME"
    }
    clinicians = {s["text"] for d in _docs(dataset) for s in d["spans"] if s["label"] == CLINICIAN}
    assert patients and clinicians


def test_code_switch_docs_exist_and_are_latin_script(dataset):
    cs = [d for d in _docs(dataset) if d["kind"] == "dialogue_mlen"]
    assert cs
    for doc in cs:
        assert doc["text"].isascii()


def test_age_over_89_only_when_age_is_over_89(dataset):
    for doc in _docs(dataset):
        for s in doc["spans"]:
            if s["label"] == "AGE_OVER_89":
                assert int(s["text"]) >= 90
        for n in doc["negatives"]:
            if n["kind"] == "age_under_90":
                assert int(n["text"]) < 90


def test_consultations_group_a_dialogue_and_a_note(dataset):
    groups = {}
    for d in _docs(dataset):
        groups.setdefault(d["consultation_id"], []).append(d["kind"])
    assert all(len(v) == 2 for v in groups.values())
    assert all("note" in v for v in groups.values())


def test_same_seed_is_byte_identical_and_other_seed_differs():
    a = generate_dataset(seed=7, n_dev=4, n_test=6, skeleton=builtin_skeleton())
    b = generate_dataset(seed=7, n_dev=4, n_test=6, skeleton=builtin_skeleton())
    c = generate_dataset(seed=8, n_dev=4, n_test=6, skeleton=builtin_skeleton())

    def digest(ds):
        return hashlib.sha256(json.dumps(ds, sort_keys=True).encode()).hexdigest()

    assert digest(a) == digest(b)
    assert digest(a) != digest(c)


def test_dev_and_test_share_no_person_names(dataset):
    def names(split):
        out = set()
        for d in dataset[split]:
            for s in d["spans"]:
                if s["label"] in ("PATIENT_NAME", "RELATIVE_NAME", CLINICIAN):
                    out.update(s["text"].split())
        return out

    assert names("dev").isdisjoint(names("test"))


def test_long_documents_exist_for_window_tests():
    ds = generate_dataset(seed=1049, n_dev=0, n_test=40, skeleton=builtin_skeleton())
    assert max(len(d["text"]) for d in ds["test"]) > 6000


def test_write_dataset_manifest_hashes_match_files(tmp_path):
    manifest = write_dataset(
        tmp_path, seed=3, n_dev=3, n_test=5, skeleton=builtin_skeleton(), skeleton_sources=[]
    )
    assert manifest["seed"] == 3
    for name, entry in manifest["files"].items():
        data = (tmp_path / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry["sha256"]
    on_disk = json.loads((tmp_path / "manifest.json").read_text())
    assert on_disk == manifest
    again = write_dataset(
        tmp_path / "again",
        seed=3,
        n_dev=3,
        n_test=5,
        skeleton=builtin_skeleton(),
        skeleton_sources=[],
    )
    assert again["files"] == manifest["files"]


def test_dataset_stats_counts_per_label_per_split(dataset):
    stats = dataset_stats(dataset)
    assert set(stats) == {"dev", "test"}
    total = sum(stats["dev"]["labels"].values())
    assert total == sum(len(d["spans"]) for d in dataset["dev"])
    assert stats["dev"]["documents"] == len(dataset["dev"])
