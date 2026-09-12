"""Shared primitives for cloud BYOK speech engines (Sarvam, OpenAI).

These cloud engines transcribe over plain REST (``httpx``) with a
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
    *,
    connection_key: str | None = None,
) -> dict[str, Any] | None:
    """Return the override entry that serves this call, or ``None``.

    ``provider_overrides`` follows the gateway wire shape
    ``{connection key: {api_key, base_url?, endpoint?, region?, model?, connection_id?}}``.

    TASK-958 — the map key is the CONNECTION KEY, which is a tenant connection's
    ``slug`` for a tenant row and the provider id for a platform row. ``connection_key``
    is read FIRST and ``provider_key`` second, and that ordering is the whole point: a
    tenant may hold two accounts of one vendor, and a provider-keyed read would hand
    both chains the same entry — so a fallback to the second connection would be served
    on the first connection's key.

    The second read is not a fallback for correctness but for COMPATIBILITY: a tenant's
    DEFAULT connection has ``slug == provider``, so the two reads coincide for it, and a
    gateway that stamps no ``connection_key`` at all keeps resolving exactly as before.

    Returns ``None`` when neither key holds a non-empty entry, so the caller fails
    closed on its own terms.
    """
    if not provider_overrides:
        return None
    keys = [connection_key, provider_key] if connection_key else [provider_key]
    for key in keys:
        entry = provider_overrides.get(key)
        if entry and isinstance(entry, dict):
            return entry
    return None


def wav_bytes_from_samples(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode float32 [-1, 1] mono samples as 16-bit PCM WAV bytes."""
    pcm_int16 = (np.asarray(samples, dtype=np.float32) * 32767).clip(-32768, 32767).astype(np.int16)
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
    STT_CLOUD_ASR_ERRORS_TOTAL.labels(provider=provider, **{"class": "transcription"}).inc()
    raise CloudASRTranscriptionError(
        f"{provider} transcription error (HTTP {status_code}): {detail}"
    )


def raise_for_cloud_transport(provider: str, detail: str) -> None:
    """Map a transport-level failure (timeout, connection error) to a
    retryable ``CloudASRTranscriptionError`` and count it."""
    STT_CLOUD_ASR_ERRORS_TOTAL.labels(provider=provider, **{"class": "transcription"}).inc()
    raise CloudASRTranscriptionError(f"{provider} transport error: {detail}")
