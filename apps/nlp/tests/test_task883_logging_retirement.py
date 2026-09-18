"""TASK-883 — apps/nlp's file/rotation logging is retired; stdout is the sink.

The deployment ships stdout → Alloy → Loki and mounts no log volume for this
service, so a rotating FILE handler wrote to an ephemeral container filesystem
nobody read. The eleven `nlp.logging.*` control-plane keys, the sink table they
overlaid, and the file/rotation handler wiring all go together — a knob whose
only effect is on a sink that does not exist is not configuration.

Behaviour is preserved, not merely "changed safely": `file_enabled` defaulted
`false` and no seed ever wrote a GlobalSetting row for any of these keys, so a
file handler was never built on any deployment. What ran was one console
handler, and what runs now (TASK-987 lane E — `hope_obs`, see
`test_observability.py`) is still exactly one console handler; only the
formatter changed, from plain text to JSON (F-03).

TASK-987 extends this retirement one step further: `LoggingConfig` and
`JsonFormatter` themselves are gone. `JsonFormatter` read OTel trace context
off the record but was never installed (`logging.Formatter(SIMPLE_FORMAT)` was
always the one actually wired) — dead code from the day it was written.
"""

from __future__ import annotations

import logging

import pytest

from nlp.core.effective_config import EffectiveConfigSnapshot
from nlp.core.logging import setup_logging


class TestTheSinkTableIsGone:
    def test_no_log_sink_declaration_survives(self) -> None:
        import nlp.core.logging as mod

        for name in ("LOG_SINK_DEFAULTS", "apply_log_sinks", "log_sink"):
            assert not hasattr(mod, name), f"{name} survived the retirement"

    def test_no_file_or_rotation_helper_survives(self) -> None:
        import nlp.core.logging as mod

        for name in ("_parse_size", "_ensure_log_directory"):
            assert not hasattr(mod, name), f"{name} survived the retirement"

    def test_logging_config_and_json_formatter_are_gone(self) -> None:
        """TASK-987 F-03: `JsonFormatter` was defined and never installed —
        dead trace-correlation code. `LoggingConfig` wrapped a plain-text
        `SIMPLE_FORMAT` handler. Both are retired in favour of `hope_obs`."""
        import nlp.core.logging as mod

        for name in ("LoggingConfig", "JsonFormatter"):
            assert not hasattr(mod, name), f"{name} survived the TASK-987 retirement"


class TestTheEffectiveConfigGroupIsGone:
    def test_the_snapshot_serves_no_logging_group(self) -> None:
        snapshot = EffectiveConfigSnapshot(
            raw={"settings": {"nlp.logging.fileEnabled": {"value": True}}}, ok=True
        )
        assert not hasattr(snapshot, "logging")

    def test_the_surviving_groups_still_resolve(self) -> None:
        """The retirement is scoped to log sinks: batching and retention stay."""
        snapshot = EffectiveConfigSnapshot(
            raw={"settings": {"nlp.inference.batchMaxSize": {"value": 16}}}, ok=True
        )
        assert snapshot.batching()["bulk"]["max_batch_size"] == 16


class TestStdoutIsTheOnlySink:
    @pytest.fixture(autouse=True)
    def _restore_root_handlers(self):
        """Also resets `hope_obs.logging._SETUP_DONE`: `configure_logging` is
        idempotent (R-3), and each test here needs `setup_logging` to actually
        reconfigure — e.g. to pick up a monkeypatched `NLP_LOG_LEVEL`. Safe as
        a MODULE-LOCAL fixture (not session-wide): this file never uses
        `caplog`.
        """
        from hope_obs import logging as obs_logging

        root = logging.getLogger()
        saved = root.handlers[:]
        saved_level = root.level
        obs_logging._SETUP_DONE = False
        yield
        root.handlers[:] = saved
        root.setLevel(saved_level)
        # Restore the "already configured" session baseline `conftest.py`
        # established once at collection time — later test FILES must not
        # see an unconfigured structlog (which would silently break any
        # `caplog`-based test elsewhere in the suite).
        obs_logging._SETUP_DONE = True

    def test_setup_installs_exactly_one_stream_handler(self) -> None:
        setup_logging("nlp-test")
        handlers = logging.getLogger().handlers
        assert len(handlers) == 1
        assert type(handlers[0]) is logging.StreamHandler

    def test_no_file_handler_is_ever_built(self) -> None:
        setup_logging("nlp-test")
        assert not any(isinstance(h, logging.FileHandler) for h in logging.getLogger().handlers)

    def test_the_level_still_comes_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """`NLP_LOG_LEVEL` (then bare `LOG_LEVEL`) stays an env read: it is what an
        operator reaches for first during an incident, with no control-plane hop."""
        monkeypatch.setenv("NLP_LOG_LEVEL", "WARNING")
        setup_logging("nlp-test")
        assert logging.getLogger().level == logging.WARNING
