"""The outbound peer-call bound (owner decision 2026-08-20).

Before this decision, `/classify/topic`/`/classify/intent` reused
`inference_bound` — the SAME semaphore that guards local GPU/CPU inference —
for their outbound HTTP calls to `text`. That conflates two different
resources: a slow round-trip to a peer service could starve local
classification's inference slots, or a burst of local inference could starve
peer-call throughput. These tests lock the SEPARATE peer-call semaphore, its
independence from the inference bound, and its live control-plane resize.
"""

from __future__ import annotations

import asyncio

import pytest

from nlp.core.concurrency import (
    ResizableSemaphore,
    get_inference_semaphore,
    get_peer_call_semaphore,
    refresh_peer_call_limit,
    reset_inference_semaphore,
    reset_peer_call_semaphore,
)
from nlp.core.effective_config import EffectiveConfigSnapshot


@pytest.fixture(autouse=True)
def _fresh_singletons():
    reset_inference_semaphore()
    reset_peer_call_semaphore()
    yield
    reset_inference_semaphore()
    reset_peer_call_semaphore()


class TestSingleton:
    def test_returns_the_same_object(self) -> None:
        assert get_peer_call_semaphore() is get_peer_call_semaphore()

    def test_defaults_to_the_configured_bound(self) -> None:
        # Bootstrap fallback — matches `nlp.peerCall.maxConcurrent`'s code default.
        assert get_peer_call_semaphore().limit == 8

    def test_reset_replaces_the_singleton(self) -> None:
        first = get_peer_call_semaphore()
        reset_peer_call_semaphore()
        assert get_peer_call_semaphore() is not first


class TestIndependenceFromInferenceBound:
    """The whole point of the decision: two different semaphores, two
    different resources — resizing or saturating one must never touch the
    other."""

    def test_peer_call_and_inference_are_different_objects(self) -> None:
        assert get_peer_call_semaphore() is not get_inference_semaphore()

    def test_resizing_the_peer_call_bound_leaves_inference_untouched(self) -> None:
        inference = get_inference_semaphore()
        peer_call = get_peer_call_semaphore()
        assert inference.limit == 4
        assert peer_call.limit == 8

        peer_call.set_limit(20)

        assert peer_call.limit == 20
        assert inference.limit == 4, "resizing the peer-call bound must not resize inference"

    async def test_saturating_the_peer_call_bound_leaves_inference_capacity_free(self) -> None:
        """A burst of topic/intent calls exhausting the peer-call bound must
        not block a concurrent local-inference request from acquiring the
        (separate) inference bound."""
        peer_call = ResizableSemaphore(1)
        inference = ResizableSemaphore(4)

        await peer_call.acquire()  # peer-call bound now fully saturated

        # Inference must still be immediately acquirable — no cross-talk.
        await asyncio.wait_for(inference.acquire(), timeout=1)
        assert inference.in_flight == 1
        assert peer_call.in_flight == 1


class TestLiveResize:
    async def test_limit_resizes_on_refresh(self) -> None:
        sem = get_peer_call_semaphore()
        assert sem.limit == 8

        sem.set_limit(15)

        assert get_peer_call_semaphore().limit == 15
        assert get_peer_call_semaphore() is sem, "resize must not swap the object"

    async def test_shrink_does_not_revoke_in_flight_peer_calls(self) -> None:
        sem = ResizableSemaphore(4)
        await sem.acquire()
        await sem.acquire()
        await sem.acquire()

        sem.set_limit(1)

        assert sem.in_flight == 3, "in-flight peer calls must never be revoked"
        assert sem.limit == 1


class _FakeClient:
    """A minimal stand-in for `EffectiveConfigClient` — just `.get()`."""

    def __init__(
        self, snapshot: EffectiveConfigSnapshot | None = None, raises: Exception | None = None
    ) -> None:
        self._snapshot = snapshot
        self._raises = raises

    async def get(self) -> EffectiveConfigSnapshot:
        if self._raises is not None:
            raise self._raises
        assert self._snapshot is not None
        return self._snapshot


class TestRefreshFromControlPlane:
    """`refresh_peer_call_limit` mirrors `refresh_inference_limit`, but reads
    ITS OWN control-plane key (`peerCallMaxConcurrent`) and never touches
    model-cache retention — that stays `refresh_inference_limit`'s job alone."""

    async def test_none_client_returns_the_bootstrap_semaphore_unchanged(self) -> None:
        sem = await refresh_peer_call_limit(None)
        assert sem.limit == 8

    async def test_applies_a_served_bound(self) -> None:
        snapshot = EffectiveConfigSnapshot(
            raw={"concurrency": {"peerCallMaxConcurrent": 32}}, ok=True
        )
        sem = await refresh_peer_call_limit(_FakeClient(snapshot=snapshot))
        assert sem.limit == 32

    async def test_no_opinion_keeps_the_current_limit(self) -> None:
        get_peer_call_semaphore().set_limit(11)
        snapshot = EffectiveConfigSnapshot(raw={}, ok=False)
        sem = await refresh_peer_call_limit(_FakeClient(snapshot=snapshot))
        assert sem.limit == 11

    async def test_a_client_error_never_raises_and_keeps_the_current_limit(self) -> None:
        get_peer_call_semaphore().set_limit(6)
        sem = await refresh_peer_call_limit(_FakeClient(raises=RuntimeError("gateway down")))
        assert sem.limit == 6

    async def test_resizing_the_peer_call_bound_via_refresh_never_touches_inference(self) -> None:
        inference = get_inference_semaphore()
        assert inference.limit == 4

        snapshot = EffectiveConfigSnapshot(
            raw={"concurrency": {"peerCallMaxConcurrent": 50}}, ok=True
        )
        await refresh_peer_call_limit(_FakeClient(snapshot=snapshot))

        assert inference.limit == 4, "peer-call refresh must never resize the inference bound"
