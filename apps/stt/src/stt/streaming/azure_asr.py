"""Azure Speech SDK utterance-level recognition for streaming ASR.

Provides a synchronous helper that recognises a single VAD-segmented
utterance via Azure's ``SpeechRecognizer.recognize_once_async()``.
The caller (``SessionManager._make_asr_callable``) wraps this in
``asyncio.to_thread`` so the event loop is never blocked.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import azure.cognitiveservices.speech as speechsdk
import numpy as np

from stt.core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
)

logger = logging.getLogger(__name__)


def azure_recognize_utterance(
    speech_config: Any,
    samples: np.ndarray,
    sample_rate: int,
    language: str,
    code_switching: bool = False,
) -> dict[str, Any]:
    """Recognise a single utterance using Azure Speech SDK.

    This is a **synchronous** function — it blocks until Azure returns.
    Intended to be called via ``asyncio.to_thread``.

    Args:
        speech_config: A ``SpeechConfig`` instance (from ``AzureSpeechLoader``).
        samples: Float32 numpy array normalised to [-1, 1].
        sample_rate: Sample rate of *samples*.
        language: BCP-47 language tag (e.g. ``"en-US"``).
        code_switching: If ``True``, use ``AutoDetectSourceLanguageConfig``.

    Returns:
        ``{"text": str, "word_timestamps": list[dict]}``

    Raises:
        CloudASRAuthError: Invalid credentials.
        CloudASRQuotaError: Rate-limited / quota exceeded.
        CloudASRTranscriptionError: Any other Azure error.
    """

    # ---- Convert float32 numpy → 16-bit PCM bytes -------------------
    pcm_int16 = (samples * 32767).clip(-32768, 32767).astype(np.int16)
    pcm_bytes = pcm_int16.tobytes()

    # ---- Set up push audio stream ------------------------------------
    audio_format = speechsdk.audio.AudioStreamFormat(
        samples_per_second=sample_rate,
        bits_per_sample=16,
        channels=1,
    )
    push_stream = speechsdk.audio.PushAudioInputStream(stream_format=audio_format)
    push_stream.write(pcm_bytes)
    push_stream.close()

    audio_config = speechsdk.audio.AudioConfig(stream=push_stream)

    # ---- Configure recognizer ----------------------------------------
    if code_switching:
        auto_detect_config = speechsdk.languageconfig.AutoDetectSourceLanguageConfig()
        recognizer = speechsdk.SpeechRecognizer(
            speech_config=speech_config,
            audio_config=audio_config,
            auto_detect_source_language_config=auto_detect_config,
        )
        logger.debug("Azure streaming: using AutoDetectSourceLanguageConfig")
    else:
        speech_config.speech_recognition_language = language
        recognizer = speechsdk.SpeechRecognizer(
            speech_config=speech_config,
            audio_config=audio_config,
        )

    # ---- Run recognition (blocking) ----------------------------------
    result = recognizer.recognize_once_async().get()

    # ---- Handle result -----------------------------------------------
    if result.reason == speechsdk.ResultReason.RecognizedSpeech:
        word_timestamps = _extract_word_timestamps(result)
        return {"text": result.text, "word_timestamps": word_timestamps}

    if result.reason == speechsdk.ResultReason.NoMatch:
        return {"text": "", "word_timestamps": []}

    if result.reason == speechsdk.ResultReason.Canceled:
        cancellation = result.cancellation_details
        _raise_for_cancellation(cancellation)

    # Unexpected reason — treat as error
    raise CloudASRTranscriptionError(
        f"Unexpected Azure result reason: {result.reason}",
    )


def _extract_word_timestamps(result: Any) -> list[dict[str, Any]]:
    """Parse word-level timestamps from the Azure result JSON payload."""
    try:
        json_str = getattr(result, "json", None) or ""
        if not json_str:
            return []
        parsed = json.loads(json_str)
        nbest = parsed.get("NBest", [])
        if not nbest:
            return []
        words = nbest[0].get("Words", [])
        return [
            {
                "word": w.get("Word", ""),
                "start": w.get("Offset", 0) / 10_000_000,
                "end": (w.get("Offset", 0) + w.get("Duration", 0)) / 10_000_000,
                "confidence": w.get("Confidence", 1.0),
            }
            for w in words
        ]
    except Exception:
        logger.debug("Failed to parse Azure word timestamps", exc_info=True)
        return []


def _raise_for_cancellation(cancellation: Any) -> None:
    """Map Azure cancellation details to the appropriate exception."""
    error_details = getattr(cancellation, "error_details", "") or ""
    reason_str = str(getattr(cancellation, "reason", ""))

    if "401" in error_details or "Unauthorized" in error_details:
        raise CloudASRAuthError(f"Azure auth error: {error_details}")
    if "429" in error_details or "throttl" in error_details.lower():
        raise CloudASRQuotaError(f"Azure quota error: {error_details}")

    raise CloudASRTranscriptionError(
        f"Azure recognition canceled ({reason_str}): {error_details}",
    )
