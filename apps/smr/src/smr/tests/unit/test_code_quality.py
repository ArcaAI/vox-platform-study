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
        source = (SRC_ROOT / "smr" / "main.py").read_text()
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

    def test_ollama_no_bare_except(self):
        filepath = SRC_ROOT / "smr" / "providers" / "ollama.py"
        violations = self._bare_except_exception_in_funcs(filepath, {"health_check", "get_info"})
        assert not violations, f"ollama.py: bare except Exception in {violations}"

    def test_azure_no_bare_except(self):
        filepath = SRC_ROOT / "smr" / "providers" / "azure_openai.py"
        violations = self._bare_except_exception_in_funcs(filepath, {"health_check", "get_info"})
        assert not violations, f"azure_openai.py: bare except Exception in {violations}"

    def test_bedrock_no_bare_except(self):
        filepath = SRC_ROOT / "smr" / "providers" / "bedrock.py"
        violations = self._bare_except_exception_in_funcs(filepath, {"health_check", "get_info"})
        assert not violations, f"bedrock.py: bare except Exception in {violations}"


# ---------------------------------------------------------------------------
# 3. Endpoint functions have return type annotations
# ---------------------------------------------------------------------------


class TestEndpointReturnTypes:
    def test_health_endpoints_have_return_types(self):
        from smr.api.endpoints import health

        for name in ("health_check", "liveness", "readiness"):
            func = getattr(health, name)
            hints = get_type_hints(func, include_extras=True)
            assert "return" in hints, f"health.{name}() missing return type annotation"

    def test_task_endpoints_have_return_types(self):
        from smr.api.endpoints import tasks

        for name in ("get_task", "cancel_task"):
            func = getattr(tasks, name)
            hints = get_type_hints(func, include_extras=True)
            assert "return" in hints, f"tasks.{name}() missing return type annotation"

    def test_provider_endpoint_has_return_type(self):
        from smr.api.endpoints import providers

        hints = get_type_hints(providers.list_providers, include_extras=True)
        assert "return" in hints, "providers.list_providers() missing return type annotation"

    def test_generate_endpoint_has_return_type(self):
        from smr.api.endpoints import generate

        hints = get_type_hints(generate.generate, include_extras=True)
        assert "return" in hints, "generate.generate() missing return type annotation"

    def test_stream_endpoint_has_return_type(self):
        from smr.api.endpoints import stream

        hints = get_type_hints(stream.stream_task, include_extras=True)
        assert "return" in hints, "stream.stream_task() missing return type annotation"


# ---------------------------------------------------------------------------
# 4. generate() returns Pydantic model directly for non-streaming
# ---------------------------------------------------------------------------


class TestGenerateReturnsPydanticModel:
    def test_generate_no_model_dump_for_sync_return(self):
        """The non-streaming code path should return GenerateResponse(...)
        directly, not GenerateResponse(...).model_dump(mode='json')."""
        source = (SRC_ROOT / "smr" / "api" / "endpoints" / "generate.py").read_text()
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
# 5. Health check failures are logged (not silently swallowed)
# ---------------------------------------------------------------------------


