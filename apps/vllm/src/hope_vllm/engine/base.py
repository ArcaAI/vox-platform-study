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

from hope_vllm.spec import ResolvedServingSpec

#: vLLM's running-batch cap when the model row declares none (``engine.maxNumSeqs``).
DEFAULT_MAX_NUM_SEQS = 64


class DecoderBudgetError(ValueError):
    """The decoder prompt leaves no room to generate within the model's context."""


class EngineBuildRefused(RuntimeError):
    """The backend refuses to build this spec for a NAMED reason.

    ``code`` travels unchanged through the pool to the HTTP layer (503 ``detail.code``),
    so a caller learns WHY — a vetoed registry credential, a checksum mismatch, fp8 on a
    GPU that cannot run it — instead of a generic load failure. Nothing is cached: the
    next request re-evaluates, which is what lets a fixed credential or row take effect.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


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

    async def build(self, spec: ResolvedServingSpec) -> WhisperEngine: ...
