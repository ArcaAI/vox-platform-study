"""OpenAI speech-to-text — per-utterance / whole-audio REST recognition.

TASK-567. Mirrors :mod:`stt.streaming.sarvam_asr`. Transcribes one audio buffer
via OpenAI's ``POST {base_url}/audio/transcriptions`` REST endpoint (per plan
§3.5: per-utterance REST in v1; realtime WS is a fast-follow). Plain ``httpx``,
no vendor SDK; ``base_url`` supports Azure-OpenAI-compatible endpoints.
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

_TIMEOUT_S = 120.0


async def openai_recognize_utterance(
    config: CloudRestConfig,
    samples: np.ndarray,
    sample_rate: int,
    language: str | None = None,
) -> dict[str, Any]:
    """Transcribe ``samples`` via OpenAI speech-to-text REST.

    Returns ``{"text": str, "word_timestamps": list[dict]}``.

    Raises:
        CloudASRAuthError: 401/403.
        CloudASRQuotaError: 429.
        CloudASRTranscriptionError: any other HTTP or transport error.
    """
    wav = wav_bytes_from_samples(samples, sample_rate)

    data: dict[str, str] = {"model": config.model_name}
    lang = language or config.language_default
    if lang:
        # OpenAI expects an ISO-639-1 primary tag (e.g. "en", not "en-US").
        data["language"] = lang.split("-")[0]

    files = {"file": ("audio.wav", wav, "audio/wav")}
    headers = {"Authorization": f"Bearer {config.api_key.get_secret_value()}"}
    url = config.base_url.rstrip("/") + "/audio/transcriptions"

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            response = await client.post(url, data=data, files=files, headers=headers)
        if response.status_code >= 400:
            raise_for_cloud_status("openai", response.status_code, response.text[:500])
        payload = response.json()
    except httpx.HTTPStatusError as exc:  # defensive — status checked above
        raise_for_cloud_status("openai", exc.response.status_code, exc.response.text[:500])
    except httpx.RequestError as exc:
        raise_for_cloud_transport("openai", type(exc).__name__)

    text = (payload.get("text") or "").strip()
    # OpenAI returns ``language`` only on verbose_json responses; carry it through
    # when present (``None`` for the default json format) so a detected language
    # reaches the transcript metadata rather than an echo of the requested mode.
    detected_language = payload.get("language") or None
    return {"text": text, "word_timestamps": [], "language": detected_language}
