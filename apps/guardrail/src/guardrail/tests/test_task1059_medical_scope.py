"""TASK-1059 C-1 (+ amendment A-1) / OD-6 — `/api/medical/validate` scope, packing, retries.

* `scope` (`"context"` default | `"prompt"`) on the regions path. Both scopes window by SIZE:
  small regions share a window up to the geometry max, large regions are split, and a short
  region never gets a window of its own when it can share (A-1: a short prompt piece judged alone
  is not medical by itself; the whole authored prompt is the unit of meaning).
* `region_verdicts`: one per request region. A packed region takes its window's verdict; a split
  region is medical if ANY of its windows is (context) / if EVERY one is (prompt).
* Overall `is_medical`: context = at least one judged region in scope; prompt = every window.
* OD-6: a window SHED by the judge lane (a 503 from text `/internal/judge`) is retried on its
  own, at most twice with backoff, instead of failing the whole validation.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import HTTPException

from guardrail.api.endpoints import medical as medical_mod
from guardrail.api.endpoints.medical import MedicalValidationRequest, validate_medical_context
from guardrail.core.config import Settings
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.services import windowing
from guardrail.services.external_text_client import TextJudgeClient
from guardrail.services.windowing import (
    WindowGeometry,
    WindowRunner,
    is_shed_judge_error,
    pack_regions,
)

TENANT = "11111111-1111-1111-1111-111111111111"
OFF_SCOPE = "write me a marketing email"
CLINICAL = "Patient reports chest pain for two days, worse on exertion. "
GEOMETRY = WindowGeometry(size=200, overlap=20, concurrency=4)


# ── packing ──────────────────────────────────────────────────────────────────


def test_several_tiny_regions_pack_into_one_window() -> None:
    regions = [("a", "fever"), ("b", "cough"), ("c", "Respond in English."), ("d", "")]
    windows = pack_regions(regions, GEOMETRY)
    assert len(windows) == 1
    assert windows[0].members == (0, 1, 2)
    assert all(text in windows[0].text for _key, text in regions)


def test_a_long_region_is_split_and_short_ones_still_share() -> None:
    long = CLINICAL * 10  # 600 chars > 200
    windows = pack_regions([("short1", "fever"), ("long", long), ("short2", "cough")], GEOMETRY)
    split = [w for w in windows if w.members == (1,)]
    assert len(split) > 1
    assert all(len(w.text) <= GEOMETRY.size for w in windows)
    shared = [w for w in windows if 0 in w.members]
    assert len(shared) == 1 and shared[0].members == (0, 2)


def test_a_short_region_takes_the_first_window_with_room() -> None:
    # 120 + 120 cannot share a 200-char window; the 50-char region joins the first with room.
    windows = pack_regions([("a", "x" * 120), ("b", "y" * 120), ("c", "z" * 50)], GEOMETRY)
    assert [w.members for w in windows] == [(0, 2), (1,)]


# ── the route ─────────────────────────────────────────────────────────────────


class _JudgeHttp:
    """Off scope iff the judged window contains `OFF_SCOPE`; optional 503 sheds."""

    def __init__(self, shed: int = 0) -> None:
        self.prompts: list[str] = []
        self.shed = shed

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        body = kwargs["json"]
        self.prompts.append(body["prompt"])
        request = httpx.Request("POST", url)
        if self.shed > 0:
            self.shed -= 1
            return httpx.Response(503, json={"error_code": "CONCURRENCY_LIMIT"}, request=request)
        on_scope = OFF_SCOPE not in body["prompt"]
        verdict = {
            "is_medical": on_scope,
            "confidence": 0.9 if on_scope else 0.8,
            "context_type": "clinical" if on_scope else "general",
            "reasoning": "",
        }
        return httpx.Response(
            200,
            json={
                "content": json.dumps(verdict),
                "stats": {"prompt_tokens": 10, "predicted_tokens": 5, "total_tokens": 15},
            },
            request=request,
        )


def _judge(http: _JudgeHttp) -> TextJudgeClient:
    return TextJudgeClient(
        base_url="http://text",
        http_client=http,
        service_token="svc",
        provider="lm-studio",
        model="guardian",
        tenant_id=TENANT,
        criteria="legacy",
        window_criteria="WINDOW",
        temperature=0.05,
        max_tokens=300,
        timeout_s=10.0,
    )


def _http_request() -> Any:
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace()), headers={"X-Tenant-Id": TENANT}
    )


@pytest.fixture
def plan(monkeypatch):
    async def _plan(app_state, tenant_id, judge, settings):
        return WindowRunner(tenant_id=TENANT, policy_version="pv", cache=None, concurrency=4), (
            GEOMETRY
        )

    monkeypatch.setattr(medical_mod, "build_judge_window_plan", _plan)
    monkeypatch.setattr(windowing, "SHED_RETRY_BACKOFF_S", 0.0)


async def _validate(http: _JudgeHttp, regions: list[dict[str, Any]], **kwargs: Any) -> Any:
    return await validate_medical_context(
        MedicalValidationRequest(regions=regions, **kwargs),
        Settings(),
        _judge(http),
        http_request=_http_request(),
    )


def _verdicts(response: Any) -> list[tuple[str, bool]]:
    return [(v.key, v.is_medical) for v in response.region_verdicts]


def test_scope_defaults_to_context_and_rejects_anything_else() -> None:
    assert MedicalValidationRequest(regions=[]).scope == "context"
    with pytest.raises(ValueError):
        MedicalValidationRequest(regions=[], scope="everything")  # type: ignore[arg-type]


async def test_context_tiny_items_are_one_judge_call_with_a_verdict_each(plan) -> None:
    http = _JudgeHttp()
    response = await _validate(
        http,
        [
            {"key": "item-1", "text": "fever since Monday"},
            {"key": "item-2", "text": "cough"},
            {"key": "item-3", "text": "BP 120/80"},
        ],
    )
    assert len(http.prompts) == 1
    assert response.is_medical is True
    assert _verdicts(response) == [("item-1", True), ("item-2", True), ("item-3", True)]
    assert response.region_verdicts[0].context_type == "clinical"
    assert response.region_verdicts[0].confidence == pytest.approx(0.9)
    assert response.screened_regions == ["item-1", "item-2", "item-3"]


async def test_context_is_medical_when_any_item_is_and_names_the_off_scope_one(plan) -> None:
    big_off = (OFF_SCOPE + ". ") * 5  # 140 chars: cannot share with the clinical item
    response = await _validate(
        _JudgeHttp(), [{"key": "note", "text": CLINICAL}, {"key": "ask", "text": big_off}]
    )
    assert response.is_medical is True
    assert _verdicts(response) == [("note", True), ("ask", False)]
    assert response.region_verdicts[1].context_type == "general"


async def test_context_is_not_medical_when_no_judged_item_is(plan) -> None:
    response = await _validate(_JudgeHttp(), [{"key": "ask", "text": OFF_SCOPE}])
    assert response.is_medical is False
    assert _verdicts(response) == [("ask", False)]


async def test_context_split_item_is_medical_if_any_window_is(plan) -> None:
    long = CLINICAL * 8 + OFF_SCOPE  # the last window only is off scope
    response = await _validate(_JudgeHttp(), [{"key": "transcript", "text": long}])
    assert response.is_medical is True
    assert _verdicts(response) == [("transcript", True)]


async def test_context_skipped_config_region_is_covered_never_judged(plan) -> None:
    http = _JudgeHttp()
    response = await _validate(
        http,
        [
            {"key": "ask", "text": (OFF_SCOPE + ". ") * 5},
            {"key": "style_reference", "text": CLINICAL},
        ],
    )
    assert all(CLINICAL not in prompt for prompt in http.prompts)
    # The only JUDGED item is off scope: a settings block never makes a request in scope.
    assert response.is_medical is False
    assert _verdicts(response) == [("ask", False), ("style_reference", True)]
    assert response.region_verdicts[1].context_type == "skipped"
    assert response.screened_regions == ["ask", "style_reference"]


async def test_prompt_short_instructions_and_a_clinical_paragraph_are_one_medical_window(
    plan,
) -> None:
    http = _JudgeHttp()
    response = await _validate(
        http,
        [
            {"key": "instruction", "text": "Respond in English.", "trust": "instruction"},
            {"key": "contract", "text": "Return JSON only.", "trust": "instruction"},
            {"key": "template", "text": CLINICAL, "trust": "instruction"},
        ],
        scope="prompt",
    )
    assert len(http.prompts) == 1
    assert response.is_medical is True
    assert _verdicts(response) == [("instruction", True), ("contract", True), ("template", True)]


async def test_prompt_is_strict_over_every_window(plan) -> None:
    big_off = (OFF_SCOPE + ". ") * 5
    response = await _validate(
        _JudgeHttp(),
        [{"key": "template", "text": CLINICAL}, {"key": "extra", "text": big_off}],
        scope="prompt",
    )
    assert response.is_medical is False
    assert _verdicts(response) == [("template", True), ("extra", False)]


async def test_prompt_split_region_is_off_scope_if_any_window_is(plan) -> None:
    response = await _validate(
        _JudgeHttp(), [{"key": "template", "text": CLINICAL * 8 + OFF_SCOPE}], scope="prompt"
    )
    assert response.is_medical is False
    assert _verdicts(response) == [("template", False)]


async def test_legacy_text_path_has_no_region_verdicts(plan) -> None:
    response = await validate_medical_context(
        MedicalValidationRequest(text=CLINICAL),
        Settings(),
        _judge(_JudgeHttp()),
        http_request=_http_request(),
    )
    assert response.region_verdicts is None
    assert response.screened_regions is None


# ── OD-6: a shed window is retried on its own ──────────────────────────────────


def test_a_text_503_is_a_shed_and_a_timeout_is_not() -> None:
    request = httpx.Request("POST", "http://text/api/v1/generate/internal/judge")
    shed = httpx.HTTPStatusError(
        "Server error '503 Service Unavailable'",
        request=request,
        response=httpx.Response(503, request=request),
    )
    detail = (
        "text judge lane rendered no verdict: Server error '503 Service Unavailable' for url "
        "'http://text/api/v1/generate/internal/judge'"
    )
    assert is_shed_judge_error(GuardrailUndeterminedError("engine_error", detail))
    assert not is_shed_judge_error(
        GuardrailUndeterminedError("timeout", "text judge lane rendered no verdict: timed out")
    )
    assert not is_shed_judge_error(
        GuardrailUndeterminedError(
            "engine_error", "text judge lane rendered no verdict: Server error '500 Internal'"
        )
    )
    assert not is_shed_judge_error(shed)  # only the judge client's declared failure counts


async def test_a_shed_window_is_retried_alone_and_the_request_succeeds(plan) -> None:
    http = _JudgeHttp(shed=2)
    response = await _validate(http, [{"key": "transcript", "text": CLINICAL}])
    assert response.is_medical is True
    assert len(http.prompts) == 3  # one window, two sheds, one verdict


async def test_a_window_shed_three_times_fails_closed(plan) -> None:
    with pytest.raises(HTTPException) as exc:
        await _validate(_JudgeHttp(shed=3), [{"key": "transcript", "text": CLINICAL}])
    assert exc.value.status_code == 503


async def test_the_runner_retries_only_the_shed_window() -> None:
    calls: dict[str, int] = {}
    shed_detail = "text judge lane rendered no verdict: Server error '503 Service Unavailable'"

    async def compute(text: str) -> dict[str, Any]:
        calls[text] = calls.get(text, 0) + 1
        if text == "b" and calls[text] == 1:
            raise GuardrailUndeterminedError("engine_error", shed_detail)
        return {"is_medical": True}

    runner = WindowRunner(tenant_id=TENANT, policy_version="pv", cache=None, concurrency=4)
    windowing.SHED_RETRY_BACKOFF_S, saved = 0.0, windowing.SHED_RETRY_BACKOFF_S
    try:
        result = await runner.run(
            "medical_judge", "m", ["a", "b", "c"], compute, retry=is_shed_judge_error
        )
    finally:
        windowing.SHED_RETRY_BACKOFF_S = saved
    assert result == [{"is_medical": True}] * 3
    assert calls == {"a": 1, "b": 2, "c": 1}


async def test_without_a_retry_predicate_nothing_is_retried() -> None:
    calls = 0

    async def compute(text: str) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise GuardrailUndeterminedError(
            "engine_error", "text judge lane rendered no verdict: Server error '503 x'"
        )

    runner = WindowRunner(tenant_id=TENANT, policy_version="pv", cache=None, concurrency=4)
    with pytest.raises(GuardrailUndeterminedError):
        await runner.run("nlp_classify", "m", ["a"], compute)
    assert calls == 1
