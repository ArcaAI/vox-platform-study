"""TASK-1035 §5.0 — the harness half of the frozen ``apps/text`` ``/generate`` egress contract.

``apps/text`` owns LLM egress safety: it classifies each provider's locality, pseudonymizes on
cloud (deterministic ``known_phi`` replacement plus GLiNER2 spans), re-identifies the answer and
fails CLOSED — an absent or unknown locality is CLOUD. The harness's Presidio egress redactor is
retired from every ``/generate`` call; what the harness still owes text is what it KNOWS:

* :func:`provider_locality` — a stamp ONLY from the resolved model's deployment kind
  (``SELF_HOSTED`` ⇒ local, ``CLOUD``/``BYOK`` ⇒ cloud). A bare provider name never produces a
  stamp: text already knows which providers are engine-served, and a guessed ``local`` is the
  one wrong answer that would send raw PHI to a vendor.
* :func:`known_phi_from` — the identity values the harness holds (external patient id, MRN,
  names, staff id), so text replaces them deterministically on cloud.
* :func:`egress_counts` — the response's ``egress`` object, copied as COUNTS only.

The judge is the one LLM hop that does NOT go through ``/generate`` (it posts to its provider
directly), so its Presidio screen stays; :func:`is_local_direct_transport` is its local set, as
code — the env allowlist ``HARNESS_PHI_LOCAL_PROVIDERS`` is gone (no configuration in env).

Pure, total and dependency-free. Never logs a value.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

__all__ = [
    "KNOWN_PHI_MAX_ITEMS",
    "LOCAL_DIRECT_TRANSPORTS",
    "egress_counts",
    "is_local_direct_transport",
    "known_phi_from",
    "locality_from_deployment_kind",
    "provider_locality",
]

Locality = Literal["local", "cloud"]

#: `AiModel.deploymentKind` (`enums.prisma` `AiDeploymentKind`) → locality. Anything else ⇒ no stamp.
_DEPLOYMENT_KIND_LOCALITY: dict[str, Locality] = {
    "SELF_HOSTED": "local",
    "CLOUD": "cloud",
    "BYOK": "cloud",
}

#: §5.0 — `known_phi` bounds.
KNOWN_PHI_MAX_ITEMS = 200
_KNOWN_PHI_MIN_CHARS = 2
_KNOWN_PHI_MAX_CHARS = 200
_MAX_DEPTH = 4

#: Identity keys the harness may hold, compared case-insensitively with `_`/`-` removed, and the
#: taxonomy label each one is replaced under. Internal ids (`consultationId`, `userId`,
#: `patientId` UUIDs) are deliberately absent: they are not PHI and never travel.
_IDENTITY_KEY_LABELS: dict[str, str] = {
    "externalpatientid": "patient_id",
    "mrn": "mrn",
    "medicalrecordnumber": "mrn",
    "encounterid": "encounter_id",
    "patientname": "person",
    "patientfullname": "person",
    "clinicianname": "person",
    "doctorname": "person",
    "staffid": "staff_id",
}

#: Containers whose own `name` / `fullName` is a person's name.
_PERSON_CONTAINERS = frozenset({"patient", "clinician", "doctor", "practitioner"})
_PERSON_NAME_KEYS = frozenset({"name", "fullname", "displayname"})

#: Transports the judge reaches DIRECTLY that are self-hosted engines. Mirrors
#: `ENGINE_SERVED_PROVIDERS` (`ai-provider-connection/constants.ts`) plus the judge's own
#: OpenAI-compatible transport name and the platform `built-in` sentinel.
LOCAL_DIRECT_TRANSPORTS = frozenset(
    {"lm-studio", "lmstudio", "openai_compat", "ollama", "vllm", "llama-cpp", "built-in"}
)

_EGRESS_FIELDS = (
    "locality",
    "detected",
    "redacted",
    "restored",
    "images_unredacted",
    "pii_leak_blocked",
)


def locality_from_deployment_kind(kind: Any) -> Locality | None:
    """``SELF_HOSTED`` ⇒ ``local``; ``CLOUD``/``BYOK`` ⇒ ``cloud``; anything else ⇒ ``None``."""
    if not isinstance(kind, str) or not kind:
        return None
    return _DEPLOYMENT_KIND_LOCALITY.get(kind.strip().upper())


def provider_locality(provider: str | None, deployment_kind: Any) -> dict[str, Locality] | None:
    """The `provider_locality` stamp for ONE call, or ``None`` to let text decide."""
    locality = locality_from_deployment_kind(deployment_kind)
    if not provider or locality is None:
        return None
    return {provider: locality}


def _normalize_key(key: str) -> str:
    return key.replace("_", "").replace("-", "").lower()


def _collect(
    value: Any, parent: str, depth: int, out: list[dict[str, str]], seen: set[tuple[str, str]]
) -> None:
    if depth > _MAX_DEPTH or len(out) >= KNOWN_PHI_MAX_ITEMS:
        return
    if isinstance(value, list):
        for item in value:
            _collect(item, parent, depth + 1, out, seen)
        return
    if not isinstance(value, Mapping):
        return
    for raw_key, item in value.items():
        if len(out) >= KNOWN_PHI_MAX_ITEMS:
            return
        if not isinstance(raw_key, str):
            continue
        key = _normalize_key(raw_key)
        label = _IDENTITY_KEY_LABELS.get(key)
        if label is None and parent in _PERSON_CONTAINERS and key in _PERSON_NAME_KEYS:
            label = "person"
        if label is not None and isinstance(item, str):
            text = " ".join(item.split())[:_KNOWN_PHI_MAX_CHARS]
            identity = (label, text.casefold())
            if len(text) >= _KNOWN_PHI_MIN_CHARS and identity not in seen:
                seen.add(identity)
                out.append({"label": label, "value": text})
            continue
        if isinstance(item, Mapping | list):
            _collect(item, key, depth + 1, out, seen)


def known_phi_from(*sources: Any) -> list[dict[str, str]] | None:
    """The identity values held in ``sources`` as ``[{label, value}]``, or ``None`` when none.

    ``None`` rather than ``[]`` so the request omits the field entirely when there is nothing to
    say. Bounded to 200 items of ≤ 200 chars; values shorter than 2 chars are dropped.
    """
    out: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for source in sources:
        _collect(source, "", 0, out, seen)
    return out or None


def egress_counts(egress: Any) -> dict[str, Any] | None:
    """The response ``egress`` object restricted to the contract's count fields."""
    if not isinstance(egress, Mapping):
        return None
    counts = {field: egress[field] for field in _EGRESS_FIELDS if field in egress}
    return counts or None


def is_local_direct_transport(transport: str | None) -> bool:
    """Whether a DIRECT (non-``/generate``) LLM transport is a self-hosted engine."""
    return isinstance(transport, str) and transport in LOCAL_DIRECT_TRANSPORTS
