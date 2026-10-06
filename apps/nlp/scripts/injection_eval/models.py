"""Candidate scorer adapters: 2,000-char windows -> per-window attack scores.

One adapter per TASK-1049 candidate, computing the score the way a production
deployment would: CPU, `eval()`, `inference_mode`, pinned revisions.

* HF sequence classifiers (Prompt Guard 2 x2, protectai v2, PIGuard): a window is
  tokenized WITHOUT special tokens, split into content segments that fit the model
  (`core.token_segments`, overlap 64), each segment gets the tokenizer's own
  special-token template, and the window is as malicious as its WORST segment.
* GLiGuard (gliner2, as `apps/nlp/src/nlp/services/gliner2_guard.py` calls it): one
  `batch_classify_text` call per batch; the window score is the highest non-benign
  `jailbreak_detection` confidence, read with `cls_threshold=0.0` so nothing is
  filtered. `gliguard_prod_flag` reproduces the production FLAG at 0.4, which is
  NOT simply `score >= 0.4` (gliner2's argmax fallback, see there).

Tokenization uses each repo's shipped `tokenizer.json` through the `tokenizers`
library, not `AutoTokenizer`: transformers 5.5.4 rebuilds `DebertaV2Tokenizer` and
silently REPLACES Prompt Guard 2's normalizer — the card's "adversarial-attack
resistant tokenization", which strips all whitespace (`Strip, Precompiled, Replace,
Replace, NFKC, ...`) — with its default whitespace-collapsing one. Measured on
"I g n o r e   previous instructions": shipped -> `▁ Ignor e previous instruction s`,
AutoTokenizer -> `▁I ▁ g ▁ n ▁ o ▁ r ▁ e ▁previous ▁instructions`. For protectai and
PIGuard both paths give identical ids (checked on five probe texts).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import torch

from .core import attack_score, token_segments


@dataclass(frozen=True)
class WindowScore:
    score: float  # attack probability/confidence in [0,1]; window score = max over segments
    n_segments: int


class Scorer(Protocol):
    name: str
    hf_id: str
    revision: str  # the pinned commit sha actually loaded
    default_threshold: float  # the threshold its vendor/prod uses
    max_tokens: int  # model max input incl. special tokens

    def score(self, windows: list[str], *, batch_size: int = 8) -> list[WindowScore]: ...


CANDIDATES: tuple[str, ...] = (
    "gliguard-300m",
    "prompt-guard-2-86m",
    "prompt-guard-2-22m",
    "protectai-deberta-v2",
    "piguard",
)

HF_IDS: dict[str, str] = {
    "gliguard-300m": "fastino/gliguard-LLMGuardrails-300M",
    "prompt-guard-2-86m": "meta-llama/Llama-Prompt-Guard-2-86M",
    "prompt-guard-2-22m": "meta-llama/Llama-Prompt-Guard-2-22M",
    "protectai-deberta-v2": "protectai/deberta-v3-base-prompt-injection-v2",
    "piguard": "leolee99/PIGuard",
}

# Resolved 2026-10-06 with `huggingface_hub.model_info(<id>).sha`.
REVISIONS: dict[str, str] = {
    "gliguard-300m": "7776816b54581f37b90dd2de12dbe13123229a9b",
    "prompt-guard-2-86m": "a8ded8e697ce7c355e395a0df51f94adb4a2fd27",
    "prompt-guard-2-22m": "11614a155199674a0a95e6602d6ab0417b790ed0",
    "protectai-deberta-v2": "90c9989b1a342275dd0d1a95aad283c04e075671",
    "piguard": "dd78b24e330193a22d2293ac66922dd4f982f563",
}

SEGMENT_OVERLAP = 64


# ── tokenization ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TokenCodec:
    """Content-token encoding plus the single-sequence special-token template."""

    encode: Callable[[str], list[int]]
    prefix: tuple[int, ...]
    suffix: tuple[int, ...]
    pad_id: int

    @property
    def n_special(self) -> int:
        return len(self.prefix) + len(self.suffix)

    def build(self, content: Sequence[int]) -> list[int]:
        return [*self.prefix, *content, *self.suffix]


_TEMPLATE_PROBE = "probe"


def codec_from_tokenizer(tokenizer: Any, *, pad_id: int) -> TokenCodec:
    """Read the special-token template off a `tokenizers.Tokenizer`'s post-processor.

    The prefix/suffix are what the tokenizer's own `post_process` wraps around a
    content sequence, so a segment is built exactly like a whole short prompt.
    """
    content = tokenizer.encode(_TEMPLATE_PROBE, add_special_tokens=False).ids
    full = tokenizer.post_process(tokenizer.encode(_TEMPLATE_PROBE, add_special_tokens=False)).ids
    if not content:
        raise ValueError("template probe encoded to no tokens")
    for i in range(len(full) - len(content) + 1):
        if full[i : i + len(content)] == content:
            return TokenCodec(
                encode=lambda text: tokenizer.encode(text, add_special_tokens=False).ids,
                prefix=tuple(full[:i]),
                suffix=tuple(full[i + len(content) :]),
                pad_id=pad_id,
            )
    raise ValueError("post-processor template does not contain the content tokens")


# ── HF sequence classifiers ────────────────────────────────────────────────


@dataclass(frozen=True)
class SeqClsSpec:
    hf_id: str
    # What the pinned config.json yields as `model.config.id2label` (verified).
    config_id2label: Mapping[int, str]
    # Explicit renames for generic LABEL_n names (evidence in SEQ_CLS_SPECS).
    rename: Mapping[str, str]
    attack: frozenset[str]
    benign: frozenset[str]
    default_threshold: float
    trust_remote_code: bool = False


SEQ_CLS_SPECS: dict[str, SeqClsSpec] = {
    # config.json @a8ded8e (86M) / @11614a1 (22M) declares NO id2label, so
    # transformers yields LABEL_0/LABEL_1. README.md "Usage": the AutoModel example
    # prints `model.config.id2label[argmax]` -> "# MALICIOUS" for "Ignore your
    # previous instructions.", and "labeling prompts as 'benign' or 'malicious'".
    # Index 1 = MALICIOUS is confirmed empirically by the smoke test (attack -> P[1]
    # near 1, clinical line -> P[1] near 0). No threshold on the card -> argmax (0.5).
    "prompt-guard-2-86m": SeqClsSpec(
        hf_id=HF_IDS["prompt-guard-2-86m"],
        config_id2label={0: "LABEL_0", 1: "LABEL_1"},
        rename={"LABEL_0": "BENIGN", "LABEL_1": "MALICIOUS"},
        attack=frozenset({"MALICIOUS"}),
        benign=frozenset({"BENIGN"}),
        default_threshold=0.5,
    ),
    "prompt-guard-2-22m": SeqClsSpec(
        hf_id=HF_IDS["prompt-guard-2-22m"],
        config_id2label={0: "LABEL_0", 1: "LABEL_1"},
        rename={"LABEL_0": "BENIGN", "LABEL_1": "MALICIOUS"},
        attack=frozenset({"MALICIOUS"}),
        benign=frozenset({"BENIGN"}),
        default_threshold=0.5,
    ),
    # config.json @90c9989: id2label {"0": "SAFE", "1": "INJECTION"}; README: "benign
    # (`0`) and injection-detected (`1`)"; usage is a plain pipeline (argmax, 0.5).
    "protectai-deberta-v2": SeqClsSpec(
        hf_id=HF_IDS["protectai-deberta-v2"],
        config_id2label={0: "SAFE", 1: "INJECTION"},
        rename={},
        attack=frozenset({"INJECTION"}),
        benign=frozenset({"SAFE"}),
        default_threshold=0.5,
    ),
    # config.json @dd78b24: id2label {"0": "benign", "1": "injection"}, auto_map ->
    # modeling_piguard.PIGuard (remote code, reviewed: a DebertaV2ForSequenceClassification
    # subclass whose head is one Linear on the [CLS] state; no I/O). Usage is a plain
    # pipeline (argmax, 0.5).
    "piguard": SeqClsSpec(
        hf_id=HF_IDS["piguard"],
        config_id2label={0: "benign", 1: "injection"},
        rename={},
        attack=frozenset({"injection"}),
        benign=frozenset({"benign"}),
        default_threshold=0.5,
        trust_remote_code=True,
    ),
}


def resolve_id2label(config_id2label: Mapping[Any, str], spec: SeqClsSpec) -> dict[int, str]:
    """The label map used for scoring; raises if the config is not the verified one."""
    actual = {int(i): str(label) for i, label in config_id2label.items()}
    if actual != dict(spec.config_id2label):
        raise ValueError(
            f"{spec.hf_id}: config id2label {actual} != verified {dict(spec.config_id2label)}"
        )
    return {i: spec.rename.get(label, label) for i, label in actual.items()}


class SeqClsScorer:
    """Segment -> batch-pad -> softmax -> `attack_score`, window = max over segments."""

    def __init__(
        self,
        *,
        name: str,
        hf_id: str,
        revision: str,
        codec: TokenCodec,
        model: Any,
        id2label: Mapping[int, str],
        attack: frozenset[str],
        benign: frozenset[str],
        default_threshold: float,
        max_tokens: int,
        overlap: int = SEGMENT_OVERLAP,
    ) -> None:
        if max_tokens - codec.n_special <= overlap:
            raise ValueError("segment overlap must be smaller than the content budget")
        self.name = name
        self.hf_id = hf_id
        self.revision = revision
        self.codec = codec
        self.model = model
        self.id2label = dict(id2label)
        self.attack = attack
        self.benign = benign
        self.default_threshold = default_threshold
        self.max_tokens = max_tokens
        self.overlap = overlap

    def segment(self, window: str) -> list[list[int]]:
        """The model inputs (special tokens included) a window is scored as."""
        ids = self.codec.encode(window)
        spans = token_segments(
            len(ids), max_tokens=self.max_tokens - self.codec.n_special, overlap=self.overlap
        ) or [(0, 0)]
        return [self.codec.build(ids[start:end]) for start, end in spans]

    def score(self, windows: list[str], *, batch_size: int = 8) -> list[WindowScore]:
        plan: list[tuple[int, list[int]]] = []
        counts: list[int] = []
        for index, window in enumerate(windows):
            inputs = self.segment(window)
            counts.append(len(inputs))
            plan.extend((index, ids) for ids in inputs)

        best = [0.0] * len(windows)
        for offset in range(0, len(plan), batch_size):
            batch = plan[offset : offset + batch_size]
            width = max(len(ids) for _, ids in batch)
            input_ids = torch.full((len(batch), width), self.codec.pad_id, dtype=torch.long)
            attention_mask = torch.zeros((len(batch), width), dtype=torch.long)
            for row, (_, ids) in enumerate(batch):
                input_ids[row, : len(ids)] = torch.tensor(ids, dtype=torch.long)
                attention_mask[row, : len(ids)] = 1
            with torch.inference_mode():
                logits = self.model(input_ids=input_ids, attention_mask=attention_mask).logits
            probs = torch.softmax(logits.float(), dim=-1).tolist()
            for (index, _), row_probs in zip(batch, probs, strict=True):
                if len(row_probs) != len(self.id2label):
                    raise ValueError(f"{len(row_probs)} logits for {len(self.id2label)} labels")
                labelled = {self.id2label[j]: p for j, p in enumerate(row_probs)}
                segment_score = attack_score(labelled, attack=self.attack, benign=self.benign)
                best[index] = max(best[index], segment_score)
        return [
            WindowScore(score=score, n_segments=n) for score, n in zip(best, counts, strict=True)
        ]


# ── GLiGuard (gliner2) ─────────────────────────────────────────────────────

# packages/database/src/prisma/db_main/seed/ai-models/nlp.ts (gliguard row,
# `_metadata.labelTaxonomy.tasks.jailbreak_detection.labels`), verbatim and in order.
GLIGUARD_JAILBREAK_LABELS: tuple[str, ...] = (
    "prompt_injection",
    "jailbreak_attempt",
    "policy_evasion",
    "instruction_override",
    "system_prompt_exfiltration",
    "data_exfiltration",
    "roleplay_bypass",
    "hypothetical_bypass",
    "obfuscated_attack",
    "multi_step_attack",
    "social_engineering",
    "benign",
)
GLIGUARD_BENIGN_LABELS: frozenset[str] = frozenset({"benign", "safe", "compliance"})
GLIGUARD_ATTACK_LABELS: frozenset[str] = frozenset(GLIGUARD_JAILBREAK_LABELS) - (
    GLIGUARD_BENIGN_LABELS
)
GLIGUARD_THRESHOLD = 0.4  # labelTaxonomy.threshold and jailbreak_detection.cls_threshold
GLIGUARD_MAX_LEN = 2048  # nlp.inference.maxInputWords default (nlp/core/bounds.py)
GLIGUARD_TASK = "jailbreak_detection"


def gliguard_prod_flag(
    confidences: Mapping[str, float],
    *,
    cls_threshold: float = GLIGUARD_THRESHOLD,
    benign: frozenset[str] = GLIGUARD_BENIGN_LABELS,
) -> bool:
    """The production verdict for one window from its full label confidences.

    gliner2 (`inference/engine.py:_extract_classification_result`, multi-label)
    returns the labels with confidence >= cls_threshold and, when there are none,
    the single ARGMAX label instead. Guardrail (`screening.py`) flags a window when
    ANY returned label is not benign. So a window whose top label is a non-benign
    one is flagged at any confidence; only above the threshold does the flag equal
    "max non-benign confidence >= cls_threshold".
    """
    chosen = [label for label, conf in confidences.items() if conf >= cls_threshold]
    if not chosen:
        chosen = [max(confidences, key=lambda label: confidences[label])]
    return any(label.lower() not in benign for label in chosen)


class GliguardScorer:
    name = "gliguard-300m"
    hf_id = HF_IDS["gliguard-300m"]
    default_threshold = GLIGUARD_THRESHOLD
    # gliner2 does not segment: `max_len` truncates at this many WORDS, and a
    # 2,000-char window is far below it. Not a subword limit.
    max_tokens = GLIGUARD_MAX_LEN

    def __init__(self, *, runtime: Any, revision: str, max_len: int = GLIGUARD_MAX_LEN) -> None:
        self.runtime = runtime
        self.revision = revision
        self.max_len = max_len

    def label_confidences(
        self, windows: list[str], *, batch_size: int = 8, cls_threshold: float = 0.0
    ) -> list[dict[str, float]]:
        """Every returned label's confidence per window (all 12 at `cls_threshold=0`)."""
        tasks = {
            GLIGUARD_TASK: {
                "labels": list(GLIGUARD_JAILBREAK_LABELS),
                "multi_label": True,
                "cls_threshold": cls_threshold,
            }
        }
        with torch.inference_mode():
            results = self.runtime.batch_classify_text(
                list(windows),
                tasks,
                batch_size=batch_size,
                threshold=GLIGUARD_THRESHOLD,
                include_confidence=True,
                max_len=self.max_len,
            )
        if len(results) != len(windows):
            raise RuntimeError(f"gliner2 returned {len(results)} results for {len(windows)}")
        return [
            {str(item["label"]): float(item["confidence"]) for item in result[GLIGUARD_TASK]}
            for result in results
        ]

    def score(self, windows: list[str], *, batch_size: int = 8) -> list[WindowScore]:
        return [
            WindowScore(
                score=attack_score(
                    confidences, attack=GLIGUARD_ATTACK_LABELS, benign=GLIGUARD_BENIGN_LABELS
                ),
                n_segments=1,
            )
            for confidences in self.label_confidences(windows, batch_size=batch_size)
        ]


