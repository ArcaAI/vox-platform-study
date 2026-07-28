"""Per-session in-memory N-speaker state.

Pure Python, zero I/O, zero async. Tracks speaker reference embeddings
via a rolling window of recent embeddings with hybrid centroid+max-similarity
scoring for session-scoped diarization.
"""

from __future__ import annotations

import collections
import threading

import numpy as np


class SpeakerTracker:
    """Per-session in-memory N-speaker state."""

    def __init__(
        self,
        max_speakers: int = 2,
        max_embeddings_per_speaker: int = 8,
        centroid_weight: float = 0.7,
    ) -> None:
        self._embedding_windows: dict[str, collections.deque[np.ndarray]] = {}
        self._max_speakers = max_speakers
        self._max_embeddings = max_embeddings_per_speaker
        self._centroid_w = centroid_weight
        self._max_sim_w = 1.0 - centroid_weight
        self._next_speaker_num = 1
        self._lock = threading.Lock()

    def compare(self, embedding: np.ndarray) -> tuple[str | None, float]:
        """Best matching speaker via hybrid centroid+max-similarity scoring.

        Returns (speaker_id, score). If no speakers registered,
        returns (None, 0.0).
        """
        query = self._normalize(embedding)
        with self._lock:
            if not self._embedding_windows:
                return None, 0.0

            best_id: str | None = None
            best_score: float = -1.0
            for sid, window in self._embedding_windows.items():
                if not window:
                    continue
                centroid = self._normalize(np.mean(np.stack(list(window)), axis=0))
                sim_centroid = float(np.dot(query, centroid))
                sim_max = float(max(np.dot(query, e) for e in window))
                score = self._centroid_w * sim_centroid + self._max_sim_w * sim_max
                if score > best_score:
                    best_score = score
                    best_id = sid

            return best_id, max(best_score, 0.0)

    def register(self, embedding: np.ndarray, speaker_id: str | None = None) -> str | None:
        """Register new speaker. Returns speaker_id or None if at capacity.

        Args:
            embedding: Speaker embedding vector (will be L2-normalized).
            speaker_id: Optional custom ID. If None, a generic "Speaker N" label is assigned.
        """
        normalized = self._normalize(embedding)
        with self._lock:
            if self._max_speakers > 0 and len(self._embedding_windows) >= self._max_speakers:
                return None

            sid = (
                speaker_id
                if speaker_id and speaker_id.strip()
                else f"Speaker {self._next_speaker_num}"
            )
            window: collections.deque[np.ndarray] = collections.deque(
                maxlen=self._max_embeddings,
            )
            window.append(normalized)
            self._embedding_windows[sid] = window
            self._next_speaker_num += 1
            return sid

    def update_reference(self, speaker_id: str, embedding: np.ndarray) -> None:
        """Append embedding to speaker's rolling window."""
        normalized = self._normalize(embedding)
        with self._lock:
            if speaker_id not in self._embedding_windows:
                return
            self._embedding_windows[speaker_id].append(normalized)

    @property
    def speaker_count(self) -> int:
        with self._lock:
            return len(self._embedding_windows)

    @property
    def speaker_ids(self) -> list[str]:
        with self._lock:
            return list(self._embedding_windows.keys())

    @staticmethod
    def _normalize(vec: np.ndarray) -> np.ndarray:
        """L2-normalize a vector."""
        arr = np.asarray(vec, dtype=np.float32)
        norm = np.linalg.norm(arr)
        if norm < 1e-10:
            return arr
        return arr / norm
