"""asr-vllm settings (pydantic-settings, ``ASR_VLLM_`` prefix).

What is deliberately NOT here: any model selection. The model arrives with every
request as a resolved spec (``asr_vllm.spec``), resolved upstream — an env var naming a
model would be a hardcoded selection (``.claude/rules/09-infrastructure-devops.md``
§No hardcoded configuration). There is no gateway URL either: this service calls no
peer and opens no database.

What IS here, as a TASK-1010 SPIKE DEVIATION: vLLM engine tuning
(``gpu_memory_utilization``, ``max_num_seqs``, ``enforce_eager``, ``max_resident_engines``)
and the two truncation-heuristic knobs. They are per-deployment GPU-budget facts while the
spike measures them; each is listed in the ticket README to move to the control plane
(an ``asr.vllm.*`` descriptor or the agent/model row) once the numbers are known.
"""

from __future__ import annotations

from hope_env import hope_settings_sources, load_env, real_secret
from pydantic import AliasChoices, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    model_config = SettingsConfigDict(env_prefix="ASR_VLLM_")

    # ── Inbound credential (owner decision D-D): the ONE shared internal token,
    # accepted as `X-Service-Token`. Unprefixed on purpose — it belongs to no single
    # service. Empty ⇒ auth bypassed, but only when running locally (core/service_auth).
    internal_access_token: SecretStr = Field(
        default=SecretStr(""), validation_alias=AliasChoices("INTERNAL_ACCESS_TOKEN")
    )

    # ── vLLM engine tuning — SPIKE DEVIATION (see module docstring) ──────────
    #: Fraction of the WHOLE GPU's memory each engine may claim (weights + KV/encoder
    #: cache). A time-sliced GPU has no memory isolation, so on a shared card this is
    #: the service's budget share, not "how much is free". 0.5 of a 16 GB RTX 2000 Ada
    #: holds Whisper-turbo fp16 (~1.6 GB) with cache room for ~64 sequences.
    gpu_memory_utilization: float = Field(default=0.5, gt=0.0, le=1.0)
    #: vLLM's running-batch cap — the ceiling on concurrent windows in one engine.
    max_num_seqs: int = Field(default=64, ge=1)
    #: Skip CUDA-graph capture (faster cold start, slower steady state).
    enforce_eager: bool = False
    #: Engines resident at once (one per runtime key). Each claims
    #: `gpu_memory_utilization`, so the product must fit one card (validated below).
    max_resident_engines: int = Field(default=1, ge=1)

    # ── Truncation heuristic (vllm#53144 hook) — SPIKE DEVIATION ─────────────
    truncation_min_chars_per_voiced_second: float = Field(default=3.0, ge=0.0)
    truncation_voiced_dbfs: float = Field(default=-40.0, le=0.0)

    @model_validator(mode="after")
    def _resident_engines_fit_one_gpu(self) -> Settings:
        if self.max_resident_engines * self.gpu_memory_utilization > 1.0:
            raise ValueError(
                f"max_resident_engines ({self.max_resident_engines}) × gpu_memory_utilization "
                f"({self.gpu_memory_utilization}) exceeds one GPU; lower either"
            )
        return self

    @property
    def accepted_service_tokens(self) -> tuple[str, ...]:
        """Every token accepted as inbound ``X-Service-Token`` (empty ⇒ none configured).

        ``real_secret`` maps the unfilled-secret sentinel onto "", so a ``CHANGE_ME``
        token is never accepted as a credential (``hope_env.placeholders``).
        """
        shared = real_secret(self.internal_access_token)
        return (shared,) if shared else ()


def get_settings() -> Settings:
    """Load ``.env.<NODE_ENV>`` (host env wins) and build settings. Call once at startup."""
    load_env()
    return Settings()
