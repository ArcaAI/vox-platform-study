import io
import logging
from collections.abc import Callable
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

# Refuse to run against another checkout's source (git-worktree false-greens).
# See scripts/pytest-support/hope_worktree_guard.py.
from hope_worktree_guard import assert_source_tree
from pydantic import SecretStr

import nlp.lifespan  # noqa: F401 — ensure module is importable before patching

assert_source_tree(["nlp", "hope_env", "hope_runtime_models", "hope_obs"], __file__)

# `nlp.core.logging.get_logger` now proxies to `structlog`, exactly like every
# module that already called `structlog.get_logger(__name__)` directly
# (`nlp.dependencies`, `nlp.core.effective_config`, ...). Unconfigured,
# structlog uses ITS OWN default renderer/logger-factory (`PrintLogger`),
# which bypasses Python's stdlib `logging` module entirely — and with it,
# `caplog`, which is a stdlib-`logging` handler. In production this never
# arises: `nlp.main` calls `setup_logging()` at import time before anything
# else runs. Tests never import `nlp.main`, so this one call reproduces that
# "always configured" baseline for the WHOLE session, exactly once, before
# pytest's per-test log-capturing handler exists — so it can never clash with
# a `caplog`-based test the way a per-test reset would (see
# `hope_obs.logging.configure_logging`: every call wipes the root logger's
# existing handlers, `caplog`'s included).
#
# `test_observability.py` and `test_task883_logging_retirement.py` need a
# FRESH reconfiguration per test (to see a monkeypatched `NLP_LOG_LEVEL`, a
# different OTLP endpoint, ...); they carry their own MODULE-LOCAL autouse
# fixture that resets `hope_obs.logging._SETUP_DONE` and is safe there
# because neither file uses `caplog`.
from hope_obs import ObservabilityConfig  # noqa: E402
from hope_obs import configure_logging as _hope_obs_configure_logging  # noqa: E402

_hope_obs_configure_logging(ObservabilityConfig(service_name="nlp"))


@pytest.fixture
def capture_log_output() -> Callable[[], io.StringIO]:
    """Redirect the root ``StreamHandler`` `hope_obs.configure_logging` installs
    into an in-memory buffer. Call AFTER logging is configured (directly, via
    `nlp.core.logging.setup_logging`, or via `nlp.core.observability.
    setup_opentelemetry`): the handler is created there and holds whatever
    ``sys.stdout`` was at that moment.

    Deliberately not `caplog`: `configure_logging` clears every existing root
    handler on each call (idempotence guard aside — this still runs the FIRST
    time in a test), which would silently drop `caplog`'s own handler if
    logging were (re)configured inside a `caplog.at_level(...)` block. Mirrors
    `packages/py-obs/tests/conftest.py`.
    """

    def _attach() -> io.StringIO:
        stream = io.StringIO()
        for handler in logging.getLogger().handlers:
            if isinstance(handler, logging.StreamHandler):
                handler.setStream(stream)
        return stream

    return _attach


class FakeService:
    """Lightweight stand-in for ML services that avoids model downloads."""

    is_initialized = True

    async def initialize(self) -> None:
        pass

    async def shutdown(self) -> None:
        pass


# Singleton slots in nlp.dependencies backing the get_* getters. Preset (not
# just patched) so code holding a direct reference to the ORIGINAL getters —
# router Depends defaults bound at import, monitoring's check table — also
# resolves to the fake, independent of module import order.
#
# The classifier singletons are GONE: every model is resolved per
# request from a caller-supplied selection through the model cache, so there is
# no process-wide instance left to preset. Only the two weightless singletons
# remain.
_DEP_SLOTS = (
    "_text_corrector_instance",
    "_websocket_manager_instance",
)


@pytest.fixture()
def mock_services():
    import nlp.dependencies as deps

    fake = FakeService()
    saved = {name: deps.__dict__.get(name) for name in _DEP_SLOTS}
    for name in _DEP_SLOTS:
        deps.__dict__[name] = fake
    patches = [
        patch("nlp.dependencies.get_text_corrector", return_value=fake),
        patch("nlp.dependencies.get_websocket_manager", return_value=fake),
        # lifespan no longer eager-loads the ML models; it only
        # initializes the (weightless) websocket manager.
        patch("nlp.lifespan.get_websocket_manager", return_value=fake),
        patch("nlp.core.observability.setup_opentelemetry"),
        patch("nlp.core.observability.setup_prometheus"),
        patch("nlp.app.setup_prometheus"),
        patch("nlp.core.observability.shutdown_opentelemetry"),
    ]
    for p in patches:
        p.start()
    yield fake
    for p in patches:
        p.stop()
    for name, value in saved.items():
        deps.__dict__[name] = value


@pytest.fixture()
def client(mock_services, monkeypatch):
    """A hermetic client with service auth OFF.

    These suites call protected routes WITHOUT an `X-Service-Token` header — they are about
    handler behaviour, not auth. `Settings.accepted_service_tokens` admits the ONE shared
    `internal_access_token` (the legacy per-service token was removed in lane D), read from the
    environment, so any token present in the loaded `.env.test` turned every such call into a
    401 before the handler ran. Clearing BOTH restores the documented "empty everywhere = auth
    disabled" dev path. `test_auth_middleware.py` re-pins them per-test, so its cases are
    unaffected.
    """
    from nlp.core.config import settings as nlp_settings

    monkeypatch.setattr(nlp_settings.service, "internal_access_token", SecretStr(""), raising=False)

    from nlp.app import get_app

    app = get_app()
    with TestClient(app) as c:
        yield c
