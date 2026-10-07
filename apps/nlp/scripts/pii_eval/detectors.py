"""Model-agnostic detectors.

`Detector` is the only thing the scorer knows. Adapters exist for the two GLiNER2
incumbents (through the nlp service's own loader), Presidio, a generic Hugging Face
token-classification checkpoint and a deterministic regex baseline. The model adapters
are STUBS in this phase: `load()` refuses unless the owner's approval switch is set, so
nothing here can pull weights by accident.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Sequence
from typing import Any, Protocol, runtime_checkable

from . import labels as L
from .spans import Detection, dedupe_longest
from .verhoeff import verhoeff_valid

APPROVAL_ENV = "HOPE_1049_ALLOW_MODEL_LOAD"


class ModelLoadNotApproved(RuntimeError):
    """The owner has not approved loading models for this evaluation."""


def ensure_load_approved(what: str) -> None:
    if os.environ.get(APPROVAL_ENV) != "1":
        raise ModelLoadNotApproved(
            f"refusing to load {what}: model loads need the owner's approval "
            f"(set {APPROVAL_ENV}=1 only after it is given)"
        )


@runtime_checkable
class Detector(Protocol):
    name: str

    def detect(self, text: str) -> list[Detection]: ...

    def detect_batch(self, texts: Sequence[str]) -> list[list[Detection]]: ...


class _Base:
    name = "detector"

    def detect(self, text: str) -> list[Detection]:
        return self.detect_batch([text])[0]

    def detect_batch(self, texts: Sequence[str]) -> list[list[Detection]]:
        return [self.detect(t) for t in texts]


class FakeDetector(_Base):
    """Test double: `fn(text) -> list[Detection]`."""

    def __init__(self, fn: Callable[[str], list[Detection]], name: str = "fake") -> None:
        self._fn = fn
        self.name = name

    def detect(self, text: str) -> list[Detection]:
        return list(self._fn(text))

    def detect_batch(self, texts: Sequence[str]) -> list[list[Detection]]:
        return [self.detect(t) for t in texts]


# ------------------------------------------------------------------------- regex
_MONTH = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
    r"Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
)
# (label, pattern, group). group 0 = whole match; otherwise the keyword-anchored value.
_REGEXES: tuple[tuple[str, re.Pattern[str], int], ...] = (
    (L.EMAIL, re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"), 0),
    (L.ABHA, re.compile(r"\b[A-Za-z0-9._-]+@(?:abdm|sbx)\b"), 0),
    (L.URL, re.compile(r"https?://[^\s,;)\"']+"), 0),
    (
        L.IP_ADDRESS,
        re.compile(
            r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d|\.\d)"
        ),
        0,
    ),
    (L.PAN, re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"), 0),
    (L.ABHA, re.compile(r"(?<!\d)\d{2}-\d{4}-\d{4}-\d{4}(?!\d)"), 0),
    (L.ABHA, re.compile(r"(?i)\bABHA\b\W{0,12}(\d{14})(?!\d)"), 1),
    (L.PHONE, re.compile(r"(?<![\w+])\+91[\s-]?[6-9]\d{4}[\s-]?\d{5}(?!\d)"), 0),
    (L.PHONE, re.compile(r"(?<![\w+])0?[6-9]\d{4}[\s-]?\d{5}(?!\d)"), 0),
    (L.PHONE, re.compile(r"(?<![\w+])0\d{2,4}[\s-]\d{6,8}(?!\d)"), 0),
    (
        L.PHONE,
        re.compile(r"(?<![\w+])\+(?!91)\d{1,3}[\s-]?\d{2,4}[\s-]\d{3,4}[\s-]\d{3,4}(?!\d)"),
        0,
    ),
    (
        L.PIN_CODE,
        re.compile(r"(?i)\b(?:pin(?:[\s-]?code)?|postal code|zip)\W{0,4}([1-9]\d{5})(?!\d)"),
        1,
    ),
    (L.PIN_CODE, re.compile(r"(?<=[A-Za-z], )([1-9]\d{5})(?!\d)"), 1),
    (L.MRN, re.compile(r"\b(?:MRN|UHID)\b[\s:#.-]*([A-Z0-9][A-Z0-9-]{4,})"), 1),
    (
        L.INSURANCE_ID,
        re.compile(
            r"(?i)\b(?:policy|insurance|member|PMJAY|ECHS)\b[^\n\d]{0,24}?([A-Z0-9][A-Z0-9-]{5,})"
        ),
        1,
    ),
    (
        L.DEVICE_ID,
        re.compile(r"(?i)\b(?:serial|device id|IMEI)\b[^\n\w]{0,10}([A-Z0-9][A-Z0-9-]{4,})"),
        1,
    ),
    (L.DATE, re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b"), 0),
    (L.DATE, re.compile(r"\b\d{4}-\d{2}-\d{2}\b"), 0),
    (L.DATE, re.compile(rf"\b\d{{1,2}}(?:st|nd|rd|th)? {_MONTH}\.? \d{{4}}\b"), 0),
    (L.DATE, re.compile(rf"\b{_MONTH}\.? \d{{1,2}}(?:st|nd|rd|th)?, \d{{4}}\b"), 0),
)
_AADHAAR = re.compile(r"(?<!\d)[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?!\d)")


class RegexDetector(_Base):
    """Deterministic baseline for STRUCTURED identifiers. No names, no free-text addresses."""

    name = "regex"

    def detect(self, text: str) -> list[Detection]:
        found: list[Detection] = []
        for label, pattern, group in _REGEXES:
            for m in pattern.finditer(text):
                s, e = m.span(group)
                if e > s:
                    found.append(Detection(label, s, e, 1.0, raw_label=label))
        for m in _AADHAAR.finditer(text):
            digits = re.sub(r"\D", "", m.group(0))
            if verhoeff_valid(digits):
                found.append(Detection(L.AADHAAR, m.start(), m.end(), 1.0, raw_label=L.AADHAAR))
        return dedupe_longest(found)


class HybridDetector(_Base):
    """A model plus the regex baseline. On overlap the regex span wins for structured IDs."""

    def __init__(self, model: Detector, regex: Detector | None = None) -> None:
        self.model = model
        self.regex = regex or RegexDetector()
        self.name = f"{model.name}+regex"

    def load(self) -> None:
        getattr(self.model, "load", lambda: None)()

    def detect_batch(self, texts: Sequence[str]) -> list[list[Detection]]:
        modelled = self.model.detect_batch(texts)
        out: list[list[Detection]] = []
        for text, from_model in zip(texts, modelled, strict=True):
            structured = self.regex.detect(text)
            kept = [
                d
                for d in from_model
                if not any(r.start < d.end and d.start < r.end for r in structured)
            ]
            out.append(sorted([*kept, *structured], key=lambda d: d.start))
        return out


# ----------------------------------------------------------------- model adapters
class Gliner2Detector(_Base):
    """A GLiNER2 PII checkpoint, loaded through the nlp service's own `Gliner2GuardService`."""

    def __init__(
        self,
        model_id: str,
        *,
        labels: Sequence[str],
        threshold: float = 0.5,
        weights_source: str | None = None,
        device: str = "cpu",
        batch_size: int = 8,
    ) -> None:
        self.model_id = model_id
        self.name = f"gliner2:{model_id.split('/')[-1]}"
        self.labels = list(labels)
        self.threshold = threshold
        self.weights_source = weights_source or model_id
        self.device = device
        self.batch_size = batch_size
        self._service: Any = None

    def load(self) -> None:
        ensure_load_approved(self.model_id)
        from nlp.services.gliner2_guard import Gliner2GuardService

        service = Gliner2GuardService(self.weights_source, self.model_id, device=self.device)
        service.load()
        self._service = service

    def detect_batch(self, texts: Sequence[str]) -> list[list[Detection]]:
        if self._service is None:
            raise RuntimeError("Gliner2Detector.load() has not been called")
        raw = self._service._sync_batch_extract(
            list(texts), self.labels, self.threshold, self.batch_size
        )
        return [
            [
                Detection(
                    L.canonical(e["label"], L.GLINER_LABEL_MAP),
                    e["start"],
                    e["end"],
                    float(e["score"]),
                    raw_label=e["label"],
                )
                for e in entities
            ]
            for entities in raw
        ]


