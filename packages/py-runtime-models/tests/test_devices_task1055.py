"""TASK-1055 wave 0 — GPU enumeration maps CUDA order onto NVML indices."""

from hope_runtime_models import devices as devices_module
from hope_runtime_models.devices import gpu_devices, visible_gpu_indices
from hope_runtime_models.vram import DeviceMemory


def test_visible_indices_follow_cuda_visible_devices() -> None:
    assert visible_gpu_indices({"CUDA_VISIBLE_DEVICES": "1"}) == [1]
    assert visible_gpu_indices({"CUDA_VISIBLE_DEVICES": "0,1"}) == [0, 1]
    assert visible_gpu_indices({"CUDA_VISIBLE_DEVICES": ""}) == []
    assert visible_gpu_indices({"CUDA_VISIBLE_DEVICES": "GPU-abc"}) is None
    assert visible_gpu_indices({}) is None


def test_gpu_devices_reads_the_nvml_index_behind_each_cuda_id(monkeypatch) -> None:
    def fake_probe(index: int):
        return lambda: DeviceMemory(free_bytes=index * 10, total_bytes=100)

    monkeypatch.setattr(devices_module, "make_vram_info_probe", fake_probe)
    found = gpu_devices({"CUDA_VISIBLE_DEVICES": "1,0"})
    assert [d.id for d in found] == ["cuda:0", "cuda:1"]
    # cuda:0 is NVML index 1 under CUDA_VISIBLE_DEVICES=1,0
    assert found[0].memory().free_bytes == 10
    assert found[1].memory().free_bytes == 0
    assert found[0].usage() == 90


def test_gpu_devices_probes_nvml_when_unrestricted(monkeypatch) -> None:
    def fake_probe(index: int):
        def probe() -> DeviceMemory:
            if index >= 2:
                raise RuntimeError("no such device")
            return DeviceMemory(free_bytes=1, total_bytes=2)

        return probe

    monkeypatch.setattr(devices_module, "make_vram_info_probe", fake_probe)
    assert [d.id for d in gpu_devices({})] == ["cuda:0", "cuda:1"]


def test_gpu_devices_is_empty_without_nvml(monkeypatch) -> None:
    monkeypatch.setattr(devices_module, "make_vram_info_probe", lambda index: None)
    assert gpu_devices({}) == []
