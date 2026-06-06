"""Clinical-documentation eval harness (TASK-330, Phase 0).

A **self-contained, offline-first** evaluation harness for the clinical
documentation loop. It scores transcript→note cases with a model-agnostic
PDSQI-9 LLM-as-judge (Epic's open-source instrument), RAGAS-style faithfulness,
and DeepEval metric wrappers, and validates the judge against clinician ratings
(ICC / Gwet AC2) before any automated score is trusted.

Design constraints (Phase 0):
* No Postgres writes and no import of ``EvalService`` / ``packages/*`` — eval
  results are emitted to files / stdout (Langfuse optional, later). DB
  persistence of eval runs is a later phase via ``apps/api``.
* The judge model is configured via env (see :mod:`harness.eval.config`):
  a small ≤20B model on an LM Studio / OpenAI-compatible endpoint is the
  priority/default; a large model via Azure OpenAI or AWS Bedrock is opt-in.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
