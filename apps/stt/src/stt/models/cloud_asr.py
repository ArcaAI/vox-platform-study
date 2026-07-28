"""Shared primitives for cloud BYOK speech engines (Sarvam, OpenAI).

TASK-567. These cloud engines transcribe over plain REST (``httpx``) with a
per-tenant or platform-env API key. Unlike the local loaders they download no
weights; the loader validates the key and returns a lightweight
``CloudRestConfig`` held in ``LoadedModel.model``.

Security invariant: the API key is wrapped in ``SecretStr`` and this module
never formats it into a log line, exception message, or ``repr``. Keep it that
way — ``tests/unit/models/test_sarvam_loader.py`` / ``test_openai_loader.py``
assert the key is absent from repr and logs.
"""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from pydantic import SecretStr

from ..core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
)
from ..core.metrics import STT_CLOUD_ASR_ERRORS_TOTAL


@dataclass(frozen=True)
class CloudRestConfig:
    """Resolved connection config for a cloud REST speech engine.

    Held in ``LoadedModel.model``. Immutable; the key lives only here, in
    memory, wrapped in ``SecretStr``.
    """

    provider: str  # "sarvam" | "openai"
    api_key: SecretStr
    base_url: str
    model_name: str
    language_default: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def __repr__(self) -> str:  # never leak the key
        return (
            f"CloudRestConfig(provider={self.provider!r}, "
            f"base_url={self.base_url!r}, model_name={self.model_name!r}, "
            f"language_default={self.language_default!r}, has_key=True)"
        )


def resolve_override_key(
    provider_overrides: dict[str, Any] | None,
    provider_key: str,
) -> dict[str, Any] | None:
    """Return the per-tenant override entry for ``provider_key`` if present.

    ``provider_overrides`` follows the gateway wire shape
    ``{provider: {api_key, base_url?, endpoint?, region?, model?}}``. Returns
    ``None`` when no (non-empty) override is configured for the provider, so the
    caller falls back to env credentials.
    """
    if not provider_overrides:
        return None
    entry = provider_overrides.get(provider_key)
    if not entry or not isinstance(entry, dict):
        return None
    return entry


def wav_bytes_from_samples(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode float32 [-1, 1] mono samples as 16-bit PCM WAV bytes."""
    pcm_int16 = (np.asarray(samples, dtype=np.float32) * 32767).clip(-32768, 32767).astype(
        np.int16
    )
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_int16.tobytes())
    buffer.seek(0)
    return buffer.read()


def raise_for_cloud_status(provider: str, status_code: int, detail: str) -> None:
    """Map an HTTP status to the CloudASR* taxonomy and count it.

    401/403 -> auth (non-retryable), 429 -> quota (retryable),
    anything else >= 400 -> transcription (retryable). Emits
    ``stt_cloud_asr_errors_total{provider, class}`` before raising. ``detail``
    is provider text and MUST NOT contain key material (callers pass response
    bodies / status text only, never the key).
    """
    if status_code in (401, 403):
        STT_CLOUD_ASR_ERRORS_TOTAL.labels(provider=provider, **{"class": "auth"}).inc()
        raise CloudASRAuthError(f"{provider} auth error (HTTP {status_code}): {detail}")
    if status_code == 429:
        STT_CLOUD_ASR_ERRORS_TOTAL.labels(provider=provider, **{"class": "quota"}).inc()
        raise CloudASRQuotaError(f"{provider} quota error (HTTP {status_code}): {detail}")
    STT_CLOUD_ASR_ERRORS_TOTAL.labels(
        provider=provider, **{"class": "transcription"}
    ).inc()
    raise CloudASRTranscriptionError(
        f"{provider} transcription error (HTTP {status_code}): {detail}"
    )


def raise_for_cloud_transport(provider: str, detail: str) -> None:
    """Map a transport-level failure (timeout, connection error) to a
    retryable ``CloudASRTranscriptionError`` and count it."""
    STT_CLOUD_ASR_ERRORS_TOTAL.labels(
        provider=provider, **{"class": "transcription"}
    ).inc()
    raise CloudASRTranscriptionError(f"{provider} transport error: {detail}")
