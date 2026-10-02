"""The TEXT -> guardrail moderation budget nests inside guardrail's judge budget.

``POST /api/medical/validate`` is answered by an LLM judge that guardrail
delegates back to this service's judge lane, on one shared GPU. Measured over
three days (n ~ 695 judge calls): judge p50 2.9 s, p90 13.6 s, **p99 50.6 s**,
max 60 s (guardrail's own budget). TEXT used to give up after 10 s and send the
call again while guardrail's judge kept running — nothing cancels across the
hop — so up to three judges stacked on the GPU, each slowing the next.

The rules pinned here:

1. **Timeouts nest.** TEXT waits longer than guardrail's worst case for one
   validation, so guardrail always answers (a verdict, or its own fail-closed
   503) before TEXT gives up.
2. **Never retry work that may still be running.** Only failures where the
   request provably did not start work are retried: a connection that was never
   established, a connection dropped before any response, and an upstream
   502/503/504. A read/write timeout is not retried, and neither is a 503 in
   which guardrail declares that its judge TIMED OUT (that is the same timeout,
   propagated; retrying it moves the retry guardrail no longer makes up a layer).
3. **Shed with a breaker.** After consecutive peer-health failures the leg
   opens and answers fail-closed without sending anything; after a cool-down one
   probe is admitted.

Fail posture is unchanged throughout: every exhausted or shed call is
``allowed: False`` with ``external_guardrail_unavailable``.

Transport realism: ``httpx.MockTransport`` never enforces a timeout, so a
"guardrail that answers at N seconds" is modelled from the per-phase timeout the
client actually put on the request (``request.extensions["timeout"]``): a read
budget shorter than N raises ``ReadTimeout`` exactly as the network would.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from text.core import runtime_defaults
from text.core.guardrail_posture import GuardrailPosture
from text.services import circuit_breaker as circuit_breaker_module
from text.services import external_guardrail as eg
from text.services.external_guardrail import (
    GUARDRAIL_UNAVAILABLE_REASON,
    ExternalGuardrailClient,
)

_BASE_URL = "http://guardrail.test"
_MEDICAL = {"is_medical": True, "confidence": 0.93}

_REPO_ROOT = Path(__file__).resolve().parents[6]
_DESCRIPTORS = _REPO_ROOT / "packages/applications/src/services/settings-registry/descriptors"
_GUARDRAIL_CONFIG = _REPO_ROOT / "apps/guardrail/src/guardrail/core/config.py"

#: The 503 detail guardrail answers when its judge timed out
#: (`GuardrailUndeterminedError(REASON_TIMEOUT).as_detail()`), pinned on the
#: guardrail side by `test_judge_timeout_budget.py`.
_JUDGE_TIMED_OUT_DETAIL = "guardrail verdict undetermined (timeout) — refusing to report 'safe'"

Step = Callable[[httpx.Request], httpx.Response]


# --- a scripted guardrail ----------------------------------------------------


def answers_after(seconds: float, payload: dict[str, Any] | None = None) -> Step:
    """A guardrail whose verdict arrives ``seconds`` after the request."""

    def step(request: httpx.Request) -> httpx.Response:
        read_budget = request.extensions["timeout"]["read"]
        if read_budget is not None and read_budget < seconds:
            raise httpx.ReadTimeout("", request=request)
        return httpx.Response(200, json=payload or _MEDICAL)

    return step


def raises(exc_type: type[httpx.TransportError]) -> Step:
    def step(request: httpx.Request) -> httpx.Response:
        raise exc_type("", request=request)

    return step


def status(code: int, detail: str = "nope", headers: dict[str, str] | None = None) -> Step:
    def step(request: httpx.Request) -> httpx.Response:
        return httpx.Response(code, json={"detail": detail}, headers=headers)

    return step


def ok(payload: dict[str, Any] | None = None) -> Step:
    return answers_after(0.0, payload)


class Guardrail:
    """Plays ``steps`` in order; the last step repeats."""

    def __init__(self, *steps: Step) -> None:
        self.steps = list(steps)
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        step = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
        return step(request)


def _client(guardrail: Guardrail, **posture: Any) -> ExternalGuardrailClient:
    posture.setdefault("retry_backoff_ms", 0)
    state = SimpleNamespace(guardrail_posture=GuardrailPosture(**posture))
    return ExternalGuardrailClient(
        base_url=_BASE_URL,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(guardrail.handler)),
        service_token="svc-token",
        app_state=state,
    )


def _assert_fail_closed(verdict: dict[str, Any]) -> None:
    assert verdict["allowed"] is False
    assert verdict["reason"] == GUARDRAIL_UNAVAILABLE_REASON


class _RecordingLogger:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def _record(self, event: str, **fields: Any) -> None:
        self.events.append((event, fields))

    info = warning = error = debug = _record

    def named(self, event: str) -> list[dict[str, Any]]:
        return [fields for name, fields in self.events if name == event]


@pytest.fixture
def log(monkeypatch: pytest.MonkeyPatch) -> _RecordingLogger:
    recorder = _RecordingLogger()
    monkeypatch.setattr(eg, "logger", recorder)
    return recorder


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """A controllable monotonic clock for the breaker's cool-down."""
    now = SimpleNamespace(t=1_000.0)
    monkeypatch.setattr(circuit_breaker_module, "time", SimpleNamespace(monotonic=lambda: now.t))
    return now


