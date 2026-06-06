"""DeepEval metric wrappers + a model adapter for the HOPE eval harness.

DeepEval (https://github.com/confident-ai/deepeval) is a **pytest-native** LLM
eval framework. It's an *optional* dependency declared under the ``[eval]`` extra
in ``apps/harness/pyproject.toml`` — importing this module must NOT require it, so
the heavy import is deferred to the builder functions. Suites that don't touch
DeepEval (the bulk of the harness) stay light, and the DeepEval-specific tests
``pytest.importorskip("deepeval")``.

Key design point: every metric is wired to the SAME model-agnostic
:class:`~harness.eval.judge.base.JudgeClient` that drives the PDSQI-9 judge (via
:func:`build_deepeval_model`). So DeepEval scores against the configured LM Studio
/ Azure / Bedrock endpoint exactly like the rest of the harness — there is no
second model configuration and nothing is hardcoded.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from harness.eval.config import JudgeConfig
from harness.eval.judge.base import JudgeClient
from harness.eval.judge.providers import build_judge_client
from harness.eval.models import GoldenCase

if TYPE_CHECKING:  # import only for type-checkers; never at runtime
    from deepeval.models import DeepEvalBaseLLM
    from deepeval.test_case import LLMTestCase

# Default GEval rubric: a clinical-faithfulness check tuned for transcript→note
# summarization. Callers can override name/criteria/steps.
DEFAULT_GEVAL_NAME = "Clinical Faithfulness"
DEFAULT_GEVAL_CRITERIA = (
    "Determine whether the generated clinical note is faithful to and fully "
    "supported by the source documents: it must not introduce fabricated "
    "findings, diagnoses, medications, or dosages, and must preserve clinically "
    "critical information present in the source."
)


def _require_deepeval() -> Any:
    """Import deepeval lazily, with an actionable error when the extra is absent."""
    try:
        import deepeval  # noqa: F401
    except ModuleNotFoundError as exc:  # pragma: no cover - hit only without the extra
        raise ModuleNotFoundError(
            "deepeval is required for harness.eval.metrics.deepeval_metrics. "
            "Install the eval extra:  pip install -e 'apps/harness[eval]'"
        ) from exc
    return deepeval


def _run_sync(coro: Any) -> str:
    """Run an async coroutine from a sync context (DeepEval's sync ``generate``).

    Falls back to a worker thread when an event loop is already running so we
    never raise ``RuntimeError: asyncio.run() cannot be called from a running
    event loop``.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro)).result()


def build_deepeval_model(
    client: JudgeClient | None = None,
    *,
    config: JudgeConfig | None = None,
) -> DeepEvalBaseLLM:
    """Wrap a :class:`JudgeClient` as a DeepEval custom model.

    The class is defined lazily (it must subclass ``DeepEvalBaseLLM``, which only
    exists when the extra is installed). With no ``client``, one is built from
    ``config`` (or env) via :func:`build_judge_client` — i.e. the configured
    LM Studio / Azure / Bedrock backend.
    """
    _require_deepeval()
    from deepeval.models import DeepEvalBaseLLM

    judge_client = client or build_judge_client(config)

    class _HarnessJudgeModel(DeepEvalBaseLLM):
        """Adapts the harness JudgeClient to DeepEval's model contract."""

        def __init__(self, jc: JudgeClient) -> None:
            self._client = jc
            self._model_name = jc.model
            # Base __init__ calls load_model(); _client must already be set.
            super().__init__(model=jc.model)

        def load_model(self) -> JudgeClient:
            return self._client

        def get_model_name(self) -> str:
            return f"harness-judge:{self._model_name}"

        async def a_generate(self, prompt: str, *args: Any, **kwargs: Any) -> str:
            messages = [{"role": "user", "content": prompt}]
            return await self._client.complete(messages, json_mode=False)

        def generate(self, prompt: str, *args: Any, **kwargs: Any) -> str:
            return _run_sync(self.a_generate(prompt))

    return _HarnessJudgeModel(judge_client)


def _resolve_model(model: Any, config: JudgeConfig | None) -> DeepEvalBaseLLM:
    """Coerce ``model`` into a DeepEval model.

    Accepts a ready DeepEval model, a JudgeClient (wrapped), or ``None`` (built
    from config/env).
    """
    from deepeval.models import DeepEvalBaseLLM

    if isinstance(model, DeepEvalBaseLLM):
        return model
    if model is None:
        return build_deepeval_model(config=config)
    if hasattr(model, "complete"):  # a JudgeClient
        return build_deepeval_model(model)
    raise TypeError(f"model must be a DeepEvalBaseLLM, a JudgeClient, or None; got {type(model)!r}")


