"""Unit tests for the LocalAgreement-2 commit policy (TASK-351 P1-1).

Covers:
- ``LocalAgreementPolicy`` — pure policy behaviour (agreement, disagreement,
  normalization, reset, monotonicity)
- ``SegmentResult.stable_chars`` — additive wire-format field
- ``SessionManager._make_commit_policy`` — per-pipeline config gating
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt_v2.streaming.commit_policy import LocalAgreementPolicy
from stt_v2.streaming.schemas import SegmentResult

# ---------------------------------------------------------------------------
# LocalAgreementPolicy — pure policy
# ---------------------------------------------------------------------------


class TestLocalAgreementPolicy:
    def test_first_hypothesis_commits_nothing(self):
        policy = LocalAgreementPolicy()
        committed, tentative = policy.update("hello wor")
        assert committed == ""
        assert tentative == "hello wor"
        assert policy.committed_text == ""
        assert policy.tentative_text == "hello wor"

    def test_agreement_on_growing_hypotheses_commits_common_prefix(self):
        policy = LocalAgreementPolicy()
        policy.update("hello wor")
        committed, tentative = policy.update("hello world how")
        # Only "hello" agrees between the two hypotheses
        assert committed == "hello"
        assert tentative == "world how"

        committed, tentative = policy.update("hello world how are")
        # Previous two agree on "hello world how"
        assert committed == "hello world how"
        assert tentative == "are"

    def test_disagreement_keeps_previous_commit_count(self):
        policy = LocalAgreementPolicy()
        policy.update("hello world foo")
        committed, _ = policy.update("hello world foo bar")
        assert committed == "hello world foo"

        # Full revision: agreement with previous is only 1 token ("hello"),
        # which is below the committed count of 3 — count must not shrink.
        committed, tentative = policy.update("hello there everyone now")
        assert committed == "hello there everyone"
        assert tentative == "now"

    def test_whitespace_normalization(self):
        policy = LocalAgreementPolicy()
        policy.update("  hello   world  ")
        committed, _ = policy.update("hello world again")
        assert committed == "hello world"

    def test_punctuation_and_case_normalization_for_comparison(self):
        policy = LocalAgreementPolicy()
        policy.update("Hello, world")
        # "hello" vs "Hello," and "world" vs "world" agree after normalization
        committed, _ = policy.update("hello world again")
        assert committed == "hello world"

    def test_committed_surface_comes_from_latest_hypothesis(self):
        policy = LocalAgreementPolicy()
        policy.update("hello world")
        committed, _ = policy.update("Hello, world again")
        # Same tokens after normalization; surface form is the latest text
        assert committed == "Hello, world"

    def test_monotonicity_committed_never_shrinks(self):
        policy = LocalAgreementPolicy()
        policy.update("a b c d")
        committed, _ = policy.update("a b c d")
        assert committed == "a b c d"

        # Shorter hypothesis cannot shrink the committed count; the visible
        # committed text is clamped to the available tokens.
        committed, tentative = policy.update("a b")
        assert committed == "a b"
        assert tentative == ""

        # Once the hypothesis grows again, the original commit count holds.
        committed, _ = policy.update("a b x y z")
        assert committed == "a b x y"

    def test_reset_clears_state(self):
        policy = LocalAgreementPolicy()
        policy.update("hello world")
        policy.update("hello world again")
        assert policy.committed_text != ""

        policy.reset()
        assert policy.committed_text == ""
        assert policy.tentative_text == ""

        # After reset, the next hypothesis is treated as the first
        committed, tentative = policy.update("completely new text")
        assert committed == ""
        assert tentative == "completely new text"

    def test_empty_hypothesis(self):
        policy = LocalAgreementPolicy()
        committed, tentative = policy.update("")
        assert committed == ""
        assert tentative == ""

        policy.update("hello world")
        committed, tentative = policy.update("")
        assert committed == ""
        assert tentative == ""


# ---------------------------------------------------------------------------
# SegmentResult.stable_chars — additive wire field
# ---------------------------------------------------------------------------


class TestSegmentResultStableChars:
    def test_default_is_none_and_omitted_from_wire(self):
        result = SegmentResult(text="hello")
        assert result.stable_chars is None
        assert "stable_chars" not in result.to_redis_dict()

    def test_stable_chars_serialized_when_set(self):
        result = SegmentResult(text="hello world", stable_chars=5, is_final=False)
        d = result.to_redis_dict()
        assert d["stable_chars"] == "5"

    def test_stable_chars_zero_is_serialized(self):
        result = SegmentResult(text="hello", stable_chars=0, is_final=False)
        assert result.to_redis_dict()["stable_chars"] == "0"

    def test_roundtrip(self):
        original = SegmentResult(text="hello world", stable_chars=5)
        restored = SegmentResult.from_redis_dict(original.to_redis_dict())
        assert restored.stable_chars == 5

    def test_roundtrip_absent(self):
        original = SegmentResult(text="hello world")
        restored = SegmentResult.from_redis_dict(original.to_redis_dict())
        assert restored.stable_chars is None


# ---------------------------------------------------------------------------
# SessionManager._make_commit_policy — config gating
# ---------------------------------------------------------------------------


def _make_manager():
    with patch("stt_v2.streaming.session_manager.get_settings") as mock_settings:
        mock_settings.side_effect = Exception("no settings in test")
        from stt_v2.streaming.execution_profile import ExecutionProfile
        from stt_v2.streaming.session_manager import SessionManager

        profile = MagicMock(spec=ExecutionProfile)
        profile.max_concurrent_streams = 5
        profile.vad_silence_threshold_ms = 500
        profile.denoise_enabled_default = False
        return SessionManager(redis=AsyncMock(), profile=profile)


class TestMakeCommitPolicy:
    def test_enabled_returns_policy(self):
        mgr = _make_manager()
        cfg = MagicMock()
        cfg.streaming.commit_policy = "local_agreement_2"
        policy = mgr._make_commit_policy(cfg)
        assert isinstance(policy, LocalAgreementPolicy)

    def test_none_value_returns_none(self):
        mgr = _make_manager()
        cfg = MagicMock()
        cfg.streaming.commit_policy = "none"
        assert mgr._make_commit_policy(cfg) is None

    def test_missing_streaming_section_returns_none(self):
        mgr = _make_manager()
        cfg = MagicMock(spec=[])  # no attributes at all
        assert mgr._make_commit_policy(cfg) is None

    def test_none_config_returns_none(self):
        mgr = _make_manager()
        assert mgr._make_commit_policy(None) is None

    def test_mock_config_without_explicit_value_returns_none(self):
        # A bare MagicMock attribute is not the literal enum value — the
        # gate must use a strict equality check (mirrors dual-capture).
        mgr = _make_manager()
        cfg = MagicMock()
        assert mgr._make_commit_policy(cfg) is None


@pytest.mark.asyncio
class TestCreateSessionCommitPolicy:
    """create_session registers a commit policy only when the pipeline enables it."""

    async def test_create_session_registers_policy_when_enabled(self):
        mgr = _make_manager()
        cfg = MagicMock()
        cfg.streaming.commit_policy = "local_agreement_2"
        cfg.preprocessing.vad.enabled = False
        cfg.preprocessing.target_sample_rate = 16000
        cfg.preprocessing.denoise.enabled = False
        cfg.preprocessing.normalize = False
        mgr._load_pipeline_config = AsyncMock(return_value=cfg)
        mgr._load_asr_pipeline = AsyncMock(return_value=(None, None))
        mgr._load_vad_service = AsyncMock(return_value=None)

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as mock_consumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as mock_listener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            mock_consumer.return_value = AsyncMock()
            mock_listener.return_value = AsyncMock()
            session = await mgr.create_session("s1", "t1", "p1")

        assert session is not None
        assert isinstance(mgr._commit_policies.get("s1"), LocalAgreementPolicy)

        await mgr.remove_session("s1")
        assert "s1" not in mgr._commit_policies

    async def test_create_session_no_policy_by_default(self):
        mgr = _make_manager()
        mgr._load_pipeline_config = AsyncMock(return_value=None)
        mgr._load_asr_pipeline = AsyncMock(return_value=(None, None))
        mgr._load_vad_service = AsyncMock(return_value=None)

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as mock_consumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as mock_listener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            mock_consumer.return_value = AsyncMock()
            mock_listener.return_value = AsyncMock()
            session = await mgr.create_session("s1", "t1", "p1")

        assert session is not None
        assert "s1" not in mgr._commit_policies

        await mgr.remove_session("s1")
