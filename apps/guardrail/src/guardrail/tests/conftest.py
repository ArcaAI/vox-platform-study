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
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

# Refuse to run against another checkout's source (git-worktree false-greens).
# See scripts/pytest-support/hope_worktree_guard.py.
from hope_worktree_guard import assert_source_tree

assert_source_tree(["guardrail", "hope_env", "hope_runtime_models"], __file__)


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
