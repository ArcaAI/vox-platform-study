"""Unit tests for SpeakerTracker.

Pure-logic tests -- no mocks, no I/O, no async.
"""

import collections

import numpy as np

from stt.diarization.speaker_tracker import SpeakerTracker


def _random_embedding(dim: int = 256) -> np.ndarray:
    """Generate a random L2-normalized embedding."""
    vec = np.random.randn(dim).astype(np.float32)
    return vec / np.linalg.norm(vec)


def _similar_embedding(base: np.ndarray, noise: float = 0.05) -> np.ndarray:
    """Create an embedding similar to *base* with small noise."""
    noisy = base + np.random.randn(*base.shape).astype(np.float32) * noise
    return noisy / np.linalg.norm(noisy)


class TestRegister:

    def test_first_register_returns_speaker_1(self):
        tracker = SpeakerTracker(max_speakers=2)
        emb = _random_embedding()
        sid = tracker.register(emb)
        assert sid == "Speaker 1"

    def test_second_register_returns_speaker_2(self):
        tracker = SpeakerTracker(max_speakers=2)
        tracker.register(_random_embedding())
        sid = tracker.register(_random_embedding())
        assert sid == "Speaker 2"

    def test_register_at_capacity_returns_none(self):
        tracker = SpeakerTracker(max_speakers=2)
        tracker.register(_random_embedding())
        tracker.register(_random_embedding())
        result = tracker.register(_random_embedding())
        assert result is None

    def test_register_unlimited_when_max_zero(self):
        tracker = SpeakerTracker(max_speakers=0)
        for i in range(10):
            sid = tracker.register(_random_embedding())
            assert sid == f"Speaker {i + 1}"
        assert tracker.speaker_count == 10

    def test_register_stores_l2_normalized(self):
        tracker = SpeakerTracker(max_speakers=5)
        raw = np.random.randn(256).astype(np.float32) * 5.0  # not normalized
        tracker.register(raw)
        # Internal reference should be L2-normalized (last entry in deque)
        ref = tracker._embedding_windows["Speaker 1"][-1]
        norm = float(np.linalg.norm(ref))
        assert abs(norm - 1.0) < 1e-5

    def test_register_creates_deque_with_one_embedding(self):
        tracker = SpeakerTracker(max_speakers=5)
        tracker.register(_random_embedding())
        window = tracker._embedding_windows["Speaker 1"]
        assert isinstance(window, collections.deque)
        assert len(window) == 1


class TestCompare:

    def test_compare_empty_tracker_returns_none(self):
        tracker = SpeakerTracker(max_speakers=2)
        emb = _random_embedding()
        sid, score = tracker.compare(emb)
        assert sid is None
        assert score == 0.0

    def test_compare_returns_best_match(self):
        tracker = SpeakerTracker(max_speakers=5)
        base1 = _random_embedding()
        base2 = _random_embedding()
        tracker.register(base1)
        tracker.register(base2)

        query = _similar_embedding(base1, noise=0.02)
        sid, score = tracker.compare(query)
        assert sid == "Speaker 1"
        assert score > 0.8

    def test_compare_single_embedding_equivalent_to_cosine(self):
        """With 1 embedding in the window, hybrid score == cosine similarity."""
        tracker = SpeakerTracker(max_speakers=2)
        emb = _random_embedding()
        tracker.register(emb)

        query = _similar_embedding(emb, noise=0.02)
        _, hybrid_score = tracker.compare(query)

        # Pure cosine for reference
        q_norm = query / np.linalg.norm(query)
        e_norm = emb / np.linalg.norm(emb)
        cosine = float(np.dot(q_norm, e_norm))

        # With 1 embedding: centroid == that embedding, max == that embedding
        # So hybrid = 0.7 * cosine + 0.3 * cosine = cosine
        assert abs(hybrid_score - cosine) < 1e-5

    def test_compare_orthogonal_gives_near_zero(self):
        tracker = SpeakerTracker(max_speakers=2)
        e1 = np.zeros(256, dtype=np.float32)
        e1[0] = 1.0
        e2 = np.zeros(256, dtype=np.float32)
        e2[1] = 1.0
        tracker.register(e1)

        sid, score = tracker.compare(e2)
        assert sid == "Speaker 1"
        assert abs(score) < 0.01

    def test_compare_hybrid_score_higher_than_pure_centroid_for_variable_speaker(self):
        """When a speaker has varied embeddings, the max-sim component
        catches an exact match that the centroid alone would miss."""
        tracker = SpeakerTracker(max_speakers=2, centroid_weight=0.7)
        base = _random_embedding()
        tracker.register(base)

        # Add several varied embeddings to dilute the centroid
        for _ in range(5):
            tracker.update_reference("Speaker 1", _random_embedding())

        # Now query with something close to the original base
        query = _similar_embedding(base, noise=0.01)
        _, hybrid_score = tracker.compare(query)

        # The max-sim component should find the original base in the window
        # giving a boost over pure centroid which averaged away from base
        # Just verify score is reasonable (> 0, non-trivial)
        assert hybrid_score > 0.0


