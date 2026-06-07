"""Eval-harness configuration (pydantic-settings).

Extends the ``apps/harness`` config conventions (see ``harness.core.config``):
every knob is env-driven with the ``HARNESS_`` family of prefixes; nothing is
hardcoded. The judge is **model-agnostic** — pick the provider via
``HARNESS_JUDGE_PROVIDER`` and configure it with that provider's prefix:

* ``openai_compat`` (default, priority) — a small ≤20B judge on an LM Studio /
  vLLM / any OpenAI-compatible local endpoint (``HARNESS_JUDGE_OPENAI_COMPAT_*``).
* ``ollama`` — Ollama via its OpenAI-compatible ``/v1`` (parity option; reuses the
  ``HARNESS_JUDGE_OPENAI_COMPAT_*`` config — point ``base_url`` at ``:11434/v1``).
* ``azure`` — a large judge via Azure OpenAI (``HARNESS_JUDGE_AZURE_*``).
* ``bedrock`` — a large judge via AWS Bedrock (``HARNESS_JUDGE_BEDROCK_*``).
"""

from __future__ import annotations

import json
from enum import StrEnum

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class JudgeProvider(StrEnum):
    """Selects which backend serves the LLM-as-judge."""

    OPENAI_COMPAT = "openai_compat"  # LM Studio / vLLM / any OpenAI-compatible server
    OLLAMA = "ollama"  # Ollama via its OpenAI-compatible ``/v1`` (parity option)
    AZURE = "azure"
    BEDROCK = "bedrock"


class OpenAICompatJudgeConfig(BaseSettings):
    """OpenAI-compatible local endpoint (LM Studio default)."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_JUDGE_OPENAI_COMPAT_")

    base_url: str = "http://localhost:1234/v1"  # LM Studio default
    api_key: SecretStr = SecretStr("lm-studio")
    organization: str | None = None
    # ``response_format.type`` sent on json_mode calls (claim extraction / verify).
    # "json_object" works on Ollama/vLLM; LM Studio rejects it ("must be json_schema
    # or text") and small models emit empty output under a strict json_schema grammar,
    # so set this to "text" for LM Studio to omit the constraint and rely on the
    # "Return ONLY JSON" prompt + tolerant parsing (harness.eval.jsonio.loads_json).
    json_response_format: str = "json_object"


class AzureJudgeConfig(BaseSettings):
    """Azure OpenAI judge endpoint."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_JUDGE_AZURE_")

    api_key: SecretStr = SecretStr("")
    endpoint: str = ""
    api_version: str = "2024-12-01-preview"
    deployment: str = ""


