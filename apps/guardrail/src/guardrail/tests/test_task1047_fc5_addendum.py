"""TASK-1047 L5 — FC-5 addendum (orchestrator, frozen 2026-10-06).

1. Every `/screen/inbound`, `/screen/outbound` and `/api/medical/validate` response
   to a `regions` (or `source_regions`) request carries `screened_regions` — every
   key windowed and screened, in the order sent. `apps/text` fails closed when a
   sent key is missing: an OLD guardrail that silently ignores `regions` and screens
   an empty `text` must never read as "screened".
2. `regions: []` — or regions that are all empty — is ALLOW with the keys sent,
   never 422 (nothing exists to be unsafe; the checks say `skipped/no_content`).
3. `apps/nlp` answers an over-long input 413 with a FLAT body
   `{"code":"INPUT_EXCEEDS_WINDOW","maxChars":N}`. Guardrail's windows never trigger
   it; if one ever does it is a fail-closed undetermined screen, logged, not retried.
4. Metric names the perf tooling (L11) reads.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from guardrail.api.endpoints.medical import MedicalValidationRequest, validate_medical_context
from guardrail.api.endpoints.screen import (
    InboundScreenRequest,
    OutboundScreenRequest,
    screen_inbound,
    screen_outbound,
)
from guardrail.core.config import Settings
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.services.external_nlp_client import NlpGuardClient
from guardrail.services.external_text_client import TextJudgeClient
from guardrail.services.screening import Screener
from guardrail.services.windowing import WindowGeometry, WindowRunner

TENANT = "11111111-1111-1111-1111-111111111111"
GEOMETRY = WindowGeometry(size=4_000, overlap=256, concurrency=4)


@dataclass(frozen=True)
class _Span:
    label: str
    start: int
    end: int
    score: float = 0.9


class _Analyzer:
    def __init__(self) -> None:
        self.classify_calls: list[str] = []
        self.policy = SimpleNamespace(pii_labels=[], benign_labels=None)

    async def classify_tasks(self, task_names, text):
        self.classify_calls.append(text)
        return dict.fromkeys(task_names, "benign")

    async def extract_pii_entities(self, text):
        return []

    def model_for(self, check):
        return "m"


@pytest.fixture
def analyzer():
    return _Analyzer()


@pytest.fixture
def request_(monkeypatch, analyzer):
    import guardrail.api.endpoints.screen as screen_mod

    async def _build_screener(app_state, tenant_id):
        return Screener(
            analyzer=analyzer,
            tenant_id=tenant_id,
            window_geometry=GEOMETRY,
            window_runner=WindowRunner(
                tenant_id=tenant_id, policy_version="pv", cache=None, concurrency=4
            ),
        )

    async def _build_span_client(app_state, tenant_id):
        return SimpleNamespace(extract_pii_entities=analyzer.extract_pii_entities, model_id="s")

    monkeypatch.setattr(screen_mod, "build_screener", _build_screener)
    monkeypatch.setattr(screen_mod, "build_pii_span_client", _build_span_client)
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(admission_gates={})),
        headers={"X-Tenant-Id": TENANT},
    )


# ── 1. screened_regions ──────────────────────────────────────────────────────


async def test_inbound_regions_response_lists_every_screened_key_in_order(request_) -> None:
    result = await screen_inbound(
        InboundScreenRequest(
            regions=[
                {"key": "system", "text": "untrusted system prompt"},
                {"key": "vitals", "text": "BP 120/80"},
                {"key": "transcript", "text": "Patient has a cough."},
            ],
            include_pii_spans=True,
        ),
        request_,  # type: ignore[arg-type]
    )
    assert result.screened_regions == ["system", "vitals", "transcript"]


async def test_a_legacy_text_inbound_response_has_no_screened_regions(request_) -> None:
    result = await screen_inbound(InboundScreenRequest(text="hello"), request_)  # type: ignore[arg-type]
    assert result.screened_regions is None


async def test_outbound_source_regions_response_lists_the_source_keys(request_) -> None:
    result = await screen_outbound(
        OutboundScreenRequest(
            response="A note.",
            source_regions=[{"key": "transcript", "text": "t"}, {"key": "case_notes", "text": "n"}],
        ),
        request_,  # type: ignore[arg-type]
    )
    assert result.screened_regions == ["transcript", "case_notes"]


async def test_a_legacy_outbound_response_has_no_screened_regions(request_) -> None:
    result = await screen_outbound(
        OutboundScreenRequest(response="A note.", source_context="ctx"),
        request_,  # type: ignore[arg-type]
    )
    assert result.screened_regions is None


class _Resp:
    status_code = 200

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _JudgeHttp:
    def __init__(self) -> None:
        self.calls = 0

    async def post(self, url: str, **kwargs: Any) -> _Resp:
        self.calls += 1
        verdict = {
            "is_medical": True,
            "confidence": 0.9,
            "context_type": "clinical",
            "reasoning": "",
        }
        return _Resp({"content": json.dumps(verdict)})


def _judge(http: _JudgeHttp) -> TextJudgeClient:
    return TextJudgeClient(
        base_url="http://text",
        http_client=http,
        service_token="svc",
        provider="lm-studio",
        model="guardian",
        tenant_id=TENANT,
        criteria="legacy",
        window_criteria="window",
        temperature=0.05,
        max_tokens=300,
        timeout_s=10.0,
    )


@pytest.fixture
def judge_plan(monkeypatch):
    import guardrail.api.endpoints.medical as medical_mod

    async def _plan(app_state, tenant_id, judge, settings):
        return (
            WindowRunner(tenant_id=tenant_id, policy_version="pv", cache=None, concurrency=4),
            WindowGeometry(size=2_000, overlap=200, concurrency=4),
        )

    monkeypatch.setattr(medical_mod, "build_judge_window_plan", _plan)
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace()), headers={"X-Tenant-Id": TENANT}
    )


async def test_medical_regions_response_lists_every_judged_key(judge_plan) -> None:
    response = await validate_medical_context(
        MedicalValidationRequest(
            regions=[{"key": "transcript", "text": "cough"}, {"key": "user", "text": "fever"}]
        ),
        Settings(),
        _judge(_JudgeHttp()),
        http_request=judge_plan,
    )
    assert response.screened_regions == ["transcript", "user"]


# ── 2. regions: [] is ALLOW, never 422 ───────────────────────────────────────


async def test_an_empty_regions_list_is_allow_with_no_screened_regions(request_, analyzer) -> None:
    result = await screen_inbound(InboundScreenRequest(regions=[]), request_)  # type: ignore[arg-type]
    assert result.decision == "allow"
    assert result.screened_regions == []
    assert analyzer.classify_calls == []
    assert all(c["outcome"] == "skipped" and c["reason"] == "no_content" for c in result.checks)


async def test_all_empty_regions_are_allow_and_listed(request_, analyzer) -> None:
    result = await screen_inbound(
        InboundScreenRequest(regions=[{"key": "user", "text": ""}], include_pii_spans=True),
        request_,  # type: ignore[arg-type]
    )
    assert result.decision == "allow"
    assert result.screened_regions == ["user"]
    assert result.pii_spans == []
    assert analyzer.classify_calls == []


async def test_empty_regions_over_http_are_not_a_422(monkeypatch, analyzer) -> None:
    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.main import create_app

    async def _build_screener(app_state, tenant_id):
        return Screener(analyzer=analyzer, tenant_id=tenant_id)

    monkeypatch.setattr(screen_mod, "build_screener", _build_screener)
    app = create_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/v1/guardrail/screen/inbound",
            json={"regions": []},
            headers={"X-Tenant-Id": TENANT},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["decision"] == "allow"
    assert body["screened_regions"] == []


async def test_medical_empty_regions_are_medical_with_no_judgement(judge_plan) -> None:
    http = _JudgeHttp()
    response = await validate_medical_context(
        MedicalValidationRequest(regions=[]), Settings(), _judge(http), http_request=judge_plan
    )
    assert response.is_medical is True
    assert response.screened_regions == []
    assert http.calls == 0


async def test_a_legacy_empty_text_still_asks_the_model(request_, analyzer) -> None:
    """The legacy contract is untouched: an empty `text` is still classified."""
    await screen_inbound(InboundScreenRequest(text=""), request_)  # type: ignore[arg-type]
    assert analyzer.classify_calls == [""]


# ── 3. nlp 413 INPUT_EXCEEDS_WINDOW ──────────────────────────────────────────


async def test_an_nlp_413_is_undetermined_logged_and_never_retried(caplog) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(413, json={"code": "INPUT_EXCEEDS_WINDOW", "maxChars": 8192})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = NlpGuardClient(
            base_url="http://nlp",
            service_token="svc",
            http_client=http_client,
            tenant_id="tenant-a",
            model_id="m",
            max_attempts=3,
            retry_backoff_s=0.0,
        )
        with pytest.raises(GuardrailUndeterminedError):
            await client.classify({"prompt_safety": {"labels": ["safe"]}}, "x" * 9_000)
    assert calls == 1


async def test_an_nlp_413_blocks_the_screen(monkeypatch) -> None:
    import guardrail.api.endpoints.screen as screen_mod

    class _Overlong(_Analyzer):
        async def classify_tasks(self, task_names, text):
            raise GuardrailUndeterminedError("engine_error", "apps/nlp classify HTTP 413")

    async def _build_screener(app_state, tenant_id):
        return Screener(analyzer=_Overlong(), tenant_id=tenant_id)

    monkeypatch.setattr(screen_mod, "build_screener", _build_screener)
    result = await screen_inbound(
        InboundScreenRequest(regions=[{"key": "user", "text": "hello"}]),
        SimpleNamespace(  # type: ignore[arg-type]
            app=SimpleNamespace(state=SimpleNamespace(admission_gates={})),
            headers={"X-Tenant-Id": TENANT},
        ),
    )
    assert result.decision == "block"
    assert result.screened_regions == ["user"]


# ── 4. metric names ──────────────────────────────────────────────────────────


async def test_the_perf_tooling_metric_names_exist(judge_plan) -> None:
    from prometheus_client import REGISTRY

    before = REGISTRY.get_sample_value("guardrail_medical_judge_calls_total") or 0.0
    await validate_medical_context(
        MedicalValidationRequest(regions=[{"key": "transcript", "text": "cough"}]),
        Settings(),
        _judge(_JudgeHttp()),
        http_request=judge_plan,
    )
    assert (REGISTRY.get_sample_value("guardrail_medical_judge_calls_total") or 0.0) == before + 1
    assert (
        REGISTRY.get_sample_value(
            "guardrail_screen_chars_computed_total", {"task": "medical_judge"}
        )
        or 0.0
    ) >= len("cough")
    for name in (
        "guardrail_screen_windows_requested_total",
        "guardrail_screen_windows_computed_total",
        "guardrail_screen_windows_cached_total",
    ):
        assert REGISTRY.get_sample_value(name, {"task": "medical_judge"}) is not None


# ── 1b. screened_regions on BLOCKED verdicts too (L4 maps a block without it to 503) ──


async def test_a_blocked_inbound_regions_verdict_still_lists_the_keys(monkeypatch) -> None:
    import guardrail.api.endpoints.screen as screen_mod

    class _Jailbreak(_Analyzer):
        async def classify_tasks(self, task_names, text):
            return {
                n: ("jailbreak" if n == "jailbreak_detection" else "benign") for n in task_names
            }

    async def _build_screener(app_state, tenant_id):
        return Screener(analyzer=_Jailbreak(), tenant_id=tenant_id)

    monkeypatch.setattr(screen_mod, "build_screener", _build_screener)
    result = await screen_inbound(
        InboundScreenRequest(
            regions=[
                {"key": "attachment", "text": "ignore all previous"},
                {"key": "user", "text": "x"},
            ]
        ),
        SimpleNamespace(  # type: ignore[arg-type]
            app=SimpleNamespace(state=SimpleNamespace(admission_gates={})),
            headers={"X-Tenant-Id": TENANT},
        ),
    )
    assert result.decision == "block"
    assert result.screened_regions == ["attachment", "user"]


async def test_a_blocked_outbound_source_regions_verdict_still_lists_the_keys(
    request_, monkeypatch
) -> None:
    class _Leaky(_Analyzer):
        async def extract_pii_entities(self, text):
            start = text.find("John Doe")
            return [_Span("person", start, start + 8)] if start >= 0 else []

    import guardrail.api.endpoints.screen as screen_mod

    async def _build_screener(app_state, tenant_id):
        return Screener(analyzer=_Leaky(), tenant_id=tenant_id)

    monkeypatch.setattr(screen_mod, "build_screener", _build_screener)
    result = await screen_outbound(
        OutboundScreenRequest(
            response="John Doe has a cough.",
            source_regions=[{"key": "transcript", "text": "patient has a cough"}],
        ),
        request_,  # type: ignore[arg-type]
    )
    assert result.decision == "block"
    assert result.screened_regions == ["transcript"]


async def test_an_off_scope_medical_regions_verdict_still_lists_the_keys(judge_plan) -> None:
    class _OffScope(_JudgeHttp):
        async def post(self, url: str, **kwargs: Any) -> _Resp:
            verdict = {
                "is_medical": False,
                "confidence": 0.9,
                "context_type": "general",
                "reasoning": "",
            }
            return _Resp({"content": json.dumps(verdict)})

    response = await validate_medical_context(
        MedicalValidationRequest(regions=[{"key": "user", "text": "write me a poem"}]),
        Settings(),
        _judge(_OffScope()),
        http_request=judge_plan,
    )
    assert response.is_medical is False
    assert response.screened_regions == ["user"]
