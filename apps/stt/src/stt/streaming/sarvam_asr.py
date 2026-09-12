"""Sarvam AI speech-to-text — per-utterance / whole-audio REST recognition.

An async helper that transcribes one audio buffer (a VAD-segmented
utterance in streaming, or a whole file in batch) via Sarvam's REST
speech-to-text endpoint. Plain ``httpx`` — no vendor SDK. The caller awaits it
directly (unlike the Azure SDK, which needs ``asyncio.to_thread``).
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
import numpy as np

from stt.core.metering import BYTE_SOURCE_WIRE
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
    *,
    code_switching: bool = False,
) -> dict[str, Any]:
    """Transcribe ``samples`` via Sarvam speech-to-text REST.

    Returns ``{"text": str, "word_timestamps": list[dict]}`` plus the TASK-959
    network counters: ``request_bytes`` (the WAV we posted), ``response_bytes``
    (the body we read) and ``byte_source: "wire"`` — real HTTP, not a proxy.
    They ride the SUCCESS return only, so a failed attempt reports nothing
    (TASK-959 §6.2, a stated blind spot).

    Args:
        code_switching: When ``True`` (a bilingual "X + English" mode), request
            Sarvam's automatic language detection by sending
            ``language_code="unknown"`` instead of a pinned language. Saaras then
            detects language switches within the utterance and transcribes the
            code-mixed audio natively; pinning a single language would suppress
            the other one.

    Raises:
        CloudASRAuthError: 401/403.
        CloudASRQuotaError: 429.
        CloudASRTranscriptionError: any other HTTP or transport error.
    """
    wav = wav_bytes_from_samples(samples, sample_rate)

    data: dict[str, str] = {"model": config.model_name}
    lang = _normalize_language_for_sarvam(language or config.language_default)
    if code_switching:
        # Sarvam Saaras code-switch (code-mixed audio, e.g. Malayalam + English):
        #   * mode="codemix" — Saaras' dedicated code-switch output mode: emit
        #     natural code-mixed text (English words in Latin script, Indic words
        #     in native script) instead of forcing everything into one script.
        #   * language_code — pin the pipeline's primary language, normalized to
        #     Sarvam's BCP-47 form (a "ml" / "ml-*" pipeline -> "ml-IN"), so the
        #     model anchors on it; fall back to "unknown" (auto-detect) only when
        #     the pipeline carried no language at all.
        data["mode"] = "codemix"
        data["language_code"] = lang or "unknown"
    elif lang:
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
    # Sarvam's saaras STT echoes the detected source language (e.g. ``ml-IN``)
    # in ``language_code`` — surface it so the per-utterance detected language
    # flows to the transcript metadata instead of an echo of the requested mode.
    detected_language = payload.get("language_code") or None
    return {
        "text": text,
        "word_timestamps": [],
        "language": detected_language,
        "request_bytes": len(wav),
        "response_bytes": len(response.content),
        "byte_source": BYTE_SOURCE_WIRE,
    }
