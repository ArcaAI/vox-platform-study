"""Generative guard judge runtime, protocol ``qwen3guard_native`` (TASK-1050 §12).

Qwen3Guard-Gen is a generative guard fine-tuned to ITS OWN chat template: the
moderation policy and the category list live inside that template, it takes
the plain user turn (prompt moderation) or the user + assistant turns (response
moderation), and it answers in a fixed text grammar::

    Safety: Safe | Controversial | Unsafe
    Categories: <comma-separated native categories> | None
    Refusal: Yes | No            (response moderation only)

Track S resolved OD-40 to ``servedBy: nlp`` (no official GGUF), so this service
runs it on transformers, CPU, from the pinned official safetensors. Guardrail
calls it through ``POST /guard/judge``.

What this module does NOT hold, by rule (00 §Configuration Principles):

* no model id — the caller resolves the row and sends its reference;
* no chat template — the REPO's own (``tokenizer_config.json#chat_template``,
  else ``chat_template.jinja``), handed to the tokenizer explicitly. The
  tokenizer is ``PreTrainedTokenizerFast(tokenizer_file=…)`` over the repo's
  ``tokenizer.json``, never ``AutoTokenizer`` (transformers 5 rebuilds some
  tokenizers and silently changes their normaliser — TASK-1049 §8.2);
* no decoding parameters — ``max_new_tokens`` (the row's ``judgeMaxTokens``) and
  ``temperature`` (the row's ``judgeTemperature``) arrive per request;
* no category → lane mapping — that is guardrail-side config
  (``AiModel._metadata.judge.categoryMap``). The native fields go back RAW.

Fail posture: a missing tokenizer file or chat template, or a generation
failure, RAISES (the route answers 503). An answer the parser cannot read
unambiguously is an explicit ``undetermined`` verdict with a reason — never a
guessed tier.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from nlp.core.logging import get_logger

logger = get_logger(__name__)

#: The judge protocol this runtime implements (`AiModel._metadata.judge.protocol`).
QWEN3GUARD_NATIVE = "qwen3guard_native"

JudgeMode = Literal["prompt", "response"]

#: The tier reported when the generation cannot be read unambiguously.
UNDETERMINED = "undetermined"

#: The grammar's tier and refusal vocabulary. These are the PARSER — the fixed
#: output language the model was trained to emit — not configuration: what a
#: tier MEANS (pass / warn / block) is the row's `judge.tiers`, in guardrail.
_TIERS = {"safe": "Safe", "controversial": "Controversial", "unsafe": "Unsafe"}
_REFUSALS = {"yes": True, "no": False}
_NO_CATEGORIES = "none"

_LINE = re.compile(r"^(Safety|Categories|Refusal):(.*)$", re.IGNORECASE)

TOKENIZER_FILENAME = "tokenizer.json"
TOKENIZER_CONFIG_FILENAME = "tokenizer_config.json"
CHAT_TEMPLATE_FILENAME = "chat_template.jinja"


@dataclass(frozen=True)
class JudgeVerdict:
    """The native fields, raw. ``reason`` is set exactly when the tier is undetermined."""

    tier: str
    categories: list[str] = field(default_factory=list)
    refusal: bool | None = None
    reason: str | None = None
    latency_ms: int = 0


def _undetermined(reason: str) -> JudgeVerdict:
    return JudgeVerdict(tier=UNDETERMINED, reason=reason)


def parse_qwen3guard_output(output: str, *, mode: JudgeMode) -> JudgeVerdict:
    """Parse one generation. Strict: every non-blank line must be a grammar line."""
    fields: dict[str, str] = {}
    for raw_line in (output or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = _LINE.match(line)
        if match is None:
            return _undetermined("unexpected_line")
        key = match.group(1).lower()
        if key == "refusal" and mode == "prompt":
            return _undetermined("unexpected_line")
        if key in fields:
            return _undetermined("duplicate_line")
        fields[key] = match.group(2).strip()

    if not fields:
        return _undetermined("empty_output")
    if "safety" not in fields:
        return _undetermined("missing_safety")
    tier = _TIERS.get(fields["safety"].lower())
    if tier is None:
        return _undetermined("unknown_tier")
    categories_line = fields.get("categories", "")
    if not categories_line:
        return _undetermined("missing_categories")
    categories = (
        []
        if categories_line.lower() == _NO_CATEGORIES
        else [part.strip() for part in categories_line.split(",") if part.strip()]
    )
    refusal: bool | None = None
    if mode == "response":
        if "refusal" not in fields:
            return _undetermined("missing_refusal")
        refusal = _REFUSALS.get(fields["refusal"].lower())
        if refusal is None:
            return _undetermined("unknown_refusal")
    return JudgeVerdict(tier=tier, categories=categories, refusal=refusal)


def judge_messages(mode: JudgeMode, prompt: str, response: str | None) -> list[dict[str, str]]:
    """The turns the template is applied to: user only, or user + assistant."""
    if mode == "prompt":
        return [{"role": "user", "content": prompt}]
    if response is None:
        raise ValueError("response moderation needs the assistant response")
    return [{"role": "user", "content": prompt}, {"role": "assistant", "content": response}]


def _hub_file(repo_id: str, filename: str) -> str | None:
    """One repo file through the hub cache, or ``None`` when the repo has no such file."""
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import EntryNotFoundError

    try:
        return str(hf_hub_download(repo_id=repo_id, filename=filename))
    except EntryNotFoundError:
        return None


def _repo_file(weights_source: str, filename: str) -> str | None:
    local = Path(weights_source)
    if local.is_dir():
        candidate = local / filename
        return str(candidate) if candidate.is_file() else None
    return _hub_file(weights_source, filename)


def load_repo_chat_template(weights_source: str) -> str:
    """The chat template the repo ships; raises when it ships none."""
    config_path = _repo_file(weights_source, TOKENIZER_CONFIG_FILENAME)
    if config_path is not None:
        config = json.loads(Path(config_path).read_text(encoding="utf-8"))
        template = config.get("chat_template") if isinstance(config, dict) else None
        if isinstance(template, str) and template.strip():
            return template
    jinja_path = _repo_file(weights_source, CHAT_TEMPLATE_FILENAME)
    if jinja_path is not None:
        template = Path(jinja_path).read_text(encoding="utf-8")
        if template.strip():
            return template
    raise RuntimeError(
        f"{weights_source!r} ships no chat template ({TOKENIZER_CONFIG_FILENAME}#chat_template "
        f"or {CHAT_TEMPLATE_FILENAME}); the {QWEN3GUARD_NATIVE} protocol is only served with "
        "the model's own template."
    )


class Qwen3GuardJudgeService:
    """A loaded generative guard. Weightless until :meth:`load` (blocking)."""

    def __init__(self, weights_source: str, model_id: str, device: str = "cpu") -> None:
        self.model_id = model_id
        self._weights_source = weights_source
        self._device = device
        self._tokenizer: Any = None
        self._model: Any = None
        self._chat_template: str | None = None
        # One generation at a time per loaded model: torch already parallelises
        # inside a pass, so stacking decodes buys contention, not throughput
        # (the same reasoning as guard_dispatch's per-slot in-flight bound).
        self._lock = asyncio.Lock()

    @property
    def device(self) -> str:
        """The metering label (``cuda`` / ``mps`` / ``cpu``) — every response carries it."""
        from nlp.core.device import device_label

        return device_label(self._device)

    @property
    def placement(self) -> str:
        """The device id the weights were placed on (``cuda:1``) — TASK-1055."""
        return self._device

    def load(self) -> None:
        import torch
        from transformers import AutoModelForCausalLM, PreTrainedTokenizerFast

        from nlp.core.device import apply_device_placement

        logger.info(f"nlp.qwen3guard_judge.loading model_id={self.model_id} device={self._device}")
        tokenizer_file = _repo_file(self._weights_source, TOKENIZER_FILENAME)
        if tokenizer_file is None:
            raise RuntimeError(f"{self._weights_source!r} ships no {TOKENIZER_FILENAME}")
        chat_template = load_repo_chat_template(self._weights_source)
        tokenizer = PreTrainedTokenizerFast(tokenizer_file=tokenizer_file)
        model = AutoModelForCausalLM.from_pretrained(
            self._weights_source, trust_remote_code=False, dtype=torch.float32
        )
        model.eval()
        apply_device_placement(model, self._device)
        self._tokenizer = tokenizer
        self._model = model
        self._chat_template = chat_template
        logger.info(f"nlp.qwen3guard_judge.ready model_id={self.model_id} device={self._device}")

    def torch_modules(self) -> list[Any]:
        """The torch modules this instance holds (residency sizing, TASK-1055)."""
        return [self._model] if self._model is not None else []

    def shutdown(self) -> None:
        self._model = None
        self._tokenizer = None

    def _sync_generate(
        self, messages: list[dict[str, str]], max_new_tokens: int, temperature: float
    ) -> str:
        import torch

        if self._model is None or self._tokenizer is None:
            raise RuntimeError(f"judge {self.model_id!r} is not loaded")
        # The model card applies the template as-is (its policy and the
        # assistant opening live inside it), so no add_generation_prompt here.
        text = self._tokenizer.apply_chat_template(
            messages, chat_template=self._chat_template, tokenize=False
        )
        inputs = self._tokenizer(text, return_tensors="pt", add_special_tokens=False)
        input_ids = inputs["input_ids"].to(self._device)
        attention_mask = inputs["attention_mask"].to(self._device)
        decode: dict[str, Any] = {"max_new_tokens": int(max_new_tokens)}
        if temperature > 0:
            decode.update(do_sample=True, temperature=float(temperature))
        else:
            decode["do_sample"] = False
        with torch.inference_mode():
            output = self._model.generate(
                input_ids=input_ids, attention_mask=attention_mask, **decode
            )
        new_tokens = output[0][input_ids.shape[-1] :]
        return str(self._tokenizer.decode(new_tokens, skip_special_tokens=True))

    async def judge(
        self,
        *,
        mode: JudgeMode,
        prompt: str,
        response: str | None,
        max_new_tokens: int,
        temperature: float,
    ) -> JudgeVerdict:
        """Moderate one prompt (or prompt + response); the verdict carries its latency."""
        messages = judge_messages(mode, prompt, response)
        async with self._lock:
            started = time.perf_counter()
            output = await asyncio.to_thread(
                self._sync_generate, messages, max_new_tokens, temperature
            )
            latency_ms = round((time.perf_counter() - started) * 1000)
        verdict = parse_qwen3guard_output(output, mode=mode)
        if verdict.reason is not None:
            # PHI-safe: the reason code only, never the generation or the input.
            logger.warning(
                f"nlp.qwen3guard_judge.undetermined model_id={self.model_id} reason={verdict.reason}"
            )
        return JudgeVerdict(
            tier=verdict.tier,
            categories=verdict.categories,
            refusal=verdict.refusal,
            reason=verdict.reason,
            latency_ms=latency_ms,
        )
