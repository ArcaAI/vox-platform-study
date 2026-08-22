"""DB-resident, fail-closed judge SELECTION for the offline eval gate.

Owner directive D-B (`docs/programs/agentic-workflow-platform/owner-decisions-2026-08-17.md`):
an engine name or model id is **never** an env var and **never** a literal in code.
The runtime (Temporal) path already honours this — `temporal/activities.py` takes
`judge_provider`/`judge_model` from the SYSTEM ``harness.judge`` ``AiTaskDefault``
snapshotted onto the workflow input and fails closed when it is absent. Before this
module the *eval gate* did not: `run-gate.sh` carried a hardcoded `JUDGE_MODEL`
default and `JudgeConfig.model` carried a literal, so the gate could silently grade
with a different judge than production selects.

This module closes that gap. It resolves the SAME row the runtime resolves:

    AiTaskDefault(taskKey='harness.judge', resourceStatus=ENABLED)
        -> modelSlug -> AiModel(slug, resourceStatus=ENABLED) -> (provider, sourceUri)

**Resolution order is tenant -> SYSTEM, two tiers, no third.** The eval gate runs with
no request tenant, so it resolves SYSTEM only; it must never widen to a customer
tenant (`50000000-...` is a customer playground, not a config tier).

**Fail closed.** A missing, disabled, or unresolvable selection raises
:class:`JudgeSelectionUnavailable`. There is deliberately no env fallback: a gate that
quietly grades with a different judge than the one the platform selects is worse than a
gate that refuses to run. Env (`HARNESS_JUDGE_OPENAI_COMPAT_*`) keeps supplying the
CONNECTION config (base_url / api_key / tuning) only — the same split the runtime uses.

**Why a direct read rather than a gateway call.** `apps/harness` deliberately has no DB
client (rule 06: gateway-resolved injection), and the runtime judge selection arrives
over that gateway callback. The eval gate, however, is an offline developer tool that
runs with no gateway process and no workflow, so there is no injection point. It
therefore takes the same sanctioned exception `apps/guardrail/core/tenant_config.py`
takes: a read-only SQL read, SYSTEM-scoped, fail-closed. ``asyncpg`` is imported
LAZILY inside :func:`resolve_eval_judge_selection` so the harness SERVICE keeps its
"no DB driver" property — only this offline tool pays for it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

import structlog

from harness.eval.config import JudgeProvider

logger = structlog.get_logger(__name__)

#: The config TIER that holds platform defaults. Never a customer tenant.
SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000"

#: The `AiTaskDefault.taskKey` the LLM-as-judge selection lives under (SUPER_ADMIN-owned).
EVAL_JUDGE_TASK_KEY = "harness.judge"

#: `AiModel.provider` values -> the judge transport that serves them. LM Studio, Ollama,
#: vLLM and llama.cpp all speak the OpenAI wire, so they share the OpenAI-compatible
#: client and differ only in `base_url` (which is CONNECTION config, i.e. env). Ollama
#: gets its own `JudgeProvider` member (not reused OPENAI_COMPAT) only so stop-reason
#: normalization stays provider-aware (`_STOP_TABLES["ollama"]`) — no vendor-specific
#: transport is added anywhere (owner decision 2026-08-20, TASK-736/TASK-740 D-740-3).
_PROVIDER_MAP: dict[str, JudgeProvider] = {
    "lm-studio": JudgeProvider.OPENAI_COMPAT,
    "openai_compat": JudgeProvider.OPENAI_COMPAT,
    "ollama": JudgeProvider.OLLAMA,
    "vllm": JudgeProvider.VLLM,
    "llama-cpp": JudgeProvider.LLAMA_CPP,
    "azure": JudgeProvider.AZURE,
    "bedrock": JudgeProvider.BEDROCK,
}

_SELECT_SQL = """
SELECT m.provider   AS provider,
       m."sourceUri" AS model_id,
       d."modelSlug" AS model_slug
  FROM core."AiTaskDefault" d
  JOIN core."AiModel"       m ON m.slug = d."modelSlug"
 WHERE d."taskKey"        = $1
   AND d."tenantId"       = $2
   AND d."resourceStatus" = 'ENABLED'
   AND m."resourceStatus" = 'ENABLED'
 ORDER BY (m."tenantId" = $2) DESC
 LIMIT 1
