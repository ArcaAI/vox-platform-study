"""TASK-958 G3 — a streaming span is attributed to ITS OWN connection.

TASK-874 gave a switched session one ledger row per engine, and TASK-958 put the
``AiProviderConnection`` into the aggregation key so a tenant holding two accounts
of one vendor can tell which key paid. The connection itself, however, was stamped
ONCE per session (``SessionManager._session_connections``, written at every engine
load) and read ONCE at teardown, then applied to EVERY span — so the last engine to
load decided the funding and the account of all of them.

The money that moves when that is wrong:

    primary  azure-speech on the PLATFORM default  -> CLOUD, platform COGS
    fallback openai       on a tenant sibling      -> BYOK,  tenant spend

After a failover the azure span was emitted under the openai sibling's
``connection_id`` and, because ``resolve_override_key`` reads a DECLARED key and
nothing else, under the openai entry's ``funding: tenant`` as well. A stretch the
PLATFORM paid for therefore vanished into the tenant's own spend, on the account
the tenant did not use for it.

So a span records ``(connection_key, connection_id)`` at the moment the engine that
serves it is loaded or switched in — the same anchoring TASK-959 used for the
compute and byte counters — and ``close`` resolves each span against its own pair.
The session-level pair survives as the fallback for a span that predates the field
(a recovered session, an accumulator built before this change), and as the summary's
own scalar, which still describes the engine that finished.
"""

from __future__ import annotations

from test_session_manager_teardown_summary import _make_manager, _make_session

# The wire shape the gateway sends for a tenant that holds the PLATFORM default for
# azure-speech and a SECOND, own-key OpenAI account. A sibling's key is namespaced
# `provider:slug` (TASK-958 G2a); the default/platform row keeps the bare provider id.
OVERRIDES = {
    "azure-speech": {
        "api_key": "platform-key",
        "funding": "platform",
        "connection_id": "conn-platform-azure",
    },
    "openai:openai-research": {
        "api_key": "tenant-key",
        "funding": "tenant",
        "connection_id": "conn-openai-research",
    },
}

PLATFORM_AZURE = ("azure-speech", "conn-platform-azure")
TENANT_OPENAI = ("openai:openai-research", "conn-openai-research")


class _FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _session(session_id: str, audio: float = 42.5, wall_seconds: int = 90):
    session = _make_session(session_id=session_id)
    session._metadata.total_duration_seconds = audio
    session._metadata.created_at = "2026-08-06T10:00:00"
    session._metadata.closed_at = f"2026-08-06T10:0{wall_seconds // 60}:{wall_seconds % 60:02d}"
    return session


def _rows(summary):
    return [(s["engine"], s["deployment"], s["connection_id"]) for s in summary["segments"]]


class TestFailoverAcrossConnections:
    def test_each_span_is_billed_to_the_connection_that_served_it(self):
        """The regression this lane exists for: a platform-funded primary span must
        not be re-labelled with the tenant sibling the session ENDED on."""
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = _session("sess_failover")
        sid = session.session_id
        clock = _FakeClock()
        mgr._provider_overrides[sid] = OVERRIDES

        # `_load_asr_pipeline` stamps the format and the connection together; the
        # accumulator's first span opens right after it.
        mgr._session_asr_formats[sid] = AiModelFormat.AZURE_SPEECH
        mgr._session_connections[sid] = PLATFORM_AZURE
        mgr._start_usage_segments(sid, clock=clock)

        clock.advance(60.0)

        # The failover: the loader stamps the NEW engine and its connection, then the
        # switch controller's synchronous `_apply` body closes the span.
        mgr._session_asr_formats[sid] = AiModelFormat.OPENAI
        mgr._session_connections[sid] = TENANT_OPENAI
        mgr._advance_usage_segments(sid)

        clock.advance(30.0)

        summary = mgr._build_teardown_summary(session)

        assert _rows(summary) == [
            ("azure-speech", "CLOUD", "conn-platform-azure"),
            ("openai", "BYOK", "conn-openai-research"),
        ]
        # The scalars still describe the engine that finished — unchanged contract.
        assert summary["engine"] == "openai"
        assert summary["deployment"] == "BYOK"
        assert summary["connection_id"] == "conn-openai-research"
        # And the anchoring TASK-874/959 rely on is untouched by the new field.
        assert sum(s["session_seconds"] for s in summary["segments"]) == 90.0
        assert sum(s["audio_seconds"] for s in summary["segments"]) == 42.5

    def test_two_connections_of_ONE_engine_are_two_rows(self):
        """The bound the previous note recorded as known and unfixed: two accounts of
        one vendor share an ASR format, so span identity had to stop being the format
        alone before the aggregation key could separate them."""
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = _session("sess_two_openai")
        sid = session.session_id
        clock = _FakeClock()
        mgr._provider_overrides[sid] = {
            "openai": {
                "api_key": "default-key",
                "funding": "tenant",
                "connection_id": "conn-openai-default",
            },
            "openai:openai-research": OVERRIDES["openai:openai-research"],
        }

        mgr._session_asr_formats[sid] = AiModelFormat.OPENAI
        mgr._session_connections[sid] = ("openai", "conn-openai-default")
        mgr._start_usage_segments(sid, clock=clock)

        clock.advance(60.0)
        mgr._session_connections[sid] = TENANT_OPENAI
        mgr._advance_usage_segments(sid)
        clock.advance(30.0)

        summary = mgr._build_teardown_summary(session)

        assert _rows(summary) == [
            ("openai", "BYOK", "conn-openai-default"),
            ("openai", "BYOK", "conn-openai-research"),
        ]
        assert [s["session_seconds"] for s in summary["segments"]] == [60.0, 30.0]


