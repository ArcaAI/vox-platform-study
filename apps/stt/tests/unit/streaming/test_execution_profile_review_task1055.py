"""TASK-1055 review R2-F3 — exposing a second GPU must not change live behaviour.

The deployment widens ``CUDA_VISIBLE_DEVICES`` from ``0`` to ``0,1`` ONLY so a
platform admin can place a model on GPU 1. Merely SEEING two GPUs therefore keeps
the single-GPU profile on ``cuda:0`` (20 streams, embedding on CPU, pool 8, no
split); the multi-GPU split profile is reachable only when the caller passes the
GPUs to split across explicitly.
"""

from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest

from stt.core.platform import PlatformType


@pytest.fixture
def cuda_host() -> Iterator[MagicMock]:
    """A CUDA host of 16 GB cards whose visible GPU count each test sets."""
    settings = MagicMock()
    settings.streaming_max_concurrent = 0
    settings.streaming_max_batch_size = 0
    with (
        patch("stt.streaming.execution_profile.detect_platform", return_value=PlatformType.CUDA),
        patch("stt.streaming.execution_profile.get_settings", return_value=settings),
        patch("stt.streaming.execution_profile._get_cuda_vram_gb", return_value=16.0),
        patch(
            "stt.streaming.execution_profile._get_cuda_device_name",
            return_value="NVIDIA RTX 2000 Ada Generation",
        ),
        patch("stt.streaming.execution_profile._get_cuda_gpu_count") as gpu_count,
        patch("stt.streaming.execution_profile._get_total_cuda_vram_gb") as total_vram,
    ):
        gpu_count.side_effect = lambda: gpu_count.visible
        total_vram.side_effect = lambda: 16.0 * gpu_count.visible
        yield gpu_count


def _visible(cuda_host: MagicMock, count: int) -> None:
    cuda_host.visible = count


def test_two_visible_gpus_keep_the_single_gpu_profile(cuda_host: MagicMock) -> None:
    from stt.streaming.execution_profile import detect_execution_profile

    _visible(cuda_host, 1)
    one = detect_execution_profile()
    _visible(cuda_host, 2)
    two = detect_execution_profile()

    assert two == one
    assert two.asr_device == "cuda:0"
    assert two.max_concurrent_streams == 20
    assert two.embedding_device == "cpu"
    assert two.preprocess_pool_size == 8
    assert two.multi_gpu_strategy == "none"


def test_the_split_profile_is_opt_in_by_naming_the_gpus(cuda_host: MagicMock) -> None:
    from stt.streaming.execution_profile import detect_execution_profile

    _visible(cuda_host, 2)
    profile = detect_execution_profile(multi_gpu_devices=["cuda:0", "cuda:1"])

    assert profile.multi_gpu_strategy == "split"
    assert profile.embedding_device == "cuda:1"
    assert profile.max_concurrent_streams == 40


def test_naming_one_gpu_is_not_a_split(cuda_host: MagicMock) -> None:
    from stt.streaming.execution_profile import detect_execution_profile

    _visible(cuda_host, 2)
    profile = detect_execution_profile(multi_gpu_devices=["cuda:0"])

    assert profile.multi_gpu_strategy == "none"
    assert profile.max_concurrent_streams == 20
