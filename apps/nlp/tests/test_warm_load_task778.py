"""TASK-778 — models are WARMED at startup, from config, never from a literal.

A cold GLiNER2 load measured 220s on this hardware (download + init). Serving
that on the first request means the first consultation of every deploy pays a
multi-minute stall, and a scale-out event under load stalls behind the very
burst that triggered it. Warm load moves that cost to boot.

Two constraints shape the design:

* the WARM SET is configuration — it names model ids, so it can only come from
  the control plane (`AiTaskDefault` ⋈ `AiModel`, served through
  `/internal/effective-config`), never from an env var or a Python literal;
* warming must NOT block or fail boot. A gateway outage, or a model that cannot
  load, leaves the service up and lazy — exactly the pre-TASK-778 behaviour.
"""

from __future__ import annotations

import asyncio

import pytest

from nlp.core.effective_config import EffectiveConfigSnapshot


def test_warm_set_comes_from_the_control_plane() -> None:
    snapshot = EffectiveConfigSnapshot(
        raw={
            "warmModels": [
                {"modelName": "acme/pii", "modelPath": "/staged/pii"},
                {"modelName": "acme/safety"},
            ]
        },
        ok=True,
    )
    assert snapshot.warm_models() == [("acme/pii", "/staged/pii"), ("acme/safety", None)]


def test_no_opinion_means_no_warming_not_a_guessed_default() -> None:
    """Absent/failed config ⇒ lazy loading, never a substituted model id."""
    assert EffectiveConfigSnapshot(raw={}, ok=False).warm_models() == []
    assert EffectiveConfigSnapshot(raw={"warmModels": None}, ok=True).warm_models() == []
    assert EffectiveConfigSnapshot(raw={"warmModels": []}, ok=True).warm_models() == []


def test_malformed_entries_are_dropped_never_coerced() -> None:
    snapshot = EffectiveConfigSnapshot(
        raw={"warmModels": [{"modelPath": "/only/path"}, "not-a-dict", {"modelName": ""}, 7]},
        ok=True,
    )
    assert snapshot.warm_models() == []


@pytest.mark.asyncio
async def test_warmup_loads_every_configured_model() -> None:
    from nlp.lifespan import warm_models

    loaded: list[tuple[str, str | None]] = []

    async def fake_load(model_name: str, model_path: str | None) -> None:
        loaded.append((model_name, model_path))

    await warm_models(
        _StubClient([("acme/pii", "/staged/pii"), ("acme/safety", None)]), load=fake_load
    )
    assert loaded == [("acme/pii", "/staged/pii"), ("acme/safety", None)]


@pytest.mark.asyncio
async def test_a_failing_warmup_never_takes_the_service_down() -> None:
    """Warming is an optimisation. A model that will not load must not block boot."""
    from nlp.lifespan import warm_models

    attempted: list[str] = []

    async def exploding_load(model_name: str, model_path: str | None) -> None:
        attempted.append(model_name)
        raise RuntimeError("weights missing")

    # Must not raise, and must still try the SECOND model — one bad row does not
    # cancel the rest of the warm set.
    await warm_models(_StubClient([("a", None), ("b", None)]), load=exploding_load)
    assert attempted == ["a", "b"]


@pytest.mark.asyncio
async def test_an_unreachable_control_plane_degrades_to_lazy_loading() -> None:
    from nlp.lifespan import warm_models

    class BrokenClient:
        async def get(self):  # noqa: ANN202
            raise RuntimeError("gateway down")

    called = False

    async def load(model_name: str, model_path: str | None) -> None:
        nonlocal called
        called = True

    await warm_models(BrokenClient(), load=load)
    assert called is False


class _StubClient:
    def __init__(self, models: list[tuple[str, str | None]]) -> None:
        self._models = models

    async def get(self) -> EffectiveConfigSnapshot:
        await asyncio.sleep(0)
        return EffectiveConfigSnapshot(
            raw={
                "warmModels": [
                    {"modelName": name, **({"modelPath": path} if path else {})}
                    for name, path in self._models
                ]
            },
            ok=True,
        )
