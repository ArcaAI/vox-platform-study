"""Two worker-log defects seen on the cluster.

* ``interpreter.load_config`` takes only a content-addressed ``ClaimCheckRef`` — it carries no
  tenant and must not (the ref is a stable, replayed shape). Its CPU sample is a DECLARED
  tenant-less drop, logged at debug, not a ``sample_dropped_no_tenant`` warning per run.
  An undeclared activity with no tenant still warns.
* An httpx failure whose ``str()`` is empty (``ReadTimeout``) produced
  ``... failed:  `` — the live-handoff warning carried no reason at all.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any

import httpx
import pytest
from temporalio.testing import ActivityEnvironment
from temporalio.worker import ExecuteActivityInput

from harness.services.api_client import _api_error
from harness.temporal.claim_check import ClaimCheckRef
from harness.temporal.compute_metering import (
    TENANTLESS_ACTIVITY_TYPES,
    ComputeMeteringInterceptor,
    ComputeSample,
    reset_cpu_ledgers,
)


class _Terminal:
    def __init__(self, body) -> None:
        self._body = body

    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        return await self._body(input)


class _Collector:
    def __init__(self) -> None:
        self.samples: list[ComputeSample] = []

    def offer(self, sample: ComputeSample) -> None:
        self.samples.append(sample)


@pytest.fixture(autouse=True)
def _fresh():
    reset_cpu_ledgers()
    yield
    reset_cpu_ledgers()


def _ref() -> ClaimCheckRef:
    return ClaimCheckRef(store="mem", bucket="b", key="k", size=1, sha256="0" * 64)


async def _drive(activity_type: str, payload: Any, collector: _Collector) -> Any:
    env = ActivityEnvironment()
    env.info = dataclasses.replace(env.info, activity_type=activity_type)

    async def _body(_input: ExecuteActivityInput) -> str:
        return "ok"

    inbound = ComputeMeteringInterceptor(collector).intercept_activity(_Terminal(_body))
    activity_input = ExecuteActivityInput(fn=_body, args=[payload], executor=None, headers={})

    async def _run() -> Any:
        return await inbound.execute_activity(activity_input)

    return await env.run(_run)


def test_load_config_is_declared_tenantless():
    assert "interpreter.load_config" in TENANTLESS_ACTIVITY_TYPES
    assert TENANTLESS_ACTIVITY_TYPES["interpreter.load_config"]


@pytest.mark.asyncio
async def test_load_config_sample_drop_does_not_warn(caplog):
    collector = _Collector()
    with caplog.at_level(logging.DEBUG):
        assert await _drive("interpreter.load_config", _ref(), collector) == "ok"
    assert collector.samples == []
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert not any("sample_dropped_no_tenant" in r.getMessage() for r in warnings)
    assert any("sample_tenantless" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_an_undeclared_activity_without_tenant_still_warns(caplog):
    collector = _Collector()
    with caplog.at_level(logging.WARNING):
        await _drive("interpreter.something_else", _ref(), collector)
    assert any("sample_dropped_no_tenant" in r.getMessage() for r in caplog.records)


def test_api_error_names_an_exception_whose_text_is_empty():
    err = _api_error("/consultations/c/live-handoff", httpx.ReadTimeout(""))
    assert "ReadTimeout" in str(err)


def test_api_error_keeps_a_non_empty_message_unchanged():
    err = _api_error("/policy", httpx.ConnectError("connection refused"))
    assert str(err) == "apps/api /policy failed: connection refused"
