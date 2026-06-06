"""PDSQI-9 LLM-as-judge (Epic open-source instrument), model-agnostic."""

from __future__ import annotations

from harness.eval.judge.base import (
    JudgeClient,
    JudgeConnectionError,
    JudgeError,
    JudgeParseError,
)
from harness.eval.judge.pdsqi import PDSQI9Judge
from harness.eval.judge.prompts import OutputMode, resolve_instructions, resolve_prompt
from harness.eval.judge.providers import (
    AzureOpenAIJudgeClient,
    BedrockJudgeClient,
    OpenAICompatJudgeClient,
    build_judge_client,
)

__all__ = [
    "AzureOpenAIJudgeClient",
    "BedrockJudgeClient",
    "JudgeClient",
    "JudgeConnectionError",
    "JudgeError",
    "JudgeParseError",
    "OpenAICompatJudgeClient",
    "OutputMode",
    "PDSQI9Judge",
    "build_judge_client",
    "resolve_instructions",
    "resolve_prompt",
]
