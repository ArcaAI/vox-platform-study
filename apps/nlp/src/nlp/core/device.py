"""Inference device placement for the guard plane (TASK-782).

TASK-778 measured the safety plane against real weights on CPU and found the
throughput target met and the LATENCY target missed: p95 ~1.7 s under a 100-way
burst, fit for an asynchronous redaction pass and unfit for a synchronous inline
gate. It named the bottleneck as encoder compute and the remedy as placement.
This module is the placement.

WHAT IS AND IS NOT CONFIG HERE
------------------------------
A device name is TRANSPORT/TOPOLOGY — *where* the tensors execute — not model
identity, taxonomy or threshold. It is therefore legitimately env-tier with a
control-plane override, exactly like the batching geometry, and unlike a model
id, which may never be a settings default
(`00-project-context.md` §Configuration Principles).

THE ONE HARD FACT ABOUT MPS, MEASURED
-------------------------------------
On this platform `gliner2`'s counting layer (`count_embed.gru`, a hand-rolled
GRU of `F.linear`/`chunk`/`sigmoid`) trips an MPSNDArray assertion:

    MPSNDArray.mm:893: failed assertion
    `initWithBufferImpl:...` Error: buffer is not large enough.

That assertion **aborts the process with SIGABRT**. It does NOT raise a Python
exception. Two consequences drive the whole design of this module:

1. **`try: mps except: fall back to cpu` is impossible.** There is nothing to
   catch. A device that turns out to be unsupported takes the worker down, so
   placement must be decided BEFORE any tensor executes, never discovered.
2. **The relocation is mandatory, not an optimisation.** When the device is
   `mps`, the named submodules are moved back to CPU as part of placement. Skip
   it and the first request kills the process.

The relocated module list is a runtime-compatibility fact about the installed
`gliner2` build, so it is configurable — a newer torch that fixes the assertion
should be answerable by emptying the list, not by editing this file.

FAIL-CLOSED ON AN EXPLICIT REQUEST
----------------------------------
`auto` degrades: it picks the best device that is actually present. An EXPLICIT
`mps`/`cuda` that is unavailable RAISES instead of quietly running on CPU,
because a latency SLO built on an accelerator that silently is not there is a
false promise — the operator must see the misconfiguration, not a 3x latency
regression they have to discover from a dashboard.
"""

from __future__ import annotations

from typing import Any

import torch
import torch.nn as nn

from nlp.core.logging import get_logger

logger = get_logger(__name__)

__all__ = [
    "DevicePlacementError",
    "resolve_inference_device",
    "apply_device_placement",
    "parse_cpu_only_modules",
]

_CPU = "cpu"
_AUTO = "auto"
_SUPPORTED = ("cpu", "mps", "cuda")


class DevicePlacementError(RuntimeError):
    """An explicitly requested device is unavailable, or placement failed."""


def _available(device: str) -> bool:
    if device == _CPU:
        return True
    if device == "cuda":
        return bool(torch.cuda.is_available())
    if device == "mps":
        backend = getattr(torch.backends, "mps", None)
        return bool(backend is not None and backend.is_available())
    return False


def resolve_inference_device(requested: str | None) -> str:
    """Map a configured device name to the device that will actually be used.

    `""`/`None` means CPU (the safe bootstrap floor). `auto` picks the best
    device present. Anything else must BE present — see the module docstring on
    why an explicit request never degrades silently.
    """
    name = (requested or "").strip().lower() or _CPU

    if name == _AUTO:
        for candidate in ("cuda", "mps"):
            if _available(candidate):
                return candidate
        return _CPU

    if name not in _SUPPORTED:
        raise DevicePlacementError(
            f"unsupported inference device {name!r}; expected one of "
            f"{_AUTO!r} or {_SUPPORTED}"
        )
    if not _available(name):
        raise DevicePlacementError(
            f"inference device {name!r} was configured explicitly but is not available "
            "on this host. Configure 'auto' to degrade to CPU deliberately."
        )
    return name


def parse_cpu_only_modules(raw: str | None) -> tuple[str, ...]:
    """Split the configured comma-separated dotted submodule paths."""
    return tuple(part.strip() for part in (raw or "").split(",") if part.strip())


class _CpuIsland(nn.Module):
    """Run one submodule on CPU inside a model that otherwise lives on `device`.

    The bounce is per CALL, not per tensor element, and the counting layer runs
    once per forward pass — so the transfer cost is a fixed small addition to a
    pass that the accelerator makes several times cheaper overall. That trade is
    measured in the ticket rather than assumed.
    """

    def __init__(self, inner: nn.Module, device: str) -> None:
        super().__init__()
        self.inner = inner.to(_CPU)
        self._device = device

    def forward(self, *args: Any, **kwargs: Any) -> Any:
        moved_args = [a.to(_CPU) if torch.is_tensor(a) else a for a in args]
        moved_kwargs = {k: (v.to(_CPU) if torch.is_tensor(v) else v) for k, v in kwargs.items()}
        result = self.inner(*moved_args, **moved_kwargs)
        return self._back(result)

    def _back(self, value: Any) -> Any:
        if torch.is_tensor(value):
            return value.to(self._device)
        if isinstance(value, tuple):
            return tuple(self._back(v) for v in value)
        if isinstance(value, list):
            return [self._back(v) for v in value]
        return value


def _relocate(model: nn.Module, path: str, device: str) -> bool:
    """Wrap `model.<path>` in a CPU island. Returns False if the path is absent."""
    parent: Any = model
    parts = path.split(".")
    for part in parts[:-1]:
        parent = getattr(parent, part, None)
        if parent is None:
            return False
    leaf = getattr(parent, parts[-1], None)
    if not isinstance(leaf, nn.Module):
        return False
    if isinstance(leaf, _CpuIsland):
        return True
    setattr(parent, parts[-1], _CpuIsland(leaf, device))
    return True


def apply_device_placement(
    model: nn.Module,
    device: str,
    cpu_only_modules: tuple[str, ...] = (),
) -> str:
    """Move `model` onto `device`, keeping `cpu_only_modules` on CPU.

    Returns the device actually used. A relocation path that does not exist in
    this build is logged and skipped — the list describes a torch/`gliner2`
    compatibility gap, so a build that no longer has the module is the GOOD
    outcome, not a configuration error.
    """
    if device == _CPU:
        return _CPU

    model.to(device)
    relocated: list[str] = []
    missing: list[str] = []
    for path in cpu_only_modules:
        (relocated if _relocate(model, path, device) else missing).append(path)

    logger.info(
        f"nlp.device.placed device={device} "
        f"cpu_islands={list(relocated)} absent={list(missing)}"
    )
    return device
