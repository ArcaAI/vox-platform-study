"""Unit tests for the claim-check core (TASK-483).

Hermetic — a fake in-memory store, no live MinIO. Proves the two safety
properties the claim-check must uphold:

* **Round-trip identity** — ``store_blob`` then ``load_blob`` returns the exact
  bytes (AC-1); the blob key is content-addressed (sha256) + deterministic.
* **Fail LOUD, never silent** — a missing blob raises ``ClaimCheckNotFound`` and
  a corrupt blob raises ``ClaimCheckIntegrityError`` (never returns empty/partial
  clinical text into the loop).

Plus the threshold gate (AC-2) and the inline-or-ref resolve seam (AC-3).
"""

from __future__ import annotations

import hashlib

import pytest

from harness.temporal.claim_check import (
    ClaimCheckIntegrityError,
    ClaimCheckNotFound,
    ClaimCheckRef,
    InMemoryBlobStore,
    content_key,
    load_blob,
    maybe_offload,
    resolve,
    should_offload,
    store_blob,
)

_BUCKET = "harness-claim-check-test"
# A blob comfortably over any small threshold used below.
_BIG = "clinical transcript " * 4096  # ~80 KiB of utf-8


class TestRoundTrip:
    @pytest.mark.asyncio
    async def test_store_then_load_is_byte_identical(self):
        """AC-1: store→reference→retrieve is the identity function."""
        store = InMemoryBlobStore()
        ref = await store_blob(_BIG, store=store, bucket=_BUCKET)
        assert isinstance(ref, ClaimCheckRef)
        loaded = await load_blob(ref, store=store)
        assert loaded == _BIG

    @pytest.mark.asyncio
    async def test_key_is_content_addressed_sha256_and_deterministic(self):
        """AC-1: the key is the sha256 of the utf-8 bytes — stable across calls."""
        store = InMemoryBlobStore()
        text = "same content"
        expected = hashlib.sha256(text.encode("utf-8")).hexdigest()
        ref1 = await store_blob(text, store=store, bucket=_BUCKET)
        ref2 = await store_blob(text, store=store, bucket=_BUCKET)
        assert ref1.key == expected
        assert ref2.key == expected  # deterministic — identical content ⇒ identical key
        assert content_key(text.encode("utf-8")) == expected

    @pytest.mark.asyncio
    async def test_ref_carries_integrity_metadata_only_no_content(self):
        """AC-6 core: the ref carries size/sha/bucket/key — never the clinical text."""
        store = InMemoryBlobStore()
        ref = await store_blob(_BIG, store=store, bucket=_BUCKET)
        blob = ref.model_dump()
        # The offloaded content must not appear anywhere in the ref payload.
        assert "clinical transcript" not in str(blob)
        assert ref.size == len(_BIG.encode("utf-8"))
        assert ref.sha256 == hashlib.sha256(_BIG.encode("utf-8")).hexdigest()
        assert ref.bucket == _BUCKET

    @pytest.mark.asyncio
    async def test_unicode_roundtrips_exactly(self):
        store = InMemoryBlobStore()
        text = "café — naïve — 日本語 — 🩺 dosage 5 mg"
        ref = await store_blob(text, store=store, bucket=_BUCKET)
        assert await load_blob(ref, store=store) == text
        assert ref.size == len(text.encode("utf-8"))


class TestFailLoud:
    @pytest.mark.asyncio
    async def test_missing_blob_raises_not_found(self):
        """A dangling/absent ref must fail LOUD — never return empty text."""
        store = InMemoryBlobStore()
        ghost = ClaimCheckRef(store="memory", bucket=_BUCKET, key="deadbeef", size=3, sha256="abc")
        with pytest.raises(ClaimCheckNotFound):
            await load_blob(ghost, store=store)

    @pytest.mark.asyncio
    async def test_corrupt_blob_raises_integrity_error(self):
        """A tampered/corrupt blob must fail LOUD (sha/size mismatch)."""
        store = InMemoryBlobStore()
        ref = await store_blob(_BIG, store=store, bucket=_BUCKET)
        # Corrupt the stored bytes under the same key.
        await store.put(ref.bucket, ref.key, b"tampered", "text/plain; charset=utf-8")
        with pytest.raises(ClaimCheckIntegrityError):
            await load_blob(ref, store=store)


