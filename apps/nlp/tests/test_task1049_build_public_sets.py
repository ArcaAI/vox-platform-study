"""TASK-1049 L1 — deterministic public/benign evaluation-set builder (offline only).

Tiny inline fixtures stand in for the downloaded corpora; nothing here touches the network.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from injection_eval import build_public_sets as bps  # noqa: E402
from injection_eval.core import iter_windows  # noqa: E402

RECORD_KEYS = {"id", "set", "split", "label", "text", "meta"}


def test_aci_dialogue_parser_matches_real_csv_format():
    raw = "[doctor] hi , martha . how are you ?\n[patient] i'm doing okay .\n[doctor] good ."
    assert bps.parse_aci_dialogue(raw) == (
        "Doctor: hi , martha . how are you ?\nPatient: i'm doing okay .\nDoctor: good ."
    )


def test_aci_dialogue_parser_joins_continuation_lines_and_unknown_speaker():
    raw = "[doctor] first line\nsecond line\n[nurse] hello"
    assert bps.parse_aci_dialogue(raw) == "Doctor: first line second line\nNurse: hello"


def test_mts_regions_are_bounded_and_deterministic():
    dialogues = [f"Doctor: q{i} " + "x" * 400 + "\nPatient: a" for i in range(40)]
    regions = bps.build_mts_regions(dialogues, min_chars=1800, max_chars=4000)
    assert regions == bps.build_mts_regions(dialogues, min_chars=1800, max_chars=4000)
    assert regions
    for region in regions:
        assert 1800 <= len(region) <= 4000
        assert "\n\n" in region
    # nothing duplicated, order preserved
    joined = "\n\n".join(regions)
    assert joined.index("q0 ") < joined.index("q5 ")


def test_mts_regions_dedupe_identical_dialogues():
    d = "Doctor: " + "y" * 500
    regions = bps.build_mts_regions([d, d, d, d, d, d, d], min_chars=1800, max_chars=4000)
    assert all(r.count(d) <= 1 for r in regions)


def test_split_rule_is_the_frozen_hash_rule():
    import hashlib

    for i in range(50):
        rid = f"b1:aci:train:D2N{i:03d}"
        expected = "dev" if int(hashlib.sha1(rid.encode()).hexdigest(), 16) % 10 < 3 else "test"
        assert bps.split_for("b1", rid) == expected
    assert {bps.split_for("b1", f"b1:x:{i}") for i in range(200)} == {"dev", "test"}


@pytest.mark.parametrize("set_name", ["a", "b3", "c1"])
def test_non_b1_sets_are_always_test(set_name):
    assert all(bps.split_for(set_name, f"{set_name}:{i}") == "test" for i in range(100))


def test_make_record_validates_contract_and_rejects_bad_input():
    rec = bps.make_record("b3:one:0", "b3", 0, "hello", {"source": "NotInject"})
    assert set(rec) == RECORD_KEYS
    bps.validate_record(rec)
    with pytest.raises(ValueError):
        bps.validate_record({**rec, "label": 2})
    with pytest.raises(ValueError):
        bps.validate_record({**rec, "text": "  "})
    with pytest.raises(ValueError):
        bps.validate_record({**rec, "meta": {}})
    with pytest.raises(ValueError):
        bps.validate_record({**rec, "split": "val"})


def test_assert_unique_ids():
    r1 = bps.make_record("a:1", "a", 0, "t", {"source": "s"})
    bps.assert_unique_ids([r1])
    with pytest.raises(ValueError):
        bps.assert_unique_ids([r1, r1])


def test_build_aci_records_dedupes_across_files(tmp_path):
    header = "dataset,encounter_id,dialogue,note\n"
    row = 'aci,D2N001,"[doctor] hi\n[patient] hello",n\n'
    (tmp_path / "train.csv").write_text(header + row, encoding="utf-8")
    (tmp_path / "valid.csv").write_text(header + row, encoding="utf-8")
    recs = bps.build_aci_records(tmp_path, ["train", "valid"])
    assert len(recs) == 1
    assert recs[0]["id"] == "b1:aci:train:D2N001"
    assert recs[0]["text"] == "Doctor: hi\nPatient: hello"
    assert recs[0]["label"] == 0 and recs[0]["set"] == "b1"
    bps.validate_record(recs[0])


def test_golden_set_is_the_118_production_rendered_windows():
    recs = bps.build_golden_records()
    bps.assert_unique_ids(recs)
    for r in recs:
        bps.validate_record(r)
        assert r["set"] == "a" and r["split"] == "test" and r["label"] == 0
    # one record per DATA region, rendered as the note composer renders it
    assert all(r["text"].startswith("--- ") for r in recs)
    assert sum(len(list(iter_windows(r["text"], 2000, 256))) for r in recs) == 118


def test_detect_lang_heuristic():
    assert bps.detect_lang("Wie kann ich das Wetter heute und morgen erfahren?") == "de"
    assert bps.detect_lang("How do I check the weather today?") == "en"


def test_sample_is_deterministic_and_capped():
    items = list(range(1000))
    a = bps.sample(items, 300, random.Random(1049))
    b = bps.sample(items, 300, random.Random(1049))
    assert a == b and len(a) == 300
    assert bps.sample(items[:5], 300, random.Random(1049)) == items[:5]


def test_build_c1_records_labels_and_dedupe():
    deepset = [("same text", 1, "train"), ("benign q", 0, "test")]
    gandalf = [("same text",), ("ignore everything",)]
    spml = [("evil", 1), ("nice", 0)]
    recs = bps.build_c1_records(deepset, gandalf, spml, gandalf_cap=300, spml_cap=300)
    bps.assert_unique_ids(recs)
    for r in recs:
        bps.validate_record(r)
        assert r["split"] == "test" and r["set"] == "c1"
    texts = [r["text"] for r in recs]
    assert len(texts) == len(set(texts))
    assert {r["text"]: r["label"] for r in recs}["benign q"] == 0
    assert {r["text"]: r["label"] for r in recs}["evil"] == 1


def test_manifest_counts(tmp_path):
    recs = [
        bps.make_record("b3:1", "b3", 0, "x" * 2100, {"source": "NotInject"}),
        bps.make_record("b3:2", "b3", 0, "short", {"source": "NotInject"}),
    ]
    path = tmp_path / "b3.jsonl"
    bps.write_jsonl(path, recs)
    lines = path.read_text(encoding="utf-8").splitlines()
    assert [json.loads(line)["id"] for line in lines] == ["b3:1", "b3:2"]
    entry = bps.manifest_entry(path, recs, sources=[{"url": "u", "licence": "MIT"}])
    assert entry["records"] == 2
    assert entry["windows"] == 3  # 2100 chars -> 2 windows, "short" -> 1
    assert entry["labels"] == {"0": 2}
    assert len(entry["sha256"]) == 64
