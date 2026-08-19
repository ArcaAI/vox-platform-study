"""Internal, synchronous eval-run endpoint (apps/api → apps/harness).

``POST /api/v1/internal/eval/run`` scores a golden set whose cases are inlined in
the request body and applies the release gate, returning the per-case scores plus
the pass/fail verdict. It is the machinery behind the apps/api **promotion gate**
(approve a template / re-point an agent pin) and the admin **run-now** action.

Design notes:

* **Synchronous + bounded.** Small sets only — the case count is capped
  (``EvalConfig.max_cases_per_run``); over-cap requests are rejected (413) rather
  than blocking a promotion for minutes. Large sets belong on the future Temporal
  lane (out of scope here).
* **Provenance, not generation.** The endpoint JUDGES the notes supplied on each
  case (``generated_note``); it does not itself run Text generation (that needs the
  LLM lane and is not hermetic). The ``promptTemplateId`` / ``promptVersion`` /
  ``promptVersionNumber`` fields are recorded as provenance and echoed back so
  apps/api can attribute the persisted ``EvalRun`` to the promotion that triggered it.
* **Hermetic-testable.** A judge (and optional faithfulness evaluator) may be
  injected on ``app.state.eval_judge`` / ``app.state.eval_faithfulness`` by tests;
  otherwise a live, model-agnostic judge is built lazily from env/config.

Guarded by the shared ``HARNESS_SERVICE_TOKEN`` (``X-Service-Token``). An empty
configured token disables the guard (local dev only).
"""

from __future__ import annotations

import secrets
from typing import Any, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from harness.core.config import Settings
from harness.core.logging import get_logger
from harness.eval.models import GoldenSet

logger = get_logger(__name__)

router = APIRouter(tags=["internal-eval"])


def _settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


def require_service_token(
    request: Request,
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
) -> None:
    """Reject the request unless ``X-Service-Token`` matches an accepted secret.

    Accepts the canonical shared ``INTERNAL_ACCESS_TOKEN`` OR the legacy
    ``HARNESS_SERVICE_TOKEN``, via :attr:`Settings.accepted_service_tokens` —
    the same both-tokens posture ``knowledge.py`` already implements. Reading
    ``harness_service_token`` alone made this surface the one inbound guard that
    rejected a caller presenting the shared token. Constant-time comparison; no
    configured token at all means auth is disabled (local dev / hermetic CI).
    """
    accepted = _settings(request).accepted_service_tokens
    if not accepted:
        return
    if not x_service_token or not any(
        secrets.compare_digest(x_service_token, tok) for tok in accepted
    ):
        raise HTTPException(status_code=401, detail="invalid or missing service token")


