"""Shared constants and helpers for multimodal LLM inference."""

from typing import Any

# Audio chunking
MAX_AUDIO_S = 28
TOKENS_PER_S = 25
CONTEXT_WORDS = 20
MAX_NEW_TOKENS_CAP = 2048

# Default prompt shared between batch and streaming paths
DEFAULT_MULTIMODAL_PROMPT = (
    "Transcribe the following speech segment in its original language. "
    "Only output the transcription, with no newlines. "
    "When transcribing numbers, write the digits."
)


def compute_max_new_tokens(duration_s: float, *, minimum: int = 64) -> int:
    """Compute max_new_tokens from audio duration, capped at MAX_NEW_TOKENS_CAP."""
    return min(max(int(duration_s * TOKENS_PER_S) + 10, minimum), MAX_NEW_TOKENS_CAP)


def build_system_prompt(
    prompt: str | None,
    language: str | None,
) -> str:
    """Build the system prompt with optional language prefix."""
    base = prompt or DEFAULT_MULTIMODAL_PROMPT
    if language:
        base = f"Transcribe in {language}. {base}"
    return base


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
        Dict of input tensors on the target device.
    """
    inputs = processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
    )
    if dtype is not None:
        inputs = {
            k: v.to(device, dtype=dtype) if v.is_floating_point() else v.to(device)
            for k, v in inputs.items()
        }
    else:
        inputs = {k: v.to(device) for k, v in inputs.items()}
    return inputs
