"""TASK-1009 — the faster-whisper decode for ONE cross-stream batch.

``FasterWhisperBatchDecoder`` reproduces, for N independent windows at once,
exactly what ``BatchedInferencePipeline.transcribe`` does for ONE window of
under 30 s (the path every streaming decode takes today): mel features, an
optional language detection, one CTranslate2 ``generate`` over the batch, the
timestamp split, word alignment and the speech-timestamp restore.

The fakes below stand in for ``faster_whisper`` and CTranslate2 — the real
packages are not installed in CI (`.[test]` does not pull the `ml` extra) and
a unit test must not load weights. Each fake audio window is a constant array
whose value is the window's MARKER, so every stage can prove which window it
is handling and that results fan back to the right caller.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from stt.streaming.faster_whisper_batch_decoder import (
    FasterWhisperBatchDecoder,
    FwBatchItem,
    FwBatchKey,
)

_N_FRAMES = 8
_LANG_TOKENS = {"en": 50, "ml": 51, "hi": 52}
_TASK_TOKENS = {"transcribe": 60, "translate": 61}
_SOT, _SOT_PREV, _NO_TS, _EOT = 1, 2, 3, 1000
#: Marker -> the language the fake LID reports for it.
_LID = {7: "en", 8: "ml", 9: "en"}


class _FakeTokenizer:
    def __init__(self, _hf, multilingual: bool, *, task: str, language: str) -> None:
        self.multilingual = multilingual
        self.task = task
        self.language_code = language
        self.sot = _SOT
        self.sot_prev = _SOT_PREV
        self.eot = _EOT
        self.no_timestamps = _NO_TS
        self.sot_sequence = [_SOT, _LANG_TOKENS[language], _TASK_TOKENS[task]]

    def encode(self, text: str) -> list[int]:
        return [ord(c) for c in text]

    def decode(self, tokens: list[int]) -> str:
        return "".join(chr(t) for t in tokens if t < self.eot)


class _FakeCt2:
    """Stands in for ``ctranslate2.models.Whisper``."""

    def __init__(self, *, multilingual: bool) -> None:
        self.is_multilingual = multilingual
        self.device = "cpu"
        self.device_index = [0]
        self.encode_calls: list[dict[str, Any]] = []
        self.generate_calls: list[dict[str, Any]] = []
        self.detect_calls = 0

    def encode(self, features, to_cpu: bool = False):
        markers = [int(round(float(f[0, 0]))) for f in features]
        self.encode_calls.append({"markers": markers, "to_cpu": to_cpu})
        # "Encoder output": one row per window, carrying its marker.
        return np.array([[m, m] for m in markers], dtype=np.float32)

    def detect_language(self, encoder_output):
        self.detect_calls += 1
        return [
            [(f"<|{_LID[int(row[0])]}|>", 0.9), ("<|hi|>", 0.05)]
            for row in np.asarray(encoder_output)
        ]

    def generate(self, encoder_output, prompts, **kwargs):
        markers = [int(row[0]) for row in np.asarray(encoder_output)]
        self.generate_calls.append({"markers": markers, "prompts": prompts, **kwargs})
        return [
            SimpleNamespace(
                sequences_ids=[[ord(c) for c in f"w{m}"]], scores=[-0.1], no_speech_prob=0.01
            )
            for m in markers
        ]


class _FakeWhisperModel:
    """Stands in for ``faster_whisper.WhisperModel``."""

    max_length = 448
    frames_per_second = 100

    def __init__(self, *, multilingual: bool = True, fail_marker: int | None = None) -> None:
        self.model = _FakeCt2(multilingual=multilingual)
        self.hf_tokenizer = object()
        self._fail_marker = fail_marker
        self.alignment_calls: list[int] = []

        model = self

        class _FE:
            chunk_length = 30
            nb_max_frames = _N_FRAMES

            def __call__(self, audio):
                marker = float(audio[0])
                if model._fail_marker is not None and int(marker) == model._fail_marker:
                    raise ValueError("bad audio")
                frames = max(1, len(audio) // 160) + 1
                return np.full((2, frames), marker, dtype=np.float32)

        self.feature_extractor = _FE()

    def get_prompt(self, tokenizer, previous_tokens, without_timestamps=False, hotwords=None):
        prompt: list[int] = []
        if previous_tokens:
            prompt.append(tokenizer.sot_prev)
            prompt.extend(previous_tokens)
        prompt.extend(tokenizer.sot_sequence)
        if without_timestamps:
            prompt.append(tokenizer.no_timestamps)
        return prompt

    def _split_segments_by_timestamps(
        self, tokenizer, tokens, time_offset, segment_size, segment_duration, seek
    ):
        return (
            [{"start": time_offset, "end": time_offset + segment_duration, "tokens": tokens}],
            seek,
            False,
        )

    def find_alignment(self, tokenizer, text_tokens, encoder_output, num_frames):
        self.alignment_calls.append(len(text_tokens))
        return [
            [
                {
                    "word": tokenizer.decode(t),
                    "tokens": t,
                    "start": 0.1,
                    "end": 0.4,
                    "probability": 0.8,
                }
            ]
            for t in text_tokens
        ]


def _fake_add_word_timestamps(
    shim, segments, tokenizer, encoder_output, num_frames, prepend, append, last_ts
):
    """Mimics the real method's contract: it asks ``shim.find_alignment``."""
    _fake_add_word_timestamps.last_ts_seen.append(last_ts)
    alignments = shim.find_alignment(tokenizer, [], encoder_output, num_frames)
    for segment, alignment in zip(segments, alignments, strict=True):
        segment[0]["words"] = [
            {k: w[k] for k in ("word", "start", "end", "probability")} for w in alignment
        ]
    return 0.0


