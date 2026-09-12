"""TASK-959 §3.2 — a switched streaming session bills its COMPUTE per engine too.

TASK-874 made audio and session seconds follow the engine that actually served
each stretch. The ASR-only processing time did not follow: the session's
`cumulative_processing_seconds` was read once at teardown for a Prometheus RTF
and then dropped, so ten minutes of GPU occupancy on a tenant's BYO primary plus
five on the platform fallback had nowhere to land as two rows.

Three properties this file pins, because each one is a different way to get the
money wrong:

* **Compute follows the span.** A fallback leg carries its OWN processing
  seconds, and Sigma over segments equals the session total — anchored the way
  audio/session seconds already are, so no arithmetic gap can open between the
  teardown summary's own scalars and the rows billed against them.
* **Bytes follow the engine that moved them.** A self-hosted span made no
  third-party call and must report `None`, not zero-that-looks-measured; a cloud
  span reports what its adapter counted, with the adapter's own `byte_source`.
* **Device is per SEGMENT, not per session.** A cloud leg's occupancy here is
  the calling service waiting on the vendor, so it bills `cpu` even on a GPU
  host — while the self-hosted leg of the SAME session bills the real device.

The aggregation key stays `(engine, deployment, connection_id)`: a session that
toggles primary -> fallback -> primary bills TWO rows, and the primary's two
stretches of compute are SUMMED into one.
"""

from __future__ import annotations

import pytest
from test_session_manager_teardown_summary import _make_manager, _make_session

from stt.core.metering import BYTE_SOURCE_APP, BYTE_SOURCE_WIRE
from stt.streaming.usage_segments import EngineUsageAccumulator, EngineUsageCounters

OVERRIDES = {
    "sarvam": {"api_key": "tenant-key", "funding": "tenant"},
    "azure-speech": {"api_key": "platform-key", "funding": "platform"},
}


class _FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _resolver(overrides=OVERRIDES):
    from stt.transcription.batch_service import resolve_usage_attribution

    return lambda fmt: resolve_usage_attribution(fmt, overrides)


def _by_engine(segments):
    return {segment.engine: segment for segment in segments}


class TestProcessingSecondsFollowTheSpan:
    def test_a_switched_session_splits_the_asr_compute_between_the_two_engines(self):
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = EngineUsageAccumulator(AiModelFormat.SARVAM, clock=clock)

        clock.advance(600.0)
        acc.switch_to(
            AiModelFormat.AZURE_SPEECH,
            audio_seconds=580.0,
            counters=EngineUsageCounters(processing_seconds=10.0),
        )
        clock.advance(300.0)

        segments = _by_engine(
            acc.close(
                audio_seconds=860.0,
                total_audio_seconds=860.0,
                total_session_seconds=900.0,
                total_processing_seconds=25.0,
                counters=EngineUsageCounters(processing_seconds=25.0),
                resolve=_resolver(),
            )
        )

        assert segments["sarvam"].processing_seconds == pytest.approx(10.0)
        assert segments["azure-speech"].processing_seconds == pytest.approx(15.0)

    def test_the_segments_sum_to_the_session_total_even_when_the_spans_disagree(self):
        """The invariant, not the arithmetic: the last span takes the remainder,
        exactly as `audio_seconds`/`session_seconds` already do, so a snapshot
        the accumulator never saw cannot open a gap against the reported total."""
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = EngineUsageAccumulator(AiModelFormat.SARVAM, clock=clock)
        clock.advance(10.0)
        acc.switch_to(
            AiModelFormat.AZURE_SPEECH,
            audio_seconds=5.0,
            counters=EngineUsageCounters(processing_seconds=4.0),
        )
        clock.advance(10.0)

        segments = acc.close(
            audio_seconds=20.0,
            total_audio_seconds=20.0,
            total_session_seconds=20.0,
            # Higher than the spans measured (4.0 + 2.0): a worker replaced
            # mid-session, or a snapshot missed at the switch.
            total_processing_seconds=30.0,
            counters=EngineUsageCounters(processing_seconds=6.0),
            resolve=_resolver(),
        )

        assert sum(s.processing_seconds for s in segments) == pytest.approx(30.0)
        by_engine = _by_engine(segments)
        assert by_engine["sarvam"].processing_seconds == pytest.approx(4.0)
        assert by_engine["azure-speech"].processing_seconds == pytest.approx(26.0)

    def test_a_session_that_never_switches_takes_the_whole_compute(self):
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = EngineUsageAccumulator(AiModelFormat.WHISPER_CPP, clock=clock)
        clock.advance(90.0)

        segments = acc.close(
            audio_seconds=42.5,
            total_audio_seconds=42.5,
            total_session_seconds=90.0,
            total_processing_seconds=11.25,
            counters=EngineUsageCounters(processing_seconds=11.25),
            resolve=_resolver(None),
        )

        assert len(segments) == 1
        assert segments[0].processing_seconds == pytest.approx(11.25)

    def test_a_toggle_back_sums_the_primarys_two_stretches_into_one_row(self):
        """The TASK-874 aggregation key is unchanged, so compute aggregates with
        it: primary -> fallback -> primary is two rows, not three."""
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = EngineUsageAccumulator(AiModelFormat.SARVAM, clock=clock)
        clock.advance(100.0)
        acc.switch_to(
            AiModelFormat.AZURE_SPEECH,
            audio_seconds=90.0,
            counters=EngineUsageCounters(processing_seconds=5.0),
        )
        clock.advance(100.0)
        acc.switch_to(
            AiModelFormat.SARVAM,
            audio_seconds=180.0,
            counters=EngineUsageCounters(processing_seconds=12.0),
        )
        clock.advance(100.0)

        segments = acc.close(
            audio_seconds=270.0,
            total_audio_seconds=270.0,
            total_session_seconds=300.0,
            total_processing_seconds=20.0,
            counters=EngineUsageCounters(processing_seconds=20.0),
            resolve=_resolver(),
        )

        assert len(segments) == 2
        by_engine = _by_engine(segments)
        # 5.0 on the first primary stretch + 8.0 on the second.
        assert by_engine["sarvam"].processing_seconds == pytest.approx(13.0)
        assert by_engine["azure-speech"].processing_seconds == pytest.approx(7.0)


