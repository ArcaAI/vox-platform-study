"""TASK-1059 lane D — outbound locality (contract C-2, owner OD-3) and RC-9.

* `POST /guardrail/screen/outbound` takes an optional `locality` (`local` | `cloud`). On a
  LOCAL model whose ONLY blocking check is `pii_leak`, the decision is `warn` (record-only):
  the notice is `guardrail.warning`, never `guardrail.blocked`, and the evaluation record
  says `decision: "warn"` — so the gateway ingest never puts the consultation on hold.
  Cloud, absent locality, and any other blocking check are unchanged.
* `pii_leak` span extraction ignores the note's inline citation labels (`[S7]`, `[S7 E1]`,
  `[S8/S9]`, `[S7, S8]`) and bracketed composer region keys (`[encounter_1]`,
  `[previous_visits]`, `[results]` …) — they are not leaked identifiers. Real PII outside
  the brackets is still caught.

Fakes only: a stub analyzer whose PII extractor behaves like the zero-shot model that
flagged region keys as `encounter_id` in the TASK-1058 e2e.
"""

from __future__ import annotations

import re
from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.core.availability import GuardrailAvailability
from guardrail.services.screening import Screener

TENANT = "50000000-0000-0000-0000-000000000000"
SOURCE = "Patient reports a dry cough for three days. No fever."

_EMAIL = re.compile(r"[\w.]+@[\w.]+\w")
_PHONE = re.compile(r"\+?\d[\d -]{8,}\d")
#: What the zero-shot model flagged in the e2e: the label tokens themselves.
_LABEL_TOKEN = re.compile(r"encounter_\d+|previous_visits|results|\bS\d+(?: E\d+)?")


class _Analyzer:
    def __init__(self, unsafe_word: str | None = None) -> None:
        self.unsafe_word = unsafe_word

    async def classify_tasks(self, task_names: Any, text: str) -> dict[str, Any]:
        bad = bool(self.unsafe_word and self.unsafe_word in text)
        return {task: ["unsafe" if bad else "benign"] for task in task_names}

    async def extract_pii_entities(self, text: str) -> list[Any]:
        spans: list[Any] = []
        for pattern, label in (
            (_EMAIL, "email"),
            (_PHONE, "phone_number"),
            (_LABEL_TOKEN, "encounter_id"),
        ):
            spans.extend(
                SimpleNamespace(label=label, start=m.start(), end=m.end(), score=0.95)
                for m in pattern.finditer(text)
            )
        return spans

    def model_for(self, check: str) -> str:
        return "pii-model"


class _RecordingOutbox:
    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    async def append(self, record: dict[str, Any]) -> bool:
        self.records.append(record)
        return True


def _request(outbox: Any) -> Any:
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(admission_gates={}, evaluation_outbox=outbox)),
        headers={"X-Tenant-Id": TENANT, "X-Hope-Consultation-Id": "c-1"},
    )


def _availability(*, response_safety: bool = False) -> GuardrailAvailability:
    checks: dict[str, Any] = {"pii_leak": {"enabled": True, "action": "block"}}
    if response_safety:
        checks["response_safety"] = {"enabled": True, "action": "block"}
    return GuardrailAvailability.from_tiers(system_blob={"checks": checks}, tenant_blob=None)


async def _screen(
    monkeypatch: Any,
    response: str,
    *,
    locality: str | None,
    unsafe_word: str | None = None,
) -> tuple[Any, dict[str, Any]]:
    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import OutboundScreenRequest, screen_outbound

    async def _build(app_state: Any, tenant_id: str, **_: Any) -> Screener:
        return Screener(
            analyzer=_Analyzer(unsafe_word),
            tenant_id=tenant_id,
            availability=_availability(response_safety=unsafe_word is not None),
            policy_version="pv-1",
        )

    monkeypatch.setattr(screen_mod, "build_screener", _build)
    body: dict[str, Any] = {
        "response": response,
        "source_regions": [{"key": "encounter_1", "text": SOURCE}],
        "response_items": [{"itemId": "note-1", "itemVersion": 2}],
    }
    if locality is not None:
        body["locality"] = locality
    outbox = _RecordingOutbox()
    result = await screen_outbound(OutboundScreenRequest(**body), _request(outbox))  # type: ignore[arg-type]
    (record,) = outbox.records
    return result, record