# --- 1. the budget nests -----------------------------------------------------


class TestTheBudgetNests:
    @pytest.mark.asyncio
    async def test_a_verdict_at_15s_is_one_request_under_the_default_budget(self) -> None:
        """The p90 judge is ~14 s. Under the old 10 s budget this call timed out,
        was sent twice more while the first judge was still running, and failed
        closed. Under the nested budget it is simply answered."""
        guardrail = Guardrail(answers_after(15.0))
        verdict = await _client(guardrail).validate("patient chest pain")

        assert verdict["allowed"] is True
        assert len(guardrail.requests) == 1

    @pytest.mark.asyncio
    async def test_a_verdict_at_the_measured_p99_is_answered(self) -> None:
        guardrail = Guardrail(answers_after(50.6))
        verdict = await _client(guardrail).validate("patient chest pain")

        assert verdict["allowed"] is True
        assert len(guardrail.requests) == 1

    @pytest.mark.asyncio
    async def test_the_connect_phase_is_bounded_separately_from_the_verdict_wait(self) -> None:
        """The long budget is for guardrail's ANSWER. Establishing a connection has
        nothing to do with judge latency, and a connect failure is retried — so a
        75 s connect phase would make three unreachable attempts cost 225 s."""
        guardrail = Guardrail(ok())
        await _client(guardrail).validate("note")

        timeout = guardrail.requests[0].extensions["timeout"]
        assert timeout["read"] == runtime_defaults.GUARDRAIL_TIMEOUT_FLOOR_S
        assert timeout["connect"] == runtime_defaults.GUARDRAIL_CONNECT_TIMEOUT_S
        assert timeout["connect"] < timeout["read"]

    @pytest.mark.asyncio
    async def test_a_served_timeout_below_the_connect_bound_caps_both(self) -> None:
        guardrail = Guardrail(ok())
        await _client(guardrail, timeout_s=3).validate("note")

        timeout = guardrail.requests[0].extensions["timeout"]
        assert timeout["read"] == 3
        assert timeout["connect"] == 3


