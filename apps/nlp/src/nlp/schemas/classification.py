from pydantic import BaseModel, Field

from nlp.schemas.clinical_taxonomy import ClinicalTaxonomy
from nlp.schemas.common import Entity, SupportedLanguage

# REST

# Text Classification


class TextClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")
    language: SupportedLanguage | None = Field(
        default=SupportedLanguage.ENGLISH, description="Language of the text"
    )
    # Optional per-request model override (gateway-injected from the
    # AiTaskDefault registry). None → the startup default instance, unchanged.
    model_name: str | None = Field(
        default=None, description="Optional HF model id overriding the default classifier"
    )
    # Gateway-injected `AiModel.localPath`. Registry-derived,
    # never caller-chosen; absent ⇒ load by `model_name` exactly as before.
    model_path: str | None = Field(
        default=None,
        description="Optional local weights directory (gateway-injected AiModel.localPath)",
    )


class TextClassificationResponse(BaseModel):
    predicted_label: str = Field(..., description="Top predicted classification label")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Classification confidence")
    probabilities: dict[str, float] = Field(..., description="All class probabilities")
    model_version: str = Field(..., description="Text classification model version")


# Multi-label text classification (owner decision 2026-08-20,
#
# `nlp.toxicity` is MULTI-LABEL: an utterance may be simultaneously toxic +
# threat + insult, which the single-`predicted_label` shape above cannot
# express (it forces one mutually-exclusive winner). This is a SEPARATE
# request/response pair, not a conditional reshape of
# `TextClassificationRequest`/`Response` — `nlp.sentiment` and
# `nlp.classification` stay on the single-label shape unchanged.
#
# No taxonomy is invented here: the label set is whatever the selected
# model's own classification head exposes (its `id2label`), exactly like
# `TextClassificationResponse.probabilities` today. `cls_threshold` is the
# ONLY new policy value, and it is gateway-injected the same way
# `model_name`/`model_path` are — sourced from the winning
# `AiModel._metadata.labelTaxonomy` row (the `labelTaxonomy.tasks.<taskKey>`
# shape already used for guardrail's GLiNER2 classification, mirrored here
# for a transformers sequence-classification checkpoint).


class MultiLabelClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")
    language: SupportedLanguage | None = Field(
        default=SupportedLanguage.ENGLISH, description="Language of the text"
    )
    model_name: str | None = Field(
        default=None,
        description="Gateway-injected AiModel.sourceUri; required, fails closed with 503",
    )
    model_path: str | None = Field(
        default=None,
        description="Optional local weights directory (gateway-injected AiModel.localPath)",
    )
    # Gateway-injected from the selected model's own
    # `AiModel._metadata.labelTaxonomy` row (mirrors `LabelTaxonomyTask.cls_threshold`).
    # Independent per-label decision boundary — NOT a softmax top-1 pick, so
    # zero, one, or several labels may all clear it on the same input.
    cls_threshold: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description="Per-label score threshold for a label to count as a positive",
    )


class MultiLabelClassificationResponse(BaseModel):
    predicted_labels: list[str] = Field(
        ...,
        description=(
            "Labels at/above cls_threshold — the simultaneous positives (e.g. "
            "['toxic', 'insult'] together). May be empty (nothing cleared the "
            "threshold) or contain more than one label at once."
        ),
    )
    scores: dict[str, float] = Field(
        ...,
        description=(
            "Per-label score for EVERY label the model's own head exposes — the "
            "model's own taxonomy, never invented here. Independent scores, not "
            "required to sum to 1."
        ),
    )
    threshold: float = Field(..., description="The cls_threshold actually applied")
    model_version: str = Field(..., description="Text classification model version")


# Token Classification


class TokenClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")
    # Absent ⇒ the SELECTED CHECKPOINT's declared strategy
    # (`clinicalTaxonomy.tokenClassifier.aggregationStrategy`) applies. It used
    # to default to "simple" here, which silently outranked the model row's own
    # declaration on every request — a schema default that made the stored value
    # unreachable. An explicit caller value still wins.
    aggregation_strategy: str | None = Field(
        default=None, description="Entity aggregation strategy; absent => the model row's own"
    )
    # The CLINICAL TAXONOMY this call executes against :
    # ontology vocabulary, vitals plausibility bands, ConText/NegEx triggers and
    # the checkpoint's own NER contract. The gateway resolves it from
    # `AiModel._metadata.clinicalTaxonomy` on the row `nlp.ner` selects and
    # injects it here, exactly as it already injects `model_name`/`model_path`.
    # Absent ⇒ each pass it governs is DISABLED — never a code literal. See
    # `nlp.schemas.clinical_taxonomy` for the full fail posture.
    clinical_taxonomy: ClinicalTaxonomy | None = Field(
        default=None,
        description="Gateway-resolved AiModel._metadata.clinicalTaxonomy. Absent => enrichment passes are disabled.",
    )
    language: SupportedLanguage | None = Field(
        default=SupportedLanguage.ENGLISH, description="Language of the text"
    )
    # Optional per-request model override (gateway-injected from the
    # AiTaskDefault registry). None → the startup default instance, unchanged.
    model_name: str | None = Field(
        default=None, description="Optional HF model id overriding the default NER model"
    )
    # Gateway-injected `AiModel.localPath`.
    model_path: str | None = Field(
        default=None,
        description="Optional local weights directory (gateway-injected AiModel.localPath)",
    )


