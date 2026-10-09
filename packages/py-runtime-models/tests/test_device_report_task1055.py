"""TASK-1055 — the residency report's per-device extras, and the INSUFFICIENT_MEMORY body.

``devices[]`` entries carry ``index`` (the NVML index behind ``cuda:<i>``, through
``CUDA_VISIBLE_DEVICES``), ``name`` / ``uuid`` (NVML; None when unknown) and
``process_bytes`` (``torch.cuda.memory_reserved`` for that CUDA index, read ONLY when torch
is already imported). Contract: ``tests/contracts/model-residency-task1055.fixture.json``.
No GPU, no NVML, no torch: every reader is a fake.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from hope_runtime_models import AdmissionRejected, Device, DeviceMemory, vram
from hope_runtime_models.residency_agent import LoadPlan, ResidencyAgent
from hope_runtime_models.residency_api import build_residency_router

GIB = 1024**3


def _fixture() -> dict[str, Any]:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts" / "model-residency-task1055.fixture.json"
        if candidate.exists():
            loaded: dict[str, Any] = json.loads(candidate.read_text())
            return loaded
    raise FileNotFoundError("model-residency-task1055.fixture.json not found above this test")


PY = _fixture()["python"]
NAMES = {0: "NVIDIA RTX 2000 Ada Generation", 1: "NVIDIA RTX A6000"}
UUIDS = {
    0: "GPU-be50f6fc-59ec-9c5b-c925-c962344c734c",
    1: "GPU-55c35bac-8291-a08a-2cb2-a43648336aa5",
}


def device(device_id: str, kind: str = "gpu") -> Device:
    memory = DeviceMemory(free_bytes=5 * GIB, total_bytes=16 * GIB)
    return Device(id=device_id, kind=kind, memory=lambda: memory)  # type: ignore[arg-type]


def agent_with(devices: list[Device]) -> ResidencyAgent:
    return ResidencyAgent(
        service="nlp", instance="hope-nlp-test", bindings=lambda: [], devices=lambda: devices
    )


def two_gpus_report() -> dict[str, Any]:
    return agent_with([device("cuda:0"), device("cuda:1")]).report()


@pytest.fixture
def nvml_readers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vram, "nvml_device_name", lambda index: NAMES.get(index))
    monkeypatch.setattr(vram, "nvml_device_uuid", lambda index: UUIDS.get(index))


def fake_torch(*, initialized: bool = True, reserved: dict[int, int] | None = None) -> Any:
    reserved = reserved if reserved is not None else {}

    def memory_reserved(index: int) -> int:
        return reserved[index]

    return types.SimpleNamespace(
        cuda=types.SimpleNamespace(
            is_initialized=lambda: initialized, memory_reserved=memory_reserved
        )
    )


# ── device JSON extras ──────────────────────────────────────────────────────


def test_device_entries_match_the_v2_fixture_key_set(nvml_readers: None) -> None:
    report = agent_with([device("cuda:0"), device("cpu", "cpu")]).report()
    expected = set(PY["report"]["devices"][0])
    assert [set(entry) for entry in report["devices"]] == [expected, expected]


def test_cuda_ids_map_to_the_nvml_index_behind_them(
    nvml_readers: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "1,0")
    monkeypatch.delitem(sys.modules, "torch", raising=False)

    gpus = {d["id"]: d for d in two_gpus_report()["devices"]}
    assert gpus["cuda:0"]["index"] == 1
    assert gpus["cuda:0"]["name"] == NAMES[1]
    assert gpus["cuda:0"]["uuid"] == UUIDS[1]
    assert gpus["cuda:1"]["index"] == 0
    assert gpus["cuda:1"]["uuid"] == UUIDS[0]


def test_without_cuda_visible_devices_the_cuda_index_is_the_nvml_index(
    nvml_readers: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    (gpu,) = agent_with([device("cuda:1")]).report()["devices"]
    assert (gpu["index"], gpu["uuid"]) == (1, UUIDS[1])


def test_cpu_device_carries_the_extras_as_null(nvml_readers: None) -> None:
    (entry,) = agent_with([device("cpu", "cpu")]).report()["devices"]
    assert entry["kind"] == "cpu"
    assert (entry["index"], entry["name"], entry["uuid"], entry["process_bytes"]) == (
        None,
        None,
        None,
        None,
    )


def test_unreadable_nvml_reports_null_name_and_uuid(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vram, "_nvml_ready", False)
    monkeypatch.setattr(vram, "_nvml_lib", None)
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    (gpu,) = agent_with([device("cuda:0")]).report()["devices"]
    assert (gpu["index"], gpu["name"], gpu["uuid"]) == (0, None, None)
    assert gpu["total_bytes"] == 16 * GIB  # the rest of the entry is unaffected


def test_process_bytes_reads_torch_reserved_for_the_cuda_index(
    nvml_readers: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "1,0")  # cuda index, NOT the NVML index
    monkeypatch.setitem(sys.modules, "torch", fake_torch(reserved={0: 1_946_157_056, 1: 0}))
    gpus = {d["id"]: d for d in two_gpus_report()["devices"]}
    assert gpus["cuda:0"]["process_bytes"] == 1_946_157_056
    assert gpus["cuda:1"]["process_bytes"] == 0


def test_process_bytes_is_null_when_torch_is_not_imported(
    nvml_readers: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    (gpu,) = agent_with([device("cuda:0")]).report()["devices"]
    assert gpu["process_bytes"] is None
    assert "torch" not in sys.modules  # the report never imports it


@pytest.mark.parametrize(
    "torch",
    [fake_torch(initialized=False), fake_torch(reserved={})],
    ids=["cuda-not-initialised", "reader-raises"],
)
def test_process_bytes_is_null_when_torch_cannot_say(
    nvml_readers: None, monkeypatch: pytest.MonkeyPatch, torch: Any
) -> None:
    monkeypatch.setitem(sys.modules, "torch", torch)
    (gpu,) = agent_with([device("cuda:0")]).report()["devices"]
    assert gpu["process_bytes"] is None


# ── NVML readers (vram.py) ──────────────────────────────────────────────────


class _FakePynvml(types.ModuleType):
    def __init__(self) -> None:
        super().__init__("pynvml")

    def nvmlInit(self) -> None:  # noqa: N802 — the real API's spelling
        return None

    def nvmlDeviceGetHandleByIndex(self, index: int) -> int:  # noqa: N802
        if index not in NAMES:
            raise RuntimeError("NVML_ERROR_INVALID_ARGUMENT")
        return index

    def nvmlDeviceGetName(self, handle: int) -> bytes:  # noqa: N802 — old bindings: bytes
        return NAMES[handle].encode()

    def nvmlDeviceGetUUID(self, handle: int) -> str:  # noqa: N802 — new bindings: str
        return UUIDS[handle]


@pytest.fixture
def fake_pynvml(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "pynvml", _FakePynvml())
    vram.reset_nvml_detection()
    yield
    vram.reset_nvml_detection()


def test_pynvml_readers_return_text_for_bytes_and_str(fake_pynvml: None) -> None:
    assert vram.nvml_device_name(1) == NAMES[1]
    assert vram.nvml_device_uuid(0) == UUIDS[0]


def test_readers_never_raise_on_a_bad_index(fake_pynvml: None) -> None:
    assert vram.nvml_device_name(7) is None
    assert vram.nvml_device_uuid(7) is None


def test_readers_are_none_without_nvml(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vram, "_nvml_ready", False)
    monkeypatch.setattr(vram, "_nvml_lib", None)
    assert vram.nvml_device_name(0) is None
    assert vram.nvml_device_uuid(0) is None


class _FakeLibNvml:
    """The ctypes fallback: writes C strings into the buffer it is handed."""

    def nvmlDeviceGetHandleByIndex_v2(self, index: int, _handle: Any) -> int:  # noqa: N802
        return 0 if index in NAMES else 2

    def nvmlDeviceGetName(self, _handle: Any, buffer: Any, length: int) -> int:  # noqa: N802
        buffer.value = NAMES[0].encode()[: length - 1]
        return 0

    def nvmlDeviceGetUUID(self, _handle: Any, buffer: Any, length: int) -> int:  # noqa: N802
        buffer.value = UUIDS[0].encode()[: length - 1]
        return 0


def test_ctypes_readers_decode_the_driver_buffers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vram, "_nvml_ready", True)
    monkeypatch.setattr(vram, "_nvml_lib", _FakeLibNvml())
    assert vram.nvml_device_name(0) == NAMES[0]
    assert vram.nvml_device_uuid(0) == UUIDS[0]
    assert vram.nvml_device_name(9) is None  # handle lookup failed: None, not a raise


# ── INSUFFICIENT_MEMORY (wave 0 already carries the fields) ─────────────────


async def test_insufficient_memory_body_names_the_device_and_the_numbers() -> None:
    expected = PY["errors"]["INSUFFICIENT_MEMORY"]["error"]
    gpu = device("cuda:0")

    class _Cache:
        name = "nlp_gliner2_guard"
        residency = types.SimpleNamespace(device=gpu)

        def residency_snapshot(self) -> list[Any]:
            return []

    cache = _Cache()

    async def refuse() -> None:
        raise AdmissionRejected(
            "X",
            device_id="cuda:0",
            free_bytes=expected["free_bytes"],
            total_bytes=16 * GIB,
            needed_bytes=expected["needed_bytes"],
            headroom_bytes=expected["headroom_bytes"],
            retry_after_seconds=5,
        )

    async def planner(model_ref: str, load_spec: dict[str, Any], *, device: str | None = None):
        return LoadPlan(cache=cache, key=model_ref, load=refuse)

    agent = ResidencyAgent(
        service="nlp",
        instance="t",
        bindings=lambda: [],
        planner=planner,
    )
    app = FastAPI()
    app.include_router(build_residency_router(agent))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://svc") as client:
        response = await client.post("/internal/residency/load", json=PY["loadRequest"])

    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"
    body = response.json()["error"]
    assert set(body) == set(expected)
    assert body["code"] == "INSUFFICIENT_MEMORY"
    assert body["device"] == "cuda:0"
    for field in ("needed_bytes", "free_bytes", "headroom_bytes"):
        assert body[field] == expected[field]