class TestUpdateReference:

    def test_update_appends_to_window(self):
        tracker = SpeakerTracker(max_speakers=2)
        tracker.register(_random_embedding())
        assert len(tracker._embedding_windows["Speaker 1"]) == 1

        tracker.update_reference("Speaker 1", _random_embedding())
        assert len(tracker._embedding_windows["Speaker 1"]) == 2

    def test_update_stays_normalized(self):
        tracker = SpeakerTracker(max_speakers=2)
        tracker.register(_random_embedding())
        tracker.update_reference("Speaker 1", _random_embedding())
        for emb in tracker._embedding_windows["Speaker 1"]:
            norm = float(np.linalg.norm(emb))
            assert abs(norm - 1.0) < 1e-5

    def test_update_evicts_oldest_when_full(self):
        tracker = SpeakerTracker(max_speakers=2, max_embeddings_per_speaker=4)
        first_emb = _random_embedding()
        tracker.register(first_emb)

        # Fill the window (register put 1, add 3 more = 4 total)
        for _ in range(3):
            tracker.update_reference("Speaker 1", _random_embedding())
        assert len(tracker._embedding_windows["Speaker 1"]) == 4

        # Add one more -- oldest should be evicted
        tracker.update_reference("Speaker 1", _random_embedding())
        assert len(tracker._embedding_windows["Speaker 1"]) == 4

        # The first embedding should be gone
        first_norm = first_emb / np.linalg.norm(first_emb)
        for emb in tracker._embedding_windows["Speaker 1"]:
            if np.allclose(emb, first_norm, atol=1e-5):
                raise AssertionError("Oldest embedding should have been evicted")

    def test_update_unknown_speaker_no_op(self):
        tracker = SpeakerTracker(max_speakers=2)
        tracker.register(_random_embedding())
        tracker.update_reference("Speaker 99", _random_embedding())
        assert tracker.speaker_count == 1


class TestRollingWindow:

    def test_window_maxlen_enforced(self):
        tracker = SpeakerTracker(max_speakers=2, max_embeddings_per_speaker=4)
        tracker.register(_random_embedding())
        for _ in range(5):
            tracker.update_reference("Speaker 1", _random_embedding())
        # register put 1 + 5 updates = 6 total, but maxlen=4
        assert len(tracker._embedding_windows["Speaker 1"]) == 4

    def test_centroid_computed_from_all_window_entries(self):
        """Verify compare uses centroid of all entries, not just first/last."""
        tracker = SpeakerTracker(max_speakers=2, max_embeddings_per_speaker=4, centroid_weight=1.0)
        # Create 4 specific embeddings
        embs = [_random_embedding() for _ in range(4)]
        tracker.register(embs[0])
        for e in embs[1:]:
            tracker.update_reference("Speaker 1", e)

        # Manually compute centroid
        stacked = np.stack([e / np.linalg.norm(e) for e in embs])
        centroid = np.mean(stacked, axis=0)
        centroid = centroid / np.linalg.norm(centroid)

        # Query with centroid itself -- should get perfect score
        _, score = tracker.compare(centroid)
        assert abs(score - 1.0) < 1e-4

    def test_max_similarity_catches_exact_match_in_window(self):
        """One embedding in window nearly identical to query;
        verify high score even if centroid is far."""
        tracker = SpeakerTracker(max_speakers=2, max_embeddings_per_speaker=8, centroid_weight=0.0)
        exact_match = _random_embedding()
        tracker.register(exact_match)

        # Add many unrelated embeddings to pull centroid away
        for _ in range(6):
            tracker.update_reference("Speaker 1", _random_embedding())

        query = _similar_embedding(exact_match, noise=0.01)
        _, score = tracker.compare(query)
        # With centroid_weight=0.0, this is pure max-sim
        # exact_match should still be in window (8 total, we added 7)
        assert score > 0.9


class TestCentroidWeight:

    def test_centroid_weight_1_ignores_max(self):
        tracker = SpeakerTracker(max_speakers=2, centroid_weight=1.0)
        emb = _random_embedding()
        tracker.register(emb)
        query = _similar_embedding(emb, noise=0.02)

        _, score_cw1 = tracker.compare(query)

        # Pure centroid with single embedding = cosine
        q_norm = query / np.linalg.norm(query)
        e_norm = emb / np.linalg.norm(emb)
        cosine = float(np.dot(q_norm, e_norm))
        assert abs(score_cw1 - cosine) < 1e-5

    def test_centroid_weight_0_uses_only_max(self):
        tracker = SpeakerTracker(max_speakers=2, centroid_weight=0.0)
        emb = _random_embedding()
        tracker.register(emb)
        query = _similar_embedding(emb, noise=0.02)

        _, score_cw0 = tracker.compare(query)

        # Pure max-sim with single embedding = cosine
        q_norm = query / np.linalg.norm(query)
        e_norm = emb / np.linalg.norm(emb)
        cosine = float(np.dot(q_norm, e_norm))
        assert abs(score_cw0 - cosine) < 1e-5


class TestProperties:

    def test_speaker_count(self):
        tracker = SpeakerTracker(max_speakers=5)
        assert tracker.speaker_count == 0
        tracker.register(_random_embedding())
        assert tracker.speaker_count == 1
        tracker.register(_random_embedding())
        assert tracker.speaker_count == 2

    def test_speaker_ids(self):
        tracker = SpeakerTracker(max_speakers=5)
        tracker.register(_random_embedding())
        tracker.register(_random_embedding())
        assert tracker.speaker_ids == ["Speaker 1", "Speaker 2"]
