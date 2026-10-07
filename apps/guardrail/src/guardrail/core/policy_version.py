"""Guardrail's POLICY VERSION — one stable hash per tenant (TASK-1047 FC-3 / FC-7).

Two consumers key on it, and both need it to move exactly when a screening verdict
could change:

* the window-verdict cache (`services/window_cache.py`) — a cached verdict made
  under another policy is never reused, because the version is part of its key;
* the gateway's governed-prompt registry (L3) — a piece screened under another
  policy version is not governed until it is re-screened.

It is a SHA-256 over a canonical JSON of, for each selection a screen can consult
(`HASHED_TASK_KEYS`: `guardrail.safety`, `guardrail.injection` (TASK-1049 R1), `guardrail.pii`,
`guardrail.pii.spans`, `guardrail.validate`, and since TASK-1050 the four judge-lane keys
`guardrail.judge.*`), the
model id, the provider, the label taxonomy, the judge declaration (`_metadata.judge`), the
serving library and the policy blob — minus `OPERATIONAL_KEYS`, which cannot change a verdict —
plus the
EFFECTIVE window geometry (the resolved pair, so a value that falls back to the
default hashes like the default), the judge window bound, and the screening task
names this code consults. The judge criteria (`medicalValidationCriteria`,
`medicalWindowScopeCriteria`) ride inside the `guardrail.validate` policy blob.

Resolution is tenant → SYSTEM through the resolver, like every selection. A
selection that is ABSENT or VETOED is part of the hash (as such); a selection that
could not be READ raises, because "unreadable" must never surface as a different,
equally plausible version.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Final

from guardrail.core.policy import OPERATIONAL_KEYS, GuardrailPolicy

#: Represented by the EFFECTIVE geometry instead of their raw values, so a value
#: that resolves to the default hashes exactly like the default.
_GEOMETRY_KEYS: Final = frozenset({"screenWindowChars", "screenWindowOverlapChars"})

#: Bump when screening CODE changes what a verdict means (window semantics, the
#: merge rule, a task's role) without any configuration moving.
#: task-1050.1: the judge's user turn is enveloped (M-1) and judge lanes combine per model.
SCREEN_CONTRACT_VERSION: Final = "task-1050.1"

#: Every routing selection whose row can change a screening verdict. The four judge-lane keys
#: (TASK-1050 §12) are here so a lane switching model — or its model's criteria, parameters or
#: native mapping changing — re-screens and colds the window cache.
HASHED_TASK_KEYS: Final[tuple[str, ...]] = (
    "guardrail.safety",
    # TASK-1049 R1: `jailbreak_detection`'s own model. Absent hashes as absent, so a
    # deploy that seeds (or vetoes, or re-points) the row re-screens and colds the cache.
    "guardrail.injection",
    "guardrail.pii",
    "guardrail.pii.spans",
    "guardrail.validate",
    "guardrail.judge.injection",
    "guardrail.judge.unsafe_content",
    "guardrail.judge.clinical_safety",
    "guardrail.judge.leakage",
)


class PolicyVersionUnavailableError(RuntimeError):
    """The tenant's screening policy could not be read — callers map this to 503."""


def _selection_component(cfg: Any) -> dict[str, Any] | None:
    if cfg is None or not getattr(cfg, "model", None):
        return None
    policy = getattr(cfg, "policy", None)
    blob = policy if isinstance(policy, dict) else {}
    return {
        "provider": getattr(cfg, "provider", None),
        "model": cfg.model,
        "azureDeployment": getattr(cfg, "azure_deployment", None),
        "labelTaxonomy": getattr(cfg, "label_taxonomy", None),
        "entailment": getattr(cfg, "entailment", None),
        # TASK-1050 §12: the judge protocol + native mapping decide what a judge verdict means,
        # and the serving library decides which runtime scores (TASK-1049 R2). `getattr`: both
        # ride the resolver's config once its row reader carries them.
        "judge": getattr(cfg, "judge", None),
        "libraryName": getattr(cfg, "library_name", None),
        "policy": {
            k: v for k, v in blob.items() if k not in OPERATIONAL_KEYS and k not in _GEOMETRY_KEYS
        },
    }


def compute_policy_version(
    *,
    selections: dict[str, Any],
    screen_policy: GuardrailPolicy,
    judge_window_chars: int,
) -> str:
    """The stable hash. ``selections`` maps task key → resolved config, ``None``
    (absent) or the string ``"vetoed"``."""
    from guardrail.services.screening import INBOUND_TASKS, OUTBOUND_TASKS

    size, overlap = screen_policy.screen_window_geometry
    document = {
        "contract": SCREEN_CONTRACT_VERSION,
        "tasks": {"inbound": list(INBOUND_TASKS), "outbound": list(OUTBOUND_TASKS)},
        "geometry": {"window": size, "overlap": overlap, "judgeWindow": judge_window_chars},
        "selections": {
            key: (value if value == "vetoed" else _selection_component(value))
            for key, value in sorted(selections.items())
        },
    }
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def judge_window_chars(screen_policy: GuardrailPolicy, judge_max_input_chars: int) -> int:
    """The judge's window: the screen window, bounded by the judge lane's input cap.

    The judge lane sees at most `JudgePolicy.max_input_chars` per call (a contract
    with `apps/text`), so a judge window is never larger — every character is
    judged, none is silently cut off the end of a window.
    """
    size, _overlap = screen_policy.screen_window_geometry
    return max(1, min(size, int(judge_max_input_chars)))


async def resolve_policy_version(app_state: Any, tenant_id: str) -> str:
    """The policy version for ``tenant_id``. Raises :class:`PolicyVersionUnavailableError`."""
    from guardrail.core.tenant_config import (
        TASK_KEY_GUARDRAIL_SAFETY,
        TenantConfigUnavailableError,
        TenantSelectionVetoedError,
    )

    resolver = getattr(app_state, "tenant_config_resolver", None)
    if resolver is None:
        raise PolicyVersionUnavailableError("tenant config resolver is not wired")

    selections: dict[str, Any] = {}
    for task_key in HASHED_TASK_KEYS:
        try:
            selections[task_key] = await resolver.resolve(tenant_id, task_key)
        except TenantSelectionVetoedError:
            selections[task_key] = "vetoed"
        except TenantConfigUnavailableError as exc:
            raise PolicyVersionUnavailableError(
                f"{task_key!r} config for tenant {exc.tenant_id!r} could not be read"
            ) from exc

    safety = selections[TASK_KEY_GUARDRAIL_SAFETY]
    screen_policy = GuardrailPolicy.from_blob(
        getattr(safety, "policy", None) if safety != "vetoed" else None
    )
    settings = getattr(app_state, "settings", None)
    judge_max = getattr(getattr(settings, "judge", None), "max_input_chars", None)
    if judge_max is None:
        from guardrail.core.config import JudgePolicy

        judge_max = JudgePolicy().max_input_chars
    return compute_policy_version(
        selections=selections,
        screen_policy=screen_policy,
        judge_window_chars=judge_window_chars(screen_policy, int(judge_max)),
    )
