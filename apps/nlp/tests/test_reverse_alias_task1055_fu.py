"""TASK-1055 follow-up — the reverse duplicate: a live request loaded first, the console second.

Owner requirement: "if a live clinical request loads a model before the console does, a
later console load SHOULD NOT load a duplicate." The clinical callers send the model
NAME only, so their copy sits under `name`; the console loads `(name, model_path)`.
Different keys, so the console's load cold-loaded a second copy of the same weights.

The name-only copy now serves a load (or a request) naming path P when its weights ARE
P — decided with the resolution the factories themselves use: the HuggingFace hub
snapshot the name resolves to (`refs/main` in the local hub cache), or the in-place
local path for a path-shaped / `file://` reference. Never when the weights differ, and
never when equality cannot be proven (no cached snapshot, a missing P, `s3://`).

No weights: factories are recorders, the hub cache is a temporary directory.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

NAME = "blaze999/Medical-NER"
MAIN_SHA = "a9d5061193e969de80b24225f926cb224caac1ce"
OLD_SHA = "0000000000000000000000000000000000000000"

WEIGHT_KEYED = {
    "nlp_token_classifier": "_create_token_classifier",
    "nlp_text_classifier": "_create_text_classifier",
    "nlp_gliner2_guard": "_create_gliner2_guard",
    "nlp_seq_cls_guard": "_create_seq_cls_guard",
    "nlp_judge_guard": "_create_judge_guard",
}


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
    def __init__(self, slot: str, key: str, device: str | None) -> None:
        self.slot, self.key, self.placement = slot, key, device

    async def shutdown(self) -> None:
        pass


@pytest.fixture
def hub(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A local hub cache holding NAME at two revisions; `refs/main` → MAIN_SHA."""
    from huggingface_hub import constants

    root = tmp_path / "hub"
    repo = root / "models--blaze999--Medical-NER"
    for sha in (MAIN_SHA, OLD_SHA):
        (repo / "snapshots" / sha).mkdir(parents=True)
        (repo / "snapshots" / sha / "config.json").write_text("{}")
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text(MAIN_SHA)
    monkeypatch.setattr(constants, "HF_HUB_CACHE", str(root))
    monkeypatch.delenv("NLP_MODEL_LOCAL_ROOTS", raising=False)
    return repo


@pytest.fixture
def release() -> asyncio.Event:
    event = asyncio.Event()
    event.set()
    return event