class TestThresholdGate:
    def test_small_string_stays_inline(self):
        """AC-2: below the threshold ⇒ no offload (no store round-trip tax)."""
        assert should_offload("tiny", min_bytes=1024) is False

    def test_at_or_above_threshold_offloads(self):
        assert should_offload("x" * 1024, min_bytes=1024) is True
        assert should_offload("x" * 1025, min_bytes=1024) is True

    def test_threshold_measured_in_utf8_bytes_not_chars(self):
        # 4-byte emoji: 3 chars but 12 bytes.
        assert should_offload("🩺🩺🩺", min_bytes=10) is True
        assert should_offload("abc", min_bytes=10) is False

    @pytest.mark.asyncio
    async def test_maybe_offload_below_threshold_returns_inline_none(self):
        """AC-2: small payload ⇒ (inline text, None) — nothing hits the store."""
        store = InMemoryBlobStore()
        inline, ref = await maybe_offload("small", store=store, bucket=_BUCKET, min_bytes=1024)
        assert inline == "small"
        assert ref is None

    @pytest.mark.asyncio
    async def test_maybe_offload_above_threshold_empties_inline_and_refs(self):
        """AC-6: above threshold ⇒ ("", ref) so the blob stays OUT of history."""
        store = InMemoryBlobStore()
        inline, ref = await maybe_offload(_BIG, store=store, bucket=_BUCKET, min_bytes=1024)
        assert inline == ""  # inline emptied — no clinical text in the carrier
        assert ref is not None
        # And the blob is retrievable from the store.
        assert await load_blob(ref, store=store) == _BIG


class TestHistoryFootprintFlat:
    @pytest.mark.asyncio
    async def test_ref_footprint_is_constant_regardless_of_blob_size(self):
        """AC-5: the recorded footprint is bounded by the REF, not the blob.

        Doubling (here 8×-ing) the blob length does not grow the offloaded payload that
        Temporal records — only the small ``ClaimCheckRef`` (fixed-length sha256 key +
        an integer size) enters history. This is the size-budget protection the ticket
        exists for.
        """
        store = InMemoryBlobStore()
        small = "x" * 100_000  # 100 KB
        big = "x" * 800_000  # 800 KB — 8× larger
        _, ref_small = await maybe_offload(small, store=store, bucket=_BUCKET, min_bytes=1024)
        _, ref_big = await maybe_offload(big, store=store, bucket=_BUCKET, min_bytes=1024)
        assert ref_small is not None and ref_big is not None
        foot_small = len(ref_small.model_dump_json())
        foot_big = len(ref_big.model_dump_json())
        # The serialized refs differ only by the digits of the integer ``size`` field; the
        # content-addressed key (sha256 hex) is fixed-length. Blob length does not leak.
        assert abs(foot_small - foot_big) <= 8
        # ...and BOTH are a few hundred bytes vs the 100 KB / 800 KB blobs (O(1) footprint).
        assert foot_big < 400


class TestResolveSeam:
    @pytest.mark.asyncio
    async def test_resolve_inline_when_ref_absent(self):
        """AC-3 backward-compat: ref None ⇒ use the inline field (old-history shape)."""
        store = InMemoryBlobStore()
        assert await resolve("inline-note", None, store=store) == "inline-note"

    @pytest.mark.asyncio
    async def test_resolve_dereferences_when_ref_present(self):
        """AC-3: ref set ⇒ dereference from the store (new-history shape)."""
        store = InMemoryBlobStore()
        _, ref = await maybe_offload(_BIG, store=store, bucket=_BUCKET, min_bytes=1024)
        assert await resolve("", ref, store=store) == _BIG

    @pytest.mark.asyncio
    async def test_offload_then_resolve_is_identity(self):
        """The end-to-end seam: produce (maybe_offload) then consume (resolve)."""
        store = InMemoryBlobStore()
        inline, ref = await maybe_offload(_BIG, store=store, bucket=_BUCKET, min_bytes=1024)
        assert await resolve(inline, ref, store=store) == _BIG