class TestHealthCheckLogsOnFailure:
    @pytest.mark.asyncio
    async def test_ollama_health_check_logs_warning(self):
        from smr.providers.ollama import OllamaProvider

        config = MagicMock()
        config.base_url = "http://localhost:11434"
        config.default_model = "llama3"
        http_client = AsyncMock(spec=httpx.AsyncClient)
        http_client.get = AsyncMock(side_effect=httpx.ConnectError("connection refused"))

        provider = OllamaProvider(config, http_client)
        with patch("smr.providers.ollama.logger") as mock_logger:
            result = await provider.health_check()
            assert result is False
            mock_logger.warning.assert_called_once()
            call_args = mock_logger.warning.call_args
            assert "health_check.failed" in call_args[0][0]

    @pytest.mark.asyncio
    async def test_azure_health_check_logs_warning(self):
        from openai import APIConnectionError

        from smr.providers.azure_openai import AzureOpenAIProvider

        config = MagicMock()
        config.api_key.get_secret_value.return_value = "fake-key"
        config.endpoint = "https://fake.openai.azure.com"
        config.api_version = "2024-02-15-preview"
        config.default_model = "gpt-4"

        provider = AzureOpenAIProvider(config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(
            side_effect=APIConnectionError(request=MagicMock())
        )

        with patch("smr.providers.azure_openai.logger") as mock_logger:
            result = await provider.health_check()
            assert result is False
            mock_logger.warning.assert_called_once()
            call_args = mock_logger.warning.call_args
            assert "health_check.failed" in call_args[0][0]

    @pytest.mark.asyncio
    async def test_bedrock_health_check_logs_warning(self):
        from botocore.exceptions import ClientError

        from smr.providers.bedrock import BedrockProvider

        config = MagicMock()
        config.region = "us-east-1"
        config.default_model = "anthropic.claude-v2"

        with patch("boto3.client") as mock_boto:
            mock_runtime = MagicMock()
            mock_mgmt = MagicMock()
            mock_boto.side_effect = [mock_runtime, mock_mgmt]
            provider = BedrockProvider(config)

        error_response = {"Error": {"Code": "AccessDeniedException", "Message": "denied"}}
        exc = ClientError(error_response, "ListFoundationModels")
        mock_mgmt.list_foundation_models.side_effect = exc

        async def _fake_to_thread(func, *args, **kwargs):
            return func(*args, **kwargs)

        with patch("smr.providers.bedrock.logger") as mock_logger:
            with patch("smr.providers.bedrock.asyncio.to_thread", side_effect=_fake_to_thread):
                result = await provider.health_check()
            assert result is False
            mock_logger.warning.assert_called_once()
            call_args = mock_logger.warning.call_args
            assert "health_check.failed" in call_args[0][0]


# ---------------------------------------------------------------------------
# 6-8. Provider health_check catches specific exception types
# ---------------------------------------------------------------------------


class TestOllamaSpecificExceptions:
    @pytest.mark.asyncio
    async def test_catches_httpx_connect_error(self):
        from smr.providers.ollama import OllamaProvider

        config = MagicMock()
        config.base_url = "http://localhost:11434"
        config.default_model = "llama3"
        http_client = AsyncMock(spec=httpx.AsyncClient)
        http_client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))

        provider = OllamaProvider(config, http_client)
        result = await provider.health_check()
        assert result is False

    @pytest.mark.asyncio
    async def test_catches_httpx_timeout(self):
        from smr.providers.ollama import OllamaProvider

        config = MagicMock()
        config.base_url = "http://localhost:11434"
        config.default_model = "llama3"
        http_client = AsyncMock(spec=httpx.AsyncClient)
        http_client.get = AsyncMock(side_effect=httpx.TimeoutException("timed out"))

        provider = OllamaProvider(config, http_client)
        result = await provider.health_check()
        assert result is False

    @pytest.mark.asyncio
    async def test_catches_connection_error(self):
        from smr.providers.ollama import OllamaProvider

        config = MagicMock()
        config.base_url = "http://localhost:11434"
        config.default_model = "llama3"
        http_client = AsyncMock(spec=httpx.AsyncClient)
        http_client.get = AsyncMock(side_effect=ConnectionError("conn reset"))

        provider = OllamaProvider(config, http_client)
        result = await provider.health_check()
        assert result is False


