"""Streaming noise suppression via RNNoise.

Processes 16kHz input by upsampling to 48kHz, running through RNNoise
(480-sample frames), then downsampling back to 16kHz.

Upsample uses linear interpolation; downsample uses simple decimation.
Both are stateless per-sample operations with zero frame-boundary
artifacts (unlike FIR-based resamplers that introduce edge transients
when called per-chunk).

Always consumes exactly ``n_in * up_ratio`` samples from the denoised
buffer to maintain a fixed downsample ratio.  The denoised output is
delayed by ~1 frame relative to the input; when blending (strength < 1
or fade-in), the original signal is delayed to match so both signals
are temporally aligned (no comb filter).
"""

from __future__ import annotations

import logging
from math import gcd
from typing import Any, cast

import numpy as np

logger = logging.getLogger(__name__)

_RNNOISE_SR = 48000
_RNNOISE_FRAME_SIZE = 480
_FADE_IN_SECONDS = 0.1
_MAX_CONSECUTIVE_FAILURES = 10

_EMPTY_F32 = np.empty(0, dtype=np.float32)


class StreamingDenoiser:
    """Persistent RNNoise session for streaming noise suppression.

    Parameters
    ----------
    input_sr:
        Input sample rate in Hz (typically 16000).
    strength:
        Blend factor between original (0.0) and denoised (1.0).
    """

    def __init__(self, input_sr: int = 16000, strength: float = 1.0) -> None:
        self._input_sr = input_sr
        self._strength = max(0.0, min(1.0, strength))
        self._rnnoise: Any = None
        self._available = False

        self._ring_48k = _EMPTY_F32.copy()
        self._denoised_48k = _EMPTY_F32.copy()

        g = gcd(_RNNOISE_SR, input_sr)
        self._up_factor = _RNNOISE_SR // g
        self._down_factor = input_sr // g

        self._total_input_samples = 0
        self._fade_in_samples = int(_FADE_IN_SECONDS * input_sr)
        self._consecutive_failures = 0

        # Delayed original frame for temporal alignment during blending.
        # The denoised output is delayed by ~1 frame relative to input
        # (RNNoise buffer fills during frame N, consumed during frame N+1).
        # To avoid comb filter when blending, delay the original to match.
        self._prev_frame_16k: np.ndarray | None = None

    def initialize(self) -> bool:
        """Create RNNoise instance. Returns False if pyrnnoise unavailable."""
        try:
            import pyrnnoise

            self._rnnoise = pyrnnoise.RNNoise(sample_rate=_RNNOISE_SR)
            self._available = True
            logger.info("StreamingDenoiser initialized (pyrnnoise available)")
            return True
        except ImportError:
            logger.warning("pyrnnoise not installed -- denoise disabled")
            self._available = False
            self._rnnoise = None
            return False
        except Exception:
            logger.error(
                "pyrnnoise initialization failed -- denoise disabled",
                exc_info=True,
            )
            self._available = False
            self._rnnoise = None
            return False

    @property
    def in_fade_in(self) -> bool:
        """Whether the denoiser is still in the initial fade-in period."""
        return self._total_input_samples < self._fade_in_samples

    def process(self, frame_16k: np.ndarray) -> np.ndarray:
        """Denoise one frame of 16kHz audio.

        Args:
            frame_16k: Float32 mono audio frame at input sample rate.

        Returns:
            Denoised float32 frame of same length.
        """
        if not self._available or self._rnnoise is None:
            return frame_16k

        if self._strength == 0.0:
            return frame_16k

        n_in = len(frame_16k)
        if n_in == 0:
            return frame_16k

        # Step 1: Upsample 16kHz -> 48kHz via linear interpolation.
        # No FIR filter = no edge transients at frame boundaries.
        # Spectral images above 8kHz are irrelevant to RNNoise.
        n_up = n_in * self._up_factor // self._down_factor
        x_48k = np.arange(n_up, dtype=np.float64) * self._down_factor / self._up_factor
        upsampled = np.interp(x_48k, np.arange(n_in), frame_16k).astype(np.float32)

        # Step 2: Append to 48kHz ring buffer
        self._ring_48k = np.concatenate([self._ring_48k, upsampled])

        # Step 3: Drain complete 480-sample chunks through RNNoise.
        new_chunks: list[np.ndarray] = []
        ring_pos = 0
        ring_len = len(self._ring_48k)
        try:
            while ring_pos + _RNNOISE_FRAME_SIZE <= ring_len:
                chunk_f32 = self._ring_48k[ring_pos : ring_pos + _RNNOISE_FRAME_SIZE]
                ring_pos += _RNNOISE_FRAME_SIZE

                chunk_int16 = (
                    (chunk_f32 * 32767.0).clip(-32768, 32767).astype(np.int16).reshape(1, -1)
                )

                for _speech_prob, denoised_chunk in self._rnnoise.denoise_chunk(chunk_int16):
                    flat = np.asarray(denoised_chunk, dtype=np.float32).ravel() / 32768.0
                    new_chunks.append(flat)

            self._consecutive_failures = 0
        except Exception:
            self._consecutive_failures += 1
            if self._consecutive_failures <= 3:
                logger.warning("RNNoise denoise_chunk failed, passing through", exc_info=True)
            elif self._consecutive_failures == _MAX_CONSECUTIVE_FAILURES:
                logger.error(
                    "RNNoise failed %d consecutive times -- auto-disabling denoiser",
                    self._consecutive_failures,
                )
                self._available = False
            self._total_input_samples += n_in
            self._prev_frame_16k = frame_16k.copy()
            return frame_16k
        finally:
            # Trim consumed samples from ring buffer (single slice).
            if ring_pos > 0:
                self._ring_48k = self._ring_48k[ring_pos:]

        if new_chunks:
            self._denoised_48k = np.concatenate([self._denoised_48k, *new_chunks])

        self._total_input_samples += n_in

        # Step 4: Consume exactly n_up samples to keep downsample ratio fixed.
        # Only the first frame may lack enough data; from frame 2 onward the
        # buffer always has >= n_up samples.
        if len(self._denoised_48k) < n_up:
            self._prev_frame_16k = frame_16k.copy()
            return frame_16k

        denoised_seg = self._denoised_48k[:n_up]
        self._denoised_48k = self._denoised_48k[n_up:]

        # Step 5: Downsample 48kHz -> 16kHz via decimation.
        # RNNoise output is bandlimited to the input's Nyquist (~8kHz),
        # so simple decimation is alias-free.  No FIR = no edge artifacts.
        denoised_16k = denoised_seg[:: self._up_factor // self._down_factor]
        if len(denoised_16k) > n_in:
            denoised_16k = denoised_16k[:n_in]
        elif len(denoised_16k) < n_in:
            denoised_16k = np.pad(denoised_16k, (0, n_in - len(denoised_16k)))

        # Step 6: Blend with temporally-aligned original.
        #
        # The denoised output is delayed by ~1 frame relative to the input
        # because the RNNoise buffer fills during frame N and is consumed
        # during frame N+1.  Blending current frame_16k (time T) with
        # denoised_16k (time T-32ms) creates a comb filter with -10dB
        # notches at speech frequencies (200Hz, 300Hz) -- the "echo."
        #
        # Fix: use the PREVIOUS frame (same time as denoised) for blending.
        original_for_blend = self._prev_frame_16k if self._prev_frame_16k is not None else frame_16k
        self._prev_frame_16k = frame_16k.copy()

        if self._total_input_samples <= self._fade_in_samples:
            fade_start = max(0.0, (self._total_input_samples - n_in) / self._fade_in_samples)
            fade_end = min(1.0, self._total_input_samples / self._fade_in_samples)
            fade_ramp = np.linspace(fade_start, fade_end, n_in, dtype=np.float32)
            result = (1.0 - fade_ramp) * original_for_blend + fade_ramp * denoised_16k
        elif self._strength >= 1.0:
            result = denoised_16k
        else:
            result = (1.0 - self._strength) * original_for_blend + self._strength * denoised_16k
        return cast(np.ndarray, result.astype(np.float32))

    def reset(self) -> None:
        """Clear ring buffer and recreate RNNoise instance."""
        self._ring_48k = _EMPTY_F32.copy()
        self._denoised_48k = _EMPTY_F32.copy()
        self._total_input_samples = 0
        self._consecutive_failures = 0
        self._prev_frame_16k = None
        if self._available:
            try:
                import pyrnnoise

                self._rnnoise = pyrnnoise.RNNoise(sample_rate=_RNNOISE_SR)
            except Exception:
                pass

    @property
    def is_available(self) -> bool:
        """Whether RNNoise is initialized and available."""
        return self._available
