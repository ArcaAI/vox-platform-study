"""E2E tests for pre-summary and summary generation across providers.

Tests both lm-studio (qwen3.5-4b) and ollama (qwen3.5:latest) providers
with sync and streaming modes.

Requires:
  - Ollama running with qwen3.5:latest pulled
  - LM Studio running with qwen3.5-4b loaded

Note: qwen3.5:latest is a thinking model that uses part of its token budget
for chain-of-thought reasoning before producing the response. Tests use
max_tokens=2048 to give the model enough room for both thinking and output.
"""

from __future__ import annotations

import json

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
    "Focus on key findings, diagnoses, medications, and treatment plans. "
    "Respond directly with the pre-summary content."
)

SUMMARY_SYSTEM_PROMPT = (
    "You are a medical documentation assistant. "
    "Generate a comprehensive clinical summary from the provided transcript. "
    "Respond directly with the summary content."
)

OLLAMA_MAX_TOKENS = 2048
LM_STUDIO_MAX_TOKENS = 512


@pytest.mark.usefixtures("require_ollama")
class TestOllamaQwen35PreSummary:
    """Pre-summary generation with Ollama qwen3.5:latest."""

    async def test_sync_presummary(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "model": "qwen3.5:latest",
                "prompt": f"Generate a pre-summary:\n\n{PRE_SUMMARY_CONTEXT}",
                "system_prompt": PRE_SUMMARY_SYSTEM_PROMPT,
                "stream": False,
                "max_tokens": OLLAMA_MAX_TOKENS,
                "temperature": 0.3,
            },
            timeout=180.0,
        )
        assert resp.status_code == 200

        body = resp.json()
        assert body["status"] == "completed"
        assert body["provider"] == "ollama"
        assert isinstance(body["content"], str)
        assert len(body["content"].strip()) > 0

    async def test_streaming_presummary(self, e2e_client: AsyncClient) -> None:
        task_resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "model": "qwen3.5:latest",
                "prompt": f"Generate a pre-summary:\n\n{PRE_SUMMARY_CONTEXT}",
                "system_prompt": PRE_SUMMARY_SYSTEM_PROMPT,
                "stream": True,
                "max_tokens": OLLAMA_MAX_TOKENS,
                "temperature": 0.3,
            },
            timeout=30.0,
        )
        assert task_resp.status_code == 202

        body = task_resp.json()
        assert body["task_id"]
        assert body["stream_url"]

        sse_resp = await e2e_client.get(body["stream_url"], timeout=180.0)
        assert sse_resp.status_code == 200

        lines = [line for line in sse_resp.text.splitlines() if line.startswith("data: ")]
        assert len(lines) > 0, "SSE stream should produce data lines"

        has_content = any('"content"' in line or '"text"' in line for line in lines)
        assert has_content, "SSE stream should contain content chunks"


@pytest.mark.usefixtures("require_ollama")
class TestOllamaQwen35Summary:
    """Summary generation with Ollama qwen3.5:latest."""

    async def test_sync_summary(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "model": "qwen3.5:latest",
                "prompt": f"Generate a clinical summary:\n\n{TRANSCRIPT}",
                "system_prompt": SUMMARY_SYSTEM_PROMPT,
                "stream": False,
                "max_tokens": OLLAMA_MAX_TOKENS,
                "temperature": 0.4,
            },
            timeout=180.0,
        )
        assert resp.status_code == 200

        body = resp.json()
        assert body["status"] == "completed"
        assert body["provider"] == "ollama"
        assert isinstance(body["content"], str)
        assert len(body["content"].strip()) > 0

    async def test_streaming_summary(self, e2e_client: AsyncClient) -> None:
        task_resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "model": "qwen3.5:latest",
                "prompt": f"Generate a clinical summary:\n\n{TRANSCRIPT}",
                "system_prompt": SUMMARY_SYSTEM_PROMPT,
                "stream": True,
                "max_tokens": OLLAMA_MAX_TOKENS,
                "temperature": 0.4,
            },
            timeout=30.0,
        )
        assert task_resp.status_code == 202

        stream_url = task_resp.json()["stream_url"]
        sse_resp = await e2e_client.get(stream_url, timeout=180.0)
        assert sse_resp.status_code == 200

        lines = [line for line in sse_resp.text.splitlines() if line.startswith("data: ")]
        assert len(lines) > 0

        accumulated = ""
        for line in lines:
            data_str = line[len("data: "):]
            if data_str == "[DONE]":
                break
            try:
                parsed = json.loads(data_str)
                text = parsed.get("content", "") or parsed.get("text", "")
                accumulated += text
            except json.JSONDecodeError:
                pass

        assert len(accumulated.strip()) > 0, "Accumulated streaming content should be non-empty"

    async def test_summary_with_presummary_context(self, e2e_client: AsyncClient) -> None:
        pre_summary = (
            "Key History: Persistent chest pain, ST-segment changes. "
            "Medications: Aspirin, Atorvastatin, Metformin."
        )
        prompt = (
            f"Generate a clinical summary:\n\n{TRANSCRIPT}"
            f"\n\n--- Pre-Summary Context ---\n{pre_summary}"
        )

        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "ollama",
                "model": "qwen3.5:latest",
                "prompt": prompt,
                "system_prompt": SUMMARY_SYSTEM_PROMPT,
                "stream": False,
                "max_tokens": OLLAMA_MAX_TOKENS,
                "temperature": 0.4,
            },
            timeout=180.0,
        )
        assert resp.status_code == 200
        assert len(resp.json()["content"].strip()) > 0


