"""BUG-013 — the worker must address the job's OWNING tenant on every callback.

The Dramatiq actor receives ``tenant_id`` but used to drop it: the gateway
client's header set was fixed at construction (``X-Internal-Service-Key`` +
``Content-Type``), so the gateway derived the tenant from the API-key row
instead. That row is pinned to the platform default tenant, so every other
tenant's job 404'd on ``/start`` — and, because ``/fail`` 404'd by the same
mechanism, stranded at QUEUED with no error ever surfaced.

These tests pin the wire contract: every job-lifecycle call carries
``X-Internal-Tenant-Id``, and the actor forwards the tenant it was dispatched with.
"""

import importlib
from typing import Any

import httpx
import pytest

from stt.core.api_client.gateway import APIGatewayClient

TENANT = "50000000-0000-0000-0000-000000000001"


@pytest.fixture
def client() -> APIGatewayClient:
    return APIGatewayClient(base_url="http://gateway.test/api/v1", api_key="test-key")


class TestLifecycleCallsCarryTenantHeader:
    """Each of the five lifecycle calls must send X-Internal-Tenant-Id."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("method_name", "kwargs"),
        [
            ("start_job", {"job_id": "job-1", "worker_id": "worker-1"}),
            ("update_job_progress", {"job_id": "job-1", "progress": 42}),
            ("complete_job", {"job_id": "job-1", "result_text": "hello"}),
            ("fail_job", {"job_id": "job-1", "error_message": "boom"}),
            ("get_job_status", {"job_id": "job-1"}),
        ],
    )
    async def test_sends_tenant_header(
        self,
        client: APIGatewayClient,
        method_name: str,
        kwargs: dict[str, Any],
    ) -> None:
        captured: dict[str, Any] = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            captured["headers"] = request.headers
            return httpx.Response(200, json={"id": "job-1", "status": "PROCESSING"})

        client._client = httpx.AsyncClient(
            base_url=client.base_url,
            transport=httpx.MockTransport(handler),
            headers={
                "X-Internal-Service-Key": client.api_key,
                "Content-Type": "application/json",
            },
        )

        await getattr(client, method_name)(tenant_id=TENANT, **kwargs)

        assert captured["headers"]["x-internal-tenant-id"] == TENANT
        # The internal-service credential must still be presented — it is what
        # authorizes the tenant pin on the gateway side.
        assert captured["headers"]["x-internal-service-key"] == "test-key"

    @pytest.mark.asyncio
    async def test_omits_header_when_no_tenant_supplied(self, client: APIGatewayClient) -> None:
        """Backward compatible: no tenant ⇒ no header (gateway keeps today's behaviour)."""
        captured: dict[str, Any] = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            captured["headers"] = request.headers
            return httpx.Response(200, json={"status": "QUEUED"})

        client._client = httpx.AsyncClient(
            base_url=client.base_url,
            transport=httpx.MockTransport(handler),
        )

        await client.get_job_status("job-1")

        assert "x-internal-tenant-id" not in captured["headers"]

    @pytest.mark.asyncio
    async def test_create_transcript_sends_tenant_header(self, client: APIGatewayClient) -> None:
        """The batch transcript create resolves the job by id too — same 404 class."""
        captured: dict[str, Any] = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            captured["headers"] = request.headers
            return httpx.Response(200, json={"contextItemId": "ci-1"})

        client._client = httpx.AsyncClient(
            base_url=client.base_url,
            transport=httpx.MockTransport(handler),
        )

        await client.create_transcript(
            transcript_text="hello",
            job_id="job-1",
            consultation_id="c-1",
            tenant_id=TENANT,
        )

        assert captured["headers"]["x-internal-tenant-id"] == TENANT


class TestActorForwardsTenantId:
    """`transcribe_file` must thread its `tenant_id` argument into every call."""

    @pytest.mark.asyncio
    async def test_happy_path_forwards_tenant_to_every_lifecycle_call(self, monkeypatch) -> None:
        mod = importlib.import_module("stt.transcription.workers.transcribe_file")

        seen: dict[str, Any] = {}

        class FakeClient:
            async def get_job_status(self, job_id: str, tenant_id: str | None = None) -> str:
                seen["status"] = tenant_id
                return "PROCESSING"

            async def start_job(
                self, job_id: str, worker_id: str, tenant_id: str | None = None
            ) -> dict[str, Any]:
                seen["start"] = tenant_id
                return {}

            async def update_job_progress(
                self, job_id: str, progress: int, tenant_id: str | None = None
            ) -> dict[str, Any]:
                seen["progress"] = tenant_id
                return {}

            async def create_transcript(self, **kwargs: Any) -> dict[str, Any]:
                seen["transcript"] = kwargs.get("tenant_id")
                return {"contextItemId": "ci-1"}

            async def complete_job(self, **kwargs: Any) -> dict[str, Any]:
                seen["complete"] = kwargs.get("tenant_id")
                return {}

            async def fail_job(self, **kwargs: Any) -> dict[str, Any]:
                seen["fail"] = kwargs.get("tenant_id")
                return {}

            async def close(self) -> None:
                return None

        _install_worker_stubs(monkeypatch, mod, FakeClient())

        await mod._transcribe_file_async(
            job_id="job-1",
            tenant_id=TENANT,
            pipeline_id="p-1",
            audio_uri="s3://bucket/a.wav",
            consultation_id="c-1",
        )

        assert seen["start"] == TENANT
        assert seen["status"] == TENANT
        assert seen["progress"] == TENANT
        assert seen["complete"] == TENANT
        assert seen["transcript"] == TENANT

    @pytest.mark.asyncio
    async def test_failure_path_forwards_tenant_to_fail_job(self, monkeypatch) -> None:
        """The compounding failure: /fail must reach the owning tenant too, or a
        broken job can never be marked FAILED and strands at QUEUED forever."""
        mod = importlib.import_module("stt.transcription.workers.transcribe_file")

        seen: dict[str, Any] = {}

        class FakeClient:
            async def get_job_status(self, job_id: str, tenant_id: str | None = None) -> str:
                return "PROCESSING"

            async def start_job(
                self, job_id: str, worker_id: str, tenant_id: str | None = None
            ) -> dict[str, Any]:
                seen["start"] = tenant_id
                raise RuntimeError("gateway exploded")

            async def fail_job(self, **kwargs: Any) -> dict[str, Any]:
                seen["fail"] = kwargs.get("tenant_id")
                return {}

            async def close(self) -> None:
                return None

        _install_worker_stubs(monkeypatch, mod, FakeClient())

        with pytest.raises(RuntimeError):
            await mod._transcribe_file_async(
                job_id="job-1",
                tenant_id=TENANT,
                pipeline_id="p-1",
                audio_uri="s3://bucket/a.wav",
            )

        assert seen["start"] == TENANT
        assert seen["fail"] == TENANT


# ---------------------------------------------------------------------------
# Stubs — every collaborator of the actor except the gateway client.
# ---------------------------------------------------------------------------


def _install_worker_stubs(monkeypatch, mod: Any, api_client: Any) -> None:
    class FakeResolver:
        def set_tenant_storage(self, *a: Any, **k: Any) -> None: ...
        def set_tenant_bucket(self, *a: Any, **k: Any) -> None: ...

    class FakeBlobService:
        _resolver = FakeResolver()

        async def download_audio(self, uri: str, tenant_id: str | None = None) -> bytes:
            return b"\x00" * 16

        async def upload_transcript(self, **kwargs: Any) -> str:
            return "s3://bucket/t.json"

        async def upload_batch_metadata(self, **kwargs: Any) -> str:
            return "s3://bucket/m.json"

    class FakeInference:
        language: str | None = None

    class FakeSpec:
        inference = FakeInference()

    class FakePipelineConfig:
        spec = FakeSpec()

    class FakePipelineReader:
        async def get_pipeline(self, pipeline_id: str) -> FakePipelineConfig:
            return FakePipelineConfig()

    class FakeResult:
        text = "hello world"
        transcript_uri: str | None = None
        duration_seconds = 1.0
        processing_time_seconds = 1.0
        engine: str | None = None
        deployment: str | None = None
        metadata: dict[str, Any] = {}

        def to_dict(self) -> dict[str, Any]:
            return {"text": self.text}

        def build_transcript_segments(self) -> list[dict[str, Any]]:
            return []

    class FakeBatchService:
        async def transcribe(self, **kwargs: Any) -> FakeResult:
            progress_callback = kwargs.get("progress_callback")
            if progress_callback:
                progress_callback(50)
            return FakeResult()

    class FakePublisher:
        async def connect(self) -> None: ...
        async def publish_status(self, *a: Any, **k: Any) -> None: ...
        async def publish_progress(self, *a: Any, **k: Any) -> None: ...
        async def publish_chunk(self, *a: Any, **k: Any) -> None: ...
        async def publish_transcript(self, *a: Any, **k: Any) -> None: ...
        async def publish_error(self, *a: Any, **k: Any) -> None: ...
        async def close(self) -> None: ...

    class FakeEffectiveConfigClient:
        async def get_provider_overrides(self, tenant_id: str) -> dict[str, Any]:
            return {}

    async def _noop_refresh() -> None:
        return None

    monkeypatch.setattr(mod, "refresh_job_concurrency_limit", _noop_refresh)
    monkeypatch.setattr(mod, "get_api_client", lambda: api_client)
    monkeypatch.setattr(mod, "get_blob_service", lambda: FakeBlobService())
    monkeypatch.setattr(mod, "get_pipeline_reader", lambda: FakePipelineReader())
    monkeypatch.setattr(mod, "get_batch_service", lambda: FakeBatchService())
    monkeypatch.setattr(mod, "TranscriptionEventPublisher", FakePublisher)
    monkeypatch.setattr(mod, "get_effective_config_client", lambda: FakeEffectiveConfigClient())