_fake_add_word_timestamps.last_ts_seen = []


def _fake_pad_or_trim(array, length: int = _N_FRAMES):
    if array.shape[-1] >= length:
        return array[..., :length]
    return np.pad(array, [(0, 0), (0, length - array.shape[-1])])


def _ops(**overrides):
    ops = SimpleNamespace(
        Tokenizer=_FakeTokenizer,
        pad_or_trim=_fake_pad_or_trim,
        get_ctranslate2_storage=lambda a: np.ascontiguousarray(a),
        get_suppressed_tokens=lambda tok, s: (99,),
        get_compression_ratio=lambda text: 1.0,
        add_word_timestamps=_fake_add_word_timestamps,
        restore_speech_timestamps=lambda segments, chunks, sr: list(segments),
        Segment=lambda **kw: SimpleNamespace(**kw),
        Word=lambda **kw: SimpleNamespace(**kw),
        transcribe_defaults={
            "patience": 1,
            "length_penalty": 1,
            "repetition_penalty": 1,
            "no_repeat_ngram_size": 0,
            "beam_size": 5,
            "temperature": [0.0, 0.2],
            "suppress_blank": True,
            "suppress_tokens": [-1],
            "without_timestamps": True,
            "word_timestamps": False,
            "max_new_tokens": None,
            "prepend_punctuations": "p",
            "append_punctuations": "a",
        },
    )
    for name, value in overrides.items():
        setattr(ops, name, value)
    return ops


def _key(language: str | None = "ml", task: str = "transcribe", **decode) -> FwBatchKey:
    decode.setdefault("word_timestamps", True)
    return FwBatchKey.build(task=task, language=language, decode=decode)


def _window(marker: int, seconds: float = 7.0) -> np.ndarray:
    return np.full(int(seconds * 16000), float(marker), dtype=np.float32)


@pytest.fixture(autouse=True)
def _reset_word_timestamp_log():
    _fake_add_word_timestamps.last_ts_seen = []


class TestOneBatchedDecode:
    def test_n_windows_share_one_encode_and_one_generate(self) -> None:
        model = _FakeWhisperModel()
        decoder = FasterWhisperBatchDecoder(model, ops=_ops())

        out = decoder(_key(), [FwBatchItem(_window(m), None) for m in (7, 8, 9)])

        assert [e["markers"] for e in model.model.encode_calls] == [[7, 8, 9]]
        assert len(model.model.generate_calls) == 1
        assert [o.segments[0].text for o in out] == ["w7", "w8", "w9"]

    def test_each_window_keeps_its_own_session_prompt(self) -> None:
        model = _FakeWhisperModel()
        decoder = FasterWhisperBatchDecoder(model, ops=_ops())

        decoder(_key(), [FwBatchItem(_window(7), "ab"), FwBatchItem(_window(8), "cd")])

        (call,) = model.model.generate_calls
        sot = _FakeTokenizer(None, True, task="transcribe", language="ml").sot_sequence
        assert call["prompts"] == [
            [_SOT_PREV, ord("a"), ord("b"), *sot, _NO_TS],
            [_SOT_PREV, ord("c"), ord("d"), *sot, _NO_TS],
        ]

    def test_prompts_of_different_lengths_share_the_encode_but_not_the_generate(self) -> None:
        # CTranslate2 refuses a batch whose <|startoftranscript|> positions differ,
        # so carry-forward text of different lengths decodes in separate generate
        # calls — but the encoder (the expensive half) still runs once.
        model = _FakeWhisperModel()
        decoder = FasterWhisperBatchDecoder(model, ops=_ops())

        out = decoder(
            _key(),
            [
                FwBatchItem(_window(7), None),
                FwBatchItem(_window(8), "abc"),
                FwBatchItem(_window(9), None),
            ],
        )

        assert [e["markers"] for e in model.model.encode_calls] == [[7, 8, 9]]
        assert model.model.encode_calls[0]["to_cpu"] is True
        assert sorted(c["markers"] for c in model.model.generate_calls) == [[7, 9], [8]]
        assert [o.segments[0].text for o in out] == ["w7", "w8", "w9"]

    def test_decode_options_come_from_the_key_over_the_library_defaults(self) -> None:
        model = _FakeWhisperModel()
        decoder = FasterWhisperBatchDecoder(model, ops=_ops())

        decoder(
            _key(beam_size=1, temperature=[0.3, 0.6], no_repeat_ngram_size=4),
            [FwBatchItem(_window(7), None)],
        )

        (call,) = model.model.generate_calls
        assert call["beam_size"] == 1
        # BatchedInferencePipeline decodes at the FIRST temperature only.
        assert call["sampling_temperature"] == 0.3
        assert call["no_repeat_ngram_size"] == 4
        assert call["patience"] == 1
        assert call["suppress_tokens"] == (99,)
        assert call["max_length"] == _FakeWhisperModel.max_length
        assert call["return_scores"] is True and call["return_no_speech_prob"] is True


