"""Processor-registry core types.

A *processor* is one swappable pipeline stage implementation (an ASR engine,
a VAD, a denoiser, a punctuation model, ...). Stage kinds are a closed set;
implementations are open and self-describe their hardware support so the
resolver can fail fast at pipeline-load time instead of at first inference.

Design:
- Specs are import-cheap metadata; the heavy implementation class is a lazy
  ``"module:attr"`` target imported on first :meth:`ProcessorRegistry.load`.
- YAML never carries import paths — only registry keys — so tenant-editable
  pipeline configs cannot execute arbitrary code.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Closed set of stage kinds (implementations are open).
STAGE_KINDS: frozenset[str] = frozenset(
    {
        "normalize",
        "denoise",
        "resample",
        "vad",
        "embedding",
        "asr",
        "diarization",
        "stabilizer",
        "punctuation",
        "disfluency",
        "merge",
    }
)


@dataclass(frozen=True)
class Capability:
    """One (device × compute × mode) support row declared by a processor."""

    device: str  # "cpu" | "cuda" | "mps" | "cloud"
    compute: tuple[str, ...] = ()  # empty = any/none (e.g. cloud engines)
    streaming: bool = True
    batch: bool = True
    rank: int = 0  # higher wins on ties within a device


@dataclass(frozen=True)
class HardwareBinding:
    """The resolved (device, compute) a processor will be loaded with."""

    device: str
    compute: str | None


@dataclass(frozen=True)
class ProcessorSpec:
    """Import-cheap registration record for one processor implementation."""

    kind: str
    name: str
    lazy_target: str  # "package.module:attr" — imported on first load()
    capabilities: tuple[Capability, ...]
    traits: frozenset[str] = frozenset()  # e.g. {"initial_prompt", "word_timestamps"}
    version: int = 1
    rank: int = 0  # default preference among same-kind implementations
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.kind not in STAGE_KINDS:
            raise ValueError(
                f"Unknown stage kind '{self.kind}'. Valid kinds: " + ", ".join(sorted(STAGE_KINDS))
            )
        if not self.capabilities:
            raise ValueError(f"Processor {self.kind}/{self.name} declares no capabilities")
        if ":" not in self.lazy_target:
            raise ValueError(f"lazy_target must be 'module:attr', got '{self.lazy_target}'")


class CapabilityError(RuntimeError):
    """No (device, compute) intersection between profile and processor."""
