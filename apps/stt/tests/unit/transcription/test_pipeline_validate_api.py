"""POST /api/v1/pipelines/validate endpoint tests."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from stt.transcription.api.routes import router


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestPipelineValidateEndpoint:
    def test_valid_v2_config(self, client):
        yaml_str = (
            'version: "2.0"\n'
            "models:\n"
            '  asr: "transformer :: openai/whisper-large-v3-turbo"\n'
        )
        resp = client.post("/api/v1/pipelines/validate", json={"config_yaml": yaml_str})
        assert resp.status_code == 200
        body = resp.json()
        assert body["valid"] is True
        assert body["errors"] == []

    def test_parse_error_reported_not_raised(self, client):
        resp = client.post(
            "/api/v1/pipelines/validate", json={"config_yaml": "version: '1.0'\n"}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["valid"] is False
        assert body["errors"][0]["field"] == "config_yaml"
        assert "models" in body["errors"][0]["message"]

    def test_validation_errors_carry_fields(self, client):
        yaml_str = (
            'version: "2.0"\n'
            "models:\n  asr: m\n"
            "preprocessing:\n  denoise:\n    scope: sideways\n"
        )
        resp = client.post("/api/v1/pipelines/validate", json={"config_yaml": yaml_str})
        body = resp.json()
        assert body["valid"] is False
        assert any(e["field"] == "preprocessing.denoise.scope" for e in body["errors"])

    def test_unknown_provider_is_a_config_error(self, client):
        yaml_str = 'version: "2.0"\nmodels:\n  asr: "warp :: x/y"\n'
        resp = client.post("/api/v1/pipelines/validate", json={"config_yaml": yaml_str})
        body = resp.json()
        assert body["valid"] is False
        assert "Unknown ASR provider" in body["errors"][0]["message"]
