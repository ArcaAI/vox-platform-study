"""TASK-829 — the realtime ROUTES: attribution, fail-closed, and the C-5 wire shape.

Handlers are exercised DIRECTLY with a lightweight fake request, matching the
rest of this suite (`test_task777_screen_routes.py`): guardrail's `lifespan`
opens Redis and a job-processor loop, so a `TestClient` context would need live
infrastructure to test routing.

The route-level property that matters most is the one on the FAILURE path.
Anywhere a guardrail can fail, a caller is tempted to improvise a policy of its
own — and the improvisation that would be a patient-safety event is "the check
failed, so hide the text". So every failure body restates
``transcriptDisposition: retain_verbatim``, and it is asserted here rather than
left to a reviewer's memory.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import guardrail.api.endpoints.realtime as realtime_mod
from guardrail.api.endpoints.realtime import (
    ConsumptionGateRequest,
    OutputCheckRequest,
    SegmentRequest,
    check_output,
    gate_consumption,
    read_segment_verdict,
    validate_segment,
)
from guardrail.core.dependencies import SelectionUnavailableError
from guardrail.realtime.consumption import CapabilityPolicy
from guardrail.realtime.deterministic import DeterministicRuleSet
from guardrail.realtime.service import AxisTasks, RealtimePolicy, RealtimeValidator
from guardrail.realtime.session_state import SessionRiskPolicy
from guardrail.realtime.store import InMemoryRealtimeStore
from guardrail.realtime.verdict import RETAIN_VERBATIM

TENANT = "11111111-1111-1111-1111-111111111111"


class _StubAnalyzer:
    def __init__(self, *, flag: str | None = None) -> None:
        self._flag = flag
        self.calls = 0

    async def classify_tasks(self, task_names, text):  # noqa: ANN001, ANN201
        self.calls += 1
        return dict.fromkeys(task_names, self._flag or "benign")


class _FakeRequest:
    def __init__(self, state, headers: dict[str, str] | None = None) -> None:
        self.app = SimpleNamespace(state=state)
        self.headers = {"X-Tenant-Id": TENANT, **(headers or {})}


def _policy() -> RealtimePolicy:
    return RealtimePolicy(
        axes=AxisTasks.from_declaration(
            {
                "contentHarm": ["prompt_safety"],
                "injectionRisk": ["jailbreak_detection"],
                "clinical": ["self_harm_screen"],
            }
        ),
        rules=DeterministicRuleSet.from_declaration([{"id": "o", "phrase": "ignore previous"}]),
        capabilities=CapabilityPolicy.from_declaration({"readonly-text": ["text.read"]}),
        session=SessionRiskPolicy(
            noise_floor=0.2,
            excess_risk_threshold=1.0,
            consecutive_limit=2,
            mean_score_threshold=0.5,
            min_windows_for_mean=4,
        ),
        lexicons={"negation": ["denies", "no"], "laterality": ["left", "right"]},
        benign_labels=frozenset({"benign"}),
        policy_version=7,
        classifier_version="clf-1",
        taxonomy_version="clinical-v3",
    )


@pytest.fixture
def bind(monkeypatch):
    """Bind `build_realtime_validator` to a stub analyzer + in-memory store."""
    store = InMemoryRealtimeStore()
    holder: dict[str, object] = {"store": store}

    def _install(analyzer: object) -> None:
        async def _build(app_state, tenant_id):  # noqa: ANN001, ANN202
            return RealtimeValidator(
                analyzer=analyzer, policy=_policy(), tenant_id=tenant_id, store=store
            )

        monkeypatch.setattr(realtime_mod, "build_realtime_validator", _build)
        holder["analyzer"] = analyzer

    def _fail(exc: Exception) -> None:
        async def _build(app_state, tenant_id):  # noqa: ANN001, ANN202
            raise exc

        monkeypatch.setattr(realtime_mod, "build_realtime_validator", _build)

    holder["install"] = _install
    holder["fail"] = _fail
    return holder


def _state():
    return SimpleNamespace(admission_gates={})


# --- attribution ------------------------------------------------------------


async def test_a_segment_without_a_tenant_header_is_refused_with_428(bind) -> None:
    bind["install"](_StubAnalyzer())
    request = _FakeRequest(_state(), headers={"X-Tenant-Id": ""})
    with pytest.raises(HTTPException) as exc:
        await validate_segment(
            SegmentRequest(session_id="s", segment_id="a", text="chest pain"), request
        )
    assert exc.value.status_code == 428


async def test_the_consumption_gate_also_demands_a_tenant(bind) -> None:
    bind["install"](_StubAnalyzer())
    with pytest.raises(HTTPException) as exc:
        await gate_consumption(
            ConsumptionGateRequest(
                session_id="s",
                text="chest pain",
                assembly_template_id="summarize.partial@3",
                capability_set_id="readonly-text",
            ),
            _FakeRequest(_state(), headers={"X-Tenant-Id": ""}),
        )
    assert exc.value.status_code == 428


# --- the happy paths --------------------------------------------------------


async def test_a_segment_verdict_comes_back_with_all_three_axes(bind) -> None:
    bind["install"](_StubAnalyzer())
    payload = await validate_segment(
        SegmentRequest(session_id="s", segment_id="a", text="patient denies chest pain"),
        _FakeRequest(_state()),
    )
    assert set(payload) >= {"contentHarm", "injectionRisk", "clinical", "window"}
    assert payload["window"]["complete"] is False
    assert payload["transcriptDisposition"] == RETAIN_VERBATIM
    assert payload["tenantId"] == TENANT


async def test_a_consumer_reads_the_stored_verdict_instead_of_revalidating(bind) -> None:
    analyzer = _StubAnalyzer()
    bind["install"](analyzer)
    request = _FakeRequest(_state())
    await validate_segment(
        SegmentRequest(session_id="s", segment_id="a", text="chest pain"), request
    )
    after_write = analyzer.calls
    for _ in range(3):
        assert (await read_segment_verdict("a", request))["segmentId"] == "a"
    assert analyzer.calls == after_write


async def test_an_unknown_segment_is_a_404_not_an_implicit_pass(bind) -> None:
    bind["install"](_StubAnalyzer())
    with pytest.raises(HTTPException) as exc:
        await read_segment_verdict("never-validated", _FakeRequest(_state()))
    assert exc.value.status_code == 404


async def test_the_consumption_route_returns_both_the_decision_and_the_verdict(bind) -> None:
    bind["install"](_StubAnalyzer())
    payload = await gate_consumption(
        ConsumptionGateRequest(
            session_id="s",
            text="patient denies chest pain radiating to the left arm",
            assembly_template_id="summarize.partial@3",
            capability_set_id="readonly-text",
            declared_capabilities=["text.read"],
        ),
        _FakeRequest(_state()),
    )
    assert payload["decision"]["allowed"] is True
    assert payload["verdict"]["window"]["complete"] is True
    assert payload["decision"]["transcriptDisposition"] == RETAIN_VERBATIM


async def test_a_composite_context_is_refused_at_the_route(bind) -> None:
    bind["install"](_StubAnalyzer())
    payload = await gate_consumption(
        ConsumptionGateRequest(
            session_id="s",
            text="transcript text joined with a document",
            assembly_template_id="summarize.partial@3",
            capability_set_id="readonly-text",
            declared_capabilities=["text.read"],
            source_artifact_count=2,
        ),
        _FakeRequest(_state()),
    )
    assert payload["decision"]["allowed"] is False
    assert "unvalidated_composite" in payload["decision"]["reasons"]


# --- fail-closed for derivations, fail-OPEN for the record (C-5) ------------


@pytest.mark.parametrize(
    "handler,payload",
    [
        (
            validate_segment,
            SegmentRequest(session_id="s", segment_id="a", text="chest pain"),
        ),
        (
            gate_consumption,
            ConsumptionGateRequest(
                session_id="s",
                text="chest pain",
                assembly_template_id="summarize.partial@3",
                capability_set_id="readonly-text",
            ),
        ),
    ],
)
async def test_an_unresolved_selection_pauses_derivations_and_keeps_the_transcript(
    bind, handler, payload
) -> None:
    bind["fail"](SelectionUnavailableError("no guardrail.safety row"))
    with pytest.raises(HTTPException) as exc:
        await handler(payload, _FakeRequest(_state()))
    assert exc.value.status_code == 503
    detail = exc.value.detail
    assert detail["transcriptDisposition"] == RETAIN_VERBATIM
    assert detail["notice"] == "ai_derivations_paused"


async def test_no_failure_body_ever_asks_a_caller_to_remove_text(bind) -> None:
    bind["fail"](RuntimeError("nlp down"))
    with pytest.raises(HTTPException) as exc:
        await validate_segment(
            SegmentRequest(session_id="s", segment_id="a", text="chest pain"),
            _FakeRequest(_state()),
        )
    body = repr(exc.value.detail).lower()
    for forbidden in ("redact", "withhold", "remove", "suppress", "hide"):
        assert forbidden not in body, forbidden


# --- C-4 at the route -------------------------------------------------------


async def test_the_output_route_accepts_no_verdict_reference_at_all(bind) -> None:
    """Structural independence: there is no field with which to express a skip."""
    fields = set(OutputCheckRequest.model_fields)
    assert not any(
        word in name.lower()
        for name in fields
        for word in ("verdict", "validation", "gate", "allowed")
    )


async def test_a_grammar_edit_that_flips_a_laterality_is_reported_as_a_safety_event(
    bind,
) -> None:
    bind["install"](_StubAnalyzer())
    payload = await check_output(
        OutputCheckRequest(
            task="grammar",
            source_text="Pain in the left leg. Patient denies fever.",
            corrected_text="Pain in the right leg. Patient denies fever.",
        ),
        _FakeRequest(_state()),
    )
    assert payload["safetyEvent"] is True
    flagged = [c["name"] for c in payload["checks"] if c["outcome"] == "flag"]
    assert "laterality_preservation" in flagged
    assert payload["transcriptDisposition"] == RETAIN_VERBATIM


async def test_ner_entities_without_provenance_are_dropped_at_the_route(bind) -> None:
    bind["install"](_StubAnalyzer())
    source = "Started warfarin 5 mg."
    payload = await check_output(
        OutputCheckRequest(
            task="ner",
            source_text=source,
            entities=[
                {"label": "DRUG", "start": 8, "end": 16, "text": "warfarin"},
                {"label": "DRUG", "start": 900, "end": 908, "text": "heparin"},
            ],
        ),
        _FakeRequest(_state()),
    )
    assert payload["droppedCount"] == 1
    assert len(payload["keptEntities"]) == 1


async def test_a_grammar_check_without_the_corrected_text_is_a_422_not_a_pass(bind) -> None:
    bind["install"](_StubAnalyzer())
    with pytest.raises(HTTPException) as exc:
        await check_output(
            OutputCheckRequest(task="grammar", source_text="x"), _FakeRequest(_state())
        )
    assert exc.value.status_code == 422


async def test_generative_groundedness_is_not_reimplemented_here(bind) -> None:
    """§7's third row already exists; a second copy is a second inference stack."""
    bind["install"](_StubAnalyzer())
    with pytest.raises(HTTPException) as exc:
        await check_output(
            OutputCheckRequest(task="summary", source_text="x"), _FakeRequest(_state())
        )
    assert exc.value.status_code == 422
    assert "groundedness" in str(exc.value.detail)


