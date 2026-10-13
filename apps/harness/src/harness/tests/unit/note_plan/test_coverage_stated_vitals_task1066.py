"""Note safety: the vitals the consultation's transcript states must reach the note.

Live failure (cluster, consultation 01a13368…, encounters 1 and 2): the doctor says "Your blood
pressure today is 152/94 and your pulse is 88" in encounter 1 (S17). The gateway's results line
carried the clinic's 2025-06-20 set WITH the supersession note, yet both notes stated only the
dated clinic set ("Vital signs recorded on 2025-06-20: BP 110/60 mmHg, HR 74 bpm … [R1]") and never
the spoken reading. Because the sentence is dated, the "earlier reading stated as today's" check
skipped it, and the ledger had marked the two vitals non-critical, so no gap was raised at all.

Fixture ``live_stated_vitals_task1066.json``: the encounter blocks and results line exactly as the
composed finalize prompts rendered them, and the two notes as the run persisted them.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from harness.services.note_plan.coverage import check_coverage, repair_directive
from harness.services.note_plan.models import NotePlanV1

LIVE: dict[str, Any] = json.loads(
    Path(__file__).with_name("live_stated_vitals_task1066.json").read_text("utf-8")
)
_BASE: dict[str, Any] = json.loads(
    Path(__file__).with_name("live_two_encounter_plan_task1045.json").read_text("utf-8")
)


def _key(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")


def _plan(blocks: list[dict[str, Any]], titles: list[str]) -> NotePlanV1:
    raw = json.loads(json.dumps(_BASE))
    raw["blocks"] = [{**block, "tokens": 10} for block in blocks]
    raw["headings"] = [{"key": _key(title), "title": title} for title in titles]
    raw["calls"] = [
        {
            "callId": "c1",
            "sectionKeys": [_key(title) for title in titles],
            "directive": "Write all sections.",
            "maxTokens": 1792,
            "promptTokens": 3000,
        }
    ]
    labels = {
        m.group(1) for block in blocks for m in re.finditer(r"\[([SR]\d+)[\s\]]", block["content"])
    }
    raw["coverage"] = {
        "criticalFacts": [],
        "sourceIds": {label: {"id": f"id-{label}", "v": 1, "kind": "segment"} for label in labels},
    }
    return NotePlanV1.model_validate(raw)


def _encounter(seq: int, content: str | None = None) -> dict[str, Any]:
    live = LIVE[f"encounter{seq}"]
    return {
        "key": f"encounter_{seq}",
        "role": "encounter_transcript",
        "label": live["label"],
        "content": live["content"] if content is None else content,
    }


def _results(content: str) -> dict[str, Any]:
    return {"key": "results", "role": "results", "label": "Results", "content": content}


def _sections(note: dict[str, str]) -> dict[str, str]:
    return {_key(title): text for title, text in note.items()}


ENC1_PLAN = _plan([_encounter(1), _results(LIVE["resultsEnc1"])], list(LIVE["noteEnc1"]))
ENC2_PLAN = _plan(
    [_encounter(1), _results(LIVE["resultsEnc2"]), _encounter(2)], list(LIVE["noteEnc2"])
)
ENC1_NOTE = _sections(LIVE["noteEnc1"])
ENC2_NOTE = _sections(LIVE["noteEnc2"])
EXAM1 = "physical_examination"
EXAM2 = "clinical_examination_updates"

_VITAL_WORDS = re.compile(r"\b(?:BP|pulse)\b")


def _vital_gaps(
    plan: NotePlanV1, sections: dict[str, str], **kwargs: Any
) -> list[tuple[str | None, str]]:
    result = check_coverage(plan, sections, {}, **kwargs)
    return [
        (gap.section_key, gap.detail)
        for gap in result.gaps
        if gap.kind == "ungrounded" and _VITAL_WORDS.search(gap.detail)
    ]


# --- the live notes ----------------------------------------------------------------------------


def test_live_encounter_1_note_with_only_the_dated_clinic_set_is_a_gap() -> None:
    gaps = _vital_gaps(ENC1_PLAN, ENC1_NOTE)

    assert {section for section, _ in gaps} == {EXAM1}
    details = " ".join(detail for _, detail in gaps)
    assert "152/94" in details and "88" in details
    assert "S17" in details


def test_live_encounter_2_note_omits_the_reading_encounter_1_stated() -> None:
    # Encounter 2 states no vital; the reading of this consultation is still encounter 1's.
    gaps = _vital_gaps(ENC2_PLAN, ENC2_NOTE)

    assert {section for section, _ in gaps} == {EXAM2}
    details = " ".join(detail for _, detail in gaps)
    assert "152/94" in details and "88" in details
    assert "encounter 1" in details


def test_the_spoken_reading_beside_the_dated_clinic_set_is_not_a_gap() -> None:
    exam = (
        "Blood pressure today is 152/94 mmHg and pulse is 88 bpm [S17 E1]. Vital signs recorded "
        "on 2025-06-20: BP 110/60 mmHg, HR 74 bpm, Temp 97.8 °F, SpO2 98 % [R1]."
    )
    assert _vital_gaps(ENC1_PLAN, {**ENC1_NOTE, EXAM1: exam}) == []
    assert _vital_gaps(ENC2_PLAN, {**ENC2_NOTE, EXAM2: exam}) == []


def test_only_the_omitted_vital_is_a_gap() -> None:
    exam = "BP 152/94 mmHg [S17 E1]. Pulse rate 74 bpm, recorded 2025-06-20 [R1]."
    gaps = _vital_gaps(ENC1_PLAN, {**ENC1_NOTE, EXAM1: exam})

    assert len(gaps) == 1
    section, detail = gaps[0]
    assert section == EXAM1
    assert "pulse" in detail and "88" in detail and "152/94" not in detail


def test_the_spoken_reading_in_a_preserved_clinician_section_counts() -> None:
    sections = {
        **ENC1_NOTE,
        "diagnosis": ENC1_NOTE["diagnosis"] + " BP 152/94, pulse 88 today [S17 E1].",
    }
    checked = [key for key in sections if key != "diagnosis"]
    assert _vital_gaps(ENC1_PLAN, sections, checked_keys=checked) == []


def test_a_note_stating_no_vital_at_all_raises_no_vitals_gap() -> None:
    assert _vital_gaps(ENC1_PLAN, {**ENC1_NOTE, EXAM1: "Not discussed"}) == []


def test_no_vitals_gap_when_no_encounter_states_a_reading() -> None:
    quiet = LIVE["encounter1"]["content"].replace(
        "Your blood pressure today is 152/94 and your pulse is 88", "Let me examine you"
    )
    plan = _plan([_encounter(1, quiet), _results(LIVE["resultsEnc2"])], list(LIVE["noteEnc1"]))
    assert _vital_gaps(plan, ENC1_NOTE) == []


def test_each_vital_is_taken_from_the_latest_encounter_that_states_it() -> None:
    # Encounter 2 re-measures the BP only: its BP wins, the pulse is still encounter 1's.
    e2 = LIVE["encounter2"]["content"] + "\n[S39 E2 Unknown 02:50] Your BP now is 138/86"
    plan = _plan(
        [_encounter(1), _results(LIVE["resultsEnc2"]), _encounter(2, e2)], list(LIVE["noteEnc2"])
    )
    good = "BP 138/86 mmHg [S39 E2], pulse 88 bpm [S17 E1]."
    assert _vital_gaps(plan, {**ENC2_NOTE, EXAM2: good}) == []

    bp = _vital_gaps(plan, {**ENC2_NOTE, EXAM2: "BP 152/94 mmHg, pulse 88 bpm."})
    assert [(section, "152/94" in d and "138/86" in d and "S39 E2" in d) for section, d in bp] == [
        (EXAM2, True)
    ]
    pulse = _vital_gaps(plan, {**ENC2_NOTE, EXAM2: "BP 138/86 mmHg [S39 E2]. Pulse 74 bpm."})
    assert [(section, "74" in d and "88" in d and "S17 E1" in d) for section, d in pulse] == [
        (EXAM2, True)
    ]


# --- an undated earlier reading, however it is worded ------------------------------------------


def test_an_undated_clinic_set_not_phrased_as_today_is_a_gap() -> None:
    exam = "BP 110/60 mmHg, HR 74 bpm, Temp 97.8 °F, SpO2 98 % [R1]."
    gaps = _vital_gaps(ENC1_PLAN, {**ENC1_NOTE, EXAM1: exam})

    details = " ".join(detail for _, detail in gaps)
    assert {section for section, _ in gaps} == {EXAM1}
    assert "110/60" in details and "152/94" in details
    assert "74" in details and "88" in details


def test_readings_spoken_with_by_and_per_minute_are_read() -> None:
    spoken = LIVE["encounter1"]["content"].replace(
        "Your blood pressure today is 152/94 and your pulse is 88",
        "Your BP is 152 by 94, pulse rate 88 per minute",
    )
    plan = _plan([_encounter(1, spoken), _results(LIVE["resultsEnc2"])], list(LIVE["noteEnc1"]))
    gaps = _vital_gaps(plan, {**ENC1_NOTE, EXAM1: "PR 74/min, BP 110/60 mmHg [R1]."})

    details = " ".join(detail for _, detail in gaps)
    assert "110/60" in details and "152/94" in details
    assert "74" in details and "88" in details


def test_an_ecg_pr_interval_is_not_a_pulse() -> None:
    exam = "BP 152/94 mmHg and pulse 88 [S17 E1]. ECG: PR interval 160 ms [R1]."
    assert _vital_gaps(ENC1_PLAN, {**ENC1_NOTE, EXAM1: exam}) == []


# --- repair ------------------------------------------------------------------------------------


def test_the_repair_directive_quotes_the_omitted_reading_and_its_line() -> None:
    result = check_coverage(ENC1_PLAN, ENC1_NOTE, {})
    directive = repair_directive(ENC1_PLAN, result, [EXAM1], ENC1_NOTE)

    assert "Fix:" in directive
    assert "152/94" in directive and "[S17 E1]" in directive