class EvalRunRequest(BaseModel):
    """Body for ``/eval/run`` (camelCase at the apps/api boundary).

    ``golden_set`` reuses the harness eval :class:`GoldenSet` value object (its own
    validators enforce ≥1 case + unique ids). The prompt-provenance fields are
    recorded on the persisted ``EvalRun`` by apps/api.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    golden_set: GoldenSet = Field(alias="goldenSet")
    prompt_template_id: str | None = Field(default=None, alias="promptTemplateId")
    prompt_version: str | None = Field(default=None, alias="promptVersion")
    prompt_version_number: int | None = Field(default=None, alias="promptVersionNumber")
    # PDSQI-only by default: faithfulness needs a claim extractor/verifier the
    # caller is not required to provision for a promotion gate.
    no_faithfulness: bool = Field(default=True, alias="noFaithfulness")


def _resolve_evaluators(request: Request, *, no_faithfulness: bool) -> tuple[Any, Any]:
    """Return ``(judge, faithfulness)`` — the injected test doubles when present,
    else a live model-agnostic judge built lazily from env/config."""
    injected_judge = getattr(request.app.state, "eval_judge", None)
    injected_faith = getattr(request.app.state, "eval_faithfulness", None)
    if injected_judge is not None or injected_faith is not None:
        return injected_judge, (None if no_faithfulness else injected_faith)

    # Live path — only reached on a real deployment, never in the hermetic suite.
    from harness.eval.config import get_eval_config
    from harness.eval.judge.pdsqi import PDSQI9Judge
    from harness.eval.judge.prompts import OutputMode
    from harness.eval.judge.providers import build_judge_client
    from harness.eval.metrics.faithfulness import build_faithfulness_evaluator

    config = get_eval_config()
    client = build_judge_client(config.judge)
    judge = PDSQI9Judge(
        client,
        output_mode=OutputMode(config.judge.output_mode),
        anchored=config.judge.anchored,
        self_consistency=config.judge.self_consistency,
        sc_temperature=config.judge.sc_temperature,
        seed=config.judge.seed,
        reasoning_mode=getattr(config.judge, "reasoning_mode", "auto"),
        suppress_reasoning=config.judge.suppress_reasoning,
    )
    faithfulness = None if no_faithfulness else build_faithfulness_evaluator(client)
    return judge, faithfulness


@router.post("/eval/run", dependencies=[Depends(require_service_token)])
async def run_eval(body: EvalRunRequest, request: Request) -> dict[str, Any]:
    """Score the inlined golden set, apply the release gate, return the verdict."""
    from harness.eval.ci import run_and_gate
    from harness.eval.config import get_eval_config
    from harness.eval.golden import InMemoryGoldenSetSource

    config = get_eval_config()

    n_cases = len(body.golden_set.cases)
    if n_cases > config.max_cases_per_run:
        # Fail fast BEFORE scoring — a synchronous promotion gate must not block for
        # minutes on an oversized set.
        raise HTTPException(
            status_code=413,
            detail=(
                f"golden set has {n_cases} cases; the synchronous eval cap is "
                f"{config.max_cases_per_run}. Split the set or use the async lane."
            ),
        )

    judge, faithfulness = _resolve_evaluators(request, no_faithfulness=body.no_faithfulness)

    run = await run_and_gate(
        InMemoryGoldenSetSource(body.golden_set),
        judge=judge,
        faithfulness=faithfulness,
        config=config,
    )

    logger.info(
        "harness.eval.run",
        golden_set_version=run.golden_set_version,
        judge_model=run.judge_model,
        n_cases=n_cases,
        passed=run.passed,
        failures=run.failures,
        prompt_template_id=body.prompt_template_id,
        prompt_version_number=body.prompt_version_number,
    )

    # The EvalRunResult (scores + gate verdict) plus the prompt provenance echo so
    # apps/api can persist an attributable EvalRun without re-deriving it.
    result = run.model_dump()
    result["promptTemplateId"] = body.prompt_template_id
    result["promptVersion"] = body.prompt_version
    result["promptVersionNumber"] = body.prompt_version_number
    # Flattened per-(case, metric) rows so apps/api persists EvalScore records
    # directly — the scalar derivation (PDSQI mean over the 1–5 Likert dims) lives
    # here with the models, not in the TypeScript gateway.
    result["caseScores"] = _flatten_case_scores(run)
    return result


def _flatten_case_scores(run: Any) -> list[dict[str, Any]]:
    """One row per scored (case, metric) for EvalScore persistence."""
    rows: list[dict[str, Any]] = []
    for cr in run.case_results:
        if cr.pdsqi is not None:
            rows.append(
                {
                    "caseId": cr.case_id,
                    "metric": "pdsqi_mean",
                    "score": cr.pdsqi.score.mean_quality(),
                    "maxScore": 5.0,
                    "judgeModel": cr.pdsqi.model,
                }
            )
        if cr.faithfulness is not None:
            rows.append(
                {
                    "caseId": cr.case_id,
                    "metric": "faithfulness",
                    "score": cr.faithfulness.score,
                    "maxScore": 1.0,
                    "judgeModel": run.judge_model,
                }
            )
    return rows
