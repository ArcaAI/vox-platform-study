"""TASK-1050 W2a — the Python mirror of the frozen judge contract, and the two protocol adapters.

The TypeScript originals are `packages/types/src/guardrail-judge-model.ts` and
`guardrail-judge-template.ts`; both are frozen by fixtures under `tests/contracts/`. Every constant
and pure function mirrored here is pinned against those fixtures, so the two languages cannot drift.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from guardrail.services import judge_protocols as jp

ROOT = Path(__file__).resolve().parents[5]
MODEL_FIXTURE = json.loads(
    (ROOT / "tests/contracts/guardrail-judge-model.fixture.json").read_text()
)
TEMPLATE_FIXTURE = json.loads(
    (ROOT / "tests/contracts/guardrail-judge-template.fixture.json").read_text()
)

QWEN_META: dict[str, Any] = MODEL_FIXTURE["valid"][1]["meta"]


# ── parity with the frozen fixtures ─────────────────────────────────────────────


def test_vocabulary_mirrors_the_judge_model_fixture() -> None:
    assert list(jp.JUDGE_PROTOCOLS) == MODEL_FIXTURE["protocols"]
    assert list(jp.GUARDRAIL_JUDGE_LANES) == MODEL_FIXTURE["judgeLanes"]
    assert list(jp.JUDGE_TIER_NAMES) == MODEL_FIXTURE["tierNames"]
    assert list(jp.JUDGE_CONTROVERSIAL_TIER_VALUES) == MODEL_FIXTURE["controversialTierValues"]
    assert {lane: jp.lane_task_key(lane) for lane in jp.GUARDRAIL_JUDGE_LANES} == MODEL_FIXTURE[
        "taskKeys"
    ]
    assert jp.JUDGE_LANE_UNSUPPORTED == MODEL_FIXTURE["errorCode"]


@pytest.mark.parametrize("case", MODEL_FIXTURE["valid"], ids=lambda c: c["name"])
def test_valid_declarations_have_no_problem(case: dict[str, Any]) -> None:
    assert jp.judge_metadata_problems(case["meta"]) == []


@pytest.mark.parametrize("case", MODEL_FIXTURE["invalid"], ids=lambda c: c["name"])
def test_invalid_declarations_name_their_problem(case: dict[str, Any]) -> None:
    problems = jp.judge_metadata_problems(case["meta"])
    assert any(case["problem"] in problem for problem in problems), problems


@pytest.mark.parametrize("case", MODEL_FIXTURE["supports"], ids=lambda c: c["name"])
def test_lane_support_matches_the_fixture(case: dict[str, Any]) -> None:
    for lane in case["supported"]:
        assert jp.model_supports_lane(case["meta"], lane) is True
    for lane in case["unsupported"]:
        assert jp.model_supports_lane(case["meta"], lane) is False


def test_template_constants_mirror_the_template_fixture() -> None:
    assert jp.GUARDRAIL_JUDGE_UNTRUSTED_DATA_CLAUSE == TEMPLATE_FIXTURE["untrustedDataClause"]
    assert {k: list(v) for k, v in jp.GUARDRAIL_JUDGE_LANE_CATEGORIES.items()} == TEMPLATE_FIXTURE[
        "laneCategories"
    ]
    for lane, categories in TEMPLATE_FIXTURE["laneCategories"].items():
        expected = TEMPLATE_FIXTURE["outputContractTemplate"].replace(
            "{categories}", "/".join(categories)
        )
        assert jp.guardrail_judge_output_contract(categories) == expected, lane


@pytest.mark.parametrize("lane", sorted(TEMPLATE_FIXTURE["examples"]))
def test_compose_matches_the_typescript_composer_byte_for_byte(lane: str) -> None:
    parts = TEMPLATE_FIXTURE["parts"][lane]
    composed = jp.compose_guardrail_judge_prompt(
        role_and_task=parts["roleAndTask"],
        unsafe_definitions=parts["unsafeDefinitions"],
        safe_examples=parts["safeExamples"],
        lane_categories=TEMPLATE_FIXTURE["laneCategories"][lane],
    )
    assert composed == TEMPLATE_FIXTURE["examples"][lane]


def test_every_lane_reads_its_own_criteria_key() -> None:
    assert jp.LANE_CRITERIA_KEYS == {
        "medical_validation": "medicalWindowScopeCriteria",
        "injection_judge": "injectionJudgeCriteria",
        "unsafe_content_judge": "unsafeContentJudgeCriteria",
        "clinical_safety_judge": "outboundClinicalSafetyCriteria",
        "leakage_judge": "outboundLeakageCriteria",
    }


# ── criteria_json: the combined call ──────────────────────────────────────────


def test_combined_system_prompt_is_one_section_per_lane_in_canonical_order() -> None:
    system = jp.combined_system_prompt(
        [("unsafe_content_judge", "UNSAFE CRITERIA"), ("medical_validation", "MED CRITERIA")]
    )
    assert system.index('<section id="medical_validation">') < system.index(
        '<section id="unsafe_content_judge">'
    )
    assert "MED CRITERIA" in system and "UNSAFE CRITERIA" in system


def test_combined_schema_is_strict_and_verdict_only() -> None:
    schema = jp.combined_verdict_schema(("medical_validation", "injection_judge"))
    assert schema["required"] == ["medical_validation", "injection_judge"]
    assert schema["additionalProperties"] is False
    injection = schema["properties"]["injection_judge"]
    assert injection["required"] == ["safe", "confidence", "category"]
    assert "reasoning" not in injection["properties"]  # A1: verdict-only
    assert injection["properties"]["category"]["enum"] == list(
        jp.GUARDRAIL_JUDGE_LANE_CATEGORIES["injection_judge"]
    )
    medical = schema["properties"]["medical_validation"]
    assert medical["required"] == ["is_medical", "confidence", "context_type"]
    assert "reasoning" not in medical["properties"]


def test_combined_parse_reads_one_verdict_per_lane() -> None:
    content = json.dumps(
        {
            "medical_validation": {
                "is_medical": True,
                "confidence": 0.9,
                "context_type": "clinical",
            },
            "injection_judge": {"safe": False, "confidence": 0.95, "category": "role_play"},
            "unsafe_content_judge": {"safe": True, "confidence": 0.99, "category": "none"},
        }
    )
    parsed = jp.parse_combined(
        content,
        ("medical_validation", "injection_judge", "unsafe_content_judge"),
        min_confidence={
            "medical_validation": 0.75,
            "injection_judge": 0.75,
            "unsafe_content_judge": 0.75,
        },
    )
    assert parsed["medical_validation"] == jp.ParsedLane("pass", "clinical", 0.9, None)
    assert parsed["injection_judge"] == jp.ParsedLane("flag", "role_play", 0.95, None)
    assert parsed["unsafe_content_judge"] == jp.ParsedLane("pass", None, 0.99, None)


def test_combined_parse_fails_each_unreadable_lane_alone() -> None:
    content = json.dumps(
        {
            "injection_judge": {"safe": False, "confidence": 0.4, "category": "role_play"},
            "unsafe_content_judge": {"safe": "maybe"},
        }
    )
    parsed = jp.parse_combined(
        content,
        ("medical_validation", "injection_judge", "unsafe_content_judge"),
        min_confidence={
            "medical_validation": 0.75,
            "injection_judge": 0.75,
            "unsafe_content_judge": 0.75,
        },
    )
    assert parsed["medical_validation"].verdict == "undetermined"
    assert parsed["medical_validation"].category == jp.REASON_UNPARSEABLE
    assert parsed["injection_judge"] == jp.ParsedLane(
        "undetermined", jp.REASON_LOW_CONFIDENCE, 0.4, None
    )
    assert parsed["unsafe_content_judge"].category == jp.REASON_UNPARSEABLE


def test_combined_parse_of_garbage_is_undetermined_for_every_lane() -> None:
    parsed = jp.parse_combined("not json {", ("injection_judge",), min_confidence={})
    assert parsed["injection_judge"].verdict == "undetermined"


def test_a_category_outside_the_lane_enum_is_undetermined() -> None:
    parsed = jp.parse_combined(
        json.dumps({"injection_judge": {"safe": False, "confidence": 0.9, "category": "violence"}}),
        ("injection_judge",),
        min_confidence={},
    )
    assert parsed["injection_judge"].verdict == "undetermined"


# ── qwen3guard_native: the mapping is config ──────────────────────────────────


def _qwen(tier: str, categories: list[str], reason: str | None = None) -> dict[str, Any]:
    return {
        "tier": tier,
        "categories": categories,
        "refusal": None,
        "undetermined_reason": reason,
        "latency_ms": 12,
    }


LANES = ("injection_judge", "unsafe_content_judge")


def test_qwen_safe_passes_every_lane_at_full_confidence() -> None:
    mapped = jp.map_qwen3guard(_qwen("Safe", []), LANES, QWEN_META)
    assert mapped == {lane: jp.ParsedLane("pass", None, 1.0, "pass") for lane in LANES}


def test_qwen_unsafe_maps_categories_to_their_lane_only() -> None:
    mapped = jp.map_qwen3guard(_qwen("Unsafe", ["Jailbreak"]), LANES, QWEN_META)
    assert mapped["injection_judge"] == jp.ParsedLane("flag", "instruction_override", 1.0, "flag")
    assert mapped["unsafe_content_judge"] == jp.ParsedLane("pass", None, 1.0, "flag")


def test_qwen_unmapped_pii_category_is_ignored() -> None:
    mapped = jp.map_qwen3guard(_qwen("Unsafe", ["PII"]), LANES, QWEN_META)
    assert all(v.verdict == "pass" for v in mapped.values())


def test_qwen_controversial_follows_the_configured_tier_value() -> None:
    mapped = jp.map_qwen3guard(_qwen("Controversial", ["Violent"]), LANES, QWEN_META)
    # Controversial → warn (OD-41): a flag whose tier carries the fixed outcome.
    assert mapped["unsafe_content_judge"] == jp.ParsedLane("flag", "violence", 1.0, "warn")
    as_pass = {**QWEN_META, "tiers": {"Safe": "pass", "Controversial": "pass", "Unsafe": "flag"}}
    passed = jp.map_qwen3guard(_qwen("Controversial", ["Violent"]), LANES, as_pass)
    assert passed["unsafe_content_judge"] == jp.ParsedLane("pass", None, 1.0, "pass")


def test_qwen_unparseable_generation_is_undetermined() -> None:
    mapped = jp.map_qwen3guard(_qwen("undetermined", [], "no Safety line"), LANES, QWEN_META)
    assert all(v.verdict == "undetermined" for v in mapped.values())
    assert all(v.category == jp.REASON_UNPARSEABLE for v in mapped.values())


def test_qwen_unsafe_without_any_category_cannot_be_attributed() -> None:
    mapped = jp.map_qwen3guard(_qwen("Unsafe", []), LANES, QWEN_META)
    assert all(v.verdict == "undetermined" for v in mapped.values())
    assert all(v.category == jp.REASON_UNATTRIBUTED for v in mapped.values())
