"""TASK-351 P2-2 — direct Cadence-Fast loader + registry routing tests.

The D-2 spike (docs/implementation/TASK-351-Realtime-Transcription-Performance/
spike-cadence-fast.md) verified that ``ai4bharat/Cadence-Fast`` loads under the
pinned transformers 5.5.4 only with ``tie_word_embeddings=False`` and a
post-load ``use_bidirectional_attention = True``. These tests pin that exact
load recipe (fully mocked — no weights, no network) and the registry routing
for the new ``cadence-fast`` model option.
"""

import asyncio
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from stt_v2.punctuation import cadence_fast, service


@pytest.fixture(autouse=True)
def _reset_service_state():
    """Reset the punctuation service registry around each test."""
    service._models.clear()
    service._default_model_name = None
    service._enabled = True
    service._suppression_warned = False
    yield
    service._models.clear()
    service._default_model_name = None
    service._enabled = True
    service._suppression_warned = False


def _make_settings(cache_dir=None):
    settings = MagicMock()
    settings.punctuation_model_cache_dir = cache_dir
    return settings


class TestLoadModelSpikeKwargs:
    """The loader must use the exact spike-verified transformers recipe."""

    def _load_with_mocks(self, cache_dir=None):
        fake_transformers = MagicMock()
        fake_model = fake_transformers.AutoModel.from_pretrained.return_value
        fake_model.config.id2label = {0: "O", 1: "."}
        with (
            patch.dict(sys.modules, {"transformers": fake_transformers}),
            patch(
                "stt_v2.punctuation.cadence_fast.get_settings",
                return_value=_make_settings(cache_dir),
            ),
            patch.object(
                cadence_fast.CadenceFastModel, "punctuate", return_value=["ok"]
            ) as warmup,
        ):
            loaded = cadence_fast.load_model()
        return fake_transformers, fake_model, warmup, loaded

    def test_model_loaded_with_trust_remote_code_and_untied_embeddings(self):
        fake_transformers, _, _, _ = self._load_with_mocks()

        fake_transformers.AutoModel.from_pretrained.assert_called_once_with(
            cadence_fast.MODEL_ID,
            revision=cadence_fast.REVISION,
            trust_remote_code=True,
            tie_word_embeddings=False,
            cache_dir=None,
        )

    def test_tokenizer_loaded_with_trust_remote_code(self):
        fake_transformers, _, _, _ = self._load_with_mocks()

        fake_transformers.AutoTokenizer.from_pretrained.assert_called_once_with(
            cadence_fast.MODEL_ID,
            revision=cadence_fast.REVISION,
            trust_remote_code=True,
            cache_dir=None,
        )

    def test_revision_is_pinned_to_spike_audited_sha(self):
        assert cadence_fast.REVISION == (
            "8971c5011e4fba5dcfbcac52744587d7da605534"
        )

    def test_model_set_to_eval_with_bidirectional_attention(self):
        _, fake_model, _, _ = self._load_with_mocks()

        fake_model.eval.assert_called_once_with()
        assert fake_model.config.use_bidirectional_attention is True

    def test_warmup_inference_runs_on_load(self):
        _, _, warmup, loaded = self._load_with_mocks()

        warmup.assert_called_once()
        (texts,) = warmup.call_args.args
        assert len(texts) == 1
        assert texts[0].strip()
        assert isinstance(loaded, cadence_fast.CadenceFastModel)

    def test_cache_dir_setting_is_forwarded(self):
        fake_transformers, _, _, _ = self._load_with_mocks(cache_dir="/tmp/punct")

        _, kwargs = fake_transformers.AutoModel.from_pretrained.call_args
        assert kwargs["cache_dir"] == "/tmp/punct"


class _FakeTensor:
    def __init__(self, values):
        self._values = list(values)

    def tolist(self):
        return list(self._values)


class _FakeTokenizer:
    all_special_ids = [0, 99]

    def __init__(self, ids, mask):
        self._ids = ids
        self._mask = mask

    def __call__(self, text, return_tensors=None, padding=None, truncation=None):
        return {
            "input_ids": [_FakeTensor(self._ids)],
            "attention_mask": [_FakeTensor(self._mask)],
        }

    def convert_ids_to_tokens(self, ids):
        return [f"t{i}" for i in ids]

    def convert_tokens_to_string(self, pieces):
        return " ".join(pieces)


class _FakeTorch:
    @staticmethod
    def argmax(logits, dim):
        return logits

    class inference_mode:  # noqa: N801 — mirrors the torch API
        def __enter__(self):
            return None

        def __exit__(self, *exc):
            return False


