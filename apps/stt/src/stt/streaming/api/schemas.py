"""Request/response schemas for the internal streaming session API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class CreateStreamingSessionRequest(BaseModel):
    """Request body for ``POST /internal/streaming/sessions``."""

    session_id: str = Field(..., description="Unique session identifier (UUID)")
    tenant_id: str = Field(..., description="Tenant identifier")
    pipeline_id: str = Field(
        ...,
        description=(
            "The session's runtime key: `resolved_spec.runtimeKey` (the ASR Agent "
            "VERSION id) on the agent path, or — DEPRECATED (TASK-861, removed in R4) — "
            "an AsrPipeline UUID/slug this service still looks up in Postgres."
        ),
    )
    resolved_spec: dict[str, Any] | None = Field(
        default=None,
        description=(
            "TASK-861 — the gateway-resolved ASR runtime contract (ResolvedAsrSpec, "
            "packages/types asr-spec.ts). When present the engine chain, its models, "
            "the fallback and the decoder prompt come from it and this service reads "
            "nothing from Postgres. Absent ⇒ the deprecated pipeline_id path."
        ),
    )
    voice_profiles: list[dict[str, Any]] | None = Field(
        default=None,
        description=(
            "TASK-887 — the end-user's ENROLLED voice profiles for THIS agent's speaker-embedding model, resolved and pushed by the gateway: [{profile_id, label, model_id, embedding}]. Diarization labels a matched segment with the profile's label and everything else `Speaker N`; a profile from another model is ignored, never re-projected. Biometric PHI — held in memory for the run only, never persisted here, never logged."
        ),
    )
    consultation_id: str | None = Field(default=None, description="Optional consultation context")
    sample_rate: int = Field(default=16000, description="Audio sample rate in Hz")
    microphone_id: str | None = Field(
        default=None, description="Identifier for the microphone device"
    )
    user_id: str | None = Field(
        default=None, description="Authenticated user ID for speaker pre-seeding"
    )
    language: str | None = Field(
        default=None, description="Override pipeline language (ISO 639-1/639-3 code)"
    )
    language_mode: str | None = Field(
        default=None,
        description=(
            "End-user language mode id, e.g. 'en', 'ml', 'ml-en' "
            "(Malayalam+English code-switch), 'auto'. Resolved against the "
            "session's engine into language/code_switching/streaming_english_gloss. "
            "Takes precedence over 'language'. An engine that cannot serve the "
            "mode is excluded from the session chain; if none qualifies, 422."
        ),
    )
    audio_bucket_name: str | None = Field(
        default=None,
        description="Tenant-scoped audio bucket name. Defaults to 'hope-audio' if not provided.",
    )
    storage: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Optional per-tenant storage provider descriptor (provider, bucket, "
            "credentials). When present, selects the MinIO/S3/Azure provider and "
            "bucket for this tenant; when absent, the global MinIO client and "
            "'audio_bucket_name' are used."
        ),
    )
    provider_overrides: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Optional per-tenant BYO cloud-provider credential map, "
            "gateway-injected: {provider: {api_key, region?, base_url?, model?}}. "
            "Held by the session runtime IN MEMORY ONLY — never persisted, never "
            "logged. Preferred over env creds by the cloud ASR loaders."
        ),
    )
    fallback_pipeline_id: str | None = Field(
        default=None,
        description=(
            "Optional tenant fallback pipeline. When set, the session "
            "can swap its live ASR engine to it on create-time load failure, "
            "classified outage, or a user-initiated switch."
        ),
    )
    start_on: str | None = Field(
        default=None,
        description=(
            "'primary' (default) or 'fallback' — open the session directly on the "
            "tenant fallback engine while keeping the primary switchable. "
            "When 'fallback' but no fallback is configured, the "
            "session proceeds on the primary (fail-open)."
        ),
    )
    auto_switch_enabled: bool | None = Field(
        default=None,
        description=(
            "Tenant governance for the FAILURE-DRIVEN auto switch. "
            "None ⇒ the engine-switch controller's default (enabled), so an "
            "older gateway that omits it keeps the previous behaviour. Never "
            "affects a user-initiated switch — that is an explicit choice."
        ),
    )
    consecutive_failure_threshold: int | None = Field(
        default=None,
        ge=1,
        description=(
            "Tenant governance for how many consecutive threshold-class "
            "utterance failures arm the auto switch. None ⇒ the "
            "controller's default (2)."
        ),
    )
    channel_count: int = Field(
        default=1,
        ge=1,
        description=(
            "Number of distinct microphone SOURCES mixed into this session. "
            "Stored and echoed on the teardown summary so the "
            "usage row is repriceable; the audio itself is always one mono "
            "uplink, so this is a metadata signal, not a PCM channel count."
        ),
    )


class SwitchProviderRequest(BaseModel):
    """Request body for ``POST /internal/streaming/sessions/{id}/switch``.

    ``target`` names the engine to switch to. Absent ⇒ ``'fallback'`` (one-way
    back-compat with the original switch-to-fallback route).
    """

    target: Literal["primary", "fallback"] = Field(
        default="fallback",
        description="Engine to switch to: 'primary' or 'fallback' (default 'fallback').",
    )


class SwitchProviderResponse(BaseModel):
    """Response for ``POST /internal/streaming/sessions/{id}/switch``."""

    switched: bool = Field(..., description="Whether the requested switch was accepted")
    active: Literal["primary", "fallback"] = Field(
        ..., description="The engine that will be live after the accepted switch"
    )


class StreamingSessionResponse(BaseModel):
    """Response for session creation and status queries."""

    session_id: str
    status: str = Field(..., description="Session status: active, finalizing, closed, rejected")
    reason: str | None = Field(default=None, description="Rejection reason (e.g. 'at_capacity')")
    max_concurrent: int = Field(..., description="Maximum concurrent sessions for this worker")
    current_active: int = Field(..., description="Number of currently active sessions")
    pipeline_id: str = Field(
        ..., description="The ASR pipeline id this session is (or was) opened with"
    )
    active_engine: str = Field(
        ...,
        description=("The engine currently live for this session: 'primary' or 'fallback'"),
    )


class StreamingUsageSegment(BaseModel):
    """One engine's total time in a session — one `transcribe.stream` ledger row.

    A session can change ASR engines mid-flight (auto on a classified outage,
    or manually in either direction), and fallback to the platform default is a
    METERED platform HA capability, so billing follows ENGINE-TIME: the tenant's
    BYO minutes meter `BYOK` and the platform fallback's meter `CLOUD`. Segments
    are aggregated per `(engine, deployment, connection_id)` — a session that toggles
    primary -> fallback -> primary yields TWO, not three — and sum exactly to the
    summary's own `audio_seconds` / `session_seconds`.
    """

    engine: str = Field(..., description="Usage-ledger engine id that served this segment")
    deployment: str = Field(
        ..., description="SELF_HOSTED | CLOUD | BYOK, derived from the row that served"
    )
    audio_seconds: float = Field(..., ge=0, description="Decoded audio seconds on this engine")
    session_seconds: float = Field(..., ge=0, description="Wall-clock seconds on this engine")
    connection_id: str | None = Field(
        default=None,
        description=(
            "AiProviderConnection id that served this segment; null when the "
            "sender named none. A tenant may hold several connections for one "
            "vendor, so `engine` alone cannot separate their spend."
        ),
    )


class StreamingSessionTeardownResponse(BaseModel):
    """Response for a REAL ``DELETE /internal/streaming/sessions/{id}``
    teardown.

    The usage-attribution summary the API Gateway needs to emit the
    ``transcribe.stream`` ledger row (AUDIO_SECOND + SESSION_SECOND). STT has
    no notion of "interrupted" — the gateway decides that from WHICH code
    path called removeSession (explicit close vs. resume-grace expiry) and
    stamps it into ``attributesJson`` itself; this summary is identical
    either way. The idempotent "session already gone" branch of the DELETE
    route returns 204 with NO body instead — nothing new to summarize.
    """

    session_id: str
    tenant_id: str
    consultation_id: str | None = None
    user_id: str | None = None
    pipeline_id: str
    closed_at: str = Field(
        ...,
        description="ISO-8601 teardown instant (session.close()'s stamp) — the ledger event's occurredAt",
    )
    audio_seconds: float = Field(
        ..., description="Decoded audio seconds ingested (total_duration_seconds)"
    )
    session_seconds: float = Field(..., description="Wall-clock socket open->close seconds")
    engine: str | None = Field(
        default=None,
        description="Usage-ledger engine id resolved from the loaded ASR model; null if none loaded",
    )
    deployment: str | None = Field(
        default=None, description="SELF_HOSTED | CLOUD | BYOK; null alongside a null engine"
    )
    connection_id: str | None = Field(
        default=None,
        description=(
            "AiProviderConnection id of the last engine to serve; null when none "
            "was named. Declared here because this model is the DELETE route's "
            "response_model and is `extra='ignore'` — a summary key the schema "
            "does not declare is dropped before it reaches the gateway."
        ),
    )
    segments: list[StreamingUsageSegment] = Field(
        default_factory=list,
        description=(
            "Per-engine usage breakdown; one ledger row each. Empty when no ASR "
            "model was ever resolved. ADDITIVE to the engine/deployment scalars "
            "above, which stay the last-loaded engine for an older gateway."
        ),
    )
    language_mode: str | None = Field(
        default=None, description="End-user language mode id, e.g. 'ml-en'"
    )
    channel_count: int = Field(
        default=1,
        ge=1,
        description=(
            "Distinct microphone source count for this session, "
            "echoed for usage repricing; 1 for a single-mic session."
        ),
    )


class StreamingAvailabilityResponse(BaseModel):
    """Response for ``GET /internal/streaming/availability``."""

    available: bool = Field(
        ..., description="Whether the streaming module is initialized and has capacity"
    )
    status: str = Field(..., description="Module status: ready, not_initialized, at_capacity")
    max_concurrent: int = Field(default=0, description="Maximum concurrent sessions")
    current_active: int = Field(default=0, description="Currently active sessions")
    available_slots: int = Field(default=0, description="Remaining available slots")
