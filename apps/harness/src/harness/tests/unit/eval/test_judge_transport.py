"""Judge transport tests: ``extra_body`` passthrough + reasoning-aware
answer extraction across reasoning / non-reasoning model families.

Empirically (LM Studio, ctx 8192, judge-like JSON task): qwen3.5 can exhaust the
token budget "thinking" and leave ``message.content`` empty with the answer only
in ``message.reasoning_content``; gpt-oss exposes a ``reasoning`` field instead;
gemma/medgemma vary. The client must therefore fall back to the reasoning text
when content is blank, and forward ``extra_body`` (a real lever for vLLM/Azure)
only when it is configured.

These tests substitute the SDK's ``chat.completions.create`` with a fake so they
stay hermetic/offline; they cover both the OpenAI-compatible and Azure clients.
"""

from __future__ import annotations

import asyncio
import types

import pytest

from harness.eval.config import JudgeConfig, JudgeProvider
from harness.eval.judge.providers import AzureOpenAIJudgeClient, OpenAICompatJudgeClient


def _fake_create(captured: dict, *, content, reasoning_content=None, reasoning=None):
    """Fake ``chat.completions.create``: records the call kwargs and returns a
    response shaped like the OpenAI SDK (``choices[0].message.*``)."""

    async def create(**kwargs):  # noqa: ANN003
        captured.update(kwargs)
        fields: dict = {"content": content}
        if reasoning_content is not None:
            fields["reasoning_content"] = reasoning_content
        if reasoning is not None:
            fields["reasoning"] = reasoning
        message = types.SimpleNamespace(**fields)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])

    return create


def _openai_compat(**overrides) -> OpenAICompatJudgeClient:
    return OpenAICompatJudgeClient(JudgeConfig(**overrides))


def _azure(**overrides) -> AzureOpenAIJudgeClient:
    cfg = JudgeConfig(provider=JudgeProvider.AZURE, model="gpt-4o", **overrides)
    cfg.azure.endpoint = "https://example.openai.azure.com"
    cfg.azure.api_key = "secret"  # type: ignore[assignment]
    cfg.azure.deployment = "gpt-4o-judge"
    return AzureOpenAIJudgeClient(cfg)


# Both OpenAI-compatible and Azure clients must obey the same contract.
CLIENT_BUILDERS = [
    pytest.param(_openai_compat, id="openai_compat"),
    pytest.param(_azure, id="azure"),
]


@pytest.mark.parametrize("build_client", CLIENT_BUILDERS)
@pytest.mark.asyncio
async def test_extra_body_forwarded_when_configured(build_client):
    client = build_client(extra_body={"reasoning_effort": "low"})
    captured: dict = {}
    client._client.chat.completions.create = _fake_create(captured, content='{"succinct": 3}')
    await client.complete([{"role": "user", "content": "hi"}])
    assert captured["extra_body"] == {"reasoning_effort": "low"}


@pytest.mark.parametrize("build_client", CLIENT_BUILDERS)
@pytest.mark.asyncio
async def test_extra_body_omitted_when_not_configured(build_client):
    client = build_client()  # extra_body defaults to None
    captured: dict = {}
    client._client.chat.completions.create = _fake_create(captured, content='{"succinct": 3}')
    await client.complete([{"role": "user", "content": "hi"}])
    assert "extra_body" not in captured


@pytest.mark.parametrize("build_client", CLIENT_BUILDERS)
@pytest.mark.asyncio
async def test_returns_reasoning_content_when_content_empty(build_client):
    # qwen3.5 / gemma-4: answer lands in reasoning_content while content is empty.
    client = build_client()
    captured: dict = {}
    client._client.chat.completions.create = _fake_create(
        captured, content="", reasoning_content='{"succinct": 3}'
    )
    out = await client.complete([{"role": "user", "content": "hi"}])
    assert out == '{"succinct": 3}'


@pytest.mark.parametrize("build_client", CLIENT_BUILDERS)
@pytest.mark.asyncio
async def test_returns_reasoning_field_when_content_blank(build_client):
    # gpt-oss exposes ``reasoning`` (not ``reasoning_content``); whitespace-only
    # content must still fall back to it.
    client = build_client()
    captured: dict = {}
    client._client.chat.completions.create = _fake_create(
        captured, content="   ", reasoning='{"succinct": 2}'
    )
    out = await client.complete([{"role": "user", "content": "hi"}])
    assert out == '{"succinct": 2}'


@pytest.mark.parametrize("build_client", CLIENT_BUILDERS)
@pytest.mark.asyncio
async def test_returns_content_verbatim_and_ignores_reasoning(build_client):
    client = build_client()
    captured: dict = {}
    client._client.chat.completions.create = _fake_create(
        captured, content='{"succinct": 4}', reasoning_content="<think>noise</think>"
    )
    out = await client.complete([{"role": "user", "content": "hi"}])
    assert out == '{"succinct": 4}'