class TestNestingInvariant:
    """TEXT's floor outlasts guardrail's worst case for ONE validation.

    Read across the service boundary as SOURCE, never imported: the judge
    budget's default is the TypeScript descriptor (the source of truth), and the
    attempt count and admission wait are guardrail's `JudgePolicy` /
    `TransportPolicy` contracts. The same invariant is pinned from guardrail's
    side and over the two descriptors in `packages/applications`.
    """

    #: Resolution, serialisation and scheduling on top of the declared waits.
    SLACK_S = 5.0

    @staticmethod
    def _judge_timeout_default() -> float:
        source = (_DESCRIPTORS / "guardrail-judge.descriptors.ts").read_text(encoding="utf-8")
        match = re.search(
            r"GUARDRAIL_JUDGE_DEFAULTS = \{\s*\[GUARDRAIL_JUDGE_TIMEOUT_KEY\]:\s*([0-9_.]+)",
            source,
        )
        assert match, "GUARDRAIL_JUDGE_DEFAULTS is no longer a one-key literal"
        return float(match.group(1).replace("_", ""))

    @staticmethod
    def _guardrail_policy_field(cls_name: str, field: str) -> float:
        source = _GUARDRAIL_CONFIG.read_text(encoding="utf-8")
        block = re.search(
            rf"\nclass {cls_name}\(BaseModel\):(?P<body>.*?)(?=\nclass |\Z)", source, re.S
        )
        assert block, f"guardrail {cls_name} is gone from core/config.py"
        match = re.search(rf"\n\s+{field}: (?:int|float) = ([0-9_.]+)", block.group("body"))
        assert match, f"guardrail {cls_name}.{field} is no longer a literal default"
        return float(match.group(1).replace("_", ""))

    def test_the_floor_outlasts_one_guardrail_validation(self) -> None:
        judge_timeout = self._judge_timeout_default()
        attempts = self._guardrail_policy_field("JudgePolicy", "max_attempts")
        backoff = self._guardrail_policy_field("JudgePolicy", "retry_backoff_s")
        admission = self._guardrail_policy_field("TransportPolicy", "max_queue_wait_s")

        backoff_total = backoff * sum(range(1, int(attempts)))
        inner_worst_case = admission + judge_timeout * attempts + backoff_total

        assert runtime_defaults.GUARDRAIL_TIMEOUT_FLOOR_S >= inner_worst_case + self.SLACK_S, (
            f"TEXT gives up after {runtime_defaults.GUARDRAIL_TIMEOUT_FLOOR_S}s but one "
            f"guardrail validation may take {inner_worst_case}s: the budget is inverted again"
        )

    def test_the_values_this_ticket_sized(self) -> None:
        """Sized against the measured judge p99 (50.6 s): the judge keeps 60 s and
        one attempt, TEXT waits 120 s and keeps two retries for connect/5xx only."""
        assert self._judge_timeout_default() == 60
        assert self._guardrail_policy_field("JudgePolicy", "max_attempts") == 1
        assert runtime_defaults.GUARDRAIL_TIMEOUT_FLOOR_S == 120
        assert runtime_defaults.GUARDRAIL_MAX_RETRIES_FLOOR == 2


# --- 2. what is retried ------------------------------------------------------


