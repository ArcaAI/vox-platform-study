"""TASK-799 A.1 (F-02) — the safety sensor DELEGATES its screen to apps/guardrail.

Rule `06-python-services.md`: *"Do not grow a second inference stack."* Before this,
`apps/harness` built an IBM Granite Guardian client and talked to an engine directly,
from a complete engine plane in env (`HARNESS_SAFETY_PROVIDER` / `_BASE_URL` / `_MODEL` /
`_HARM_CRITERIA` — a 7-item clinical risk taxonomy in a JSON env array). `apps/guardrail`
already owns tenant-aware safety policy, the label taxonomy, and the delegation to
text/nlp, and harness already had a guardrail client for the interpreter lane.

These tests pin the THREE properties the migration must not break:

1. the sensor's **degrade path** — a backend outage degrades THAT SENSOR and never
   raises into the durable loop (a `SafetyScreenError`, exactly as `GraniteServiceError`
   did);
2. an **unverifiable** screen never auto-PASSes — an `undetermined` check, or a screen in
   which no check produced a verdict at all, degrades rather than reporting "safe";
3. the `guardrail_decisions["safety"]` map shape that `activities._safety_decision`
   produces is byte-identical to the pre-migration shape.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from harness.sensors.base import SensorContext
from harness.sensors.inferential.guardrail_screen import (
    GuardrailSafetyScreen,
    SafetyScreenError,
)
from harness.sensors.inferential.safety import SafetySensor
from harness.services.guardrail_client import GuardrailClient

TENANT = "11111111-1111-1111-1111-111111111111"


def _check(name: str, outcome: str, model: str = "granite-guard") -> dict[str, Any]:
    return {
        "name": name,
        "outcome": outcome,
        "failMode": "closed",
        "model": model,
        "reason": "",
        "labels": [],
    }


def _screen_response(checks: list[dict[str, Any]], decision: str = "allow") -> dict[str, Any]:
    return {
        "decision": decision,
        "direction": "outbound",
        "reasons": [c["name"] for c in checks if c["outcome"] in ("flag", "undetermined")],
        "checks": checks,
        "tenant_id": TENANT,
        "policy_source_tenant_id": TENANT,
        "sanitization": None,
        "envelope": None,
        "nonce": None,
    }


def _screen(checks: list[dict[str, Any]], *, decision: str = "allow") -> GuardrailSafetyScreen:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json=_screen_response(checks, decision))

    client = GuardrailClient(
        "http://guardrail.test",
        service_token="tok",
        transport=httpx.MockTransport(handler),
    )
    screen = GuardrailSafetyScreen(client, tenant_id=TENANT)
    screen.captured = captured  # type: ignore[attr-defined]
    return screen


class TestScreenMapping:
    @pytest.mark.asyncio
    async def test_flag_is_unsafe_and_pass_is_safe(self) -> None:
        screen = _screen(
            [
                _check("response_safety", "flag"),
                _check("response_toxicity", "pass"),
                _check("response_refusal", "pass"),
            ],
            decision="block",
        )
        assert await screen.screen("a note") == {
            "response_safety": True,
            "response_toxicity": False,
            "response_refusal": False,
        }

    @pytest.mark.asyncio
    async def test_skipped_checks_are_excluded_not_counted_safe(self) -> None:
        """A check that did not run must not inflate the safe fraction."""
        screen = _screen(
            [
                _check("response_safety", "pass"),
                # No source_context is supplied, so guardrail reports pii_leak skipped.
                _check("pii_leak", "skipped"),
                _check("containment_echo", "skipped"),
            ]
        )
        assert await screen.screen("a note") == {"response_safety": False}

    @pytest.mark.asyncio
    async def test_targets_the_outbound_screen_route_with_the_tenant_header(self) -> None:
        screen = _screen([_check("response_safety", "pass")])
        await screen.screen("a note")
        captured = screen.captured  # type: ignore[attr-defined]
        assert captured["url"] == "http://guardrail.test/api/v1/guardrail/screen/outbound"
        # TASK-737: tenant identity is mandatory on every internal tenant-scoped hop.
        assert captured["headers"]["x-tenant-id"] == TENANT
        assert captured["headers"]["x-service-token"] == "tok"
        assert captured["body"]["response"] == "a note"

    @pytest.mark.asyncio
    async def test_model_is_aggregated_from_the_checks_that_answered(self) -> None:
        screen = _screen(
            [
                _check("response_safety", "pass", model="guard-a"),
                _check("response_toxicity", "flag", model="guard-b"),
            ]
        )
        await screen.screen("a note")
        assert screen.model == "guard-a,guard-b"


class TestDegradePathPreserved:
    """A backend outage degrades THAT SENSOR — it never raises into the durable loop."""

    @pytest.mark.asyncio
    async def test_transport_failure_raises_safety_screen_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"detail": "outbound screening failed"})

        client = GuardrailClient(
            "http://guardrail.test",
            service_token="",
            transport=httpx.MockTransport(handler),
        )
        with pytest.raises(SafetyScreenError):
            await GuardrailSafetyScreen(client, tenant_id=TENANT).screen("a note")

    @pytest.mark.asyncio
    async def test_undetermined_check_raises_rather_than_reporting_unsafe(self) -> None:
        """`undetermined` means the check could not RUN — the Granite parse-error analogue."""
        screen = _screen(
            [_check("response_safety", "undetermined"), _check("response_toxicity", "pass")],
            decision="block",
        )
        with pytest.raises(SafetyScreenError):
            await screen.screen("a note")

    @pytest.mark.asyncio
    async def test_no_verdict_at_all_raises_rather_than_auto_passing(self) -> None:
        screen = _screen([_check("pii_leak", "skipped")])
        with pytest.raises(SafetyScreenError):
            await screen.screen("a note")

    @pytest.mark.asyncio
    async def test_missing_tenant_is_a_caller_bug_refused_at_construction(self) -> None:
        client = GuardrailClient("http://guardrail.test", service_token="")
        with pytest.raises(ValueError):
            GuardrailSafetyScreen(client, tenant_id="")

    @pytest.mark.asyncio
    async def test_sensor_degrades_on_a_screen_error(self) -> None:
        class _Boom:
            model = None

            async def screen(self, text: str) -> dict[str, bool]:
                raise SafetyScreenError("guardrail unreachable")

        result = await SafetySensor(_Boom()).arun(  # type: ignore[arg-type]
            SensorContext(note_text="n", transcript_text="t"), judge=None
        )
        assert result.degraded is True
        assert result.passed is False


class TestGuardrailDecisionShapeUnchanged:
    @pytest.mark.asyncio
    async def test_safety_decision_map_keys_are_byte_identical(self) -> None:
        from harness.temporal.activities import _safety_decision

        screen = _screen(
            [_check("response_safety", "flag"), _check("response_toxicity", "pass")],
            decision="block",
        )
        result = await SafetySensor(screen).arun(  # type: ignore[arg-type]
            SensorContext(note_text="n", transcript_text="t"), judge=None
        )
        decision = _safety_decision(result)
        assert set(decision) == {
            "decision",
            "passed",
            "score",
            "unsafe",
            "flaggedDimensions",
            "dimensions",
            "model",
        }
        assert decision["decision"] == "FLAG"
        assert decision["unsafe"] is True
        assert decision["flaggedDimensions"] == ["response_safety"]
        assert decision["dimensions"] == {"response_safety": True, "response_toxicity": False}
        assert decision["score"] == 0.5


class TestEnginePlaneDeleted:
    def test_safety_guard_config_is_gone(self) -> None:
        import harness.core.config as config

        assert not hasattr(config, "SafetyGuardConfig")
        assert "safety" not in config.Settings.model_fields

    def test_granite_client_module_is_gone(self) -> None:
        with pytest.raises(ModuleNotFoundError):
            __import__("harness.sensors.inferential.granite_client")
