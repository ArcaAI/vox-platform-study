"""Locust Load & Concurrency Test Suite through HOPE API Gateway.

Simulates multiple concurrent clinicians requesting clinical note generation,
streaming responses via SSE, and recording TTFT and E2E generation times.
"""

import json
import os
import time
from pathlib import Path
from locust import HttpUser, between, task

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_PAYLOAD_FILE = SCRIPT_DIR / "sample_clinical_transcript.json"

GATEWAY_ENDPOINT = os.getenv("GATEWAY_ENDPOINT", "/api/v1/text-generations/generate/assembled")
DOCTOR_USERNAME = os.getenv("DOCTOR_USERNAME", os.getenv("DOCTOR_EMAIL", "doctor.test@example.com"))
DOCTOR_PASSWORD = os.getenv("DOCTOR_PASSWORD", "Password123!")


class ClinicianUser(HttpUser):
    # Wait between 2 and 5 seconds between completed notes (realistic clinician pause)
    wait_time = between(2.0, 5.0)

    def on_start(self):
        """Authenticates with the API Gateway to obtain a valid Bearer token."""
        self.headers = {"Content-Type": "application/json"}
        
        # Load sample payload
        with open(DEFAULT_PAYLOAD_FILE, "r", encoding="utf-8") as f:
            self.payload = json.load(f)

        auth_disabled = os.getenv("DISABLE_AUTH", "false").lower() in ("true", "1")
        if auth_disabled:
            return

        try:
            resp = self.client.post(
                "/api/v1/auth/login",
                json={"username": DOCTOR_USERNAME, "password": DOCTOR_PASSWORD},
                timeout=15.0,
            )
            if resp.status_code in (200, 201):
                data = resp.json()
                token = (
                    data.get("token")
                    or data.get("accessToken")
                    or (data.get("data") or {}).get("token")
                    or (data.get("data") or {}).get("accessToken")
                )
                if token:
                    self.headers["Authorization"] = f"Bearer {token}"
        except Exception as exc:
            print(f"[!] Auth request failed: {exc}")

    @task(weight=3)
    def generate_streaming_note(self):
        """Dispatches clinical note generation and tracks streaming latency."""
        start_time = time.monotonic()
        first_token_time = None

        with self.client.post(
            GATEWAY_ENDPOINT,
            headers=self.headers,
            json=self.payload,
            stream=True,
            catch_response=True,
            timeout=120.0,
            name="POST /text-generations/generate/assembled (Streaming)",
        ) as response:
            if response.status_code not in (200, 201, 202):
                response.failure(f"HTTP {response.status_code}: {response.text[:200]}")
                return

            try:
                for line in response.iter_lines():
                    if line:
                        now = time.monotonic()
                        if first_token_time is None:
                            first_token_time = now
                            # Report TTFT custom metric
                            ttft_ms = (first_token_time - start_time) * 1000
                            self.environment.events.request.fire(
                                request_type="SSE",
                                name="TTFT (Time to First Token)",
                                response_time=ttft_ms,
                                response_length=0,
                                exception=None,
                                context={},
                            )

                response.success()
            except Exception as exc:
                response.failure(f"Streaming interrupted: {exc}")

    @task(weight=1)
    def check_gateway_health(self):
        """Periodic lightweight health check to monitor Gateway responsiveness."""
        self.client.get("/api/v1/health", name="GET /api/v1/health")
