"""Shared fixtures for the ``hope_obs`` suite.

Every test runs against a clean process state: no observability environment
variables inherited from the developer's shell or from a sibling test, no
leftover root handlers, and no structlog configuration from a previous
``configure_logging`` call. ``configure_logging`` is deliberately idempotent
(R-3), so without the reset below the second test to call it would silently
assert against the first test's configuration.
"""

from __future__ import annotations

import io
import logging
from collections.abc import Callable, Iterator

import pytest
import structlog

from hope_obs import logging as obs_logging

# Every variable `ObservabilityConfig.from_env` reads, plus the per-service
# overrides the tests exercise. Inherited values would make the precedence
# assertions depend on the machine they run on.
_OBSERVABILITY_ENV = (
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_SERVICE_NAME",
    "OTEL_TRACES_SAMPLER_ARG",
    "DEPLOYMENT_ENVIRONMENT",
    "NODE_ENV",
    "LOG_LEVEL",
    "STT_LOG_LEVEL",
    "TEXT_LOG_LEVEL",
    "HOPE_STT_V2_LOG_LEVEL",
)


@pytest.fixture(autouse=True)
def clean_observability_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _OBSERVABILITY_ENV:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def reset_logging_state() -> Iterator[None]:
    root = logging.getLogger()
    preexisting = root.handlers[:]
    for handler in preexisting:
        root.removeHandler(handler)
    obs_logging._SETUP_DONE = False

    yield

    for handler in root.handlers[:]:
        root.removeHandler(handler)
    for handler in preexisting:
        root.addHandler(handler)
    obs_logging._SETUP_DONE = False
    structlog.reset_defaults()
    structlog.contextvars.clear_contextvars()
    logging.getLogger("uvicorn.access").disabled = False


@pytest.fixture
def capture_log_output() -> Callable[[], io.StringIO]:
    """Redirect the configured root StreamHandler into an in-memory buffer.

    Call it AFTER ``configure_logging``: the handler is created there and holds
    a reference to whatever ``sys.stdout`` was at that moment, which pytest may
    have already replaced.
    """

    def _attach() -> io.StringIO:
        stream = io.StringIO()
        for handler in logging.getLogger().handlers:
            if isinstance(handler, logging.StreamHandler):
                handler.setStream(stream)
        return stream

    return _attach
