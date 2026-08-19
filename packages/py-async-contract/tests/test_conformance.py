"""assert_async_conformance — mirrors src/conformance/__tests__/self.test.ts."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from hope_async_contract.conformance import (
    AsyncProducerUnderTest,
    assert_async_conformance,
)
from hope_async_contract.envelope import ASYNC_ENVELOPE_SCHEMA_VERSION
from hope_async_contract.resume_token import decode_resume_token, encode_resume_token


def _hash_seconds(value: str) -> int:
    """Deterministic 0-59 hash so two productions of the same event share ``occurredAt``."""
    total = 0
    for ch in value:
        total = (total * 31 + ord(ch)) % 60
    return total


def _test_uuid_v7(counter: int) -> str:
    hex_part = format(counter, "012x")
    return f"00000000-0000-7000-8000-{hex_part}"


def _occurred_at(correlation_id: str) -> str:
    return datetime(
        2026, 1, 1, 0, 0, _hash_seconds(correlation_id), tzinfo=UTC
    ).isoformat()


class FakeResumableProducer:
    """An in-memory, well-behaved, resumable producer — the self-test double for the suite."""

    def __init__(self) -> None:
        self.resumable = True
        self._log: list[tuple[str, dict]] = []
        self._counter = 0

    async def produce(
        self, event_type: str, payload: object, correlation_id: str
    ) -> object:
        envelope = {
            "schemaVersion": ASYNC_ENVELOPE_SCHEMA_VERSION,
            "id": _test_uuid_v7(self._counter),
            "tenantId": "00000000-0000-0000-0000-000000000000",
            "type": event_type,
            "occurredAt": _occurred_at(correlation_id),
            "correlationId": correlation_id,
            "causationId": None,
            "idempotencyKey": f"{event_type}:{correlation_id}",
            "payload": payload,
        }
        token = encode_resume_token("in-memory", str(self._counter))
        self._log.append((token, envelope))
        self._counter += 1
        return envelope

    async def replay(self, token: str) -> list[object]:
        decoded = decode_resume_token(token)
        if decoded is None:
            return []
        from_index = int(decoded["cursor"])
        return [
            envelope for i, (_t, envelope) in enumerate(self._log) if i > from_index
        ]

    def resume_token_of(self, produced: object) -> str | None:
        for token, envelope in self._log:
            if envelope is produced:
                return token
        return None


class FakeNonResumableProducer:
    """A non-resumable producer that correctly declines to implement replay()."""

    def __init__(self) -> None:
        self.resumable = False
        self._counter = 0

    async def produce(
        self, event_type: str, payload: object, correlation_id: str
    ) -> object:
        self._counter += 1
        return {
            "schemaVersion": ASYNC_ENVELOPE_SCHEMA_VERSION,
            "id": _test_uuid_v7(self._counter),
            "tenantId": "00000000-0000-0000-0000-000000000000",
            "type": event_type,
            "occurredAt": _occurred_at(correlation_id),
            "correlationId": correlation_id,
            "causationId": None,
            "idempotencyKey": f"{event_type}:{correlation_id}",
            "payload": payload,
        }


class BadProducer:
    resumable = False

    async def produce(
        self, event_type: str, payload: object, correlation_id: str
    ) -> object:
        return {"not": "an envelope"}


class MisdeclaredProducer(FakeNonResumableProducer):
    """Declares resumable but has no replay()."""

    def __init__(self) -> None:
        super().__init__()
        self.resumable = True


def test_isinstance_check_recognizes_a_conforming_producer() -> None:
    assert isinstance(FakeResumableProducer(), AsyncProducerUnderTest)


def test_passes_against_a_well_behaved_resumable_producer() -> None:
    problems = asyncio.run(assert_async_conformance(FakeResumableProducer()))
    assert problems == []


def test_passes_against_a_well_behaved_non_resumable_producer() -> None:
    problems = asyncio.run(assert_async_conformance(FakeNonResumableProducer()))
    assert problems == []


def test_reports_problems_for_a_producer_emitting_non_conforming_envelopes_never_throws() -> (
    None
):
    problems = asyncio.run(assert_async_conformance(BadProducer()))
    assert len(problems) > 0


def test_flags_a_resumable_producer_that_declares_resumable_but_has_no_replay() -> None:
    problems = asyncio.run(assert_async_conformance(MisdeclaredProducer()))
    assert "resumable producer must implement replay()" in problems
