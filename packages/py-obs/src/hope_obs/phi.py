"""PHI-safe helpers for telemetry (TASK-987 R-3/R-7).

``docs/operations/telemetry-phi-guardrails.md`` is the policy; this module is
the emitter-side half of it. Two rules it exists to make mechanical:

1. **No clinical content on any span or log line, at any level, including
   DEBUG** — no transcript, prompt, completion, summary, note or entity text.
2. **No raw identifier on a log line.** ``redact_id`` is the only sanctioned way
   an id reaches one.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any, Protocol

#: Attributes an HTTP instrumentation is free to attach if body capture is ever
#: switched on. On this fleet those bodies are audio, clinical text and
#: generated notes, so they are redacted unconditionally rather than gated on a
#: capture flag nobody re-reads.
BODY_ATTRIBUTES = ("http.request.body.content", "http.response.body.content")

REDACTED = "[REDACTED]"


class SpanLike(Protocol):
    """The span surface the instrumentation hook actually uses."""

    attributes: Mapping[str, Any] | None

    def is_recording(self) -> bool: ...

    def set_attribute(self, key: str, value: Any) -> None: ...


def phi_sanitization_hook(span: SpanLike, scope: dict[str, Any]) -> None:
    """``server_request_hook`` for ``FastAPIInstrumentor.instrument_app``.

    Passed **unconditionally** by ``hope_obs``. "The hook exists but is never
    passed" is a defect this fleet has already shipped twice — once in NLP
    (fixed), once in STT (finding F-13, on the one service whose payloads are
    clinical audio). Making it an argument nobody can forget is the fix.

    ``scope`` is the ASGI scope; it is accepted because the hook contract
    requires it, and deliberately not read — nothing in it is needed to redact.
    """
    if not span.is_recording():
        return
    attributes = span.attributes or {}
    for attribute in BODY_ATTRIBUTES:
        if attribute in attributes:
            span.set_attribute(attribute, REDACTED)


def redact_id(value: object | None) -> str:
    """Return a PHI-safe, stable token for an identifier in a log record.

    Raw user ids, consultation ids, session labels and names must never appear
    in log output. A short SHA-256 prefix keeps lines correlatable — the same
    input always yields the same token — without exposing the underlying value.
    ``None`` and empty values render as ``"-"`` so a missing id is visibly
    missing rather than a plausible-looking hash.

    Promoted from ``apps/stt/src/stt/core/logging.py`` unchanged, including the
    12-character width: short enough to read in a log line, long enough that a
    collision inside one service's retention window is not a practical concern.
    """
    if value is None or value == "":
        return "-"
    digest = hashlib.sha256(str(value).encode("utf-8")).hexdigest()
    return digest[:12]
