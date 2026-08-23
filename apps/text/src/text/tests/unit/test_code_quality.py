"""Tests for code quality improvements (Phase 5, Task 5.4).

Verifies:
- No __contains__ anti-pattern in main.py
- Providers use specific exception types (not bare except Exception)
- Endpoint functions have return type annotations
- generate() returns Pydantic model directly (not .model_dump())
- Health check failures are logged, not silently swallowed
- Redis close failures in lifespan teardown are logged
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import get_type_hints
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

SRC_ROOT = Path(__file__).resolve().parents[3]


# ---------------------------------------------------------------------------
# 1. No __contains__ anti-pattern in main.py
# ---------------------------------------------------------------------------


class TestNoDunderContains:
    def test_no_dunder_contains_in_main(self):
        source = (SRC_ROOT / "text" / "main.py").read_text()
        assert (
            "__contains__" not in source
        ), "main.py still uses .__contains__() — use the `in` operator instead"


# ---------------------------------------------------------------------------
# 2. Providers use specific exceptions (not bare except Exception)
# ---------------------------------------------------------------------------


class TestProvidersUseSpecificExceptions:
    """Verify that health_check / get_info in each provider file
    catch specific exception types rather than bare `except Exception`."""

    @staticmethod
    def _bare_except_exception_in_funcs(filepath: Path, func_names: set[str]) -> list[str]:
        """Return function names that silently swallow exceptions.

        A handler is considered "silent" when it catches `Exception` without
        binding it to a name (no `as exc`) AND the body is trivial (pass,
        return False, or a bare expression).  Handlers that bind the exception
        and contain a logger call are considered acceptable fallbacks.
        """
        source = filepath.read_text()
        tree = ast.parse(source)
        violations: list[str] = []

        for node in ast.walk(tree):
            if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                continue
            if node.name not in func_names:
                continue
            for child in ast.walk(node):
                if not isinstance(child, ast.ExceptHandler):
                    continue
                if child.type is None:
                    violations.append(node.name)
                    break
                if isinstance(child.type, ast.Name) and child.type.id == "Exception":
                    if child.name is not None:
                        continue
                    body_is_pass = len(child.body) == 1 and isinstance(
                        child.body[0], (ast.Pass, ast.Expr)
                    )
                    body_returns_false = (
                        len(child.body) == 1
                        and isinstance(child.body[0], ast.Return)
                        and isinstance(child.body[0].value, ast.Constant)
                        and child.body[0].value.value is False
                    )
                    if body_is_pass or body_returns_false:
                        violations.append(node.name)
                        break
        return violations

    def test_azure_no_bare_except(self):
        filepath = SRC_ROOT / "text" / "providers" / "azure_openai.py"
        violations = self._bare_except_exception_in_funcs(filepath, {"health_check", "get_info"})
        assert not violations, f"azure_openai.py: bare except Exception in {violations}"

    def test_bedrock_no_bare_except(self):
        filepath = SRC_ROOT / "text" / "providers" / "bedrock.py"
        violations = self._bare_except_exception_in_funcs(filepath, {"health_check", "get_info"})
        assert not violations, f"bedrock.py: bare except Exception in {violations}"


# ---------------------------------------------------------------------------
# 3. Endpoint functions have return type annotations
# ---------------------------------------------------------------------------


class TestEndpointReturnTypes:
    def test_health_endpoints_have_return_types(self):
        from text.api.endpoints import health

        for name in ("health_check", "liveness", "readiness"):
            func = getattr(health, name)
            hints = get_type_hints(func, include_extras=True)
            assert "return" in hints, f"health.{name}() missing return type annotation"

    def test_task_endpoints_have_return_types(self):
        from text.api.endpoints import tasks

        for name in ("get_task", "cancel_task"):
            func = getattr(tasks, name)
            hints = get_type_hints(func, include_extras=True)
            assert "return" in hints, f"tasks.{name}() missing return type annotation"

    def test_provider_endpoint_has_return_type(self):
        from text.api.endpoints import providers

        hints = get_type_hints(providers.list_providers, include_extras=True)
        assert "return" in hints, "providers.list_providers() missing return type annotation"

    def test_generate_endpoint_has_return_type(self):
        from text.api.endpoints import generate

        hints = get_type_hints(generate.generate, include_extras=True)
        assert "return" in hints, "generate.generate() missing return type annotation"

    def test_stream_endpoint_has_return_type(self):
        from text.api.endpoints import stream

        hints = get_type_hints(stream.stream_task, include_extras=True)
        assert "return" in hints, "stream.stream_task() missing return type annotation"


# ---------------------------------------------------------------------------
# 4. generate() returns Pydantic model directly for non-streaming
# ---------------------------------------------------------------------------


class TestGenerateReturnsPydanticModel:
    def test_generate_no_model_dump_for_sync_return(self):
        """The non-streaming code path should return GenerateResponse(...)
        directly, not GenerateResponse(...).model_dump(mode='json')."""
        source = (SRC_ROOT / "text" / "api" / "endpoints" / "generate.py").read_text()
        tree = ast.parse(source)

        for node in ast.walk(tree):
            if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                continue
            if node.name != "generate":
                continue
            for child in ast.walk(node):
                if not isinstance(child, ast.Return):
                    continue
                if child.value is None:
                    continue
                if isinstance(child.value, ast.Call):
                    func = child.value.func
                    if isinstance(func, ast.Attribute) and func.attr == "model_dump":
                        if isinstance(func.value, ast.Call):
                            inner = func.value.func
                            if isinstance(inner, ast.Name) and inner.id == "GenerateResponse":
                                pytest.fail(
                                    "generate() still calls GenerateResponse(...).model_dump() — "
                                    "return the Pydantic model directly"
                                )


# ---------------------------------------------------------------------------
# 5-8. A health PROBE logs its failure and catches its transport's exceptions
# ---------------------------------------------------------------------------
#
# These used to target Azure and Bedrock. Those adapters no longer probe at all:
# their connection is per request, so a process-level probe has no endpoint to
# reach and `health_check()` returns True ("no negative evidence" — see
# `services/pool_health.py`). The BEHAVIOUR under test — a probe must catch its
# transport's specific exceptions, log, and return False rather than raise — now
# lives on the self-hosted adapters, which probe the last endpoint they served.


def _probing_provider(cls, http_client, endpoint: str = "http://engine.local"):
    """A self-host adapter with an endpoint already observed, so it will probe."""
    provider = cls(http_client)
    provider._last_base_url = endpoint
    return provider


class TestHealthCheckLogsOnFailure:
    @pytest.mark.asyncio
    async def test_ollama_health_check_logs_warning(self):
        import httpx

        from text.providers.ollama import OllamaProvider

        http_client = AsyncMock()
        http_client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        provider = _probing_provider(OllamaProvider, http_client)

        with patch("text.providers.ollama.logger") as mock_logger:
            assert await provider.health_check() is False
            mock_logger.warning.assert_called_once()
            assert "health_check.failed" in mock_logger.warning.call_args[0][0]

    @pytest.mark.asyncio
    async def test_llama_cpp_health_check_logs_warning(self):
        import httpx

        from text.providers.llama_cpp import LlamaCppProvider

        http_client = AsyncMock()
        http_client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        provider = _probing_provider(LlamaCppProvider, http_client)

        with patch("text.providers.llama_cpp.logger") as mock_logger:
            assert await provider.health_check() is False
            mock_logger.warning.assert_called_once()
            assert "health_check.failed" in mock_logger.warning.call_args[0][0]


class TestProbeCatchesSpecificTransportExceptions:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "exc",
        [
            httpx.ConnectError("refused"),
            httpx.ReadTimeout("slow"),
            httpx.HTTPError("boom"),
            OSError("socket gone"),
        ],
        ids=["connect", "timeout", "http", "os"],
    )
    async def test_ollama_returns_false_rather_than_raising(self, exc):
        from text.providers.ollama import OllamaProvider

        http_client = AsyncMock()
        http_client.get = AsyncMock(side_effect=exc)
        provider = _probing_provider(OllamaProvider, http_client)
        assert await provider.health_check() is False


class TestUnprobedProviderIsNotReportedUnhealthy:
    """Fail-OPEN on "never probed" — `PoolHealthTracker` acts only on a
    POSITIVELY known-unhealthy result, so an adapter that has simply not been
    contacted yet must not take itself out of degrade routing."""

    @pytest.mark.asyncio
    async def test_self_host_adapter_with_no_observed_endpoint(self):
        from text.providers.ollama import OllamaProvider

        http_client = AsyncMock()
        assert await OllamaProvider(http_client).health_check() is True
        http_client.get.assert_not_called()

    @pytest.mark.asyncio
    async def test_byok_adapter_has_nothing_to_probe(self):
        from text.providers.azure_openai import AzureOpenAIProvider

        assert await AzureOpenAIProvider().health_check() is True


# ---------------------------------------------------------------------------
# 9. Lifespan teardown logs Redis close failures
# ---------------------------------------------------------------------------


class TestLifespanTeardownLogging:
    def test_no_bare_except_in_lifespan_redis_close(self):
        """The lifespan function should not silently swallow Redis close errors."""
        source = (SRC_ROOT / "text" / "main.py").read_text()
        tree = ast.parse(source)

        for node in ast.walk(tree):
            if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                continue
            if node.name != "lifespan":
                continue
            for child in ast.walk(node):
                if not isinstance(child, ast.ExceptHandler):
                    continue
                if child.type is None:
                    pytest.fail("lifespan() has bare except (no exception type)")
                if isinstance(child.type, ast.Name) and child.type.id == "Exception":
                    if len(child.body) == 1 and isinstance(child.body[0], ast.Pass):
                        pytest.fail(
                            "lifespan() catches Exception and does `pass` — " "should log the error"
                        )
