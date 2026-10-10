"""TASK-1059 OD-2: at runtime the PROMPT is never judged for medical scope.

The medical judge runs on context in the gateway before composition (C-0) and on authored prompts
at save time (C-3). The inbound screen route therefore never asks the screener for the medical
lane — with or without the `medical_internal` exemption, and without stamping that exemption on
the evaluation record.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.api.endpoints.screen import InboundScreenRequest, ScreenRegion, screen_inbound
from guardrail.services.screening import Screener

TENANT = "11111111-1111-1111-1111-111111111111"
SYSTEM = "00000000-0000-0000-0000-000000000000"


class _Analyzer:
    def __init__(self) -> None:
        self.policy = SimpleNamespace(pii_labels=[], benign_labels=None)

    async def classify_tasks(self, task_names, text):
        return dict.fromkeys(task_names, "benign")

    async def extract_pii_entities(self, text):  # pragma: no cover
        return []

    def model_for(self, check):
        return "stub"


class _FakeRequest:
    def __init__(self) -> None:
        self.app = SimpleNamespace(state=SimpleNamespace(analyzer=_Analyzer(), admission_gates={}))
        self.headers = {"X-Tenant-Id": TENANT}


@pytest.fixture
def seen(monkeypatch) -> list[bool]:
    import guardrail.api.endpoints.screen as screen_mod

    calls: list[bool] = []

    class _Recording(Screener):
        async def screen_inbound_regions(self, regions, **kwargs: Any):  # type: ignore[override]
            calls.append(kwargs.get("include_medical", True))
            return await super().screen_inbound_regions(regions, **kwargs)

    async def _build_screener(app_state, tenant_id):
        return _Recording(
            analyzer=app_state.analyzer, tenant_id=tenant_id, policy_source_tenant_id=SYSTEM
        )

    monkeypatch.setattr(screen_mod, "build_screener", _build_screener)
    return calls


@pytest.mark.parametrize("exempt", [None, "medical_internal"])
async def test_the_inbound_screen_never_asks_for_the_medical_lane(
    seen: list[bool], exempt: str | None
) -> None:
    request = InboundScreenRequest(
        regions=[
            ScreenRegion(key="system", text="You are a clinical scribe."),
            ScreenRegion(key="transcript", text="Patient reports chest pain.", trust="data"),
        ],
        exempt=exempt,
    )
    await screen_inbound(request, _FakeRequest())  # type: ignore[arg-type]
    assert seen == [False]
