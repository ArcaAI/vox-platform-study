"""Resume-token convention — mirrors src/__tests__/resume-token.test.ts."""

from __future__ import annotations

from hope_async_contract.resume_token import (
    RESUME_FROM_BEGINNING,
    decode_resume_token,
    encode_resume_token,
)


class TestResumeToken:
    def test_round_trips_a_transport_and_cursor(self) -> None:
        token = encode_resume_token("redis-stream", "1723800000000-0")
        assert decode_resume_token(token) == {
            "transport": "redis-stream",
            "cursor": "1723800000000-0",
        }

    def test_is_base64url(self) -> None:
        token = encode_resume_token("redis-stream", "1723800000000-0")
        assert "+" not in token
        assert "/" not in token
        assert "=" not in token

    def test_returns_none_for_a_malformed_token(self) -> None:
        assert decode_resume_token("not-a-real-token!!!") is None

    def test_returns_none_for_an_empty_string(self) -> None:
        assert decode_resume_token("") is None

    def test_resume_from_beginning_is_the_redis_sentinel(self) -> None:
        assert RESUME_FROM_BEGINNING == "0-0"