class TestUnchangedPaths:
    def test_a_single_engine_session_reports_one_row_on_its_own_connection(self):
        from stt.pipeline.dto import AiModelFormat

        mgr = _make_manager()
        session = _session("sess_single")
        sid = session.session_id
        clock = _FakeClock()
        mgr._provider_overrides[sid] = OVERRIDES
        mgr._session_asr_formats[sid] = AiModelFormat.AZURE_SPEECH
        mgr._session_connections[sid] = PLATFORM_AZURE
        mgr._start_usage_segments(sid, clock=clock)
        clock.advance(90.0)

        summary = mgr._build_teardown_summary(session)

        assert _rows(summary) == [("azure-speech", "CLOUD", "conn-platform-azure")]
        assert summary["segments"][0]["session_seconds"] == 90.0

    def test_a_span_that_recorded_no_pair_falls_back_to_the_session_pair(self):
        """An accumulator built before this change (or by a path that stamps nothing)
        has no per-span pair. It must resolve exactly as it did — against the
        session-level stamp — rather than losing its connection to `None`."""
        from stt.pipeline.dto import AiModelFormat
        from stt.streaming.usage_segments import EngineUsageAccumulator

        mgr = _make_manager()
        session = _session("sess_legacy")
        sid = session.session_id
        clock = _FakeClock()
        mgr._provider_overrides[sid] = OVERRIDES
        mgr._session_asr_formats[sid] = AiModelFormat.AZURE_SPEECH
        mgr._session_connections[sid] = PLATFORM_AZURE
        # Built by hand WITHOUT a connection — the pre-TASK-958-G3 shape.
        mgr._session_usage_segments[sid] = EngineUsageAccumulator(
            AiModelFormat.AZURE_SPEECH, clock=clock
        )
        clock.advance(90.0)

        summary = mgr._build_teardown_summary(session)

        assert _rows(summary) == [("azure-speech", "CLOUD", "conn-platform-azure")]


class TestAccumulatorContract:
    def test_close_hands_the_resolver_each_span_s_own_pair(self):
        from stt.pipeline.dto import AiModelFormat
        from stt.streaming.usage_segments import EngineUsageAccumulator

        seen: list[tuple] = []

        def _resolve(fmt, connection):
            seen.append((fmt, connection))
            return (str(fmt.value).lower(), "BYOK", connection[1] if connection else None)

        clock = _FakeClock()
        acc = EngineUsageAccumulator(
            AiModelFormat.AZURE_SPEECH, clock=clock, connection=PLATFORM_AZURE
        )
        clock.advance(10.0)
        acc.switch_to(AiModelFormat.OPENAI, audio_seconds=8.0, connection=TENANT_OPENAI)
        clock.advance(10.0)

        segments = acc.close(
            audio_seconds=16.0,
            total_audio_seconds=16.0,
            total_session_seconds=20.0,
            resolve=_resolve,
        )

        assert seen == [
            (AiModelFormat.AZURE_SPEECH, PLATFORM_AZURE),
            (AiModelFormat.OPENAI, TENANT_OPENAI),
        ]
        assert [s.connection_id for s in segments] == [
            "conn-platform-azure",
            "conn-openai-research",
        ]
