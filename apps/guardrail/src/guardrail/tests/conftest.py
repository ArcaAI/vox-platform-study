"""Shared test fixtures for guardrail.

Isolates the pytest session from this machine's gitignored ``.env.dev``.

``guardrail.main.create_app()`` takes no ``settings_override``: it calls the real
``get_settings()``, which calls ``hope_env.load_env()`` — a permanent mutation of
``os.environ`` — on EVERY invocation. So unlike the TTS variant of this bug
(a module-level ``app = create_app()`` leaking once at import time, fixed by a
snapshot around that import in ``apps/tts/src/tts/tests/conftest.py``), guardrail
leaks per test, at test runtime, and needs a per-test fixture.

Two distinct failure modes, both closed below:

1. **Leak into later tests.** A test that builds an app pulls the developer's real
   ``GUARDRAIL_*`` values into the process env, where they outlive it and change
   what a later test observes. Snapshot/restore around each test contains it.
2. **A real token breaking auth-agnostic tests.** With a live
   ``GUARDRAIL_SERVICE_TOKEN`` in ``.env.dev``, ``ServiceAuthMiddleware`` enforces,
   and every unauthenticated request in a test that is not about auth gets a
   genuine 401 instead of reaching its handler. Pre-setting the var to ``""``
   (the documented dev / hermetic-CI bypass) gives the same posture CI has, where
   no env file is read at all.

The token must be SET to empty, not deleted: ``load_env`` only fills keys that are
absent from ``os.environ`` (host env > file), so a deleted key is repopulated from
``.env.dev`` on the next ``create_app()`` while an empty one is left alone.

This is a floor, not a lock. A test that IS about auth overrides it normally — via
``monkeypatch.setenv`` before ``create_app()`` (see
``test_auth_middleware.py::test_enforcement_fires_from_canonical_env``) or by
setting ``app.state.settings.service_token`` after construction — and the restore
below undoes that too.

TASK-987: ``create_app()`` now ALSO calls into ``hope_obs`` (logging + request
middleware + tracing), because the two ASGI middlewares it installs must be
added before the app serves its first request — the old ``lifespan``-time
``setup_logging`` call ran too late for that. ``hope_obs.configure_logging`` is
deliberately idempotent (its own R-3 contract): the FIRST ``create_app()`` call
in this pytest session configures the root logger once, at ``settings.log_level``
(``"info"`` unless a manifest sets ``GUARDRAIL_V2_LOG_LEVEL``), and every later
call is a no-op. Do NOT add a per-test reset for this here — it looks tidier but
it is not: ``structlog.testing.capture_logs`` (used by
``test_task892_internal_token_startup.py``) keeps working across
``cache_logger_on_first_use=True`` specifically by MUTATING the currently
configured processors list in place rather than replacing it; forcing a fresh
``structlog.configure(...)`` call every test (a *new* list each time) makes any
logger a PRIOR test already cached — e.g. ``guardrail.main``'s module-level
``logger`` — hold a stale reference that ``capture_logs`` never touches, so its
capture silently empties out. Confirmed by reproducing exactly that failure
while implementing this ticket. A test that needs an isolated log capture
should redirect the existing handler's stream instead (see
``test_task987_observability.py::_attach_capture``), not force a reconfigure.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

# Refuse to run against another checkout's source (git-worktree false-greens).
# See scripts/pytest-support/hope_worktree_guard.py.
from hope_worktree_guard import assert_source_tree

assert_source_tree(["guardrail", "hope_env", "hope_runtime_models", "hope_obs"], __file__)


@pytest.fixture(autouse=True)
def _isolate_env_from_dot_env_dev() -> Iterator[None]:
    """Snapshot ``os.environ``, neutralize the service token, restore afterwards."""
    snapshot = dict(os.environ)
    # Empty (not absent) — see the module docstring: absent keys get refilled
    # from .env.dev by the next load_env(), empty ones win over the file.
    os.environ["GUARDRAIL_SERVICE_TOKEN"] = ""
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(snapshot)
