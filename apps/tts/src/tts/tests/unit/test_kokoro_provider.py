"""TDD tests for KokoroProvider."""

from __future__ import annotations

import asyncio
import gc
import threading
import weakref
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

from tts.core.config import KokoroConfig
from tts.providers.base import AudioFormat, SynthesisRequest, TTSEngine
from tts.providers.kokoro import KokoroProvider


class FakePipeline:
    """Mimics kokoro.KPipeline: callable yielding (graphemes, phonemes, audio)."""

    def __init__(self, segments: int = 2, samples: int = 2400) -> None:
        self.segments = segments
        self.samples = samples
        self.voice: str | None = None
        self.calls = 0

    def __call__(self, text, voice=None):
        self.calls += 1
        self.voice = voice
        for _ in range(self.segments):
            yield ("gs", "ps", np.zeros(self.samples, dtype=np.float32))


def _req(**kw) -> SynthesisRequest:
    base = {"text": "Hello there.", "provider_voice": "af_heart", "locale": "en-IN"}
    base.update(kw)
    return SynthesisRequest(**base)


async def _collect(provider, req):
    return [c async for c in provider.synthesize(req)]


@pytest.mark.asyncio
async def test_streams_pcm_chunk_per_segment():
    provider = KokoroProvider(
        KokoroConfig(voice="af_heart"), pipeline=FakePipeline(segments=3, samples=2400)
    )
    chunks = await _collect(provider, _req(fmt=AudioFormat.PCM))
    assert len(chunks) == 3
    assert all(len(c.data) == 4800 for c in chunks)  # 2400 samples × 2 bytes, 24k→24k


@pytest.mark.asyncio
async def test_wav_is_single_chunk_with_riff_header():
    provider = KokoroProvider(KokoroConfig(), pipeline=FakePipeline(segments=2))
    chunks = await _collect(provider, _req(fmt=AudioFormat.WAV))
    assert len(chunks) == 1
    assert chunks[0].data[:4] == b"RIFF"
    assert chunks[0].is_final is True


@pytest.mark.asyncio
async def test_passes_requested_voice_to_pipeline():
    pipeline = FakePipeline()
    provider = KokoroProvider(KokoroConfig(voice="af_default"), pipeline=pipeline)
    await _collect(provider, _req(provider_voice="af_heart"))
    assert pipeline.voice == "af_heart"


def test_protocol_and_streaming_flag():
    provider = KokoroProvider(KokoroConfig(), pipeline=FakePipeline())
    assert isinstance(provider, TTSEngine)
    assert provider.native_streaming is True


# ── streaming synthesis + a bounded memory peak ──────────────
#
# `synthesize()` used to materialize EVERY segment of the utterance into a list
# before yielding a single chunk, despite `native_streaming = True`. Two separate
# defects, and measurement in the built image showed they are not the same size:
#
# 1. It did not stream. First audio for a 4096-char input arrived after the whole
#    65 s synthesis instead of after ~7 s. That is the user-visible one.
# 2. It let concurrency multiply peak RSS. Peak is dominated by the torch forward
#    pass of the largest SEGMENT (~1.2 GB over the resident model), not by the
#    buffered audio — 24 segments and 357 s of audio peaked LOWER (1848 MB) than
#    2 segments and 51 s (2341 MB). What did scale was concurrent requests, each
#    running its own inference on the shared thread pool: 2505 / 4314 / 7228 MB
#    for 1 / 3 / 5 concurrent 840-char synths. Routing all inference through the
#    provider's one worker flattens that to 2426 / 2660 / 2458 MB.
#
# The buffered-audio term the original diagnosis blamed is real but small (≤ ~35 MB
# of float32 even at `max_input_chars`); it is fixed here too, but it was never
# what put RSS at 2.3 GB.
#
# These tests pin: a chunk reaches the caller before the pipeline has finished
# producing; at most a couple of segment arrays are resident at once (WAV/MP3
# still buffer, but as PCM16 bytes, not live float32 arrays); and all inference
# runs on one dedicated thread.


class CountingPipeline:
    """Records how many segments it has produced so far."""

    def __init__(self, segments: int = 4, samples: int = 2400) -> None:
        self.segments = segments
        self.samples = samples
        self.produced = 0

    def __call__(self, text, voice=None):
        for _ in range(self.segments):
            self.produced += 1
            yield ("gs", "ps", np.zeros(self.samples, dtype=np.float32))


class TrackingPipeline:
    """Hands out segment arrays and keeps only weak references to them."""

    def __init__(self, segments: int = 6, samples: int = 2400) -> None:
        self.segments = segments
        self.samples = samples
        self.refs: list[weakref.ReferenceType] = []
        self.threads: set[int] = set()

    def __call__(self, text, voice=None):
        for _ in range(self.segments):
            self.threads.add(threading.get_ident())
            audio = np.zeros(self.samples, dtype=np.float32)
            self.refs.append(weakref.ref(audio))
            yield ("gs", "ps", audio)

    def alive(self) -> int:
        gc.collect()
        return sum(1 for ref in self.refs if ref() is not None)


