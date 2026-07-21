"""RED tests for S5 -- streaming punctuation restoration."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np

from stt_v2.streaming.inference import StreamingInferenceWorker
from stt_v2.streaming.preprocessor import AudioUtterance


def _make_postprocessing_config(punctuation_config):
    """Build a PostprocessingConfig-like object wrapping a punctuation config."""
    if punctuation_config is None:
        return None
    cfg = MagicMock()
    cfg.punctuation = punctuation_config
    cfg.remove_disfluencies = False
    cfg.lowercase = False
    return cfg


def _make_worker(punctuation_config=None, **kwargs):
    return StreamingInferenceWorker(
        result_publisher=None,
        asr_pipeline=lambda samples, sr: {"text": "hello world", "word_timestamps": []},
        postprocessing_config=_make_postprocessing_config(punctuation_config),
        **kwargs,
    )


class TestApplyPunctuationDisabled:
    @patch("stt_v2.punctuation.service.punctuate")
    async def test_returns_unchanged_when_disabled(self, mock_punctuate):
        worker = _make_worker(punctuation_config=None)
        result = await worker._apply_punctuation("hello world")
        assert result == "hello world"
        mock_punctuate.assert_not_awaited()

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_returns_unchanged_when_config_not_enabled(self, mock_punctuate):
        cfg = MagicMock()
        cfg.enabled = False
        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("hello world")
        assert result == "hello world"
        mock_punctuate.assert_not_awaited()


class TestApplyPunctuationEnabled:
    async def test_empty_text_returns_empty(self):
        cfg = MagicMock()
        cfg.enabled = True
        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("")
        assert result == ""

    async def test_whitespace_only_returns_as_is(self):
        cfg = MagicMock()
        cfg.enabled = True
        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("   ")
        assert result == "   "

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_restores_punctuation(self, mock_punctuate):
        mock_punctuate.return_value = "Hello world, how are you?"
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = None

        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("hello world how are you")

        assert result == "Hello world, how are you?"
        mock_punctuate.assert_awaited_once_with("hello world how are you", model_name=None)

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_passes_model_name_from_config(self, mock_punctuate):
        mock_punctuate.return_value = "Hello."
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "Cadence"

        worker = _make_worker(punctuation_config=cfg)
        await worker._apply_punctuation("hello")

        mock_punctuate.assert_awaited_once_with("hello", model_name="Cadence")

    @patch("stt_v2.punctuation.service.punctuate", side_effect=RuntimeError("model crash"))
    async def test_model_failure_returns_original(self, mock_punctuate):
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = None

        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("hello world")

        assert result == "hello world"
        mock_punctuate.assert_awaited_once_with("hello world", model_name=None)

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_multiple_calls_use_service(self, mock_punctuate):
        mock_punctuate.side_effect = ["Hello.", "World."]
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = None

        worker = _make_worker(punctuation_config=cfg)

        first = await worker._apply_punctuation("hello")
        second = await worker._apply_punctuation("world")

        assert first == "Hello."
        assert second == "World."

    @patch("stt_v2.streaming.inference.logger.debug")
    @patch("stt_v2.punctuation.service.punctuate")
    async def test_logs_before_after_when_changed(self, mock_punctuate, mock_logger_debug):
        mock_punctuate.return_value = "Hello world."
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = None

        worker = _make_worker(punctuation_config=cfg)
        await worker._apply_punctuation("Hello world")

        mock_logger_debug.assert_called_once()
        _, kwargs = mock_logger_debug.call_args
        assert kwargs["before"] == "Hello world"
        assert kwargs["after"] == "Hello world."

    @patch("stt_v2.streaming.inference.logger.debug")
    @patch("stt_v2.punctuation.service.punctuate")
    async def test_no_log_when_unchanged(self, mock_punctuate, mock_logger_debug):
        mock_punctuate.return_value = "Hello world"
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = None

        worker = _make_worker(punctuation_config=cfg)
        await worker._apply_punctuation("Hello world")

        mock_logger_debug.assert_not_called()

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_normalizes_danda_for_non_devanagari_text(self, mock_punctuate):
        mock_punctuate.return_value = "So it's another psychopathic killer.\u0964"
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = None

        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("so it's another psychopathic killer")

        assert result == "So it's another psychopathic killer."

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_normalizes_ellipsis_followed_by_danda(self, mock_punctuate):
        mock_punctuate.return_value = "What was it again the plot? I'm...\u0964"
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = None

        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("what was it again the plot im")

        assert result == "What was it again the plot? I'm..."

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_keeps_danda_for_devanagari_text(self, mock_punctuate):
        mock_punctuate.return_value = (
            "\u0928\u092e\u0938\u094d\u0924\u0947 "
            "\u0926\u0941\u0928\u093f\u092f\u093e\u0964"
        )
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = None

        worker = _make_worker(punctuation_config=cfg)
        result = await worker._apply_punctuation("hello")

        assert result == (
            "\u0928\u092e\u0938\u094d\u0924\u0947 "
            "\u0926\u0941\u0928\u093f\u092f\u093e\u0964"
        )

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_normalizes_question_and_exclamation_with_danda(self, mock_punctuate):
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = None

        worker = _make_worker(punctuation_config=cfg)

        mock_punctuate.return_value = "What now?\u0964"
        question = await worker._apply_punctuation("what now")

        mock_punctuate.return_value = "No way!\u0964"
        exclamation = await worker._apply_punctuation("no way")

        assert question == "What now?"
        assert exclamation == "No way!"


class TestProcessUtteranceWithPunctuation:
    @patch("stt_v2.punctuation.service.punctuate")
    async def test_process_utterance_applies_punctuation(self, mock_punctuate):
        mock_punctuate.return_value = "Hello world."
        cfg = MagicMock()
        cfg.enabled = True

        publisher = AsyncMock()
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: {"text": "hello world", "word_timestamps": []},
            postprocessing_config=_make_postprocessing_config(cfg),
        )

        utt = AudioUtterance(
            samples=np.random.randn(16000).astype(np.float32) * 0.1,
            sample_rate=16000,
            start_time=0.0,
            end_time=1.0,
            utterance_index=0,
        )

        result = await worker.process_utterance("s1", utt)

        assert result.text == "Hello world."


# ---------------------------------------------------------------------------
# Direct Cadence-Fast punctuation: finals-only, time-boxed, raw-text
# fallback. Legacy registry models above keep their behavior.
# ---------------------------------------------------------------------------


def _cadence_fast_cfg(enabled=True):
    cfg = MagicMock()
    cfg.enabled = enabled
    cfg.model = "cadence-fast"
    return cfg


def _make_utterance(is_final):
    return AudioUtterance(
        samples=np.random.randn(16000).astype(np.float32) * 0.1,
        sample_rate=16000,
        start_time=0.0,
        end_time=1.0,
        utterance_index=0,
        is_final=is_final,
    )


class TestCadenceFastFinalsOnly:
    @patch("stt_v2.punctuation.service.punctuate")
    async def test_partial_returns_raw_without_calling_service(self, mock_punctuate):
        worker = _make_worker(punctuation_config=_cadence_fast_cfg())

        result = await worker._apply_punctuation("hello world", is_final=False)

        assert result == "hello world"
        mock_punctuate.assert_not_called()

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_final_is_punctuated(self, mock_punctuate):
        mock_punctuate.return_value = "Hello world."
        worker = _make_worker(punctuation_config=_cadence_fast_cfg())

        result = await worker._apply_punctuation("hello world", is_final=True)

        assert result == "Hello world."
        mock_punctuate.assert_awaited_once_with(
            "hello world", model_name="cadence-fast"
        )

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_global_default_model_selects_cadence_fast(self, mock_punctuate):
        """punctuation.model: null + PUNCTUATION_MODEL_NAME=cadence-fast ⇒ selects cadence-fast."""
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = None
        settings = MagicMock()
        settings.punctuation_model_name = "cadence-fast"
        settings.streaming_extra_filler_patterns = ""

        with patch(
            "stt_v2.core.config.settings.get_settings", return_value=settings
        ):
            worker = _make_worker(punctuation_config=cfg)

        result = await worker._apply_punctuation("hello world", is_final=False)

        assert result == "hello world"
        mock_punctuate.assert_not_called()

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_wrapper_model_name_keeps_legacy_partial_behavior(
        self, mock_punctuate
    ):
        """'Cadence-Fast' (wrapper spelling) must NOT trip the finals-only path."""
        mock_punctuate.return_value = "Hello world."
        cfg = MagicMock()
        cfg.enabled = True
        cfg.model = "Cadence-Fast"
        worker = _make_worker(punctuation_config=cfg)

        result = await worker._apply_punctuation("hello world", is_final=False)

        assert result == "Hello world."
        mock_punctuate.assert_awaited_once_with(
            "hello world", model_name="Cadence-Fast"
        )

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_disabled_config_is_zero_behavior_change(self, mock_punctuate):
        worker = _make_worker(punctuation_config=_cadence_fast_cfg(enabled=False))

        result = await worker._apply_punctuation("hello world", is_final=True)

        assert result == "hello world"
        mock_punctuate.assert_not_called()


class TestCadenceFastTimeoutFallback:
    async def test_timeout_returns_raw_text(self):
        async def never_finishes(text, model_name=None):
            await asyncio.sleep(30)

        with patch("stt_v2.punctuation.service.punctuate", new=never_finishes):
            worker = _make_worker(punctuation_config=_cadence_fast_cfg())
            worker._punctuation_timeout_s = 0.01

            result = await worker._apply_punctuation("hello world", is_final=True)

        assert result == "hello world"

    @patch(
        "stt_v2.punctuation.service.punctuate",
        side_effect=RuntimeError("model crash"),
    )
    async def test_exception_returns_raw_text(self, mock_punctuate):
        worker = _make_worker(punctuation_config=_cadence_fast_cfg())

        result = await worker._apply_punctuation("hello world", is_final=True)

        assert result == "hello world"
        mock_punctuate.assert_awaited_once()

    @patch("stt_v2.streaming.inference.logger")
    @patch(
        "stt_v2.punctuation.service.punctuate",
        side_effect=RuntimeError("model crash"),
    )
    async def test_fallback_warns_once_per_session_then_debug(
        self, mock_punctuate, mock_logger
    ):
        worker = _make_worker(punctuation_config=_cadence_fast_cfg())

        first = await worker._apply_punctuation("hello", is_final=True)
        second = await worker._apply_punctuation("world", is_final=True)

        assert first == "hello"
        assert second == "world"
        fallback_warnings = [
            c
            for c in mock_logger.warning.call_args_list
            if c.args and "punctuation" in c.args[0].lower()
        ]
        fallback_debugs = [
            c
            for c in mock_logger.debug.call_args_list
            if c.args and "punctuation" in c.args[0].lower()
        ]
        assert len(fallback_warnings) == 1
        assert len(fallback_debugs) == 1


class TestCadenceFastTimeoutSetting:
    def test_timeout_read_from_settings(self):
        settings = MagicMock()
        settings.streaming_punctuation_timeout_s = 0.35
        settings.streaming_extra_filler_patterns = ""

        with patch(
            "stt_v2.core.config.settings.get_settings", return_value=settings
        ):
            worker = _make_worker(punctuation_config=_cadence_fast_cfg())

        assert worker._punctuation_timeout_s == 0.35

    def test_timeout_defaults_when_settings_unavailable(self):
        with patch(
            "stt_v2.core.config.settings.get_settings",
            side_effect=RuntimeError("no settings"),
        ):
            worker = _make_worker(punctuation_config=_cadence_fast_cfg())

        assert worker._punctuation_timeout_s == 0.4

    def test_timeout_rejects_non_positive_values(self):
        settings = MagicMock()
        settings.streaming_punctuation_timeout_s = -1.0
        settings.streaming_extra_filler_patterns = ""

        with patch(
            "stt_v2.core.config.settings.get_settings", return_value=settings
        ):
            worker = _make_worker(punctuation_config=_cadence_fast_cfg())

        assert worker._punctuation_timeout_s == 0.4


class TestCadenceFastDandaBehavior:
    """Malayalam uses Western '. , ?' (no danda) — spike-verified."""

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_malayalam_western_marks_pass_through(self, mock_punctuate):
        punctuated = (
            "\u0d30\u0d4b\u0d17\u0d3f\u0d15\u0d4d\u0d15\u0d4d "
            "\u0d2a\u0d28\u0d3f\u0d2f\u0d41\u0d23\u0d4d\u0d1f\u0d4d. "
            "\u0d0e\u0d28\u0d4d\u0d24\u0d3e\u0d23\u0d4d?"
        )
        mock_punctuate.return_value = punctuated
        worker = _make_worker(punctuation_config=_cadence_fast_cfg())

        result = await worker._apply_punctuation("raw malayalam", is_final=True)

        assert result == punctuated

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_spurious_danda_on_malayalam_normalized_to_period(
        self, mock_punctuate
    ):
        mock_punctuate.return_value = (
            "\u0d30\u0d4b\u0d17\u0d3f\u0d15\u0d4d\u0d15\u0d4d "
            "\u0d2a\u0d28\u0d3f\u0d2f\u0d41\u0d23\u0d4d\u0d1f\u0d4d\u0964"
        )
        worker = _make_worker(punctuation_config=_cadence_fast_cfg())

        result = await worker._apply_punctuation("raw malayalam", is_final=True)

        assert result == (
            "\u0d30\u0d4b\u0d17\u0d3f\u0d15\u0d4d\u0d15\u0d4d "
            "\u0d2a\u0d28\u0d3f\u0d2f\u0d41\u0d23\u0d4d\u0d1f\u0d4d."
        )


class TestCadenceFastProcessUtterance:
    @patch("stt_v2.punctuation.service.punctuate")
    async def test_partial_utterance_not_punctuated_in_flow(self, mock_punctuate):
        mock_punctuate.return_value = "SHOULD NOT APPEAR"
        publisher = AsyncMock()
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: {"text": "hello world", "word_timestamps": []},
            postprocessing_config=_make_postprocessing_config(_cadence_fast_cfg()),
        )

        result = await worker.process_utterance("s1", _make_utterance(is_final=False))

        assert result.text == "hello world"
        mock_punctuate.assert_not_called()

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_final_utterance_punctuated_before_gloss_snapshot(
        self, mock_punctuate
    ):
        """The gloss task must snapshot the punctuated text."""
        mock_punctuate.return_value = "Hello world."
        publisher = AsyncMock()
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: {"text": "hello world", "word_timestamps": []},
            postprocessing_config=_make_postprocessing_config(_cadence_fast_cfg()),
            gloss_callable=lambda samples, sr: {"text": "english gloss"},
        )
        worker._publish_gloss = AsyncMock()

        result = await worker.process_utterance("s1", _make_utterance(is_final=True))
        await asyncio.sleep(0)

        assert result.text == "Hello world."
        worker._publish_gloss.assert_called_once()
        gloss_result = worker._publish_gloss.call_args.args[2]
        assert gloss_result.text == "Hello world."

    @patch("stt_v2.punctuation.service.punctuate")
    async def test_final_timeout_still_publishes_raw_final(self, mock_punctuate):
        async def never_finishes(text, model_name=None):
            await asyncio.sleep(30)

        mock_punctuate.side_effect = never_finishes
        publisher = AsyncMock()
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: {"text": "hello world", "word_timestamps": []},
            postprocessing_config=_make_postprocessing_config(_cadence_fast_cfg()),
        )
        worker._punctuation_timeout_s = 0.01

        result = await worker.process_utterance("s1", _make_utterance(is_final=True))

        assert result.text == "hello world"
        publisher.publish.assert_awaited_once()
        published = publisher.publish.await_args.args[0]
        assert published.text == "hello world"