# ── loading ────────────────────────────────────────────────────────────────


def _load_seq_cls(name: str) -> SeqClsScorer:
    from huggingface_hub import hf_hub_download
    from tokenizers import Tokenizer
    from transformers import AutoModelForSequenceClassification

    spec = SEQ_CLS_SPECS[name]
    revision = REVISIONS[name]
    model = AutoModelForSequenceClassification.from_pretrained(
        spec.hf_id,
        revision=revision,
        trust_remote_code=spec.trust_remote_code,
        dtype=torch.float32,
    )
    model.to("cpu").eval()
    tokenizer = Tokenizer.from_file(
        hf_hub_download(spec.hf_id, "tokenizer.json", revision=revision)
    )
    tokenizer.no_padding()
    tokenizer.no_truncation()
    return SeqClsScorer(
        name=name,
        hf_id=spec.hf_id,
        revision=revision,
        codec=codec_from_tokenizer(tokenizer, pad_id=int(model.config.pad_token_id)),
        model=model,
        id2label=resolve_id2label(model.config.id2label, spec),
        attack=spec.attack,
        benign=spec.benign,
        default_threshold=spec.default_threshold,
        max_tokens=int(model.config.max_position_embeddings),
    )


def _load_gliguard() -> GliguardScorer:
    from gliner2 import GLiNER2
    from huggingface_hub import snapshot_download

    revision = REVISIONS["gliguard-300m"]
    # `GLiNER2.from_pretrained` takes no revision, so the pinned snapshot is passed
    # as a local directory — which is also how production hands it a model path.
    path = snapshot_download(HF_IDS["gliguard-300m"], revision=revision)
    runtime = GLiNER2.from_pretrained(path, map_location="cpu")
    runtime.to("cpu").eval()
    return GliguardScorer(runtime=runtime, revision=revision)


def load_scorer(name: str, *, threads: int = 4) -> Scorer:
    """Load one candidate on CPU with `threads` intra-op threads."""
    if name not in REVISIONS:
        raise KeyError(name)
    torch.set_num_threads(threads)
    if name == "gliguard-300m":
        return _load_gliguard()
    return _load_seq_cls(name)
