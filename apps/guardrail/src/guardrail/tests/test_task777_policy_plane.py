"""TASK-777 Lane A — policy-plane correctness.

Covers the four findings the audit recorded against `apps/guardrail`'s config
resolution (ticket §2.2):

* **A-1** identical in-flight config reads coalesce into ONE database load;
* **A-2** invalidation is the propagation path — TTL is only the backstop;
* **A-3/A-5** verdict-deciding POLICY (criteria, confidence floor, thresholds)
  resolves through the SAME two-tier `tenant → SYSTEM` cascade as the selection
  it belongs to, with a `failMode` DECLARED per key;
* **A-4** an unparseable judge response is *undetermined*, never a verdict
  synthesised from a hardcoded keyword taxonomy.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.policy import FAIL_CLOSED, FAIL_OPEN_TO_DEFAULT, GuardrailPolicy
from guardrail.core.tenant_config import (
    KEY_MODEL,
    KEY_POLICY,
    KEY_PROVIDER,
    SYSTEM_TENANT_ID,
    TASK_KEY_GUARDRAIL_VALIDATE,
    TenantConfigResolver,
    TenantConfigUnavailableError,
)

TENANT_A = "11111111-1111-1111-1111-111111111111"
TENANT_B = "22222222-2222-2222-2222-222222222222"


class _CountingResolver(TenantConfigResolver):
    """Resolver whose DB layer is a slow, counting in-memory map."""

    def __init__(self, data: dict[str, dict[str, str]], delay: float = 0.02) -> None:
        super().__init__(session_factory=lambda: None)  # type: ignore[arg-type,return-value]
        self._data = data
        self._delay = delay
        self.loads: list[tuple[str, str]] = []

    async def _load_from_db(
        self, tenant_id: str, task_key: str = TASK_KEY_GUARDRAIL_VALIDATE
    ) -> dict[str, str]:
        self.loads.append((tenant_id, task_key))
        await asyncio.sleep(self._delay)
        return dict(self._data.get(tenant_id, {}))


# ---------------------------------------------------------------------------
# A-1 — single-flight / coalescing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_identical_in_flight_config_reads_coalesce_into_one_load() -> None:
    """100 concurrent cold reads for one tenant must cost ONE query, not 100.

    Without this the opening burst of 100 consultation sessions is a thundering
    herd against a `pool_size=5` engine.
    """
    r = _CountingResolver({TENANT_A: {KEY_PROVIDER: "vllm", KEY_MODEL: "m"}})

    results = await asyncio.gather(*(r.resolve(TENANT_A) for _ in range(100)))

    assert all(cfg.model == "m" for cfg in results)
    assert r.loads == [(TENANT_A, TASK_KEY_GUARDRAIL_VALIDATE)]


@pytest.mark.asyncio
async def test_single_flight_does_not_merge_across_tenants() -> None:
    """Coalescing is per `task_key::tenant_id` — never across tenants."""
    r = _CountingResolver(
        {
            TENANT_A: {KEY_PROVIDER: "vllm", KEY_MODEL: "a"},
            TENANT_B: {KEY_PROVIDER: "vllm", KEY_MODEL: "b"},
        }
    )

    a, b = await asyncio.gather(r.resolve(TENANT_A), r.resolve(TENANT_B))

    assert (a.model, b.model) == ("a", "b")
    assert sorted(t for t, _ in r.loads) == sorted([TENANT_A, TENANT_B])


@pytest.mark.asyncio
async def test_single_flight_propagates_a_failure_to_every_waiter() -> None:
    """A coalesced load that fails must not resolve some waiters and fail others."""

    class _Boom(_CountingResolver):
        async def _load_from_db(self, tenant_id, task_key=TASK_KEY_GUARDRAIL_VALIDATE):
            self.loads.append((tenant_id, task_key))
            await asyncio.sleep(0.01)
            raise RuntimeError("db down")

    r = _Boom({})
    # A DB error is a FAILED READ, not an absent row (TASK-799 F-08), so every
    # waiter sees the same raise — and only one attempt was made.
    results = await asyncio.gather(
        *(r.resolve(TENANT_A) for _ in range(20)), return_exceptions=True
    )
    assert all(isinstance(e, TenantConfigUnavailableError) for e in results)
    assert len(r.loads) == 1  # one coalesced attempt; no SYSTEM widening after a failure


# ---------------------------------------------------------------------------
# A-2 — invalidation is the propagation path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invalidate_tenant_drops_only_that_tenants_entries() -> None:
    r = _CountingResolver(
        {
            TENANT_A: {KEY_PROVIDER: "vllm", KEY_MODEL: "a"},
            TENANT_B: {KEY_PROVIDER: "vllm", KEY_MODEL: "b"},
        },
        delay=0.0,
    )
    await r.resolve(TENANT_A)
    await r.resolve(TENANT_B)
    assert len(r.loads) == 2

    r.invalidate(tenant_id=TENANT_A)

    await r.resolve(TENANT_A)
    await r.resolve(TENANT_B)
    # A reloaded once; B still served from cache.
    assert len(r.loads) == 3
    assert r.loads[-1][0] == TENANT_A


@pytest.mark.asyncio
async def test_invalidate_all_drops_every_entry() -> None:
    r = _CountingResolver({TENANT_A: {KEY_MODEL: "a"}}, delay=0.0)
    await r.resolve(TENANT_A)
    r.invalidate()
    await r.resolve(TENANT_A)
    assert len(r.loads) == 2


# ---------------------------------------------------------------------------
# A-3 / A-5 — policy is CONFIG, resolved tenant-first, failMode declared per key
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_policy_blob_resolves_through_the_two_tier_cascade() -> None:
    r = _CountingResolver(
        {
            TENANT_A: {
                KEY_MODEL: "m",
                KEY_POLICY: json.dumps({"medicalValidationCriteria": "tenant criteria"}),
            },
            SYSTEM_TENANT_ID: {
                KEY_MODEL: "m",
                KEY_POLICY: json.dumps({"medicalValidationCriteria": "system criteria"}),
            },
        },
        delay=0.0,
    )

    tenant_cfg = await r.resolve(TENANT_A)
    system_cfg = await r.resolve(TENANT_B)  # no rows -> widens to SYSTEM

    assert tenant_cfg.policy == {"medicalValidationCriteria": "tenant criteria"}
    assert system_cfg.policy == {"medicalValidationCriteria": "system criteria"}
    assert system_cfg.source_tenant_id == SYSTEM_TENANT_ID


def test_criteria_is_fail_closed_and_has_no_code_default() -> None:
    """The safety criteria text decides a verdict, so absence is 503 — not a literal."""
    policy = GuardrailPolicy.from_blob(None, source_tenant_id=SYSTEM_TENANT_ID)

    assert policy.fail_mode("medicalValidationCriteria") is FAIL_CLOSED
    with pytest.raises(GuardrailUndeterminedError):
        policy.require_criteria("medicalValidationCriteria")


def test_configured_criteria_is_returned_verbatim() -> None:
    policy = GuardrailPolicy.from_blob(
        {"medicalValidationCriteria": "  judge like so  "},
        source_tenant_id=TENANT_A,
    )
    assert policy.require_criteria("medicalValidationCriteria") == "judge like so"
    assert policy.source_tenant_id == TENANT_A


def test_tuning_knobs_fail_open_to_their_declared_default() -> None:
    policy = GuardrailPolicy.from_blob({}, source_tenant_id=SYSTEM_TENANT_ID)

    assert policy.fail_mode("judgeMinConfidence") is FAIL_OPEN_TO_DEFAULT
    assert policy.judge_min_confidence == pytest.approx(0.75)

    tightened = GuardrailPolicy.from_blob(
        {"judgeMinConfidence": 0.9}, source_tenant_id=TENANT_A
    )
    assert tightened.judge_min_confidence == pytest.approx(0.9)


def test_out_of_range_policy_value_falls_back_rather_than_corrupting_the_gate() -> None:
    """A bad tuning value is ignored (declared open-to-default), never applied."""
    policy = GuardrailPolicy.from_blob(
        {"judgeMinConfidence": 7.5}, source_tenant_id=TENANT_A
    )
    assert policy.judge_min_confidence == pytest.approx(0.75)


def test_every_declared_key_has_a_declared_fail_mode() -> None:
    """Fail posture is DECLARED per key, not decided ad hoc at the call site."""
    for key in GuardrailPolicy.DECLARED_KEYS:
        assert GuardrailPolicy.fail_mode(key) in (FAIL_CLOSED, FAIL_OPEN_TO_DEFAULT)


# ---------------------------------------------------------------------------
# A-4 / A-6 — no fabricated verdicts, and the confidence floor actually bites
# ---------------------------------------------------------------------------


class _StubResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class _StubHttp:
    def __init__(self, payload: dict) -> None:
        self._payload = payload
        self.bodies: list[dict] = []

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: A002
        self.bodies.append(json or {})
        return _StubResponse(self._payload)


def _judge(payload: dict, **kwargs):
    from guardrail.services.external_text_client import TextJudgeClient

    http = _StubHttp(payload)
    client = TextJudgeClient(
        base_url="http://text",
        http_client=http,
        service_token="",
        provider="vllm",
        model="m",
        tenant_id=TENANT_A,
        criteria="you are a medical context validator",
        **kwargs,
    )
    return client, http


@pytest.mark.asyncio
async def test_unparseable_judge_response_is_undetermined_not_a_keyword_guess() -> None:
    """A-4. The deleted `_keyword_verdict` scored the RAW MODEL OUTPUT against a
    hardcoded 40-term taxonomy — so prose containing two clinical words passed the
    gate with no model having judged it. That is a hardcoded taxonomy AND an
    injection bypass. Non-JSON is now simply *undetermined*.
    """
    client, _ = _judge({"content": "Sure! The patient's diagnosis is unremarkable."})

    with pytest.raises(GuardrailUndeterminedError):
        await client.validate_medical_context("some note")


@pytest.mark.asyncio
async def test_no_keyword_taxonomy_survives_in_the_module() -> None:
    import guardrail.services.external_text_client as mod

    assert not hasattr(mod, "_MEDICAL_KEYWORDS")
    assert not hasattr(mod, "MEDICAL_VALIDATION_CRITERIA")
    assert not hasattr(mod.TextJudgeClient, "_keyword_verdict")


@pytest.mark.asyncio
async def test_verdict_below_the_confidence_floor_is_undetermined() -> None:
    """A-6. The floor used to be LOGGED and then ignored — the verdict was returned
    as if it had cleared it."""
    client, _ = _judge(
        {"content": json.dumps({"is_medical": True, "confidence": 0.10})},
        min_confidence=0.75,
    )

    with pytest.raises(GuardrailUndeterminedError):
        await client.validate_medical_context("some note")


@pytest.mark.asyncio
async def test_verdict_at_or_above_the_floor_is_returned() -> None:
    client, _ = _judge(
        {"content": json.dumps({"is_medical": True, "confidence": 0.80})},
        min_confidence=0.75,
    )
    result = await client.validate_medical_context("some note")
    assert result["is_medical"] is True


@pytest.mark.asyncio
async def test_criteria_reaches_the_wire_as_the_system_prompt() -> None:
    client, http = _judge({"content": json.dumps({"is_medical": True, "confidence": 1.0})})
    await client.validate_medical_context("some note")
    assert http.bodies[0]["system_prompt"] == "you are a medical context validator"
