"""TASK-1050 §11.1 — a platform lock on the SYSTEM row wins at RUNTIME.

The gateway refuses a tenant write to a SYSTEM-locked check, but a tenant entry written
BEFORE the platform admin set the lock must not keep overriding it: the lock is the
platform's statement that tenants have no opinion on that check.
"""

from __future__ import annotations

from guardrail.core.availability import _effective


def _v2(checks: dict) -> dict:
    return {
        "directions": {"inbound": {"enabled": True}, "outbound": {"enabled": True}},
        "checks": checks,
    }


def test_a_system_lock_beats_a_tenant_entry_written_before_the_lock() -> None:
    system = _v2({"prompt_toxicity": {"enabled": True, "action": "block", "locked": True}})
    tenant = _v2({"prompt_toxicity": {"enabled": False, "action": "ignore"}})
    policies, _ = _effective(system, tenant)
    assert policies["prompt_toxicity"]["enabled"] is True
    assert policies["prompt_toxicity"]["action"] == "block"
    assert policies["prompt_toxicity"]["locked"] is True


def test_without_a_system_lock_the_tenant_enabled_flag_still_wins() -> None:
    system = _v2({"prompt_toxicity": {"enabled": True, "action": "block"}})
    tenant = _v2({"prompt_toxicity": {"enabled": False}})
    policies, _ = _effective(system, tenant)
    assert policies["prompt_toxicity"]["enabled"] is False
