"""Shared 422 handler: PHI-safe body, PHI-safe log line."""

from __future__ import annotations

import io
import json
from collections.abc import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from hope_obs import ObservabilityConfig, configure_observability

Capture = Callable[[], io.StringIO]

SECRET = "patient-John-Smith-MRN-99887"


class Body(BaseModel):
    age: int
    name: str


@pytest.fixture
def client(capture_log_output: Capture) -> tuple[TestClient, io.StringIO]:
    app = FastAPI()

    @app.post("/things")
    def create(body: Body) -> dict[str, str]:
        return {"ok": "1"}

    configure_observability(app, ObservabilityConfig(service_name="svc"))
    return TestClient(app), capture_log_output()


def test_422_body_has_loc_msg_type_and_never_input(
    client: tuple[TestClient, io.StringIO],
) -> None:
    http, _ = client
    response = http.post("/things", json={"age": SECRET, "name": 5})

    assert response.status_code == 422
    body = response.json()
    assert set(body) == {"detail"}
    for item in body["detail"]:
        assert set(item) == {"loc", "msg", "type"}
    assert {tuple(item["loc"]) for item in body["detail"]} == {("body", "age"), ("body", "name")}
    assert SECRET not in response.text
    assert '"input"' not in response.text


def test_validation_failure_logs_loc_and_type_only(
    client: tuple[TestClient, io.StringIO],
) -> None:
    http, stream = client
    http.post("/things", json={"age": SECRET, "name": "ok"}, headers={"X-Request-Id": "rid-1"})

    lines = [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]
    (line,) = [entry for entry in lines if entry["event"] == "hope.request.validation_failed"]
    assert line["level"] == "warning"
    assert line["violations"] == [{"loc": ["body", "age"], "type": "int_parsing"}]
    assert line["requestId"] == "rid-1"
    assert SECRET not in stream.getvalue()