class TestBytesFollowTheEngineThatMovedThem:
    def test_a_cloud_fallback_carries_its_own_bytes_and_the_self_hosted_leg_carries_none(self):
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = EngineUsageAccumulator(AiModelFormat.WHISPER_CPP, clock=clock)
        clock.advance(60.0)
        # The self-hosted primary moved nothing: the counters are unchanged.
        acc.switch_to(
            AiModelFormat.SARVAM, audio_seconds=55.0, counters=EngineUsageCounters()
        )
        clock.advance(60.0)

        segments = _by_engine(
            acc.close(
                audio_seconds=115.0,
                total_audio_seconds=115.0,
                total_session_seconds=120.0,
                total_processing_seconds=8.0,
                counters=EngineUsageCounters(
                    processing_seconds=8.0,
                    request_bytes=40960,
                    response_bytes=2048,
                    byte_source=BYTE_SOURCE_WIRE,
                ),
                resolve=_resolver(),
            )
        )

        assert segments["sarvam"].request_bytes == 40960
        assert segments["sarvam"].response_bytes == 2048
        assert segments["sarvam"].byte_source == BYTE_SOURCE_WIRE
        # Not 0 — a self-hosted engine made no third-party call at all, and
        # "measured zero" and "never applicable" must not look alike.
        assert segments["whisper_cpp"].request_bytes is None
        assert segments["whisper_cpp"].response_bytes is None
        assert segments["whisper_cpp"].byte_source is None

    def test_a_self_hosted_leg_AFTER_a_cloud_leg_does_not_inherit_its_byte_source(self):
        """The ordering trap. `last_byte_source` is a single slot, so a session
        that starts on a cloud engine and switches BACK to self-hosted would hand
        the self-hosted span a stale `wire` label with zero bytes — which reads as
        "a third-party call that moved nothing" instead of "no such call". Two
        things prevent it: the worker clears the label when an engine that reports
        no bytes runs, and a zero-delta span is attributed no bytes at all.
        """
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = EngineUsageAccumulator(AiModelFormat.SARVAM, clock=clock)
        clock.advance(60.0)
        acc.switch_to(
            AiModelFormat.WHISPER_CPP,
            audio_seconds=55.0,
            counters=EngineUsageCounters(
                processing_seconds=4.0,
                request_bytes=1000,
                response_bytes=100,
                byte_source=BYTE_SOURCE_WIRE,
            ),
        )
        clock.advance(60.0)

        segments = _by_engine(
            acc.close(
                audio_seconds=115.0,
                total_audio_seconds=115.0,
                total_session_seconds=120.0,
                total_processing_seconds=9.0,
                # The self-hosted engine moved nothing, so the counters are
                # unchanged from the switch — but a STALE label would still be here
                # if the worker had not cleared it.
                counters=EngineUsageCounters(
                    processing_seconds=9.0,
                    request_bytes=1000,
                    response_bytes=100,
                    byte_source=BYTE_SOURCE_WIRE,
                ),
                resolve=_resolver(),
            )
        )

        assert segments["sarvam"].request_bytes == 1000
        assert segments["whisper_cpp"].request_bytes is None
        assert segments["whisper_cpp"].response_bytes is None
        assert segments["whisper_cpp"].byte_source is None

    def test_each_span_keeps_the_byte_source_of_the_engine_that_served_it(self):
        """Sarvam counts real HTTP (`wire`); the Azure Speech SDK can only offer an
        application-level proxy (`app`). One session, two meanings."""
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = EngineUsageAccumulator(AiModelFormat.SARVAM, clock=clock)
        clock.advance(60.0)
        acc.switch_to(
            AiModelFormat.AZURE_SPEECH,
            audio_seconds=55.0,
            counters=EngineUsageCounters(
                processing_seconds=4.0,
                request_bytes=1000,
                response_bytes=100,
                byte_source=BYTE_SOURCE_WIRE,
            ),
        )
        clock.advance(60.0)

        segments = _by_engine(
            acc.close(
                audio_seconds=115.0,
                total_audio_seconds=115.0,
                total_session_seconds=120.0,
                total_processing_seconds=9.0,
                counters=EngineUsageCounters(
                    processing_seconds=9.0,
                    request_bytes=4000,
                    response_bytes=400,
                    byte_source=BYTE_SOURCE_APP,
                ),
                resolve=_resolver(),
            )
        )

        assert segments["sarvam"].byte_source == BYTE_SOURCE_WIRE
        assert (segments["sarvam"].request_bytes, segments["sarvam"].response_bytes) == (1000, 100)
        assert segments["azure-speech"].byte_source == BYTE_SOURCE_APP
        assert (
            segments["azure-speech"].request_bytes,
            segments["azure-speech"].response_bytes,
        ) == (3000, 300)