"""


class JudgeSelectionUnavailable(RuntimeError):
    """The DB carries no usable judge selection — the gate must NOT run."""


@dataclass(frozen=True)
class JudgeSelection:
    """A resolved judge selection and the tier that supplied it."""

    provider: JudgeProvider
    model: str
    model_slug: str
    #: "tenant" or "system" — which tier answered. Reported, never inferred.
    tier: str


@dataclass(frozen=True)
class RawSelection:
    """A resolved `AiTaskDefault` row, provider kept as the RAW `AiModel.provider` string.

    The judge path maps this onto a :class:`JudgeProvider` transport; the SAFETY
    path (``harness.eval.safety_selection``) needs the raw name instead, because
    ``SafetyGuardConfig`` selects its engine BY NAME and the mapping is lossy
    (``lm-studio`` and ``openai_compat`` both collapse to ``OPENAI_COMPAT``).
    """

    provider: str
    model: str
    model_slug: str
    #: "tenant" or "system" — which tier answered. Reported, never inferred.
    tier: str


def _asyncpg_dsn(raw: str) -> str:
    """Strip a Prisma-style query string; asyncpg rejects `?schema=`/`?pgbouncer=`."""
    parts = urlsplit(raw)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


async def resolve_eval_selection(
    *,
    task_key: str,
    tenant_id: str | None = None,
    dsn: str | None = None,
) -> RawSelection:
    """Resolve any eval-tool `AiTaskDefault` SELECTION from the database, fail closed.

    The shared engine behind :func:`resolve_eval_judge_selection` (``harness.judge``)
    and :func:`harness.eval.safety_selection.resolve_eval_safety_selection`
    (``guardrail.safety``). Extracted so a second offline eval consumer cannot
    drift from the judge's resolution order, failure posture, or DSN handling by
    reimplementing them.

    **Resolution order is tenant -> SYSTEM, two tiers, no third.** A caller with no
    request tenant resolves SYSTEM only and must never widen to a customer tenant.

    Raises
    ------
    JudgeSelectionUnavailable
        When ``DATABASE_URL`` is unset, the database is unreachable, the task
        default is absent/disabled, or its model row is absent/disabled/empty.
    """

    resolved_dsn = dsn or os.environ.get("DATABASE_URL", "")
    if not resolved_dsn:
        raise JudgeSelectionUnavailable(
            "DATABASE_URL is not set, so the DB-resident judge selection "
            f"({task_key}) cannot be resolved. The eval gate fails closed rather than "
            "grading with an env-supplied model id (owner decision D-B)."
        )

    try:
        import asyncpg  # noqa: PLC0415 — lazy: keeps the harness SERVICE free of a DB driver
    except ImportError as exc:  # pragma: no cover - environment defect
        raise JudgeSelectionUnavailable(
            "asyncpg is required to resolve the DB-resident judge selection for the "
            "offline eval gate; install it in the conda env (`arcaenv`)."
        ) from exc

    tiers: list[tuple[str, str]] = []
    if tenant_id and tenant_id != SYSTEM_TENANT_ID:
        tiers.append(("tenant", tenant_id))
    tiers.append(("system", SYSTEM_TENANT_ID))

    try:
        conn = await asyncpg.connect(_asyncpg_dsn(resolved_dsn))
    except Exception as exc:  # noqa: BLE001 — any connect failure is fail-closed
        raise JudgeSelectionUnavailable(
            f"could not reach the database to resolve the {task_key} judge selection: {exc}"
        ) from exc

    try:
        for tier, tid in tiers:
            row = await conn.fetchrow(_SELECT_SQL, task_key, tid)
            if row is None:
                continue
            provider_key = str(row["provider"] or "").strip()
            if not provider_key:
                raise JudgeSelectionUnavailable(
                    f"{task_key} resolves to model slug {row['model_slug']!r} with an empty "
                    "provider; there is no engine to select."
                )
            model = str(row["model_id"] or "").strip()
            if not model:
                raise JudgeSelectionUnavailable(
                    f"{task_key} resolves to model slug {row['model_slug']!r} with an empty "
                    "sourceUri; there is no model id to select."
                )
            selection = RawSelection(
                provider=provider_key,
                model=model,
                model_slug=str(row["model_slug"]),
                tier=tier,
            )
            logger.info(
                "harness.eval.selection_resolved",
                task_key=task_key,
                tier=tier,
                model_slug=selection.model_slug,
                provider=provider_key,
                model=model,
            )
            return selection
    finally:
        await conn.close()

    raise JudgeSelectionUnavailable(
        f"no ENABLED {task_key} AiTaskDefault (with an ENABLED AiModel) for "
        f"{'tenant ' + str(tenant_id) + ' or ' if tenant_id else ''}the SYSTEM tenant. "
        "The eval gate fails closed: seed/enable the selection rather than passing a "
        "model id through the environment."
    )


def _cli() -> int:  # pragma: no cover - thin shell adapter
    """Print one field of the resolved selection, so `run-gate.sh` never hardcodes it.

    ``python -m harness.eval.judge.selection --field model`` -> the model id.
    Exits 2 (never 0 with a fabricated value) when the selection cannot be resolved.
    """
    import argparse
    import asyncio
    import sys

    from hope_env import load_env

    parser = argparse.ArgumentParser(prog="python -m harness.eval.judge.selection")
    parser.add_argument("--field", default="model", choices=["model", "provider", "slug", "tier"])
    args = parser.parse_args()

    load_env()
    try:
        selection = asyncio.run(resolve_eval_judge_selection())
    except JudgeSelectionUnavailable as exc:
        print(f"judge selection unavailable (fail-closed): {exc}", file=sys.stderr)
        return 2
    print(
        {
            "model": selection.model,
            "provider": str(selection.provider),
            "slug": selection.model_slug,
            "tier": selection.tier,
        }[args.field]
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_cli())


async def resolve_eval_judge_selection(
    *,
    tenant_id: str | None = None,
    task_key: str = EVAL_JUDGE_TASK_KEY,
    dsn: str | None = None,
) -> JudgeSelection:
    """Resolve the LLM-as-judge SELECTION, tenant -> SYSTEM, fail closed.

    Thin mapping over :func:`resolve_eval_selection`: the DB read is shared, and
    only the provider -> transport mapping is judge-specific.

    Parameters
    ----------
    tenant_id:
        Optional request tenant. ``None`` (the eval gate's normal case) resolves the
        SYSTEM tier ONLY — never a customer tenant.
    dsn:
        Override for ``DATABASE_URL`` (tests).

    Raises
    ------
    JudgeSelectionUnavailable
        When ``DATABASE_URL`` is unset, the database is unreachable, the task default
        is absent/disabled, or its model row is absent/disabled/unknown-provider.
    """
    raw = await resolve_eval_selection(task_key=task_key, tenant_id=tenant_id, dsn=dsn)
    provider = _PROVIDER_MAP.get(raw.provider)
    if provider is None:
        raise JudgeSelectionUnavailable(
            f"{task_key} resolves to AiModel provider {raw.provider!r}, which no "
            f"judge transport serves (known: {sorted(_PROVIDER_MAP)})."
        )
    return JudgeSelection(
        provider=provider,
        model=raw.model,
        model_slug=raw.model_slug,
        tier=raw.tier,
    )