def _pii(result: Any) -> dict[str, Any]:
    return next(check for check in result.checks if check["name"] == "pii_leak")


LEAKY = "Dry cough for three days. Contact jane.doe@example.com for follow-up."


# ── C-2 / OD-3: locality ────────────────────────────────────────────────────


def test_the_request_declares_locality() -> None:
    from guardrail.api.endpoints.screen import OutboundScreenRequest

    assert OutboundScreenRequest(response="x", locality="local").locality == "local"
    assert OutboundScreenRequest(response="x").locality is None
    with pytest.raises(ValueError):
        OutboundScreenRequest(response="x", locality="edge")


@pytest.mark.asyncio
async def test_local_pii_leak_only_is_a_warning_never_a_hold(monkeypatch: Any) -> None:
    result, record = await _screen(monkeypatch, LEAKY, locality="local")

    assert result.guardrail_decision == "warn"
    assert result.decision == "allow"
    assert _pii(result)["verdict"] == "flag"
    assert _pii(result)["actionTaken"] == "warn"
    assert [notice["type"] for notice in result.notices] == ["guardrail.warning"]
    assert result.notices[0]["resumable"] is False
    assert record["decision"] == "warn"
    assert "withheldContent" not in record


@pytest.mark.asyncio
async def test_local_pii_leak_with_another_block_still_blocks(monkeypatch: Any) -> None:
    result, record = await _screen(
        monkeypatch, LEAKY + " UNSAFE", locality="local", unsafe_word="UNSAFE"
    )

    assert result.decision == "block"
    assert result.guardrail_decision == "block"
    assert {"response_safety", "pii_leak"} <= set(result.reasons)
    assert "guardrail.blocked" in [notice["type"] for notice in result.notices]
    assert record["decision"] == "block"


@pytest.mark.asyncio
@pytest.mark.parametrize("locality", ["cloud", None])
async def test_cloud_or_unknown_pii_leak_blocks(monkeypatch: Any, locality: str | None) -> None:
    result, record = await _screen(monkeypatch, LEAKY, locality=locality)

    assert result.decision == "block"
    assert result.reasons == ["pii_leak"]
    assert [notice["type"] for notice in result.notices] == ["guardrail.blocked"]
    assert record["decision"] == "block"


# ── RC-9: citation labels and region keys are not leaked identifiers ────────

LABELLED = (
    "Dry cough for three days [S7]. No fever [S7 E1]. Cough worse at night [S8/S9]. "
    "Started three days ago [S7, S8]. As discussed [encounter_1]. Prior history "
    "[encounter_2, previous_visits] and [previous_visits]; labs normal [results]."
)


@pytest.mark.asyncio
async def test_citation_labels_and_region_keys_are_not_flagged(monkeypatch: Any) -> None:
    result, record = await _screen(monkeypatch, LABELLED, locality="cloud")

    assert _pii(result)["outcome"] == "pass", _pii(result)
    assert result.decision == "allow"
    assert result.notices == []
    assert record["decision"] == "allow"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("extra", "label"),
    [
        (" Email jane.doe@example.com.", "email"),
        (" Call +91 98765 43210 tomorrow.", "phone_number"),
    ],
)
async def test_real_pii_beside_labels_is_still_caught(
    monkeypatch: Any, extra: str, label: str
) -> None:
    result, _record = await _screen(monkeypatch, LABELLED + extra, locality="cloud")

    pii = _pii(result)
    assert pii["outcome"] == "flag"
    assert pii["labels"] == [label]
    assert result.decision == "block"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("cough [S7] fever", "cough   fever"),
        ("seen [encounter_12] and [S7, encounter_1].", "seen   and  ."),
        ("[ledger_2/pre_summary] ok", "  ok"),
        # Not a label: unbracketed words, unknown keys and real text in brackets stay.
        ("Results normal; encounter_1 noted", "Results normal; encounter_1 noted"),
        (
            "[John Smith] [mrn_123] [S] [results of CBC]",
            "[John Smith] [mrn_123] [S] [results of CBC]",
        ),
    ],
)
def test_strip_note_labels_is_narrow(text: str, expected: str) -> None:
    from guardrail.services.screening import strip_note_labels

    assert strip_note_labels(text) == expected
