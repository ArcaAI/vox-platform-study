"""`POST /api/v1/guardrail/judge/dry-run` — a platform admin's draft, judged in memory (TASK-1050 §11.3 B).

The gateway's `POST admin/guardrail/policy-keys/dry-run` calls this with a DRAFT judge prompt,
draft parameters and/or a draft native mapping. It runs the real judge runner with the drafts
layered over the stored values and answers per sample, per lane, with latency.

What it deliberately does NOT do:

* **persist anything** — no window-cache entry (a draft verdict must never be served under the
  live policy version), no shared single-flight, no evaluation record, no write to the model row;
* **check residency** — the gateway refuses a non-resident judge with 409 before calling here
  (OD-35). A judge that is not loaded simply answers undetermined.

Behind `X-Service-Token` like every route here; `X-Tenant-Id` is mandatory (428).
"""

from __future__ import annotations

import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from guardrail.core.dependencies import require_tenant_id
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.logging import get_logger
from guardrail.core.policy import KIND_CRITERIA, GuardrailPolicy, policy_key_catalogue
from guardrail.services import judge_protocols as jp
from guardrail.services.judge_runner import JudgeWindow, build_judge_runner_for_app

logger = get_logger(__name__)

router = APIRouter()

#: The policy keys a draft may set: every criteria key, plus the two judge hyperparameters.
_DRAFTABLE_KEYS = frozenset(
    {entry["key"] for entry in policy_key_catalogue()["keys"] if entry["kind"] == KIND_CRITERIA}
    | {"judgeTemperature", "judgeMaxTokens"}
)


class DraftJudgeMeta(BaseModel):
    """A draft native mapping, layered over the stored ``_metadata.judge`` of each lane's row."""

    model_config = ConfigDict(extra="forbid")

    categoryMap: dict[str, dict[str, str]] | None = None  # noqa: N815 — wire name
    tiers: dict[str, str] | None = None


class JudgeDryRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lanes: list[str] = Field(..., min_length=1, description="Judge lanes to run")
    direction: Literal["inbound", "outbound"]
    mode: Literal["prompt", "response"] = "prompt"
    promptContext: str | None = Field(  # noqa: N815 — wire name
        default=None, description="The user turn, for a response-mode native judge"
    )
    draftPolicy: dict[str, Any] | None = Field(  # noqa: N815 — wire name
        default=None,
        description="Criteria by key, judgeTemperature?, judgeMaxTokens? — in memory only",
    )
    draftJudgeMeta: DraftJudgeMeta | None = None  # noqa: N815 — wire name
    samples: list[str] = Field(..., min_length=1, max_length=50)

    @field_validator("lanes")
    @classmethod
    def _known_lanes(cls, lanes: list[str]) -> list[str]:
        unknown = sorted(set(lanes) - set(jp.GUARDRAIL_JUDGE_LANES))
        if unknown:
            raise ValueError(f"unknown judge lane(s): {', '.join(unknown)}")
        return lanes

    @field_validator("draftPolicy")
    @classmethod
    def _draftable(cls, draft: dict[str, Any] | None) -> dict[str, Any] | None:
        if draft is None:
            return None
        unknown = sorted(set(draft) - _DRAFTABLE_KEYS)
        if unknown:
            raise ValueError(f"not a draftable judge policy key: {', '.join(unknown)}")
        probe = GuardrailPolicy.from_blob(draft)
        for key in ("judgeTemperature", "judgeMaxTokens"):
            if key in draft:
                try:
                    probe.require_number(key)
                except GuardrailUndeterminedError as exc:
                    raise ValueError(f"{key} is not a valid value: {exc.detail}") from exc
        for key, value in draft.items():
            if key not in ("judgeTemperature", "judgeMaxTokens") and not (
                isinstance(value, str) and value.strip()
            ):
                raise ValueError(f"{key} must be a non-empty string")
        return draft


class LaneResult(BaseModel):
    verdict: str
    category: str | None
    confidence: float | None
    model: str | None
    latencyMs: int  # noqa: N815 — wire name
    tier: str | None


class SampleResult(BaseModel):
    sampleIndex: int  # noqa: N815 — wire name
    latencyMs: int  # noqa: N815 — wire name
    verdicts: dict[str, LaneResult]


class JudgeDryRunResponse(BaseModel):
    results: list[SampleResult]
    latencyMs: int  # noqa: N815 — wire name


async def _stored_meta_problems(
    app_state: Any, tenant_id: str, lanes: list[str], draft: dict[str, Any]
) -> list[str]:
    """Validate the draft mapping layered over each lane's STORED declaration (422 on a problem)."""
    resolver = getattr(app_state, "tenant_config_resolver", None)
    if resolver is None:
        return []
    problems: list[str] = []
    for lane in lanes:
        try:
            cfg = await resolver.resolve(tenant_id, jp.lane_task_key(lane))
        except Exception:  # noqa: BLE001 — an unresolvable lane is undetermined at run time
            continue
        stored = getattr(cfg, "judge", None)
        if isinstance(stored, dict):
            problems.extend(f"{lane}: {p}" for p in jp.judge_metadata_problems({**stored, **draft}))
    return problems


@router.post("/guardrail/judge/dry-run", response_model=JudgeDryRunResponse)
async def judge_dry_run(request: JudgeDryRunRequest, http_request: Request) -> JudgeDryRunResponse:
    """Judge ``samples`` on ``lanes`` under the drafts, in memory. Persists nothing."""
    tenant_id = require_tenant_id(http_request)
    app_state = http_request.app.state
    draft_meta = (
        request.draftJudgeMeta.model_dump(exclude_none=True) if request.draftJudgeMeta else {}
    )
    if draft_meta:
        problems = await _stored_meta_problems(app_state, tenant_id, request.lanes, draft_meta)
        if problems:
            raise HTTPException(
                status_code=422, detail={"code": "JUDGE_META_INVALID", "problems": problems}
            )

    runner = await build_judge_runner_for_app(
        app_state,
        tenant_id,
        dry_run=True,
        draft_policy=request.draftPolicy,
        draft_judge_meta=draft_meta,
    )
    started = time.monotonic()
    results: list[SampleResult] = []
    for index, sample in enumerate(request.samples):
        sample_started = time.monotonic()
        region = f"sample@{index}"
        verdicts = await runner.judge(
            tenant_id=tenant_id,
            direction=request.direction,
            lanes=request.lanes,
            windows=[JudgeWindow(region_key=region, text=sample, items=())],
            mode=request.mode,
            prompt_context=request.promptContext,
        )
        results.append(
            SampleResult(
                sampleIndex=index,
                latencyMs=int((time.monotonic() - sample_started) * 1000),
                verdicts={
                    lane: LaneResult(
                        verdict=v.verdict,
                        category=v.category,
                        confidence=v.confidence,
                        model=v.model,
                        latencyMs=v.latency_ms,
                        tier=v.tier,
                    )
                    for (lane, key), v in verdicts.items()
                    if key == region
                },
            )
        )
    # Counts only — never a sample, never a criterion (both may be PHI or unreviewed policy).
    logger.info(
        "guardrail.judge.dry_run",
        tenant_id=tenant_id,
        lanes=request.lanes,
        samples=len(request.samples),
    )
    return JudgeDryRunResponse(results=results, latencyMs=int((time.monotonic() - started) * 1000))
