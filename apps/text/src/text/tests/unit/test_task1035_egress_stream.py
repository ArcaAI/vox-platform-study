"""TASK-1035 OD-7 — streamed text is released a sentence window at a time.

A token cannot be recalled once a client has it, so a streamed generation is
buffered and released only at sentence boundaries, AFTER the window passed the
outbound screen. On a cloud provider the window is re-identified before release,
and a token split across two provider chunks is held back until it is whole. A
blocked window is never emitted: the terminal frame is the error instead.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from text.models.requests import GenerateRequest
from text.models.stream import StreamChunk
from text.services.egress import prepare_egress

_PROVIDER = "azure"


def _task_manager() -> AsyncMock:
    tm = AsyncMock()
    tm.create_task = AsyncMock(return_value=MagicMock(task_id="g-1"))
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    tm.append_batch = AsyncMock()
    tm.is_cancel_requested = AsyncMock(return_value=False)
    return tm


def _provider(*pieces: str) -> Any:
    async def stream(_request):
        for piece in pieces:
            yield StreamChunk(type="chunk", content=piece)
        yield StreamChunk(
            type="usage", data={"prompt_tokens": 3, "predicted_tokens": 4, "total_tokens": 7}
        )
        yield StreamChunk(type="done", data={"finish_reason": "stop"})

    provider = AsyncMock()
    provider.generate_stream = stream
    return provider


class _Guardrail:
    def __init__(self, verdicts: list[dict[str, Any]] | None = None) -> None:
        self.verdicts = verdicts or []
        self.screened: list[str] = []

    async def screen_output(self, response: str, **_: Any) -> dict[str, Any]:
        self.screened.append(response)
        if self.verdicts:
            return self.verdicts.pop(0)
        return {"allowed": True, "reason": "output_screened", "raw": {"decision": "allow"}}


def _released(tm: AsyncMock) -> list[str]:
    """Every delta the producer made durable (the same events subscribers get)."""
    out: list[str] = []
    for call in tm.append_batch.await_args_list:
        for event in call.args[1]:
            payload = json.loads(event.payload)
            if payload.get("type") == "chunk":
                out.append(payload["content"])
    return out


def _terminal(tm: AsyncMock) -> StreamChunk:
    return tm.append_chunk.await_args_list[-1].args[1]


def _cloud_request() -> GenerateRequest:
    return GenerateRequest(
        prompt="Write a note for John Doe.",
        provider=_PROVIDER,
        model="m",
        stream=True,
        known_phi=[{"label": "patient_name", "value": "John Doe"}],
    )


async def _run(tm: AsyncMock, provider: Any, guardrail: Any, request: GenerateRequest) -> Any:
    from text.api.endpoints.generate import _run_streaming_generation

    egress = prepare_egress(request, spans_by_segment=None)
    await _run_streaming_generation(
        tm,
        provider,
        "g-1",
        egress.provider_request,
        provider_name=_PROVIDER,
        model="m",
        tenant_id="t",
        guardrail_client=guardrail,
        egress=egress,
    )
    return egress


async def test_a_token_split_across_chunks_is_restored_and_never_released_half() -> None:
    tm = _task_manager()
    guardrail = _Guardrail()
    egress = await _run(
        tm,
        _provider("[PATIENT_", "NAME_1] is stable. Next [PATI", "ENT_NAME_1] sentence."),
        guardrail,
        _cloud_request(),
    )

    released = _released(tm)
    assert "".join(released) == "John Doe is stable. Next John Doe sentence."
    assert all("[PATI" not in piece for piece in released)
    # The screen saw the PSEUDONYMIZED windows, before restore.
    assert all("John Doe" not in window for window in guardrail.screened)
    assert len(guardrail.screened) >= 2

    terminal = _terminal(tm)
    assert terminal.type == "done"
    assert terminal.data["egress"]["locality"] == "cloud"
    assert terminal.data["egress"]["restored"] == 2
    assert egress.summary.restored == 2
    # What the task record keeps is the restored text.
    final = tm.update_task.await_args_list[-1].kwargs
    assert final["content"] == "John Doe is stable. Next John Doe sentence."


async def test_a_blocked_window_is_never_emitted() -> None:
    tm = _task_manager()
    block = {
        "allowed": False,
        "reason": "response_safety",
        "raw": {"decision": "block", "reasons": ["response_safety"]},
    }
    guardrail = _Guardrail(
        verdicts=[{"allowed": True, "reason": "ok", "raw": {"decision": "allow"}}, block]
    )

    await _run(
        tm,
        _provider("First sentence is fine. ", "Second sentence is harmful."),
        guardrail,
        _cloud_request(),
    )

    released = "".join(_released(tm))
    assert "First sentence is fine." in released
    assert "harmful" not in released
    terminal = _terminal(tm)
    assert terminal.type == "error"
    assert terminal.data["code"] == "GUARDRAIL_REJECTED"
    assert "egress" in terminal.data


async def test_a_cloud_pii_leak_in_a_window_blocks_and_is_flagged() -> None:
    tm = _task_manager()
    leak = {
        "allowed": False,
        "reason": "pii_leak",
        "raw": {"decision": "block", "reasons": ["pii_leak"]},
    }
    egress = await _run(
        tm, _provider("Jane Roe called. "), _Guardrail(verdicts=[leak]), _cloud_request()
    )

    assert _released(tm) == []
    terminal = _terminal(tm)
    assert terminal.type == "error"
    assert terminal.data["code"] == "PII_LEAK_BLOCKED"
    assert terminal.data["egress"]["pii_leak_blocked"] is True
    assert egress.summary.pii_leak_blocked is True
