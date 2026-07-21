"""TDD tests for the WS-duplex streaming path.

Covers ``split_confirmed`` incremental segmentation, the ``SentenceAdapter``
(buffer → per-sentence synth → audio out), and ``TTSRouter.stream`` (before-
first-byte failover, provider lock, native-duplex preference + speed fallback).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from tts_v2.catalog.voices import VoiceCatalog
from tts_v2.core.config import Settings
from tts_v2.providers.base import AudioChunk, ProviderRegistry, SynthesisStream
from tts_v2.routing.chunking import split_confirmed
from tts_v2.routing.router import TTSRouter
from tts_v2.routing.sentence_adapter import SentenceAdapter
from tts_v2.tests.fakes import FakeDuplexEngine, FakeEngine

# --- split_confirmed ---------------------------------------------------------


def test_split_confirmed_keeps_unterminated_remainder():
    sentences, remainder = split_confirmed("One. Two. Thre", "en-IN")
    assert sentences == ["One.", "Two."]
    assert remainder == "Thre"


def test_split_confirmed_needs_trailing_space_to_confirm():
    # No whitespace after the final period → the whole thing stays buffered.
    sentences, remainder = split_confirmed("Only one.", "en-IN")
    assert sentences == []
    assert remainder == "Only one."


def test_split_confirmed_does_not_split_decimals():
    sentences, remainder = split_confirmed("BP is 8.2 today. Next", "en-IN")
    assert sentences == ["BP is 8.2 today."]
    assert remainder == "Next"


# --- SentenceAdapter ---------------------------------------------------------


class _RecordingSynth:
    """A synth_sentence callable recording sentences and emitting one frame each."""

    def __init__(self) -> None:
        self.sentences: list[str] = []

    async def __call__(self, sentence: str) -> AsyncIterator[AudioChunk]:
        self.sentences.append(sentence)
        yield AudioChunk(data=b"X")


async def _drain(adapter: SentenceAdapter) -> list[AudioChunk]:
    return [c async for c in adapter]


@pytest.mark.asyncio
async def test_adapter_synthesizes_per_confirmed_sentence():
    synth = _RecordingSynth()
    adapter = SentenceAdapter(synth, locale="en-IN", max_chars=400)
    await adapter.push_text("Hello there. ")
    await adapter.push_text("How are you? ")
    await adapter.end_input()
    frames = await _drain(adapter)
    assert synth.sentences == ["Hello there.", "How are you?"]
    assert len(frames) == 2


@pytest.mark.asyncio
async def test_adapter_end_flushes_unterminated_remainder():
    synth = _RecordingSynth()
    adapter = SentenceAdapter(synth, locale="en-IN", max_chars=400)
    await adapter.push_text("No trailing period")
    await adapter.end_input()
    await _drain(adapter)
    assert synth.sentences == ["No trailing period"]


@pytest.mark.asyncio
async def test_adapter_flush_forces_remainder_then_continues():
    synth = _RecordingSynth()
    adapter = SentenceAdapter(synth, locale="en-IN", max_chars=400)
    await adapter.push_text("Partial")
    await adapter.flush()
    await adapter.push_text(" more. ")
    await adapter.end_input()
    await _drain(adapter)
    assert synth.sentences == ["Partial", "more."]


@pytest.mark.asyncio
async def test_adapter_aclose_cancels_worker():
    synth = _RecordingSynth()
    adapter = SentenceAdapter(synth, locale="en-IN", max_chars=400)
    await adapter.push_text("Hello. ")
    _ = adapter.__aiter__()  # start the worker
    await adapter.aclose()  # must not raise


# --- Router.stream -----------------------------------------------------------


def _router(providers: dict) -> TTSRouter:
    reg = ProviderRegistry()
    for name, engine in providers.items():
        reg.register(name, engine)
    return TTSRouter(reg, VoiceCatalog(), Settings())


async def _run_stream(stream: SynthesisStream, texts: list[str]) -> list[AudioChunk]:
    for t in texts:
        await stream.push_text(t)
    await stream.end_input()
    return [c async for c in stream]


@pytest.mark.asyncio
async def test_stream_uses_sentence_adapter_for_non_native():
    engine = FakeEngine("azure", native_streaming=False, chunks=1)
    router = _router({"azure": engine})
    stream = router.stream(voice_id="en-female-1")
    frames = await _run_stream(stream, ["One. ", "Two. "])
    assert engine.calls == 2  # one synth per sentence
    assert len(frames) == 2


@pytest.mark.asyncio
async def test_stream_failover_before_first_byte():
    azure = FakeEngine("azure", fail_before_emit=True)
    kokoro = FakeEngine("kokoro", chunks=1)
    router = _router({"azure": azure, "kokoro": kokoro})
    stream = router.stream(voice_id="en-female-1")
    frames = await _run_stream(stream, ["Hello. "])
    assert azure.calls == 1 and kokoro.calls == 1
    assert len(frames) == 1


@pytest.mark.asyncio
async def test_stream_locks_provider_after_first_byte():
    # azure serves sentence 1; kokoro must never be used once locked.
    azure = FakeEngine("azure", chunks=1)
    kokoro = FakeEngine("kokoro", chunks=1)
    router = _router({"azure": azure, "kokoro": kokoro})
    stream = router.stream(voice_id="en-female-1")
    await _run_stream(stream, ["One. ", "Two. ", "Three. "])
    assert azure.calls == 3
    assert kokoro.calls == 0


@pytest.mark.asyncio
async def test_stream_prefers_native_duplex_at_speed_1():
    azure = FakeDuplexEngine("azure")
    router = _router({"azure": azure})
    stream = router.stream(voice_id="en-female-1", speed=1.0)
    # Native path returns the engine's own stream, not a SentenceAdapter.
    assert not isinstance(stream, SentenceAdapter)
    assert len(azure.streams) == 1


@pytest.mark.asyncio
async def test_stream_speed_change_falls_back_to_adapter():
    azure = FakeDuplexEngine("azure")
    router = _router({"azure": azure})
    stream = router.stream(voice_id="en-female-1", speed=1.2)
    # speed != 1.0 → SentenceAdapter (one-shot synthesize path for SSML rate).
    assert isinstance(stream, SentenceAdapter)
    assert len(azure.streams) == 0
