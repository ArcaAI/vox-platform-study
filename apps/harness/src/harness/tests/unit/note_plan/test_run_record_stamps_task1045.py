"""Run-record stamps (P-E §1f): every note LLM_CALL / NODE step names its ``activity_kind``.

The gateway writes an ``AiActivityRun`` only for a step that declares one, so a note written by
the single-call ``generate`` (no NotePlan) used to leave no record at all. Its call is the one
section group of a one-call note; the note record itself (``NOTE_GENERATE`` + the persisted
``context_item_id`` / ``output_version``) is stamped by ``persist_draft``.
"""

from __future__ import annotations

import dataclasses
import datetime
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.core.config import Settings
from harness.services.api_client import DraftResponse, TrajectoryReportResponse
from harness.services.text_client import TextGenerationResult, TextServiceError
from harness.temporal import activities
from harness.temporal.models import GenerateInput, PersistDraftInput, TrajectoryContext

_TENANT = "11111111-1111-1111-1111-111111111111"


class _CapTraj:
    def __init__(self) -> None:
        self.steps: list[Any] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)
        return TrajectoryReportResponse(accepted=len(steps))


class _Text:
    def __init__(self, failing: set[str]) -> None:
        self.failing = failing

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        if kwargs.get("provider") in self.failing:
            raise TextServiceError(f"{kwargs['provider']} down")
        return TextGenerationResult(
            content="DRAFT", model=kwargs["model"], provider=kwargs["provider"]
        )


@pytest.fixture
def env() -> ActivityEnvironment:
    environment = ActivityEnvironment()
    environment.info = dataclasses.replace(
        environment.info, start_to_close_timeout=datetime.timedelta(minutes=30)
    )
    return environment


def _generate_input(**over: Any) -> GenerateInput:
    payload: dict[str, Any] = {
        "tenant_id": _TENANT,
        "prompt": "Write the note.",
        "provider": "lmstudio",
        "model": "gemma-4-e2b-it-qat",
        "hyperparameters": {"max_tokens": 2048},
        "trajectory": TrajectoryContext(tenant_id=_TENANT, consultation_id="c-1", seq=16),
    }
    payload.update(over)
    return GenerateInput(**payload)


async def test_the_single_call_generate_step_is_a_one_call_section_group(env, monkeypatch) -> None:
    cap = _CapTraj()
    monkeypatch.setattr(activities, "_text_client", lambda _s: _Text(set()))
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)

    await env.run(activities.generate, _generate_input())

    [step] = [s for s in cap.steps if s.step_type == "LLM_CALL"]
    assert step.stats["activity_kind"] == "NOTE_SECTION_GROUP"
    assert step.stats["call_index"] == 1
    assert step.stats["call_count"] == 1
    assert step.stats["max_tokens"] == 2048


async def test_a_lost_candidate_of_the_single_call_is_recorded_as_the_same_kind(
    env, monkeypatch
) -> None:
    cap = _CapTraj()
    monkeypatch.setattr(activities, "_text_client", lambda _s: _Text({"lmstudio"}))
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)
    fallback = {
        "autoSwitch": True,
        "chain": [
            {
                "kind": "platform-default",
                "agent": {"slug": "x"},
                "modelSlug": "gemma",
                "provider": "vllm",
                "model": "google/gemma",
            }
        ],
    }

    await env.run(activities.generate, _generate_input(text_fallback=fallback))

    kinds = sorted((s.status, s.stats["activity_kind"]) for s in cap.steps)
    assert kinds == [("ERROR", "NOTE_SECTION_GROUP"), ("OK", "NOTE_SECTION_GROUP")]


class _Api:
    async def persist_draft(self, consultation_id: str, **kwargs: Any) -> DraftResponse:
        return DraftResponse(context_item_id="ctx-note-1", version_number=3)


async def test_persist_draft_stamps_the_note_record_with_the_persisted_item_and_version(
    env, monkeypatch
) -> None:
    cap = _CapTraj()
    monkeypatch.setattr(activities, "get_settings", lambda: Settings())
    monkeypatch.setattr(activities, "_api_client", lambda _s: _Api())
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: cap)

    await env.run(
        activities.persist_draft,
        PersistDraftInput(
            consultation_id="c-1",
            tenant_id=_TENANT,
            user_id="u-1",
            job_id="j-1",
            content="NOTE",
            note_run_stats={"activity_kind": "NOTE_GENERATE", "call_count": 1},
            trajectory=TrajectoryContext(tenant_id=_TENANT, consultation_id="c-1", seq=32),
        ),
    )

    [node] = [s for s in cap.steps if s.step_type == "NODE"]
    assert node.seq == 33
    assert node.stats == {
        "activity_kind": "NOTE_GENERATE",
        "call_count": 1,
        "context_item_id": "ctx-note-1",
        "output_version": 3,
    }
