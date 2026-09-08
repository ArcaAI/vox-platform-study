"""A cold stack must be able to pre-load its guard weights (TASK-930 D-7).

`warm_models()` has always existed and has always been driven by the control
plane. Measured on the dev stack: **nothing produces `warmModels`** — no
gateway code path writes that key — and nlp boots BEFORE the gateway, so its
one-shot config fetch fails with `ConnectError` anyway. The warm path is
therefore inert in every environment, and the first `/guard/*` request pays the
whole cold load under an upstream that gives up in seconds.

This adds a BOOTSTRAP list (`NLP_WARM_MODELS`, empty by default) that names
weights to pre-load. It is a SCHEDULING lever, not a selection one: a request
still names its own model, resolved tenant-first by the caller, and an entry
here only decides that those weights are loaded before the first caller asks.
Empty by default keeps CI and every unconfigured process exactly as lazy as
they are today.
"""

from __future__ import annotations

import pytest

from nlp.core.effective_config import EffectiveConfigSnapshot
from nlp.lifespan import bootstrap_warm_models, warm_models


def test_the_bootstrap_list_is_empty_by_default() -> None:
    """No opinion ⇒ no warming. CI stays hermetic."""
    assert bootstrap_warm_models("") == []
    assert bootstrap_warm_models(None) == []


def test_entries_parse_as_name_and_optional_path() -> None:
    assert bootstrap_warm_models("acme/pii=/staged/pii, acme/safety ,, acme/x=") == [
        ("acme/pii", "/staged/pii"),
        ("acme/safety", None),
        ("acme/x", None),
    ]


@pytest.mark.asyncio
async def test_the_bootstrap_list_is_warmed_when_the_control_plane_offers_nothing() -> None:
    loaded: list[tuple[str, str | None]] = []

    async def fake_load(model_name: str, model_path: str | None) -> None:
        loaded.append((model_name, model_path))

    await warm_models(_StubClient([]), load=fake_load, bootstrap=[("acme/pii", "/staged/pii")])
    assert loaded == [("acme/pii", "/staged/pii")]


@pytest.mark.asyncio
async def test_an_unreachable_control_plane_no_longer_discards_the_bootstrap_list() -> None:
    """The whole cold-start case: the gateway is not up yet when nlp boots."""

    class BrokenClient:
        async def get(self):  # noqa: ANN202
            raise RuntimeError("control plane down")

    loaded: list[str] = []

    async def fake_load(model_name: str, model_path: str | None) -> None:
        loaded.append(model_name)

    await warm_models(BrokenClient(), load=fake_load, bootstrap=[("acme/pii", None)])
    assert loaded == ["acme/pii"]


@pytest.mark.asyncio
async def test_the_control_plane_wins_and_a_duplicate_is_loaded_once() -> None:
    """One model, one load — the served entry is authoritative for its path."""
    loaded: list[tuple[str, str | None]] = []

    async def fake_load(model_name: str, model_path: str | None) -> None:
        loaded.append((model_name, model_path))

    await warm_models(
        _StubClient([("acme/pii", "/served/pii")]),
        load=fake_load,
        bootstrap=[("acme/pii", "/bootstrap/pii"), ("acme/safety", None)],
    )
    assert loaded == [("acme/pii", "/served/pii"), ("acme/safety", None)]


class _StubClient:
    def __init__(self, models: list[tuple[str, str | None]]) -> None:
        self._models = models

    async def get(self) -> EffectiveConfigSnapshot:
        return EffectiveConfigSnapshot(
            raw={
                "warmModels": [
                    {"modelName": name, **({"modelPath": path} if path else {})}
                    for name, path in self._models
                ]
            },
            ok=True,
        )
