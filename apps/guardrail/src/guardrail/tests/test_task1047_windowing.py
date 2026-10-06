"""TASK-1047 L5 — region windows, the window-verdict cache and bounded concurrency.

D4: every ML screen is cut into region-aligned windows (size `W`, overlap `O`, cut
from the region's OWN start), so no peer call ever carries more than one window
and an append-only region yields byte-identical earlier windows on every flush.

D5 / FC-7: each window's verdict is cached in Redis under an HMAC of the window —
`gr:wv:<task>:<hmac>`, `hmac = HMAC-SHA256(K_t, policyVersion ‖ 0x1f ‖ modelId ‖
0x1f ‖ task ‖ 0x1f ‖ windowText)`, `K_t = HMAC-SHA256(secret, tenantId)` — and the
value carries offsets and labels, NEVER text. An absent secret disables the cache
(every window computed, never skipped); a Redis error is a miss.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from dataclasses import dataclass

import fakeredis.aioredis
import pytest

from guardrail.core.policy import NLP_MAX_INPUT_CHARS, GuardrailPolicy
from guardrail.services.pii_extraction import windowed_spans
from guardrail.services.window_cache import WindowVerdictCache, window_cache_key
from guardrail.services.windowing import (
    RegionSpan,
    WindowGeometry,
    WindowRunner,
    dedupe_longest,
    iter_windows,
    region_windows,
)

TENANT_A = "11111111-1111-1111-1111-111111111111"
TENANT_B = "22222222-2222-2222-2222-222222222222"
SECRET = "window-cache-test-secret"
GEOMETRY = WindowGeometry(size=4_000, overlap=256, concurrency=4)


@dataclass(frozen=True)
class _Span:
    label: str
    start: int
    end: int
    score: float = 0.9


class _RecordingSpanClient:
    """Finds every `needle`; records the length of every text it is handed."""

    def __init__(self, needle: str = "John Doe", delay: float = 0.0) -> None:
        self.needle = needle
        self.delay = delay
        self.calls: list[str] = []
        self.in_flight = 0
        self.max_in_flight = 0

    async def extract_pii_entities(self, text: str) -> list[_Span]:
        self.calls.append(text)
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            spans = []
            start = text.find(self.needle)
            while start != -1:
                spans.append(_Span("person", start, start + len(self.needle)))
                start = text.find(self.needle, start + 1)
            return spans
        finally:
            self.in_flight -= 1


def _runner(cache: WindowVerdictCache | None, tenant: str = TENANT_A) -> WindowRunner:
    return WindowRunner(
        tenant_id=tenant, policy_version="pv-1", cache=cache, concurrency=GEOMETRY.concurrency
    )


@pytest.fixture
def redis():
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


# ── window geometry ──────────────────────────────────────────────────────────


def test_windows_cover_the_whole_region_and_never_exceed_the_window() -> None:
    text = "x" * 100_000
    windows = list(iter_windows(text, 4_000, 256))

    assert all(len(w) <= 4_000 for _, w in windows)
    covered = set()
    for offset, window in windows:
        covered.update(range(offset, offset + len(window)))
    assert covered == set(range(len(text)))


def test_region_windows_are_cut_from_the_region_start_so_appends_keep_earlier_windows() -> None:
    first = "a" * 9_000
    grown = first + "b" * 1_500

    before = [w.text for w in region_windows("transcript", first, GEOMETRY)]
    after = [w.text for w in region_windows("transcript", grown, GEOMETRY)]

    # Every window that ended before the old tail is byte-identical after the append.
    assert after[: len(before) - 1] == before[:-1]
    assert all(w.region == "transcript" for w in region_windows("transcript", grown, GEOMETRY))


def test_the_default_geometry_fits_inside_the_nlp_input_ceiling() -> None:
    policy = GuardrailPolicy.from_blob({})
    size, overlap = policy.screen_window_geometry
    # OD-6 re-decided 2026-10-06 (V2 window sweep): 2,000 beats 4,000 on F1, p95 and memory.
    assert (size, overlap) == (2_000, 256)
    assert size + overlap <= NLP_MAX_INPUT_CHARS == 8_192
    assert policy.screen_window_concurrency == 4
    assert policy.window_cache_ttl_seconds == 86_400
    assert policy.nlp_deadline_seconds == 30.0


def test_a_geometry_over_the_nlp_ceiling_falls_back_to_the_declared_defaults() -> None:
    policy = GuardrailPolicy.from_blob(
        {"screenWindowChars": 8_000, "screenWindowOverlapChars": 512}
    )
    assert policy.screen_window_geometry == (2_000, 256)


def test_an_admitted_geometry_is_honoured() -> None:
    policy = GuardrailPolicy.from_blob(
        {"screenWindowChars": 3_000, "screenWindowOverlapChars": 128}
    )
    assert policy.screen_window_geometry == (3_000, 128)


# ── span re-basing and overlap de-duplication ────────────────────────────────


def test_overlap_duplicates_resolve_longest_span_wins() -> None:
    spans = [
        RegionSpan("t", "person", 100, 104, 0.9),  # "John" — clipped by a boundary
        RegionSpan("t", "person", 100, 108, 0.8),  # "John Doe" — the full span
        RegionSpan("t", "person", 100, 108, 0.7),  # same span seen by the next window
        RegionSpan("t", "email", 200, 210, 0.9),
        RegionSpan("u", "person", 100, 104, 0.9),  # another region — never merged
    ]
    kept = dedupe_longest(spans)
    assert [(s.region, s.label, s.start, s.end) for s in kept] == [
        ("t", "person", 100, 108),
        ("t", "email", 200, 210),
        ("u", "person", 100, 104),
    ]


async def test_spans_are_rebased_to_region_offsets_and_deduped_across_the_overlap() -> None:
    # Place the needle INSIDE the overlap of windows 0 and 1 (window 1 starts at 3,744).
    filler = "x" * 3_800
    region = filler + " John Doe " + "y" * 3_000
    client = _RecordingSpanClient()

    spans = await windowed_spans(
        _runner(None), client.extract_pii_entities, "pii-model", [("note", region)], GEOMETRY
    )

    assert len(client.calls) == 2
    assert len(spans) == 1
    span = spans[0]
    assert span.region == "note"
    assert region[span.start : span.end] == "John Doe"


# ── C2: no peer call ever carries more than one window ───────────────────────


async def test_a_100k_region_reaches_the_peer_only_in_bounded_windows() -> None:
    region = ("Patient John Doe reports chest pain. " * 3_000)[:100_000]
    client = _RecordingSpanClient()

    spans = await windowed_spans(
        _runner(None), client.extract_pii_entities, "pii-model", [("transcript", region)], GEOMETRY
    )

    assert len(client.calls) > 1
    assert all(len(text) <= GEOMETRY.size + GEOMETRY.overlap for text in client.calls)
    assert all(len(text) <= GEOMETRY.size for text in client.calls)
    assert spans and all(region[s.start : s.end] == "John Doe" for s in spans)


async def test_windows_of_one_request_run_under_a_bounded_concurrency() -> None:
    region = "z" * 40_000
    client = _RecordingSpanClient(delay=0.02)

    await windowed_spans(
        _runner(None), client.extract_pii_entities, "pii-model", [("r", region)], GEOMETRY
    )

    assert len(client.calls) > GEOMETRY.concurrency
    assert client.max_in_flight <= GEOMETRY.concurrency


# ── FC-7 cache ───────────────────────────────────────────────────────────────


def test_the_cache_key_is_exactly_the_frozen_hmac_and_never_contains_text() -> None:
    window = "Patient John Doe, DOB 1970-01-01, reports chest pain."
    key = window_cache_key(SECRET, TENANT_A, "pv-1", "pii-model", "pii", window)

    tenant_key = hmac.new(SECRET.encode(), TENANT_A.encode(), hashlib.sha256).digest()
    message = "\x1f".join(("pv-1", "pii-model", "pii", window)).encode()
    expected = hmac.new(tenant_key, message, hashlib.sha256).hexdigest()

    assert key == f"gr:wv:pii:{expected}"
    assert "John" not in key and "chest" not in key


def test_the_cache_key_is_tenant_keyed() -> None:
    window = "same window text"
    a = window_cache_key(SECRET, TENANT_A, "pv-1", "m", "pii", window)
    b = window_cache_key(SECRET, TENANT_B, "pv-1", "m", "pii", window)
    assert a != b


def test_policy_version_and_model_are_part_of_the_key() -> None:
    window = "same window text"
    base = window_cache_key(SECRET, TENANT_A, "pv-1", "m", "pii", window)
    assert base != window_cache_key(SECRET, TENANT_A, "pv-2", "m", "pii", window)
    assert base != window_cache_key(SECRET, TENANT_A, "pv-1", "m2", "pii", window)


async def test_an_append_only_region_rescreen_computes_only_the_tail_window(redis) -> None:
    cache = WindowVerdictCache.build(redis, SECRET, ttl_s=86_400)
    assert cache is not None
    first = ("Patient John Doe reports chest pain. " * 600)[:20_000]
    grown = first + " New speech from John Doe about a cough."

    client = _RecordingSpanClient()
    await windowed_spans(
        _runner(cache), client.extract_pii_entities, "pii-model", [("transcript", first)], GEOMETRY
    )
    first_calls = len(client.calls)
    assert first_calls == len(region_windows("transcript", first, GEOMETRY))

    client.calls.clear()
    spans = await windowed_spans(
        _runner(cache), client.extract_pii_entities, "pii-model", [("transcript", grown)], GEOMETRY
    )

    # Only the changed tail window reached the peer; the rest were cache hits.
    assert len(client.calls) == 1
    assert client.calls[0] == region_windows("transcript", grown, GEOMETRY)[-1].text
    assert spans and all(grown[s.start : s.end] == "John Doe" for s in spans)


async def test_the_cached_value_carries_offsets_and_labels_never_text(redis) -> None:
    cache = WindowVerdictCache.build(redis, SECRET, ttl_s=3_600)
    region = "Seen today: John Doe, 54, chest pain."
    client = _RecordingSpanClient()

    await windowed_spans(
        _runner(cache), client.extract_pii_entities, "pii-model", [("note", region)], GEOMETRY
    )

    keys = await redis.keys("gr:wv:*")
    assert len(keys) == 1
    assert keys[0].startswith("gr:wv:pii:")
    raw = await redis.get(keys[0])
    assert "John" not in raw and "chest" not in raw
    value = json.loads(raw)
    assert value["spans"] == [["person", 12, 20, 0.9]]
    ttl = await redis.ttl(keys[0])
    assert 0 < ttl <= 3_600


async def test_another_tenant_never_reads_a_cached_verdict(redis) -> None:
    cache = WindowVerdictCache.build(redis, SECRET, ttl_s=3_600)
    region = "Seen today: John Doe."
    client = _RecordingSpanClient()

    await windowed_spans(
        _runner(cache, TENANT_A), client.extract_pii_entities, "m", [("n", region)], GEOMETRY
    )
    await windowed_spans(
        _runner(cache, TENANT_B), client.extract_pii_entities, "m", [("n", region)], GEOMETRY
    )
    assert len(client.calls) == 2


def test_an_absent_secret_disables_the_cache(redis) -> None:
    assert WindowVerdictCache.build(redis, "", ttl_s=60) is None
    assert WindowVerdictCache.build(redis, None, ttl_s=60) is None
    assert WindowVerdictCache.build(None, SECRET, ttl_s=60) is None


async def test_an_absent_secret_computes_every_window_never_skips() -> None:
    region = "John Doe " * 2_000
    client = _RecordingSpanClient()

    for _ in range(2):
        spans = await windowed_spans(
            _runner(None), client.extract_pii_entities, "m", [("r", region)], GEOMETRY
        )
        assert spans

    windows = len(region_windows("r", region, GEOMETRY))
    assert len(client.calls) == 2 * windows


class _BrokenRedis:
    async def get(self, key):
        raise ConnectionError("redis down")

    async def set(self, key, value, ex=None):
        raise ConnectionError("redis down")


async def test_a_redis_error_is_a_miss_and_the_window_is_computed() -> None:
    cache = WindowVerdictCache.build(_BrokenRedis(), SECRET, ttl_s=60)
    region = "Seen today: John Doe."
    client = _RecordingSpanClient()

    spans = await windowed_spans(
        _runner(cache), client.extract_pii_entities, "m", [("n", region)], GEOMETRY
    )

    assert len(client.calls) == 1
    assert [region[s.start : s.end] for s in spans] == ["John Doe"]


async def test_a_failing_window_fails_the_whole_extraction_closed() -> None:
    from guardrail.core.errors import GuardrailUndeterminedError

    calls = 0

    async def extract(text: str):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise GuardrailUndeterminedError("engine_error", "nlp down")
        return []

    with pytest.raises(GuardrailUndeterminedError):
        await windowed_spans(_runner(None), extract, "m", [("r", "q" * 10_000)], GEOMETRY)


# ── D8 metrics ───────────────────────────────────────────────────────────────


async def test_window_metrics_count_requested_computed_and_cached(redis) -> None:
    from prometheus_client import REGISTRY

    def sample(name: str) -> float:
        return REGISTRY.get_sample_value(name, {"task": "pii"}) or 0.0

    before = {
        n: sample(n)
        for n in (
            "guardrail_screen_windows_requested_total",
            "guardrail_screen_windows_computed_total",
            "guardrail_screen_windows_cached_total",
        )
    }
    cache = WindowVerdictCache.build(redis, SECRET, ttl_s=60)
    region = "John Doe " * 1_000  # 9,000 chars → 3 windows
    client = _RecordingSpanClient()
    for _ in range(2):
        await windowed_spans(
            _runner(cache), client.extract_pii_entities, "m", [("r", region)], GEOMETRY
        )

    windows = len(region_windows("r", region, GEOMETRY))
    assert sample("guardrail_screen_windows_requested_total") - before[
        "guardrail_screen_windows_requested_total"
    ] == pytest.approx(2 * windows)
    assert sample("guardrail_screen_windows_computed_total") - before[
        "guardrail_screen_windows_computed_total"
    ] == pytest.approx(windows)
    assert sample("guardrail_screen_windows_cached_total") - before[
        "guardrail_screen_windows_cached_total"
    ] == pytest.approx(windows)
    assert (
        REGISTRY.get_sample_value("guardrail_window_cache_hit_ratio", {"task": "pii"}) is not None
    )
    assert (
        REGISTRY.get_sample_value("guardrail_screen_window_latency_seconds_count", {"task": "pii"})
        or 0
    ) >= windows