@pytest.mark.asyncio
async def test_pcm_first_chunk_arrives_before_all_segments_are_produced():
    pipeline = CountingPipeline(segments=4)
    provider = KokoroProvider(KokoroConfig(), pipeline=pipeline)

    produced_at_first_chunk = None
    async for _chunk in provider.synthesize(_req(fmt=AudioFormat.PCM)):
        produced_at_first_chunk = pipeline.produced
        break

    assert produced_at_first_chunk == 1, (
        "synthesize() must yield each segment as the pipeline produces it; "
        f"the pipeline had already produced {produced_at_first_chunk} segments"
    )


@pytest.mark.asyncio
async def test_pcm_keeps_at_most_one_segment_resident():
    pipeline = TrackingPipeline(segments=6)
    provider = KokoroProvider(KokoroConfig(), pipeline=pipeline)

    peak_alive = 0
    async for _chunk in provider.synthesize(_req(fmt=AudioFormat.PCM)):
        peak_alive = max(peak_alive, pipeline.alive())

    assert peak_alive <= 2, f"{peak_alive} segment arrays were resident at once"


@pytest.mark.asyncio
async def test_wav_does_not_retain_every_segment_array():
    """WAV cannot stream (its RIFF header needs the final byte count), but it
    must still buffer PCM16 bytes rather than a list of live float32 arrays."""
    pipeline = TrackingPipeline(segments=6)
    provider = KokoroProvider(KokoroConfig(), pipeline=pipeline)

    chunks = await _collect(provider, _req(fmt=AudioFormat.WAV))

    assert len(chunks) == 1
    assert pipeline.alive() == 0, "every segment array must be released as it is encoded"


@pytest.mark.asyncio
async def test_pipeline_never_runs_on_the_event_loop():
    """The KPipeline generator is synchronous and heavy — every step of it must
    be pumped from a worker thread, not the event loop."""
    pipeline = TrackingPipeline(segments=3)
    provider = KokoroProvider(KokoroConfig(), pipeline=pipeline)

    await _collect(provider, _req(fmt=AudioFormat.PCM))

    assert threading.get_ident() not in pipeline.threads


@pytest.mark.asyncio
async def test_pipeline_is_pumped_from_exactly_one_thread():
    """All steps of one utterance must run on ONE dedicated worker thread.

    Measured in the built image: pumping with `asyncio.to_thread` (the shared
    default executor) spread a 4096-char synthesis over 3 pool threads and raised
    peak RSS from 2475 MB to 2745 MB — torch's per-thread state and glibc's
    per-thread malloc arenas are duplicated per thread that touches inference.
    The old code got single-threadedness for free by draining the whole pipeline
    inside one `to_thread` call; streaming must not give that up.
    """
    pipeline = TrackingPipeline(segments=8)
    provider = KokoroProvider(KokoroConfig(), pipeline=pipeline)

    async for _chunk in provider.synthesize(_req(fmt=AudioFormat.PCM)):
        await asyncio.sleep(0)  # let the loop schedule other work between steps

    assert len(pipeline.threads) == 1, (
        f"the pipeline was pumped from {len(pipeline.threads)} threads; "
        "it must have one dedicated worker for the whole utterance"
    )


@pytest.mark.asyncio
async def test_concurrent_requests_share_the_one_inference_thread():
    """The peak-memory guarantee: N concurrent synths cost ONE inference, not N.

    Peak RSS is dominated by the torch forward pass of the largest segment, so
    the bound that matters is how many of those can be in flight at once. The
    old code ran every request on the shared pool, so two concurrent requests
    paid the peak twice.
    """
    pipeline = TrackingPipeline(segments=4)
    provider = KokoroProvider(KokoroConfig(), pipeline=pipeline)

    await asyncio.gather(
        _collect(provider, _req(fmt=AudioFormat.PCM)),
        _collect(provider, _req(fmt=AudioFormat.PCM)),
        _collect(provider, _req(fmt=AudioFormat.PCM)),
    )

    assert len(pipeline.threads) == 1
    assert threading.get_ident() not in pipeline.threads


@pytest.mark.asyncio
async def test_synthesis_does_not_queue_behind_a_busy_default_executor():
    """The dedicated-worker requirement, stated as behaviour.

    `asyncio.to_thread` hands work to the loop's SHARED default executor, so a
    saturated pool stalls synthesis outright and, when it is not saturated,
    scatters one utterance's inference across whichever pool threads are free
    (the memory cost pinned by the test above). Owning a worker fixes both.
    """
    released = threading.Event()
    loop = asyncio.get_running_loop()
    busy = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(busy)
    try:
        occupied = loop.run_in_executor(busy, released.wait)
        await asyncio.sleep(0)  # let the blocker actually take the only worker

        provider = KokoroProvider(KokoroConfig(), pipeline=FakePipeline(segments=2))
        chunks = await asyncio.wait_for(_collect(provider, _req(fmt=AudioFormat.PCM)), timeout=5)

        assert len(chunks) == 2
    finally:
        released.set()
        await occupied
        busy.shutdown(wait=True)
