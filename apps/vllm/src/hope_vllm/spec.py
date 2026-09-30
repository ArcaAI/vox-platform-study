"""``ResolvedServingSpec`` — what the gateway resolves ``model=<slug>`` to (TASK-1021 C-1).

Pydantic mirror of ``packages/types/src/serving-spec.ts``. ONE producer: the gateway's
``GET /api/v1/internal/models/:slug/serving-spec`` (``buildResolvedServingSpec``), which
resolves the slug for the CALLING tenant — the tenant's own row first, then SYSTEM, never
another customer — and returns everything this process needs to BUILD an engine for that
``AiModel`` row. This service never chooses a model: a client names a slug, the gateway
decides which row that slug means for that tenant, and this spec IS that decision.

Both sides validate the SAME committed fixture
(``tests/contracts/resolved-serving-spec.fixture.json``), which is the cross-language lock.

STRICT, unlike the spike's ``ResolvedAsrSpec`` slice (which ignored unknown keys because STT
forwarded a shared, evolving spec): this contract has one producer and one consumer, so an
unknown key is DRIFT (or a leaked credential) and is refused, every key is required, and a
value is nullable exactly where the TS type says ``| null``.

* ``runtimeKey`` — ``<aiModel.id>:<checksum ?? v<version>>`` (D-13): the row, not the slug,
  is the engine's identity, so the same slug held by two tenants is two engines.
* ``tenantId`` — the row's OWNER (SYSTEM or the tenant): whose registry credential funds a
  pull (``core/model_credentials.py``), never assumed to be the caller.
* ``engine`` — sizing facts from ``AiModel._metadata.serving`` (D-11): GPU memory in GiB
  (never a fraction of the card), and the optional batch cap / eager flag.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

#: `AiModel.taskType` → what the served model does (`SERVING_KINDS`).
ServingKind = Literal["asr", "llm", "tts"]

#: `AiModelAsrProfile.quantization`. ``none`` = the checkpoint's own precision.
Quantization = Literal["none", "fp8", "awq", "gptq", "int8"]

_CONFIG = ConfigDict(
    alias_generator=to_camel,
    validate_by_name=True,
    validate_by_alias=True,
    extra="forbid",
    frozen=True,
)


class ResolvedServingEngine(BaseModel):
    """``engine`` — how big the engine is, from ``AiModel._metadata.serving``."""

    model_config = _CONFIG

    #: GPU memory the engine is sized to, in GiB. ``to_camel('vram_gib')`` would be
    #: ``vramGib``; the wire says ``vramGiB``, so the alias is explicit.
    vram_gib: float = Field(alias="vramGiB", gt=0)
    #: vLLM's running-batch cap; ``None`` = the service default.
    max_num_seqs: int | None = Field(ge=1)
    #: Skip CUDA-graph capture; ``None`` = off.
    enforce_eager: bool | None


class ResolvedServingSpec(BaseModel):
    """One servable ``AiModel`` row, resolved for the calling tenant."""

    model_config = _CONFIG

    slug: str = Field(min_length=1)
    kind: ServingKind
    runtime_key: str = Field(min_length=1)
    #: The tenant that OWNS the row (SYSTEM for the platform catalogue).
    tenant_id: str = Field(min_length=1)
    local_path: str | None
    source_uri: str
    source_revision: str | None
    #: SHA256 of the published primary weights object, or ``None`` (the row declares none).
    checksum: str | None
    #: vLLM runs HF safetensors checkpoints only; the gateway refuses every other format.
    format: Literal["SAFETENSOR"]
    #: → vLLM ``dtype``; ``None`` = ``auto``.
    compute_type: Literal["float16", "bfloat16", "float32"] | None
    #: → vLLM ``quantization``; ``None`` / ``none`` = the checkpoint's own precision.
    quantization: Quantization | None
    #: → vLLM ``max_model_len``; ``None`` = derived from the checkpoint (448 for Whisper).
    max_model_len: int | None = Field(ge=1)
    engine: ResolvedServingEngine
