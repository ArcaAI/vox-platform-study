"""TASK-1003 F-10a — the teardown summary's key set is pinned against the
shared gateway contract fixture.

``SessionManager._build_teardown_summary()`` is the PRODUCER of
``POST /internal/stt/streaming/usage``'s wire body (via
``gateway.py::record_streaming_usage``, which sends ``{**summary,
interrupted}`` verbatim). The CONSUMER is
``SttStreamingUsagePushbackRequest`` (apps/api), whose global pipe runs
``forbidNonWhitelisted`` — so a key this builder starts returning that the DTO
does not declare does not degrade, it 400s every push-back. That is exactly
how ``lexicon_correction_count`` (TASK-935) broke streaming usage metering:
nothing on either side would have caught the drift before this fixture.

Both halves read the SAME committed file —
``tests/contracts/stt-streaming-usage.fixture.json`` — so a shape change on
either producer or consumer fails the other side. The TypeScript half is
``apps/api/src/modules/internal/__tests__/stt-streaming-usage.contract.test.ts``.

This test builds a REAL summary through ``_build_teardown_summary`` (reusing
the ``_make_manager``/``_make_session`` helpers the sibling streaming tests
already share — see ``test_session_manager_teardown_summary.py``,
``test_task958_per_span_connection.py``,
``test_task959_usage_segments_compute.py`` in this directory) rather than
asserting against the builder's literal key list, so a field added to (or
dropped from) the summary's own return statement fails this test even if
nobody remembers to update it by hand.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from test_session_manager_teardown_summary import _make_manager, _make_session


def _load_fixture() -> dict[str, Any]:
    """Locate the shared contract fixture by walking up to the repo root."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "stt-streaming-usage.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared stt-streaming-usage contract fixture not found")


FIXTURE = _load_fixture()
PUSHBACK: dict[str, Any] = FIXTURE["pushback"]


def _build_real_summary() -> dict[str, Any]:
    """A real teardown summary through the same code path the reaper uses.

    Mirrors ``test_self_hosted_engine_summary``'s setup (one ASR format
    resolved, no accumulator — the RECOVERED-session branch, which is exactly
    the shape a crash-reaper push-back arrives in) plus the two fields that
    test does not touch: the lexicon worker's correction count and the
    channel count, so every key the builder can return is actually present.
    """
    from stt.pipeline.dto import AiModelFormat
    from stt.streaming.inference import StreamingInferenceWorker

    mgr = _make_manager()
    session = _make_session()
    session._metadata.total_duration_seconds = 42.5
    session._metadata.created_at = "2026-08-06T10:00:00"
    session._metadata.closed_at = "2026-08-06T10:01:30"  # +90s wall clock
    mgr._session_asr_formats[session.session_id] = AiModelFormat.WHISPER_CPP
    mgr._session_language_modes[session.session_id] = "ml-en"
    mgr._session_channel_counts[session.session_id] = 1

    worker = StreamingInferenceWorker()
    worker.cumulative_processing_seconds = 10.0
    worker.lexicon_correction_count = 3
    mgr._inference_workers[session.session_id] = worker

    return mgr._build_teardown_summary(session)


class TestStreamingUsagePushbackContract:
    def test_the_real_summary_key_set_equals_the_fixture_minus_interrupted(self):
        """`interrupted` is a GATEWAY concept (`gateway.py` adds it); the
        builder itself never carries it."""
        summary = _build_real_summary()

        assert set(summary.keys()) == set(PUSHBACK.keys()) - {"interrupted"}

    def test_the_one_segment_key_set_equals_the_fixture_segment(self):
        summary = _build_real_summary()

        assert len(summary["segments"]) == 1
        assert set(summary["segments"][0].keys()) == set(PUSHBACK["segments"][0].keys())

    def test_lexicon_correction_count_is_a_real_builder_field(self):
        """The field this ticket exists for: it must actually come off the
        worker, not merely appear in the fixture."""
        summary = _build_real_summary()

        assert summary["lexicon_correction_count"] == 3

    def test_the_wire_body_gateway_sends_matches_the_fixture_exactly(self):
        """`gateway.py::record_streaming_usage` builds the push-back as
        `{**summary, interrupted}` — reproduce that here and the whole wire
        body's key set must equal the fixture."""
        summary = _build_real_summary()

        pushback_body = {**summary, "interrupted": False}

        assert set(pushback_body.keys()) == set(PUSHBACK.keys())