def _flaky_create(captured: dict, *, fail_times: int, error: str, content: str):
    """Fake ``create`` that raises ``error`` for the first ``fail_times`` calls,
    then returns a normal response. Records the attempt count in ``captured``."""
    captured["attempts"] = 0

    async def create(**kwargs):  # noqa: ANN003
        captured["attempts"] += 1
        if captured["attempts"] <= fail_times:
            raise Exception(error)
        message = types.SimpleNamespace(content=content)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])

    return create


@pytest.mark.parametrize("build_client", CLIENT_BUILDERS)
@pytest.mark.asyncio
async def test_transient_terminated_is_retried_then_succeeds(build_client):
    # LM Studio terminates/unloads gemma-4-e4b mid-run under load (HTTP 400
    # 'terminated'), then JIT-reloads on the next call. A bounded retry (zero
    # backoff here for speed) must recover instead of aborting the whole run.
    client = build_client(transient_retries=3, transient_retry_backoff_s=0.0)
    captured: dict = {}
    client._client.chat.completions.create = _flaky_create(
        captured,
        fail_times=2,
        error="Error code: 400 - {'error': 'terminated'}",
        content='{"succinct": 3}',
    )
    out = await client.complete([{"role": "user", "content": "hi"}])
    assert out == '{"succinct": 3}'
    assert captured["attempts"] == 3  # 2 failures + 1 success


@pytest.mark.parametrize("build_client", CLIENT_BUILDERS)
@pytest.mark.asyncio
async def test_transient_failure_aborts_after_retries_exhausted(build_client):
    # A backend that never recovers must still surface as JudgeConnectionError
    # (so a broken endpoint can never masquerade as a passing gate).
    from harness.eval.judge.base import JudgeConnectionError

    client = build_client(transient_retries=2, transient_retry_backoff_s=0.0)
    captured: dict = {}
    client._client.chat.completions.create = _flaky_create(
        captured,
        fail_times=99,
        error="{'error': 'terminated'}",
        content="unused",
    )
    with pytest.raises(JudgeConnectionError):
        await client.complete([{"role": "user", "content": "hi"}])
    assert captured["attempts"] == 3  # initial + 2 retries, then give up


@pytest.mark.parametrize("build_client", CLIENT_BUILDERS)
@pytest.mark.asyncio
async def test_non_transient_error_is_not_retried(build_client):
    # A deterministic client error (e.g. malformed request) would only fail again,
    # so it must NOT be retried — fail fast.
    from harness.eval.judge.base import JudgeConnectionError

    client = build_client(transient_retries=3, transient_retry_backoff_s=0.0)
    captured: dict = {}
    client._client.chat.completions.create = _flaky_create(
        captured,
        fail_times=99,
        error="invalid 'messages': bad shape",
        content="unused",
    )
    with pytest.raises(JudgeConnectionError):
        await client.complete([{"role": "user", "content": "hi"}])
    assert captured["attempts"] == 1  # no retry on a non-transient error


@pytest.mark.asyncio
async def test_judge_respects_shared_endpoint_concurrency_cap(monkeypatch):
    # The inferential pass fans groundedness + citation_verify out concurrently over
    # ONE judge client hitting one LM Studio box. With the governor cap=2, the gather
    # may still fan out, but no more than 2 calls are ever in flight — so the box is
    # never bursted (the root cause of the DEGRADED citation_verify/safety).
    from harness.core.llm_concurrency import reset_endpoint_limiters

    monkeypatch.setenv("HARNESS_LLM_MAX_CONCURRENCY", "2")
    reset_endpoint_limiters()
    client = _openai_compat()
    state = {"in_flight": 0, "peak": 0}

    async def create(**kwargs):  # noqa: ANN003
        state["in_flight"] += 1
        state["peak"] = max(state["peak"], state["in_flight"])
        try:
            await asyncio.sleep(0.02)  # hold the slot long enough to overlap
            msg = types.SimpleNamespace(content='{"supported": true}')
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)])
        finally:
            state["in_flight"] -= 1

    client._client.chat.completions.create = create
    await asyncio.gather(*(client.complete([{"role": "user", "content": "hi"}]) for _ in range(8)))
    assert state["peak"] == 2  # fanned out 8, capped at 2 in flight


@pytest.mark.parametrize("build_client", CLIENT_BUILDERS)
@pytest.mark.asyncio
async def test_prefers_reasoning_when_content_json_truncated(build_client):
    # gemma-4-e4b (LM Studio): the COMPLETE JSON lands in reasoning_content while
    # ``content`` holds only a *truncated* duplicate cut off mid-object
    # (finish_reason=length) — an unbalanced ``{`` no parser can recover. The client
    # must prefer the reasoning channel that actually carries a balanced answer.
    client = build_client()
    captured: dict = {}
    truncated = '{"citation": 5, "accurate": 5, "comprehensible":'
    complete = '{"citation": 5, "accurate": 5, "comprehensible": 5}'
    client._client.chat.completions.create = _fake_create(
        captured, content=truncated, reasoning_content="...weighed each dimension...\n" + complete
    )
    out = await client.complete([{"role": "user", "content": "hi"}])
    assert complete in out  # the balanced JSON, not the truncated content
    assert out != truncated
