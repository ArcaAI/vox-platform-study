"""Processor registry (TASK-505 Phase 1).

Keyed ``(kind, name)``. Specs register at import time via
:func:`register_processor`; implementations import lazily on first
:meth:`ProcessorRegistry.load`. ``scoped()`` gives tests an isolated child
registry without mutating the module singleton.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from typing import Any

import structlog

from .base import Capability, CapabilityError, HardwareBinding, ProcessorSpec

logger = structlog.get_logger(__name__)


class ProcessorRegistry:
    """(kind, name) → ProcessorSpec, with lazy implementation loading."""

    def __init__(self) -> None:
        self._specs: dict[tuple[str, str], ProcessorSpec] = {}
        self._loaded: dict[tuple[str, str], Any] = {}

    # ------------------------------------------------------------------
    # Registration / lookup
    # ------------------------------------------------------------------

    def register(self, spec: ProcessorSpec) -> ProcessorSpec:
        key = (spec.kind, spec.name)
        existing = self._specs.get(key)
        if existing is not None and existing != spec:
            raise ValueError(f"Processor {spec.kind}/{spec.name} already registered")
        self._specs[key] = spec
        return spec

    def spec(self, kind: str, name: str) -> ProcessorSpec:
        try:
            return self._specs[(kind, name)]
        except KeyError:
            known = ", ".join(sorted(self.names(kind))) or "(none)"
            raise KeyError(
                f"No processor '{name}' registered for kind '{kind}'. "
                f"Registered: {known}"
            ) from None

    def names(self, kind: str) -> list[str]:
        return [n for (k, n) in self._specs if k == kind]

    def all_specs(self) -> list[ProcessorSpec]:
        return list(self._specs.values())

    # ------------------------------------------------------------------
    # Lazy implementation loading
    # ------------------------------------------------------------------

    def load(self, kind: str, name: str) -> Any:
        """Import and return the implementation behind ``lazy_target`` (cached)."""
        key = (kind, name)
        if key in self._loaded:
            return self._loaded[key]
        spec = self.spec(kind, name)
        module_name, _, attr = spec.lazy_target.partition(":")
        module = importlib.import_module(module_name)
        try:
            impl = getattr(module, attr)
        except AttributeError:
            raise ImportError(
                f"lazy_target '{spec.lazy_target}' for {kind}/{name}: "
                f"module '{module_name}' has no attribute '{attr}'"
            ) from None
        self._loaded[key] = impl
        return impl

    # ------------------------------------------------------------------
    # Hardware-binding resolution
    # ------------------------------------------------------------------

    def resolve_binding(
        self,
        kind: str,
        name: str,
        *,
        devices: Sequence[str],
        compute_pref: Sequence[str] = (),
        mode: str = "batch",
    ) -> HardwareBinding:
        """Pick the first (device, compute) both sides support.

        Iterates profile ``devices`` in preference order. Within a device,
        ``compute_pref`` is a SOFT preference (order beats capability rank):
        if none of the preferred computes is supported, the highest-rank
        row's own default compute is used — a preference mismatch must never
        report a supported engine as unsupported (TASK-505 P1 review: the
        profile vocabulary, e.g. ``float16``, differs from some engines'
        declared sets, e.g. NeMo ``float32`` or ONNX quant names). A
        capability with an empty compute tuple has no compute concept (cloud
        engines) and resolves to ``None``. ``mode`` is ``"streaming"`` or
        ``"batch"`` — capabilities that do not support the mode are skipped.
        Raises :class:`CapabilityError` with the full declared matrix only
        when no requested DEVICE is supported in the mode.
        """
        spec = self.spec(kind, name)
        mode_ok = [
            c
            for c in spec.capabilities
            if (c.streaming if mode == "streaming" else c.batch)
        ]
        for device in devices:
            rows = sorted(
                (c for c in mode_ok if c.device == device),
                key=lambda c: -c.rank,
            )
            if not rows:
                continue
            # 1) Honor the caller's compute preference order across rows.
            for compute in compute_pref:
                for cap in rows:
                    if cap.compute and compute in cap.compute:
                        return HardwareBinding(device=device, compute=compute)
            # 2) Soft fallback: highest-rank row's own default compute
            #    (None for compute-less capabilities, e.g. cloud engines).
            cap = rows[0]
            return HardwareBinding(
                device=device,
                compute=cap.compute[0] if cap.compute else None,
            )

        matrix = "; ".join(
            f"{c.device}[{','.join(c.compute) or '*'}]"
            f"{'' if (c.streaming if mode == 'streaming' else c.batch) else ' (no ' + mode + ')'}"
            for c in spec.capabilities
        )
        raise CapabilityError(
            f"{kind}/{name} supports no requested (device, compute) in mode "
            f"'{mode}'. Requested devices={list(devices)}, "
            f"compute_pref={list(compute_pref)}. Declared: {matrix}"
        )

    # ------------------------------------------------------------------
    # Test seam
    # ------------------------------------------------------------------

    @contextmanager
    def scoped(self) -> Iterator[ProcessorRegistry]:
        """Yield an isolated child registry pre-populated with current specs."""
        child = ProcessorRegistry()
        child._specs = dict(self._specs)
        yield child


_registry = ProcessorRegistry()


def get_registry() -> ProcessorRegistry:
    """Module-singleton registry (spec modules register into it at import)."""
    return _registry


def register_processor(
    *,
    kind: str,
    name: str,
    lazy_target: str,
    capabilities: Sequence[Capability],
    traits: Sequence[str] = (),
    version: int = 1,
    rank: int = 0,
    metadata: dict[str, Any] | None = None,
) -> ProcessorSpec:
    """Build a :class:`ProcessorSpec` and register it in the singleton."""
    spec = ProcessorSpec(
        kind=kind,
        name=name,
        lazy_target=lazy_target,
        capabilities=tuple(capabilities),
        traits=frozenset(traits),
        version=version,
        rank=rank,
        metadata=dict(metadata or {}),
    )
    return _registry.register(spec)