class TestDeviceIsResolvedPerSegment:
    def test_a_self_hosted_segment_reports_the_sessions_own_device(self):
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = EngineUsageAccumulator(AiModelFormat.WHISPER_CPP, clock=clock)
        clock.advance(10.0)

        segments = acc.close(
            audio_seconds=10.0,
            total_audio_seconds=10.0,
            total_session_seconds=10.0,
            total_processing_seconds=2.0,
            counters=EngineUsageCounters(processing_seconds=2.0),
            device="cuda",
            resolve=_resolver(None),
        )

        assert segments[0].device == "cuda"

    def test_a_cloud_segment_reports_cpu_even_on_a_gpu_host(self):
        """What the request occupied HERE is the calling service waiting on the
        vendor — billing the fallback leg a GPU second would bill our own card
        for someone else's inference."""
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = EngineUsageAccumulator(AiModelFormat.WHISPER_CPP, clock=clock)
        clock.advance(10.0)
        acc.switch_to(
            AiModelFormat.SARVAM,
            audio_seconds=9.0,
            counters=EngineUsageCounters(processing_seconds=2.0),
        )
        clock.advance(10.0)

        segments = _by_engine(
            acc.close(
                audio_seconds=20.0,
                total_audio_seconds=20.0,
                total_session_seconds=20.0,
                total_processing_seconds=5.0,
                counters=EngineUsageCounters(processing_seconds=5.0),
                device="cuda",
                resolve=_resolver(),
            )
        )

        assert segments["whisper_cpp"].device == "cuda"
        assert segments["sarvam"].device == "cpu"

    def test_an_unknown_host_device_degrades_to_cpu_rather_than_to_nothing(self):
        from stt.pipeline.dto import AiModelFormat

        clock = _FakeClock()
        acc = EngineUsageAccumulator(AiModelFormat.WHISPER_CPP, clock=clock)
        clock.advance(10.0)

        segments = acc.close(
            audio_seconds=10.0,
            total_audio_seconds=10.0,
            total_session_seconds=10.0,
            resolve=_resolver(None),
        )

        assert segments[0].device == "cpu"
        assert segments[0].processing_seconds == 0.0