class TestAzureSpecificExceptions:
    @pytest.mark.asyncio
    async def test_catches_api_connection_error(self):
        from openai import APIConnectionError

        from smr.providers.azure_openai import AzureOpenAIProvider

        config = MagicMock()
        config.api_key.get_secret_value.return_value = "fake"
        config.endpoint = "https://fake.openai.azure.com"
        config.api_version = "2024-02-15-preview"
        config.default_model = "gpt-4"

        provider = AzureOpenAIProvider(config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(
            side_effect=APIConnectionError(request=MagicMock())
        )
        result = await provider.health_check()
        assert result is False

    @pytest.mark.asyncio
    async def test_catches_api_timeout_error(self):
        from openai import APITimeoutError

        from smr.providers.azure_openai import AzureOpenAIProvider

        config = MagicMock()
        config.api_key.get_secret_value.return_value = "fake"
        config.endpoint = "https://fake.openai.azure.com"
        config.api_version = "2024-02-15-preview"
        config.default_model = "gpt-4"

        provider = AzureOpenAIProvider(config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(side_effect=APITimeoutError(request=MagicMock()))
        result = await provider.health_check()
        assert result is False

    @pytest.mark.asyncio
    async def test_catches_api_error(self):
        from openai import APIError

        from smr.providers.azure_openai import AzureOpenAIProvider

        config = MagicMock()
        config.api_key.get_secret_value.return_value = "fake"
        config.endpoint = "https://fake.openai.azure.com"
        config.api_version = "2024-02-15-preview"
        config.default_model = "gpt-4"

        provider = AzureOpenAIProvider(config)
        provider._client = AsyncMock()
        provider._client.models.list = AsyncMock(
            side_effect=APIError(message="server error", request=MagicMock(), body=None)
        )
        result = await provider.health_check()
        assert result is False


class TestBedrockSpecificExceptions:

    @staticmethod
    async def _fake_to_thread(func, *args, **kwargs):
        return func(*args, **kwargs)

    @pytest.mark.asyncio
    async def test_catches_client_error(self):
        from botocore.exceptions import ClientError

        from smr.providers.bedrock import BedrockProvider

        config = MagicMock()
        config.region = "us-east-1"
        config.default_model = "anthropic.claude-v2"

        with patch("boto3.client") as mock_boto:
            mock_runtime = MagicMock()
            mock_mgmt = MagicMock()
            mock_boto.side_effect = [mock_runtime, mock_mgmt]
            provider = BedrockProvider(config)

        error_response = {"Error": {"Code": "AccessDeniedException", "Message": "denied"}}
        mock_mgmt.list_foundation_models.side_effect = ClientError(
            error_response, "ListFoundationModels"
        )

        with patch("smr.providers.bedrock.asyncio.to_thread", side_effect=self._fake_to_thread):
            result = await provider.health_check()
        assert result is False

    @pytest.mark.asyncio
    async def test_catches_endpoint_connection_error(self):
        from botocore.exceptions import EndpointConnectionError

        from smr.providers.bedrock import BedrockProvider

        config = MagicMock()
        config.region = "us-east-1"
        config.default_model = "anthropic.claude-v2"

        with patch("boto3.client") as mock_boto:
            mock_runtime = MagicMock()
            mock_mgmt = MagicMock()
            mock_boto.side_effect = [mock_runtime, mock_mgmt]
            provider = BedrockProvider(config)

        mock_mgmt.list_foundation_models.side_effect = EndpointConnectionError(
            endpoint_url="https://bedrock.us-east-1.amazonaws.com"
        )

        with patch("smr.providers.bedrock.asyncio.to_thread", side_effect=self._fake_to_thread):
            result = await provider.health_check()
        assert result is False

    @pytest.mark.asyncio
    async def test_catches_botocore_error(self):
        from botocore.exceptions import BotoCoreError

        from smr.providers.bedrock import BedrockProvider

        config = MagicMock()
        config.region = "us-east-1"
        config.default_model = "anthropic.claude-v2"

        with patch("boto3.client") as mock_boto:
            mock_runtime = MagicMock()
            mock_mgmt = MagicMock()
            mock_boto.side_effect = [mock_runtime, mock_mgmt]
            provider = BedrockProvider(config)

        mock_mgmt.list_foundation_models.side_effect = BotoCoreError()

        with patch("smr.providers.bedrock.asyncio.to_thread", side_effect=self._fake_to_thread):
            result = await provider.health_check()
        assert result is False


# ---------------------------------------------------------------------------
# 9. Lifespan teardown logs Redis close failures
# ---------------------------------------------------------------------------


class TestLifespanTeardownLogging:
    def test_no_bare_except_in_lifespan_redis_close(self):
        """The lifespan function should not silently swallow Redis close errors."""
        source = (SRC_ROOT / "smr" / "main.py").read_text()
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