class Vitals(BaseModel):
    """Structured vital signs deterministically extracted from clinical text.

    Every field is optional and null-safe: an un-parsed or out-of-range value
    stays ``None`` (never fabricated). Blood pressure is reported as separate
    systolic/diastolic integers.
    """

    systolic: int | None = Field(default=None, description="Systolic blood pressure (mmHg)")
    diastolic: int | None = Field(default=None, description="Diastolic blood pressure (mmHg)")
    heart_rate: int | None = Field(default=None, description="Heart rate (bpm)")
    spo2: int | None = Field(default=None, description="Oxygen saturation (%)")
    temperature_c: float | None = Field(default=None, description="Temperature (°C)")
    weight_kg: float | None = Field(default=None, description="Weight (kg)")

    def has_any(self) -> bool:
        """True when at least one vital was extracted."""
        return any(
            value is not None
            for value in (
                self.systolic,
                self.diastolic,
                self.heart_rate,
                self.spo2,
                self.temperature_c,
                self.weight_kg,
            )
        )


class TokenClassificationResponse(BaseModel):
    entities: list[Entity] = Field(..., description="Extracted entities")
    model_version: str = Field(..., description="Token classification model version")
    vitals: Vitals | None = Field(
        default=None,
        description="Deterministically extracted vital signs (BP/HR/SpO2/temp/weight); None when none were found.",
    )


# Topic / Intent Classification — OPEN-taxonomy tasks delegated to
# `text` via ExternalTextClient. Unlike `/classify/text`, these carry the
# gateway-injected tenant instructions (topic list / intent list, resolved
# server-side from `TenantNlpTaskInstructions`) AND `tenant_id` (forwarded as
# `X-Tenant-Id` to `text`) — the gateway injects a request-body field here the
# same way it injects `model_name`/`model_path` on `/classify/text`, keeping
# apps/nlp stateless (it never resolves tenant config itself).


class TopicClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")
    language: SupportedLanguage | None = Field(
        default=SupportedLanguage.ENGLISH, description="Language of the text"
    )
    # Gateway-injected from TenantNlpTaskInstructions (nlp.topic). A missing
    # or empty list fails closed (503) — there is no meaningful "classify
    # into no topics" default, mirroring /classify/text's fail-closed
    # missing-model_name posture.
    instructions: list[str] | None = Field(
        default=None,
        description="Tenant's topic list (gateway-injected from TenantNlpTaskInstructions)",
    )
    tenant_id: str | None = Field(
        default=None, description="Gateway-injected tenant id, forwarded to text as X-Tenant-Id"
    )


class TopicClassificationResponse(BaseModel):
    predicted_topic: str = Field(
        ..., description="The topic label text selected, from the tenant's instructed list"
    )
    available_topics: list[str] = Field(
        default_factory=list, description="The tenant's topic list this call was constrained to"
    )


class IntentClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")
    language: SupportedLanguage | None = Field(
        default=SupportedLanguage.ENGLISH, description="Language of the text"
    )
    # Gateway-injected from TenantNlpTaskInstructions (nlp.intent).
    instructions: list[str] | None = Field(
        default=None,
        description="Tenant's intent list (gateway-injected from TenantNlpTaskInstructions)",
    )
    tenant_id: str | None = Field(
        default=None, description="Gateway-injected tenant id, forwarded to text as X-Tenant-Id"
    )


class IntentClassificationResponse(BaseModel):
    predicted_intent: str = Field(
        ..., description="The intent label text selected, from the tenant's instructed list"
    )
    available_intents: list[str] = Field(
        default_factory=list, description="The tenant's intent list this call was constrained to"
    )


# WebSocket
#
# The socket carries its tenant PER MESSAGE. A connection is long-lived and a
# handshake header cannot be re-sent, so attribution has to travel with the work
# rather than with the connection — and these routes carried no tenant at all
# before. Cross-checked against `X-Tenant-Id` from the handshake when present.


# Text Classification


class WebSocketTextClassifyIncoming(TextClassificationRequest):
    tenant_id: str | None = Field(
        default=None, description="Gateway-injected tenant id for this message"
    )


class WebSocketTextClassifyOutgoing(TextClassificationResponse):
    pass


# Token Classification


class WebSocketTokenClassifyIncoming(TokenClassificationRequest):
    tenant_id: str | None = Field(
        default=None, description="Gateway-injected tenant id for this message"
    )


class WebSocketTokenClassifyOutgoing(TokenClassificationResponse):
    pass