class TestOnlyFailuresThatStartedNoWorkAreRetried:
    @pytest.mark.asyncio
    async def test_a_read_timeout_is_not_retried(self, log: _RecordingLogger) -> None:
        """The request reached guardrail and its judge may still be running: a
        second request would stack another judgement on the same GPU."""
        guardrail = Guardrail(raises(httpx.ReadTimeout))
        verdict = await _client(guardrail, max_retries=2).validate("note")

        _assert_fail_closed(verdict)
        assert "ReadTimeout" in verdict["error"]
        assert len(guardrail.requests) == 1

        [failed] = log.named("external_guardrail.attempt_failed")
        assert failed["will_retry"] is False
        assert failed["retry_reason"] == "timed_out_in_flight"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "exc_type", [httpx.WriteTimeout, httpx.PoolTimeout, httpx.ReadError, httpx.WriteError]
    )
    async def test_other_in_flight_or_local_failures_are_not_retried(
        self, exc_type: type[httpx.TransportError]
    ) -> None:
        guardrail = Guardrail(raises(exc_type))
        verdict = await _client(guardrail, max_retries=2).validate("note")

        _assert_fail_closed(verdict)
        assert len(guardrail.requests) == 1

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "exc_type", [httpx.ConnectError, httpx.ConnectTimeout, httpx.RemoteProtocolError]
    )
    async def test_a_connection_that_never_carried_the_request_is_retried(
        self, exc_type: type[httpx.TransportError], log: _RecordingLogger
    ) -> None:
        guardrail = Guardrail(raises(exc_type), raises(exc_type), ok())
        verdict = await _client(guardrail, max_retries=2).validate("patient note")

        assert verdict["allowed"] is True
        assert len(guardrail.requests) == 3
        assert [f["will_retry"] for f in log.named("external_guardrail.attempt_failed")] == [
            True,
            True,
        ]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("code", [502, 503, 504])
    async def test_an_upstream_5xx_is_retried(self, code: int, log: _RecordingLogger) -> None:
        guardrail = Guardrail(status(code), ok())
        verdict = await _client(guardrail, max_retries=2).validate("patient note")

        assert verdict["allowed"] is True
        assert len(guardrail.requests) == 2
        [failed] = log.named("external_guardrail.attempt_failed")
        assert failed["will_retry"] is True
        assert failed["retry_reason"] == "upstream_5xx"

    @pytest.mark.asyncio
    async def test_a_503_declaring_the_judge_timed_out_is_not_retried(
        self, log: _RecordingLogger
    ) -> None:
        """Guardrail already waited its full judge budget and made its one
        attempt; retrying here re-runs the judgement guardrail deliberately
        does not retry, one layer up."""
        guardrail = Guardrail(status(503, _JUDGE_TIMED_OUT_DETAIL))
        verdict = await _client(guardrail, max_retries=2).validate("note")

        _assert_fail_closed(verdict)
        assert len(guardrail.requests) == 1
        [failed] = log.named("external_guardrail.attempt_failed")
        assert failed["retry_reason"] == "guardrail_judge_timed_out"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("code", [400, 401, 403, 404, 422, 500])
    async def test_a_client_error_or_a_500_is_not_retried(self, code: int) -> None:
        guardrail = Guardrail(status(code), ok())
        verdict = await _client(guardrail, max_retries=2).validate("note")

        _assert_fail_closed(verdict)
        assert len(guardrail.requests) == 1

    @pytest.mark.asyncio
    async def test_an_unreadable_verdict_is_not_retried(self) -> None:
        """Guardrail answered — its judgement ran. Asking again re-runs it."""

        def garbage(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b"<html>not json</html>")

        guardrail = Guardrail(garbage, ok())
        verdict = await _client(guardrail, max_retries=2).validate("note")

        _assert_fail_closed(verdict)
        assert len(guardrail.requests) == 1

    @pytest.mark.asyncio
    async def test_the_retry_budget_still_bounds_a_sustained_outage(
        self, log: _RecordingLogger
    ) -> None:
        guardrail = Guardrail(raises(httpx.ConnectError))
        verdict = await _client(guardrail, max_retries=2).validate("note")

        _assert_fail_closed(verdict)
        assert len(guardrail.requests) == 3
        failed = log.named("external_guardrail.attempt_failed")
        assert [f["will_retry"] for f in failed] == [True, True, False]
        assert failed[-1]["retry_reason"] == "budget_exhausted"
        assert log.named("external_guardrail.exhausted_fail_closed")

    @pytest.mark.asyncio
    async def test_the_output_screen_rides_the_same_rules(self) -> None:
        guardrail = Guardrail(raises(httpx.ReadTimeout))
        verdict = await _client(guardrail, max_retries=2).screen_output("x", tenant_id="t")

        _assert_fail_closed(verdict)
        assert len(guardrail.requests) == 1


# --- 3. the breaker ----------------------------------------------------------


