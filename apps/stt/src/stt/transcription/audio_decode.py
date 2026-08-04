"""Tolerant audio decoding for uploaded files.

Uploaded audio is not guaranteed to be clean. Phone recorders in particular
append vendor metadata after the last audio frame — an OPPO/ColorOS recording
carries an ``oppoMark//oppoMark`` trailer (ASCII waveform peaks plus binary
marker blocks). libsndfile's mpg123 backend parses such a trailer as audio,
fails to resync, and raises ``LibsndfileError: Unspecified internal error``,
which failed batch jobs whose audio was entirely intact.

Two stages, in order:

1. **libsndfile** (``soundfile``) — fast, in-process, bit-exact. Handles
   WAV/FLAC/OGG and well-formed MP3.
2. **ffmpeg** — error-resilient and far wider format coverage (m4a/aac/opus,
   damaged or trailing-garbage streams). ffmpeg is provisioned in both the
   conda dev env (``scripts/setup-python-env.sh``) and the service images
   (``apps/stt/docker/Dockerfile``).

Anything neither stage can read raises :class:`AudioCorruptedError`, which is
in ``NON_RETRYABLE_EXCEPTIONS`` — a file that cannot decode will never decode
on a retry, so the job fails once instead of four times.
"""

import io
import logging
import shutil
import subprocess
from typing import cast

import numpy as np

from ..core.exceptions import AudioCorruptedError

logger = logging.getLogger(__name__)

# Generous ceiling: ffmpeg decodes at hundreds of times realtime, so even the
# longest permitted upload finishes in seconds. This only bounds a hung child.
FFMPEG_TIMEOUT_SECONDS = 300

# Shown to the user. Decoder-specific wording ("Unspecified internal error")
# stays in ``details`` — it means nothing to whoever uploaded the file.
_USER_MESSAGE = "Audio file could not be decoded. The format is unsupported or the file is damaged."


def decode_audio(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode uploaded audio to float32 samples.

    Args:
        audio_bytes: Raw bytes of the uploaded file.

    Returns:
        Tuple of (samples, sample_rate). Samples are float32 at the file's
        native rate; multi-channel files keep their ``(frames, channels)``
        shape — downmixing is the caller's decision.

    Raises:
        AudioCorruptedError: The bytes are empty, or no decoder could read them.
    """
    if not audio_bytes:
        raise AudioCorruptedError(_USER_MESSAGE, details={"reason": "empty file"})

    try:
        samples, sample_rate = _decode_with_soundfile(audio_bytes)
    except Exception as sf_error:
        logger.info(
            "libsndfile could not decode the upload (%s: %s) — retrying with ffmpeg",
            type(sf_error).__name__,
            sf_error,
        )
        samples, sample_rate = _decode_with_ffmpeg(audio_bytes, soundfile_error=sf_error)

    if samples.size == 0:
        raise AudioCorruptedError(_USER_MESSAGE, details={"reason": "no audio frames decoded"})

    return samples.astype(np.float32, copy=False), sample_rate


def _decode_with_soundfile(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode via libsndfile. Raises on any read error."""
    import soundfile as sf

    samples, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32")
    return cast(np.ndarray, samples), int(sample_rate)


def _decode_with_ffmpeg(
    audio_bytes: bytes, soundfile_error: Exception | None = None
) -> tuple[np.ndarray, int]:
    """Decode via ffmpeg, emitting WAV so sample rate and layout survive.

    ffmpeg skips undecodable trailing bytes and still exits 0, which is exactly
    the behavior the vendor-trailer case needs.
    """
    details: dict[str, object] = {}
    if soundfile_error is not None:
        details["soundfile_error"] = f"{type(soundfile_error).__name__}: {soundfile_error}"

    if shutil.which("ffmpeg") is None:
        raise AudioCorruptedError(
            _USER_MESSAGE, details={**details, "reason": "ffmpeg is not installed"}
        ) from soundfile_error

    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                "pipe:0",
                "-map",
                "0:a:0",
                "-c:a",
                "pcm_f32le",
                "-f",
                "wav",
                "pipe:1",
            ],
            input=audio_bytes,
            capture_output=True,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise AudioCorruptedError(
            _USER_MESSAGE,
            details={**details, "reason": f"ffmpeg timed out after {FFMPEG_TIMEOUT_SECONDS}s"},
        ) from exc

    stderr = proc.stderr.decode("utf-8", errors="replace").strip()

    if proc.returncode != 0 or not proc.stdout:
        raise AudioCorruptedError(
            _USER_MESSAGE,
            details={
                **details,
                "reason": "ffmpeg could not decode the file",
                "stderr": stderr[-500:],
            },
        ) from soundfile_error

    try:
        samples, sample_rate = _decode_with_soundfile(proc.stdout)
    except Exception as exc:
        raise AudioCorruptedError(
            _USER_MESSAGE, details={**details, "reason": "ffmpeg output was unreadable"}
        ) from exc

    if stderr:
        # Recovered: ffmpeg reported damage but produced audio. Worth a record —
        # this is the signal that an upload carried a trailer or a bad frame.
        logger.warning(
            "Audio decoded by ffmpeg after libsndfile failed; "
            "input reported errors (%.1fs recovered): %s",
            len(samples) / sample_rate if sample_rate else 0.0,
            stderr[-300:],
        )
    else:
        logger.info("Audio decoded by ffmpeg fallback (%.1fs)", len(samples) / sample_rate)

    return samples, sample_rate
