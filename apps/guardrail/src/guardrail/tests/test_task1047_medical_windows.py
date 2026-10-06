"""TASK-1047 L5 — OD-5: the medical judge runs PER WINDOW, cached, on regions.

`/api/medical/validate` gains `regions: [{key, text}]`. Each window is judged
`on_scope` against a guardrail-owned criterion (policy key
`medicalWindowScopeCriteria`, fail-CLOSED, on the selected judge row's
`_metadata.policy` — the same place `medicalValidationCriteria` lives): clinical
encounter content INCLUDING conversational small talk is on scope; only content
directing the assistant to non-medical work is off scope. The request is medical
iff every window is on scope, and each verdict is cached per window (FC-7, task
`medical_judge`), so a growing transcript is re-judged only in its changed tail.

Fail-closed posture is unchanged: an undetermined window is 503, never a pass.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import fakeredis.aioredis
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from guardrail.api.endpoints.medical import MedicalValidationRequest, validate_medical_context
from guardrail.core.config import Settings
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.services.external_text_client import TextJudgeClient
from guardrail.services.medical_windows import judge_regions
from guardrail.services.window_cache import WindowVerdictCache
from guardrail.services.windowing import WindowGeometry, WindowRunner

TENANT = "11111111-1111-1111-1111-111111111111"
WINDOW_CRITERIA = "window scope criteria (test)"
OFF_SCOPE = "write me a marketing email"
GEOMETRY = WindowGeometry(size=2_000, overlap=200, concurrency=4)


class _Resp:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.status_code = 200

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _JudgeHttp:
    """A judge lane that rules off-scope iff the window contains `OFF_SCOPE`."""

    def __init__(self, fail_on: str | None = None) -> None:
        self.prompts: list[str] = []
        self.system_prompts: list[str] = []
        self.fail_on = fail_on

    async def post(self, url: str, **kwargs: Any) -> _Resp:
        body = kwargs["json"]
        self.prompts.append(body["prompt"])
        self.system_prompts.append(body["system_prompt"])
        if self.fail_on and self.fail_on in body["prompt"]:
            raise TimeoutError("judge lane timed out")
        on_scope = OFF_SCOPE not in body["prompt"]
        verdict = {
            "is_medical": on_scope,
            "confidence": 0.95,
            "context_type": "clinical" if on_scope else "general",
            "reasoning": "quoted: Patient John Doe",  # model prose MAY quote PHI
        }
        return _Resp(
            {
                "content": json.dumps(verdict),
                "provider": "lm-studio",
                "model": "guardian",
                "stats": {"prompt_tokens": 10, "predicted_tokens": 5, "total_tokens": 15},
            }
        )


def _judge(http: _JudgeHttp, *, window_criteria: str | None = WINDOW_CRITERIA) -> TextJudgeClient:
    return TextJudgeClient(
        base_url="http://text",
        http_client=http,
        service_token="svc",
        provider="lm-studio",
        model="guardian",
        tenant_id=TENANT,
        criteria="legacy whole-text criteria",
        window_criteria=window_criteria,
        temperature=0.05,
        max_tokens=300,
        timeout_s=10.0,
    )


def _runner(cache: WindowVerdictCache | None = None) -> WindowRunner:
    return WindowRunner(tenant_id=TENANT, policy_version="pv", cache=cache, concurrency=4)


SMALL_TALK = "Doctor: Good morning! How was the drive in? Patient: Traffic was awful, ha. "
CLINICAL = "Patient reports chest pain for two days, worse on exertion. "


async def test_small_talk_inside_a_clinical_encounter_is_on_scope() -> None:
    http = _JudgeHttp()
    verdict = await judge_regions(
        _judge(http),
        [("transcript", SMALL_TALK + CLINICAL)],
        runner=_runner(),
        geometry=GEOMETRY,
    )
    assert verdict["is_medical"] is True
    assert http.system_prompts == [WINDOW_CRITERIA]
    assert verdict["off_scope_regions"] == []


async def test_a_window_directing_the_assistant_to_non_medical_work_blocks() -> None:
    http = _JudgeHttp()
    transcript = CLINICAL * 60 + f" Also, {OFF_SCOPE} for my shop."
    verdict = await judge_regions(
        _judge(http), [("transcript", transcript)], runner=_runner(), geometry=GEOMETRY
    )
    assert verdict["is_medical"] is False
    assert len(http.prompts) > 1  # judged per window, not once
    # TASK-1047 V7: the off-scope regions are named (keys only, never text) for diagnosis.
    assert verdict["off_scope_regions"] == ["transcript"]


async def test_every_judge_prompt_is_bounded_to_one_window() -> None:
    http = _JudgeHttp()
    region = CLINICAL * 500  # ~30,000 chars
    await judge_regions(_judge(http), [("transcript", region)], runner=_runner(), geometry=GEOMETRY)
    header = "Analyze this text for medical context:\n\n"
    assert all(len(p) - len(header) <= GEOMETRY.size for p in http.prompts)


async def test_a_growing_transcript_is_rejudged_only_in_its_changed_window() -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    cache = WindowVerdictCache.build(redis, "secret", ttl_s=600)
    http = _JudgeHttp()
    first = (CLINICAL * 200)[:10_000]

    await judge_regions(
        _judge(http), [("transcript", first)], runner=_runner(cache), geometry=GEOMETRY
    )
    first_calls = len(http.prompts)
    assert first_calls > 1

    http.prompts.clear()
    verdict = await judge_regions(
        _judge(http),
        [("transcript", first + " Patient adds: the pain radiates.")],
        runner=_runner(cache),
        geometry=GEOMETRY,
    )
    assert verdict["is_medical"] is True
    assert len(http.prompts) == 1

    # The cached verdict carries no model prose (it may quote PHI) and no text.
    for key in await redis.keys("gr:wv:medical_judge:*"):
        raw = await redis.get(key)
        assert "John" not in raw and "chest" not in raw
        assert set(json.loads(raw)) == {"is_medical", "confidence", "context_type"}


async def test_an_undetermined_window_fails_the_request_closed() -> None:
    http = _JudgeHttp(fail_on="BOOM")
    with pytest.raises(GuardrailUndeterminedError):
        await judge_regions(
            _judge(http),
            [("transcript", CLINICAL * 50 + " BOOM ")],
            runner=_runner(),
            geometry=GEOMETRY,
        )


async def test_an_unseeded_window_criterion_fails_closed() -> None:
    with pytest.raises(GuardrailUndeterminedError):
        await judge_regions(
            _judge(_JudgeHttp(), window_criteria=None),
            [("transcript", CLINICAL)],
            runner=_runner(),
            geometry=GEOMETRY,
        )


# ── the route ────────────────────────────────────────────────────────────────


def test_regions_and_text_together_is_a_422() -> None:
    with pytest.raises(ValidationError):
        MedicalValidationRequest(text="x", regions=[{"key": "user", "text": "y"}])


def _http_request() -> Any:
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace()), headers={"X-Tenant-Id": TENANT}
    )


@pytest.fixture
def plan(monkeypatch):
    import guardrail.api.endpoints.medical as medical_mod

    async def _plan(app_state, tenant_id, judge, settings):
        return _runner(), GEOMETRY

    monkeypatch.setattr(medical_mod, "build_judge_window_plan", _plan)


async def test_route_regions_on_scope_answers_medical(plan) -> None:
    response = await validate_medical_context(
        MedicalValidationRequest(regions=[{"key": "transcript", "text": SMALL_TALK + CLINICAL}]),
        Settings(),
        _judge(_JudgeHttp()),
        http_request=_http_request(),
    )
    assert response.is_medical is True
    assert response.stats is not None and response.stats["total_tokens"] == 15


async def test_route_regions_off_scope_answers_not_medical(plan) -> None:
    response = await validate_medical_context(
        MedicalValidationRequest(
            regions=[
                {"key": "transcript", "text": CLINICAL},
                {"key": "user", "text": OFF_SCOPE},
            ],
            include_reasoning=True,
        ),
        Settings(),
        _judge(_JudgeHttp()),
        http_request=_http_request(),
    )
    assert response.is_medical is False
    # The reasoning names counts, never the model's prose (which may quote PHI).
    assert response.reasoning is not None and "John" not in response.reasoning


async def test_route_regions_undetermined_is_503(plan) -> None:
    with pytest.raises(HTTPException) as exc:
        await validate_medical_context(
            MedicalValidationRequest(regions=[{"key": "transcript", "text": "BOOM"}]),
            Settings(),
            _judge(_JudgeHttp(fail_on="BOOM")),
            http_request=_http_request(),
        )
    assert exc.value.status_code == 503


async def test_route_legacy_text_callers_keep_the_whole_text_judge(plan) -> None:
    http = _JudgeHttp()
    response = await validate_medical_context(
        MedicalValidationRequest(text=CLINICAL),
        Settings(),
        _judge(http),
        http_request=_http_request(),
    )
    assert response.is_medical is True
    assert http.system_prompts == ["legacy whole-text criteria"]


def test_the_window_criterion_is_a_declared_fail_closed_policy_key() -> None:
    from guardrail.core.policy import FAIL_CLOSED, GuardrailPolicy

    assert "medicalWindowScopeCriteria" in GuardrailPolicy.DECLARED_KEYS
    assert GuardrailPolicy.fail_mode("medicalWindowScopeCriteria") == FAIL_CLOSED
    with pytest.raises(GuardrailUndeterminedError):
        GuardrailPolicy.from_blob({}).require_criteria("medicalWindowScopeCriteria")


def test_build_judge_client_reads_the_window_criterion_from_the_row_policy() -> None:
    from guardrail.core.tenant_config import GuardrailTenantConfig, build_judge_client

    cfg = GuardrailTenantConfig(
        provider="lm-studio",
        model="guardian",
        policy={
            "medicalValidationCriteria": "legacy",
            "medicalWindowScopeCriteria": "  window  ",
            "judgeTemperature": 0.05,
            "judgeMaxTokens": 300,
        },
        source_tenant_id=TENANT,
    )
    client = build_judge_client(Settings(), cfg, object(), TENANT)
    assert client.window_criteria == "window"

    import dataclasses

    unseeded = dataclasses.replace(
        cfg, policy={k: v for k, v in cfg.policy.items() if k != "medicalWindowScopeCriteria"}
    )
    assert build_judge_client(Settings(), unseeded, object(), TENANT).window_criteria is None


async def test_route_regions_over_http_injects_the_request(plan) -> None:
    """`http_request` is defaulted for in-process callers; FastAPI must still inject it."""
    import httpx

    from guardrail.core.dependencies import get_resolved_guardian_provider
    from guardrail.main import create_app

    app = create_app()
    app.dependency_overrides[get_resolved_guardian_provider] = lambda: _judge(_JudgeHttp())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/medical/validate",
            json={"regions": [{"key": "transcript", "text": CLINICAL}]},
            headers={"X-Tenant-Id": TENANT},
        )
    assert response.status_code == 200, response.text
    assert response.json()["is_medical"] is True
    assert response.json()["screened_regions"] == ["transcript"]