class TestTheBreakerShedsFailClosed:
    @property
    def THRESHOLD(self) -> int:  # noqa: N802 — read like the constant it mirrors
        return runtime_defaults.GUARDRAIL_BREAKER_FAILURE_THRESHOLD

    @property
    def RECOVERY_S(self) -> float:  # noqa: N802
        return runtime_defaults.GUARDRAIL_BREAKER_RECOVERY_S

    async def _open(self, client: ExternalGuardrailClient) -> None:
        for _ in range(self.THRESHOLD):
            _assert_fail_closed(await client.validate("note"))

    def test_the_tunables_mirror_guardrails_own_peer_breakers(self) -> None:
        assert self.THRESHOLD == 5
        assert self.RECOVERY_S == 15.0

    @pytest.mark.asyncio
    async def test_it_opens_after_consecutive_failures_and_sheds_without_a_request(
        self, clock: SimpleNamespace, log: _RecordingLogger
    ) -> None:
        guardrail = Guardrail(raises(httpx.ConnectError))
        client = _client(guardrail, max_retries=0)
        await self._open(client)
        assert len(guardrail.requests) == self.THRESHOLD

        verdict = await client.validate("note")

        _assert_fail_closed(verdict)
        assert verdict["error"] == eg.GUARDRAIL_CIRCUIT_OPEN_ERROR
        assert len(guardrail.requests) == self.THRESHOLD, "an open circuit sends nothing"
        assert log.named("external_guardrail.shed_circuit_open")

    @pytest.mark.asyncio
    async def test_the_output_screen_is_shed_by_the_same_breaker(
        self, clock: SimpleNamespace
    ) -> None:
        guardrail = Guardrail(raises(httpx.ConnectTimeout))
        client = _client(guardrail, max_retries=0)
        await self._open(client)

        verdict = await client.screen_output("x", tenant_id="t")

        _assert_fail_closed(verdict)
        assert verdict["error"] == eg.GUARDRAIL_CIRCUIT_OPEN_ERROR
        assert len(guardrail.requests) == self.THRESHOLD

    @pytest.mark.asyncio
    async def test_retries_count_and_an_opening_circuit_stops_the_retry_loop(
        self, clock: SimpleNamespace
    ) -> None:
        guardrail = Guardrail(raises(httpx.ConnectError))
        client = _client(guardrail, max_retries=2)

        await client.validate("note")  # 3 failures
        verdict = await client.validate("note")  # 2 more open it; the 3rd is shed

        _assert_fail_closed(verdict)
        assert verdict["error"] == eg.GUARDRAIL_CIRCUIT_OPEN_ERROR
        assert len(guardrail.requests) == self.THRESHOLD

    @pytest.mark.asyncio
    async def test_a_guardrail_that_answered_is_not_a_peer_failure(
        self, clock: SimpleNamespace
    ) -> None:
        """One tenant's 4xx or a low-confidence 503 is guardrail answering
        correctly about THAT request. Counting it would let one tenant's traffic
        shed every other tenant's moderation."""
        guardrail = Guardrail(
            *[status(422)] * self.THRESHOLD,
            *[status(503, "guardrail verdict undetermined (invalid_response)")] * self.THRESHOLD,
            ok(),
        )
        client = _client(guardrail, max_retries=0)
        for _ in range(2 * self.THRESHOLD):
            await client.validate("note")

        verdict = await client.validate("patient note")

        assert verdict["allowed"] is True
        assert len(guardrail.requests) == 2 * self.THRESHOLD + 1

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "failure",
        [
            raises(httpx.ReadTimeout),
            status(502),
            status(504),
            status(503, _JUDGE_TIMED_OUT_DETAIL),
            status(503, "Service saturated", headers={"Retry-After": "5"}),
        ],
        ids=["read-timeout", "502", "504", "503-judge-timeout", "503-saturated"],
    )
    async def test_slow_or_saturated_guardrail_counts(
        self, failure: Step, clock: SimpleNamespace
    ) -> None:
        guardrail = Guardrail(failure)
        client = _client(guardrail, max_retries=0)
        await self._open(client)

        verdict = await client.validate("note")

        assert verdict["error"] == eg.GUARDRAIL_CIRCUIT_OPEN_ERROR
        assert len(guardrail.requests) == self.THRESHOLD

    @pytest.mark.asyncio
    async def test_a_success_resets_the_run(self, clock: SimpleNamespace) -> None:
        guardrail = Guardrail(
            *[raises(httpx.ConnectError)] * (self.THRESHOLD - 1),
            ok(),
            *[raises(httpx.ConnectError)] * (self.THRESHOLD - 1),
            ok(),
        )
        client = _client(guardrail, max_retries=0)
        # Distinct texts: an allowed verdict is cached per text (TASK-1035).
        for i in range(2 * self.THRESHOLD - 1):
            await client.validate(f"note {i}")

        assert (await client.validate("patient note"))["allowed"] is True

    @pytest.mark.asyncio
    async def test_after_the_cool_down_one_probe_is_admitted_and_success_closes(
        self, clock: SimpleNamespace
    ) -> None:
        guardrail = Guardrail(*[raises(httpx.ConnectError)] * self.THRESHOLD, ok())
        client = _client(guardrail, max_retries=0)
        await self._open(client)

        clock.t += self.RECOVERY_S - 0.1
        assert (await client.validate("note"))["error"] == eg.GUARDRAIL_CIRCUIT_OPEN_ERROR
        assert len(guardrail.requests) == self.THRESHOLD

        clock.t += 0.2
        # Distinct texts: an allowed verdict is cached per text (TASK-1035).
        assert (await client.validate("patient note 1"))["allowed"] is True
        assert (await client.validate("patient note 2"))["allowed"] is True
        assert len(guardrail.requests) == self.THRESHOLD + 2

    @pytest.mark.asyncio
    async def test_a_half_open_circuit_admits_only_one_probe(self, clock: SimpleNamespace) -> None:
        release = asyncio.Event()

        async def slow_ok(request: httpx.Request) -> httpx.Response:
            await release.wait()
            return httpx.Response(200, json=_MEDICAL)

        guardrail = Guardrail(*[raises(httpx.ConnectError)] * self.THRESHOLD, slow_ok)
        client = _client(guardrail, max_retries=0)
        await self._open(client)
        clock.t += self.RECOVERY_S

        probe = asyncio.create_task(client.validate("patient note"))
        await asyncio.sleep(0)
        while len(guardrail.requests) < self.THRESHOLD + 1:
            await asyncio.sleep(0)

        shed = await client.validate("note")
        assert shed["error"] == eg.GUARDRAIL_CIRCUIT_OPEN_ERROR
        assert len(guardrail.requests) == self.THRESHOLD + 1

        release.set()
        assert (await probe)["allowed"] is True

    @pytest.mark.asyncio
    async def test_a_failed_probe_reopens_for_a_fresh_cool_down(
        self, clock: SimpleNamespace
    ) -> None:
        guardrail = Guardrail(raises(httpx.ConnectError))
        client = _client(guardrail, max_retries=0)
        await self._open(client)
        clock.t += self.RECOVERY_S

        _assert_fail_closed(await client.validate("note"))  # the probe, failing
        assert len(guardrail.requests) == self.THRESHOLD + 1

        clock.t += self.RECOVERY_S - 0.1
        assert (await client.validate("note"))["error"] == eg.GUARDRAIL_CIRCUIT_OPEN_ERROR
        assert len(guardrail.requests) == self.THRESHOLD + 1

    @pytest.mark.asyncio
    async def test_a_cancelled_probe_never_wedges_the_circuit(self, clock: SimpleNamespace) -> None:
        """A caller that gives up mid-probe reports nothing about the peer. If its
        slot were not released, the circuit would stay half-open with its one
        probe slot taken — shedding every request, i.e. no moderation ever again."""
        never = asyncio.Event()

        async def hangs(request: httpx.Request) -> httpx.Response:
            await never.wait()
            return httpx.Response(200, json=_MEDICAL)

        guardrail = Guardrail(*[raises(httpx.ConnectError)] * self.THRESHOLD, hangs, ok())
        client = _client(guardrail, max_retries=0)
        await self._open(client)
        clock.t += self.RECOVERY_S

        probe = asyncio.create_task(client.validate("note"))
        while len(guardrail.requests) < self.THRESHOLD + 1:
            await asyncio.sleep(0)
        probe.cancel()
        with pytest.raises(asyncio.CancelledError):
            await probe

        clock.t += self.RECOVERY_S
        assert (await client.validate("patient note"))["allowed"] is True
        assert len(guardrail.requests) == self.THRESHOLD + 2
