"""TASK-1050 / TASK-1049 F7 — the live lane's own previous note is never re-judged.

The live lane sends its previous note as the `current_note` data region (W2g,
`LIVE_SELF_NOTE_REGION_KEY`). It is the lane's own output, already screened by TEXT's
output gate when it was generated, and it is rewritten every flush, so judging it again
costs ~2-3 judge windows per flush with a guaranteed cache miss. It joins the medical
judge's configuration skip list, and configuration-skipped regions are also outside the
inbound safety lanes.
"""

from __future__ import annotations

from guardrail.core.policy import GuardrailPolicy
from guardrail.services import judge_protocols as jp
from guardrail.services.judge_runner import plan_inbound_judge_calls
from guardrail.services.windowing import WindowGeometry


def _lanes_by_region(plan) -> dict[str, tuple[str, ...]]:
    out: dict[str, tuple[str, ...]] = {}
    for lanes, windows in plan:
        for window in windows:
            out[window.region_key.split("@", 1)[0]] = lanes
    return out


def test_current_note_is_in_the_default_medical_skip_list() -> None:
    assert "current_note" in GuardrailPolicy({}).medical_judge_config_regions


def test_current_note_gets_no_judge_lane_but_the_transcript_does() -> None:
    skip = GuardrailPolicy({}).medical_judge_config_regions
    regions = [
        ("transcript", "Patient reports chest pain since yesterday.", "data"),
        ("current_note", "S: chest pain. O: BP 140/90.", "data"),
    ]
    plan = plan_inbound_judge_calls(
        regions,
        enabled_safety_lanes=list(jp.INBOUND_SAFETY_LANES),
        medical_skip=skip,
        geometry=WindowGeometry(size=2000, overlap=256, concurrency=4),
    )
    lanes = _lanes_by_region(plan)
    assert "current_note" not in lanes
    assert jp.MEDICAL_LANE in lanes["transcript"]
    assert set(jp.INBOUND_SAFETY_LANES) <= set(lanes["transcript"])
