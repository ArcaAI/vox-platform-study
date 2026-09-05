"""`HarnessPolicy.safetyProvider` / `.safetyModel` are RETIRED.

Phase 2 proved by grep-gate (mutation-verified) that no harness module read either field off
the policy object, and recorded them as the only two `HarnessPolicy` columns Phase 4 could
justify dropping. Phase 4 dropped them: the Prisma columns, the entity/factory/model, both
DTOs, the admin-console controls and these two pydantic fields all went together.

Why nothing was lost. The real safety screen is built from ``settings.guardrail_base_url``
alone (``activities.py::_safety_screen_client``) and ``GuardrailClient.analyze`` POSTs only
``{text, guardrail_type, request_id}``. ``apps/guardrail`` resolves its own provider and model
tenant-first from the ``guardrail.safety`` ``AiRoutingPolicy`` row, fail-closed — the correct home for
that selection since /736, and precisely why these two had nothing left to do.

Why the fields could not simply be left in place. Their defaults were the literal engine name
``lm-studio`` and the literal model id ``granite-guardian-4.1-8b``. With the API no longer
sending the keys, ``from_api``'s fallback would have resolved to those literals on every run —
a hardcoded engine/model selection with no reader, which is exactly what
00-project-context.md Principles rule 1 forbids.

Replay safety. ``HarnessPolicy`` carries ``ConfigDict(extra="ignore")``, so a recorded history
that still contains ``safety_provider`` / ``safety_model`` decodes cleanly against the current
model — the keys are ignored, not rejected. ``test_replay_compat.py`` is the live proof.

This test is the tombstone: it keeps the fields from being reintroduced by reflex, since any
re-add would have to re-answer the questions above rather than restore a mirror of a column
that no longer exists.
"""

from __future__ import annotations

import pytest

_RETIRED_FIELDS = ["safety_provider", "safety_model"]


@pytest.mark.parametrize("field", _RETIRED_FIELDS)
def test_the_retired_field_is_no_longer_a_policy_field(field: str) -> None:
    from harness.temporal.models import HarnessPolicy

    assert field not in HarnessPolicy.model_fields, (
        f"`HarnessPolicy.{field}` was retired in  Phase 4 together with its Prisma "
        "column. Re-adding it re-creates a hardcoded engine/model selection with no reader — "
        "the guardrail selection lives in the `guardrail.safety` AiRoutingPolicy row, resolved by "
        "apps/guardrail tenant-first. If this is deliberate wiring, delete this test WITH the "
        "ticket that justifies it."
    )


@pytest.mark.parametrize("field", _RETIRED_FIELDS)
def test_a_recorded_history_carrying_the_retired_field_still_decodes(field: str) -> None:
    """`extra="ignore"` is what makes the removal replay-safe — assert it, don't assume it."""
    from harness.temporal.models import HarnessPolicy

    policy = HarnessPolicy.model_validate({field: "granite-guardian-4.1-8b", "max_regen": 3})

    assert policy.max_regen == 3
    assert not hasattr(policy, field)
