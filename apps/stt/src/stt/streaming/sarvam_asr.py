"""Sarvam AI speech-to-text — per-utterance / whole-audio REST recognition.

TASK-567. An async helper that transcribes one audio buffer (a VAD-segmented
utterance in streaming, or a whole file in batch) via Sarvam's REST
speech-to-text endpoint. Plain ``httpx`` — no vendor SDK. The caller awaits it
directly (unlike the Azure SDK, which needs ``asyncio.to_thread``).
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
import numpy as np

from stt.models.cloud_asr import (
    CloudRestConfig,
    raise_for_cloud_status,
    raise_for_cloud_transport,
    wav_bytes_from_samples,
)

logger = logging.getLogger(__name__)

# Generous per-request timeout — clinical utterances are short, but a whole-file
# batch call over a slow link should not hang the worker indefinitely.
_TIMEOUT_S = 120.0


_SARVAM_LANGUAGE_ALIASES = {
    "as": "as-IN",
    "bn": "bn-IN",
    "brx": "brx-IN",
    "doi": "doi-IN",
    "en": "en-IN",
    "gu": "gu-IN",
    "hi": "hi-IN",
    "kn": "kn-IN",
    "kok": "kok-IN",
    "ks": "ks-IN",
    "mai": "mai-IN",
    "ml": "ml-IN",
    "mni": "mni-IN",
    "mr": "mr-IN",
    "ne": "ne-IN",
    "od": "od-IN",
    "pa": "pa-IN",
    "sa": "sa-IN",
    "sat": "sat-IN",
    "sd": "sd-IN",
    "ta": "ta-IN",
    "te": "te-IN",
    "ur": "ur-IN",
}


def _normalize_language_for_sarvam(language: str | None) -> str | None:
    normalized = language.strip() if language else None
    if not normalized:
        return None
    primary = normalized.split("-", 1)[0].lower()
    return _SARVAM_LANGUAGE_ALIASES.get(primary, normalized)


async def sarvam_recognize_utterance(
    config: CloudRestConfig,
    samples: np.ndarray,
    sample_rate: int,
    language: str | None = None,
) -> dict[str, Any]:
    """Transcribe ``samples`` via Sarvam speech-to-text REST.

    Returns ``{"text": str, "word_timestamps": list[dict]}``.

    Raises:
        CloudASRAuthError: 401/403.
        CloudASRQuotaError: 429.
        CloudASRTranscriptionError: any other HTTP or transport error.
    """
    wav = wav_bytes_from_samples(samples, sample_rate)

    data: dict[str, str] = {"model": config.model_name}
    lang = _normalize_language_for_sarvam(language or config.language_default)
    if lang:
        data["language_code"] = lang

    files = {"file": ("audio.wav", wav, "audio/wav")}
    headers = {"api-subscription-key": config.api_key.get_secret_value()}
    url = config.base_url.rstrip("/") + "/speech-to-text"

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            response = await client.post(url, data=data, files=files, headers=headers)
        if response.status_code >= 400:
            raise_for_cloud_status("sarvam", response.status_code, response.text[:500])
        payload = response.json()
    except httpx.HTTPStatusError as exc:  # defensive — status checked above
        raise_for_cloud_status("sarvam", exc.response.status_code, exc.response.text[:500])
    except httpx.RequestError as exc:
        raise_for_cloud_transport("sarvam", type(exc).__name__)

    text = (payload.get("transcript") or payload.get("text") or "").strip()
    return {"text": text, "word_timestamps": []}
