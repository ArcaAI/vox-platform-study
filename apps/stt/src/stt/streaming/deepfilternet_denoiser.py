"""Streaming noise suppression via DeepFilterNet3.

Unlike RNNoise (``denoiser.py``), DeepFilterNet3's public API
(``df.enhance.enhance()``) operates on a WHOLE audio buffer/tensor — there is
no frame-accurate incremental-streaming call exposed by the ``deepfilternet``
package. This adapter therefore uses BLOCK processing: it accumulates input
frames into a fixed-size block (`_BLOCK_SECONDS`), runs ``enhance()`` once the
block is full, and emits the enhanced audio one input-frame-size slice at a
time from the resulting queue.

This trades ~`_BLOCK_SECONDS` of added latency for correctness (no ad hoc
incremental-DNN hacks). While a block is still filling (including the very
first block after session start), ``process()`` passes the ORIGINAL audio
through unmodified rather than emitting silence — audio is never dropped,
only (temporarily) un-denoised. For latency-sensitive real-time denoising,
prefer ``engine: rnnoise`` (frame-accurate, ~1 frame of latency); DeepFilterNet3
is best suited to pipelines where the extra ~1s latency is acceptable in
exchange for its stronger full-band noise suppression.
"""

from __future__ import annotations

import logging
from math import gcd
from typing import Any, cast

import numpy as np

from ..core.exceptions import ModelLoadError

logger = logging.getLogger(__name__)

_DF_SR = 48000
_BLOCK_SECONDS = 1.0
_EMPTY_F32 = np.empty(0, dtype=np.float32)


class DeepFilterNet3StreamingDenoiser:
    """Block-processing DeepFilterNet3 session for streaming noise suppression.

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
        self._model: Any = None
        self._df_state: Any = None
        self._available = False

        g = gcd(_DF_SR, input_sr)
        self._up_factor = _DF_SR // g
        self._down_factor = input_sr // g
        self._block_samples_in = int(_BLOCK_SECONDS * input_sr)

        self._pending_in: np.ndarray = _EMPTY_F32.copy()
        self._output_queue: np.ndarray = _EMPTY_F32.copy()

    def initialize(self) -> bool:
        """Load the DeepFilterNet3 model. FAILS CLOSED (TASK-860 R-5).

        A pipeline that SELECTED ``deepfilternet3`` must never silently pass
        un-denoised audio through because the ``deepfilternet`` package is
        absent or its checkpoint failed to load — that is a wrong answer
        delivered quietly. Raises ``ModelLoadError`` naming the engine and the
        fix; returns ``True`` on success (the ``bool`` return is kept so the
        RNNoise-shaped call site reads the same for both engines).
        """
        try:
            from df.enhance import init_df
        except ImportError as exc:
            self._available = False
            raise ModelLoadError(
                "denoise engine 'deepfilternet3' was selected but the `deepfilternet` "
                "package is not installed in this image — install it (numpy-2 "
                "compatible build) or select `rnnoise`."
            ) from exc
        try:
            self._model, self._df_state, _, _ = init_df(default_model="DeepFilterNet3")
        except Exception as exc:
            self._available = False
            raise ModelLoadError(
                f"denoise engine 'deepfilternet3' failed to initialise its checkpoint: {exc}"
            ) from exc
        self._available = True
        logger.info("DeepFilterNet3StreamingDenoiser initialized")
        return True

    @property
    def in_fade_in(self) -> bool:
        """No fade-in ramp for block processing — passthrough during warm-up
        already avoids the RNNoise-style discontinuity this guards against."""
        return False

    def process(self, frame_16k: np.ndarray) -> np.ndarray:
        """Denoise one frame of input-rate audio (block-buffered).

        Args:
            frame_16k: Float32 mono audio frame at input sample rate.

        Returns:
            Float32 frame of the same length — either enhanced audio (once a
            full block has been processed) or the original, unmodified frame
            (while the current block is still filling).
        """
        if not self._available or self._model is None or self._strength == 0.0:
            return frame_16k

        n_in = len(frame_16k)
        if n_in == 0:
            return frame_16k

        self._pending_in = np.concatenate([self._pending_in, frame_16k])

        if len(self._pending_in) >= self._block_samples_in:
            block = self._pending_in[: self._block_samples_in]
            self._pending_in = self._pending_in[self._block_samples_in :]

            enhanced = self._enhance_block(block)
            if enhanced is not None:
                blended = (
                    enhanced
                    if self._strength >= 1.0
                    else (1.0 - self._strength) * block + self._strength * enhanced
                )
                self._output_queue = np.concatenate(
                    [self._output_queue, blended.astype(np.float32)]
                )
            else:
                # enhance() failed — degrade to passthrough for this block
                # rather than leaving the output queue permanently starved.
                self._output_queue = np.concatenate([self._output_queue, block])

        if len(self._output_queue) >= n_in:
            out = self._output_queue[:n_in]
            self._output_queue = self._output_queue[n_in:]
            return out

        # Not enough enhanced audio queued yet (still warming up) — pass the
        # original through rather than emitting silence or blocking.
        return frame_16k

    def _enhance_block(self, block_in: np.ndarray) -> np.ndarray | None:
        try:
            import torch
            from df.enhance import enhance

            block_48k = block_in
            if self._input_sr != _DF_SR:
                n_up = len(block_in) * self._up_factor // self._down_factor
                x_48k = np.arange(n_up, dtype=np.float64) * self._down_factor / self._up_factor
                block_48k = np.interp(x_48k, np.arange(len(block_in)), block_in).astype(np.float32)

            audio_tensor = torch.from_numpy(block_48k).unsqueeze(0)
            enhanced_tensor = enhance(self._model, self._df_state, audio_tensor)
            enhanced_48k = enhanced_tensor.squeeze(0).cpu().numpy().astype(np.float32)

            if self._input_sr != _DF_SR:
                enhanced_in = enhanced_48k[:: self._up_factor // self._down_factor]
                target_len = len(block_in)
                if len(enhanced_in) > target_len:
                    enhanced_in = enhanced_in[:target_len]
                elif len(enhanced_in) < target_len:
                    enhanced_in = np.pad(enhanced_in, (0, target_len - len(enhanced_in)))
                return cast(np.ndarray, enhanced_in)
            return cast(np.ndarray, enhanced_48k)
        except Exception:
            logger.warning("DeepFilterNet3 enhance() failed, passing through", exc_info=True)
            return None

    def reset(self) -> None:
        """Clear buffers (model/state are reusable — no reload needed)."""
        self._pending_in = _EMPTY_F32.copy()
        self._output_queue = _EMPTY_F32.copy()

    @property
    def is_available(self) -> bool:
        """Whether DeepFilterNet3 is initialized and available."""
        return self._available
