"""NLP PHI span-redaction hook is actually wired.

`_phi_sanitization_hook` used to live in `nlp/core/observability.py`, defined
since the module was written and **never passed to the instrumentor** — dead
code. TEXT's identical hook *was* wired
(`server_request_hook=_phi_sanitization_hook`), so the two services silently
disagreed about whether request/response bodies get scrubbed off spans. NLP
receives clinical text on every request, so an unhooked FastAPI instrumentor
was free to attach request/response bodies to spans that land in Tempo.

TASK-987 lane E deleted NLP's local `_phi_sanitization_hook` and
`_instrument_fastapi` entirely: PHI redaction now comes from
`hope_obs.phi.phi_sanitization_hook`, which `hope_obs.tracing.
instrument_fastapi` passes to `FastAPIInstrumentor` UNCONDITIONALLY — there is
no argument for switching it off, so the "hook exists but is never passed"
failure mode this file exists to catch cannot recur. This file now pins two
things: that NLP's own (redundant) copies are gone, and that
`setup_opentelemetry` actually reaches the shared hook when tracing is
enabled.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from hope_obs.phi import phi_sanitization_hook

from nlp.core.config import settings as nlp_settings


class TestLocalCopiesAreGone:
    def test_no_local_phi_hook_or_instrument_wrapper_survives(self) -> None:
        import nlp.core.observability as obs

        for name in ("_phi_sanitization_hook", "_instrument_fastapi"):
            assert not hasattr(obs, name), (
                f"{name} survived the TASK-987 move to hope_obs — a service-local "
                "copy is exactly the drift this fleet has shipped twice already."
            )


class TestSetupOpentelemetryWiresTheSharedHook:
    def test_instrument_fastapi_is_called_with_the_shared_phi_hook(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)

        from nlp.core.observability import setup_opentelemetry, shutdown_opentelemetry

        app = FastAPI()
        # `hope_obs.tracing.instrument_fastapi` imports `FastAPIInstrumentor`
        # LAZILY, inside the function body (so `import hope_obs` works in a
        # worker with no FastAPI installed) — patch it at its true home,
        # `opentelemetry.instrumentation.fastapi`, not on `hope_obs.tracing`,
        # which never binds the name at module scope.
        with patch("opentelemetry.instrumentation.fastapi.FastAPIInstrumentor") as instrumentor_cls:
            instrument_app_mock = instrumentor_cls.instrument_app
            setup_opentelemetry(app)
        try:
            assert instrument_app_mock.call_count == 1
            kwargs = instrument_app_mock.call_args.kwargs
            assert kwargs.get("server_request_hook") is phi_sanitization_hook, (
                "setup_opentelemetry must reach hope_obs.phi.phi_sanitization_hook "
                "via hope_obs.tracing.instrument_fastapi; otherwise it is dead "
                "code again and request bodies reach Tempo (OBS-19)."
            )
        finally:
            shutdown_opentelemetry(app)


class TestSharedHookRedactsBodies:
    """`hope_obs.phi.phi_sanitization_hook` redacts
    `http.request.body.content`/`http.response.body.content` — the current
    attribute names (finding F-13's fix moved these off NLP's old
    `http.request.body`/`http.response.body` spelling; both were always
    hypothetical, since neither FastAPI nor this fleet captures request
    bodies onto spans by default — the hook exists for the day someone turns
    that capture on)."""

    def test_hook_redacts_request_and_response_bodies(self) -> None:
        span = MagicMock()
        span.is_recording.return_value = True
        span.attributes = {
            "http.request.body.content": '{"patient": "John Doe"}',
            "http.response.body.content": '{"diagnosis": "flu"}',
        }

        phi_sanitization_hook(span, {})

        redacted = {call.args[0] for call in span.set_attribute.call_args_list}
        assert redacted == {"http.request.body.content", "http.response.body.content"}
        for call in span.set_attribute.call_args_list:
            assert call.args[1] == "[REDACTED]"

    def test_hook_is_a_noop_on_a_non_recording_span(self) -> None:
        """A sampled-out span must not be touched — cheap, and avoids surprises."""
        span = MagicMock()
        span.is_recording.return_value = False

        phi_sanitization_hook(span, {})

        span.set_attribute.assert_not_called()
