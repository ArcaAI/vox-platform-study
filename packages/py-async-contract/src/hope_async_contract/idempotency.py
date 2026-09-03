"""Idempotency-key convention for the async envelope.

============================================================================
THE ONE RULE, restated from ``packages/applications/src/services/usageLedger/
idempotency-keys.ts:3-26`` (the module this convention is generalized from —
read its header before touching this file):

    A KEY IS DERIVED FROM INTENT, NEVER FROM CHANCE.

Every transport this contract documents is at-least-once. An
``idempotencyKey`` minted from a clock, a counter, or a random uuid makes
every redelivery a NEW event, which defeats the only mechanism a consumer has
for collapsing duplicates. The key must be a pure function of WHAT happened.

COROLLARY, carried over unchanged: the abort/failure path uses the SAME key
as the completion path for the same intent.
============================================================================
"""

from __future__ import annotations

import re

#: Hard ceiling on a key. Bounded so a pathological id cannot bloat a unique index.
MAX_IDEMPOTENCY_KEY_LENGTH = 255

#: No whitespace, no control characters, bounded length.
_IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[\x21-\x7e]{1,255}$")


def idempotency_key_problems(key: object) -> list[str]:
    """Problems with an ``idempotencyKey`` value. Empty list = conforms. Never raises."""
    if not isinstance(key, str) or len(key) == 0:
        return ["idempotencyKey must be a non-empty string"]
    if len(key) > MAX_IDEMPOTENCY_KEY_LENGTH:
        return [
            f"idempotencyKey must be at most {MAX_IDEMPOTENCY_KEY_LENGTH} characters "
            f"(received {len(key)})"
        ]
    if not _IDEMPOTENCY_KEY_PATTERN.match(key):
        return ["idempotencyKey must contain no whitespace or control characters"]
    return []


def _require_id(value: str, name: str) -> str:
    """Reject a blank intent id — a blank id collapses every event onto ONE key."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"AsyncIdempotencyKey: {name} is required and must be non-blank"
        )
    return value.strip()


class AsyncIdempotencyKey:
    """Intent-derived recipes ( recipe table). Mirrors idempotency.ts."""

    @staticmethod
    def stt_segment(session_id: str, utterance_index: int) -> str:
        """``stt:session:<sessionId>:seg:<utteranceIndex>``."""
        return (
            f"stt:session:{_require_id(session_id, 'session_id')}:seg:{utterance_index}"
        )

    @staticmethod
    def text_chunk(task_id: str, sequence: int) -> str:
        """``text:task:<taskId>:chunk:<sequence>``."""
        return f"text:task:{_require_id(task_id, 'task_id')}:chunk:{sequence}"

    @staticmethod
    def workflow_node(run_id: str, node_id: str, attempt_generation: int) -> str:
        """``wf:run:<runId>:node:<nodeId>:<attemptGeneration>``."""
        run = _require_id(run_id, "run_id")
        node = _require_id(node_id, "node_id")
        return f"wf:run:{run}:node:{node}:{attempt_generation}"

    @staticmethod
    def webhook_delivery(subscription_id: str, source_envelope_id: str) -> str:
        """``hook:<subscriptionId>:<sourceEnvelopeId>``."""
        return (
            f"hook:{_require_id(subscription_id, 'subscription_id')}:"
            f"{_require_id(source_envelope_id, 'source_envelope_id')}"
        )
