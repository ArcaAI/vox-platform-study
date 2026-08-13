"""Pluggable golden-set sources.

The golden set is read through a small :class:`GoldenSetSource` interface so the
source is swappable: today a synthetic JSON fixture ships with the package;
tomorrow a clinician-authored set (DB/S3/Git) can be dropped in by implementing
``load`` — no runner changes required.

.. note::
   **OPEN PREREQUISITE (HLD §7.5 #1 / #3).** The shipped
   fixture is *synthetic* and exists only to exercise the harness end-to-end and
   keep CI hermetic. The Phase-0 exit gate ("golden set ≥50 cases scored; judge
   ICC ≥0.8") requires the **REAL clinician-authored golden set** — transcript→note
   cases across specialties/tenants, owned + versioned by a clinical SME. That
   set is an outstanding prerequisite and MUST replace this fixture before any
   eval result is used to gate a clinical claim.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from harness.eval.models import GoldenCase, GoldenSet

FIXTURES_DIR = Path(__file__).parent / "fixtures"
DEFAULT_FIXTURE = FIXTURES_DIR / "synthetic_v0.json"

# The REAL clinician-authored set (Phase-0 exit prerequisite). It does not exist
# until SMEs author it; ``ClinicalGoldenSetSource`` fails loudly rather than
# silently falling back to a synthetic set. Authored in the rich multi-rater
# format described by ``clinical_v1.schema.json`` (see golden/clinical_v1_spec.md).
CLINICAL_FIXTURE = FIXTURES_DIR / "clinical_v1.json"
CLINICAL_SCHEMA = FIXTURES_DIR / "clinical_v1.schema.json"
CLINICAL_TEMPLATE_FIXTURE = FIXTURES_DIR / "clinical_v1.template.json"

# Sentinel that marks a case as a non-clinical TEMPLATE/PLACEHOLDER (also settable
# at document level via the top-level ``"template": true`` key).
_TEMPLATE_PROVENANCE = "TEMPLATE-PLACEHOLDER"

# Rich-schema keys that map 1:1 onto a ``GoldenCase`` field. Everything else in a
# clinical case (pdsqi_raters, adjudication, claims, safety_truth, deidentification,
# provenance, ...) is preserved under ``GoldenCase.metadata`` by the projection, so
# the runtime model is unchanged while no authored detail is lost.
_GOLDEN_CASE_NATIVE_KEYS = frozenset(
    {
        "case_id",
        "source_documents",
        "generated_note",
        "target_specialty",
        "role",
        "reference_note",
        "contexts",
        "clinician_pdsqi",
    }
)


@runtime_checkable
class GoldenSetSource(Protocol):
    """Anything that can produce a :class:`GoldenSet`."""

    def load(self) -> GoldenSet: ...


class InMemoryGoldenSetSource:
    """Wraps an already-constructed golden set (tests / programmatic use)."""

    def __init__(self, golden_set: GoldenSet) -> None:
        self._golden_set = golden_set

    def load(self) -> GoldenSet:
        return self._golden_set


class JSONFileGoldenSetSource:
    """Loads a golden set from a JSON file on disk."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> GoldenSet:
        if not self._path.is_file():
            raise FileNotFoundError(f"golden set file not found: {self._path}")
        data = json.loads(self._path.read_text(encoding="utf-8"))
        return GoldenSet.model_validate(data)


def default_golden_set_source() -> JSONFileGoldenSetSource:
    """The packaged synthetic golden set (see the module note / TODO)."""
    return JSONFileGoldenSetSource(DEFAULT_FIXTURE)


def _case_is_template(raw: dict[str, Any]) -> bool:
    """A case is a placeholder when its ``metadata.label_provenance`` is the sentinel."""
    metadata = raw.get("metadata") or {}
    return str(metadata.get("label_provenance", "")).upper() == _TEMPLATE_PROVENANCE


def project_clinical_case(raw: dict[str, Any]) -> GoldenCase:
    """Project a rich ``clinical_v1`` case onto the runtime :class:`GoldenCase`.

    The adjudicated consensus ``clinician_pdsqi`` becomes the human reference the
    judge is calibrated against; every other authored field (per-rater labels,
    adjudication, claim/safety ground truth, de-identification, provenance) is
    folded into ``metadata`` so the existing ICC gate works unchanged and no
    detail is dropped. Native keys are never duplicated into ``metadata``.
    """
    base: dict[str, Any] = {key: raw[key] for key in _GOLDEN_CASE_NATIVE_KEYS if key in raw}
    metadata = dict(raw.get("metadata") or {})
    for key, value in raw.items():
        if key not in _GOLDEN_CASE_NATIVE_KEYS and key != "metadata":
            metadata.setdefault(key, value)
    base["metadata"] = metadata
    return GoldenCase.model_validate(base)


class ClinicalGoldenSetSource:
    """Loads the REAL clinician-authored golden set (rich ``clinical_v1`` format).

    Reads a document authored against ``clinical_v1.schema.json`` and projects each
    case onto a :class:`GoldenCase` (see :func:`project_clinical_case`) so it is a
    drop-in :class:`GoldenSetSource` for the runner + the judge↔clinician ICC gate.

    **Integrity guard.** A document flagged as a TEMPLATE/PLACEHOLDER — top-level
    ``"template": true`` or any case whose ``metadata.label_provenance`` is
    ``"TEMPLATE-PLACEHOLDER"`` — is REFUSED (raises ``ValueError``) unless
    ``allow_template=True`` is passed explicitly. This makes it structurally
    impossible for placeholder data to silently gate a clinical calibration claim;
    ``allow_template=True`` is reserved for schema/CI smoke-tests.
    """

    def __init__(self, path: str | Path, *, allow_template: bool = False) -> None:
        self._path = Path(path)
        self._allow_template = allow_template

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> GoldenSet:
        if not self._path.is_file():
            raise FileNotFoundError(
                f"clinical golden set not found: {self._path}. The real clinician-authored "
                f"set is an open Phase-0 prerequisite — author it from {CLINICAL_TEMPLATE_FIXTURE.name} "
                "per golden/clinical_v1_spec.md."
            )
        data = json.loads(self._path.read_text(encoding="utf-8"))
        cases = data.get("cases", [])
        is_template = bool(data.get("template", False)) or any(_case_is_template(c) for c in cases)
        if is_template and not self._allow_template:
            raise ValueError(
                f"refusing to load TEMPLATE/PLACEHOLDER clinical golden set {self._path}: "
                "it contains placeholder (non-clinical) cases and must never gate a clinical "
                "claim. Replace the placeholders with real, de-identified, multi-rater-labeled "
                "cases per golden/clinical_v1_spec.md, or pass allow_template=True only for a "
                "schema/CI smoke-test."
            )
        return GoldenSet(
            version=data["version"],
            name=data.get("name", "clinical-golden-set"),
            description=data.get("description", ""),
            cases=[project_clinical_case(c) for c in cases],
        )


def clinical_golden_set_source(*, allow_template: bool = False) -> ClinicalGoldenSetSource:
    """The real clinician-authored set (``clinical_v1.json``).

    Raises ``FileNotFoundError`` until SMEs author it — there is deliberately no
    synthetic fallback so a clinical calibration claim can never run on a fixture.
    """
    return ClinicalGoldenSetSource(CLINICAL_FIXTURE, allow_template=allow_template)
