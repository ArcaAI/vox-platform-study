"""Idempotency-key grammar + recipes — mirrors src/__tests__/idempotency.test.ts."""

from __future__ import annotations

import pytest

from hope_async_contract.idempotency import (
    MAX_IDEMPOTENCY_KEY_LENGTH,
    AsyncIdempotencyKey,
    idempotency_key_problems,
)


class TestIdempotencyKeyProblems:
    def test_accepts_a_well_formed_key(self) -> None:
        assert idempotency_key_problems("stt:session:abc:seg:0") == []

    def test_rejects_an_empty_string(self) -> None:
        assert idempotency_key_problems("") == [
            "idempotencyKey must be a non-empty string"
        ]

    def test_rejects_a_key_over_the_max_length(self) -> None:
        problems = idempotency_key_problems("a" * (MAX_IDEMPOTENCY_KEY_LENGTH + 1))
        assert any(f"at most {MAX_IDEMPOTENCY_KEY_LENGTH}" in p for p in problems)

    def test_rejects_whitespace(self) -> None:
        problems = idempotency_key_problems("has a space")
        assert any("no whitespace or control characters" in p for p in problems)

    def test_rejects_a_non_string_value(self) -> None:
        assert idempotency_key_problems(None) == [
            "idempotencyKey must be a non-empty string"
        ]


class TestAsyncIdempotencyKey:
    def test_stt_segment(self) -> None:
        assert (
            AsyncIdempotencyKey.stt_segment("sess-1", 3) == "stt:session:sess-1:seg:3"
        )

    def test_smr_chunk(self) -> None:
        assert AsyncIdempotencyKey.text_chunk("task-1", 7) == "text:task:task-1:chunk:7"

    def test_workflow_node(self) -> None:
        assert (
            AsyncIdempotencyKey.workflow_node("run-1", "node-1", 2)
            == "wf:run:run-1:node:node-1:2"
        )

    def test_webhook_delivery(self) -> None:
        assert (
            AsyncIdempotencyKey.webhook_delivery("sub-1", "env-1") == "hook:sub-1:env-1"
        )

    def test_is_a_pure_function(self) -> None:
        assert AsyncIdempotencyKey.text_chunk(
            "task-1", 7
        ) == AsyncIdempotencyKey.text_chunk("task-1", 7)

    def test_throws_on_a_blank_intent_id(self) -> None:
        with pytest.raises(ValueError, match="task_id is required"):
            AsyncIdempotencyKey.text_chunk("  ", 0)
