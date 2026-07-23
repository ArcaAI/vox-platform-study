"""Tests for the token-guarded synchronous internal eval-run endpoint.

``POST /api/v1/internal/eval/run`` is the apps/api promotion-gate + admin
run-now entrypoint. It wraps :class:`GoldenSetRunner` + ``apply_gate`` over a
golden set whose cases are inlined in the request body, and returns the scores +
the pass/fail gate verdict.

These tests are HERMETIC: a deterministic stub judge is injected on
``app.state.eval_judge`` so no LLM/network/DB/Temporal is touched. They assert
the wiring — token guard, gate verdict, case-count cap, provenance echo — not the
judge's clinical behaviour (covered by the eval unit suite).
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from harness.core.config import Settings
from harness.eval.judge import OutputMode, PDSQI9Judge
from harness.main import create_app

from ..eval._stubs import StubJudgeClient, pdsqi_score_json

_TOKEN = "shared-secret"
_HEADERS = {"X-Service-Token": _TOKEN}


def _golden_set_payload(n: int = 2) -> dict:
    return {
        "version": "v-test",
        "name": "unit-golden",
        "cases": [
            {
                "case_id": f"c{i}",
                "source_documents": [f"transcript {i}: patient reports headache"],
                "generated_note": f"S: headache {i}. A/P: analgesia.",
                "reference_note": f"S: headache {i}. A/P: analgesia.",
            }
            for i in range(n)
        ],
    }


def _build(*, judge_score_overrides: dict | None = None, service_token: str = _TOKEN):
    settings = Settings(service_token=SecretStr(service_token), log_level="debug")
    app = create_app(settings_override=settings)
    # Inject a deterministic score-only judge — hermetic, no network.
    app.state.eval_judge = PDSQI9Judge(
        StubJudgeClient(pdsqi_score_json(**(judge_score_overrides or {})), model="stub-judge"),
        output_mode=OutputMode.SCORE,
    )
    return app, settings


@pytest_asyncio.fixture
async def harness() -> AsyncGenerator[tuple, None]:
    app, settings = _build()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, settings


class TestEvalRun:
    @pytest.mark.asyncio
    async def test_passing_run_returns_scores_and_gate_verdict(self, harness):
        http, _settings = harness
        resp = await http.post(
            "/api/v1/internal/eval/run",
            headers=_HEADERS,
            json={
                "goldenSet": _golden_set_payload(2),
                "promptTemplateId": "tmpl-1",
                "promptVersionNumber": 3,
                "noFaithfulness": True,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        # Gate passed (stub judge emits high scores) + provenance echoed back.
        assert body["passed"] is True
        assert body["failures"] == []
        assert body["golden_set_version"] == "v-test"
        assert body["judge_model"] == "stub-judge"
        assert body["aggregates"]["pdsqi_mean"] >= 4.0
        assert len(body["case_results"]) == 2
        assert body["promptTemplateId"] == "tmpl-1"
        assert body["promptVersionNumber"] == 3
        # Flattened per-(case, metric) rows ready for EvalScore persistence.
        case_scores = body["caseScores"]
        assert len(case_scores) == 2  # pdsqi_mean per case, faithfulness skipped
        assert {r["metric"] for r in case_scores} == {"pdsqi_mean"}
        assert all(r["maxScore"] == 5.0 for r in case_scores)
        assert {r["caseId"] for r in case_scores} == {"c0", "c1"}

    @pytest.mark.asyncio
    async def test_failing_scores_flip_gate_to_blocked(self):
        # accurate=2 (< 4.0 threshold) → gate FAILS, but the endpoint still 200s;
        # the verdict lives in the body so apps/api can persist the run either way.
        app, _settings = _build(judge_score_overrides={"accurate": 2})
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            resp = await http.post(
                "/api/v1/internal/eval/run",
                headers=_HEADERS,
                json={"goldenSet": _golden_set_payload(1), "noFaithfulness": True},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["passed"] is False
        assert any("pdsqi_accurate" in f for f in body["failures"])

    @pytest.mark.asyncio
    async def test_rejects_missing_or_bad_token(self, harness):
        http, _settings = harness
        payload = {"goldenSet": _golden_set_payload(1)}
        missing = await http.post("/api/v1/internal/eval/run", json=payload)
        bad = await http.post(
            "/api/v1/internal/eval/run", headers={"X-Service-Token": "wrong"}, json=payload
        )
        assert missing.status_code == 401
        assert bad.status_code == 401

    @pytest.mark.asyncio
    async def test_case_count_cap_enforced(self, harness):
        # Over the synchronous cap (default 50) → 413, no scoring attempted.
        http, _settings = harness
        resp = await http.post(
            "/api/v1/internal/eval/run",
            headers=_HEADERS,
            json={"goldenSet": _golden_set_payload(51), "noFaithfulness": True},
        )
        assert resp.status_code == 413

    @pytest.mark.asyncio
    async def test_empty_golden_set_is_rejected(self, harness):
        # GoldenSet validation (>=1 case) surfaces as a 422 pydantic error.
        http, _settings = harness
        resp = await http.post(
            "/api/v1/internal/eval/run",
            headers=_HEADERS,
            json={"goldenSet": {"version": "v", "cases": []}},
        )
        assert resp.status_code == 422
