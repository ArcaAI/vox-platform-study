"""The harness atomic-fact entailer resolves weights DB-first.

Harness has NO database access (services never read the DB directly), so
the registry path arrives via the control plane's effective-config `modelWeights`
map, keyed by the `AiModel` SLUG (`minicheck-flan-t5-large`) — harness's use has
no routing task key of its own.

The effective-config client does not yet always carry the `modelWeights`
contract, so this stage ships env-fallback-first: the control-plane lane is
implemented and tested against a stub, and degrades to
`HARNESS_ATOMIC_FACT_MODEL_PATH` whenever the key is absent — which is every
deployment until the control plane populates it.

Hermetic: no Temporal, no DB, no Redis, no network. `workflows.py` is untouched.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from harness.models.source_resolver import (
    ATOMIC_FACT_MODEL_SLUG,
    ModelSourceConfig,
    resolve_atomic_fact_model_path,
)


class _StubClient:
    """Stands in for the effective-config client."""

    def __init__(self, weights: dict | None = None, explode: bool = False) -> None:
        self._weights = weights or {}
        self._explode = explode
        self.calls = 0

    async def get(self):
        self.calls += 1
        if self._explode:
            raise RuntimeError("control plane unreachable")
        # `model_weights` is a METHOD on the real `EffectiveConfigSnapshot`. This
        # stub used to expose it as a plain attribute, which is precisely why
        # F-16 stayed invisible: the resolver's `getattr` fallback made a real
        # snapshot (with no such member) silently read as "no weights", and only
        # this stub ever took the control-plane branch.
        # `test_model_weights_loop.py` drives the REAL type; this file keeps the
        # stub so the surrounding degradation cases stay hermetic.
        weights = self._weights
        return type("Snapshot", (), {"model_weights": staticmethod(lambda: weights)})()


def _config(tmp_path: Path) -> ModelSourceConfig:
    return ModelSourceConfig(cache_dir=str(tmp_path / "cache"))


@pytest.mark.asyncio
async def test_effective_config_path_beats_env(tmp_path: Path) -> None:
    staged = tmp_path / "from-control-plane"
    staged.mkdir()
    env_path = tmp_path / "from-env"
    env_path.mkdir()

    client = _StubClient({ATOMIC_FACT_MODEL_SLUG: {"localPath": str(staged)}})

    result = await resolve_atomic_fact_model_path(
        client, env_path=str(env_path), config=_config(tmp_path)
    )

    assert result == str(staged)


@pytest.mark.asyncio
async def test_env_fallback_when_key_absent(tmp_path: Path) -> None:
    """Today's behaviour: no `modelWeights` key ⇒ the env path, unchanged."""
    env_path = tmp_path / "from-env"
    env_path.mkdir()

    result = await resolve_atomic_fact_model_path(
        _StubClient({}), env_path=str(env_path), config=_config(tmp_path)
    )

    assert result == str(env_path)


@pytest.mark.asyncio
async def test_env_fallback_when_client_absent(tmp_path: Path) -> None:
    """No client wired at all (the state until the control plane populates it)."""
    env_path = tmp_path / "from-env"
    env_path.mkdir()

    result = await resolve_atomic_fact_model_path(
        None, env_path=str(env_path), config=_config(tmp_path)
    )

    assert result == str(env_path)


@pytest.mark.asyncio
async def test_env_fallback_when_control_plane_unreachable(tmp_path: Path) -> None:
    """A control-plane outage must never cost us the staged env weights."""
    env_path = tmp_path / "from-env"
    env_path.mkdir()

    result = await resolve_atomic_fact_model_path(
        _StubClient(explode=True), env_path=str(env_path), config=_config(tmp_path)
    )

    assert result == str(env_path)


@pytest.mark.asyncio
async def test_neither_set_returns_none(tmp_path: Path) -> None:
    """Nothing anywhere ⇒ None ⇒ the caller keeps the deterministic entailer."""
    result = await resolve_atomic_fact_model_path(
        _StubClient({}), env_path=None, config=_config(tmp_path)
    )

    assert result is None


@pytest.mark.asyncio
async def test_unresolvable_source_uri_falls_back_to_env(tmp_path: Path) -> None:
    """An hf:-only entry does not auto-download inside an activity."""
    env_path = tmp_path / "from-env"
    env_path.mkdir()

    client = _StubClient(
        {ATOMIC_FACT_MODEL_SLUG: {"sourceUri": "hf:nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF"}}
    )

    result = await resolve_atomic_fact_model_path(
        client, env_path=str(env_path), config=_config(tmp_path)
    )

    assert result == str(env_path)


@pytest.mark.asyncio
async def test_missing_local_path_falls_through_to_env(tmp_path: Path) -> None:
    """Set-but-missing path falls THROUGH (warning), never a hard failure."""
    env_path = tmp_path / "from-env"
    env_path.mkdir()

    client = _StubClient({ATOMIC_FACT_MODEL_SLUG: {"localPath": str(tmp_path / "nope")}})

    result = await resolve_atomic_fact_model_path(
        client, env_path=str(env_path), config=_config(tmp_path)
    )

    assert result == str(env_path)


class TestEntailerWiring:
    """The safe floor is unchanged: no path anywhere ⇒ deterministic entailer."""

    def test_no_path_still_yields_deterministic_entailer(self) -> None:
        from harness.core.config import Settings
        from harness.sensors.inferential import DeterministicOverlapEntailer
        from harness.temporal.activities import _atomic_fact_entailer

        settings = Settings(atomic_fact_model_path=None)

        assert isinstance(_atomic_fact_entailer(settings), DeterministicOverlapEntailer)