@pytest.fixture
def loads(
    monkeypatch: pytest.MonkeyPatch, hub: Path, release: asyncio.Event
) -> Iterator[list[Any]]:
    """Two visible GPUs; every weight-keyed factory records `(slot, key, device)`."""
    import nlp.core.device as device_module
    import nlp.dependencies as deps
    import nlp.residency as residency

    monkeypatch.setattr(residency, "gpu_devices", lambda *a, **k: [_fake_gpu(0), _fake_gpu(1)])
    monkeypatch.setattr(device_module.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(device_module.torch.cuda, "device_count", lambda: 2)
    monkeypatch.setattr(deps, "release_accelerator_memory", lambda device_id=None: None)
    calls: list[Any] = []
    for slot, attr in WEIGHT_KEYED.items():

        async def factory(key: str, device: str | None = None, _slot: str = slot) -> _Loaded:
            calls.append((_slot, key, device))
            await release.wait()
            return _Loaded(_slot, key, device)

        monkeypatch.setattr(deps, attr, factory)
    residency.nlp_device.cache_clear()
    deps.reset_model_caches()
    yield calls
    deps.reset_model_caches()
    residency.nlp_device.cache_clear()


def _snapshot(hub: Path, sha: str = MAIN_SHA) -> str:
    return f"{hub / 'snapshots' / sha}/"


def _pinned(slot: str) -> Any:
    import nlp.dependencies as deps

    return {
        "nlp_token_classifier": deps.pinned_token_classifier,
        "nlp_text_classifier": deps.pinned_text_classifier,
        "nlp_gliner2_guard": deps.pinned_gliner2_guard,
        "nlp_seq_cls_guard": deps.pinned_seq_cls_guard,
        "nlp_judge_guard": deps.pinned_judge_guard,
    }[slot]


async def _serve(slot: str, name: str, path: str | None = None) -> Any:
    async with _pinned(slot)(name, path) as service:
        return service


async def _console_load(
    slot: str, path: str | None, *, name: str = NAME, device: str | None = None
) -> dict[str, Any]:
    from nlp.residency import nlp_residency_agent

    return await nlp_residency_agent().load(
        name, {"cache": slot, "model_path": path}, pin=False, ttl_seconds=None, device=device
    )


@pytest.mark.parametrize("slot", sorted(WEIGHT_KEYED))
async def test_a_console_load_after_a_live_load_of_the_same_weights_is_already_loaded(
    loads: list[Any], hub: Path, slot: str
) -> None:
    live = await _serve(slot, NAME)

    out = await _console_load(slot, _snapshot(hub))

    assert out["outcome"] == "already_loaded"
    assert out["model"]["model_ref"] == NAME
    assert loads == [(slot, NAME, None)]  # no second copy
    assert await _serve(slot, NAME, _snapshot(hub)) is live


@pytest.mark.parametrize("slot", sorted(WEIGHT_KEYED))
async def test_a_request_naming_the_path_is_served_by_the_name_only_copy(
    loads: list[Any], hub: Path, slot: str
) -> None:
    live = await _serve(slot, NAME)

    served = await _serve(slot, NAME, _snapshot(hub))

    assert served is live
    assert len(loads) == 1


async def test_a_name_only_copy_on_another_device_serves_a_pathed_request(
    loads: list[Any], hub: Path
) -> None:
    await _console_load("nlp_token_classifier", None, device="cuda:1")

    served = await _serve("nlp_token_classifier", NAME, _snapshot(hub))

    assert served.placement == "cuda:1"
    assert len(loads) == 1


async def test_a_console_load_joins_a_live_load_still_in_flight(
    loads: list[Any], hub: Path, release: asyncio.Event
) -> None:
    import nlp.dependencies as deps

    release.clear()
    live = asyncio.create_task(_serve("nlp_token_classifier", NAME))
    cache = deps._cache_for("nlp_token_classifier")
    for _ in range(100):
        if NAME in cache._inflight:
            break
        await asyncio.sleep(0)

    console = asyncio.create_task(_console_load("nlp_token_classifier", _snapshot(hub)))
    await asyncio.sleep(0.01)
    release.set()
    served, out = await asyncio.gather(live, console)

    assert out["model"]["model_ref"] == NAME
    assert loads == [("nlp_token_classifier", NAME, None)]
    assert served.key == NAME


async def test_different_weights_are_a_second_copy(loads: list[Any], hub: Path) -> None:
    """P is another revision of the same repo: the name-only copy is not P."""
    await _serve("nlp_token_classifier", NAME)

    out = await _console_load("nlp_token_classifier", _snapshot(hub, OLD_SHA))

    assert out["outcome"] == "loaded"
    assert [key for _slot, key, _d in loads] == [NAME, f"{NAME}\x00{_snapshot(hub, OLD_SHA)}"]


async def test_unprovable_equality_is_a_second_copy(loads: list[Any], hub: Path) -> None:
    """No `refs/main` in the hub cache: what the name loaded cannot be proven to be P."""
    (hub / "refs" / "main").unlink()
    await _serve("nlp_token_classifier", NAME)

    out = await _console_load("nlp_token_classifier", _snapshot(hub))

    assert out["outcome"] == "loaded"
    assert len(loads) == 2


async def test_a_missing_path_is_never_aliased(loads: list[Any], hub: Path) -> None:
    await _serve("nlp_gliner2_guard", NAME)

    await _serve("nlp_gliner2_guard", NAME, "/nowhere/at/all/")

    assert [key for _slot, key, _d in loads] == [NAME, f"{NAME}\x00/nowhere/at/all/"]


async def test_a_console_load_on_another_device_is_its_own_placement(
    loads: list[Any], hub: Path
) -> None:
    """An explicit device is a deliberate placement: the default copy does not satisfy it."""
    await _serve("nlp_token_classifier", NAME)

    out = await _console_load("nlp_token_classifier", _snapshot(hub), device="cuda:1")

    assert out["outcome"] == "loaded"
    assert out["model"]["device"] == "cuda:1"


async def test_a_path_shaped_name_matches_the_same_directory_through_a_symlink(
    loads: list[Any], tmp_path: Path
) -> None:
    weights = tmp_path / "staged" / "gliguard"
    weights.mkdir(parents=True)
    link = tmp_path / "link"
    link.symlink_to(weights, target_is_directory=True)
    await _serve("nlp_gliner2_guard", str(weights))

    out = await _console_load("nlp_gliner2_guard", f"{link}/", name=str(weights))

    assert out["outcome"] == "already_loaded"
    assert len(loads) == 1


async def test_an_s3_name_is_never_proven_equal(loads: list[Any], tmp_path: Path) -> None:
    """`s3://` weights are a materialised copy whose directory the request cannot see."""
    staged = tmp_path / "s3-copy"
    staged.mkdir()
    name = "s3://hope-models/medical-ner"
    await _serve("nlp_token_classifier", name)

    await _serve("nlp_token_classifier", name, str(staged))

    assert len(loads) == 2


async def test_another_model_name_is_never_aliased(loads: list[Any], hub: Path) -> None:
    await _serve("nlp_token_classifier", "blaze999/Medical-NER-v2")

    out = await _console_load("nlp_token_classifier", _snapshot(hub))

    assert out["outcome"] == "loaded"
