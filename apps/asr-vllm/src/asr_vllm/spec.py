"""The resolved spec a caller sends with every request — the gateway's ``ResolvedAsrSpec``.

This service never chooses a model. The gateway resolves the tenant's ASR **Agent** to
registry rows and builds a ``ResolvedAsrSpec`` (``packages/types/src/asr-spec.ts``, one
producer: ``buildResolvedAsrSpec``); STT holds it per session and forwards it with each
window, unchanged and in its camelCase wire form. There is no model slug, engine or
pipeline selector anywhere in this API — the spec IS the selection, and only a gateway
resolver can build one from registered rows.

WHAT IS PARSED — the slice this service acts on, strictly:

* ``runtimeKey`` — the ASR Agent version id; the engine's identity in this process;
* ``models.asr`` — the registry row to serve: ``slug``, ``format`` (must be
  ``SAFETENSOR``), ``tenantId`` (the row's OWNER — whose registry credential funds a
  pull), ``checksum``, ``sourceUri``, ``sourceRevision``, ``localPath``, ``computeType``,
  and the two OPTIONAL vLLM serving facts ``quantization`` / ``maxModelLen``
  (``AiModel._metadata.asr``, carried on the spec model since TASK-1010 phase B).

The registry identity — ``runtimeKey``, ``models.asr.tenantId`` and the
``models.asr.checksum`` KEY (``null`` = the row declares none) — must be present: a body
without it did not come from the resolver (422).

WHAT IS IGNORED, AND WHY (``extra='ignore'``): every other block — ``agent``,
``audioFrontEnd``, ``decoding``, ``streaming``, ``fallback``, the other model roles, keys
not invented yet. The shared spec EVOLVES, and ``apps/stt/src/stt/pipeline/spec.py`` is
its strict (``extra='forbid'``) mirror, pinned to the committed parity fixture. Mirroring
it strictly a second time here would make every unrelated contract change a 422 on the
decode tier; parsing only the slice lets the two ship in either order. Consequence worth
knowing: equality (the pool's runtime-key drift check) compares the slice only.

``format`` fails CLOSED: vLLM's Whisper runs HF safetensors checkpoints only, so a GGUF
(``WHISPER_CPP``) or CTranslate2 (``FASTER_WHISPER``) row is refused at validation.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

#: `AiModelAsrProfile.quantization` (lane L1). ``none`` = the checkpoint's own precision.
Quantization = Literal["none", "fp8", "awq", "gptq", "int8"]

_CONFIG = ConfigDict(
    alias_generator=to_camel,
    populate_by_name=True,
    extra="ignore",
    frozen=True,
)


class AsrModelSlice(BaseModel):
    """``models.asr`` — the one registry row this engine serves."""

    model_config = _CONFIG

    slug: str = Field(min_length=1)
    format: Literal["SAFETENSOR"]
    #: The tenant that OWNS the row (SYSTEM for the platform catalogue).
    tenant_id: str = Field(min_length=1)
    #: SHA256 of the published primary weights object. Required KEY, nullable value.
    checksum: str | None
    source_uri: str
    source_revision: str | None
    local_path: str | None
    #: ``AiModel.computeType``; ``None`` = the row expressed no opinion → vLLM ``auto``.
    compute_type: Literal["float16", "bfloat16", "float32"] | None
    #: vLLM quantization; absent / ``None`` / ``none`` = the checkpoint's own precision.
    quantization: Quantization | None = None
    #: vLLM ``max_model_len``; absent = derived from the checkpoint (448 for Whisper).
    max_model_len: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _needs_somewhere_to_load_from(self) -> AsrModelSlice:
        if not (self.local_path or self.source_uri.strip()):
            raise ValueError("model names neither localPath nor sourceUri — nothing to load")
        return self


class _Models(BaseModel):
    model_config = _CONFIG

    asr: AsrModelSlice


class ResolvedVllmAsrSpec(BaseModel):
    """The ``ResolvedAsrSpec`` (or a fallback-chain ``AsrSpecCore``) — its vLLM slice."""

    model_config = _CONFIG

    runtime_key: str = Field(min_length=1)
    models: _Models

    @property
    def model(self) -> AsrModelSlice:
        """The ASR row this engine serves."""
        return self.models.asr