def build_faithfulness_metric(
    *,
    threshold: float = 0.85,
    model: Any = None,
    config: JudgeConfig | None = None,
    include_reason: bool = True,
    **kwargs: Any,
) -> Any:
    """DeepEval ``FaithfulnessMetric`` wired to the configured judge."""
    _require_deepeval()
    from deepeval.metrics import FaithfulnessMetric

    return FaithfulnessMetric(
        threshold=threshold,
        model=_resolve_model(model, config),
        include_reason=include_reason,
        **kwargs,
    )


def build_hallucination_metric(
    *,
    threshold: float = 0.3,
    model: Any = None,
    config: JudgeConfig | None = None,
    include_reason: bool = True,
    **kwargs: Any,
) -> Any:
    """DeepEval ``HallucinationMetric`` wired to the configured judge.

    Hallucination is a lower-is-better contradiction rate, so the default
    threshold is the *maximum* tolerated score.
    """
    _require_deepeval()
    from deepeval.metrics import HallucinationMetric

    return HallucinationMetric(
        threshold=threshold,
        model=_resolve_model(model, config),
        include_reason=include_reason,
        **kwargs,
    )


def build_summarization_metric(
    *,
    threshold: float = 0.5,
    n: int = 5,
    model: Any = None,
    config: JudgeConfig | None = None,
    **kwargs: Any,
) -> Any:
    """DeepEval ``SummarizationMetric`` wired to the configured judge."""
    _require_deepeval()
    from deepeval.metrics import SummarizationMetric

    return SummarizationMetric(
        threshold=threshold,
        n=n,
        model=_resolve_model(model, config),
        **kwargs,
    )


def _default_geval_params() -> list[Any]:
    """Evaluation params for the default clinical GEval (INPUT + ACTUAL_OUTPUT).

    Prefer the non-deprecated ``SingleTurnParams`` and fall back to
    ``LLMTestCaseParams`` for older deepeval.
    """
    try:
        from deepeval.test_case import SingleTurnParams as Params  # type: ignore[attr-defined]
    except ImportError:  # pragma: no cover - older deepeval
        from deepeval.test_case import LLMTestCaseParams as Params

    return [Params.INPUT, Params.ACTUAL_OUTPUT]


def build_geval_metric(
    *,
    name: str = DEFAULT_GEVAL_NAME,
    criteria: str | None = None,
    evaluation_steps: list[str] | None = None,
    evaluation_params: list[Any] | None = None,
    threshold: float = 0.7,
    model: Any = None,
    config: JudgeConfig | None = None,
    **kwargs: Any,
) -> Any:
    """DeepEval ``GEval`` metric (defaults to a clinical-faithfulness rubric).

    Provide *either* ``criteria`` (free-text rubric) or ``evaluation_steps``
    (explicit chain). When neither is given, the default clinical criteria are
    used.
    """
    _require_deepeval()
    from deepeval.metrics import GEval

    geval_kwargs: dict[str, Any] = {
        "name": name,
        "evaluation_params": evaluation_params or _default_geval_params(),
        "threshold": threshold,
        "model": _resolve_model(model, config),
        **kwargs,
    }
    if evaluation_steps is not None:
        geval_kwargs["evaluation_steps"] = evaluation_steps
    else:
        geval_kwargs["criteria"] = criteria or DEFAULT_GEVAL_CRITERIA

    return GEval(**geval_kwargs)


def to_llm_test_case(case: GoldenCase, *, actual_output: str | None = None) -> LLMTestCase:
    """Convert a :class:`GoldenCase` into a DeepEval ``LLMTestCase``.

    * ``input`` — the joined grounding source text,
    * ``actual_output`` — the generated note (or an override),
    * ``retrieval_context`` — faithfulness contexts (used by FaithfulnessMetric),
    * ``context`` — the same grounding set (used by HallucinationMetric).
    """
    _require_deepeval()
    from deepeval.test_case import LLMTestCase

    contexts = case.faithfulness_contexts()
    return LLMTestCase(
        input="\n\n".join(case.source_documents),
        actual_output=actual_output if actual_output is not None else case.generated_note,
        expected_output=case.reference_note,
        retrieval_context=list(contexts),
        context=list(contexts),
    )
