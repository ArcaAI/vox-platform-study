"""Tests for response_model annotations on all endpoints and new response models."""

from __future__ import annotations

import pathlib

import pytest

from text.main import create_app
from text.models.responses import (
    ComponentCheckResponse,
    ErrorResponse,
    HealthResponse,
    LivenessResponse,
    ReadinessResponse,
)


@pytest.fixture()
def openapi_schema():
    app = create_app()
    return app.openapi()


class TestOpenAPIResponseSchemas:
    """Verify that every endpoint declares a response_model so the OpenAPI spec is accurate."""

    def test_health_response_model_in_openapi(self, openapi_schema):
        health_op = openapi_schema["paths"]["/api/v1/health"]["get"]
        assert "200" in health_op["responses"]

    def test_liveness_response_model_in_openapi(self, openapi_schema):
        live_op = openapi_schema["paths"]["/api/v1/health/live"]["get"]
        assert "200" in live_op["responses"]

    def test_readiness_response_model_in_openapi(self, openapi_schema):
        ready_op = openapi_schema["paths"]["/api/v1/health/ready"]["get"]
        assert "200" in ready_op["responses"]

    def test_generate_response_model_in_openapi(self, openapi_schema):
        gen_op = openapi_schema["paths"]["/api/v1/generate"]["post"]
        responses = gen_op["responses"]
        assert "200" in responses, "generate endpoint must declare a 200 response schema"
        ref_200 = responses["200"]["content"]["application/json"]["schema"].get("$ref", "")
        assert "GenerateResponse" in ref_200

        # the 202-and-poll envelope is gone — a streaming
        # request gets 200 + `text/event-stream`, which has no JSON schema to
        # declare. What replaced it in the contract is the 409 an
        # `Idempotency-Key` reused with a different payload returns
        assert "202" not in responses, "the 202-and-poll indirection was removed"
        assert "409" in responses, "generate endpoint must declare idempotency_conflict"

    def test_generate_error_responses_in_openapi(self, openapi_schema):
        gen_op = openapi_schema["paths"]["/api/v1/generate"]["post"]
        responses = gen_op["responses"]
        for code in ("404", "422", "429", "502", "503"):
            assert code in responses, f"generate endpoint must declare a {code} error response"
            ref = responses[code]["content"]["application/json"]["schema"].get("$ref", "")
            assert "ErrorResponse" in ref

    def test_tasks_get_response_model_in_openapi(self, openapi_schema):
        task_op = openapi_schema["paths"]["/api/v1/tasks/{task_id}"]["get"]
        assert "200" in task_op["responses"]
        resp_content = task_op["responses"]["200"]["content"]["application/json"]
        ref = resp_content["schema"].get("$ref", "")
        assert "TaskResponse" in ref

    def test_tasks_cancel_response_model_in_openapi(self, openapi_schema):
        cancel_op = openapi_schema["paths"]["/api/v1/tasks/{task_id}/cancel"]["post"]
        assert "200" in cancel_op["responses"]
        resp_content = cancel_op["responses"]["200"]["content"]["application/json"]
        ref = resp_content["schema"].get("$ref", "")
        assert "TaskResponse" in ref

    def test_providers_response_model_in_openapi(self, openapi_schema):
        prov_op = openapi_schema["paths"]["/api/v1/providers"]["get"]
        assert "200" in prov_op["responses"]
        resp_content = prov_op["responses"]["200"]["content"]["application/json"]
        schema = resp_content["schema"]
        assert schema.get("type") == "array" or "items" in schema


class TestResponseModelSerialization:
    """Verify new response models can be constructed and round-trip through JSON."""

    def test_health_response_serialization(self):
        resp = HealthResponse(
            status="healthy",
            service="text",
            version="2.0.0",
            uptime_seconds=10.0,
            timestamp="2025-01-01T00:00:00Z",
            checks={
                "ollama": ComponentCheckResponse(status="healthy", duration_ms=1.5),
                "azure": ComponentCheckResponse(status="unhealthy", duration_ms=2.0),
            },
        )
        data = resp.model_dump()
        assert data["status"] == "healthy"
        assert data["checks"]["ollama"]["status"] == "healthy"
        assert data["checks"]["azure"]["status"] == "unhealthy"

    def test_health_response_json_round_trip(self):
        resp = HealthResponse(
            status="degraded",
            service="text",
            version="2.0.0",
            uptime_seconds=5.0,
            timestamp="2025-01-01T00:00:00Z",
            checks={},
        )
        json_str = resp.model_dump_json()
        restored = HealthResponse.model_validate_json(json_str)
        assert restored.status == "degraded"
        assert restored.checks == {}

    def test_liveness_response_serialization(self):
        resp = LivenessResponse(status="healthy")
        data = resp.model_dump()
        assert data["status"] == "healthy"

    def test_readiness_response_serialization(self):
        resp = ReadinessResponse(status="healthy")
        data = resp.model_dump()
        assert data["status"] == "healthy"
        assert data["message"] is None

    def test_readiness_response_not_ready(self):
        resp = ReadinessResponse(status="unhealthy", message="No healthy providers available")
        data = resp.model_dump()
        assert data["status"] == "unhealthy"
        assert "No healthy" in data["message"]

    def test_error_response_serialization(self):
        resp = ErrorResponse(detail="Something went wrong")
        data = resp.model_dump()
        assert data["detail"] == "Something went wrong"

    def test_error_response_json_round_trip(self):
        resp = ErrorResponse(detail="Not found")
        json_str = resp.model_dump_json()
        restored = ErrorResponse.model_validate_json(json_str)
        assert restored.detail == "Not found"


class TestPyTypedMarker:
    """Verify the py.typed marker file exists for PEP 561 compliance."""

    def test_py_typed_exists(self):
        marker = pathlib.Path(__file__).resolve().parents[2] / "py.typed"
        assert marker.exists(), f"py.typed marker must exist at {marker}"
        assert marker.is_file()