class BedrockJudgeConfig(BaseSettings):
    """AWS Bedrock judge endpoint."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_JUDGE_BEDROCK_")

    region: str = "us-east-1"


class JudgeConfig(BaseSettings):
    """Root, model-agnostic judge configuration."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_JUDGE_")

    # Priority/default = a small ≤20B model on a local OpenAI-compatible endpoint.
    provider: JudgeProvider = JudgeProvider.OPENAI_COMPAT
    model: str = "google/gemma-4-e4b"
    temperature: float = 0.0
    # Large budget (NOT ~2k): reasoning model families (qwen3.5, gemma-4, medgemma)
    # can spend thousands of tokens "thinking" before emitting the JSON answer; a
    # small cap truncates mid-reasoning (finish_reason=length → empty ``content``,
    # the answer stranded in ``reasoning_content``). 8192 leaves room for the
    # reasoning trace *and* the final JSON across both reasoning/non-reasoning models.
    max_tokens: int = 8192
    # Generous default: a slow local reasoning judge can take minutes for a single
    # call (observed ~90s on gemma-4-e4b, ~340s on qwen3.5-9b via LM Studio), so the
    # old 120s default killed legitimate calls mid-generation.
    timeout_s: float = 300.0
    max_retries: int = 2
    # Bounded app-level retry for *transient* backend failures (distinct from the
    # SDK's ``max_retries``, which does NOT retry HTTP 400s). A small local server
    # (e.g. LM Studio serving gemma-4-e4b) can terminate/unload the model engine
    # under sustained sequential load — surfacing as ``400 {'error':'terminated'}``
    # or a dropped connection — then JIT-reload it on the next call. We retry such
    # transient failures (with linear backoff to let the model reload) so a long
    # run survives a mid-run engine crash; a genuinely-down backend still aborts
    # once the retries are exhausted (never a silent green gate).
    transient_retries: int = 3
    transient_retry_backoff_s: float = 12.0

    # -- Calibration levers (TASK-330 eval hardening) -----------------------
    # Opt-in anchored rubric prompt: appends rubric-faithful per-score guidance +
    # balanced exemplars so a small local judge applies the Epic grade descriptors
    # consistently (raises judge↔reference agreement). The verbatim instrument is
    # preserved; this is purely additive. Default off to keep CI prompts pristine.
    anchored: bool = False
    # Self-consistency: sample the judge ``self_consistency`` times and take the
    # per-dimension median (variance reduction). ``1`` == single deterministic pass.
    self_consistency: int = 1
    # Temperature used for the >1 self-consistency samples (needs > 0 for diversity).
    # Kept low (0.2) so samples stay near the greedy mode while still varying enough
    # for the per-dimension median to reduce variance without drifting off-rubric.
    sc_temperature: float = 0.2
    # Deterministic decoding seed (passed to OpenAI-compatible / Azure backends).
    seed: int | None = None
    # Judge output format: "with_explanation" (default; richer per-dimension rationale)
    # or "score" (compact score-only JSON). SCORE is markedly more reliable for small
    # (≤~7B) judge models, which can otherwise emit a long un-tagged prose preamble that
    # exhausts ``max_tokens`` before any JSON appears.
    output_mode: str = "with_explanation"
    # Append a "/no_think" + JSON-only directive to the judge system prompt. Needed for
    # small local judges (e.g. gemma-4-e4b on LM Studio) that otherwise emit a long
    # ``<think>`` block and may end the turn before the JSON (premature stop). Off by
    # default so larger judges (gpt-oss, Azure) keep their pristine prompt.
    suppress_reasoning: bool = False

    # -- Reasoning-control levers (cross-family robustness) ------------------
    # Forwarded verbatim into the OpenAI-compatible / Azure ``create(...)`` call
    # (ignored by Bedrock's converse API) when set. This is the passthrough for
    # server-specific reasoning knobs that DO take effect on vLLM/Azure — e.g.
    # ``{"reasoning_effort": "low"}`` or
    # ``{"chat_template_kwargs": {"enable_thinking": false}}``. Empirically these had
    # NO effect on LM Studio (where a large ``max_tokens`` + reading reasoning text is
    # the only reliable lever), so this stays off by default. Accepts a JSON string
    # from the environment (``HARNESS_JUDGE_EXTRA_BODY='{"reasoning_effort":"low"}'``).
    extra_body: dict | None = None
    # Selects how the prompt asks the model to reason (consumed by the judge prompts):
    # "auto" (let the model decide), "think" (encourage an explicit reasoning pass), or
    # "none" (instruct it to answer directly). Distinct from ``suppress_reasoning`` so
    # prompt phrasing and the hard ``/no_think`` suffix can be tuned independently.
    reasoning_mode: str = "auto"

    # Provider sub-configs (each reads its own env prefix at instantiation).
    openai_compat: OpenAICompatJudgeConfig = Field(default_factory=OpenAICompatJudgeConfig)
    azure: AzureJudgeConfig = Field(default_factory=AzureJudgeConfig)
    bedrock: BedrockJudgeConfig = Field(default_factory=BedrockJudgeConfig)

    @field_validator("extra_body", mode="before")
    @classmethod
    def _parse_extra_body(cls, v: object) -> dict | None:
        """Accept a JSON string (env) or a dict; blank/None → None.

        ``HARNESS_JUDGE_EXTRA_BODY='{"reasoning_effort":"low"}'`` arrives as a string
        on direct construction; this parses it into a dict. An already-parsed dict
        (or ``None``) passes through unchanged.
        """
        if v is None:
            return None
        if isinstance(v, str):
            stripped = v.strip()
            if not stripped:
                return None
            return json.loads(stripped)
        return v

    @field_validator("reasoning_mode")
    @classmethod
    def _validate_reasoning_mode(cls, v: str) -> str:
        allowed = {"auto", "think", "none"}
        if v not in allowed:
            raise ValueError(f"reasoning_mode must be one of {sorted(allowed)}")
        return v


class EvalConfig(BaseSettings):
    """Eval-run thresholds + golden-set pin (the release-gate knobs)."""

    model_config = SettingsConfigDict(env_prefix="HARNESS_EVAL_")

    # Pinned golden-set version the gate runs against (CI overrides via env).
    golden_set_version: str = "synthetic-v0.1.0"
    golden_set_path: str = ""

    # Release-gate thresholds.
    icc_threshold: float = 0.8
    faithfulness_threshold: float = 0.85
    pdsqi_accurate_threshold: float = 4.0
    pdsqi_thorough_threshold: float = 4.0
    pdsqi_mean_threshold: float = 4.0

    judge: JudgeConfig = Field(default_factory=JudgeConfig)

    @field_validator("icc_threshold", "faithfulness_threshold")
    @classmethod
    def _unit_interval(cls, v: float) -> float:
        if not (0.0 <= v <= 1.0):
            raise ValueError("threshold must be within [0, 1]")
        return v


def _load_env() -> None:
    """Populate ``os.environ`` from ``.env`` files (reuses the core loader)."""
    from harness.core.config import _load_dotenv_into_environ

    _load_dotenv_into_environ()


def get_judge_config() -> JudgeConfig:
    """Build :class:`JudgeConfig` from env / ``.env`` (call once at startup)."""
    _load_env()
    return JudgeConfig()


def get_eval_config() -> EvalConfig:
    """Build :class:`EvalConfig` from env / ``.env`` (call once at startup)."""
    _load_env()
    return EvalConfig()