class TestCadenceFastModelDecode:
    def test_punctuate_inserts_marks_skips_specials_and_padding(self):
        # ids: 0 = BOS (special), 5/6 = real tokens, 99 = pad (special+masked)
        tokenizer = _FakeTokenizer(ids=[0, 5, 6, 99], mask=[1, 1, 1, 0])
        preds = _FakeTensor([1, 0, 2, 1])  # ".", "O", "?", "."
        backbone = MagicMock()
        backbone.config.id2label = {"0": "O", "1": ".", "2": "?"}
        backbone.return_value = SimpleNamespace(logits=[preds])

        model = cadence_fast.CadenceFastModel(tokenizer=tokenizer, model=backbone)
        with patch.dict(sys.modules, {"torch": _FakeTorch}):
            result = model.punctuate(["hello world"])

        # t5 has label "O" (no mark); t6 gets "?"; specials/padding skipped.
        assert result == ["t5 t6 ?"]

    def test_punctuate_serializes_concurrent_calls(self):
        backbone = MagicMock()
        backbone.config.id2label = {0: "O"}
        model = cadence_fast.CadenceFastModel(tokenizer=MagicMock(), model=backbone)

        active = 0
        max_active = 0
        guard = threading.Lock()

        def fake_one(text):
            nonlocal active, max_active
            with guard:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.02)
            with guard:
                active -= 1
            return text

        model._punctuate_one = fake_one  # type: ignore[method-assign]

        threads = [
            threading.Thread(target=model.punctuate, args=(["x"],)) for _ in range(4)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert max_active == 1


class TestServiceRouting:
    """service._load_model must route the 'cadence-fast' name to the direct loader."""

    @patch("stt_v2.punctuation.cadence_fast.load_model")
    def test_cadence_fast_name_routes_to_direct_loader(self, mock_load):
        sentinel = MagicMock()
        mock_load.return_value = sentinel
        wrapper_cls = MagicMock()

        with patch.dict(
            sys.modules, {"cadence": MagicMock(PunctuationModel=wrapper_cls)}
        ):
            result = service._load_model(cadence_fast.MODEL_NAME)

        assert result is sentinel
        mock_load.assert_called_once_with()
        wrapper_cls.assert_not_called()

    @patch("stt_v2.punctuation.cadence_fast.load_model")
    @patch("stt_v2.punctuation.service.get_settings")
    def test_wrapper_names_keep_legacy_loader(self, mock_settings, mock_load):
        settings = MagicMock()
        settings.punctuation_device = "cpu"
        settings.punctuation_model_cache_dir = None
        settings.punctuation_max_length = 300
        mock_settings.return_value = settings
        instance = MagicMock()
        wrapper_cls = MagicMock(return_value=instance)

        with patch.dict(
            sys.modules, {"cadence": MagicMock(PunctuationModel=wrapper_cls)}
        ):
            result = service._load_model("Cadence-Fast")

        assert result is instance
        wrapper_cls.assert_called_once()
        mock_load.assert_not_called()

    @patch("stt_v2.punctuation.cadence_fast.load_model")
    def test_get_model_lazy_loads_cadence_fast_once(self, mock_load):
        instance = MagicMock()
        mock_load.return_value = instance

        first = service.get_model(cadence_fast.MODEL_NAME)
        second = service.get_model(cadence_fast.MODEL_NAME)

        assert first is instance
        assert second is instance
        mock_load.assert_called_once()


class TestPunctuateLazyLoadOffLoop:
    """TASK-351 P2-2 — lazy model load must not block the event loop.

    The streaming worker wraps service.punctuate in asyncio.wait_for; the
    timeout can only fire (and the raw final go out on time) if the blocking
    model lookup/load runs in the executor, not on the loop thread.
    """

    async def test_lazy_load_does_not_block_event_loop(self):
        model = MagicMock()
        model.punctuate.return_value = ["Hello."]

        def slow_load(name):
            time.sleep(0.4)
            return model

        with patch("stt_v2.punctuation.service._load_model", side_effect=slow_load):
            start = time.monotonic()
            task = asyncio.create_task(
                service.punctuate("hello", model_name="slow-model")
            )
            await asyncio.sleep(0.05)
            loop_latency = time.monotonic() - start
            result = await task

        assert result == "Hello."
        assert loop_latency < 0.3, (
            f"event loop was blocked for {loop_latency:.3f}s during lazy model load"
        )
