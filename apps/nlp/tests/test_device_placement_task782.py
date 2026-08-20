"""TASK-782 — device placement contract.

The measured fact this file protects: an unsupported op on MPS aborts the
PROCESS (SIGABRT from an MPSNDArray assertion) rather than raising. So placement
cannot be discovered by trying it, the relocation of the known-bad submodule is
mandatory rather than an optimisation, and an explicit-but-absent device must
fail loudly instead of degrading to CPU behind the operator's back.
"""

from __future__ import annotations

import pytest
import torch
import torch.nn as nn

from nlp.core.device import (
    DevicePlacementError,
    apply_device_placement,
    parse_cpu_only_modules,
    resolve_inference_device,
)


class _Counter(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.linear = nn.Linear(4, 4)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.linear(x)


class _Toy(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.encoder = nn.Linear(4, 4)
        self.count_embed = nn.Module()
        self.count_embed.gru = _Counter()  # type: ignore[assignment]


def test_empty_or_absent_configuration_means_cpu() -> None:
    assert resolve_inference_device(None) == "cpu"
    assert resolve_inference_device("") == "cpu"
    assert resolve_inference_device("  CPU ") == "cpu"


def test_auto_degrades_to_cpu_rather_than_raising() -> None:
    """`auto` is the ONLY form allowed to silently land on CPU."""
    assert resolve_inference_device("auto") in {"cpu", "mps", "cuda"}


def test_an_explicit_but_unavailable_device_fails_closed() -> None:
    """A latency SLO built on an accelerator that is not there is a false promise."""
    absent = "cuda" if not torch.cuda.is_available() else "mps"
    if absent == "mps" and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        pytest.skip("both accelerators present on this host")
    with pytest.raises(DevicePlacementError):
        resolve_inference_device(absent)


def test_an_unknown_device_name_is_refused() -> None:
    with pytest.raises(DevicePlacementError):
        resolve_inference_device("tpu")


def test_cpu_placement_is_a_no_op() -> None:
    model = _Toy()
    assert apply_device_placement(model, "cpu", ("count_embed.gru",)) == "cpu"
    # No island is inserted on CPU: the relocation exists only to dodge an MPS
    # assertion, so paying its transfer on CPU would be pure overhead.
    assert isinstance(model.count_embed.gru, _Counter)
    assert model.encoder.weight.device.type == "cpu"


def test_parse_cpu_only_modules_tolerates_spacing_and_blanks() -> None:
    assert parse_cpu_only_modules(" count_embed.gru , , a.b ") == ("count_embed.gru", "a.b")
    assert parse_cpu_only_modules("") == ()
    assert parse_cpu_only_modules(None) == ()


@pytest.mark.skipif(
    not (getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),
    reason="MPS not available on this host",
)
def test_mps_placement_leaves_the_named_submodule_on_cpu_and_still_computes() -> None:
    """The relocation is what stops the first forward pass killing the worker."""
    model = _Toy()
    assert apply_device_placement(model, "mps", ("count_embed.gru",)) == "mps"

    assert model.encoder.weight.device.type == "mps"
    inner = model.count_embed.gru.inner  # the CPU island's payload
    assert inner.linear.weight.device.type == "cpu"

    # An MPS tensor goes in, an MPS tensor comes out — the island is invisible
    # to the surrounding graph, which is the only way a third-party forward()
    # that never heard of it keeps working.
    out = model.count_embed.gru(torch.randn(2, 4, device="mps"))
    assert out.device.type == "mps"


@pytest.mark.skipif(
    not (getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),
    reason="MPS not available on this host",
)
def test_an_absent_relocation_path_is_skipped_not_fatal() -> None:
    """The list describes a torch/gliner2 gap; a build without it is the good case."""
    model = _Toy()
    assert apply_device_placement(model, "mps", ("no.such.module",)) == "mps"
    assert model.encoder.weight.device.type == "mps"
