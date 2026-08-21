"""Fail-closed PHI redaction guard.

:class:`PhiRedactor` wraps Microsoft Presidio's :class:`AnalyzerEngine` +
:class:`AnonymizerEngine` and registers an extra clinical-identifier recognizer
(see :func:`_build_clinical_recognizer`). It exposes two entry points:

* :meth:`PhiRedactor.redact` — the low-level primitive: detect PHI and return the
  anonymized text plus the entities found. Exceptions propagate (the caller
  decides the failure policy).
* :meth:`PhiRedactor.ensure_safe_for_cloud` — the **fail-closed** egress gate.
  For any provider **not** listed in ``settings.phi.local_providers`` (i.e.
  every cloud provider, known or not) it redacts and *confirms* removal before
  returning the cleaned text; if the analyzer raises **or** removal cannot be
  confirmed, and ``fail_closed`` is set (the default), it RAISES
  :class:`PhiEgressBlocked` so **no** text egresses. For a *known-local*
  provider it is a pure pass-through (local calls are not egress) — this is a
  default-deny allowlist: an unrecognized provider string is treated as cloud,
  never as local.

Why a custom "confirm removal" check (not a re-analyze): after anonymization the
placeholders themselves (``<MRN>``) and leftover label words (``DOB``) get
re-flagged by spaCy NER (e.g. as ``ORGANIZATION``), so a naive re-analyze would
false-block clean output. Instead :meth:`_removal_confirmed` verifies that none
of the originally detected PHI *values* survive in the redacted text (after
stripping the ``<ENTITY>`` placeholders) — this still catches a silent anonymizer
failure (which would leave the raw values in place) without the placeholder noise.

Presidio (``presidio-analyzer`` / ``presidio-anonymizer`` / ``spacy`` + the
``en_core_web_lg`` model) is imported **lazily** so this module imports even when
the optional ``guardrails`` extra is absent — in which case the analyzer build
fails and, on a cloud egress, the fail-closed path refuses (no silent leak).
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:  # pragma: no cover - typing only
    from harness.core.config import Settings

# Presidio's recommended production NER model. Recorded here as the single source
# of truth; the integration phase / ops pull it via
# ``python -m spacy download en_core_web_lg``.
DEFAULT_SPACY_MODEL = "en_core_web_lg"

# Anonymizer placeholders look like ``<PERSON>`` / ``<MRN>``; strip them before
# the removal-confirmation substring check so a placeholder's own letters cannot
# be mistaken for residual PHI.
_PLACEHOLDER_RE = re.compile(r"<[A-Z_]+>")


class PhiModelUnavailable(RuntimeError):
    """Raised when the spaCy NER model backing Presidio is not installed.

    Deliberately NOT a trigger for an install: the redactor refuses rather than
    downloading. See :func:`_build_analyzer`.
    """


class PhiEgressBlocked(RuntimeError):
    """Raised when the fail-closed guard refuses to release text to a cloud provider."""

    def __init__(self, *, provider: str, reason: str) -> None:
        self.provider = provider
        self.reason = reason
        super().__init__(
            f"PHI egress to cloud provider {provider!r} blocked (fail-closed): {reason}"
        )


class RedactedEntity(BaseModel):
    """A single PHI span Presidio detected (offsets into the *original* text)."""

    model_config = ConfigDict(extra="forbid")

    entity_type: str
    start: int
    end: int
    score: float


class RedactionResult(BaseModel):
    """The outcome of :meth:`PhiRedactor.redact`: cleaned text + entities found."""

    model_config = ConfigDict(extra="forbid")

    text: str
    entities: list[RedactedEntity] = Field(default_factory=list)


def _build_clinical_recognizer() -> Any:
    """A lightweight regex recognizer for the **MRN** clinical identifier.

    Presidio's predefined recognizers cover the generic PHI in our crafted line
    (``PERSON`` via spaCy NER, ``PHONE_NUMBER``, ``DATE_TIME``) but have no notion
    of a Medical Record Number, so we add one here. It matches a labelled MRN
    (``MRN: 884512`` / ``Medical Record Number 884512``) at high confidence.

    JSL upgrade path: this regex recognizer is a deliberate stand-in. For
    production-grade clinical de-identification (MRN, account/encounter/visit IDs,
    provider IDs, device/biometric identifiers, …) register a John Snow Labs (JSL)
    clinical NER as a Presidio ``EntityRecognizer`` — wrap a spark-nlp
    ``MedicalNerModel`` / clinical ``deidentification`` pipeline and add it via
    ``analyzer.registry.add_recognizer(...)`` exactly like this one, so the rest of
    the guard (analyze → anonymize → confirm) is unchanged.
    """
    from presidio_analyzer import Pattern, PatternRecognizer

    patterns = [
        Pattern(name="mrn_labeled", regex=r"\bMRN\s*[:#-]?\s*\d{5,12}\b", score=0.9),
        Pattern(
            name="mrn_spelled",
            regex=r"\bmedical record (?:number|no\.?|#)\s*[:#-]?\s*\d{5,12}\b",
            score=0.9,
        ),
    ]
    return PatternRecognizer(
        supported_entity="MRN",
        patterns=patterns,
        context=["mrn", "medical record", "record number", "chart number"],
    )


def _build_analyzer(spacy_model: str) -> Any:
    """Build a Presidio ``AnalyzerEngine`` backed by the given spaCy model.

    The model must already be INSTALLED. Presidio's ``NlpEngineProvider`` otherwise
    "helpfully" downloads it (~400 MB from GitHub release assets) the first time a
    redaction runs — i.e. inside a PHI egress check, on a host that may be
    air-gapped, with the activity clock running, and (because spaCy's downloader
    shells out to pip and calls ``sys.exit``) surfacing as a bare ``SystemExit``
    rather than anything a caller can act on. Same posture as the nlp guard plane:
    an unusable model reference fails CLOSED with an attributable error and never
    reaches for the network.

    The raised :class:`PhiModelUnavailable` is converted by
    :meth:`PhiRedactor.ensure_safe_for_cloud` into a fail-closed
    :class:`PhiEgressBlocked`, so a missing model blocks cloud egress — it never
    degrades into an unredacted send. Stage the model with
    ``python -m spacy download en_core_web_lg`` at image-build time.
    """
    import spacy.util
    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider

    if not spacy.util.is_package(spacy_model):
        raise PhiModelUnavailable(
            f"spaCy model {spacy_model!r} is not installed, so PHI redaction cannot "
            "run. Install it at build time (`python -m spacy download "
            f"{spacy_model}`); it is never downloaded on demand."
        )

    provider = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": spacy_model}],
        }
    )
    analyzer = AnalyzerEngine(nlp_engine=provider.create_engine())
    analyzer.registry.add_recognizer(_build_clinical_recognizer())
    return analyzer


class PhiRedactor:
    """Presidio-backed PHI redactor with a fail-closed cloud-egress gate.

    The Presidio engines are built lazily on first use and cached, so the cheap
    paths (local pass-through, injected-engine tests) never load the spaCy model.
    Engines may be injected for testing.
    """

    def __init__(
        self,
        *,
        spacy_model: str = DEFAULT_SPACY_MODEL,
        analyzer: Any = None,
        anonymizer: Any = None,
    ) -> None:
        self._spacy_model = spacy_model
        self._analyzer = analyzer
        self._anonymizer = anonymizer

    def _get_analyzer(self) -> Any:
        if self._analyzer is None:
            self._analyzer = _build_analyzer(self._spacy_model)
        return self._analyzer

    def _get_anonymizer(self) -> Any:
        if self._anonymizer is None:
            from presidio_anonymizer import AnonymizerEngine

            self._anonymizer = AnonymizerEngine()
        return self._anonymizer

    def redact(self, text: str) -> RedactionResult:
        """Detect PHI in ``text`` and return the anonymized text + entities found."""
        analyzer = self._get_analyzer()
        results = analyzer.analyze(text=text, language="en")
        anonymized = self._get_anonymizer().anonymize(text=text, analyzer_results=results)
        entities = [
            RedactedEntity(entity_type=r.entity_type, start=r.start, end=r.end, score=r.score)
            for r in results
        ]
        return RedactionResult(text=anonymized.text, entities=entities)

    def ensure_safe_for_cloud(self, text: str, *, provider: str, settings: Settings) -> str:
        """Clear ``text`` for egress to ``provider`` (fail-closed for cloud).

        * ``provider`` in ``settings.phi.local_providers`` → local call, returned
          untouched (no redaction).
        * everything else (a known cloud provider OR an unrecognized provider
          string — default-deny) → redact + confirm removal. On analyzer failure
          or an unconfirmed removal: RAISE :class:`PhiEgressBlocked` when
          ``settings.phi.fail_closed`` (the default); otherwise degrade open
          (return the best-available text).
        """
        phi = settings.phi
        if provider in phi.local_providers:
            return text

        try:
            result = self.redact(text)
            confirmed = self._removal_confirmed(text, result)
        except Exception as exc:
            if phi.fail_closed:
                raise PhiEgressBlocked(
                    provider=provider, reason=f"redaction failed: {exc}"
                ) from exc
            return text

        if not confirmed:
            if phi.fail_closed:
                raise PhiEgressBlocked(provider=provider, reason="could not confirm PHI removal")
            return result.text
        return result.text

    @staticmethod
    def _removal_confirmed(original: str, result: RedactionResult) -> bool:
        """True iff no originally detected PHI value survives in the redacted text.

        Placeholders (``<MRN>``) are stripped first so their letters are not
        mistaken for residual PHI. An empty entity set means nothing was detected
        (nothing to remove) — confirmed.
        """
        if not result.entities:
            return True
        stripped = _PLACEHOLDER_RE.sub(" ", result.text)
        for ent in result.entities:
            value = original[ent.start : ent.end]
            if value and value in stripped:
                return False
        return True
