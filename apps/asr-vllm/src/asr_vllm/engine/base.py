"""The engine seam: what the HTTP layer and the pool need from a decode backend.

Two protocols keep the service importable and testable without vLLM: the real
backend (``vllm_backend.VllmEngineFactory``) and the test fakes implement the same
shape. Nothing here imports an ML library.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np
import numpy.typing as npt

from asr_vllm.spec import ResolvedVllmAsrSpec


class DecoderBudgetError(ValueError):
    """The decoder prompt leaves no room to generate within the model's context."""


@dataclass(frozen=True)
class DecodeRequest:
    audio: npt.NDArray[np.float32]
    language: str
    prompt: str | None
    temperature: float
    max_tokens: int | None
    request_id: str


@dataclass(frozen=True)
class DecodeResult:
    text: str
    finish_reason: str | None
    #: submit → final output, measured by the adapter (includes the engine's own queue).
    decode_ms: float
    #: vLLM's scheduler wait for this request, when the engine reports it (else ``None``).
    engine_queue_ms: float | None


class WhisperEngine(Protocol):
    async def transcribe(self, request: DecodeRequest) -> DecodeResult: ...

    async def shutdown(self) -> None: ...


class EngineFactory(Protocol):
    name: str

    def availability(self) -> str | None:
        """``None`` when this process can build engines, else the reason it cannot."""
        ...

    async def build(self, spec: ResolvedVllmAsrSpec) -> WhisperEngine: ...
