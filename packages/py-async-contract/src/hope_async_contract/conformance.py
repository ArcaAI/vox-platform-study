"""The reusable conformance suite (TASK-717 Task 6) — Python twin of
``@arcaai/async-contract``'s ``assertAsyncConformance``
(``packages/async-contract/src/conformance/index.ts``).

Exported from the package root so a Python producer (the TASK-717 Task 5
reference adoption on ``apps/text``, and any future Python adopter) can be
checked without re-deriving what "conforms to the envelope" means. Mirrors
the TypeScript suite assertion-for-assertion — see that module's docstring
for the full rationale; this one restates only what differs (Python's
duck-typed optional protocol members, `asyncio` instead of `Promise`).

``assert_async_conformance`` never raises; every check appends a problem
string instead. An empty return means the producer conforms.
"""

from __future__ import annotations

import re
from typing import Any, Protocol, runtime_checkable

from hope_async_contract.envelope import envelope_problems, parse_async_envelope

#: How many envelopes to produce for the volume/uniqueness assertions (Task 6 assertion 2).
PRODUCTION_VOLUME = 1000
#: Index at which the mid-stream resume assertion cuts the stream.
MID_STREAM_INDEX = 5

#: UUIDv7: version nibble `7`, variant nibble `8`-`b`.
_UUIDV7_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_TYPE_PATTERN = re.compile(r"^[a-z0-9]+(\.[a-z0-9_]+){1,4}$")

#: Shape of one produced envelope, once it has passed the "is a dict" gate.
Envelope = dict[str, Any]


@runtime_checkable
class AsyncProducerUnderTest(Protocol):
    """The producer contract a transport-specific adopter implements.

    ``replay`` and ``resume_token_of`` are OPTIONAL, exactly as in the
    TypeScript twin — Python has no clean way to express "optional Protocol
    method", so the suite below probes for them with ``getattr`` instead of
    requiring them structurally.
    """

    resumable: bool

    async def produce(
        self, event_type: str, payload: object, correlation_id: str
    ) -> object:
        """Produce one envelope for a given logical event."""
        ...


def _as_envelopes(values: list[object]) -> list[Envelope]:
    return [value for value in values if isinstance(value, dict)]


