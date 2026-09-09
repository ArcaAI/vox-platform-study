"""Platform-aware engine binding resolution.

Bridges the processor capability declarations to the running host: the
detected platform yields a device-preference list, and
:func:`resolve_engine_binding` intersects it with an engine's declared
capabilities via the registry.

Observability-first posture: a mismatch WARNS and returns ``None`` instead of
blocking — the capability table is engine-level while some support is a
per-loaded-model property (e.g. raw-vs-Optimum ONNX is decided by processor
presence at load time), so a hard block here would reject configurations that
work today. Hard enforcement lands once capabilities carry that per-model
nuance. Resolved bindings are surfaced in ``/health`` so silent downgrades
(e.g. CPU fallback for an ASR engine) are visible.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import structlog

from stt.core.platform import detect_platform

from .base import CapabilityError, HardwareBinding
from .registry import get_registry

logger = structlog.get_logger(__name__)

_PLATFORM_DEVICE_PREFS: dict[str, list[str]] = {
    "cuda": ["cuda", "cpu"],
    "mps": ["mps", "cpu"],
    "cpu": ["cpu"],
}


def platform_device_preferences(platform: str | None = None) -> list[str]:
    """Device preference order for the (detected) platform.

    ``cloud`` is always appended — cloud engines are host-independent.
    """
    plat = platform or detect_platform().value
    devices = list(_PLATFORM_DEVICE_PREFS.get(plat, ["cpu"]))
    devices.append("cloud")
    return devices


def resolve_engine_binding(
    kind: str,
    name: str,
    *,
    mode: str,
    compute_pref: Sequence[str | None] = (),
    declared_compute_type: str | None = None,
    platform: str | None = None,
    warn: bool = True,
) -> HardwareBinding | None:
    """Resolve the (device, compute) binding for a processor on this host.

    ``declared_compute_type`` is the ASSIGNED MODEL ROW's own compute type
    (e.g. ``AiModel.computeType`` / ``AiModelConfig.compute_type`` — a
    ``q4_k``/``q5_k``/``q8_0``/``f16`` GGUF quant string for whisper.cpp, an
    ``int8``/``float16`` CTranslate2 string for faster-whisper, ...). It is
    tried FIRST, ahead of ``compute_pref`` (typically the execution
    profile's ``float16``/``int8``/``float32`` precision vocabulary),
    because the two vocabularies differ per engine family and a GGUF
    engine's never overlaps the profile's — without this, the row's actual
    compute type never reaches resolution and the soft fallback in
    ``ProcessorRegistry.resolve_binding`` silently returns the engine's
    first declared compute, which can disagree with the weights actually
    loaded (TASK-934). When ``declared_compute_type`` is unset, or is not in
    the engine's declared vocabulary for the resolved device, resolution
    falls through to ``compute_pref`` order and the soft-fallback default —
    unchanged from before.

    Returns ``None`` (optionally warning) when the engine declares no support
    for any of the platform's devices in the requested mode.
    """
    try:
        preferred = [c for c in (declared_compute_type, *compute_pref) if c]
        return get_registry().resolve_binding(
            kind,
            name,
            devices=platform_device_preferences(platform),
            compute_pref=preferred,
            mode=mode,
        )
    except (CapabilityError, KeyError) as exc:
        if warn:
            logger.warning(
                "Engine capability mismatch for this platform",
                kind=kind,
                name=name,
                mode=mode,
                error=str(exc),
            )
        return None


def asr_processor_health() -> dict[str, Any]:
    """Registered ASR engines + per-mode resolved bindings (for ``/health``)."""
    plat = detect_platform().value
    engines: dict[str, Any] = {}
    for name in sorted(get_registry().names("asr")):
        entry: dict[str, Any] = {}
        for mode in ("batch", "streaming"):
            binding = resolve_engine_binding("asr", name, mode=mode, platform=plat, warn=False)
            entry[mode] = (
                {"device": binding.device, "compute": binding.compute}
                if binding is not None
                else "unsupported"
            )
        engines[name] = entry
    return {"platform": plat, "asr_engines": engines}
