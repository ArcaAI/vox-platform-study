"""Audio preprocessing for transcription.

Pipeline order:
    1. Load audio from bytes
    2. Convert to mono
    3. Normalize (if enabled)
    4. **Denoise** (if enabled) — RNNoise at 48 kHz; output stays at 48 kHz
    5. **Resample** to ``target_sample_rate`` (single final resample)
    6. **VAD** (if enabled) — detects speech segments on clean, resampled audio

The target resample is deferred until *after* denoising so that when
RNNoise is active the path is:

    original_sr → 48 kHz (for RNNoise) → target_sr   (2 resamples)

Instead of:

    original_sr → target_sr → 48 kHz → target_sr     (3 resamples)

When denoising is disabled the path remains the normal single resample:

    original_sr → target_sr                            (1 resample)

Denoising runs *before* VAD so that Voice Activity Detection operates on
cleaner audio, producing more accurate speech/silence boundaries.

Uses the pipeline-defined VAD model when available, falling back to the
dedicated Silero VAD v5 ONNX singleton service for backward compatibility.
"""

import io
import logging
from typing import Any

import numpy as np

from ..models.base_loader import LoadedModel
from ..pipeline.dto import PreprocessingConfig
from .dto import AudioSegment, ProcessedAudio

logger = logging.getLogger(__name__)

# RNNoise native sample rate — the library requires exactly 48 kHz
_RNNOISE_SAMPLE_RATE = 48_000