@pytest.mark.usefixtures("require_lm_studio")
class TestLmStudioQwen35PreSummary:
    """Pre-summary generation with LM Studio qwen3.5-4b."""

    async def test_sync_presummary(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "lm-studio",
                "model": "qwen3.5-4b",
                "prompt": f"Generate a pre-summary:\n\n{PRE_SUMMARY_CONTEXT}",
                "system_prompt": PRE_SUMMARY_SYSTEM_PROMPT,
                "stream": False,
                "max_tokens": LM_STUDIO_MAX_TOKENS,
                "temperature": 0.3,
            },
            timeout=120.0,
        )
        assert resp.status_code == 200

        body = resp.json()
        assert body["status"] == "completed"
        assert isinstance(body["content"], str)
        assert len(body["content"].strip()) > 0

    async def test_streaming_presummary(self, e2e_client: AsyncClient) -> None:
        task_resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "lm-studio",
                "model": "qwen3.5-4b",
                "prompt": f"Generate a pre-summary:\n\n{PRE_SUMMARY_CONTEXT}",
                "system_prompt": PRE_SUMMARY_SYSTEM_PROMPT,
                "stream": True,
                "max_tokens": LM_STUDIO_MAX_TOKENS,
                "temperature": 0.3,
            },
            timeout=30.0,
        )
        assert task_resp.status_code == 202

        body = task_resp.json()
        assert body["task_id"]
        assert body["stream_url"]

        sse_resp = await e2e_client.get(body["stream_url"], timeout=120.0)
        assert sse_resp.status_code == 200

        lines = [line for line in sse_resp.text.splitlines() if line.startswith("data: ")]
        assert len(lines) > 0


@pytest.mark.usefixtures("require_lm_studio")
class TestLmStudioQwen35Summary:
    """Summary generation with LM Studio qwen3.5-4b."""

    async def test_sync_summary(self, e2e_client: AsyncClient) -> None:
        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "lm-studio",
                "model": "qwen3.5-4b",
                "prompt": f"Generate a clinical summary:\n\n{TRANSCRIPT}",
                "system_prompt": SUMMARY_SYSTEM_PROMPT,
                "stream": False,
                "max_tokens": LM_STUDIO_MAX_TOKENS,
                "temperature": 0.4,
            },
            timeout=120.0,
        )
        assert resp.status_code == 200

        body = resp.json()
        assert body["status"] == "completed"
        assert isinstance(body["content"], str)
        assert len(body["content"].strip()) > 0

    async def test_streaming_summary(self, e2e_client: AsyncClient) -> None:
        task_resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "lm-studio",
                "model": "qwen3.5-4b",
                "prompt": f"Generate a clinical summary:\n\n{TRANSCRIPT}",
                "system_prompt": SUMMARY_SYSTEM_PROMPT,
                "stream": True,
                "max_tokens": LM_STUDIO_MAX_TOKENS,
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

        accumulated = ""
        for line in lines:
            data_str = line[len("data: "):]
            if data_str == "[DONE]":
                break
            try:
                parsed = json.loads(data_str)
                text = parsed.get("content", "") or parsed.get("text", "")
                accumulated += text
            except json.JSONDecodeError:
                pass

        assert len(accumulated.strip()) > 0

    async def test_summary_with_visit_type_context(self, e2e_client: AsyncClient) -> None:
        """Summary with visit type context (simulating debug mode assembled payload)."""
        system_prompt = (
            f"{SUMMARY_SYSTEM_PROMPT}\n\nThis is a referral visit."
        )

        resp = await e2e_client.post(
            "/api/v1/generate",
            json={
                "provider": "lm-studio",
                "model": "qwen3.5-4b",
                "prompt": f"Generate a clinical summary:\n\n{TRANSCRIPT}",
                "system_prompt": system_prompt,
                "stream": False,
                "max_tokens": LM_STUDIO_MAX_TOKENS,
                "temperature": 0.4,
            },
            timeout=120.0,
        )
        assert resp.status_code == 200
        assert len(resp.json()["content"].strip()) > 0
