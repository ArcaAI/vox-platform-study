"""
SMR V2 Load Tests — Locust

Verifies resilience features under sustained load:
- Baseline throughput
- Rate limiter (429 responses)
- Circuit breaker (503 responses)
- Semaphore saturation (503 responses)
- Queue behavior

Usage:
    # Baseline test (10 users, 60s)
    locust -f locustfile.py --headless -u 10 -r 2 -t 60s --host http://localhost:8862

    # Rate limiter test (50 users, 120s)
    locust -f locustfile.py --headless -u 50 -r 10 -t 120s --host http://localhost:8862 --tags rate-limit

    # Full resilience test
    locust -f locustfile.py --headless -u 100 -r 20 -t 300s --host http://localhost:8862
"""

from __future__ import annotations

from locust import HttpUser, between, constant, tag, task


class BaseSmrUser(HttpUser):
    """Base class for SMR V2 load test users. Sets auth header and provider."""

    abstract = True
    provider = "lm-studio"

    def on_start(self) -> None:
        self.client.headers["X-Service-Token"] = ""
        # Verify health and that provider is available
        with self.client.get(
            "/api/v1/health",
            name="/api/v1/health",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"Health check failed: {resp.status_code}")
            else:
                data = resp.json()
                if self.provider not in data.get("providers", {}):
                    resp.failure(f"Provider {self.provider} not in health response")


class BaselineUser(BaseSmrUser):
    """Baseline throughput: sync generate, health, providers. Normal pacing."""

    weight = 3
    wait_time = between(1, 3)

    @tag("baseline")
    @task
    def sync_generate(self) -> None:
        with self.client.post(
            "/api/v1/generate",
            json={
                "provider": self.provider,
                "prompt": "Say hello in one word.",
                "stream": False,
            },
            name="/api/v1/generate [sync]",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"Expected 200, got {resp.status_code}")

    @tag("baseline")
    @task
    def health_check(self) -> None:
        with self.client.get(
            "/api/v1/health",
            name="/api/v1/health",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"Expected 200, got {resp.status_code}")

    @tag("baseline")
    @task
    def list_providers(self) -> None:
        with self.client.get(
            "/api/v1/providers",
            name="/api/v1/providers",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"Expected 200, got {resp.status_code}")


class RateLimitUser(BaseSmrUser):
    """Rapid-fire requests to trigger rate limiter (429) and verify Retry-After."""

    weight = 2
    wait_time = constant(0)

    @tag("rate-limit")
    @task
    def rapid_fire_generate(self) -> None:
        with self.client.post(
            "/api/v1/generate",
            json={
                "provider": self.provider,
                "prompt": "Hi",
                "stream": False,
            },
            name="/api/v1/generate [rate-limit]",
            catch_response=True,
        ) as resp:
            if resp.status_code == 429:
                retry_after = resp.headers.get("Retry-After")
                if retry_after is None:
                    resp.failure("429 without Retry-After header")
                else:
                    resp.success()
            elif resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Unexpected status: {resp.status_code}")


class ConcurrencyUser(BaseSmrUser):
    """Concurrent requests with longer prompts to saturate semaphore (503)."""

    weight = 2
    wait_time = between(0, 1)

    @tag("concurrency")
    @task
    def concurrent_generate(self) -> None:
        # Longer prompt to hold semaphore longer
        prompt = "Write a short poem about the sea. " * 5
        with self.client.post(
            "/api/v1/generate",
            json={
                "provider": self.provider,
                "prompt": prompt,
                "stream": False,
            },
            name="/api/v1/generate [concurrency]",
            catch_response=True,
        ) as resp:
            if resp.status_code == 503:
                # Semaphore exhaustion or circuit breaker
                retry_after = resp.headers.get("Retry-After")
                if retry_after:
                    resp.success()
                else:
                    resp.success()  # 503 is expected under load
            elif resp.status_code == 200:
                resp.success()
            else:
                resp.failure(f"Unexpected status: {resp.status_code}")


class StreamingUser(BaseSmrUser):
    """Streaming requests: POST with stream=true (202), then poll task status."""

    weight = 1
    wait_time = between(2, 5)

    @tag("streaming")
    @task
    def streaming_generate(self) -> None:
        with self.client.post(
            "/api/v1/generate",
            json={
                "provider": self.provider,
                "prompt": "Count from 1 to 3.",
                "stream": True,
            },
            name="/api/v1/generate [stream]",
            catch_response=True,
        ) as resp:
            if resp.status_code != 202:
                resp.failure(f"Expected 202, got {resp.status_code}")
                return
            data = resp.json()
            task_id = data.get("task_id")
            if not task_id:
                resp.failure("No task_id in 202 response")
                return
            resp.success()
            self._check_task(task_id)

    def _check_task(self, task_id: str) -> None:
        with self.client.get(
            f"/api/v1/tasks/{task_id}",
            name="/api/v1/tasks/{id}",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"Task status failed: {resp.status_code}")
            else:
                data = resp.json()
                status = data.get("status")
                if status not in ("running", "completed", "failed"):
                    resp.failure(f"Unexpected task status: {status}")
                else:
                    resp.success()
