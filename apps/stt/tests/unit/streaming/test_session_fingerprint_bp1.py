"""TASK-985 BP-1 — the session's own configuration fingerprint.

``streaming_quality.check_fingerprint`` compares the committed evaluation
baseline to the live run FIELD BY NAME, and treats a field either side is
missing as "not comparable" rather than as a mismatch. So a typo'd or dropped
key does not fail the gate — it silently shrinks it, which is the exact failure
mode BP-1 exists to end (M-15: six configuration drifts, every ``_note`` still
describing the 2026-09-09 config, and ``e3d61eefb`` moving English WER 27x with
nothing in the log able to settle which config had run).

These tests therefore pin the CONTRACT, not the values: the emitted key set is
asserted against ``streaming_quality.FINGERPRINT_FIELDS`` itself, so the two
halves cannot drift apart without a red test.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from tests.integration.streaming_quality import FINGERPRINT_EVENT_NAME, FINGERPRINT_FIELDS


def _make_manager():
    from stt.streaming.execution_profile import ExecutionProfile, PlatformType
    from stt.streaming.session_manager import SessionManager

    profile = ExecutionProfile(
        platform=PlatformType.CPU,
        device_name="cpu-test",
        gpu_count=0,
        total_vram_gb=0,
        total_ram_gb=16,
        cpu_cores=4,
        asr_device="cpu",
        asr_compute_type="float32",
        asr_max_batch_size=2,
        asr_model_quantization="fp16",
        embedding_device="cpu",
        embedding_batch_size=2,
        preprocess_pool_size=2,
        max_concurrent_streams=10,
        batch_scheduler_max_wait_ms=500,
        multi_gpu_strategy="none",
    )
    redis_mock = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    return SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")


def _effective() -> dict[str, object]:
    """The preprocessor's own view — the source the fingerprint must read from."""
    return {
        "segmenter": "silero",
        "partial_window_s": 3.0,
        "partial_interval_s": 0.3,
        "endpointing": "semantic",
        "min_silence_ms": 350,
    }


def _emit(mgr, capture, **overrides):
    kwargs: dict[str, object] = {
        "session_id": "s1",
        "pipeline_config": SimpleNamespace(
            models=SimpleNamespace(asr=SimpleNamespace(slug="arcaai-whisper-large-ml-en-gguf"))
        ),
        # Deliberately NOT carrying the geometry: reading it off the preprocessor
        # rather than re-deriving it at the call site is the M-13 lesson.
        "preprocessor": SimpleNamespace(partial_window_s=99.0, partial_interval_s=9.9),
        "effective": _effective(),
        "max_decode_window_sec": 7.0,
        "initial_prompt": "a composed priming prompt",
        "vad_enabled": False,
    }
    kwargs.update(overrides)
    mgr._log_session_fingerprint(**kwargs)
    return capture


@pytest.fixture
def capture(monkeypatch):
    """Capture the structlog INFO calls this module makes."""
    import stt.streaming.session_manager as sm

    seen: list[tuple[str, dict]] = []
    real_info = sm.logger.info

    def _info(event, **fields):
        seen.append((event, fields))
        return real_info(event, **fields)

    monkeypatch.setattr(sm.logger, "info", _info)
    return seen


def _fingerprint(seen):
    matches = [f for event, f in seen if event == FINGERPRINT_EVENT_NAME]
    assert len(matches) == 1, f"expected exactly one {FINGERPRINT_EVENT_NAME}, got {len(matches)}"
    return matches[0]


