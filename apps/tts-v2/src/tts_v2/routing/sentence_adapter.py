"""Sentence adapter — turns a non-streaming engine into a duplex SynthesisStream.

Buffers incremental text (SMR tokens), emits complete sentences to a per-sentence
synth callable, and yields the resulting audio frames as they are produced — so
first audio ships after the first sentence instead of the whole summary. Natively
duplex engines (Azure text-stream) bypass this and stream directly (TASK-492).
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Callable

from tts_v2.core.logging import get_logger
from tts_v2.providers.base import AudioChunk
from tts_v2.routing.chunking import chunk_text, split_confirmed

logger = get_logger(__name__)

SynthSentence = Callable[[str], AsyncIterator[AudioChunk]]


class _Done:
    """Output-queue sentinel: input ended and all audio drained."""


class _Err:
    """Output-queue sentinel wrapping a worker exception."""

    def __init__(self, exc: BaseException) -> None:
        self.exc = exc


_DONE = _Done()


class SentenceAdapter:
    """Drives a per-sentence synth callable from an incremental text stream.

    ``synth_sentence(text)`` is an async iterator of ``AudioChunk`` for one
    sentence (the router supplies one that handles provider selection + before-
    first-byte failover). The adapter owns only buffering + boundary detection.
    """

    def __init__(
        self,
        synth_sentence: SynthSentence,
        *,
        locale: str,
        max_chars: int,
    ) -> None:
        self._synth = synth_sentence
        self._locale = locale
        self._max_chars = max_chars
        self._buffer = ""
        self._text_q: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        self._out_q: asyncio.Queue[AudioChunk | _Done | _Err] = asyncio.Queue()
        self._worker: asyncio.Task[None] | None = None

    async def push_text(self, text: str) -> None:
        await self._text_q.put(("text", text))

    async def flush(self) -> None:
        await self._text_q.put(("flush", ""))

    async def end_input(self) -> None:
        await self._text_q.put(("end", ""))

    def __aiter__(self) -> AsyncIterator[AudioChunk]:
        self._ensure_worker()
        return self

    async def __anext__(self) -> AudioChunk:
        self._ensure_worker()
        item = await self._out_q.get()
        if isinstance(item, _Done):
            raise StopAsyncIteration
        if isinstance(item, _Err):
            raise item.exc
        return item

    def _ensure_worker(self) -> None:
        if self._worker is None:
            self._worker = asyncio.ensure_future(self._run())

    async def _run(self) -> None:
        try:
            while True:
                kind, payload = await self._text_q.get()
                if kind == "text":
                    self._buffer += payload
                    await self._emit_confirmed()
                elif kind == "flush":
                    await self._emit_remaining()
                elif kind == "end":
                    await self._emit_remaining()
                    break
            await self._out_q.put(_DONE)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # surface to the consumer via __anext__
            await self._out_q.put(_Err(exc))

    async def _emit_confirmed(self) -> None:
        sentences, self._buffer = split_confirmed(self._buffer, self._locale)
        for sentence in sentences:
            await self._synth_and_emit(sentence)

    async def _emit_remaining(self) -> None:
        remaining = self._buffer.strip()
        self._buffer = ""
        if not remaining:
            return
        for sentence in chunk_text(remaining, self._locale, self._max_chars):
            await self._synth_and_emit(sentence)

    async def _synth_and_emit(self, sentence: str) -> None:
        async with contextlib.aclosing(self._synth(sentence)) as stream:
            async for chunk in stream:
                await self._out_q.put(chunk)

    async def aclose(self) -> None:
        if self._worker is not None and not self._worker.done():
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._worker
        # Unblock a consumer parked on __anext__ (e.g. client disconnect).
        self._out_q.put_nowait(_DONE)
