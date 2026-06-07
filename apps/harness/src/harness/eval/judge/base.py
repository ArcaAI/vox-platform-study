"""Model-agnostic judge client protocol + error hierarchy.

The judge is decoupled from any specific model/provider: anything that
implements :class:`JudgeClient` (an async ``complete`` returning the raw model
text, plus a ``model`` name) can drive the PDSQI-9 judge. This is what makes the
judge swappable between a local ≤20B model (LM Studio), Azure OpenAI, AWS
Bedrock, or a deterministic test stub.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

Messages = list[dict[str, str]]


class JudgeError(RuntimeError):
    """Base error for judge operations."""


class JudgeConnectionError(JudgeError):
    """The judge backend was unreachable or returned a transport error."""


class JudgeParseError(JudgeError):
    """The judge response could not be parsed into a valid score."""


@runtime_checkable
class JudgeClient(Protocol):
    """Minimal contract a judge backend must satisfy."""

    model: str

    async def complete(
        self,
        messages: Messages,
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        """Return the raw text completion for a chat ``messages`` array.

        ``temperature`` overrides the configured decoding temperature for this one
        call (used by self-consistency sampling); ``None`` keeps the default.
        ``seed`` overrides the configured decoding seed for this one call (used to
        give each self-consistency sample a *distinct but reproducible* seed);
        ``None`` falls back to the configured seed.
        """
        ...
