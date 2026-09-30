"""Request builders shared by the tests and the fakes (import-cycle-free: no app import)."""

from __future__ import annotations

import io
import wave

import numpy as np

TENANT_ID = "50000000-0000-0000-0000-000000000000"
SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000"
SAMPLE_RATE = 16_000

#: Pass as an override value to REMOVE that key from the payload ("missing", not null).
DROP = object()

#: Overrides that land on `engine`; every other override lands on the spec itself.
_ENGINE_KEYS = frozenset({"vramGiB", "maxNumSeqs", "enforceEager"})

#: The default slug and runtime key of :func:`serving_spec_payload`.
SLUG = "arcaai-whisper-large-ml-en-vllm"
RUNTIME_KEY = "model-0001:v1"


def serving_spec_payload(**overrides: object) -> dict[str, object]:
    """A `ResolvedServingSpec` as the gateway emits it (camelCase, C-1) — every key present.

    ``vramGiB`` / ``maxNumSeqs`` / ``enforceEager`` overrides land on ``engine``; every other
    override lands on the spec; ``DROP`` removes a key.
    """
    engine: dict[str, object] = {"vramGiB": 3, "maxNumSeqs": 64, "enforceEager": None}
    payload: dict[str, object] = {
        "slug": SLUG,
        "kind": "asr",
        "runtimeKey": RUNTIME_KEY,
        "tenantId": SYSTEM_TENANT_ID,
        "localPath": "/mnt/models-bucket/hf/whisper-turbo-ml-en-fp16",
        "sourceUri": "taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16",
        "sourceRevision": "main",
        "checksum": None,
        "format": "SAFETENSOR",
        "computeType": "float16",
        "quantization": None,
        "maxModelLen": None,
        "engine": engine,
    }
    for key, value in overrides.items():
        target = engine if key in _ENGINE_KEYS else payload
        if value is DROP:
            target.pop(key, None)
        else:
            target[key] = value
    return payload


def wav_bytes(
    seconds: float,
    *,
    rate: int = SAMPLE_RATE,
    channels: int = 1,
    sampwidth: int = 2,
    amplitude: float = 0.3,
    freq_hz: float = 220.0,
) -> bytes:
    """A WAV file of a tone — the OpenAI route's `file`."""
    n = int(round(seconds * rate))
    t = np.arange(n, dtype=np.float64) / rate
    tone = amplitude * np.sin(2 * np.pi * freq_hz * t)
    if sampwidth == 2:
        frames = (tone * 32767).astype("<i2")
    elif sampwidth == 1:
        frames = ((tone + 1.0) * 127.5).astype("u1")
    else:
        frames = (tone * 2147483647).astype("<i4")
    if channels > 1:
        frames = np.repeat(frames, channels)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(sampwidth)
        out.setframerate(rate)
        out.writeframes(frames.tobytes())
    return buffer.getvalue()
