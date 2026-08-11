"""Programmable stub activities for ``ConsultationLoopWorkflow`` tests.

Replaces every loop activity (same registered name) with a deterministic stub so
the workflow tests exercise pure orchestration — the pinned config, signal
de-duplication, the depth cap, budget degradation, ``continue_as_new`` and the
child-finalize ``ParentClosePolicy`` — with no network I/O at all. Not collected
by pytest (does not match ``test_*``).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from temporalio import activity

from harness.temporal.models import (
    ConsultationLoopConfig,
    EmitLoopEventInput,
    EmitLoopEventResult,
    FetchLoopConfigInput,
    LiveDocControlInput,
    LiveDocControlResult,
    LoopBudget,
    LoopSubscription,
)


@dataclass
class LoopStubRecorder:
    """Records every stub invocation so a test can assert the dispatch sequence."""

    calls: list[tuple[str, Any]] = field(default_factory=list)

    def record(self, name: str, payload: Any) -> None:
        self.calls.append((name, payload))

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]

    def count(self, name: str) -> int:
        return sum(1 for n, _ in self.calls if n == name)

    def payloads(self, name: str) -> list[Any]:
        return [p for n, p in self.calls if n == name]


@dataclass
class LoopStubConfig:
    """Per-scenario behaviour for the loop stub activity set."""

    # The config the (single) ``fetch_loop_config`` call returns.
    config: ConsultationLoopConfig | None = None
    # Raise from ``fetch_loop_config`` instead of returning (unpinnable config).
    fetch_fails: bool = False
    # Seconds each dispatch activity sleeps — used to open a window in which a
    # signal lands WHILE an activity is in flight.
    dispatch_delay_s: float = 0.0


def default_loop_config(**overrides: Any) -> ConsultationLoopConfig:
    """A servable config subscribing TRANSCRIPT-ish kinds to ``client.emit``."""
    base: dict[str, Any] = {
        "enabled": True,
        "context_schema_version_id": "csv-1",
        "agent_config_version_id": "dav-1",
        "agent_id": "agent-1",
        "department_id": "dept-1",
        "subscriptions": [
            LoopSubscription(kind_key="transcript", actions=["client.emit"]),
            LoopSubscription(kind_key="worknote", actions=["client.emit"]),
        ],
        "budget": LoopBudget(max_depth=2, max_actions=50),
        "start_actions": [],
        "ending_actions": [],
    }
    base.update(overrides)
    return ConsultationLoopConfig(**base)


def make_loop_stub_activities(
    config: LoopStubConfig,
    recorder: LoopStubRecorder,
) -> list[Callable[..., Any]]:
    """Build the stub activity set (registered under the real activity names)."""

    resolved = config.config if config.config is not None else default_loop_config()

    @activity.defn(name="fetch_loop_config")
    async def fetch_loop_config_stub(payload: FetchLoopConfigInput) -> ConsultationLoopConfig:
        recorder.record("fetch_loop_config", payload)
        if config.fetch_fails:
            raise RuntimeError("loop config endpoint unavailable")
        return resolved

    async def _delay() -> None:
        if config.dispatch_delay_s:
            await asyncio.sleep(config.dispatch_delay_s)

    @activity.defn(name="livedoc_start")
    async def livedoc_start_stub(payload: LiveDocControlInput) -> LiveDocControlResult:
        recorder.record("livedoc_start", payload)
        await _delay()
        return LiveDocControlResult(ok=True)

    @activity.defn(name="livedoc_stop")
    async def livedoc_stop_stub(payload: LiveDocControlInput) -> LiveDocControlResult:
        recorder.record("livedoc_stop", payload)
        await _delay()
        return LiveDocControlResult(ok=True)

    @activity.defn(name="emit_loop_event")
    async def emit_loop_event_stub(payload: EmitLoopEventInput) -> EmitLoopEventResult:
        recorder.record("emit_loop_event", payload)
        await _delay()
        return EmitLoopEventResult(emitted=True)

    return [
        fetch_loop_config_stub,
        livedoc_start_stub,
        livedoc_stop_stub,
        emit_loop_event_stub,
    ]
