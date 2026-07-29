"""On-demand speaker turn detection via pyannote/segmentation-3.0.

Thread-safe, lazy-loaded. Used only when ambiguous-zone diarization
needs sub-segment splitting.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


class SegmentationService:
    """On-demand speaker turn detection."""

    def __init__(self, hf_model_id: str = "pyannote/segmentation-3.0") -> None:
        self._hf_model_id = hf_model_id
        self._model: Any = None
        self._loaded = False
        self._lock = threading.Lock()
        self._sample_rate = 16000

    async def initialize(self) -> None:
        """Load model (CPU by default). Safe to call multiple times."""
        if self._loaded:
            return
        await asyncio.to_thread(self._load_model)

    def _load_model(self) -> None:
        if self._loaded:
            return
        try:
            from pyannote.audio import Model

            from stt.core.config.settings import get_settings

            settings = get_settings()
            hf_token = settings.huggingface_token
            token = hf_token.get_secret_value() if hf_token else None
            if not token:
                try:
                    from huggingface_hub import get_token as hf_get_token

                    token = hf_get_token()
                except Exception:
                    pass

            self._model = Model.from_pretrained(
                self._hf_model_id,
                use_auth_token=token,
            )
            self._loaded = True
            logger.info("Segmentation model loaded: %s", self._hf_model_id)
        except Exception:
            logger.exception("Failed to load segmentation model: %s", self._hf_model_id)
            raise

    def _run_segmentation(
        self,
        samples: np.ndarray,
        sample_rate: int,
    ) -> tuple[np.ndarray, float]:
        """Run segmentation model synchronously.

        Returns (activations, frame_duration_s) where activations is
        (num_frames, num_speakers) and frame_duration_s is the duration
        of each frame in seconds.
        """
        import torch

        waveform = torch.from_numpy(samples).unsqueeze(0).float()
        if sample_rate != self._sample_rate:
            import torchaudio

            waveform = torchaudio.functional.resample(waveform, sample_rate, self._sample_rate)

        with self._lock:
            with torch.no_grad():
                output = self._model(waveform)

        # output shape: (1, num_frames, num_speakers)
        activations = output.squeeze(0).cpu().numpy()

        # pyannote/segmentation-3.0 uses ~16ms frames
        total_duration = len(samples) / sample_rate
        num_frames = activations.shape[0]
        frame_duration = total_duration / num_frames if num_frames > 0 else 0.016

        return activations, frame_duration

    async def detect_speaker_turns(
        self,
        samples: np.ndarray,
        sample_rate: int,
        min_segment_s: float = 0.5,
    ) -> list[tuple[float, float]]:
        """Return sub-segment boundaries from speaker change detection.

        Each tuple is (start_seconds, end_seconds).
        """
        activations, frame_duration = await asyncio.to_thread(
            self._run_segmentation,
            samples,
            sample_rate,
        )

        return self._extract_turn_boundaries(activations, frame_duration, min_segment_s)

    @staticmethod
    def _extract_turn_boundaries(
        activations: np.ndarray,
        frame_duration: float,
        min_segment_s: float,
    ) -> list[tuple[float, float]]:
        """Extract speaker turn boundaries from activation matrix.

        Finds frames where the dominant speaker changes and merges
        consecutive same-speaker frames into segments.
        """
        if activations.shape[0] == 0:
            return []

        # Dominant speaker per frame
        dominant = np.argmax(activations, axis=1)

        segments: list[tuple[float, float]] = []
        seg_start = 0
        current_speaker = dominant[0]

        for i in range(1, len(dominant)):
            if dominant[i] != current_speaker:
                start_s = seg_start * frame_duration
                end_s = i * frame_duration
                if (end_s - start_s) >= min_segment_s:
                    segments.append((start_s, end_s))
                seg_start = i
                current_speaker = dominant[i]

        # Final segment
        start_s = seg_start * frame_duration
        end_s = len(dominant) * frame_duration
        if (end_s - start_s) >= min_segment_s:
            segments.append((start_s, end_s))

        return segments

    async def shutdown(self) -> None:
        self._model = None
        self._loaded = False
