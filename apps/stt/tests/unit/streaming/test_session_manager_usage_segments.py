"""TASK-874 — a switched streaming session bills ENGINE-TIME, not one tier.

Fallback to the platform default is a platform HA capability that is on by
default (owner decision #8, TASK-870), so it must be METERED: ten minutes on the
tenant's BYO primary followed by five on the platform fallback is
``10 min BYOK + 5 min CLOUD``, not fifteen of either.

Before this ticket the teardown summary carried ONE ``(engine, deployment)``
pair, resolved from ``_session_asr_formats`` — a single slot holding whichever
engine was loaded LAST — so the gateway emitted one ledger row for the whole
session and attributed every second of it to the engine that happened to finish.

``EngineUsageAccumulator`` records a span per live engine and the teardown
summary carries them as ``segments``, aggregated by the ``(engine, deployment)``
pair each span derives from the row that actually served it (funding is derived,
never stamped — `09-infrastructure-devops.md` §Tenant-first resolution & BYO).
"""

from __future__ import annotations

from unittest.mock import AsyncMock

from test_session_manager_teardown_summary import _make_manager, _make_session


class _FakeClock:
    """A monotonic stand-in the test drives explicitly, so span wall-clock is
    asserted on real numbers instead of on whatever the test host happened to
    take between two statements."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _accumulator(asr_format, clock, audio_seconds: float = 0.0):
    from stt.streaming.usage_segments import EngineUsageAccumulator

    return EngineUsageAccumulator(asr_format, audio_seconds=audio_seconds, clock=clock)


def _resolver(overrides):
    from stt.transcription.batch_service import resolve_usage_attribution

    # TASK-958 G3 — `close` hands the resolver each span's OWN
    # `(connection_key, connection_id)`. These spans record none, so the pair
    # arrives as `None` and attribution is exactly what it was before the field
    # existed; the forwarding is written out rather than swallowed so the test
    # exercises the real call shape.
    def _resolve(fmt, connection=None):
        connection_key, connection_id = connection or (None, None)
        return resolve_usage_attribution(
            fmt, overrides, connection_key=connection_key, connection_id=connection_id
        )

    return _resolve


class TestEngineUsageAccumulator:
    def test_a_session_that_never_switches_yields_one_segment_equal_to_the_totals(self):
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = _accumulator(AiModelFormat.WHISPER_CPP, clock)
        clock.advance(90.0)

        segments = acc.close(
            audio_seconds=42.5,
            total_audio_seconds=42.5,
            total_session_seconds=90.0,
            resolve=_resolver(None),
        )

        assert [(s.engine, s.deployment) for s in segments] == [("whisper_cpp", "SELF_HOSTED")]
        assert segments[0].audio_seconds == 42.5
        assert segments[0].session_seconds == 90.0

    def test_byo_primary_switching_to_the_platform_fallback_splits_the_bill(self):
        """The defect this ticket exists for: ten minutes of BYO Sarvam plus five
        of platform-funded Azure is 10 BYOK + 5 CLOUD, not 15 of the engine that
        finished."""
        from stt.pipeline.dto import AiModelFormat

        overrides = {
            "sarvam": {"api_key": "tenant-key", "funding": "tenant"},
            "azure-speech": {"api_key": "platform-key", "funding": "platform"},
        }
        clock = _FakeClock()
        acc = _accumulator(AiModelFormat.SARVAM, clock)

        clock.advance(600.0)  # ten minutes on the tenant's own engine
        acc.switch_to(AiModelFormat.AZURE_SPEECH, audio_seconds=580.0)
        clock.advance(300.0)  # five on the platform fallback

        segments = acc.close(
            audio_seconds=860.0,
            total_audio_seconds=860.0,
            total_session_seconds=900.0,
            resolve=_resolver(overrides),
        )

        assert [(s.engine, s.deployment) for s in segments] == [
            ("sarvam", "BYOK"),
            ("azure-speech", "CLOUD"),
        ]
        assert [s.session_seconds for s in segments] == [600.0, 300.0]
        assert [s.audio_seconds for s in segments] == [580.0, 280.0]

    def test_a_switch_back_aggregates_by_engine_not_by_span(self):
        """Manual switching is bidirectional, so an engine can be live more than
        once. Billing cares about total time per engine; the interleaving stays
        observable through provider_switched / stt_provider_switch_total."""
        from stt.pipeline.dto import AiModelFormat

        overrides = {"azure-speech": {"api_key": "k", "funding": "platform"}}
        clock = _FakeClock()
        acc = _accumulator(AiModelFormat.WHISPER_CPP, clock)

        clock.advance(60.0)
        acc.switch_to(AiModelFormat.AZURE_SPEECH, audio_seconds=50.0)
        clock.advance(30.0)
        acc.switch_to(AiModelFormat.WHISPER_CPP, audio_seconds=75.0)
        clock.advance(60.0)

        segments = acc.close(
            audio_seconds=130.0,
            total_audio_seconds=130.0,
            total_session_seconds=150.0,
            resolve=_resolver(overrides),
        )

        assert [(s.engine, s.deployment) for s in segments] == [
            ("whisper_cpp", "SELF_HOSTED"),
            ("azure-speech", "CLOUD"),
        ]
        # 60s before the switch + 60s after the switch back.
        assert segments[0].session_seconds == 120.0
        assert segments[1].session_seconds == 30.0
        assert segments[0].audio_seconds == 50.0 + 55.0
        assert segments[1].audio_seconds == 25.0

    def test_segments_sum_exactly_to_the_session_totals(self):
        """The rows billed must reconcile with the summary's own scalars — the
        last span is anchored to the total so no arithmetic gap can open between
        what the summary reports and what the ledger charges."""
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = _accumulator(AiModelFormat.WHISPER_CPP, clock)
        clock.advance(11.0)
        acc.switch_to(AiModelFormat.FASTER_WHISPER, audio_seconds=7.0)
        clock.advance(4.0)

        # Deliberately inconsistent with the measured deltas (the wall clock and
        # the created_at/closed_at ISO diff are different clocks).
        segments = acc.close(
            audio_seconds=9.0,
            total_audio_seconds=9.0,
            total_session_seconds=20.0,
            resolve=_resolver(None),
        )

        assert sum(s.audio_seconds for s in segments) == 9.0
        assert sum(s.session_seconds for s in segments) == 20.0

    def test_an_engine_that_never_served_is_dropped(self):
        """A create-time fallback (the primary failed to LOAD) must not bill the
        primary for a zero-length span it never ran."""
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = _accumulator(AiModelFormat.SARVAM, clock)
        acc.switch_to(AiModelFormat.WHISPER_CPP, audio_seconds=0.0)
        clock.advance(90.0)

        segments = acc.close(
            audio_seconds=42.5,
            total_audio_seconds=42.5,
            total_session_seconds=90.0,
            resolve=_resolver(None),
        )

        assert [(s.engine, s.deployment) for s in segments] == [("whisper_cpp", "SELF_HOSTED")]

    def test_an_unresolvable_format_is_left_out_rather_than_guessed(self):
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = _accumulator(AiModelFormat.WHISPER_CPP, clock)
        clock.advance(90.0)

        segments = acc.close(
            audio_seconds=42.5,
            total_audio_seconds=42.5,
            total_session_seconds=90.0,
            resolve=lambda _fmt, _connection=None: None,
        )

        assert segments == []


class TestTeardownSummarySegments:
    def _session(self, session_id="sess_seg", audio=42.5, wall_seconds=90):
        session = _make_session(session_id=session_id)
        session._metadata.total_duration_seconds = audio
        session._metadata.created_at = "2026-08-06T10:00:00"
        session._metadata.closed_at = f"2026-08-06T10:0{wall_seconds // 60}:{wall_seconds % 60:02d}"
        return session

    def test_summary_carries_one_segment_per_engine_alongside_the_legacy_scalars(self):
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = self._session()
        clock = _FakeClock()
        mgr._provider_overrides[session.session_id] = {
            "sarvam": {"api_key": "tenant-key", "funding": "tenant"},
        }
        mgr._start_usage_segments(session.session_id, AiModelFormat.SARVAM, clock=clock)
        clock.advance(60.0)
        mgr._session_asr_formats[session.session_id] = AiModelFormat.WHISPER_CPP
        mgr._advance_usage_segments(session.session_id)
        clock.advance(30.0)

        summary = mgr._build_teardown_summary(session)

        # The legacy scalars are untouched, so an un-upgraded gateway keeps
        # metering exactly as it does today.
        assert summary["engine"] == "whisper_cpp"
        assert summary["audio_seconds"] == 42.5
        assert summary["session_seconds"] == 90.0

        assert [(s["engine"], s["deployment"]) for s in summary["segments"]] == [
            ("sarvam", "BYOK"),
            ("whisper_cpp", "SELF_HOSTED"),
        ]
        assert sum(s["session_seconds"] for s in summary["segments"]) == 90.0
        assert sum(s["audio_seconds"] for s in summary["segments"]) == 42.5

    def test_a_session_with_no_accumulator_synthesizes_one_segment_from_the_totals(self):
        """A RECOVERED session (crash restart) builds no accumulator and cannot
        switch engines — it must still carry a segment so the gateway has one
        uniform path, and that segment is exactly the legacy row."""
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = self._session(session_id="sess_recovered")
        mgr._session_asr_formats[session.session_id] = AiModelFormat.WHISPER_CPP

        summary = mgr._build_teardown_summary(session)

        assert summary["segments"] == [
            {
                "engine": "whisper_cpp",
                "deployment": "SELF_HOSTED",
                "audio_seconds": 42.5,
                "session_seconds": 90.0,
                # TASK-958 — a recovered session stamped no connection; the row carries
                # `None` rather than omitting the key, so the gateway reads one shape.
                "connection_id": None,
                # TASK-959 — this branch is now built through `UsageSegment` itself, so
                # it carries the accumulator's full shape: no compute was recorded (no
                # worker), and a self-hosted engine made no third-party call, which is
                # a null byte count rather than a measured-looking zero.
                "processing_seconds": 0.0,
                "device": "cpu",
                "request_bytes": None,
                "response_bytes": None,
                "byte_source": None,
            }
        ]

    def test_no_engine_resolved_yields_no_segments(self):
        mgr = _make_manager()
        session = self._session(session_id="sess_no_engine")

        summary = mgr._build_teardown_summary(session)

        assert summary["engine"] is None
        assert summary["segments"] == []

    def test_the_teardown_response_schema_carries_segments_on_the_wire(self):
        """The DELETE route returns `StreamingSessionTeardownResponse(**summary)`
        — a field the schema does not declare never reaches the gateway."""
        from stt.streaming.api.schemas import StreamingSessionTeardownResponse

        response = StreamingSessionTeardownResponse(
            session_id="s-1",
            tenant_id="t-1",
            pipeline_id="p-1",
            closed_at="2026-08-06T10:01:30",
            audio_seconds=42.5,
            session_seconds=90.0,
            engine="whisper_cpp",
            deployment="SELF_HOSTED",
            segments=[
                {
                    "engine": "sarvam",
                    "deployment": "BYOK",
                    "audio_seconds": 20.0,
                    "session_seconds": 60.0,
                },
                {
                    "engine": "whisper_cpp",
                    "deployment": "SELF_HOSTED",
                    "audio_seconds": 22.5,
                    "session_seconds": 30.0,
                },
            ],
        )

        dumped = response.model_dump()
        assert [s["engine"] for s in dumped["segments"]] == ["sarvam", "whisper_cpp"]
        assert dumped["segments"][0]["deployment"] == "BYOK"


class TestSwitchAdvancesTheSegment:
    async def test_the_callable_swap_advances_the_engine_span(self):
        """The span boundary rides in `_apply` — the synchronous body that swaps
        the ASR callable and the provenance stamp — so it lands at the instant
        the live engine changes, and NOT when a fallback build merely starts (a
        build that raises must not close the primary's span)."""
        from stt.pipeline.dto import AiModelFormat
        from stt.streaming.usage_segments import EngineUsageAccumulator

        mgr = _make_manager()
        session_id = "sess_switch"
        clock = _FakeClock()
        mgr._provider_overrides[session_id] = {
            "azure-speech": {"api_key": "platform-key", "funding": "platform"}
        }
        mgr._start_usage_segments(session_id, AiModelFormat.WHISPER_CPP, clock=clock)
        controller = mgr._make_switch_controller(
            session_id=session_id,
            tenant_id="t1",
            primary_pipeline_id="p-primary",
            fallback_pipeline_id="p-fallback",
        )

        clock.advance(60.0)

        async def _fake_build():
            # `_load_asr_pipeline` is the sole loader and stamps the format
            # before the swap; reproduce exactly that ordering.
            mgr._session_asr_formats[session_id] = AiModelFormat.AZURE_SPEECH
            return AsyncMock()

        controller._build_fallback = _fake_build
        assert await controller.switch_manual("fallback") is True

        clock.advance(30.0)
        accumulator = mgr._session_usage_segments[session_id]
        assert isinstance(accumulator, EngineUsageAccumulator)

        from stt.transcription.batch_service import resolve_usage_attribution

        segments = accumulator.close(
            audio_seconds=80.0,
            total_audio_seconds=80.0,
            total_session_seconds=90.0,
            resolve=lambda fmt, _connection=None: resolve_usage_attribution(
                fmt, mgr._provider_overrides.get(session_id)
            ),
        )
        assert [(s.engine, s.deployment) for s in segments] == [
            ("whisper_cpp", "SELF_HOSTED"),
            ("azure-speech", "CLOUD"),
        ]
        assert [s.session_seconds for s in segments] == [60.0, 30.0]
