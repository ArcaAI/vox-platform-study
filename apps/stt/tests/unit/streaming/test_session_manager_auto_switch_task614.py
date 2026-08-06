"""Tenant auto-switch governance reaching the session (TASK-614 D-10).

``autoSwitchEnabled`` and ``consecutiveFailureThreshold`` are real tenant
settings — stored on ``TenantSttConfig``, resolved through
``resolveEffectiveSttConfig``, exposed on the effective-config API — but they
were never sent to STT. ``EngineSwitchController`` therefore always constructed
with its own defaults (``True`` / ``2``), so a tenant that switched auto-fallback
OFF still got auto-fallback, and a tenant that raised the failure threshold was
ignored.

The heavy assembly is mocked but the REAL ``_make_switch_controller`` is bound,
so these assert the controller's actual behaviour rather than a passed argument.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from test_session_manager_start_on import _create, _make_manager  # noqa: E402

from stt.core.exceptions import CloudASRTranscriptionError


def _arm_for_switch(mgr) -> None:
    """Make an actual engine swap survivable on the mocked manager.

    The start_on suite never lets a switch FIRE, so its double leaves the two
    async members the swap touches un-mocked. Set after `create_session` —
    the controller's closures resolve them at switch time, not at build time.
    """
    mgr._build_fallback_asr_callable = AsyncMock(return_value=MagicMock())
    mgr._build_primary_asr_callable = AsyncMock(return_value=MagicMock())
    publisher = mgr._publishers.get("s1")
    if publisher is not None:
        publisher.publish_provider_switched = AsyncMock()


async def _fail_utterances(ctrl, count: int) -> None:
    """Drive `count` consecutive threshold-class failures through the controller."""
    for index in range(count):
        await ctrl.record_failure(CloudASRTranscriptionError("5xx"), utterance_index=index)


@pytest.mark.asyncio
async def test_auto_switch_disabled_by_the_tenant_never_auto_switches():
    mgr = _make_manager()

    await _create(mgr, fallback_pipeline_id="fb-pipe", auto_switch_enabled=False)
    ctrl = mgr._switch_controllers["s1"]

    # Well past any threshold — the tenant said no.
    await _fail_utterances(ctrl, 5)

    assert ctrl.switched is False
    assert ctrl.active_engine == "primary"


@pytest.mark.asyncio
async def test_auto_switch_defaults_to_enabled_when_the_gateway_says_nothing():
    # Regression lock: an older gateway that sends neither field must keep the
    # pre-614 behaviour exactly.
    mgr = _make_manager()

    await _create(mgr, fallback_pipeline_id="fb-pipe")
    _arm_for_switch(mgr)
    ctrl = mgr._switch_controllers["s1"]

    await _fail_utterances(ctrl, 2)

    assert ctrl.switched is True


@pytest.mark.asyncio
async def test_tenant_failure_threshold_is_honoured():
    mgr = _make_manager()

    await _create(mgr, fallback_pipeline_id="fb-pipe", consecutive_failure_threshold=4)
    _arm_for_switch(mgr)
    ctrl = mgr._switch_controllers["s1"]

    # Three failures is the DEFAULT threshold exceeded but this tenant's not met.
    await _fail_utterances(ctrl, 3)
    assert ctrl.switched is False

    await _fail_utterances(ctrl, 1)
    assert ctrl.switched is True
