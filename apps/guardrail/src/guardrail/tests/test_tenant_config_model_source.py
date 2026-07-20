"""TASK-527 (D-12) — guardrail carries the model weight path, not just the id.

Before this ticket ``AiModelRead`` selected only ``provider``/``sourceUri``/
``_metadata``, so an admin editing ``AiModel.localPath`` changed nothing for
guardrail: the MiniCheck weight path came 100 % from the environment. These
tests lock the DB-first path (and its 60 s TTL pickup) in place.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from guardrail.core.tenant_config import (
    SYSTEM_TENANT_ID,
    TenantConfigResolver,
)

DEFAULT_TENANT = "50000000-0000-0000-0000-000000000000"
TENANT_A = "11111111-1111-1111-1111-111111111111"


class _FakeResult:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def all(self) -> list:
        return list(self._rows)

    def first(self):
        return self._rows[0] if self._rows else None


class _FakeSession:
    def __init__(self, rows_ref: dict) -> None:
        self._rows_ref = rows_ref

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        return False

    async def execute(self, stmt: object) -> _FakeResult:
        return _FakeResult(self._rows_ref["rows"])


def _row(
    *,
    provider: str | None = "built-in",
    source_uri: str | None = "nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF",
    local_path: str | None = None,
    checksum: str | None = None,
    source: str | None = "HUGGINGFACE",
    source_revision: str | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        default_tenant_id=SYSTEM_TENANT_ID,
        model_tenant_id=SYSTEM_TENANT_ID,
        provider=provider,
        source_uri=source_uri,
        meta_data=None,
        local_path=local_path,
        checksum=checksum,
        source=source,
        source_revision=source_revision,
    )


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _resolver(rows_ref: dict, clock=None, ttl: int = 60) -> TenantConfigResolver:
    kwargs = {}
    if clock is not None:
        kwargs["time_func"] = clock
    return TenantConfigResolver(
        session_factory=lambda: _FakeSession(rows_ref),
        default_tenant_id=DEFAULT_TENANT,
        cache_ttl_s=ttl,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_load_from_db_returns_local_path_and_checksum() -> None:
    rows_ref = {
        "rows": [
            _row(local_path="/opt/hope/models/minicheck", checksum="a" * 64)
        ]
    }

    cfg = await _resolver(rows_ref).resolve(TENANT_A, "guardrail.groundedness")

    assert cfg.local_path == "/opt/hope/models/minicheck"
    assert cfg.checksum == "a" * 64
    assert cfg.model == "nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF"


@pytest.mark.asyncio
async def test_absent_local_path_stays_none() -> None:
    """No path on the row ⇒ None, so callers fall back to env (today's behaviour)."""
    rows_ref = {"rows": [_row()]}

    cfg = await _resolver(rows_ref).resolve(TENANT_A, "guardrail.groundedness")

    assert cfg.local_path is None
    assert cfg.checksum is None


@pytest.mark.asyncio
async def test_db_row_edit_picked_up_within_ttl() -> None:
    """An admin editing `localPath` is honoured after the 60 s TTL — both ways."""
    clock = _Clock()
    rows_ref = {"rows": [_row(local_path="/opt/models/old")]}
    resolver = _resolver(rows_ref, clock=clock, ttl=60)

    first = await resolver.resolve(TENANT_A, "guardrail.groundedness")
    assert first.local_path == "/opt/models/old"

    # Admin PATCHes the registry row.
    rows_ref["rows"] = [_row(local_path="/opt/models/new")]

    # Within the TTL the cached path still serves — no per-request DB hit.
    cached = await resolver.resolve(TENANT_A, "guardrail.groundedness")
    assert cached.local_path == "/opt/models/old"

    # Past the TTL the new path is picked up.
    clock.now += 61
    refreshed = await resolver.resolve(TENANT_A, "guardrail.groundedness")
    assert refreshed.local_path == "/opt/models/new"


@pytest.mark.asyncio
async def test_resolve_model_source_by_slug_serves_non_task_key_lookups() -> None:
    """Harness-style by-slug lookups (no task key exists for every consumer)."""
    rows_ref = {"rows": [_row(local_path="/opt/models/minicheck")]}
    resolver = _resolver(rows_ref)

    identity = await resolver.resolve_model_source_by_slug("minicheck-flan-t5-large")

    assert identity is not None
    assert identity.local_path == "/opt/models/minicheck"
    assert identity.slug == "minicheck-flan-t5-large"