class TestFingerprintContract:
    def test_it_emits_exactly_the_fields_the_gate_compares(self, capture):
        fp = _fingerprint(_emit(_make_manager(), capture))

        # `session_id` is the correlation key `find_fingerprint_in_log` matches
        # on; everything else must be the gate's field set, no more and no less.
        assert set(fp) - {"session_id"} == set(FINGERPRINT_FIELDS)

    def test_geometry_is_read_from_the_preprocessors_own_view(self, capture):
        """M-13 — the object that APPLIES the numbers answers for them."""
        fp = _fingerprint(_emit(_make_manager(), capture))

        assert fp["partialWindowSec"] == 3.0
        assert fp["partialIntervalMs"] == 300
        assert fp["endpointing"] == "semantic"
        assert fp["maxDecodeWindowSec"] == 7.0
        assert fp["vadEnabled"] is False

    def test_the_prompt_is_a_digest_and_never_the_text(self, capture):
        """The composed prompt carries tenant-authored clinical vocabulary."""
        prompt = "atorvastatin, metoprolol - dictate the discharge summary"
        fp = _fingerprint(_emit(_make_manager(), capture, initial_prompt=prompt))

        assert fp["promptHash"] is not None
        assert prompt not in str(fp)
        for word in ("atorvastatin", "metoprolol", "discharge"):
            assert word not in str(fp)

        # Same prompt => same digest; a changed prompt => a changed digest. That
        # pair is the whole of what the gate asks of this field.
        capture.clear()
        again = _fingerprint(_emit(_make_manager(), capture, initial_prompt=prompt))
        assert again["promptHash"] == fp["promptHash"]

        capture.clear()
        other = _fingerprint(_emit(_make_manager(), capture, initial_prompt=prompt + "!"))
        assert other["promptHash"] != fp["promptHash"]

    def test_no_prompt_is_a_null_hash_not_a_hash_of_nothing(self, capture):
        fp = _fingerprint(_emit(_make_manager(), capture, initial_prompt=None))
        assert fp["promptHash"] is None

    def test_the_priming_prompt_flags_are_read_at_call_time(self, capture, monkeypatch):
        """``e3d61eefb`` flipped this flag and no gate could see it.

        Read at call time, not captured at import, so the very next session says
        what the running process actually does.
        """
        import stt.pipeline.language_modes as lm

        monkeypatch.setattr(lm, "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED", True)
        monkeypatch.setattr(lm, "WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED", False)

        fp = _fingerprint(_emit(_make_manager(), capture))

        assert fp["pairPromptEnabled"] is True
        assert fp["singlePromptEnabled"] is False

    def test_the_operating_point_is_null_rather_than_guessed(self, capture):
        """Nothing on the wire declares harness/scribe/playground to STT.

        ``check_fingerprint`` reads a null as "not captured" and leaves that
        field out of the comparison — which is honest. A value invented here
        would be exactly the re-derivation BP-1 exists to abolish.
        """
        fp = _fingerprint(_emit(_make_manager(), capture))
        assert fp["sdkOperatingPoint"] is None

    def test_a_broken_source_degrades_to_no_line_not_a_failed_session(self, capture):
        """A fingerprint is diagnostic; it may never take a session down."""
        mgr = _make_manager()

        class _Boom:
            @property
            def partial_window_s(self):
                raise RuntimeError("boom")

        # Must not raise.
        mgr._log_session_fingerprint(
            session_id="s1",
            pipeline_config=None,
            preprocessor=_Boom(),
            effective={},
            max_decode_window_sec=None,
            initial_prompt=None,
            vad_enabled=False,
        )
        assert not [f for event, f in capture if event == FINGERPRINT_EVENT_NAME]


class TestFingerprintOnTheAgentPath:
    """The two identity fields, sourced from the session's REGISTERED spec.

    ``agentVersion`` and ``modelDigest`` are the fields that say WHICH agent
    version and WHICH weights ran. Both read from the in-memory
    ``ResolvedSpecBundle`` the gateway sent, so they are null on any path that
    did not register one — never guessed from the seed.
    """

    @staticmethod
    def _spec() -> dict:
        import json
        from pathlib import Path

        here = Path(__file__).resolve()
        for parent in here.parents:
            candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
            if candidate.is_file():
                return json.loads(candidate.read_text(encoding="utf-8"))
        raise AssertionError("shared ResolvedAsrSpec contract fixture not found")

    def test_the_agent_version_is_the_sessions_runtime_key(self, capture):
        from stt.streaming.session_manager import SessionManager

        spec = self._spec()["platformDefault"]["expected"]
        mgr = _make_manager()
        bundle = SessionManager._register_resolved_spec(mgr, "s1", spec)

        fp = _fingerprint(_emit(mgr, capture))

        # The runtime key IS the `agentVersionId` the gateway resolved against —
        # a stronger identity than an incrementing version integer, and the same
        # key the session is already keyed on everywhere else.
        assert fp["agentVersion"] == bundle.runtime_key
        assert fp["agentVersion"] == spec["runtimeKey"]

    def test_the_model_digest_and_engine_come_from_the_resolved_row(self, capture):
        """WHICH weights ran, and what they ran on."""
        from stt.streaming.session_manager import SessionManager

        spec = self._spec()["platformDefault"]["expected"]
        mgr = _make_manager()
        SessionManager._register_resolved_spec(mgr, "s1", spec)

        fp = _fingerprint(_emit(mgr, capture))

        assert fp["modelSlug"] == spec["models"]["asr"]["slug"]
        assert fp["modelDigest"] == spec["models"]["asr"]["checksum"]
        # `engineBuild` names the decoder FAMILY and the image that compiled its
        # binding — `pywhispercpp` exposes no upstream commit of its own.
        assert fp["engineBuild"] is not None
        assert fp["engineBuild"].lower().startswith("whisper_cpp@")

    def test_an_unregistered_session_reports_null_rather_than_guessing(self, capture):
        fp = _fingerprint(_emit(_make_manager(), capture))
        assert fp["agentVersion"] is None
        assert fp["modelDigest"] is None
