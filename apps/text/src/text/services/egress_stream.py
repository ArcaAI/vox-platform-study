"""Sentence-window release for streamed generations (TASK-1035 OD-7).

A delivered token cannot be recalled, so a streamed completion is BUFFERED and
released one sentence window at a time, and only after that window passed the
outbound screen. On a cloud provider the window is re-identified before release.

Cutting only at a sentence boundary is also what keeps a pseudonym token whole: a
token (``[PERSON_1]``) holds no whitespace, so it can never straddle a boundary,
and a token split across two provider chunks simply waits in the buffer. The one
forced cut — a run longer than :data:`MAX_WINDOW_CHARS` with no boundary — backs
off to before any unclosed ``[`` so it cannot split one either.

Content and reasoning are buffered separately (they are separate frames) and
screened together, assembled the way the post-receive gate always assembled them.
A blocked window raises :class:`~text.services.output_gate.OutputRejectedError` and
is never emitted; the producer turns that into the terminal error frame.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Final

from text.models.stream import StreamChunk
from text.services.output_gate import assemble_completion

#: A sentence end followed by whitespace (closing quotes/brackets allowed), or a newline.
_BOUNDARY: Final = re.compile(r"[.!?。…][\"'”’)\]]*\s+|\n")

#: The longest window held without a sentence boundary before a forced cut.
MAX_WINDOW_CHARS: Final = 2000


def _cut(buffer: str, *, final: bool) -> int:
    """How much of ``buffer`` may be released now (0 = hold everything)."""
    if final:
        return len(buffer)
    cut = 0
    for match in _BOUNDARY.finditer(buffer):
        cut = match.end()
    if cut == 0 and len(buffer) > MAX_WINDOW_CHARS:
        cut = max(buffer.rfind(" ", 0, MAX_WINDOW_CHARS) + 1, 0) or MAX_WINDOW_CHARS
    if cut:
        opened = buffer.rfind("[", 0, cut)
        if opened > buffer.rfind("]", 0, cut):
            cut = opened  # never release half a token
    return cut


class StreamGate:
    """Buffers deltas and releases screened, re-identified sentence windows."""

    def __init__(
        self,
        *,
        screen: Callable[[str], Awaitable[object]],
        restore: Callable[[str], str],
    ) -> None:
        self._screen = screen
        self._restore = restore
        self._content = ""
        self._reasoning = ""

    async def feed(self, kind: str, text: str) -> list[StreamChunk]:
        """Buffer one delta; return whatever is now safe to emit."""
        if kind == "reasoning":
            self._reasoning += text
        else:
            self._content += text
        return await self._release(final=False)

    async def flush(self) -> list[StreamChunk]:
        """Screen and release everything still buffered (end of stream)."""
        return await self._release(final=True)

    async def _release(self, *, final: bool) -> list[StreamChunk]:
        content_cut = _cut(self._content, final=final)
        reasoning_cut = _cut(self._reasoning, final=final)
        if not content_cut and not reasoning_cut:
            return []
        content, reasoning = self._content[:content_cut], self._reasoning[:reasoning_cut]
        window = assemble_completion(content, reasoning)
        if window.strip():
            # Raises on a blocked window — and the buffers are left untouched, so
            # nothing of it can be emitted afterwards either.
            await self._screen(window)
        self._content = self._content[content_cut:]
        self._reasoning = self._reasoning[reasoning_cut:]
        released: list[StreamChunk] = []
        if reasoning:
            released.append(StreamChunk(type="reasoning", content=self._restore(reasoning)))
        if content:
            released.append(StreamChunk(type="chunk", content=self._restore(content)))
        return released