_PRESIDIO_MAP = {
    "PERSON": L.PERSON,
    "EMAIL_ADDRESS": L.EMAIL,
    "PHONE_NUMBER": L.PHONE,
    "DATE_TIME": L.DATE,
    "LOCATION": L.ADDRESS,
    "URL": L.URL,
    "IP_ADDRESS": L.IP_ADDRESS,
    "IN_PAN": L.PAN,
    "IN_AADHAAR": L.AADHAAR,
    "IN_VEHICLE_REGISTRATION": L.OTHER,
    "IN_VOTER": L.ID,
    "IN_PASSPORT": L.ID,
    "MEDICAL_LICENSE": L.ID,
    "US_SSN": L.ID,
    "US_DRIVER_LICENSE": L.ID,
    "US_PASSPORT": L.ID,
    "NRP": L.OTHER,
}


class PresidioDetector(_Base):
    """Presidio analyzer (rules + spaCy NER). Needs the spaCy model: a load, so gated."""

    name = "presidio"

    def __init__(self, *, language: str = "en", score_threshold: float = 0.35) -> None:
        self.language = language
        self.score_threshold = score_threshold
        self._engine: Any = None

    def load(self) -> None:
        ensure_load_approved("presidio-analyzer (spaCy model)")
        from presidio_analyzer import AnalyzerEngine

        self._engine = AnalyzerEngine()

    def detect(self, text: str) -> list[Detection]:
        if self._engine is None:
            raise RuntimeError("PresidioDetector.load() has not been called")
        results = self._engine.analyze(
            text=text, language=self.language, score_threshold=self.score_threshold
        )
        return [
            Detection(
                _PRESIDIO_MAP.get(r.entity_type, L.OTHER),
                r.start,
                r.end,
                float(r.score),
                raw_label=r.entity_type,
            )
            for r in results
        ]


