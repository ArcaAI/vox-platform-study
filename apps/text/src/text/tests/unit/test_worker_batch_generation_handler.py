"""`_handle_batch_generation` — the TASK-725 §7 known gap (`worker.py`'s
BATCH_GENERATION handler used to raise `NotImplementedError` unconditionally).

Hermetic: the provider registry holds a stub `LLMProvider`; no live engine.
Mirrors `_handle_embedding`'s shape (resolve from a registry, call the
provider directly) — the generic claim/process/ack/drain machinery around it
is already covered by `test_worker_pool_consumer.py`.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from text.models.stats import GenerationStats
from text.models.worker_task import WorkerTaskEnvelope, WorkerTaskType
from text.providers.base import ProviderNotFoundError, ProviderRegistry


def _payload(**overrides: object) -> dict:
    body = {"prompt": "summarize this note", "provider": "lm-studio", "model": "gemma-4"}
    body.update(overrides)
    return body


class TestHandleBatchGeneration:
    @pytest.mark.asyncio
    async def test_resolves_provider_and_calls_generate(self):
        from text.worker import _handle_batch_generation

        provider = AsyncMock()
        provider.generate = AsyncMock(return_value=("the answer", "", GenerationStats()))
        registry = ProviderRegistry()
        registry.register("lm-studio", provider)

        envelope = WorkerTaskEnvelope(task_type=WorkerTaskType.BATCH_GENERATION, payload=_payload())
        await _handle_batch_generation(envelope, provider_registry=registry)

        provider.generate.assert_awaited_once()
        (request,) = provider.generate.await_args.args
        assert request.prompt == "summarize this note"
        assert request.model == "gemma-4"

    @pytest.mark.asyncio
    async def test_unknown_provider_raises(self):
        """Propagates rather than swallowing — `WorkerPoolConsumer._process`
        is the layer that turns this into a FAILED task + an ACK (one bad
        task must not wedge the stream), not the handler itself."""
        from text.worker import _handle_batch_generation

        registry = ProviderRegistry()  # nothing registered
        envelope = WorkerTaskEnvelope(
            task_type=WorkerTaskType.BATCH_GENERATION, payload=_payload(provider="ghost")
        )

        with pytest.raises(ProviderNotFoundError):
            await _handle_batch_generation(envelope, provider_registry=registry)

    @pytest.mark.asyncio
    async def test_missing_prompt_raises_validation_error(self):
        """A malformed payload fails closed (pydantic ValidationError) rather
        than dispatching a garbage request to a paid engine."""
        from pydantic import ValidationError

        from text.worker import _handle_batch_generation

        registry = ProviderRegistry()
        registry.register("lm-studio", AsyncMock())
        envelope = WorkerTaskEnvelope(
            task_type=WorkerTaskType.BATCH_GENERATION,
            payload={"provider": "lm-studio", "model": "gemma-4"},
        )

        with pytest.raises(ValidationError):
            await _handle_batch_generation(envelope, provider_registry=registry)

    @pytest.mark.asyncio
    async def test_no_model_selected_fails_closed_for_cloud_provider(self):
        """A cloud provider's own `require_model` guard (base.py) still fires
        for an out-of-process batch call — the fail-closed model-selection
        contract is enforced by the provider, not duplicated in the worker."""
        from text.core.exceptions import ModelNotSelectedError
        from text.worker import _handle_batch_generation

        provider = AsyncMock()

        async def _raise_no_model(_request):
            raise ModelNotSelectedError("no model selected", provider="anthropic")

        provider.generate = _raise_no_model
        registry = ProviderRegistry()
        registry.register("anthropic", provider)

        envelope = WorkerTaskEnvelope(
            task_type=WorkerTaskType.BATCH_GENERATION,
            payload=_payload(provider="anthropic", model=None),
        )

        with pytest.raises(ModelNotSelectedError):
            await _handle_batch_generation(envelope, provider_registry=registry)


class TestWorkerMainWiring:
    @pytest.mark.asyncio
    async def test_batch_generation_consumer_uses_a_real_provider_registry(self):
        """`main()`'s BATCH_GENERATION consumer must be wired to an actual
        `ProviderRegistry` (built the same way the FastAPI app builds one —
        `text.main._register_provider_factories`), not left pointed at the
        `NotImplementedError` stub."""
        import inspect

        from text import worker

        source = inspect.getsource(worker.main)
        assert "_register_provider_factories" in source
        assert "_handle_batch_generation" in source
