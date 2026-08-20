"""NLP PHI span-redaction hook is actually wired.

`_phi_sanitization_hook` has existed in `nlp/core/observability.py` since the
module was written and was **never passed to the instrumentor** — dead code.
TEXT's identical hook *is* wired (`server_request_hook=_phi_sanitization_hook`),
so the two services silently disagreed about whether request/response bodies
get scrubbed off spans.

That matters the moment tracing is enabled fleet-wide: NLP
receives clinical text on every request, and an unhooked FastAPI instrumentor
is free to attach request/response bodies to spans that land in Tempo.

There are TWO `instrument_app` call sites — one for the provider-configured
path and one for the fallback. Both must carry the hook; wiring only the first
leaves a silent hole on the branch that runs when no OTLP endpoint is set.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from fastapi import FastAPI


def test_phi_hook_is_passed_to_instrumentor_on_both_paths() -> None:
    from nlp.core import observability as obs

    for tracer_provider in (MagicMock(name="provider"), None):
        app = FastAPI()
        with patch.object(obs, "FastAPIInstrumentor") as instrumentor_cls:
            instance = instrumentor_cls.return_value
            obs._instrument_fastapi(app, tracer_provider)

        assert instance.instrument_app.call_count == 1
        kwargs = instance.instrument_app.call_args.kwargs
        assert kwargs.get("server_request_hook") is obs._phi_sanitization_hook, (
            "The PHI sanitisation hook must be wired to the instrumentor "
            f"(tracer_provider={'set' if tracer_provider else 'None'}); "
            "otherwise it is dead code and request bodies reach Tempo (OBS-19)."
        )


def test_hook_redacts_request_and_response_bodies() -> None:
    from nlp.core.observability import _phi_sanitization_hook

    span = MagicMock()
    span.is_recording.return_value = True

    _phi_sanitization_hook(span, {})

    redacted = {call.args[0] for call in span.set_attribute.call_args_list}
    assert "http.request.body" in redacted
    assert "http.response.body" in redacted
    for call in span.set_attribute.call_args_list:
        assert call.args[1] == "[REDACTED]"


def test_hook_is_a_noop_on_a_non_recording_span() -> None:
    """A sampled-out span must not be touched — cheap, and avoids surprises."""
    from nlp.core.observability import _phi_sanitization_hook

    span = MagicMock()
    span.is_recording.return_value = False

    _phi_sanitization_hook(span, {})

    span.set_attribute.assert_not_called()
