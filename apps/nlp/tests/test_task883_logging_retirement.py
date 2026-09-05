"""TASK-883 — apps/nlp's file/rotation logging is retired; stdout is the sink.

The deployment ships stdout → Alloy → Loki and mounts no log volume for this
service, so a rotating FILE handler wrote to an ephemeral container filesystem
nobody read. The eleven `nlp.logging.*` control-plane keys, the sink table they
overlaid, and the file/rotation handler wiring all go together — a knob whose
only effect is on a sink that does not exist is not configuration.

Behaviour is preserved, not merely "changed safely": `file_enabled` defaulted
`false` and no seed ever wrote a GlobalSetting row for any of these keys, so a
file handler was never built on any deployment. What ran was one console
handler with the plain formatter, which is exactly what remains.
"""

from __future__ import annotations

import logging

import pytest

from nlp.core.effective_config import EffectiveConfigSnapshot
from nlp.core.logging import LoggingConfig, setup_logging


class TestTheSinkTableIsGone:
    def test_no_log_sink_declaration_survives(self) -> None:
        import nlp.core.logging as mod

        for name in ("LOG_SINK_DEFAULTS", "apply_log_sinks", "log_sink"):
            assert not hasattr(mod, name), f"{name} survived the retirement"

    def test_no_file_or_rotation_helper_survives(self) -> None:
        for name in ("_parse_size", "_ensure_log_directory"):
            assert not hasattr(LoggingConfig, name), f"{name} survived the retirement"


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
        root = logging.getLogger()
        saved = root.handlers[:]
        saved_level = root.level
        yield
        root.handlers[:] = saved
        root.setLevel(saved_level)

    def test_setup_installs_exactly_one_stream_handler(self) -> None:
        setup_logging("nlp-test")
        handlers = logging.getLogger().handlers
        assert len(handlers) == 1
        assert type(handlers[0]) is logging.StreamHandler

    def test_no_file_handler_is_ever_built(self) -> None:
        setup_logging("nlp-test")
        assert not any(
            isinstance(h, logging.FileHandler) for h in logging.getLogger().handlers
        )

    def test_the_level_still_comes_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """`NLP_LOG_LEVEL` (then bare `LOG_LEVEL`) stays an env read: it is what an
        operator reaches for first during an incident, with no control-plane hop."""
        monkeypatch.setenv("NLP_LOG_LEVEL", "WARNING")
        setup_logging("nlp-test")
        assert logging.getLogger().level == logging.WARNING
