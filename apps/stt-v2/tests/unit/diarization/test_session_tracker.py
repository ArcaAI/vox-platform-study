"""Unit tests for SpeakerTracker.

Pure-logic tests -- no mocks, no I/O, no async.
"""

import numpy as np

from stt_v2.diarization.speaker_tracker import SpeakerTracker


def _random_embedding(dim: int = 512) -> np.ndarray:
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
        raw = np.random.randn(512).astype(np.float32) * 5.0  # not normalized
        tracker.register(raw)
        # Internal reference should be L2-normalized
        ref = tracker._embeddings["Speaker 1"]
        norm = float(np.linalg.norm(ref))
        assert abs(norm - 1.0) < 1e-5


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

    def test_compare_score_is_cosine_similarity(self):
        tracker = SpeakerTracker(max_speakers=2)
        emb = _random_embedding()
        tracker.register(emb)

        # Identical embedding should have cosine similarity ~1.0
        sid, score = tracker.compare(emb.copy())
        assert sid == "Speaker 1"
        assert abs(score - 1.0) < 1e-5

    def test_compare_orthogonal_gives_near_zero(self):
        tracker = SpeakerTracker(max_speakers=2)
        # Create two orthogonal vectors (in high dim, random vecs are nearly orthogonal)
        e1 = np.zeros(512, dtype=np.float32)
        e1[0] = 1.0
        e2 = np.zeros(512, dtype=np.float32)
        e2[1] = 1.0
        tracker.register(e1)

        sid, score = tracker.compare(e2)
        assert sid == "Speaker 1"
        assert abs(score) < 0.01


class TestUpdateReference:

    def test_ema_update_moves_reference(self):
        tracker = SpeakerTracker(max_speakers=2, ema_alpha=0.5)
        base = _random_embedding()
        tracker.register(base)
        old_ref = tracker._embeddings["Speaker 1"].copy()

        new_emb = _random_embedding()
        tracker.update_reference("Speaker 1", new_emb)
        updated_ref = tracker._embeddings["Speaker 1"]

        # Reference should have changed
        assert not np.allclose(old_ref, updated_ref)

    def test_ema_update_stays_normalized(self):
        tracker = SpeakerTracker(max_speakers=2, ema_alpha=0.3)
        tracker.register(_random_embedding())
        tracker.update_reference("Speaker 1", _random_embedding())
        ref = tracker._embeddings["Speaker 1"]
        norm = float(np.linalg.norm(ref))
        assert abs(norm - 1.0) < 1e-5

    def test_ema_alpha_controls_weight(self):
        tracker = SpeakerTracker(max_speakers=2, ema_alpha=0.0)
        base = _random_embedding()
        tracker.register(base)
        original = tracker._embeddings["Speaker 1"].copy()

        tracker.update_reference("Speaker 1", _random_embedding())
        # alpha=0 means no update
        assert np.allclose(original, tracker._embeddings["Speaker 1"], atol=1e-5)


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
