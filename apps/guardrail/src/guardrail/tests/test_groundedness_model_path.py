"""The MiniCheck clinical gate resolves its weights DB-first.

The DB row wins, env remains the fallback
(so an un-configured registry behaves byte-for-byte as env-only), and the
"never auto-download in a clinical gate" posture is preserved: hub pulls stay
blocked (``allow_network=False``) while ``s3://`` / ``file://`` / ``localPath``
are permitted.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from guardrail.core.model_source import (
    ModelSourceConfig,
    ModelWeightIdentity,
    resolve_groundedness_model_path,
)


class _StubResolver:
    """Stands in for `TenantConfigResolver.resolve` (task-key lane)."""

    def __init__(self, identity: ModelWeightIdentity | None) -> None:
        self._identity = identity
        self.calls = 0

    async def resolve_model_source(self, tenant_id, task_key):
        self.calls += 1
        return self._identity


def _config(tmp_path: Path) -> ModelSourceConfig:
    return ModelSourceConfig(
        cache_dir=str(tmp_path / "cache"), hf_cache_dir=str(tmp_path / "hf")
    )


@pytest.mark.asyncio
async def test_db_path_beats_env(tmp_path: Path) -> None:
    staged = tmp_path / "from-db"
    staged.mkdir()
    env_path = tmp_path / "from-env"
    env_path.mkdir()

    resolver = _StubResolver(
        ModelWeightIdentity(
            slug="minicheck-flan-t5-large",
            source_uri="nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF",
            local_path=str(staged),
        )
    )

    result = await resolve_groundedness_model_path(
        resolver, env_path=str(env_path), tenant_id=None, config=_config(tmp_path)
    )

    assert result == str(staged)


@pytest.mark.asyncio
async def test_env_fallback_when_db_empty(tmp_path: Path) -> None:
    """No registry opinion ⇒ today's env behaviour, byte-for-byte."""
    env_path = tmp_path / "from-env"
    env_path.mkdir()

    result = await resolve_groundedness_model_path(
        _StubResolver(None),
        env_path=str(env_path),
        tenant_id=None,
        config=_config(tmp_path),
    )

    assert result == str(env_path)


@pytest.mark.asyncio
async def test_env_fallback_when_db_row_has_no_path(tmp_path: Path) -> None:
    env_path = tmp_path / "from-env"
    env_path.mkdir()

    resolver = _StubResolver(
        ModelWeightIdentity(
            slug="minicheck-flan-t5-large",
            source_uri="nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF",
            local_path=None,
        )
    )

    result = await resolve_groundedness_model_path(
        resolver, env_path=str(env_path), tenant_id=None, config=_config(tmp_path)
    )

    assert result == str(env_path)


@pytest.mark.asyncio
async def test_neither_set_returns_none_keeping_fail_closed(tmp_path: Path) -> None:
    """Nothing anywhere ⇒ None, so `load_minicheck_scorer` still raises (fail-closed)."""
    result = await resolve_groundedness_model_path(
        _StubResolver(None), env_path=None, tenant_id=None, config=_config(tmp_path)
    )

    assert result is None


@pytest.mark.asyncio
async def test_hub_pull_blocked_for_clinical_gate(tmp_path: Path) -> None:
    """An hf:-only row must NOT trigger a download — it degrades to env/None."""
    resolver = _StubResolver(
        ModelWeightIdentity(
            slug="minicheck-flan-t5-large",
            source_uri="hf:nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF",
            source="HUGGINGFACE",
            local_path=None,
        )
    )

    result = await resolve_groundedness_model_path(
        resolver, env_path=None, tenant_id=None, config=_config(tmp_path)
    )

    # No exception, no download: the clinical gate degrades to 'unverified'
    # rather than auto-pulling weights.
    assert result is None


@pytest.mark.asyncio
async def test_resolver_failure_degrades_to_env(tmp_path: Path) -> None:
    """A DB/resolver blow-up must never cost us the staged env weights."""

    class _Exploding:
        async def resolve_model_source(self, tenant_id, task_key):
            raise RuntimeError("db unreachable")

    env_path = tmp_path / "from-env"
    env_path.mkdir()

    result = await resolve_groundedness_model_path(
        _Exploding(), env_path=str(env_path), tenant_id=None, config=_config(tmp_path)
    )

    assert result == str(env_path)
