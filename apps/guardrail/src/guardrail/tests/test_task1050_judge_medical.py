"""TASK-1050 — the medical judge after W2a: response contract unchanged, F5, the combined path.

* `/api/medical/validate` keeps its response model field for field.
* F5 (TASK-1049 §13): the per-window medical judge also skips the `style_reference` block and the
  FC-1 configuration blocks (`document_headings`, `language_name`, …) in every placeholder spelling.
* With an inbound safety-judge lane enabled, the regions path goes through the JudgeRunner, so the
  screen route's identical request shares ONE combined call per window.
* The apps/nlp client sends `library_name` / `threshold` on classify (TASK-1049 Track R) and has the
  new `/guard/judge` call.
"""

from __future__ import annotations

import dataclasses
import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from guardrail.api.endpoints import medical as medical_mod
from guardrail.api.endpoints.medical import (
    MedicalValidationRequest,
    MedicalValidationResponse,
    validate_medical_context,
)
from guardrail.core.config import Settings
from guardrail.core.policy import GuardrailPolicy
from guardrail.core.tenant_config import GuardrailTenantConfig
from guardrail.services.external_nlp_client import JUDGE_PATH, NlpGuardClient
from guardrail.services.external_text_client import TextJudgeClient
from guardrail.services.judge_runner import SingleFlight

TENANT = "11111111-1111-1111-1111-111111111111"


# ── the response contract ──────────────────────────────────────────────────────


def test_the_medical_response_contract_is_unchanged() -> None:
    assert list(MedicalValidationResponse.model_fields) == [
        "is_medical",
        "confidence",
        "context_type",
        "reasoning",
        "matched_keywords",
        "processing_time_ms",
        "request_id",
        "timestamp",
        "error",
        "stats",
        "screened_regions",
    ]
    assert list(MedicalValidationRequest.model_fields) == [
        "text",
        "regions",
        "request_id",
        "include_reasoning",
        "provider_overrides",
    ]


# ── F5: configuration blocks are not judged for medical relevance ─────────────────


@pytest.mark.parametrize(
    "region",
    [
        "style_reference",
        "context_dna_style_text",
        "trigger_context_dna_redaction_rules_text",
        "context_document_headings",
        "trigger_context_document_headings",
        "context_document_heading_list",
        "context_language_name",
        "trigger_context_language_name",
        "language_name",
        "variables_language_name",
        "context_current_department",
        "context_visit_type",
        "context_dna_style_id",
    ],
)
def test_f5_every_configuration_block_is_skipped_by_default(region: str) -> None:
    assert region in GuardrailPolicy.from_blob({}).medical_judge_config_regions


@pytest.mark.parametrize("region", ["transcript", "case_notes", "prior_draft", "user", "system"])
def test_f5_clinical_content_is_still_judged(region: str) -> None:
    assert region not in GuardrailPolicy.from_blob({}).medical_judge_config_regions


# ── the combined path ───────────────────────────────────────────────────────────


@dataclasses.dataclass(frozen=True)
class _Cfg(GuardrailTenantConfig):
    judge: dict[str, Any] | None = None


GRANITE = _Cfg(
    provider="lm-studio",
    model="granite",
    source_tenant_id=TENANT,
    judge={
        "protocol": "criteria_json",
        "lanes": ["medical_validation", "injection_judge", "unsafe_content_judge"],
    },
    policy={
        "medicalValidationCriteria": "WHOLE",
        "medicalWindowScopeCriteria": "WINDOW",
        "injectionJudgeCriteria": "INJECTION",
        "unsafeContentJudgeCriteria": "UNSAFE",
        "judgeTemperature": 0.0,
        "judgeMaxTokens": 120,
    },
)


class _Availability:
    def __init__(self, enabled: set[str]) -> None:
        self.enabled = enabled

    def is_enabled(self, check: str) -> bool:
        return check in self.enabled


class _Resolver:
    def __init__(self, enabled: set[str]) -> None:
        self.enabled = enabled

    async def resolve(self, tenant_id: str, task_key: str) -> Any:
        if task_key in {
            "guardrail.validate",
            "guardrail.judge.injection",
            "guardrail.judge.unsafe_content",
        }:
            return GRANITE
        return _Cfg()

    async def resolve_availability(self, tenant_id: str) -> Any:
        return _Availability(self.enabled)


