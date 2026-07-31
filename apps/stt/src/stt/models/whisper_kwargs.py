"""Shared Whisper/transformers ``generate_kwargs`` assembly.

One builder for the decode parameters that were previously triplicated across
batch transformers inference, batch Optimum-ONNX inference, and the streaming
ASR callable — three hand-kept copies that drifted independently. Pure
config→dict translation; import-cheap (no torch).

Call-site-specific concerns stay at the call site: ``prompt_ids`` injection,
the translate-task language override, code-switching log lines, None-filtering.
"""

from __future__ import annotations

from typing import Any

from stt.pipeline.dto import primary_language_subtag


def build_whisper_generate_kwargs(
    config: Any,
    *,
    task: str = "transcribe",
    return_timestamps: bool = True,
    language: str | None = None,
) -> dict[str, Any]:
    """Translate an ``InferenceConfig`` into transformers ``generate`` kwargs.

    Semantics (locked by ``tests/unit/test_batch_inference_kwargs.py``):
    - ``language`` is pinned only when not None (a configured
      language is always pinned, including with code_switching; null = auto-LID).
      A paired / BCP-47 value collapses to its primary subtag first
      (``"ml-en"`` / ``"ml-IN"`` → ``"ml"``): transformers pins one language.
    - ``beam_size`` > 1 → ``num_beams`` (1/0/None omitted).
    - ``temperature``: scalar normalized to a 1-list; single value emits a
      scalar plus ``do_sample`` (> 0.0); a schedule emits a tuple (no
      ``do_sample``). Bools are not temperatures.
    - Float thresholds pass through when numeric; ``condition_on_prev_tokens``
      is emitted only when truthy.
    """
    generate_kwargs: dict[str, Any] = {
        "task": task,
        "return_timestamps": return_timestamps,
    }

    language = primary_language_subtag(language)
    if language is not None:
        generate_kwargs["language"] = language

    no_repeat_ngram_size = getattr(config, "no_repeat_ngram_size", None)
    if isinstance(no_repeat_ngram_size, int) and no_repeat_ngram_size > 0:
        generate_kwargs["no_repeat_ngram_size"] = no_repeat_ngram_size

    beam_size = getattr(config, "beam_size", None)
    if isinstance(beam_size, int) and beam_size > 1:
        generate_kwargs["num_beams"] = beam_size

    temperature = getattr(config, "temperature", None)
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
        temperature = [float(temperature)]
    if isinstance(temperature, (list, tuple)) and len(temperature) > 0:
        temp_list = [float(x) for x in temperature]
        if len(temp_list) == 1:
            generate_kwargs["temperature"] = temp_list[0]
            generate_kwargs["do_sample"] = temp_list[0] > 0.0
        else:
            generate_kwargs["temperature"] = tuple(temp_list)

    compression_ratio_threshold = getattr(config, "compression_ratio_threshold", None)
    if isinstance(compression_ratio_threshold, (int, float)):
        generate_kwargs["compression_ratio_threshold"] = float(compression_ratio_threshold)

    logprob_threshold = getattr(config, "logprob_threshold", None)
    if isinstance(logprob_threshold, (int, float)):
        generate_kwargs["logprob_threshold"] = float(logprob_threshold)

    no_speech_threshold = getattr(config, "no_speech_threshold", None)
    if isinstance(no_speech_threshold, (int, float)):
        generate_kwargs["no_speech_threshold"] = float(no_speech_threshold)

    raw_condition = getattr(config, "condition_on_prev_tokens", False)
    if isinstance(raw_condition, (bool, int)) and bool(raw_condition):
        generate_kwargs["condition_on_prev_tokens"] = True

    return generate_kwargs
