"""TASK-1055 follow-up — the platform admin manages EVERY nlp model, the guards included.

Before: the residency planner refused `nlp_seq_cls_guard` (Prompt Guard 2) and
`nlp_judge_guard` (the generative guard judge) as "unknown cache", so the console
could not load them, place them, or pin them, though their caches were already
residency-wired. They take the same `load_spec` as the other single-model slots —
`{cache, model_path}` — and are keyed the way the request path keys them, so an agent
load makes the next guard request a hit.

No weights: the factories are replaced by recorders.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

NAME = "meta-llama/Llama-Prompt-Guard-2-86M"
PATH = "/mnt/models-bucket/hf/hub/models--meta-llama--Llama-Prompt-Guard-2-86M/snapshots/abc/"
GUARD_SLOTS = ("nlp_seq_cls_guard", "nlp_judge_guard")
FACTORIES = {"nlp_seq_cls_guard": "_create_seq_cls_guard", "nlp_judge_guard": "_create_judge_guard"}


def _fake_gpu(index: int) -> Any:
    from hope_runtime_models import Device
    from hope_runtime_models.vram import DeviceMemory

    return Device(
        id=f"cuda:{index}",
        kind="gpu",
        memory=lambda: DeviceMemory(free_bytes=8 << 30, total_bytes=16 << 30),
        usage=lambda: 8 << 30,
    )


class _Loaded:
    made: list[_Loaded] = []

    def __init__(self, key: str, device: str | None) -> None:
        self.key, self.placement, self.shut = key, device, False
        _Loaded.made.append(self)

    async def shutdown(self) -> None:
        self.shut = True


@pytest.fixture
def loads(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[Any]]:
    """Two visible GPUs; both guard factories record `(slot, key, device)`."""
    import nlp.core.device as device_module
    import nlp.dependencies as deps
    import nlp.residency as residency

    monkeypatch.setattr(residency, "gpu_devices", lambda *a, **k: [_fake_gpu(0), _fake_gpu(1)])
    monkeypatch.setattr(device_module.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(device_module.torch.cuda, "device_count", lambda: 2)
    monkeypatch.setattr(deps, "release_accelerator_memory", lambda device_id=None: None)
    calls: list[Any] = []
    _Loaded.made.clear()

    for slot, attr in FACTORIES.items():

        async def factory(key: str, device: str | None = None, _slot: str = slot) -> _Loaded:
            calls.append((_slot, key, device))
            return _Loaded(key, device)

        monkeypatch.setattr(deps, attr, factory)
    residency.nlp_device.cache_clear()
    deps.reset_model_caches()
    yield calls
    deps.reset_model_caches()
    residency.nlp_device.cache_clear()


def _agent() -> Any:
    from nlp.residency import nlp_residency_agent

    return nlp_residency_agent()


def _pinned(slot: str) -> Any:
    import nlp.dependencies as deps

    return {
        "nlp_seq_cls_guard": deps.pinned_seq_cls_guard,
        "nlp_judge_guard": deps.pinned_judge_guard,
    }[slot]


@pytest.mark.parametrize("slot", GUARD_SLOTS)
async def test_the_agent_loads_a_guard_and_the_next_request_is_a_hit(
    loads: list[Any], slot: str
) -> None:
    import nlp.dependencies as deps

    out = await _agent().load(
        NAME, {"cache": slot, "model_path": PATH}, pin=False, ttl_seconds=None
    )

    key = deps._model_cache_key(NAME, PATH)
    assert out["outcome"] == "loaded"
    assert (out["model"]["cache"], out["model"]["model_ref"]) == (slot, NAME)
    assert loads == [(slot, key, None)]
    async with _pinned(slot)(NAME, PATH) as served:
        assert served.key == key
    assert len(loads) == 1  # the request reused the agent's copy


@pytest.mark.parametrize("slot", GUARD_SLOTS)
async def test_a_guard_load_without_a_path_keys_the_name_alone(loads: list[Any], slot: str) -> None:
    out = await _agent().load(
        NAME, {"cache": slot, "model_path": None}, pin=False, ttl_seconds=None
    )

    assert out["outcome"] == "loaded"
    assert loads == [(slot, NAME, None)]


@pytest.mark.parametrize("slot", GUARD_SLOTS)
async def test_a_guard_load_honours_the_device(loads: list[Any], slot: str) -> None:
    import nlp.dependencies as deps

    out = await _agent().load(
        NAME, {"cache": slot, "model_path": PATH}, pin=False, ttl_seconds=None, device="cuda:1"
    )

    assert out["model"]["device"] == "cuda:1"
    assert loads == [(slot, deps._model_cache_key(NAME, PATH), "cuda:1")]
    assert deps._cache_for(slot).cached_keys() == []


@pytest.mark.parametrize("slot", GUARD_SLOTS)
async def test_the_report_lists_guard_copies_on_every_device(loads: list[Any], slot: str) -> None:
    agent = _agent()
    spec = {"cache": slot, "model_path": PATH}
    await agent.load(NAME, spec, pin=False, ttl_seconds=None)
    await agent.load(NAME, spec, pin=False, ttl_seconds=None, device="cuda:1")

    rows = [m for m in agent.report()["models"] if m["cache"] == slot]

    assert sorted(m["device"] for m in rows) == ["cpu", "cuda:1"]
    assert {m["model_ref"] for m in rows} == {NAME}


@pytest.mark.parametrize("slot", GUARD_SLOTS)
async def test_pin_ttl_and_unload_work_on_a_guard(loads: list[Any], slot: str) -> None:
    import nlp.dependencies as deps

    agent = _agent()
    out = await agent.load(NAME, {"cache": slot, "model_path": PATH}, pin=True, ttl_seconds=900)
    assert out["model"]["admin_pinned"] is True

    policy = await agent.set_policy(NAME, admin_pinned=False, ttl_seconds=600)
    assert (policy["model"]["admin_pinned"], policy["model"]["ttl_seconds"]) == (False, 600)

    [instance] = _Loaded.made
    result = await agent.unload(NAME, force=False, reason="console")

    assert result["outcome"] == "unloaded"
    assert deps._cache_for(slot).cached_keys() == []
    assert instance.shut is True


@pytest.mark.parametrize("slot", GUARD_SLOTS)
async def test_a_guard_load_spec_takes_only_cache_and_model_path(
    loads: list[Any], slot: str
) -> None:
    from hope_runtime_models.residency_agent import ResidencyError

    with pytest.raises(ResidencyError) as refused:
        await _agent().load(
            NAME,
            {"cache": slot, "model_path": PATH, "ner_model_name": "x"},
            pin=False,
            ttl_seconds=None,
        )

    assert refused.value.status == 400
    assert loads == []
