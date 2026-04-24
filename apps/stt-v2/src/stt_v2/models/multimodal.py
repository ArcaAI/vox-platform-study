"""Shared constants and helpers for multimodal LLM inference."""

from typing import Any

import torch

# Audio chunking
MAX_AUDIO_S = 28
TOKENS_PER_S = 25
CONTEXT_WORDS = 20
MAX_NEW_TOKENS_CAP = 2048


def compute_max_new_tokens(duration_s: float, *, minimum: int = 64) -> int:
    """Compute max_new_tokens from audio duration, capped at MAX_NEW_TOKENS_CAP."""
    return min(max(int(duration_s * TOKENS_PER_S) + 10, minimum), MAX_NEW_TOKENS_CAP)


def prepare_chat_inputs(
    processor: Any,
    messages: list[dict],
    device: Any,
    dtype: Any | None = None,
) -> dict:
    """Apply chat template and move tensors to device.

    Args:
        processor: HuggingFace processor with apply_chat_template.
        messages: Chat messages list.
        device: Target device.
        dtype: Optional dtype cast (used in batch path).

    Returns:
        Dict of input tensors on the target device. Non-tensor fields
        (e.g. processor metadata lists) pass through unchanged so they
        can still be consumed by downstream ``generate``/``decode`` calls.
    """
    inputs = processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
    )
    moved: dict[str, Any] = {}
    for k, v in inputs.items():
        if not isinstance(v, torch.Tensor):
            moved[k] = v
            continue
        if dtype is not None and v.is_floating_point():
            moved[k] = v.to(device, dtype=dtype)
        else:
            moved[k] = v.to(device)
    return moved
