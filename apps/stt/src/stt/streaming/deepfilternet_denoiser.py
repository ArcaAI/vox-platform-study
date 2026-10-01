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
from pathlib import Path
from typing import Any, cast

import numpy as np

from .denoise_report import DegradeReason, DenoiseDegraded, report_denoise_degraded

logger = logging.getLogger(__name__)

_DF_SR = 48000
_BLOCK_SECONDS = 1.0
_EMPTY_F32 = np.empty(0, dtype=np.float32)


def _missing_weights(model_dir: str | None) -> str:
    """What is missing from a DeepFilterNet3 weights directory, or ``""`` when complete."""
    if not model_dir:
        return "no weights directory bound (the deepfilternet3 model row is not published)"
    base = Path(model_dir)
    if not (base / "config.ini").is_file():
        return f"{base}/config.ini not found"
    checkpoints = base / "checkpoints"
    if not checkpoints.is_dir() or not any(checkpoints.iterdir()):
        return f"{base}/checkpoints/ has no checkpoint"
    return ""


class DeepFilterNet3StreamingDenoiser:
    """Block-processing DeepFilterNet3 session for streaming noise suppression.

    Parameters
    ----------
    input_sr:
        Input sample rate in Hz (typically 16000).
    strength:
        Blend factor between original (0.0) and denoised (1.0).
    """

    def __init__(
        self, input_sr: int = 16000, strength: float = 1.0, model_dir: str | None = None
    ) -> None:
        self._input_sr = input_sr
        self._strength = max(0.0, min(1.0, strength))
        # TASK-1030 (OD-3) — the bound `deepfilternet3` row's weights directory in the
        # models bucket (`models.denoise.local_path`): `config.ini` + `checkpoints/`.
        self._model_dir = model_dir
        self._model: Any = None
        self._df_state: Any = None
        self._available = False
        self._degraded: DenoiseDegraded | None = None
        self._enhance_failure_reported = False

        g = gcd(_DF_SR, input_sr)
        self._up_factor = _DF_SR // g
        self._down_factor = input_sr // g
        self._block_samples_in = int(_BLOCK_SECONDS * input_sr)

        self._pending_in: np.ndarray = _EMPTY_F32.copy()
        self._output_queue: np.ndarray = _EMPTY_F32.copy()

    def initialize(self) -> bool:
        """Load DeepFilterNet3 from the bound weights directory. NEVER raises.

        TASK-1030 (owner decision OD-2, reversing TASK-860 R-5): an engine that
        cannot run must not break the ASR task. Every failure — package absent,
        no weights directory, a directory without the checkpoint, a checkpoint
        that fails to load — returns ``False`` with ``degraded`` set and the
        degrade REPORTED; the caller runs the session without denoise.

        ``df``'s own downloader is never reached: without ``model_dir`` the load
        is refused rather than letting ``init_df`` fetch from GitHub at session
        time.
        """
        try:
            from df.enhance import init_df
        except ImportError:
            return self._degrade("package_missing", "the `deepfilternet` package is not installed")

        missing = _missing_weights(self._model_dir)
        if missing:
            return self._degrade("weights_unavailable", missing)

        try:
            # 0.5.6 returns (DfNet, DF, suffix) — THREE values. `log_level="NONE"` skips
            # df's logger setup, which shells out to `git` (absent from the runtime image,
            # where it raised FileNotFoundError); `log_file=None` keeps it from writing
            # `enhance.log` into the read-only bucket dir.
            loaded = init_df(model_base_dir=self._model_dir, log_level="NONE", log_file=None)
            self._model, self._df_state = loaded[0], loaded[1]
        except Exception as exc:  # noqa: BLE001 — any load failure degrades, never raises
            return self._degrade("init_failed", f"checkpoint failed to load: {exc}")
        self._available = True
        logger.info("DeepFilterNet3StreamingDenoiser initialized from %s", self._model_dir)
        return True

    def _degrade(self, reason: DegradeReason, detail: str) -> bool:
        self._available = False
        self._model = None
        self._degraded = report_denoise_degraded("deepfilternet3", reason, detail)
        return False

    @property
    def degraded(self) -> DenoiseDegraded | None:
        """Why this engine is not running (``None`` when it initialised)."""
        return self._degraded

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
        except Exception as exc:  # noqa: BLE001 — a failed block passes through, never raises
            if not self._enhance_failure_reported:
                self._enhance_failure_reported = True
                self._degraded = report_denoise_degraded(
                    "deepfilternet3", "enhance_failed", f"enhance() raised: {exc}"
                )
            return None

    def reset(self) -> None:
        """Clear buffers (model/state are reusable — no reload needed)."""
        self._pending_in = _EMPTY_F32.copy()
        self._output_queue = _EMPTY_F32.copy()

    @property
    def is_available(self) -> bool:
        """Whether DeepFilterNet3 is initialized and available."""
        return self._available
