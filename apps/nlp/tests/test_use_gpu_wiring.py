"""D6 (dead-config sweep) — ``use_gpu`` on TextClassificationConfig,
TokenClassificationConfig and MedicalSuggesterConfig was defined but never
read; every ``initialize()`` unconditionally auto-detects CUDA
(``device=0 if torch.cuda.is_available() else -1``), so an operator setting
``*_USE_GPU=false`` had zero effect.

Since all three configs already default ``use_gpu=True``, honoring the field
(``device=0 if (use_gpu and torch.cuda.is_available()) else -1``) reproduces
today's auto-detect behavior exactly on an unconfigured system — only an
explicit ``use_gpu=False`` changes anything (forces CPU even when CUDA is
available).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from nlp.core.config import (
    MedicalSuggesterConfig,
    TextClassificationConfig,
    TokenClassificationConfig,
)


class _StubNer:
    """A weightless stand-in for the suggester's NER.

    `MedicalSuggester.initialize()` initializes its NER too (both selections are
    required now), and these cases patch only the SUGGESTER's transformers
    calls — a real classifier here would reach for the hub.
    """

    is_initialized = True

    async def initialize(self) -> None: ...

    async def shutdown(self) -> None: ...



class TestTextClassifierUseGpu:
    @pytest.mark.asyncio
    async def test_use_gpu_false_forces_cpu_even_when_cuda_available(self):
        """RED: use_gpu is currently ignored — pipeline always gets device=0
        when CUDA is reported available, regardless of config."""
        from nlp.services.text_classifier import TransformerTextClassifier

        config = TextClassificationConfig(
            model_name="some-org/clinical-doctype-model", use_gpu=False
        )
        classifier = TransformerTextClassifier(config=config)

        with (
            patch("nlp.services.text_classifier.AutoTokenizer"),
            patch("nlp.services.text_classifier.AutoModelForSequenceClassification"),
            patch("nlp.services.text_classifier.torch.cuda.is_available", return_value=True),
            patch(
                "nlp.services.text_classifier.pipeline", return_value=MagicMock()
            ) as mock_pipeline,
        ):
            await classifier.initialize()

        assert mock_pipeline.call_args.kwargs["device"] == -1

    @pytest.mark.asyncio
    async def test_use_gpu_default_true_preserves_cuda_auto_detect(self):
        """Default (True) preserves today's behavior: device follows
        torch.cuda.is_available() exactly."""
        from nlp.services.text_classifier import TransformerTextClassifier

        config = TextClassificationConfig(model_name="some-org/clinical-doctype-model")
        assert config.use_gpu is True
        classifier = TransformerTextClassifier(config=config)

        with (
            patch("nlp.services.text_classifier.AutoTokenizer"),
            patch("nlp.services.text_classifier.AutoModelForSequenceClassification"),
            patch("nlp.services.text_classifier.torch.cuda.is_available", return_value=True),
            patch(
                "nlp.services.text_classifier.pipeline", return_value=MagicMock()
            ) as mock_pipeline,
        ):
            await classifier.initialize()

        assert mock_pipeline.call_args.kwargs["device"] == 0


class TestTokenClassifierUseGpu:
    @pytest.mark.asyncio
    async def test_use_gpu_false_forces_cpu_even_when_cuda_available(self):
        """RED: use_gpu is currently ignored — pipeline always gets device=0
        when CUDA is reported available, regardless of config."""
        from nlp.services.token_classifier import TransformerTokenClassifier

        config = TokenClassificationConfig(
            model_name="test-org/ner", tokenizer_name="test-org/ner", use_gpu=False
        )
        classifier = TransformerTokenClassifier(configs=config)

        with (
            patch("nlp.services.token_classifier.AutoTokenizer"),
            patch("nlp.services.token_classifier.AutoModelForTokenClassification") as mock_model,
            patch("nlp.services.token_classifier.torch.cuda.is_available", return_value=True),
            patch(
                "nlp.services.token_classifier.pipeline", return_value=MagicMock()
            ) as mock_pipeline,
        ):
            mock_model.from_pretrained.return_value.config.id2label = {}
            await classifier.initialize()

        assert mock_pipeline.call_args.kwargs["device"] == -1

    @pytest.mark.asyncio
    async def test_use_gpu_default_true_preserves_cuda_auto_detect(self):
        """Default (True) preserves today's behavior: device follows
        torch.cuda.is_available() exactly."""
        from nlp.services.token_classifier import TransformerTokenClassifier

        config = TokenClassificationConfig(
            model_name="test-org/ner", tokenizer_name="test-org/ner"
        )
        assert config.use_gpu is True
        classifier = TransformerTokenClassifier(configs=config)

        with (
            patch("nlp.services.token_classifier.AutoTokenizer"),
            patch("nlp.services.token_classifier.AutoModelForTokenClassification") as mock_model,
            patch("nlp.services.token_classifier.torch.cuda.is_available", return_value=True),
            patch(
                "nlp.services.token_classifier.pipeline", return_value=MagicMock()
            ) as mock_pipeline,
        ):
            mock_model.from_pretrained.return_value.config.id2label = {}
            await classifier.initialize()

        assert mock_pipeline.call_args.kwargs["device"] == 0


class TestMedicalSuggesterUseGpu:
    @pytest.mark.asyncio
    async def test_use_gpu_false_forces_cpu_even_when_cuda_available(self):
        """RED: use_gpu is currently ignored — pipeline always gets device=0
        when CUDA is reported available, regardless of config."""
        from nlp.services.medical_suggester import MedicalSuggester

        config = MedicalSuggesterConfig(
            model_name="test-org/dx", tokenizer_name="test-org/dx", use_gpu=False
        )
        suggester = MedicalSuggester(config=config, token_classifier=_StubNer())

        with (
            patch("nlp.services.medical_suggester.AutoTokenizer"),
            patch("nlp.services.medical_suggester.AutoModelForSequenceClassification"),
            patch("nlp.services.medical_suggester.torch.cuda.is_available", return_value=True),
            patch(
                "nlp.services.medical_suggester.pipeline", return_value=MagicMock()
            ) as mock_pipeline,
        ):
            await suggester.initialize()

        assert mock_pipeline.call_args.kwargs["device"] == -1

    @pytest.mark.asyncio
    async def test_use_gpu_default_true_preserves_cuda_auto_detect(self):
        """Default (True) preserves today's behavior: device follows
        torch.cuda.is_available() exactly."""
        from nlp.services.medical_suggester import MedicalSuggester

        config = MedicalSuggesterConfig(
            model_name="test-org/dx", tokenizer_name="test-org/dx"
        )
        assert config.use_gpu is True
        suggester = MedicalSuggester(config=config, token_classifier=_StubNer())

        with (
            patch("nlp.services.medical_suggester.AutoTokenizer"),
            patch("nlp.services.medical_suggester.AutoModelForSequenceClassification"),
            patch("nlp.services.medical_suggester.torch.cuda.is_available", return_value=True),
            patch(
                "nlp.services.medical_suggester.pipeline", return_value=MagicMock()
            ) as mock_pipeline,
        ):
            await suggester.initialize()

        assert mock_pipeline.call_args.kwargs["device"] == 0