class AudioPreprocessor:
    """Preprocess audio before transcription."""

    async def process(
        self,
        audio_bytes: bytes,
        config: PreprocessingConfig,
        vad_model: LoadedModel | None = None,
        denoise_model: LoadedModel | None = None,
    ) -> ProcessedAudio:
        """
        Apply preprocessing pipeline.

        Steps (in order):
        1. Load audio from bytes
        2. Convert to mono
        3. Normalize (if enabled)
        4. **Denoise** (if enabled) — upsample to 48 kHz → RNNoise → output at 48 kHz
        5. **Resample** to ``target_sample_rate`` — single final resample
        6. **VAD** (if enabled — pipeline model first, Silero fallback)

        When denoise is enabled the resample path is::

            original_sr → 48 kHz (RNNoise) → target_sr   (2 resamples)

        When denoise is disabled::

            original_sr → target_sr                        (1 resample)

        Args:
            audio_bytes: Raw audio bytes
            config: Preprocessing configuration
            vad_model: Optional pipeline-defined VAD model (used first when available)
            denoise_model: Optional denoise model (kept for signature compat, not used
                internally — ``pyrnnoise`` is used directly)

        Returns:
            ProcessedAudio result
        """
        # Load audio
        samples, original_sr = self._load_audio(audio_bytes)
        current_sr = original_sr
        was_resampled = False
        was_normalized = False

        # Convert to mono if needed
        if len(samples.shape) > 1:
            samples = samples.mean(axis=1)

        # Normalize (before denoise — operates on original-rate audio)
        if config.normalize:
            samples = self._normalize(samples)
            was_normalized = True

        # ----- Denoise (operates at 48 kHz) -----
        # Resample is deferred so that `_apply_denoise` can go
        # original_sr → 48 kHz in a single step, and the final
        # resample to target_sr happens once afterward.
        denoise_applied = False
        if config.denoise.enabled:
            samples, current_sr = await self._apply_denoise(
                samples, current_sr, config.denoise.strength
            )
            denoise_applied = True

        # ----- Single final resample to target_sample_rate -----
        if current_sr != config.target_sample_rate:
            samples = self._resample(samples, current_sr, config.target_sample_rate)
            was_resampled = True

        # Calculate duration (must be after final resample)
        duration = len(samples) / config.target_sample_rate

        # ----- VAD (operates on clean, resampled audio) -----
        segments: list[AudioSegment] = []
        vad_applied = False
        if config.vad.enabled:
            segments, vad_applied = await self._apply_vad_smart(
                samples, config.target_sample_rate, config.vad, vad_model
            )

        return ProcessedAudio(
            samples=samples,
            sample_rate=config.target_sample_rate,
            duration_seconds=duration,
            segments=segments,
            was_resampled=was_resampled,
            was_normalized=was_normalized,
            vad_applied=vad_applied,
            denoise_applied=denoise_applied,
        )

    async def _apply_vad_smart(
        self,
        samples: np.ndarray,
        sample_rate: int,
        vad_config: Any,
        pipeline_model: LoadedModel | None,
    ) -> tuple[list[AudioSegment], bool]:
        """Use pipeline-defined VAD model first, fall back to Silero singleton.

        Priority order:
        1. Pipeline-defined VAD model (from YAML ``models.vad``)
        2. Silero VAD v5 ONNX singleton (always-loaded fallback)

        Returns:
            (segments, was_applied) tuple.
        """
        # Priority 1: Pipeline-defined VAD model
        if pipeline_model is not None:
            try:
                segments = await self._apply_vad(
                    samples, sample_rate, pipeline_model, vad_config.threshold
                )
                logger.debug(
                    "Pipeline VAD model: %d speech segments detected",
                    len(segments),
                )
                return segments, True
            except Exception as e:
                logger.warning(
                    "Pipeline VAD model failed: %s, falling back to Silero", e
                )

        # Priority 2: Silero VAD ONNX singleton (fallback)
        try:
            from ..vad.silero_service import get_vad_service

            vad_service = get_vad_service()
            if vad_service.is_loaded:
                result = vad_service.detect_speech(
                    samples=samples,
                    sample_rate=sample_rate,
                    threshold=vad_config.threshold,
                    min_speech_duration_ms=vad_config.min_speech_duration_ms,
                    min_silence_duration_ms=vad_config.min_silence_duration_ms,
                    speech_pad_ms=vad_config.padding_ms,
                )
                segments = [
                    AudioSegment(
                        start_time=s.start_time,
                        end_time=s.end_time,
                        is_speech=True,
                        confidence=s.probability,
                    )
                    for s in result.segments
                ]
                logger.debug(
                    "Silero VAD fallback: %d speech segments, %.1fs speech / %.1fs total",
                    len(segments),
                    result.speech_duration,
                    result.audio_duration,
                )
                return segments, True
        except Exception as e:
            logger.debug("Silero VAD service unavailable: %s", e)

        return [], False

    def _load_audio(self, audio_bytes: bytes) -> tuple[np.ndarray, int]:
        """
        Load audio from bytes.

        Args:
            audio_bytes: Raw audio bytes

        Returns:
            Tuple of (samples as numpy array, sample rate)
        """
        try:
            import soundfile as sf

            audio_io = io.BytesIO(audio_bytes)
            samples, sr = sf.read(audio_io)
            return samples.astype(np.float32), sr

        except ImportError:
            # Fallback to librosa
            import librosa

            audio_io = io.BytesIO(audio_bytes)
            samples, sr = librosa.load(audio_io, sr=None)
            return samples, sr

    def _resample(
        self, samples: np.ndarray, original_sr: int, target_sr: int
    ) -> np.ndarray:
        """Resample audio to target sample rate."""
        try:
            import librosa

            return librosa.resample(samples, orig_sr=original_sr, target_sr=target_sr)
        except ImportError:
            # Simple linear interpolation fallback
            ratio = target_sr / original_sr
            new_length = int(len(samples) * ratio)
            indices = np.linspace(0, len(samples) - 1, new_length)
            return np.interp(indices, np.arange(len(samples)), samples)

    def _normalize(self, samples: np.ndarray) -> np.ndarray:
        """Normalize audio to [-1, 1] range."""
        max_val = np.abs(samples).max()
        if max_val > 0:
            samples = samples / max_val
        return samples

    async def _apply_vad(
        self,
        samples: np.ndarray,
        sample_rate: int,
        vad_model: LoadedModel,
        threshold: float,
    ) -> list[AudioSegment]:
        """
        Apply Voice Activity Detection.

        Args:
            samples: Audio samples
            sample_rate: Sample rate
            vad_model: VAD model
            threshold: Speech detection threshold

        Returns:
            List of audio segments
        """
        try:
            import torch

            model = vad_model.model

            # Convert to tensor
            audio_tensor = torch.from_numpy(samples).float()

            # Silero VAD expects specific format
            if hasattr(model, "get_speech_timestamps"):
                # Silero VAD
                speech_timestamps = model.get_speech_timestamps(
                    audio_tensor,
                    model,
                    sampling_rate=sample_rate,
                    threshold=threshold,
                )

                segments = []
                for ts in speech_timestamps:
                    segments.append(
                        AudioSegment(
                            start_time=ts["start"] / sample_rate,
                            end_time=ts["end"] / sample_rate,
                            is_speech=True,
                        )
                    )
                return segments

            else:
                # Generic classification model
                # Process in chunks
                chunk_size = sample_rate  # 1 second chunks
                segments = []

                for i in range(0, len(samples), chunk_size):
                    chunk = samples[i : i + chunk_size]
                    if len(chunk) < chunk_size // 2:
                        continue

                    chunk_tensor = torch.from_numpy(chunk).float().unsqueeze(0)

                    with torch.no_grad():
                        outputs = model(chunk_tensor)
                        probs = torch.softmax(outputs.logits, dim=-1)
                        # Assuming class 1 is speech
                        speech_prob = probs[0, 1].item()

                    if speech_prob > threshold:
                        segments.append(
                            AudioSegment(
                                start_time=i / sample_rate,
                                end_time=(i + len(chunk)) / sample_rate,
                                is_speech=True,
                                confidence=speech_prob,
                            )
                        )

                return self._merge_segments(segments)

        except Exception as e:
            logger.warning(f"VAD processing failed: {e}, returning full audio as speech")
            return [
                AudioSegment(
                    start_time=0.0,
                    end_time=len(samples) / sample_rate,
                    is_speech=True,
                )
            ]

    async def _apply_denoise(
        self,
        samples: np.ndarray,
        sample_rate: int,
        strength: float,
    ) -> tuple[np.ndarray, int]:
        """Apply RNNoise noise suppression.

        RNNoise operates exclusively at 48 kHz with 480-sample frames (10 ms).
        This method:

        1. Upsamples from ``sample_rate`` → 48 kHz (single resample)
        2. Converts float32 [-1, 1] → int16 for ``pyrnnoise``
        3. Runs ``pyrnnoise.RNNoise.denoise_chunk()`` frame-by-frame
        4. Converts int16 → float32
        5. Blends denoised 48 kHz audio with upsampled original based on ``strength``

        The output stays at **48 kHz** — the caller is responsible for the
        single final resample down to ``target_sample_rate``.  This avoids
        an extra resample round-trip (48 k→16 k→48 k would be wasteful
        if we resampled to target *before* denoising).

        Args:
            samples: Float32 mono audio at ``sample_rate``.
            sample_rate: Current sample rate of the input.
            strength: Denoise strength 0.0 (bypass) to 1.0 (full denoise).

        Returns:
            Tuple of (denoised float32 audio, output sample rate).
            When denoising is applied the output sample rate is 48 000.
            When skipped (strength <= 0 or error) it equals the input ``sample_rate``.
        """
        if strength <= 0.0:
            return samples, sample_rate

        try:
            from pyrnnoise import RNNoise

            # Step 1: Upsample to 48 kHz (RNNoise requirement)
            if sample_rate != _RNNOISE_SAMPLE_RATE:
                samples_48k = self._resample(samples, sample_rate, _RNNOISE_SAMPLE_RATE)
            else:
                samples_48k = samples.copy()

            # Step 2: float32 [-1, 1] → int16 (pyrnnoise expects int16)
            int16_audio = (
                (samples_48k * 32767).clip(-32768, 32767).astype(np.int16)
            )
            # pyrnnoise expects shape [num_channels, num_samples] — mono = (1, N)
            int16_chunk = int16_audio.reshape(1, -1)

            # Step 3: Denoise frame-by-frame via pyrnnoise
            denoiser = RNNoise(sample_rate=_RNNOISE_SAMPLE_RATE)
            denoised_frames: list[np.ndarray] = []
            for _speech_prob, denoised_frame in denoiser.denoise_chunk(int16_chunk):
                denoised_frames.append(denoised_frame)

            if not denoised_frames:
                logger.warning("RNNoise produced no output frames — returning original")
                return samples, sample_rate

            # Step 4: Reassemble and convert back to float32
            denoised_int16 = np.concatenate(denoised_frames, axis=-1)
            # Flatten to 1-D mono (denoise_chunk may return [channels, frame_samples])
            denoised_int16 = denoised_int16.flatten()
            denoised_48k = denoised_int16.astype(np.float32) / 32767.0

            # Ensure same length as upsampled input
            if len(denoised_48k) > len(samples_48k):
                denoised_48k = denoised_48k[: len(samples_48k)]
            elif len(denoised_48k) < len(samples_48k):
                denoised_48k = np.pad(
                    denoised_48k, (0, len(samples_48k) - len(denoised_48k))
                )

            # Step 5: Blend with upsampled original based on strength
            if strength < 1.0:
                denoised_48k = (
                    strength * denoised_48k + (1.0 - strength) * samples_48k
                )

            logger.debug(
                "RNNoise denoising applied (strength=%.2f, frames=%d, "
                "input_sr=%d, output_sr=%d)",
                strength,
                len(denoised_frames),
                sample_rate,
                _RNNOISE_SAMPLE_RATE,
            )
            # Output stays at 48 kHz — caller does the final resample
            return denoised_48k.astype(np.float32), _RNNOISE_SAMPLE_RATE

        except ImportError:
            logger.warning(
                "pyrnnoise not installed — skipping denoising. "
                "Install with: pip install pyrnnoise"
            )
            return samples, sample_rate
        except Exception as e:
            logger.warning("RNNoise denoising failed: %s, returning original audio", e)
            return samples, sample_rate

    def _merge_segments(
        self, segments: list[AudioSegment], gap_threshold: float = 0.3
    ) -> list[AudioSegment]:
        """Merge adjacent speech segments with small gaps."""
        if not segments:
            return []

        merged = [segments[0]]
        for seg in segments[1:]:
            last = merged[-1]
            if seg.start_time - last.end_time <= gap_threshold:
                # Merge
                merged[-1] = AudioSegment(
                    start_time=last.start_time,
                    end_time=seg.end_time,
                    is_speech=True,
                    confidence=min(last.confidence, seg.confidence),
                )
            else:
                merged.append(seg)

        return merged


# Singleton instance
_preprocessor: AudioPreprocessor | None = None


def get_preprocessor() -> AudioPreprocessor:
    """Get singleton preprocessor instance."""
    global _preprocessor
    if _preprocessor is None:
        _preprocessor = AudioPreprocessor()
    return _preprocessor