class TestTheSegmentDictIsTheWire:
    def test_to_dict_carries_every_field_the_gateway_reads(self):
        from stt.streaming.usage_segments import UsageSegment

        dumped = UsageSegment(
            engine="sarvam",
            deployment="BYOK",
            audio_seconds=1.0,
            session_seconds=2.0,
            connection_id="conn-1",
            processing_seconds=0.5,
            device="cpu",
            request_bytes=10,
            response_bytes=20,
            byte_source=BYTE_SOURCE_WIRE,
        ).to_dict()

        assert dumped == {
            "engine": "sarvam",
            "deployment": "BYOK",
            "audio_seconds": 1.0,
            "session_seconds": 2.0,
            # TASK-958 — left exactly as its lane wrote it.
            "connection_id": "conn-1",
            "processing_seconds": 0.5,
            "device": "cpu",
            "request_bytes": 10,
            "response_bytes": 20,
            "byte_source": BYTE_SOURCE_WIRE,
        }

    # `response_model=StreamingSessionTeardownResponse` FILTERS the summary, so the
    # five fields must be DECLARED on `StreamingUsageSegment` or the DELETE-teardown
    # path silently drops them (the reaper push-back POSTs the raw dict and is not
    # affected). Declared by the orchestrator after TASK-958 Lane C's own change to
    # the same file; this test pins that the declaration stays.
    def test_the_teardown_schema_declares_the_new_fields_or_they_never_reach_the_wire(self):
        from stt.streaming.api.schemas import StreamingUsageSegment

        segment = StreamingUsageSegment(
            engine="sarvam",
            deployment="BYOK",
            audio_seconds=1.0,
            session_seconds=2.0,
            processing_seconds=0.5,
            device="cpu",
            request_bytes=10,
            response_bytes=20,
            byte_source="wire",
        )
        dumped = segment.model_dump()

        assert dumped["processing_seconds"] == 0.5
        assert dumped["device"] == "cpu"
        assert dumped["request_bytes"] == 10
        assert dumped["response_bytes"] == 20
        assert dumped["byte_source"] == "wire"


class TestTheTeardownSummaryCarriesThemEndToEnd:
    def _session(self, session_id="sess_959"):
        session = _make_session(session_id=session_id)
        session._metadata.total_duration_seconds = 42.5
        session._metadata.created_at = "2026-09-12T10:00:00"
        session._metadata.closed_at = "2026-09-12T10:01:30"  # +90s
        return session

    def test_a_switched_session_reports_per_engine_compute_bytes_and_device(self):
        from dataclasses import replace

        from stt.pipeline.dto import AiModelFormat
        from stt.streaming.inference import StreamingInferenceWorker

        clock = _FakeClock()
        mgr = _make_manager()
        # The dev/CI profile is CPU; billing a GPU host is the interesting case.
        mgr._profile = replace(mgr._profile, asr_device="cuda:0")
        session = self._session()
        mgr._sessions[session.session_id] = session
        mgr._provider_overrides[session.session_id] = OVERRIDES

        worker = StreamingInferenceWorker()
        mgr._inference_workers[session.session_id] = worker

        mgr._session_asr_formats[session.session_id] = AiModelFormat.WHISPER_CPP
        mgr._start_usage_segments(session.session_id, AiModelFormat.WHISPER_CPP, clock=clock)

        # 4 s of local GPU compute, no network.
        worker.cumulative_processing_seconds = 4.0
        clock.advance(45.0)
        mgr._session_asr_formats[session.session_id] = AiModelFormat.SARVAM
        mgr._advance_usage_segments(session.session_id)

        # 6 s more, this time waiting on Sarvam over the wire.
        worker.cumulative_processing_seconds = 10.0
        worker.cumulative_request_bytes = 40960
        worker.cumulative_response_bytes = 2048
        worker.last_byte_source = BYTE_SOURCE_WIRE
        clock.advance(45.0)

        summary = mgr._build_teardown_summary(session)
        segments = {s["engine"]: s for s in summary["segments"]}

        assert segments["whisper_cpp"]["processing_seconds"] == pytest.approx(4.0)
        assert segments["whisper_cpp"]["device"] == "cuda"
        assert segments["whisper_cpp"]["request_bytes"] is None
        assert segments["sarvam"]["processing_seconds"] == pytest.approx(6.0)
        assert segments["sarvam"]["device"] == "cpu"
        assert segments["sarvam"]["request_bytes"] == 40960
        assert segments["sarvam"]["response_bytes"] == 2048
        assert segments["sarvam"]["byte_source"] == BYTE_SOURCE_WIRE
        assert sum(s["processing_seconds"] for s in summary["segments"]) == pytest.approx(10.0)

    def test_a_recovered_session_puts_the_whole_compute_on_its_one_segment(self):
        """A crash-recovered session builds no switch controller, so it cannot
        change engines — one segment equal to the whole session is exact."""
        from stt.pipeline.dto import AiModelFormat
        from stt.streaming.inference import StreamingInferenceWorker

        mgr = _make_manager()
        session = self._session(session_id="sess_recovered_959")
        mgr._session_asr_formats[session.session_id] = AiModelFormat.WHISPER_CPP
        worker = StreamingInferenceWorker()
        worker.cumulative_processing_seconds = 7.5
        mgr._inference_workers[session.session_id] = worker

        summary = mgr._build_teardown_summary(session)

        assert len(summary["segments"]) == 1
        segment = summary["segments"][0]
        assert segment["processing_seconds"] == pytest.approx(7.5)
        assert segment["device"] == "cpu"  # the CPU test profile
        assert segment["request_bytes"] is None
        assert segment["byte_source"] is None


