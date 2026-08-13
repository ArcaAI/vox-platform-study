"""Wire-contract tests for the agent roster in ``fetch_loop_config``.

The gateway answers camelCase (`LoopConfigResponse`); the activity maps it onto
the snake_case `ConsultationLoopConfig` the workflow pins. shipped a
wire-contract DEFECT of exactly this class — a body shaped for the wrong DTO
that would have 400'd every loop-event publish in production — so the mapping
gets its own tests rather than being assumed correct.

The two properties that matter most are both about a gateway that has NOT been
upgraded: an old gateway sends no `agents` and no `reasoningEnabled`, and the
loop must then behave exactly as left it rather than half-enabling a
deliberative lane with an empty roster.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.activities import fetch_loop_config
from harness.temporal.models import AGENT_ROLE_SPECIALIST, FetchLoopConfigInput


class _StubApiClient:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.calls: list[tuple[str, str]] = []

    async def get_loop_config(self, consultation_id: str, *, tenant_id: str) -> dict[str, Any]:
        self.calls.append((consultation_id, tenant_id))
        return self._payload


@pytest.fixture
def patch_client(monkeypatch):
    def _apply(payload: dict[str, Any]) -> _StubApiClient:
        client = _StubApiClient(payload)
        monkeypatch.setattr("harness.temporal.activities._api_client", lambda _s: client)
        return client

    return _apply


FULL_PAYLOAD: dict[str, Any] = {
    "enabled": True,
    "consultationId": "c-1",
    "departmentId": "d-1",
    "agentId": "agent-primary",
    "agentConfigVersionId": "dav-1",
    "contextSchemaVersionId": "csv-1",
    "subscriptions": [{"kindKey": "transcript", "actions": ["client.emit"]}],
    "budget": {"maxDepth": 4, "maxActions": 99},
    "startActions": ["livedoc.start"],
    "endingActions": ["harness.finalize"],
    "reasoningEnabled": True,
    "agents": [
        {
            "agentId": "agent-primary",
            "role": "PRIMARY",
            "slug": "primary",
            "goal": "Produce one reconciled note",
            "subscribedKinds": ["transcript", "worknote"],
            "writeScope": ["soap_note"],
            "agentConfigVersionId": "dav-1",
        },
        {
            "agentId": "agent-cardio",
            "role": "SPECIALIST",
            "slug": "cardiology",
            "goal": None,
            "subscribedKinds": ["transcript"],
            "writeScope": ["cardiology_finding"],
            "agentConfigVersionId": "dav-2",
        },
    ],
}


class TestRosterMapping:
    @pytest.mark.asyncio
    async def test_every_roster_field_maps_from_its_camel_case_key(self, patch_client):
        patch_client(FULL_PAYLOAD)

        config = await fetch_loop_config(
            FetchLoopConfigInput(consultation_id="c-1", tenant_id="t-1")
        )

        assert config.reasoning_enabled is True
        assert [a.agent_id for a in config.agents] == ["agent-primary", "agent-cardio"]

        primary = config.agents[0]
        assert primary.is_primary is True
        assert primary.slug == "primary"
        assert primary.goal == "Produce one reconciled note"
        assert primary.subscribed_kinds == ["transcript", "worknote"]
        assert primary.write_scope == ["soap_note"]
        assert primary.agent_config_version_id == "dav-1"

        specialist = config.agents[1]
        assert specialist.is_primary is False
        assert specialist.reads("transcript") is True
        assert specialist.reads("worknote") is False
        assert specialist.may_write("cardiology_finding") is True

    @pytest.mark.asyncio
    async def test_the_budget_gains_the_specialist_cap(self, patch_client):
        payload = {**FULL_PAYLOAD, "budget": {"maxDepth": 4, "maxActions": 99}}
        patch_client(payload)

        config = await fetch_loop_config(
            FetchLoopConfigInput(consultation_id="c-1", tenant_id="t-1")
        )

        assert config.budget.max_depth == 4
        assert config.budget.max_actions == 99
        # Not on the wire yet; the model default applies rather than 0.
        assert config.budget.max_specialist_runs > 0


class TestIdleBoundMapping:
    """``idleTimeoutSeconds`` is the only path the bound can arrive by.

    The workflow reads the bound from the PINNED config and nowhere else (C1), so
    if this mapping is wrong the bound silently does not exist — which is exactly
    the defect this ticket fixes, reintroduced one layer down.
    """

    @pytest.mark.asyncio
    async def test_the_idle_bound_maps_from_its_camel_case_key(self, patch_client):
        patch_client({**FULL_PAYLOAD, "idleTimeoutSeconds": 14400})

        config = await fetch_loop_config(
            FetchLoopConfigInput(consultation_id="c-1", tenant_id="t-1")
        )

        assert config.idle_timeout_seconds == 14400.0

    @pytest.mark.asyncio
    async def test_an_absent_bound_leaves_the_loop_unbounded(self, patch_client):
        """The prior gateway shape. None ⇒ the era gate short-circuits."""
        patch_client(FULL_PAYLOAD)

        config = await fetch_loop_config(
            FetchLoopConfigInput(consultation_id="c-1", tenant_id="t-1")
        )

        assert config.idle_timeout_seconds is None

    @pytest.mark.parametrize("raw", ["14400", None, True, {"seconds": 1}])
    @pytest.mark.asyncio
    async def test_a_non_numeric_bound_is_dropped_rather_than_coerced(self, patch_client, raw):
        """A malformed bound must read as "unbounded", never as a coerced number.

        ``True`` is in the list on purpose: it is an ``int`` in Python, so a naive
        ``isinstance(raw, (int, float))`` would pin a one-SECOND idle bound and
        abandon every consultation almost immediately.
        """
        patch_client({**FULL_PAYLOAD, "idleTimeoutSeconds": raw})

        config = await fetch_loop_config(
            FetchLoopConfigInput(consultation_id="c-1", tenant_id="t-1")
        )

        assert config.idle_timeout_seconds is None


class TestUnUpgradedGateway:
    """A gateway that predates sends neither field."""

    @pytest.mark.asyncio
    async def test_an_absent_roster_leaves_the_reasoning_lane_off(self, patch_client):
        payload = {k: v for k, v in FULL_PAYLOAD.items() if k not in {"agents", "reasoningEnabled"}}
        patch_client(payload)

        config = await fetch_loop_config(
            FetchLoopConfigInput(consultation_id="c-1", tenant_id="t-1")
        )

        assert config.reasoning_enabled is False
        assert config.agents == []
        # ...and everything resolved is untouched.
        assert config.enabled is True
        assert [s.kind_key for s in config.subscriptions] == ["transcript"]
        assert config.ending_actions == ["harness.finalize"]

    @pytest.mark.asyncio
    async def test_a_malformed_roster_entry_is_dropped_not_fatal(self, patch_client):
        patch_client(
            {
                **FULL_PAYLOAD,
                "agents": [
                    "not-an-object",
                    {"role": "SPECIALIST"},  # no agentId
                    {"agentId": "agent-ok", "subscribedKinds": ["transcript"]},
                ],
            }
        )

        config = await fetch_loop_config(
            FetchLoopConfigInput(consultation_id="c-1", tenant_id="t-1")
        )

        assert [a.agent_id for a in config.agents] == ["agent-ok"]
        # An entry with no role defaults to SPECIALIST — never to PRIMARY, which
        # would hand note ownership to an agent the tenant never designated.
        assert config.agents[0].role == AGENT_ROLE_SPECIALIST

    @pytest.mark.asyncio
    async def test_non_string_scope_entries_are_filtered_rather_than_coerced(self, patch_client):
        patch_client(
            {
                **FULL_PAYLOAD,
                "agents": [
                    {
                        "agentId": "agent-ok",
                        "role": "SPECIALIST",
                        "subscribedKinds": ["transcript", 42, None],
                        "writeScope": ["finding", {"nested": 1}],
                    }
                ],
            }
        )

        config = await fetch_loop_config(
            FetchLoopConfigInput(consultation_id="c-1", tenant_id="t-1")
        )

        assert config.agents[0].subscribed_kinds == ["transcript"]
        assert config.agents[0].write_scope == ["finding"]