# --- the store ---------------------------------------------------------------


class _FakeRedis:
    def __init__(self, seed: dict[str, str] | None = None) -> None:
        self.data = dict(seed or {})
        self.ttls: dict[str, int] = {}

    async def get(self, key):  # noqa: ANN001, ANN201
        return self.data.get(key)

    async def set(self, key, value, ex=None):  # noqa: ANN001, ANN201
        self.data[key] = value
        self.ttls[key] = ex


async def test_a_corrupt_cache_entry_is_a_miss_and_never_half_a_verdict() -> None:
    """Recomputing is cheap; interpreting half a verdict is a safety decision."""
    from guardrail.realtime.store import RedisRealtimeStore

    store = RedisRealtimeStore(_FakeRedis({"k": "{not json", "l": "[1,2]"}))
    assert await store.get("k") is None
    assert await store.get("l") is None, "a JSON array is not a verdict"
    assert await store.get("absent") is None


async def test_the_store_round_trips_a_verdict_with_a_ttl() -> None:
    from guardrail.realtime.store import RedisRealtimeStore

    redis = _FakeRedis()
    store = RedisRealtimeStore(redis)
    await store.put("k", {"decision": "PASS"}, 900)
    assert await store.get("k") == {"decision": "PASS"}
    assert redis.ttls["k"] == 900


def test_every_store_key_starts_with_the_tenant_so_a_cross_tenant_read_cannot_occur() -> None:
    from guardrail.realtime.store import segment_key, session_key

    for builder in (segment_key, session_key):
        a, b = builder("tenant-a", "x"), builder("tenant-b", "x")
        assert a != b
        assert "tenant-a" in a and "tenant-b" in b
