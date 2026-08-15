"""E2E tests for real-time SSE generation of pre-summaries and summaries.

Verifies the full streaming flow:
  1. POST /generate with stream=true → 202 with task_id + stream_url
  2. GET /tasks/{task_id}/stream → SSE stream with chunks + [DONE]

Requires a running Ollama instance.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = [pytest.mark.e2e]

PRE_SUMMARY_CONTEXT = """Patient: John Smith, Age: 58, MRN: MRN-2024-0892
Previous Visit: Persistent chest pain, ECG showed ST-segment changes.
Current Medications: Aspirin 81mg daily, Atorvastatin 40mg, Metformin 500mg BID.
Lab Results: Troponin I: 0.04 ng/mL (normal), BNP: 150 pg/mL (mildly elevated), HbA1c: 7.2%.
"""

TRANSCRIPT = """Doctor: Good morning, Mr. Smith. How have you been since our last visit?
Patient: The chest pain has improved since starting the new medication.
Doctor: Blood pressure is 138 over 85, heart rate 72. Better than last time.
Patient: I sometimes forget the evening metformin.
Doctor: It's important to take it consistently for diabetes management.
"""

PRE_SUMMARY_SYSTEM_PROMPT = (
    "You are a medical documentation assistant. "
    "Generate a concise pre-summary from the provided clinical context. "
    "Focus on key findings, diagnoses, medications, and treatment plans."
)

SUMMARY_SYSTEM_PROMPT = (
    "You are a medical documentation assistant. "
    "Generate a comprehensive clinical summary from the provided transcript."
)


@pytest.mark.usefixtures("require_ollama")
class TestPreSummarySseE2E:
    """Pre-summary generation via SSE streaming against real Ollama."""

    async def test_presummary_stream_returns_202_with_stream_url(
        self,
        e2e_client: AsyncClient,
    ) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": f"Generate a pre-summary:\n\n{PRE_SUMMARY_CONTEXT}",
                "system_prompt": PRE_SUMMARY_SYSTEM_PROMPT,
                "stream": True,
                "max_tokens": 256,
                "temperature": 0.3,
            },
            timeout=30.0,
        )
        assert resp.status_code == 202

        body = resp.json()
        assert body["status"] == "running"
        assert body["task_id"]
        assert body["stream_url"]
        assert body["stream_url"].startswith("/api/v1/tasks/")
        assert body["stream_url"].endswith("/stream")

    async def test_presummary_sse_stream_produces_chunks_and_done(
        self,
        e2e_client: AsyncClient,
    ) -> None:
        task_resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": f"Generate a pre-summary:\n\n{PRE_SUMMARY_CONTEXT}",
                "system_prompt": PRE_SUMMARY_SYSTEM_PROMPT,
                "stream": True,
                "max_tokens": 256,
                "temperature": 0.3,
            },
            timeout=30.0,
        )
        assert task_resp.status_code == 202
        _task_id = task_resp.json()["task_id"]
        stream_url = task_resp.json()["stream_url"]

        sse_resp = await e2e_client.get(stream_url, timeout=120.0)
        assert sse_resp.status_code == 200

        body = sse_resp.text
        lines = [line for line in body.splitlines() if line.startswith("data: ")]
        assert len(lines) > 0, "SSE stream should produce at least one data line"

        has_content = any('"content"' in line or '"text"' in line for line in lines)
        assert has_content, "SSE stream should contain content chunks"

        has_done = any("[DONE]" in line or '"done"' in line for line in lines)
        assert has_done, "SSE stream should end with a done signal"

    async def test_presummary_sync_returns_content(
        self,
        e2e_client: AsyncClient,
    ) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": f"Generate a pre-summary:\n\n{PRE_SUMMARY_CONTEXT}",
                "system_prompt": PRE_SUMMARY_SYSTEM_PROMPT,
                "stream": False,
                "max_tokens": 256,
                "temperature": 0.3,
            },
            timeout=120.0,
        )
        assert resp.status_code == 200

        body = resp.json()
        assert body["status"] == "completed"
        assert body["provider"] == "ollama"
        assert isinstance(body["content"], str)
        assert len(body["content"].strip()) > 0


@pytest.mark.usefixtures("require_ollama")
class TestSummarySseE2E:
    """Full summary generation via SSE streaming against real Ollama."""

    async def test_summary_stream_returns_202_with_stream_url(
        self,
        e2e_client: AsyncClient,
    ) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": f"Generate a clinical summary:\n\n{TRANSCRIPT}",
                "system_prompt": SUMMARY_SYSTEM_PROMPT,
                "stream": True,
                "max_tokens": 512,
                "temperature": 0.4,
            },
            timeout=30.0,
        )
        assert resp.status_code == 202

        body = resp.json()
        assert body["status"] == "running"
        assert body["task_id"]
        assert body["stream_url"]

    async def test_summary_sse_stream_produces_chunks_and_done(
        self,
        e2e_client: AsyncClient,
    ) -> None:
        task_resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": f"Generate a clinical summary:\n\n{TRANSCRIPT}",
                "system_prompt": SUMMARY_SYSTEM_PROMPT,
                "stream": True,
                "max_tokens": 512,
                "temperature": 0.4,
            },
            timeout=30.0,
        )
        assert task_resp.status_code == 202
        stream_url = task_resp.json()["stream_url"]

        sse_resp = await e2e_client.get(stream_url, timeout=120.0)
        assert sse_resp.status_code == 200

        body = sse_resp.text
        lines = [line for line in body.splitlines() if line.startswith("data: ")]
        assert len(lines) > 0, "SSE stream should produce at least one data line"

        has_content = any('"content"' in line or '"text"' in line for line in lines)
        assert has_content, "SSE stream should contain content chunks"

        has_done = any("[DONE]" in line or '"done"' in line for line in lines)
        assert has_done, "SSE stream should end with a done signal"

    async def test_summary_with_presummary_context_stream(
        self,
        e2e_client: AsyncClient,
    ) -> None:
        """Full flow: pre-summary context injected into summary generation."""
        pre_summary = "Key History: Persistent chest pain, ST-segment changes. Medications: Aspirin, Atorvastatin, Metformin."

        prompt = (
            f"Generate a clinical summary:\n\n{TRANSCRIPT}"
            f"\n\n--- Pre-Summary Context ---\n{pre_summary}"
        )

        task_resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": prompt,
                "system_prompt": SUMMARY_SYSTEM_PROMPT,
                "stream": True,
                "max_tokens": 512,
                "temperature": 0.4,
            },
            timeout=30.0,
        )
        assert task_resp.status_code == 202
        stream_url = task_resp.json()["stream_url"]

        sse_resp = await e2e_client.get(stream_url, timeout=120.0)
        assert sse_resp.status_code == 200

        lines = [line for line in sse_resp.text.splitlines() if line.startswith("data: ")]
        assert len(lines) > 0

    async def test_summary_sync_returns_content(
        self,
        e2e_client: AsyncClient,
    ) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "prompt": f"Generate a clinical summary:\n\n{TRANSCRIPT}",
                "system_prompt": SUMMARY_SYSTEM_PROMPT,
                "stream": False,
                "max_tokens": 512,
                "temperature": 0.4,
            },
            timeout=120.0,
        )
        assert resp.status_code == 200

        body = resp.json()
        assert body["status"] == "completed"
        assert isinstance(body["content"], str)
        assert len(body["content"].strip()) > 0
