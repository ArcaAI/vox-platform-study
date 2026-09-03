"""Per-call timeout + heartbeat tests for ``run_inferential_sensors``.

A hung judge/guardian HTTP call burned the full 900 s ``start_to_close``
before Temporal retried, ballooning SOAP-note latency. The fix bounds EACH model call
at a per-call wall-clock timeout (``HARNESS_LLM_REQUEST_TIMEOUT_S``); a timed-out call
is transient (retried within the endpoint budget) and, once exhausted, the OWNING
sensor self-degrades via its existing ``degraded_result`` path — never raising into the
activity, never a silent auto-PASS. The activity also heartbeats so Temporal detects a
dead worker / hung attempt at ``heartbeat_timeout`` (60 s) instead of ``start_to_close``.

These run the REAL ``run_inferential_sensors`` body in a Temporal ``ActivityEnvironment``
with the judge / Granite client factories monkeypatched. The judge timeout path is
exercised through the REAL ``_create_with_retry`` (the same wrapper
``OpenAICompatJudgeClient.complete`` uses); the Granite path through the REAL
``governed_request`` driven by a never-responding httpx transport.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from temporalio.testing import ActivityEnvironment

from harness.core.llm_concurrency import reset_endpoint_limiters
from harness.eval.judge.base import JudgeConnectionError
from harness.eval.judge.providers import _create_with_retry
from harness.sensors.inferential.guardrail_screen import GuardrailSafetyScreen
from harness.services.guardrail_client import GuardrailClient
from harness.temporal import activities
from harness.temporal.models import RunInferentialSensorsInput


@pytest.fixture(autouse=True)
def _fast_governor(monkeypatch):
    """Tiny per-call timeout + single attempt + no backoff so the hang tests are fast.

    Tests that need a different bound override ``HARNESS_LLM_REQUEST_TIMEOUT_S`` locally.
    """
    monkeypatch.setenv("HARNESS_LLM_REQUEST_TIMEOUT_S", "0.05")
    monkeypatch.setenv("HARNESS_LLM_MAX_ATTEMPTS", "1")
    monkeypatch.setenv("HARNESS_LLM_BACKOFF_BASE_S", "0")
    monkeypatch.setenv("HARNESS_LLM_BACKOFF_MAX_S", "0")
    monkeypatch.setenv("HARNESS_LLM_BACKOFF_JITTER_S", "0")
    monkeypatch.setenv("HARNESS_LLM_MAX_CONCURRENCY", "2")
    reset_endpoint_limiters()
    yield
    reset_endpoint_limiters()


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


class _StubJudge:
    """Deterministic judge: always ``supported`` (returns immediately, never hangs)."""

    model = "stub-judge"

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        self.calls += 1
        return '{"supported": true}'


class _CreateRetryJudge:
    """Drives the REAL ``_create_with_retry`` with a create that sleeps ``delay_s``.

    This is the production judge call path: ``OpenAICompatJudgeClient.complete`` wraps the
    openai ``create`` in ``_create_with_retry`` identically, then wraps any failure in
    ``JudgeConnectionError``. Exercising the real wrapper here proves the per-call timeout
    aborts a hung judge call without needing a live openai endpoint.
    """

    model = "create-retry-judge"

    def __init__(
        self, *, delay_s: float, retries: int = 0, base_url: str = "http://judge.local/v1"
    ) -> None:
        self._delay_s = delay_s
        self._retries = retries
        self._base_url = base_url
        self.attempts = 0

    async def complete(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        async def _create(**_kw: Any) -> str:
            self.attempts += 1
            await asyncio.sleep(self._delay_s)
            return '{"supported": true}'

        try:
            return await _create_with_retry(
                _create, {}, retries=self._retries, backoff_s=0.0, base_url=self._base_url
            )
        except Exception as exc:  # mirrors OpenAICompatJudgeClient.complete
            raise JudgeConnectionError(f"openai_compat judge call failed: {exc}") from exc


class _FakeGranite:
    """Safety-screen stand-in: canned per-dimension verdicts (returns immediately)."""

    def __init__(self, *, dimensions: dict[str, bool] | None = None) -> None:
        self.model = "screen-fake"
        self._dimensions = dimensions or {}
        self.screened: list[str] = []

    async def screen(self, text: str) -> dict[str, bool]:
        self.screened.append(text)
        return dict(self._dimensions)


class _TimingOutTransport(httpx.AsyncBaseTransport):
    """httpx transport that times out — a wedged peer whose client clock ran out.

    Raises the exception a REAL bounded `httpx.AsyncClient` surfaces rather than
    sleeping: httpx enforces its `timeout=` inside its own transport, so a custom
    transport that merely sleeps would hang forever and prove nothing about harness.
    """

    def __init__(self) -> None:
        self.requests = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests += 1
        raise httpx.ReadTimeout("timed out", request=request)


def _cited_claim_input(**kw: Any) -> RunInferentialSensorsInput:
    """Inferential input whose single claim drives BOTH groundedness (text + transcript
    premise) AND citation_verify (``knowledgeChunkIds`` + a resolvable chunk), so a hung
    judge degrades both judge sensors."""
    base: dict[str, Any] = {
        # The safety screen is a tenant-scoped call into apps/guardrail
        # (`X-Tenant-Id` mandatory), so both workflow call sites now thread
        # the tenant onto this input; without it the safety sensor degrades by design.
        "tenant_id": "11111111-1111-1111-1111-111111111111",
        "note_text": "Patient has hypertension; continue current plan.",
        "transcript_text": "Patient has hypertension.",
        # SYSTEM harness.judge selection the workflow snapshots onto the
        # input; absent ⇒ the pass fails closed before ever building the judge.
        "judge_provider": "openai_compat",
        "judge_model": "stub-judge",
        "citations_map": {
            "claims": [
                {
                    "id": "c-htn",
                    "text": "hypertension",
                    "section": "A",
                    "knowledgeChunkIds": ["kc-1"],
                    "evidence": [{"quote": "hypertension"}],
                }
            ]
        },
        "knowledge_chunks": {"kc-1": "The patient has hypertension."},
    }
    base.update(kw)
    return RunInferentialSensorsInput(**base)


class TestPerCallTimeout:
    @pytest.mark.asyncio
    async def test_hung_judge_call_degrades_judge_sensors_only(self, env, monkeypatch):
        judge = _CreateRetryJudge(delay_s=30)  # never returns within the 0.05s budget
        granite = _FakeGranite(dimensions={"harm": False})
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(activities, "_safety_screen_client", lambda s, t: granite)

        # Outer guard: before the fix the hung call burns ~30s; the per-call timeout must
        # abort it near-instantly. ``wait_for`` makes the RED observable instead of hanging.
        result = await asyncio.wait_for(
            env.run(activities.run_inferential_sensors, _cited_claim_input()), timeout=5.0
        )

        gd = result.guardrail_decisions
        assert gd["groundedness"]["decision"] == "DEGRADED"
        assert gd["citation_verify"]["decision"] == "DEGRADED"
        assert "timeout" in gd["groundedness"]["reason"].lower()
        # Safety used a healthy backend -> real PASS, never silent auto-degrade of others.
        assert gd["safety"]["decision"] == "PASS"
        assert result.degraded is True

    @pytest.mark.asyncio
    async def test_hung_safety_screen_degrades_safety_only(self, env, monkeypatch):
        """A wedged guardrail degrades the SAFETY sensor and nothing else.

        The screen is a peer-service call now, not an LLM call, so it is bounded by the
        client's own httpx timeout rather than the LLM governor's per-call budget — but
        the property that matters is unchanged: one dead backend degrades one sensor.
        """
        transport = _TimingOutTransport()
        screen = GuardrailSafetyScreen(
            GuardrailClient(
                "http://guardrail.test", service_token="", timeout=0.05, transport=transport
            ),
            tenant_id="11111111-1111-1111-1111-111111111111",
        )
        judge = _StubJudge()
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(activities, "_safety_screen_client", lambda s, t: screen)

        result = await asyncio.wait_for(
            env.run(activities.run_inferential_sensors, _cited_claim_input()), timeout=5.0
        )

        gd = result.guardrail_decisions
        assert transport.requests == 1
        assert gd["safety"]["decision"] == "DEGRADED"
        assert "safety screen unavailable" in gd["safety"]["reason"].lower()
        # Judge sensors used a healthy stub -> real results, not degraded.
        assert gd["groundedness"].get("degraded") is not True
        assert gd["citation_verify"].get("degraded") is not True
        assert result.degraded is True

    @pytest.mark.asyncio
    async def test_per_call_timeout_override_lets_finite_call_complete(self, env, monkeypatch):
        # Generous override: a judge call taking 0.05s finishes (NOT cut off) — proving the
        # cutoff honors HARNESS_LLM_REQUEST_TIMEOUT_S rather than a hardcoded constant.
        monkeypatch.setenv("HARNESS_LLM_REQUEST_TIMEOUT_S", "5.0")
        judge = _CreateRetryJudge(delay_s=0.05)
        granite = _FakeGranite(dimensions={"harm": False})
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(activities, "_safety_screen_client", lambda s, t: granite)

        result = await asyncio.wait_for(
            env.run(activities.run_inferential_sensors, _cited_claim_input()), timeout=5.0
        )

        gd = result.guardrail_decisions
        assert gd["groundedness"].get("degraded") is not True
        assert gd["citation_verify"].get("degraded") is not True
        assert result.degraded is False


class TestHeartbeat:
    @pytest.mark.asyncio
    async def test_emits_heartbeats_during_pass(self, env, monkeypatch):
        monkeypatch.setattr(activities, "_HEARTBEAT_INTERVAL_S", 0.01, raising=False)
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
        monkeypatch.setattr(
            activities,
            "_safety_screen_client",
            lambda s, t: _FakeGranite(dimensions={"harm": False}),
        )
        beats: list[tuple] = []
        env.on_heartbeat = lambda *args: beats.append(args)

        result = await env.run(activities.run_inferential_sensors, _cited_claim_input())

        assert result.degraded is False
        # The activity heartbeats during the pass so Temporal can detect a hung worker
        # within heartbeat_timeout (60s) rather than start_to_close (900s).
        assert len(beats) >= 1


class _StubNli:
    """Deterministic self-hosted-NLI stub (no model/network) — entailed unless marked."""

    def __init__(self, *, ungrounded_markers: tuple[str, ...] = (), error: Exception | None = None):
        self._markers = ungrounded_markers
        self._error = error

    async def entail(self, premise: str, hypothesis: str) -> bool:
        if self._error is not None:
            raise self._error
        return not any(m in hypothesis.lower() for m in self._markers)


class TestAtomicFactWiring:
    """The DETERMINISTIC atomic-fact verifier runs ALONGSIDE the judge
    sensors inside ``run_inferential_sensors`` when ``HARNESS_ATOMIC_FACT_ENABLED`` is on.

    Wired as a fresh activity-side signal (read at runtime — no workflow command, replay-
    safe): a healthy pass emits an ``atomic_fact`` guardrail decision; a degraded backend
    degrades that decision (never auto-PASS); default OFF ⇒ the sensor never runs.
    """

    @pytest.mark.asyncio
    async def test_disabled_by_default_no_atomic_fact_signal(self, env, monkeypatch):
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
        monkeypatch.setattr(
            activities,
            "_safety_screen_client",
            lambda s, t: _FakeGranite(dimensions={"harm": False}),
        )
        result = await env.run(activities.run_inferential_sensors, _cited_claim_input())
        assert "atomic_fact" not in result.guardrail_decisions

    @pytest.mark.asyncio
    async def test_enabled_adds_deterministic_atomic_fact_signal(self, env, monkeypatch):
        from harness.core.config import Settings

        monkeypatch.setattr(activities, "get_settings", lambda: Settings(atomic_fact_enabled=True))
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
        monkeypatch.setattr(
            activities,
            "_safety_screen_client",
            lambda s, t: _FakeGranite(dimensions={"harm": False}),
        )
        monkeypatch.setattr(activities, "_atomic_fact_entailer", lambda s: _StubNli())
        result = await env.run(activities.run_inferential_sensors, _cited_claim_input())
        # A grounded note -> atomic_fact PASSes and is a real (non-degraded) gate signal.
        assert result.guardrail_decisions["atomic_fact"]["decision"] == "PASS"
        assert any(r.name == "atomic_fact" for r in result.results)
        assert result.degraded is False

    @pytest.mark.asyncio
    async def test_atomic_fact_backend_error_degrades_never_auto_passes(self, env, monkeypatch):
        from harness.core.config import Settings

        monkeypatch.setattr(activities, "get_settings", lambda: Settings(atomic_fact_enabled=True))
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
        monkeypatch.setattr(
            activities,
            "_safety_screen_client",
            lambda s, t: _FakeGranite(dimensions={"harm": False}),
        )
        monkeypatch.setattr(
            activities,
            "_atomic_fact_entailer",
            lambda s: _StubNli(error=RuntimeError("nli offline")),
        )
        result = await env.run(activities.run_inferential_sensors, _cited_claim_input())
        assert result.guardrail_decisions["atomic_fact"]["decision"] == "DEGRADED"
        assert result.degraded is True