class TestTheInferenceWorkerAccumulatesTheAdaptersByteCounts:
    @pytest.mark.asyncio
    async def test_a_cloud_adapters_counters_accumulate_across_utterances(self):
        import numpy as np

        from stt.streaming.inference import StreamingInferenceWorker
        from stt.streaming.preprocessor import AudioUtterance

        async def fake_asr(samples, sample_rate, **kwargs):
            return {
                "text": "hello",
                "word_timestamps": [],
                "request_bytes": 100,
                "response_bytes": 10,
                "byte_source": BYTE_SOURCE_WIRE,
            }

        worker = StreamingInferenceWorker()
        worker._asr_pipeline = fake_asr
        utterance = AudioUtterance(
            samples=np.zeros(160, dtype=np.float32),
            sample_rate=16000,
            start_time=0.0,
            end_time=0.01,
            utterance_index=0,
            is_final=True,
        )

        await worker._run_inference(utterance)
        await worker._run_inference(utterance)

        assert worker.cumulative_request_bytes == 200
        assert worker.cumulative_response_bytes == 20
        assert worker.last_byte_source == BYTE_SOURCE_WIRE
        assert worker.cumulative_processing_seconds >= 0.0

    @pytest.mark.asyncio
    async def test_a_self_hosted_engine_CLEARS_the_byte_source_after_a_cloud_one(self):
        """`last_byte_source` names the LIVE engine's reporting, so an engine that
        reports none must clear it — otherwise its span inherits the previous
        engine's label at the next boundary snapshot."""
        import numpy as np

        from stt.streaming.inference import StreamingInferenceWorker
        from stt.streaming.preprocessor import AudioUtterance

        async def cloud_asr(samples, sample_rate, **kwargs):
            return {
                "text": "hi",
                "request_bytes": 100,
                "response_bytes": 10,
                "byte_source": BYTE_SOURCE_WIRE,
            }

        async def self_hosted_asr(samples, sample_rate, **kwargs):
            return {"text": "hi"}

        utterance = AudioUtterance(
            samples=np.zeros(160, dtype=np.float32),
            sample_rate=16000,
            start_time=0.0,
            end_time=0.01,
            utterance_index=0,
            is_final=True,
        )
        worker = StreamingInferenceWorker()

        worker._asr_pipeline = cloud_asr
        await worker._run_inference(utterance)
        assert worker.last_byte_source == BYTE_SOURCE_WIRE

        worker._asr_pipeline = self_hosted_asr
        await worker._run_inference(utterance)

        assert worker.last_byte_source is None
        # The totals are cumulative and never rewound — only the LABEL moves.
        assert worker.cumulative_request_bytes == 100
        assert worker.cumulative_response_bytes == 10

    @pytest.mark.asyncio
    async def test_a_self_hosted_adapter_leaves_the_byte_counters_untouched(self):
        import numpy as np

        from stt.streaming.inference import StreamingInferenceWorker
        from stt.streaming.preprocessor import AudioUtterance

        async def fake_asr(samples, sample_rate, **kwargs):
            return {"text": "hello", "word_timestamps": []}

        worker = StreamingInferenceWorker()
        worker._asr_pipeline = fake_asr

        await worker._run_inference(
            AudioUtterance(
                samples=np.zeros(160, dtype=np.float32),
                sample_rate=16000,
                start_time=0.0,
                end_time=0.01,
                utterance_index=0,
                is_final=True,
            )
        )

        assert worker.cumulative_request_bytes == 0
        assert worker.cumulative_response_bytes == 0
        assert worker.last_byte_source is None
