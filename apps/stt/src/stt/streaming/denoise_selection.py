"""The one rule for turning an agent's denoise choice into a running engine (TASK-1030).

Shared by streaming session assembly; the batch path applies the same rule inside
``AudioPreprocessor``. Owner decision OD-2: an engine that is not ready NEVER breaks
the ASR task — this returns ``(None, DenoiseDegraded)`` and the caller transcribes
without denoise, publishing the degrade.
"""

from __future__ import annotations

import importlib
from typing import Any

from stt.pipeline.dto import DenoiseConfig

from .deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser
from .denoise_report import DenoiseDegraded, report_denoise_degraded
from .denoiser import StreamingDenoiser

#: Engines this runtime runs, by the name `DenoiseConfig.engine` carries.
KNOWN_ENGINES: tuple[str, ...] = ("rnnoise", "deepfilternet3")

#: The Python module each engine needs — probed for the health body.
_ENGINE_MODULES: dict[str, str] = {"rnnoise": "pyrnnoise", "deepfilternet3": "df.enhance"}


def build_streaming_denoiser(
    denoise: DenoiseConfig | Any,
    *,
    input_sr: int,
    session_id: str | None = None,
) -> tuple[Any | None, DenoiseDegraded | None]:
    """``(denoiser, None)`` when the chosen engine runs; ``(None, degrade)`` when it cannot.

    A disabled stage is ``(None, None)``: nothing was asked for, nothing degraded.
    An engine name this runtime does not know (``unknown:<library>`` from the spec
    mapper) runs NOTHING — never RNNoise in place of the engine the admin bound.
    """
    if not denoise or not getattr(denoise, "enabled", False):
        return None, None

    engine = getattr(denoise, "engine", "rnnoise") or "rnnoise"
    strength = getattr(denoise, "strength", 1.0)
    if engine == "deepfilternet3":
        denoiser: Any = DeepFilterNet3StreamingDenoiser(
            input_sr=input_sr, strength=strength, model_dir=getattr(denoise, "model_path", None)
        )
    elif engine == "rnnoise":
        denoiser = StreamingDenoiser(input_sr=input_sr, strength=strength)
    else:
        return None, report_denoise_degraded(
            engine,
            "unknown_engine",
            f"no denoise engine named '{engine}' in this runtime (known: {list(KNOWN_ENGINES)})",
            session_id=session_id,
        )

    if denoiser.initialize():
        return denoiser, None
    return None, denoiser.degraded


def denoise_engine_status() -> dict[str, dict[str, str]]:
    """Each engine's package presence, for the health body. NOT a readiness gate (OD-2).

    DeepFilterNet3 additionally needs its bound weights, which are per agent and
    checked at session start; ``ok`` here means the package can run them.
    """
    status: dict[str, dict[str, str]] = {}
    for engine, module in _ENGINE_MODULES.items():
        try:
            importlib.import_module(module)
        except Exception as exc:  # noqa: BLE001 — a broken import is "unavailable", not a crash
            status[engine] = {
                "status": "unavailable",
                "detail": f"package `{module}` not importable: {exc}",
            }
        else:
            status[engine] = {"status": "ok", "detail": ""}
    return status