async def assert_async_conformance(producer: AsyncProducerUnderTest) -> list[str]:
    """Run every assertion from TASK-717 Task 6 against ``producer``.

    Returns the list of problems found — empty means the producer conforms
    to the async envelope contract.
    """
    problems: list[str] = []

    produced: list[object] = []
    try:
        fixed_correlation_id = "conformance-fixed"
        for i in range(PRODUCTION_VOLUME):
            # The first two productions replay the SAME logical event (so the
            # suite can assert occurredAt/idempotencyKey stability across a
            # redelivery); every later one is a distinct event (so it can
            # assert uniqueness/differentiation at volume).
            if i < 2:
                correlation_id, payload = fixed_correlation_id, {"n": 0}
            else:
                correlation_id, payload = f"conformance-{i}", {"n": i}
            produced.append(
                await producer.produce(
                    "conformance.test.event", payload, correlation_id
                )
            )
    except (
        Exception
    ) as exc:  # noqa: BLE001 — surfaced as a problem string, never raised
        problems.append(f"produce() threw: {exc}")
        return problems

    # 1. every produced value satisfies envelope_problems -> empty
    for i, value in enumerate(produced):
        for problem in envelope_problems(value):
            problems.append(f"production[{i}]: {problem}")

    envelopes = _as_envelopes(produced)

    # 2. id is unique across PRODUCTION_VOLUME productions and UUIDv7-shaped
    ids = [e["id"] for e in envelopes if isinstance(e.get("id"), str)]
    if len(set(ids)) != len(ids):
        problems.append("id is not unique across productions")
    for i, envelope_id in enumerate(ids):
        if not _UUIDV7_PATTERN.match(envelope_id):
            problems.append(f"production[{i}]: id {envelope_id!r} is not UUIDv7-shaped")

    # 3. tenantId present and never null/empty
    for i, e in enumerate(envelopes):
        tenant_id = e.get("tenantId")
        if not isinstance(tenant_id, str) or len(tenant_id) == 0:
            problems.append(f"production[{i}]: tenantId is missing or empty")

    # 4. type matches the grammar
    for i, e in enumerate(envelopes):
        event_type = e.get("type")
        if not isinstance(event_type, str) or not _TYPE_PATTERN.match(event_type):
            problems.append(f"production[{i}]: type does not match the grammar")

    first: Envelope | None = envelopes[0] if len(envelopes) > 0 else None
    second: Envelope | None = envelopes[1] if len(envelopes) > 1 else None

    # 5. occurredAt does not change across a redelivery of the same logical event
    if first is not None and second is not None:
        if first.get("occurredAt") != second.get("occurredAt"):
            problems.append(
                "occurredAt changed across two productions of the same logical event"
            )

    # 6. idempotencyKey stable across repeats of the same event, differs across distinct events
    if first is not None and second is not None:
        if first.get("idempotencyKey") != second.get("idempotencyKey"):
            problems.append(
                "idempotencyKey is not stable across two productions of the same logical event"
            )
    distinct_keys = [e.get("idempotencyKey") for e in envelopes[2:]]
    if len(set(distinct_keys)) != len(distinct_keys):
        problems.append("idempotencyKey does not differ across distinct logical events")

    # 7. payload XOR payloadRef — already enforced per-envelope by assertion 1 above.

    # 8. a payloadRef, when present, is shape-valid (fail-loud on a malformed ref).
    #    Fetching and hashing the referenced blob is out of this suite's scope — it
    #    has no blob-store handle; the adopting surface's own tests own that half.
    for i, e in enumerate(envelopes):
        if "payloadRef" in e and envelope_problems(e):
            problems.append(f"production[{i}]: payloadRef is malformed")

    # 9. correlationId propagated unchanged (nothing to check beyond assertion 1's shape
    #    check — correlationId is caller-supplied and echoed, not derived); causationId,
    #    when set, names a previously produced id.
    seen_ids: set[str] = set()
    for i, e in enumerate(envelopes):
        causation_id = e.get("causationId")
        if isinstance(causation_id, str) and causation_id not in seen_ids:
            problems.append(
                f"production[{i}]: causationId {causation_id!r} does not name a "
                "previously produced id"
            )
        envelope_id = e.get("id")
        if isinstance(envelope_id, str):
            seen_ids.add(envelope_id)

    # 10. unknown schemaVersion -> refusal, not a partial parse
    if first is not None:
        unknown_version: Envelope = dict(first)
        unknown_version["schemaVersion"] = 999
        if parse_async_envelope(unknown_version) is not None:
            problems.append(
                "parse_async_envelope did not refuse an unknown schemaVersion"
            )

    # 11 & 12. resume tokens (design doc §3.6)
    resumable = getattr(producer, "resumable", False)
    replay = getattr(producer, "replay", None)
    resume_token_of = getattr(producer, "resume_token_of", None)
    if resumable:
        if replay is None:
            problems.append("resumable producer must implement replay()")
        elif resume_token_of is not None:
            mid_envelope = (
                produced[MID_STREAM_INDEX] if len(produced) > MID_STREAM_INDEX else None
            )
            token = resume_token_of(mid_envelope)
            if not token:
                problems.append(
                    "resume_token_of did not return a token for a resumable producer"
                )
            else:
                try:
                    suffix = await replay(token)
                    expected_ids = [
                        e.get("id") for e in envelopes[MID_STREAM_INDEX + 1 :]
                    ]
                    actual_ids = [e.get("id") for e in _as_envelopes(suffix)]
                    if actual_ids != expected_ids:
                        problems.append(
                            "replay from a mid-stream token did not yield exactly the "
                            "suffix (gap or duplicate detected)"
                        )
                except Exception as exc:  # noqa: BLE001 — surfaced as a problem string
                    problems.append(f"replay() threw: {exc}")
    elif replay is not None:
        problems.append(
            "a non-resumable producer must not implement replay() — a resume token that "
            "cannot resume is worse than none (§3.6)"
        )

    return problems
