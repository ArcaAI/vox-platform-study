"""F-16 — the `modelWeights` loop, closed on the Python side.

`models/source_resolver.py` was written against a `modelWeights` block the TS
contract did not have; Phase 1 added the block. But the block still could not
reach the resolver, because the REAL `EffectiveConfigSnapshot` carried no
accessor for it — the resolver read it through
`getattr(snapshot, "model_weights", None)`, which silently yielded `{}` against
a real snapshot and sent every deployment down the env branch. The only tests
that passed used a hand-rolled stub that happened to expose the attribute, so
nothing failed.

These tests therefore drive `resolve_atomic_fact_model_path` with the REAL
snapshot type, parsed from the REAL wire shape the gateway serves
(`effective-config.model-weights.test.ts` pins the producing half).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from harness.core.effective_config import EffectiveConfigSnapshot
from harness.models.source_resolver import (
    ATOMIC_FACT_MODEL_SLUG,
    ModelSourceConfig,
    resolve_atomic_fact_model_path,
)


class _Client:
    """A client returning one REAL snapshot — no attribute the type lacks."""

    def __init__(self, payload: dict) -> None:
        self._snapshot = EffectiveConfigSnapshot(raw=payload, ok=True)

    async def get(self) -> EffectiveConfigSnapshot:
        return self._snapshot


def _config(tmp_path: Path) -> ModelSourceConfig:
    return ModelSourceConfig(cache_dir=str(tmp_path / "cache"))


def _wire(**entry: object) -> dict:
    """The gateway's `EffectiveConfigResponse` shape, `modelWeights` only."""
    return {
        "service": "harness",
        "generatedAt": "2026-08-23T00:00:00Z",
        "modelWeights": {ATOMIC_FACT_MODEL_SLUG: entry},
    }


# --------------------------------------------------------------------------
# The accessor
# --------------------------------------------------------------------------


def test_snapshot_exposes_model_weights_from_the_wire_shape() -> None:
    snapshot = EffectiveConfigSnapshot(
        raw=_wire(sourceUri="hf:lytang/MiniCheck", localPath=None, checksum="abc"), ok=True
    )
    assert snapshot.model_weights() == {
        ATOMIC_FACT_MODEL_SLUG: {
            "sourceUri": "hf:lytang/MiniCheck",
            "localPath": None,
            "checksum": "abc",
        }
    }


def test_absent_or_malformed_model_weights_read_as_no_opinion() -> None:
    """An omitted block means "keep the env value", never "no weights exist"."""
    assert EffectiveConfigSnapshot(raw={"service": "harness"}, ok=True).model_weights() == {}
    assert EffectiveConfigSnapshot(raw={"modelWeights": []}, ok=True).model_weights() == {}
    assert (
        EffectiveConfigSnapshot(raw={"modelWeights": {"slug": "oops"}}, ok=True).model_weights()
        == {}
    )
    assert EffectiveConfigSnapshot().model_weights() == {}


# --------------------------------------------------------------------------
# The loop
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolved_weight_beats_the_env_path(tmp_path: Path) -> None:
    """THE regression: a real snapshot carrying a weight must win over env."""
    staged = tmp_path / "from-control-plane"
    staged.mkdir()
    env_path = tmp_path / "from-env"
    env_path.mkdir()

    client = _Client(_wire(sourceUri="", localPath=str(staged), checksum=None))

    result = await resolve_atomic_fact_model_path(
        client, env_path=str(env_path), config=_config(tmp_path)
    )

    assert result == str(staged)
    assert result != str(env_path)


@pytest.mark.asyncio
async def test_env_still_wins_when_the_control_plane_has_no_opinion(tmp_path: Path) -> None:
    env_path = tmp_path / "from-env"
    env_path.mkdir()
    client = _Client({"service": "harness", "generatedAt": "2026-08-23T00:00:00Z"})

    result = await resolve_atomic_fact_model_path(
        client, env_path=str(env_path), config=_config(tmp_path)
    )

    assert result == str(env_path)
