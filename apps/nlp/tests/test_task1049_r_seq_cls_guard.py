"""TASK-1049 R2 — the sequence-classification guard runtime (Prompt Guard 2 class).

R1 replaces GLiGuard for `jailbreak_detection` with a DeBERTa sequence classifier
served by THIS service behind `/guard/classify`. R2 lists the mechanics that
silently break its accuracy when missed, and each one is pinned here:

* the tokenizer is the repo's own ``tokenizer.json`` loaded through
  ``tokenizers`` — never ``AutoTokenizer``, which in transformers 5 rebuilds the
  tokenizer and drops Prompt Guard 2's anti-obfuscation normaliser (a letter-spaced
  attack scored 0.004 instead of 0.999 in the TASK-1049 eval);
* a window is split into <= 512-token segments with 64 tokens of overlap, and it
  is as malicious as its WORST segment;
* forward passes carry at most 8 segments;
* labels, benign labels and the threshold are the caller's ``labelTaxonomy`` —
  this module holds none of them.

Every model and tokenizer here is a FAKE installed into ``sys.modules``: no
checkpoint is ever instantiated and the hub is never contacted.
"""

from __future__ import annotations

import asyncio
import math
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import torch

ATTACK_ID = 99
PREFIX = [1]
SUFFIX = [2]
PAD_ID = 0

LABELS = ["BENIGN", "MALICIOUS"]
TASK = {
    "jailbreak_detection": {"labels": LABELS, "multi_label": False, "benign_labels": ["BENIGN"]}
}


# ── fakes ────────────────────────────────────────────────────────────────


class FakeEncoding:
    def __init__(self, ids: list[int]) -> None:
        self.ids = ids


class FakeTokenizer:
    """One token per whitespace word; ``ATTACK`` is token 99. Template ``[1] … [2]``."""

    loaded_from: list[str] = []

    def __init__(self) -> None:
        self.padding_disabled = False
        self.truncation_disabled = False

    @classmethod
    def from_file(cls, path: str) -> FakeTokenizer:
        cls.loaded_from.append(path)
        return cls()

    def encode(self, text: str, add_special_tokens: bool = True) -> FakeEncoding:
        ids = [ATTACK_ID if word == "ATTACK" else 10 for word in text.split()]
        return FakeEncoding([*PREFIX, *ids, *SUFFIX] if add_special_tokens else ids)

    def post_process(self, encoding: FakeEncoding) -> FakeEncoding:
        return FakeEncoding([*PREFIX, *encoding.ids, *SUFFIX])

    def no_padding(self) -> None:
        self.padding_disabled = True

    def no_truncation(self) -> None:
        self.truncation_disabled = True


