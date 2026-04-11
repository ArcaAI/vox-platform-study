"""Per-session in-memory N-speaker state.

Pure Python, zero I/O, zero async. Tracks speaker reference embeddings
via cosine similarity for session-scoped diarization.
"""

from __future__ import annotations

import threading

import numpy as np


class SpeakerTracker:
    """Per-session in-memory N-speaker state."""

    def __init__(self, max_speakers: int = 2, ema_alpha: float = 0.1) -> None:
        self._embeddings: dict[str, np.ndarray] = {}
        self._max_speakers = max_speakers
        self._ema_alpha = ema_alpha
        self._next_speaker_num = 1
        self._lock = threading.Lock()

    def compare(self, embedding: np.ndarray) -> tuple[str | None, float]:
        """Best matching speaker via cosine similarity.

        Returns (speaker_id, score). If no speakers registered,
        returns (None, 0.0).
        """
        query = self._normalize(embedding)
        with self._lock:
            if not self._embeddings:
                return None, 0.0

            best_id: str | None = None
            best_score: float = -1.0
            for sid, ref in self._embeddings.items():
                score = float(np.dot(query, ref))
                if score > best_score:
                    best_score = score
                    best_id = sid

            return best_id, max(best_score, 0.0)

    def register(self, embedding: np.ndarray) -> str | None:
        """Register new speaker. Returns speaker_id or None if at capacity."""
        normalized = self._normalize(embedding)
        with self._lock:
            if self._max_speakers > 0 and len(self._embeddings) >= self._max_speakers:
                return None

            speaker_id = f"Speaker {self._next_speaker_num}"
            self._embeddings[speaker_id] = normalized
            self._next_speaker_num += 1
            return speaker_id

    def update_reference(self, speaker_id: str, embedding: np.ndarray) -> None:
        """EMA-update reference embedding for high-confidence matches."""
        normalized = self._normalize(embedding)
        with self._lock:
            if speaker_id not in self._embeddings:
                return
            ref = self._embeddings[speaker_id]
            updated = (1.0 - self._ema_alpha) * ref + self._ema_alpha * normalized
            self._embeddings[speaker_id] = self._normalize(updated)

    @property
    def speaker_count(self) -> int:
        with self._lock:
            return len(self._embeddings)

    @property
    def speaker_ids(self) -> list[str]:
        with self._lock:
            return list(self._embeddings.keys())

    @staticmethod
    def _normalize(vec: np.ndarray) -> np.ndarray:
        """L2-normalize a vector."""
        arr = np.asarray(vec, dtype=np.float32)
        norm = np.linalg.norm(arr)
        if norm < 1e-10:
            return arr
        return arr / norm
