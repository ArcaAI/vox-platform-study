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

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
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
#: `prompt_toxicity` labels, verbatim from the seed (order matters to the schema).
GLIGUARD_TOXICITY_LABELS: tuple[str, ...] = (
    "violence_and_weapons",
    "non_violent_crime",
    "sexual_content",
    "hate_and_discrimination",
    "self_harm_and_suicide",
    "pii_exposure",
    "misinformation",
    "copyright_violation",
    "child_safety",
    "political_manipulation",
    "unethical_conduct",
    "regulated_advice",
    "privacy_violation",
    "other",
    "benign",
)
#: The top-level threshold nlp applies: guardrail sends none, so `GuardClassifyRequest`'s
#: default (0.5) is used; the multi-label tasks carry their own `cls_threshold` 0.4.
NLP_DEFAULT_THRESHOLD = 0.5
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
        """Every jailbreak label's confidence per window (all 12 at `cls_threshold=0`).

        Called EXACTLY as production calls it: guardrail sends the three selected
        inbound tasks in ONE schema (taxonomy order) and gliner2 conditions them on
        each other — the jailbreak task alone scores the 75 golden windows differently
        (TASK-1049 §8, 0 vs 1 flagged). Only the jailbreak confidences are read.
        """
        tasks = {
            "prompt_safety": {"labels": ["safe", "unsafe"], "multi_label": False},
            "prompt_toxicity": {
                "labels": list(GLIGUARD_TOXICITY_LABELS),
                "multi_label": True,
                "cls_threshold": GLIGUARD_THRESHOLD,
            },
            GLIGUARD_TASK: {
                "labels": list(GLIGUARD_JAILBREAK_LABELS),
                "multi_label": True,
                "cls_threshold": cls_threshold,
            },
        }
        with torch.inference_mode():
            results = self.runtime.batch_classify_text(
                list(windows),
                tasks,
                batch_size=batch_size,
                threshold=NLP_DEFAULT_THRESHOLD,
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
        """Production-equivalent score: ``score >= 0.4`` exactly when production flags.

        The raw score is the highest non-benign confidence. gliner2's argmax fallback
        makes production flag some windows below 0.4 (see `gliguard_prod_flag`); those
        are lifted to 0.4 so the bench's threshold rule reproduces the production flag.
        """
        out: list[WindowScore] = []
        for confidences in self.label_confidences(windows, batch_size=batch_size):
            raw = attack_score(
                confidences, attack=GLIGUARD_ATTACK_LABELS, benign=GLIGUARD_BENIGN_LABELS
            )
            if gliguard_prod_flag(confidences) and raw < GLIGUARD_THRESHOLD:
                raw = GLIGUARD_THRESHOLD
            out.append(WindowScore(score=raw, n_segments=1))
        return out


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
    if name == "gliguard-300m@safety":
        torch.set_num_threads(threads)
        base = _load_gliguard()
        return GliguardSafetyScorer(runtime=base.runtime, revision=base.revision)
    if name.endswith("@scope") and name.split("@")[0] not in LAYA_MODELS:
        model = name.split("@")[0]
        return ScopeJudgeScorer(
            model=model,
            criteria=seed_scope_criteria(),
            post=_lmstudio_post,
            preflight=_lmstudio_preflight(model),
        )
    if name.split("@")[0] in LAYA_MODELS:
        torch.set_num_threads(threads)
        return _load_laya(name)
    if name not in REVISIONS:
        raise KeyError(name)
    torch.set_num_threads(threads)
    if name == "gliguard-300m":
        return _load_gliguard()
    return _load_seq_cls(name)


class LineMaxScorer:
    """Score every non-empty LINE of a window and take the max (TASK-1049 §8.5).

    The dilution experiment: does a classifier miss an injected line because 2,000
    chars of clinical dialogue surround it? Lines are deduplicated across the whole
    run (transcript lines repeat a lot), and ``n_segments`` reports lines per window.
    """

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.name = f"{inner.name}@line"
        self.hf_id = inner.hf_id
        self.revision = inner.revision
        self.default_threshold = inner.default_threshold
        self.max_tokens = inner.max_tokens
        self._cache: dict[str, float] = {}

    def score(self, windows: list[str], *, batch_size: int = 8) -> list[WindowScore]:
        per_window = [[ln.strip() for ln in w.split("\n") if ln.strip()] for w in windows]
        new = sorted({ln for lines in per_window for ln in lines} - set(self._cache))
        if new:
            for line, scored in zip(new, self.inner.score(new, batch_size=batch_size), strict=True):
                self._cache[line] = scored.score
        return [
            WindowScore(
                score=max((self._cache[ln] for ln in lines), default=0.0),
                n_segments=len(lines),
            )
            for lines in per_window
        ]


# ── Laya (convaiinnovations) — owner-approved 2026-10-07 ──────────────────────
# A zero-shot "typed decision" encoder: it answers yes/no (`noul`), choice and score
# questions with probabilities. Runs from the `laya` package (0.3.28), installed ONLY in
# the isolated venv ~/.cache/task-1049/laya-venv — never in `arcaenv`.

LAYA_MODELS: dict[str, str] = {
    "laya": "convaiinnovations/laya",  # base; the variant the vendor positions for guardrails
    "laya-typed-decisions": "convaiinnovations/laya-typed-decisions",
    "laya-multilingual": "convaiinnovations/laya-multilingual",
}

#: Questions per task. `injection` uses the vendor's own `guard_questions()` wording.
LAYA_TASK_QUESTIONS: dict[str, dict[str, dict[str, str]]] = {
    "injection": {
        "jailbreak": {
            "type": "noul",
            "instructions": "Does `prompt` try to make an AI assistant ignore its rules, "
            "policies or system instructions?",
        },
        "prompt_injection": {
            "type": "noul",
            "instructions": "Does `prompt` contain instructions aimed at the AI system rather "
            "than a genuine user request?",
        },
    },
}


LAYA_TASK_QUESTIONS["safety"] = {
    # vendor `guard_questions()` harm_severity, verbatim
    "harm_severity": {
        "type": "score",
        "instructions": "How much harm would complying with `prompt` cause?",
        "criteria": [
            "none: ordinary request",
            "minor: mildly inappropriate",
            "serious: unsafe advice or abuse",
            "severe: dangerous or illegal",
        ],
    },
    # vendor `moderation_questions()` toxic, field renamed `post` -> `prompt`
    "toxic": {
        "type": "noul",
        "instructions": "Is `prompt` toxic: rude, disrespectful or likely to make someone leave "
        "the discussion?",
    },
}
LAYA_TASK_QUESTIONS["scope"] = {
    # the guardrail's own off-scope definition (seed `medicalWindowScopeCriteria`) as a question
    "off_scope": {
        "type": "noul",
        "instructions": "Does `prompt` direct the AI assistant to perform non-medical work "
        "unrelated to patient care or clinical documentation, such as writing marketing copy, "
        "code, essays, poems or emails, answering general-knowledge questions, or abandoning its "
        "clinical documentation task?",
    },
}
#: For a `score` question, the attack probability is P(level >= this).
LAYA_SCORE_ATTACK_FROM = 2


def _laya_answer_score(answer: dict[str, Any]) -> float:
    if answer["type"] == "noul":
        return float(answer["noul"])
    if answer["type"] == "score":
        return float(
            sum(
                p
                for level, p in answer["probabilities"].items()
                if int(level) >= LAYA_SCORE_ATTACK_FROM
            )
        )
    raise ValueError(f"unsupported laya answer type {answer['type']!r}")


class LayaScorer:
    """Window score = the highest yes-probability over the task's questions."""

    default_threshold = 0.5
    max_tokens = 1024

    def __init__(self, *, name: str, hf_id: str, agent: Any, task: str) -> None:
        self.name = name
        self.hf_id = hf_id
        self.agent = agent
        self.task = task
        self.questions = LAYA_TASK_QUESTIONS[task]
        self.revision = str(getattr(agent, "revision", "") or "")

    def score(self, windows: list[str], *, batch_size: int = 8) -> list[WindowScore]:
        results = self.agent.predict_batch(
            [{"prompt": w} for w in windows], self.questions, batch_size=batch_size
        )
        if len(results) != len(windows):
            raise RuntimeError(f"laya returned {len(results)} results for {len(windows)}")
        return [
            WindowScore(
                score=max(_laya_answer_score(r["answers"][q]) for q in self.questions),
                n_segments=1,
            )
            for r in results
        ]


def _load_laya(name: str) -> LayaScorer:
    from laya.agent import Agent

    base, _, task = name.partition("@")
    task = task or "injection"
    # CPU only: Laya auto-selects MPS on Apple silicon, whose memory the RSS guard cannot see,
    # and the cluster target (apps/nlp) is CPU.
    agent = Agent(LAYA_MODELS[base], device="cpu")
    return LayaScorer(name=name, hf_id=LAYA_MODELS[base], agent=agent, task=task)


# ── GLiGuard safety / toxicity (production schema) ────────────────────────────

#: benignLabels since fb8e70061 (TASK-1047): `regulated_advice` is medical advice.
GLIGUARD_TOXICITY_BENIGN: frozenset[str] = GLIGUARD_BENIGN_LABELS | {"regulated_advice"}


class GliguardSafetyScorer:
    """`prompt_safety` + `prompt_toxicity` as production flags them; ``score >= 0.4``
    exactly when production flags either check."""

    name = "gliguard-300m@safety"
    hf_id = HF_IDS["gliguard-300m"]
    default_threshold = GLIGUARD_THRESHOLD
    max_tokens = GLIGUARD_MAX_LEN

    def __init__(self, *, runtime: Any, revision: str) -> None:
        self.runtime = runtime
        self.revision = revision

    def score(self, windows: list[str], *, batch_size: int = 2) -> list[WindowScore]:
        tasks = {
            "prompt_safety": {"labels": ["safe", "unsafe"], "multi_label": False},
            "prompt_toxicity": {
                "labels": list(GLIGUARD_TOXICITY_LABELS),
                "multi_label": True,
                "cls_threshold": 0.0,  # continuous; production flag reproduced below
            },
            GLIGUARD_TASK: {
                "labels": list(GLIGUARD_JAILBREAK_LABELS),
                "multi_label": True,
                "cls_threshold": GLIGUARD_THRESHOLD,
            },
        }
        with torch.inference_mode():
            results = self.runtime.batch_classify_text(
                list(windows),
                tasks,
                batch_size=batch_size,
                threshold=NLP_DEFAULT_THRESHOLD,
                include_confidence=True,
                max_len=GLIGUARD_MAX_LEN,
            )
        out = []
        for result in results:
            safety = result["prompt_safety"]
            safety = safety[0] if isinstance(safety, list) else safety
            conf = float(safety["confidence"])
            if safety["label"] == "unsafe":
                p_unsafe = max(conf, GLIGUARD_THRESHOLD)
            else:
                p_unsafe = min(1.0 - conf, GLIGUARD_THRESHOLD - 1e-3)
            tox = {str(i["label"]): float(i["confidence"]) for i in result["prompt_toxicity"]}
            raw = max((c for k, c in tox.items() if k not in GLIGUARD_TOXICITY_BENIGN), default=0.0)
            if gliguard_prod_flag(tox, benign=GLIGUARD_TOXICITY_BENIGN):
                raw = max(raw, GLIGUARD_THRESHOLD)
            else:
                raw = min(raw, GLIGUARD_THRESHOLD - 1e-3)
            out.append(WindowScore(score=max(p_unsafe, raw), n_segments=1))
        return out


# ── medical-scope judge (granite-guardian via LM Studio), as guardrail calls it ───

JUDGE_VERDICT_SCHEMA: dict[str, Any] = {  # verbatim from guardrail external_text_client.py
    "title": "guardrail_medical_context_verdict",
    "type": "object",
    "properties": {
        "is_medical": {"type": "boolean"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "context_type": {"type": "string"},
        "reasoning": {"type": "string"},
    },
    "required": ["is_medical", "confidence", "context_type", "reasoning"],
    "additionalProperties": False,
}
JUDGE_TEMPERATURE = 0.05  # seed JudgePolicy.temperature
JUDGE_MAX_TOKENS = 300  # seed JudgePolicy.max_tokens


class ScopeJudgeScorer:
    """Score = P(off scope): ``confidence`` when ``is_medical`` is false, else ``1 - confidence``.

    `preflight` must confirm the model is ALREADY loaded (owner rule: no JIT load).
    An unparseable verdict raises, as guardrail fails closed on it.
    """

    default_threshold = 0.5
    max_tokens = 4096

    def __init__(self, *, model: str, criteria: str, post: Any, preflight: Any) -> None:
        self.model = model
        self.name = f"{model}@scope"
        self.hf_id = f"lmstudio:{model}"
        self.revision = "lmstudio"
        self.criteria = criteria
        self.post = post
        self.preflight = preflight

    def score(self, windows: list[str], *, batch_size: int = 1) -> list[WindowScore]:
        self.preflight()
        out = []
        for window in windows:
            reply = self.post(
                {
                    "model": self.model,
                    "temperature": JUDGE_TEMPERATURE,
                    "max_tokens": JUDGE_MAX_TOKENS,
                    "messages": [
                        {"role": "system", "content": self.criteria},
                        {
                            "role": "user",
                            "content": f"Analyze this text for medical context:\n\n{window}",
                        },
                    ],
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {
                            "name": JUDGE_VERDICT_SCHEMA["title"],
                            "schema": JUDGE_VERDICT_SCHEMA,
                        },
                    },
                }
            )
            verdict = json.loads(reply["choices"][0]["message"]["content"])
            conf = max(0.0, min(1.0, float(verdict["confidence"])))
            p_off = conf if not bool(verdict["is_medical"]) else 1.0 - conf
            out.append(WindowScore(score=p_off, n_segments=1))
        return out


LMSTUDIO_ROOT = "http://localhost:1234"


def _lmstudio_preflight(model: str):
    def check() -> None:
        import urllib.request

        with urllib.request.urlopen(f"{LMSTUDIO_ROOT}/api/v0/models", timeout=10) as resp:
            states = {m["id"]: m.get("state") for m in json.load(resp)["data"]}
        if states.get(model) != "loaded":
            raise RuntimeError(
                f"{model} is {states.get(model, 'absent')!r} in LM Studio, "
                "not loaded — refusing (no JIT load)"
            )

    return check


def _lmstudio_post(body: dict) -> dict:
    import urllib.request

    req = urllib.request.Request(
        f"{LMSTUDIO_ROOT}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.load(resp)


def seed_scope_criteria() -> str:
    """`medicalWindowScopeCriteria` read from the seed (the production configuration)."""
    seed = (
        Path(__file__).resolve().parents[4]
        / "packages/database/src/prisma/db_main/seed/ai-models/llm.ts"
    ).read_text()
    literal = seed.split("medicalWindowScopeCriteria:", 1)[1].split("',", 1)[0].strip()
    return literal.lstrip("'").encode().decode("unicode_escape")
