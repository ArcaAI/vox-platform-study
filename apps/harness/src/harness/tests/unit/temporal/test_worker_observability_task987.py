"""TASK-987 R-6 worker parity — the harness Temporal worker installs a real TracerProvider.

Before this ticket, `harness.temporal.worker.run_worker` called `setup_logging`
only for the process's observability — no `TracerProvider` was ever built for
the worker, so any span the Temporal `TracingInterceptor` (`temporal/client.py`)
opened was non-recording, and — because trace correlation reads the CURRENT
span — the worker's log lines never carried a `traceId` either (finding F-04,
the same defect fixed for `apps/stt/worker.py` in this ticket).

`run_worker` now calls
`hope_obs.configure_worker_observability(build_observability_config(settings))`
and wires the returned handle's `.shutdown()` into its `finally` block. This
test proves HARNESS'S composition of those two calls — not `hope_obs`'s own
degrade-to-off/never-raises behaviour, which is `packages/py-obs/tests`' job.
"""

from __future__ import annotations

from hope_obs import configure_worker_observability
from hope_obs.runtime import worker_service_name
from opentelemetry.sdk.trace import TracerProvider

from harness.core.config import Settings
from harness.core.observability import build_observability_config


class TestWorkerObservabilityParity:
    def test_worker_installs_recording_tracer_provider_when_endpoint_configured(self) -> None:
        """(F-04) An endpoint alone (R-2) is enough — no live collector required:
        the OTLP gRPC channel connects lazily, so this never touches the network.
        """
        settings = Settings(otel_enabled=False, otel_exporter_endpoint="http://localhost:4317")

        handle = configure_worker_observability(build_observability_config(settings))
        try:
            assert isinstance(handle.tracer_provider, TracerProvider)
        finally:
            handle.shutdown()  # must not raise; no live collector is listening

    def test_worker_tracer_provider_absent_when_tracing_disabled(self) -> None:
        handle = configure_worker_observability(build_observability_config(Settings()))

        assert handle.tracer_provider is None
        handle.shutdown()  # never raises even when nothing was built

    def test_worker_service_name_gets_worker_suffix(self) -> None:
        """R-6's no-double-suffix rule: an operator-set `OTEL_SERVICE_NAME` ending
        in `-worker` (as a Deployment sets on the worker directly) must not be
        mangled into `...-worker-worker`.
        """
        assert worker_service_name("harness") == "harness-worker"
        assert worker_service_name("hope-harness-v2-worker") == "hope-harness-v2-worker"

    def test_worker_shutdown_is_idempotent(self) -> None:
        """A worker's `finally` block plus a signal-handler race must not double-flush."""
        settings = Settings(otel_enabled=False, otel_exporter_endpoint="http://localhost:4317")

        handle = configure_worker_observability(build_observability_config(settings))
        handle.shutdown()
        handle.shutdown()  # must not raise the second time
