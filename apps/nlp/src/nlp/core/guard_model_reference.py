"""Resolve a guard-plane model REFERENCE to something the loader can open.

Owner addition, 2026-08-19: the gliner2 loader accepts either form —
`from_pretrained("<hub-id>")` or `from_pretrained("/path/on/disk")`. A model
reference stored in the catalog is therefore EITHER a Hugging Face hub id OR a
local filesystem path, and the catalog must not constrain it to a hub-id
pattern: a super admin (SYSTEM tier) and a tenant admin (tenant tier) may
legitimately configure either.

Resolution order is unchanged and lives in the CALLER: `AiRoutingPolicy` ⋈
`AiModel`, request tenant → SYSTEM, two tiers, fail closed (503) when
unresolved. This module answers only the last question — "given the resolved
row, what string do I hand the loader?"

Two forms, told apart WITHOUT touching the filesystem
=====================================================
A reference is LOCAL when it is path-SHAPED:

* a `file://` URI, or
* it begins with `/`, `~`, `./` or `../`.

Everything else is a hub id (`org/repo`, or a canonical bare name like
`bert-base-uncased`). The discrimination is syntactic on purpose: probing the
filesystem to decide would make the meaning of a stored value depend on what
happens to exist on a given node, so the same row would mean different things on
different hosts.

Failure posture — FAIL CLOSED
=============================
An unusable local path RAISES. It never falls through to a hub download. The
older `dependencies._weights_source` (mirrored from `apps/stt`) deliberately
warns and falls through, which is right for the NER plane and wrong here twice:
an air-gapped clinical host that staged its weights would start pulling from the
internet, and the service would serve a DIFFERENT model than the admin
configured with no error anywhere. For a safety plane that is a silent policy
change, so this module keeps its own posture rather than widening that one.

Security — a tenant-supplied filesystem path is an input
========================================================
A tenant admin can store an arbitrary path, so the value reaches
`open()` on a platform-operated node. What is done about it:

* the path is fully resolved (symlinks and `..` collapsed) BEFORE any check, so
  containment cannot be defeated by traversal;
* an operator may declare an allow-list of roots in `NLP_MODEL_LOCAL_ROOTS`
  (`os.pathsep`-separated). When set, a reference resolving outside every root
  is refused;
* **when it is NOT set, paths are unrestricted — deliberately, and documented
  here rather than silently.** Model staging is an operator activity on an
  operator-controlled filesystem, tenant admins are trusted operators under this
  platform's threat model, and the reachable damage is "load a file the service
  account can already read" rather than escalation. An operator running
  less-trusted tenants sets the allow-list; the mechanism exists precisely so
  that is a configuration decision and not a code change.

This is a bootstrap-floor TRANSPORT setting (which directories on this host are
legal), not model identity, taxonomy or policy — so it is legitimately env-tier.
"""

from __future__ import annotations

import os
from pathlib import Path

import structlog

logger = structlog.get_logger(__name__)

_ALLOWED_ROOTS_ENV = "NLP_MODEL_LOCAL_ROOTS"
_LOCAL_PREFIXES = ("/", "~", "./", "../")
_FILE_SCHEME = "file://"


class GuardModelReferenceError(RuntimeError):
    """A guard model reference cannot be turned into something loadable.

    The route maps this to 503 — the same fail-closed posture as an unresolved
    selection, because an unusable reference IS an unresolved selection.
    """


def is_local_reference(reference: str) -> bool:
    """True when `reference` is path-shaped (see the module docstring)."""
    candidate = (reference or "").strip()
    if not candidate:
        return False
    return candidate.startswith(_FILE_SCHEME) or candidate.startswith(_LOCAL_PREFIXES)


def _allowed_roots() -> list[str]:
    """Operator-declared legal roots for local references; empty = unrestricted."""
    raw = os.environ.get(_ALLOWED_ROOTS_ENV, "")
    return [part for part in raw.split(os.pathsep) if part.strip()]


def _to_path(reference: str) -> Path:
    candidate = reference[len(_FILE_SCHEME) :] if reference.startswith(_FILE_SCHEME) else reference
    return Path(candidate).expanduser()


def _check_containment(resolved: Path, model_id: str) -> None:
    roots = _allowed_roots()
    if not roots:
        return
    for root in roots:
        try:
            resolved.relative_to(Path(root).expanduser().resolve())
        except ValueError:
            continue
        return
    raise GuardModelReferenceError(
        f"model {model_id!r} resolves to {str(resolved)!r}, which is outside every "
        f"root declared in {_ALLOWED_ROOTS_ENV} ({os.pathsep.join(roots)}). "
        f"Stage the weights under an allowed root, or widen {_ALLOWED_ROOTS_ENV}."
    )


def _verify_local(reference: str, model_id: str, origin: str) -> str:
    path = _to_path(reference)
    # Resolve FIRST: containment must be checked on the real target, or a
    # symlink or `..` segment would walk straight out of an allowed root.
    resolved = path.resolve()
    _check_containment(resolved, model_id)

    if not resolved.exists():
        raise GuardModelReferenceError(
            f"model {model_id!r} declares {origin} {reference!r}, which does not exist "
            f"on this host. Refusing to fall back to a hub download: that would serve "
            f"a different model than the one configured."
        )
    if not os.access(resolved, os.R_OK):
        raise GuardModelReferenceError(
            f"model {model_id!r} declares {origin} {reference!r}, which exists but is "
            f"not readable by this service account."
        )
    logger.debug(
        "nlp.guard_model_reference.local_hit", model=model_id, path=str(resolved), origin=origin
    )
    return str(path) if not reference.startswith(_FILE_SCHEME) else str(resolved)


def resolve_guard_weights_source(model_name: str, model_path: str | None) -> str:
    """What to hand `GLiNER2.from_pretrained` for this catalog row.

    `model_path` (the `AiModel.localPath` column) wins when present — it is the
    explicit operator override. Otherwise the reference itself (`sourceUri`) is
    used, as a local path when path-shaped and as a hub id otherwise.
    """
    model_id = (model_name or "").strip()
    if not model_id:
        raise GuardModelReferenceError(
            "guard model reference is empty; selection is resolved by the caller "
            "from AiRoutingPolicy ⋈ AiModel and is fail-closed."
        )

    staged = (model_path or "").strip()
    if staged:
        return _verify_local(staged, model_id, "staged weights path")

    if is_local_reference(model_id):
        return _verify_local(model_id, model_id, "local model reference")

    return model_id
