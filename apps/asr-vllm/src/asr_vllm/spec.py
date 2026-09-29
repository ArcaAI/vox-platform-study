"""The resolved model spec a caller sends with every request.

This service never chooses a model. The gateway resolves the tenant's ASR Agent to
concrete registry rows (``packages/types/src/asr-spec.ts``, mirrored for STT in
``apps/stt/src/stt/pipeline/spec.py``); STT — the only intended caller — forwards the
slice below with each decode window. Field names are the SAME camelCase wire names as
``AsrSpecModel`` / ``AsrSpecCore`` so STT can forward them without renaming:

* ``runtimeKey`` — ``AsrSpecCore.runtime_key`` (the ASR Agent version id), the engine's
  identity in this process;
* ``slug`` / ``format`` / ``libraryName`` / ``sourceUri`` / ``sourceRevision`` /
  ``localPath`` / ``computeType`` — ``AsrSpecModel`` members, unchanged;
* ``quantization`` / ``maxModelLen`` — NEW, vLLM-only engine shape. Not on the shared
  contract yet; adding them there is part of the STT-adapter follow-up (README).

``extra='forbid'`` makes an unknown key a contract drift rather than a silent drop, and
``format`` fails CLOSED: vLLM's Whisper runs HF safetensors checkpoints only, so a GGUF
(``WHISPER_CPP``) or CTranslate2 (``FASTER_WHISPER``) row is refused at validation, never
guessed at.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

#: The HF scheme prefix a registry row MAY carry on ``sourceUri``; vLLM wants a bare repo id.
_HF_PREFIXES = ("hf://", "huggingface://")


class ResolvedVllmAsrSpec(BaseModel):
    """One resolved Whisper checkpoint + the engine shape vLLM needs to serve it."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
    )

    runtime_key: str = Field(min_length=1)
    slug: str = Field(min_length=1)
    format: Literal["SAFETENSOR"]
    library_name: str | None = None
    source_uri: str
    source_revision: str | None = None
    local_path: str | None = None
    #: ``AiModel.computeType``; ``None`` = the row expressed no opinion → vLLM ``auto``.
    compute_type: Literal["float16", "bfloat16", "float32"] | None = None
    #: vLLM ``--quantization`` (e.g. ``fp8``); ``None`` = the checkpoint's own precision.
    quantization: str | None = None
    #: vLLM ``--max-model-len``; ``None`` = derived from the checkpoint (448 for Whisper).
    max_model_len: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _needs_somewhere_to_load_from(self) -> ResolvedVllmAsrSpec:
        if not (self.local_path or self.source_uri.strip()):
            raise ValueError("spec names neither localPath nor sourceUri — nothing to load")
        return self

    @property
    def load_target(self) -> str:
        """What vLLM's ``model=`` receives: the published directory, else the HF repo id."""
        if self.local_path:
            return self.local_path
        uri = self.source_uri.strip()
        for prefix in _HF_PREFIXES:
            if uri.startswith(prefix):
                return uri[len(prefix) :]
        return uri

    @property
    def load_revision(self) -> str | None:
        """A local directory has no revision; an HF source is pinned to the row's."""
        return None if self.local_path else self.source_revision