class FakeModel:
    """P(index 1) is ``attack_p`` for a row holding token 99, ``clean_p`` otherwise."""

    def __init__(
        self,
        *,
        attack_p: float = 0.98,
        clean_p: float = 0.02,
        num_labels: int = 2,
        max_pos: int = 512,
    ) -> None:
        self.attack_p = attack_p
        self.clean_p = clean_p
        self.config = SimpleNamespace(
            num_labels=num_labels, pad_token_id=PAD_ID, max_position_embeddings=max_pos
        )
        self.num_labels = num_labels
        self.batches: list[list[list[int]]] = []
        self.evaluated = False

    def eval(self) -> FakeModel:
        self.evaluated = True
        return self

    def to(self, _device: str) -> FakeModel:
        return self

    def __call__(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> Any:
        rows: list[list[int]] = []
        logits: list[list[float]] = []
        for ids, mask in zip(input_ids.tolist(), attention_mask.tolist(), strict=True):
            row = [i for i, m in zip(ids, mask, strict=True) if m]
            rows.append(row)
            p = self.attack_p if ATTACK_ID in row else self.clean_p
            logit = math.log(p / (1 - p))
            logits.append([0.0, logit] + [-50.0] * (self.num_labels - 2))
        self.batches.append(rows)
        return SimpleNamespace(logits=torch.tensor(logits))


class Recorder:
    def __init__(self) -> None:
        self.model_calls: list[tuple[str, dict[str, Any]]] = []
        self.auto_tokenizer_calls = 0


@pytest.fixture()
def fake_libs(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    """Fake ``transformers`` + ``tokenizers`` modules: nothing real can load."""
    recorder = Recorder()
    FakeTokenizer.loaded_from = []
    holder: dict[str, FakeModel] = {"model": FakeModel()}

    class AutoModelForSequenceClassification:
        @staticmethod
        def from_pretrained(source: str, **kwargs: Any) -> FakeModel:
            recorder.model_calls.append((source, kwargs))
            return holder["model"]

    class AutoTokenizer:
        @staticmethod
        def from_pretrained(*_a: Any, **_k: Any) -> Any:
            recorder.auto_tokenizer_calls += 1
            raise AssertionError("AutoTokenizer must never be used for a guard classifier")

    transformers = types.ModuleType("transformers")
    transformers.AutoModelForSequenceClassification = AutoModelForSequenceClassification  # type: ignore[attr-defined]
    transformers.AutoTokenizer = AutoTokenizer  # type: ignore[attr-defined]
    transformers.PreTrainedTokenizerFast = AutoTokenizer  # type: ignore[attr-defined]
    tokenizers = types.ModuleType("tokenizers")
    tokenizers.Tokenizer = FakeTokenizer  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "transformers", transformers)
    monkeypatch.setitem(sys.modules, "tokenizers", tokenizers)
    recorder.holder = holder  # type: ignore[attr-defined]
    return recorder


def _staged(tmp_path: Path) -> str:
    (tmp_path / "tokenizer.json").write_text("{}")
    (tmp_path / "config.json").write_text("{}")
    return str(tmp_path)


def _service(tmp_path: Path, fake_libs: Recorder, model: FakeModel | None = None) -> Any:
    from nlp.services.seq_cls_guard import SeqClsGuardService

    if model is not None:
        fake_libs.holder["model"] = model  # type: ignore[attr-defined]
    service = SeqClsGuardService(weights_source=_staged(tmp_path), model_id="org/guard")
    service.load()
    return service


def _classify(
    service: Any, texts: list[str], tasks: dict[str, Any] = TASK, **kw: Any
) -> list[dict]:
    threshold = kw.pop("threshold", 0.5)
    batch_size = kw.pop("batch_size", 8)
    return asyncio.run(service.batch_classify_text(texts, tasks, threshold, batch_size))


def _words(n: int, attack_at: set[int] | None = None) -> str:
    attack_at = attack_at or set()
    return " ".join("ATTACK" if i in attack_at else "word" for i in range(n))


# ── tokenizer: the repo's own tokenizer.json, never AutoTokenizer ────────


def test_tokenizer_is_loaded_from_the_staged_tokenizer_json(tmp_path, fake_libs):
    service = _service(tmp_path, fake_libs)
    assert FakeTokenizer.loaded_from == [str(tmp_path / "tokenizer.json")]
    assert fake_libs.auto_tokenizer_calls == 0
    # padding/truncation are this runtime's job (segments), never the tokenizer's
    assert service._tokenizer.padding_disabled and service._tokenizer.truncation_disabled


def test_model_loads_without_remote_code_and_in_eval_mode(tmp_path, fake_libs):
    _service(tmp_path, fake_libs)
    ((source, kwargs),) = fake_libs.model_calls
    assert source == str(tmp_path)
    assert kwargs.get("trust_remote_code") is False
    assert fake_libs.holder["model"].evaluated  # type: ignore[attr-defined]


def test_hub_reference_downloads_only_its_tokenizer_json(tmp_path, fake_libs, monkeypatch):
    from nlp.services import seq_cls_guard

    calls: list[tuple[str, str]] = []
    path = tmp_path / "tokenizer.json"
    path.write_text("{}")

    def fake_download(repo_id: str, filename: str, **_k: Any) -> str:
        calls.append((repo_id, filename))
        return str(path)

    monkeypatch.setattr(seq_cls_guard, "_hf_hub_download", fake_download)
    service = seq_cls_guard.SeqClsGuardService(weights_source="org/guard", model_id="org/guard")
    service.load()
    assert calls == [("org/guard", "tokenizer.json")]
    assert FakeTokenizer.loaded_from == [str(path)]
    assert fake_libs.auto_tokenizer_calls == 0


def test_a_staged_directory_without_tokenizer_json_fails_closed(tmp_path, fake_libs):
    from nlp.services.seq_cls_guard import SeqClsGuardService

    (tmp_path / "config.json").write_text("{}")
    service = SeqClsGuardService(weights_source=str(tmp_path), model_id="org/guard")
    with pytest.raises(RuntimeError, match="tokenizer.json"):
        service.load()
    assert fake_libs.auto_tokenizer_calls == 0


# ── segmentation: 512 tokens, 64 overlap, max over segments ──────────────


def test_token_segments_cover_everything_with_the_declared_overlap():
    from nlp.services.seq_cls_guard import token_segments

    assert token_segments(0, max_tokens=510, overlap=64) == []
    assert token_segments(510, max_tokens=510, overlap=64) == [(0, 510)]
    assert token_segments(1200, max_tokens=510, overlap=64) == [(0, 510), (446, 956), (892, 1200)]


def test_segments_are_at_most_512_tokens_including_special_tokens(tmp_path, fake_libs):
    service = _service(tmp_path, fake_libs)
    _classify(service, [_words(1200)])
    (rows,) = fake_libs.holder["model"].batches  # type: ignore[attr-defined]
    assert len(rows) == 3
    assert all(len(row) <= 512 for row in rows)
    assert all(row[0] == PREFIX[0] and row[-1] == SUFFIX[0] for row in rows)
    # consecutive segments share exactly 64 content tokens
    assert [len(row) - 2 for row in rows] == [510, 510, 308]


def test_the_window_is_as_malicious_as_its_worst_segment(tmp_path, fake_libs):
    """An attack only in the LAST segment still flags the whole window."""
    service = _service(tmp_path, fake_libs)
    (verdict,) = _classify(service, [_words(1200, attack_at={1150})])
    assert verdict["jailbreak_detection"]["label"] == "MALICIOUS"
    assert verdict["jailbreak_detection"]["confidence"] == pytest.approx(0.98)


def test_a_clean_window_reports_the_benign_label_of_its_worst_segment(tmp_path, fake_libs):
    service = _service(tmp_path, fake_libs)
    (verdict,) = _classify(service, [_words(1200)])
    assert verdict == {
        "jailbreak_detection": {"label": "BENIGN", "confidence": pytest.approx(0.98)}
    }


def test_segment_length_never_exceeds_the_models_own_position_limit(tmp_path, fake_libs):
    service = _service(tmp_path, fake_libs, FakeModel(max_pos=256))
    _classify(service, [_words(600)])
    rows = fake_libs.holder["model"].batches[0]  # type: ignore[attr-defined]
    assert [len(row) for row in rows] == [256, 256, 222]


def test_a_position_limit_too_small_for_the_overlap_fails_closed(tmp_path, fake_libs):
    with pytest.raises(RuntimeError, match="overlap"):
        _service(tmp_path, fake_libs, FakeModel(max_pos=16))


def test_forward_passes_carry_at_most_eight_segments(tmp_path, fake_libs):
    service = _service(tmp_path, fake_libs)
    _classify(service, [_words(1200) for _ in range(5)], batch_size=32)
    sizes = [len(rows) for rows in fake_libs.holder["model"].batches]  # type: ignore[attr-defined]
    assert sizes == [8, 7]


def test_a_smaller_lane_batch_is_respected(tmp_path, fake_libs):
    service = _service(tmp_path, fake_libs)
    _classify(service, [_words(1200) for _ in range(2)], batch_size=4)
    sizes = [len(rows) for rows in fake_libs.holder["model"].batches]  # type: ignore[attr-defined]
    assert sizes == [4, 2]


def test_results_stay_aligned_with_their_texts(tmp_path, fake_libs):
    service = _service(tmp_path, fake_libs)
    verdicts = _classify(service, [_words(30), _words(1200, attack_at={600}), _words(5)])
    labels = [v["jailbreak_detection"]["label"] for v in verdicts]
    assert labels == ["BENIGN", "MALICIOUS", "BENIGN"]


# ── labelTaxonomy-driven decision ────────────────────────────────────────


@pytest.mark.parametrize(
    ("attack_p", "threshold", "expected", "confidence"),
    [
        (0.7, 0.5, "MALICIOUS", 0.7),
        (0.7, 0.9, "BENIGN", 0.3),
        (0.4, 0.3, "MALICIOUS", 0.4),
    ],
)
def test_the_request_threshold_decides(
    tmp_path, fake_libs, attack_p, threshold, expected, confidence
):
    service = _service(tmp_path, fake_libs, FakeModel(attack_p=attack_p))
    (verdict,) = _classify(service, ["please ATTACK now"], threshold=threshold)
    assert verdict["jailbreak_detection"] == {
        "label": expected,
        "confidence": pytest.approx(confidence),
    }


def test_a_task_cls_threshold_wins_over_the_request_threshold(tmp_path, fake_libs):
    service = _service(tmp_path, fake_libs, FakeModel(attack_p=0.7))
    tasks = {"jailbreak_detection": {**TASK["jailbreak_detection"], "cls_threshold": 0.9}}
    (verdict,) = _classify(service, ["ATTACK"], tasks, threshold=0.5)
    assert verdict["jailbreak_detection"]["label"] == "BENIGN"


def test_labels_map_to_logits_in_taxonomy_order(tmp_path, fake_libs):
    """Index i of the head is ``labels[i]`` — the taxonomy names the classes."""
    service = _service(tmp_path, fake_libs)
    tasks = {
        "jailbreak_detection": {
            "labels": ["clean", "injection"],
            "multi_label": False,
            "benign_labels": ["Clean"],  # benign matching is case-insensitive
        }
    }
    (verdict,) = _classify(service, ["ATTACK"], tasks)
    assert verdict["jailbreak_detection"]["label"] == "injection"


@pytest.mark.parametrize(
    "spec",
    [
        {"labels": LABELS, "multi_label": False},  # no benign labels
        {"labels": LABELS, "multi_label": False, "benign_labels": ["SAFE"]},  # not in labels
        {"labels": LABELS, "multi_label": False, "benign_labels": LABELS},  # nothing to flag
        {"labels": ["A", "B", "C"], "multi_label": False, "benign_labels": ["A"]},  # 3 != 2 logits
        {"labels": LABELS, "multi_label": True, "benign_labels": ["BENIGN"]},  # softmax head
    ],
)
def test_an_unusable_task_spec_raises_instead_of_guessing(tmp_path, fake_libs, spec):
    service = _service(tmp_path, fake_libs)
    with pytest.raises(ValueError):
        _classify(service, ["ATTACK"], {"jailbreak_detection": spec})


def test_more_than_one_task_on_a_single_head_is_refused(tmp_path, fake_libs):
    service = _service(tmp_path, fake_libs)
    tasks = {**TASK, "prompt_safety": TASK["jailbreak_detection"]}
    with pytest.raises(ValueError, match="one task"):
        _classify(service, ["ATTACK"], tasks)


def test_no_texts_is_no_pass(tmp_path, fake_libs):
    service = _service(tmp_path, fake_libs)
    assert _classify(service, []) == []
    assert fake_libs.holder["model"].batches == []  # type: ignore[attr-defined]
