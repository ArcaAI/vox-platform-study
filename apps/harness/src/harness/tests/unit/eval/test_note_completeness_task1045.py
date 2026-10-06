"""TASK-1045 — the multi-encounter note-completeness golden set, its metrics, runner and gate.

Hermetic: no model, no network. Plans are built here from each case's envelope in the shape the
apps/api composer emits (labelled transcript lines, ledger fact lines, ``coverage.sourceIds``); the
TypeScript side composes the real plans from the same envelopes.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncGenerator
from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from harness.core.config import Settings
from harness.eval.note_completeness import (
    GoldenReference,
    NoteCompletenessCaseInput,
    NoteCompletenessThresholds,
    apply_thresholds,
    load_golden_fixture,
    p95,
    run_note_completeness,
    score_case,
)
from harness.main import create_app
from harness.services.note_plan.executor import NoteCallRequest, NoteCallResult
from harness.services.note_plan.models import NotePlanV1

FIXTURE = load_golden_fixture()
CASES = {case["caseId"]: case for case in FIXTURE["cases"]}

THRESHOLDS = NoteCompletenessThresholds(
    critical_fact_recall_min=1.0,
    dose_accuracy_min=1.0,
    unsupported_rate_max=0.02,
    latency_p95_max_ms=0,
)

# ------------------------------------------------------------------------------------------------
# A plan per case, in the composer's wire shape
# ------------------------------------------------------------------------------------------------


def _mmss(ms: int) -> str:
    seconds = ms // 1000
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def _segment_line(encounter_seq: int, segment: dict[str, Any]) -> str:
    return (
        f"[S{segment['seq']} E{encounter_seq} {segment['speaker']} {_mmss(segment['t0Ms'])}] "
        f"{segment['text']}"
    )


def _plan_for(case: dict[str, Any], *, reduce_prior: bool | None = None) -> NotePlanV1:
    env = case["transcript"]
    strategy = case["expectedStrategy"]
    reduce = strategy.startswith("ledger_prior") if reduce_prior is None else reduce_prior
    encounters = env["encounters"]
    source_ids: dict[str, dict[str, Any]] = {}
    blocks: list[dict[str, Any]] = []
    reductions: list[dict[str, Any]] = []
    enc_sources: list[dict[str, Any]] = []
    if env.get("preSummary"):
        blocks.append(
            {"key": "pre_summary", "role": "pre_summary", "label": "Pre-summary",
             "content": env["preSummary"], "tokens": 1}
        )  # fmt: skip
    for enc in encounters:
        for seg in enc["segments"]:
            source_ids[f"S{seg['seq']}"] = {"id": f"seg-{seg['seq']}", "v": 1, "kind": "segment"}
    for index, _ in enumerate(env["results"]):
        source_ids[f"R{index + 1}"] = {"id": f"res-{index + 1}", "v": 1, "kind": "result"}
    for index, _ in enumerate(env["attachmentTranscripts"]):
        source_ids[f"A{index + 1}"] = {
            "id": f"aud-{index + 1}",
            "v": 1,
            "kind": "attachment_transcript",
        }

    def verbatim(enc: dict[str, Any]) -> dict[str, Any]:
        return {
            "key": f"encounter_{enc['seq']}",
            "role": "encounter_transcript",
            "label": f"Encounter {enc['seq']} transcript ({enc['visitType']})",
            "content": "\n".join(_segment_line(enc["seq"], s) for s in enc["segments"]),
            "tokens": 1,
        }

    for enc in encounters[:-1]:
        if reduce:
            cited = {label for fact in enc["ledger"]["facts"] for label in fact["citations"]}
            lines = [
                _segment_line(enc["seq"], s) for s in enc["segments"] if f"S{s['seq']}" in cited
            ]
            if lines:
                blocks.append(
                    {"key": f"encounter_{enc['seq']}", "role": "encounter_transcript",
                     "label": f"Encounter {enc['seq']} — cited segments",
                     "content": "\n".join(lines), "tokens": 1}
                )  # fmt: skip
            blocks.append(
                {
                    "key": f"ledger_{enc['seq']}",
                    "role": "encounter_ledger",
                    "label": f"Encounter {enc['seq']} fact ledger",
                    "content": "\n".join(
                        f"{f['factId']} {f['kind']}: {f['statement']} "
                        + " ".join(f"[{c}]" for c in f["citations"])
                        for f in enc["ledger"]["facts"]
                    ),
                    "tokens": 1,
                }
            )
            reductions.append(
                {"kind": "prior_encounter_to_ledger", "encounterSeq": enc["seq"],
                 "tokensBefore": 20000, "tokensAfter": 400}
            )  # fmt: skip
            enc_sources.append(
                {"seq": enc["seq"], "visitType": enc["visitType"],
                 "segmentCount": len(enc["segments"]), "ledgerItemId": f"ledger-{enc['seq']}",
                 "ledgerVersion": 1, "rendered": "ledger_cited"}
            )  # fmt: skip
        else:
            blocks.append(verbatim(enc))
            enc_sources.append(
                {"seq": enc["seq"], "visitType": enc["visitType"],
                 "segmentCount": len(enc["segments"]), "rendered": "verbatim"}
            )  # fmt: skip
    if env["results"]:
        blocks.append(
            {"key": "results", "role": "results", "label": "Results",
             "content": "\n".join(f"[R{i + 1}] {r['text']}" for i, r in enumerate(env["results"])),
             "tokens": 1}
        )  # fmt: skip
    if env["attachmentTranscripts"]:
        blocks.append(
            {"key": "attachment_audio", "role": "attachment_transcript",
             "label": "Uploaded audio transcripts",
             "content": "\n".join(
                 f"[A{i + 1}] {a['text']}" for i, a in enumerate(env["attachmentTranscripts"])
             ),
             "tokens": 1}
        )  # fmt: skip
    last = encounters[-1]
    blocks.append(verbatim(last))
    enc_sources.append(
        {"seq": last["seq"], "visitType": last["visitType"],
         "segmentCount": len(last["segments"]), "rendered": "verbatim"}
    )  # fmt: skip

    superseded = {
        old for enc in encounters for f in enc["ledger"]["facts"] for old in f.get("supersedes", [])
    }
    critical = [
        {
            "factId": f["factId"],
            "encounterSeq": enc["seq"],
            "key": f["key"],
            "kind": f["kind"],
            "anchors": [f["key"].split(":", 1)[1].replace("_", " "), *f["aliases"]],
            "numbers": f["numbers"],
            "citations": f["citations"],
        }
        for enc in encounters
        for f in enc["ledger"]["facts"]
        if f["critical"] and f["factId"] not in superseded
    ]
    headings = env["headings"]
    keys = [h["key"] for h in headings]
    groups = [keys] if len(keys) < 16 else [keys[: len(keys) // 2], keys[len(keys) // 2 :]]
    calls = [
        {"callId": f"{'g' if len(groups) > 1 else 'c'}{i + 1}", "sectionKeys": group,
         "directive": f"Write only these sections: {', '.join(group)}.", "maxTokens": 1792,
         "promptTokens": 2000}
        for i, group in enumerate(groups)
    ]  # fmt: skip
    return NotePlanV1.model_validate(
        {
            "schema": "hope.note_plan.v1",
            "planId": f"plan-{case['caseId']}",
            "consultationId": f"golden-{case['caseId']}",
            "tenantId": "tenant-golden",
            "inputDigest": "sha256:" + "0" * 64,
            "mode": "final",
            "model": env["conditions"]["model"],
            "budget": {
                "contextWindow": env["conditions"]["model"]["contextWindow"],
                "singlePassRatio": 0.6,
                "safetyTokens": 512,
                "inputTokens": 2000,
                "tokenizer": {"mode": "estimate", "id": "estimate:utf8-bytes/2"},
                "strategy": strategy if reduce_prior is None else "single_pass",
                "reductions": reductions,
            },
            "sources": {"encounters": enc_sources},
            "system": env["conditions"]["system"],
            "blocks": blocks,
            "headings": headings,
            "calls": calls,
            "coverage": {"criticalFacts": critical, "sourceIds": source_ids, "repairPasses": 1},
            "preserve": None,
        }
    )


def _reference(case: dict[str, Any]) -> GoldenReference:
    return GoldenReference.model_validate(case["reference"])


def _score(case_id: str, note: str | None = None, sources: Any = None, latency_ms: float = 1000.0):
    case = CASES[case_id]
    return score_case(
        case_id=case_id,
        reference=_reference(case),
        plan=_plan_for(case),
        case_note=case["reference"]["referenceNote"] if note is None else note,
        sources=sources or [],
        latency_ms=latency_ms,
    )


def _replace_section(note: str, title: str, body: str) -> str:
    pattern = re.compile(rf"(## {re.escape(title)}\n)(.*?)(?=\n\n## |\Z)", re.DOTALL)
    assert pattern.search(note), title
    return pattern.sub(lambda m: m.group(1) + body, note, count=1)


# ------------------------------------------------------------------------------------------------
# The fixture
# ------------------------------------------------------------------------------------------------


class TestGoldenFixture:
    def test_loads_at_least_twelve_synthetic_multi_encounter_cases(self) -> None:
        cases = FIXTURE["cases"]
        assert len(cases) >= 12
        assert len({c["caseId"] for c in cases}) == len(cases)
        for case in cases:
            env, ref = case["transcript"], case["reference"]
            assert env["caseShape"] == "multi_encounter_v1" == ref["caseShape"]
            assert env["synthetic"] is True
            assert len(env["encounters"]) >= 2
            model = env["conditions"]["model"]
            # D-10: the one model, at its 32 768 window, temperature 0.
            assert model["contextWindow"] == 32768
            assert env["conditions"]["temperature"] == 0
            assert ref["referenceNote"].strip()
            assert ref["criticalFacts"], case["caseId"]
            for segment in (s for e in env["encounters"] for s in e["segments"]):
                assert {"seq", "speaker", "t0Ms", "text"} <= set(segment)

    def test_every_golden_citation_resolves_to_a_source_of_its_case(self) -> None:
        for case in FIXTURE["cases"]:
            env = case["transcript"]
            labels = {f"S{s['seq']}" for e in env["encounters"] for s in e["segments"]}
            labels |= {f"R{i + 1}" for i in range(len(env["results"]))}
            labels |= {f"A{i + 1}" for i in range(len(env["attachmentTranscripts"]))}
            for fact in case["reference"]["criticalFacts"]:
                assert set(fact["citations"]) <= labels, (case["caseId"], fact["factId"])
            for enc in env["encounters"]:
                for fact in enc["ledger"]["facts"]:
                    assert set(fact["citations"]) <= labels, (case["caseId"], fact["factId"])

    def test_covers_dose_change_negation_e1_only_allergy_audio_and_long_cases(self) -> None:
        cases = FIXTURE["cases"]

        def text_of(env: dict[str, Any], seq: int) -> str:
            enc = next(e for e in env["encounters"] if e["seq"] == seq)
            return " ".join(s["text"] for s in enc["segments"]).lower()

        dose_changes = [
            (c, f) for c in cases for f in c["reference"]["criticalFacts"]
            if f["kind"] == "dose_change" and f.get("supersededNumbers")
        ]  # fmt: skip
        assert len(dose_changes) >= 3
        for case, fact in dose_changes:
            # The later encounter states the new dose; an earlier one the superseded dose.
            later = text_of(case["transcript"], fact["encounterSeq"])
            assert f"{fact['numbers'][0]['value']} {fact['numbers'][0]['unit']}" in later
            earlier = " ".join(
                text_of(case["transcript"], e["seq"])
                for e in case["transcript"]["encounters"]
                if e["seq"] < fact["encounterSeq"]
            )
            stale = fact["supersededNumbers"][0]
            assert f"{stale['value']} {stale['unit']}" in earlier

        negations = [
            f for c in cases for f in c["reference"]["criticalFacts"] if f["kind"] == "negation"
        ]
        assert len(negations) >= 3

        e1_only_allergies = 0
        for case in cases:
            env = case["transcript"]
            for fact in case["reference"]["criticalFacts"]:
                if fact["kind"] != "allergy" or fact["encounterSeq"] != 1:
                    continue
                later = " ".join(text_of(env, e["seq"]) for e in env["encounters"][1:])
                if fact["anchors"][0].lower() not in later:
                    e1_only_allergies += 1
        assert e1_only_allergies >= 3

        strategies = {c["expectedStrategy"] for c in cases}
        assert {
            "single_pass",
            "ledger_prior",
            "section_groups",
            "ledger_prior+section_groups",
        } <= strategies
        for case in cases:
            if "section_groups" in case["expectedStrategy"]:
                assert len(case["transcript"]["headings"]) >= 16
        assert any(c["transcript"]["attachmentTranscripts"] for c in cases)
        assert any(len(c["transcript"]["encounters"]) >= 3 for c in cases)


# ------------------------------------------------------------------------------------------------
# Metrics
# ------------------------------------------------------------------------------------------------


class TestMetrics:
    @pytest.mark.parametrize("case_id", sorted(CASES))
    def test_every_reference_note_scores_complete(self, case_id: str) -> None:
        score = _score(case_id)
        assert score.missing_fact_ids == [], case_id
        assert score.critical_fact_recall == 1.0
        assert score.dose_accuracy == 1.0
        assert score.statements_unsupported == 0, case_id
        assert score.unsupported_rate == 0.0

    def test_a_missing_e1_allergy_lowers_recall(self) -> None:
        case = CASES["me02-cellulitis-penicillin-allergy"]
        note = _replace_section(
            case["reference"]["referenceNote"],
            "Subjective",
            "Red, hot area around a cut on the left shin for three days [S2].",
        )
        note = note.replace("; penicillin avoided because of the allergy [S4]", "")
        score = _score(case["caseId"], note)
        assert score.missing_fact_ids == ["E1-F1"]
        assert score.critical_fact_recall < 1.0

    def test_the_superseded_dose_is_a_wrong_dose(self) -> None:
        case = CASES["me01-chest-tightness-metformin"]
        note = case["reference"]["referenceNote"].replace(
            "Increase metformin from 500 mg to 1000 mg twice daily [S3] [S7]",
            "Continue metformin 500 mg twice daily [S3]",
        )
        score = _score(case["caseId"], note)
        assert score.doses_total == 1
        assert score.doses_correct == 0
        assert score.wrong_dose_fact_ids == ["E2-F2"]
        assert score.dose_accuracy == 0.0

    def test_a_negation_must_stay_negated(self) -> None:
        case = CASES["me03-hypertension-negation-audio"]
        note = case["reference"]["referenceNote"].replace(
            "No chest pain and no shortness of breath [S2].", "Chest pain on exertion [S2]."
        )
        score = _score(case["caseId"], note)
        assert "E1-F1" in score.missing_fact_ids

    def test_unsupported_numbers_and_unresolved_citations_are_counted(self) -> None:
        case = CASES["me01-chest-tightness-metformin"]
        note = case["reference"]["referenceNote"].replace(
            "Review in 4 weeks [S8].", "Review in 4 weeks [S8]. Add aspirin 75 mg daily [S8]."
        )
        score = _score(
            case["caseId"], note, sources=[{"sectionKey": "plan", "refs": ["S7", "S99"]}]
        )
        assert score.statements_unsupported == 2  # 75 mg, and S99
        assert 0 < score.unsupported_rate <= 1

    def test_p95_is_nearest_rank(self) -> None:
        assert p95([]) is None
        assert p95([400.0]) == 400.0
        assert p95([float(v) for v in range(1, 101)]) == 95.0


class TestLedgerReducedCase:
    def test_reduced_encounter_facts_are_reported_and_scored(self) -> None:
        case = CASES["me09-copd-long-codeine-allergy"]
        plan = _plan_for(case)
        assert plan.budget.strategy == "ledger_prior"
        # E1 reached the model only as its ledger plus the segments it cites.
        assert not any(
            b.key == "encounter_1" and len(b.content.splitlines()) > 20 for b in plan.blocks
        )
        good = score_case(
            case_id=case["caseId"],
            reference=_reference(case),
            plan=plan,
            case_note=case["reference"]["referenceNote"],
            sources=[],
            latency_ms=900.0,
        )
        assert good.budget_strategy == "ledger_prior"
        assert good.reduced_encounters == [1]
        assert good.reduced_facts_total == 3
        assert good.reduced_facts_present == 3
        assert good.statements_unsupported == 0

        note = case["reference"]["referenceNote"].replace(
            " Allergic to codeine (sickness and itch) [S253].", ""
        )
        assert note != case["reference"]["referenceNote"]
        bad = score_case(
            case_id=case["caseId"],
            reference=_reference(case),
            plan=plan,
            case_note=note,
            sources=[],
            latency_ms=900.0,
        )
        assert bad.reduced_facts_present == 2
        assert bad.missing_fact_ids == ["E1-F2"]


# ------------------------------------------------------------------------------------------------
# Gate + runner
# ------------------------------------------------------------------------------------------------


class TestThresholds:
    def test_pass_when_every_threshold_holds(self) -> None:
        passed, failures = apply_thresholds(
            {"critical_fact_recall": 1.0, "dose_accuracy": 1.0, "unsupported_rate": 0.01,
             "stop_to_note_p95_ms": 90000.0},
            THRESHOLDS.model_copy(update={"latency_p95_max_ms": 120000}),
        )  # fmt: skip
        assert passed and failures == []

    def test_fail_names_every_breached_threshold(self) -> None:
        passed, failures = apply_thresholds(
            {"critical_fact_recall": 0.95, "dose_accuracy": 0.9, "unsupported_rate": 0.05,
             "stop_to_note_p95_ms": 150000.0},
            THRESHOLDS.model_copy(update={"latency_p95_max_ms": 120000}),
        )  # fmt: skip
        assert not passed
        assert [f.split(" ")[0] for f in failures] == [
            "critical_fact_recall", "dose_accuracy", "unsupported_rate", "stop_to_note_p95_ms"
        ]  # fmt: skip

    def test_latency_is_recorded_but_not_gated_at_zero(self) -> None:
        passed, _ = apply_thresholds(
            {"critical_fact_recall": 1.0, "dose_accuracy": 1.0, "unsupported_rate": 0.0,
             "stop_to_note_p95_ms": 10_000_000.0},
            THRESHOLDS,
        )  # fmt: skip
        assert passed


def _section_answers(case: dict[str, Any]) -> dict[str, str]:
    bodies: dict[str, str] = {}
    titles = {h["title"]: h["key"] for h in case["transcript"]["headings"]}
    for chunk in case["reference"]["referenceNote"].split("## ")[1:]:
        title, _, body = chunk.partition("\n")
        bodies[titles[title.strip()]] = body.strip()
    return bodies


def _reference_generator(case: dict[str, Any], *, drop: tuple[str, ...] = ()):
    bodies = _section_answers(case)
    titles = {h["key"]: h["title"] for h in case["transcript"]["headings"]}

    def body(key: str) -> str:
        text = bodies.get(key, "Not discussed")
        for fragment in drop:
            text = text.replace(fragment, "")
        return text

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        note = "\n\n".join(f"## {titles[k]}\n{body(k)}" for k in request.section_keys)
        return NoteCallResult(
            content=json.dumps({"case_note": note, "redactions": [], "sources": []}),
            provider="stub",
            model="stub-model",
        )

    return generate


class TestRunner:
    @pytest.mark.asyncio
    async def test_executes_plans_and_passes_on_complete_notes(self) -> None:
        ids = ["me01-chest-tightness-metformin", "me11-pneumonia-long-template"]
        generators = {cid: _reference_generator(CASES[cid]) for cid in ids}

        async def generate(request: NoteCallRequest) -> NoteCallResult:
            # Each plan's shared prefix carries its own transcript.
            cid = ids[0] if "metformin" in request.user else ids[1]
            return await generators[cid](request)

        inputs = [
            NoteCompletenessCaseInput(
                case_id=cid, reference=_reference(CASES[cid]), plan=_plan_for(CASES[cid])
            )
            for cid in ids
        ]
        run = await run_note_completeness(inputs, thresholds=THRESHOLDS, generate=generate)
        assert run.passed, run.failures
        assert [s.case_id for s in run.case_scores] == ids
        assert all(s.latency_ms is not None and s.latency_ms >= 0 for s in run.case_scores)
        assert run.aggregates["critical_fact_recall"] == 1.0
        assert run.aggregates["cases"] == 2
        # The sixteen-section case ran as two section groups.
        assert run.case_scores[1].budget_strategy == "section_groups"
        assert run.case_scores[1].call_count == 2

    @pytest.mark.asyncio
    async def test_fails_when_the_model_drops_a_fact(self) -> None:
        cid = "me02-cellulitis-penicillin-allergy"
        case = CASES[cid]
        run = await run_note_completeness(
            [
                NoteCompletenessCaseInput(
                    case_id=cid, reference=_reference(case), plan=_plan_for(case)
                )
            ],
            thresholds=THRESHOLDS,
            generate=_reference_generator(
                case,
                drop=(
                    " Allergic to penicillin with rash and lip swelling [S4].",
                    "; penicillin avoided because of the allergy [S4]",
                ),
            ),
        )
        assert not run.passed
        assert any(f.startswith("critical_fact_recall") for f in run.failures)

    @pytest.mark.asyncio
    async def test_a_failing_call_is_a_failed_case_never_a_skipped_one(self) -> None:
        cid = "me05-uti-culture-nitrofurantoin"
        case = CASES[cid]

        async def broken(request: NoteCallRequest) -> NoteCallResult:
            raise RuntimeError("engine down")

        run = await run_note_completeness(
            [
                NoteCompletenessCaseInput(
                    case_id=cid, reference=_reference(case), plan=_plan_for(case)
                )
            ],
            thresholds=THRESHOLDS,
            generate=broken,
        )
        [score] = run.case_scores
        assert score.status == "error"
        assert score.error == "NotePlanCallFailed"
        assert score.critical_facts_present == 0
        assert not run.passed

    @pytest.mark.asyncio
    async def test_supplied_outputs_are_scored_without_a_generator(self) -> None:
        cid = "me14-three-encounters-warfarin"
        case = CASES[cid]
        run = await run_note_completeness(
            [
                NoteCompletenessCaseInput.model_validate(
                    {
                        "caseId": cid,
                        "reference": case["reference"],
                        "plan": _plan_for(case).to_wire(),
                        "output": {
                            "caseNote": case["reference"]["referenceNote"],
                            "sources": [],
                            "latencyMs": 4200,
                        },
                    }
                )
            ],
            thresholds=THRESHOLDS.model_copy(update={"latency_p95_max_ms": 5000}),
        )
        assert run.passed
        assert run.aggregates["stop_to_note_p95_ms"] == 4200.0


# ------------------------------------------------------------------------------------------------
# The internal eval endpoint, mode note_completeness
# ------------------------------------------------------------------------------------------------

_TOKEN = "shared-secret"


@pytest_asyncio.fixture
async def http() -> AsyncGenerator[AsyncClient, None]:
    app = create_app(settings_override=Settings(service_token=SecretStr(_TOKEN), log_level="debug"))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client


def _endpoint_case(case_id: str, note: str | None = None) -> dict[str, Any]:
    case = CASES[case_id]
    return {
        "caseId": case_id,
        "reference": case["reference"],
        "plan": _plan_for(case).to_wire(),
        "output": {
            "caseNote": case["reference"]["referenceNote"] if note is None else note,
            "sources": [],
            "latencyMs": 3000,
        },
    }


_ENDPOINT_THRESHOLDS = {
    "criticalFactRecallMin": 1.0,
    "doseAccuracyMin": 1.0,
    "unsupportedRateMax": 0.02,
    "latencyP95MaxMs": 0,
}


class TestEvalEndpoint:
    @pytest.mark.asyncio
    async def test_scores_supplied_notes_and_returns_case_score_rows(self, http) -> None:
        resp = await http.post(
            "/api/v1/internal/eval/run",
            headers={"X-Service-Token": _TOKEN},
            json={
                "mode": "note_completeness",
                "promptTemplateId": "tmpl-1",
                "noteCompleteness": {
                    "version": "v1",
                    "name": "Multi-encounter note completeness v1",
                    "tenantId": "tenant-golden",
                    "thresholds": _ENDPOINT_THRESHOLDS,
                    "cases": [
                        _endpoint_case("me01-chest-tightness-metformin"),
                        _endpoint_case("me09-copd-long-codeine-allergy"),
                    ],
                },
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["passed"] is True
        assert body["mode"] == "note_completeness"
        assert body["golden_set_version"] == "v1"
        assert body["promptTemplateId"] == "tmpl-1"
        assert body["thresholds"]["critical_fact_recall"] == 1.0
        metrics = {(row["caseId"], row["metric"]) for row in body["caseScores"]}
        assert ("me09-copd-long-codeine-allergy", "critical_fact_recall") in metrics
        assert ("me01-chest-tightness-metformin", "stop_to_note_ms") in metrics
        assert all(row["judgeModel"] == "note-completeness" for row in body["caseScores"])

    @pytest.mark.asyncio
    async def test_a_dropped_fact_fails_the_gate(self, http) -> None:
        case = CASES["me02-cellulitis-penicillin-allergy"]
        note = (
            case["reference"]["referenceNote"]
            .replace(" Allergic to penicillin with rash and lip swelling [S4].", "")
            .replace("; penicillin avoided because of the allergy [S4]", "")
        )
        resp = await http.post(
            "/api/v1/internal/eval/run",
            headers={"X-Service-Token": _TOKEN},
            json={
                "mode": "note_completeness",
                "noteCompleteness": {
                    "version": "v1",
                    "tenantId": "tenant-golden",
                    "thresholds": _ENDPOINT_THRESHOLDS,
                    "cases": [_endpoint_case(case["caseId"], note)],
                },
            },
        )
        assert resp.status_code == 200
        assert resp.json()["passed"] is False

    @pytest.mark.asyncio
    async def test_thresholds_are_required_never_defaulted(self, http) -> None:
        resp = await http.post(
            "/api/v1/internal/eval/run",
            headers={"X-Service-Token": _TOKEN},
            json={
                "mode": "note_completeness",
                "noteCompleteness": {
                    "version": "v1",
                    "tenantId": "tenant-golden",
                    "cases": [_endpoint_case("me01-chest-tightness-metformin")],
                },
            },
        )
        assert resp.status_code == 422


def test_golden_cases_name_the_lm_studio_engine_text_serves() -> None:
    """TASK-1047 V6: apps/text registers LM Studio as ``lm-studio``; the fixture said ``lmstudio`` and
    every live golden-set call that reached generation answered 404 PROVIDER_NOT_FOUND."""
    from harness.eval.note_completeness.runner import GOLDEN_FIXTURE

    cases = json.loads(GOLDEN_FIXTURE.read_text())["cases"]
    assert {case["transcript"]["conditions"]["model"]["provider"] for case in cases} == {
        "lm-studio"
    }
