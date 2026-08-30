"""Subprocess entrypoint: run the REAL `apps/text` app for the bench harness.

This is the "no production-code change" half of H-1: it imports the actual,
unmodified `text.main.create_app` (the same factory `uvicorn text.main:app`
uses in production) and serves it with real uvicorn, over a real socket, in
its own OS process — so AC-2's per-stream RSS is a real process's RSS, and
the concurrency sweep exercises the real ASGI app under real I/O scheduling,
not an in-process test transport.

The ONE substitution is Redis: `app.state.redis` is set to
`fakeredis.aioredis.FakeRedis()` before uvicorn's lifespan runs, exactly the
pattern `src/text/tests/integration/conftest.py` already uses (see its
`app` fixture) — not a Lane-H invention. `main.py`'s lifespan
(`text/main.py:117-121`) only opens a REAL Redis connection when
`app.state.redis` is still `None`, so this is achieved without touching
`main.py` at all, by using its own documented extension point:

    if not hasattr(app.state, "redis") or app.state.redis is None:
        redis_client = aioredis.from_url(...)   # skipped — we set it first
    else:
        redis_client = app.state.redis           # our fake

Why fakeredis and not a real ephemeral Redis: `fakeredis[lua]` (already an
`apps/text` `test` extra — see `pyproject.toml`) implements Redis Streams
(XADD/XREAD/XRANGE), which is all the current `TaskManager` needs, without
requiring a live Redis server — running `redis-server` or docker infra is an
orchestrator-owned surface (EXECUTION-PLAN §4), not something a Lane H
benchmark script should spin up itself.

Hermetic env: every var that would otherwise dial an unreachable peer
(gateway, guardrail) is left at its safe default (guardrail posture floors to
disabled — see `core/runtime_defaults.GUARDRAIL_ENABLED_FLOOR = False`; the
effective-config pull and self-registration are both fire-and-forget and
negative-cache on failure per `main.py`'s own comments) — nothing here papers
over a real dependency, it relies on defaults the service already ships.
"""

from __future__ import annotations

import os

# CI=true makes `hope_env.load_env()` a guaranteed no-op (host env only) —
# see `packages/py-env/src/hope_env/__init__.py::load_env`. This worktree has
# no `.env.dev`/`.env.test` anyway (gitignored, does not follow a worktree),
# but pinning this makes the bench process hermetic regardless of where it is
# run from.
os.environ.setdefault("CI", "true")
# Same defect class documented in `src/text/tests/conftest.py`: an ambient
# service token would make every bench request 401 through
# `ServiceAuthMiddleware`. Empty token = the sanctioned dev-mode bypass
# (`.claude/rules/06-python-services.md` §Gateway Integration & Auth).
os.environ.setdefault("INTERNAL_ACCESS_TOKEN", "")
os.environ.setdefault("SERVICE_TOKEN", "")
# No OTel collector in a benchmark run; avoid retry/backoff noise against a
# nonexistent endpoint.
os.environ.setdefault("TEXT_OTEL_EXPORTER_ENDPOINT", "")

import fakeredis.aioredis  # noqa: E402
import uvicorn  # noqa: E402

from text.main import create_app  # noqa: E402


def build_app():
    """The real app, with the ONE Redis substitution described above."""
    app = create_app()
    app.state.redis = fakeredis.aioredis.FakeRedis()
    return app


app = build_app()


if __name__ == "__main__":
    port = int(os.environ.get("BENCH_TEXT_PORT", "8862"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