class TestLanguage:
    def test_a_pinned_language_skips_detection(self) -> None:
        model = _FakeWhisperModel()
        decoder = FasterWhisperBatchDecoder(model, ops=_ops())

        out = decoder(_key(language="ml"), [FwBatchItem(_window(7), None)])

        assert model.model.detect_calls == 0
        assert out[0].language == "ml"

    def test_auto_lid_partitions_the_batch_by_detected_language(self) -> None:
        model = _FakeWhisperModel()
        decoder = FasterWhisperBatchDecoder(model, ops=_ops())

        out = decoder(_key(language=None), [FwBatchItem(_window(m), None) for m in (7, 8, 9)])

        assert model.model.detect_calls == 1
        assert [o.language for o in out] == ["en", "ml", "en"]
        by_lang = {c["prompts"][0][1]: sorted(c["markers"]) for c in model.model.generate_calls}
        assert by_lang == {_LANG_TOKENS["en"]: [7, 9], _LANG_TOKENS["ml"]: [8]}

    def test_an_english_only_model_decodes_a_pinned_language_as_english(self) -> None:
        # Same coercion BatchedInferencePipeline applies (with a warning): a
        # non-multilingual model has no language token for anything but English.
        model = _FakeWhisperModel(multilingual=False)
        decoder = FasterWhisperBatchDecoder(model, ops=_ops())

        out = decoder(_key(language="ml"), [FwBatchItem(_window(7), None)])

        assert out[0].language == "en"
        assert model.model.generate_calls[0]["prompts"][0][1] == _LANG_TOKENS["en"]


class TestWordTimestamps:
    def test_alignment_runs_once_per_batch_and_each_window_starts_from_zero(self) -> None:
        model = _FakeWhisperModel()
        decoder = FasterWhisperBatchDecoder(model, ops=_ops())

        out = decoder(_key(), [FwBatchItem(_window(m), None) for m in (7, 8)])

        assert model.alignment_calls == [2]
        # The per-call path starts every window at last_speech_timestamp=0.0;
        # carrying it across windows of DIFFERENT sessions would be wrong.
        assert _fake_add_word_timestamps.last_ts_seen == [0.0, 0.0]
        assert [[w.word for w in o.segments[0].words] for o in out] == [["w7"], ["w8"]]

    def test_no_word_timestamps_requested_means_no_alignment(self) -> None:
        model = _FakeWhisperModel()
        decoder = FasterWhisperBatchDecoder(model, ops=_ops())

        out = decoder(_key(word_timestamps=False), [FwBatchItem(_window(7), None)])

        assert model.alignment_calls == []
        assert out[0].segments[0].words is None


class TestIsolation:
    def test_a_window_whose_features_fail_fails_alone(self) -> None:
        model = _FakeWhisperModel(fail_marker=8)
        decoder = FasterWhisperBatchDecoder(model, ops=_ops())

        out = decoder(_key(), [FwBatchItem(_window(m), None) for m in (7, 8, 9)])

        assert isinstance(out[1], ValueError)
        assert [out[0].segments[0].text, out[2].segments[0].text] == ["w7", "w9"]
        assert [e["markers"] for e in model.model.encode_calls] == [[7, 9]]


class TestKey:
    def test_equal_configs_make_equal_hashable_keys(self) -> None:
        a = FwBatchKey.build(task="transcribe", language="ml", decode={"temperature": [0.0, 0.2]})
        b = FwBatchKey.build(task="transcribe", language="ml", decode={"temperature": [0.0, 0.2]})
        assert a == b and hash(a) == hash(b)

    @pytest.mark.parametrize(
        "other",
        [
            {"task": "translate", "language": "ml", "decode": {"beam_size": 5}},
            {"task": "transcribe", "language": "en", "decode": {"beam_size": 5}},
            {"task": "transcribe", "language": None, "decode": {"beam_size": 5}},
            {"task": "transcribe", "language": "ml", "decode": {"beam_size": 1}},
        ],
    )
    def test_any_difference_makes_a_different_key(self, other) -> None:
        base = FwBatchKey.build(task="transcribe", language="ml", decode={"beam_size": 5})
        assert FwBatchKey.build(**other) != base