#: Label vocabularies of the i2b2-2014-trained de-identification encoders, canonicalised.
HF_DEID_LABEL_MAP: dict[str, str] = {
    "patient": L.PATIENT_NAME,
    "staff": L.CLINICIAN,
    "hcw": L.CLINICIAN,
    "doctor": L.CLINICIAN,
    "person": L.PERSON,
    "name": L.PERSON,
    "age": L.AGE,
    "date": L.DATE,
    "phone": L.PHONE,
    "email": L.EMAIL,
    "id": L.ID,
    "idnum": L.ID,
    "url": L.URL,
    "ipaddr": L.IP_ADDRESS,
    "loc": L.ADDRESS,
    "location": L.ADDRESS,
    "street": L.ADDRESS,
    "city": L.ADDRESS,
    "zip": L.PIN_CODE,
    "hosp": L.OTHER,
    "hospital": L.OTHER,
    "patorg": L.OTHER,
    "vendor": L.OTHER,
    "organization": L.OTHER,
    "otherphi": L.OTHER,
}


class HfTokenClassDetector(_Base):
    """Any `transformers` token-classification checkpoint (clinical de-id encoders)."""

    def __init__(
        self,
        model_id: str,
        *,
        label_map: dict[str, str] | None = None,
        revision: str | None = None,
        trust_remote_code: bool = False,
        min_score: float = 0.5,
    ) -> None:
        self.model_id = model_id
        self.name = f"hf:{model_id.split('/')[-1]}"
        self.label_map = label_map or HF_DEID_LABEL_MAP
        self.revision = revision
        self.trust_remote_code = trust_remote_code
        self.min_score = min_score
        self._pipe: Any = None

    def load(self) -> None:
        ensure_load_approved(self.model_id)
        from transformers import pipeline

        self._pipe = pipeline(
            "token-classification",
            model=self.model_id,
            revision=self.revision,
            aggregation_strategy="simple",
            trust_remote_code=self.trust_remote_code,
            device=-1,
        )

    def detect(self, text: str) -> list[Detection]:
        if self._pipe is None:
            raise RuntimeError("HfTokenClassDetector.load() has not been called")
        out: list[Detection] = []
        for ent in self._pipe(text):
            if float(ent["score"]) < self.min_score:
                continue
            raw = str(ent.get("entity_group") or ent.get("entity") or "")
            key = re.sub(r"^[BIES]-", "", raw).lower()
            out.append(
                Detection(
                    self.label_map.get(key, L.OTHER),
                    int(ent["start"]),
                    int(ent["end"]),
                    float(ent["score"]),
                    raw_label=raw,
                )
            )
        return out
