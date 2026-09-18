"""Text's own GenAI-span helpers, plus a `get_tracer` compatibility shim.

Tracing SETUP (the `TracerProvider`, the OTLP exporter, FastAPI/httpx
instrumentation, the PHI `server_request_hook`) moved to `hope_obs` and is wired
once in `text.main.create_app` via `configure_observability` (TASK-987). What
stays here is TEXT-SPECIFIC: the `gen_ai.*` semantic-convention attribute
stamper every provider adapter uses, and a `get_tracer` wrapper so the eight
`text.providers.*` modules (plus a few tests) that import
`text.core.telemetry.get_tracer` keep working unchanged — rewriting eight call
sites for a package-relocation with no behavioural difference would balloon
this diff for nothing.

`docs/operations/telemetry-phi-guardrails.md` — `gen_ai.*` is TEXT's namespace
alone (`hope_obs`'s R-7 note); this module is where it is allowed to live.
"""

from __future__ import annotations

from typing import Any

from hope_obs import get_tracer as _hope_get_tracer
from opentelemetry.trace import Tracer

__all__ = ["get_tracer", "set_generation_span_attributes"]


def get_tracer(name: str = "text") -> Tracer:
    """Same signature every provider module has always called; delegates to hope_obs."""
    return _hope_get_tracer(name)


def set_generation_span_attributes(
    span: Any,
    *,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    finish_reasons: list[str],
) -> None:
    """Stamp OpenTelemetry GenAI semantic-convention attributes on a generation
    span.

    No-op when there is no recording span (invalid/no-op span, tracing disabled),
    so it is always safe to call from the request path.
    """
    if span is None:
        return
    is_recording = getattr(span, "is_recording", None)
    if callable(is_recording) and not is_recording():
        return
    span.set_attribute("gen_ai.system", provider)
    span.set_attribute("gen_ai.request.model", model)
    span.set_attribute("gen_ai.usage.input_tokens", input_tokens)
    span.set_attribute("gen_ai.usage.output_tokens", output_tokens)
    span.set_attribute("gen_ai.response.finish_reasons", finish_reasons)