class _Resp:
    status_code = 200

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _Text:
    def __init__(self, off_scope: str | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.off_scope = off_scope

    async def post(self, url: str, **kwargs: Any) -> _Resp:
        body = kwargs["json"]
        self.calls.append(body)
        schema = body["response_format"]["json_schema"]
        on_scope = not (self.off_scope and self.off_scope in body["prompt"])
        if schema["title"] == "guardrail_medical_context_verdict":
            verdict: dict[str, Any] = {
                "is_medical": on_scope,
                "confidence": 0.9,
                "context_type": "clinical" if on_scope else "general",
                "reasoning": "",
            }
        else:
            verdict = {}
            for lane in schema["required"]:
                if lane == "medical_validation":
                    verdict[lane] = {
                        "is_medical": on_scope,
                        "confidence": 0.9,
                        "context_type": "clinical" if on_scope else "general",
                    }
                else:
                    verdict[lane] = {"safe": True, "confidence": 0.9, "category": "none"}
        return _Resp(
            {
                "content": json.dumps(verdict),
                "provider": "lm-studio",
                "model": "granite",
                "stats": {"prompt_tokens": 10, "predicted_tokens": 4, "total_tokens": 14},
            }
        )


def _state(http: _Text, enabled: set[str]) -> SimpleNamespace:
    return SimpleNamespace(
        tenant_config_resolver=_Resolver(enabled),
        settings=Settings(),
        http_client=http,
        redis=None,
        judge_single_flight=SingleFlight(),
    )


def _guardian(http: _Text) -> TextJudgeClient:
    return TextJudgeClient(
        base_url="http://text",
        http_client=http,
        service_token="",
        provider="lm-studio",
        model="granite",
        tenant_id=TENANT,
        criteria="WHOLE",
        window_criteria="WINDOW",
        temperature=0.0,
        max_tokens=120,
        timeout_s=5.0,
    )


def _http_request(state: SimpleNamespace) -> Any:
    async def _json() -> dict[str, Any]:
        return {}

    return SimpleNamespace(
        app=SimpleNamespace(state=state), headers={"X-Tenant-Id": TENANT}, json=_json
    )


REGIONS = [
    {"key": "system", "text": "Write the SOAP note.", "trust": "instruction"},
    {"key": "transcript", "text": "Patient reports chest pain on exertion.", "trust": "data"},
]


async def test_with_no_safety_lane_enabled_the_medical_judge_is_unchanged() -> None:
    http = _Text()
    response = await validate_medical_context(
        MedicalValidationRequest(regions=REGIONS),
        Settings(),
        _guardian(http),
        http_request=_http_request(_state(http, set())),
    )
    assert response.is_medical is True
    assert response.screened_regions == ["system", "transcript"]
    assert [c["system_prompt"] for c in http.calls] == ["WINDOW", "WINDOW"]


async def test_with_inbound_lanes_on_data_windows_get_one_combined_call() -> None:
    http = _Text()
    response = await validate_medical_context(
        MedicalValidationRequest(regions=REGIONS),
        Settings(),
        _guardian(http),
        http_request=_http_request(_state(http, {"injection_judge", "unsafe_content_judge"})),
    )
    assert response.is_medical is True
    assert response.screened_regions == ["system", "transcript"]
    assert response.stats is not None and response.stats["total_tokens"] == 28
    combined = [c for c in http.calls if '<section id="injection_judge">' in c["system_prompt"]]
    medical_only = [c for c in http.calls if c["system_prompt"] == "WINDOW"]
    assert len(combined) == 1 and "chest pain" in combined[0]["prompt"]  # the data window
    assert (
        len(medical_only) == 1 and "SOAP" in medical_only[0]["prompt"]
    )  # instruction: medical only


async def test_the_combined_path_still_answers_not_medical_and_503() -> None:
    http = _Text(off_scope="chest pain")
    response = await validate_medical_context(
        MedicalValidationRequest(regions=REGIONS, include_reasoning=True),
        Settings(),
        _guardian(http),
        http_request=_http_request(_state(http, {"injection_judge"})),
    )
    assert response.is_medical is False
    assert response.context_type == "general"
    assert response.reasoning == "2 window(s) judged; 1 off scope"

    class _Down(_Text):
        async def post(self, url: str, **kwargs: Any) -> _Resp:
            raise TimeoutError("down")

    down = _Down()
    with pytest.raises(HTTPException) as exc:
        await validate_medical_context(
            MedicalValidationRequest(regions=REGIONS),
            Settings(),
            _guardian(down),
            http_request=_http_request(_state(down, {"injection_judge"})),
        )
    assert exc.value.status_code == 503


# ── apps/nlp client ─────────────────────────────────────────────────────────────


class _Nlp:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.calls: list[tuple[str, dict[str, Any], dict[str, str]]] = []

    async def post(self, url: str, **kwargs: Any) -> Any:
        self.calls.append((url, kwargs["json"], kwargs["headers"]))
        payload = self.payload
        return SimpleNamespace(status_code=200, json=lambda: payload)


def _nlp(http: _Nlp, **kwargs: Any) -> NlpGuardClient:
    return NlpGuardClient(
        base_url="http://nlp",
        service_token="svc",
        http_client=http,  # type: ignore[arg-type]
        tenant_id=TENANT,
        model_id="model-uri",
        **kwargs,
    )


async def test_classify_sends_the_library_and_the_threshold() -> None:
    http = _Nlp({"results": {"safety": "safe"}})
    await _nlp(http, threshold=0.4, library_name="transformers").classify({"safety": {}}, "text")
    _url, body, _headers = http.calls[0]
    assert body["library_name"] == "transformers"
    assert body["threshold"] == 0.4


async def test_classify_without_a_library_sends_none_so_nlp_keeps_gliner2() -> None:
    http = _Nlp({"results": {}})
    await _nlp(http).classify({"safety": {}}, "text")
    assert "library_name" not in http.calls[0][1]


async def test_the_judge_call_carries_the_protocol_and_the_row_parameters() -> None:
    http = _Nlp({"tier": "Safe", "categories": [], "latency_ms": 3})
    result = await _nlp(http).judge(
        protocol="qwen3guard_native",
        mode="response",
        prompt="user turn",
        response="assistant turn",
        max_new_tokens=32,
        temperature=0.0,
    )
    url, body, headers = http.calls[0]
    assert url == f"http://nlp{JUDGE_PATH}" and JUDGE_PATH == "/api/v1/guard/judge"
    assert body == {
        "protocol": "qwen3guard_native",
        "mode": "response",
        "prompt": "user turn",
        "response": "assistant turn",
        "max_new_tokens": 32,
        "temperature": 0.0,
        "tenant_id": TENANT,
        "model_name": "model-uri",
    }
    assert headers["X-Tenant-Id"] == TENANT and headers["X-Service-Token"] == "svc"
    assert result["tier"] == "Safe"


def test_medical_module_keeps_its_imports_for_existing_monkeypatches() -> None:
    # TASK-1047 tests monkeypatch these two names on the module.
    assert hasattr(medical_mod, "build_judge_window_plan")
    assert hasattr(medical_mod, "resolve_screen_policy")
