"""ASR engine capability declarations (TASK-505 Phase 1).

Spec-only module (import-cheap — no torch/onnx imports): the single source of
truth for which (device, compute, mode) each ASR engine supports, verified
against the loaders/adapters in the TASK-505 engine inventory. The
``lazy_target``s point at the delegation adapters in ``asr_engines.py`` —
the registry IS the dispatch surface for both the batch and streaming paths.

Names are ``AiModelFormat`` values lowercased, so YAML engine strings and
registry keys stay one vocabulary.
"""

from __future__ import annotations

from .base import Capability
from .registry import register_processor

_HF_COMPUTE = ("float16", "float32", "bfloat16", "int8", "auto")
# CTranslate2 compute types (mirrors VALID_CT2_COMPUTE_TYPES in pipeline/dto.py).
_CT2_COMPUTE = (
    "auto",
    "default",
    "int8",
    "int8_float16",
    "int8_bfloat16",
    "int8_float32",
    "int16",
    "float16",
    "bfloat16",
    "float32",
)
_ONNX_QUANT = ("fp16", "int8", "uint8", "q4", "q4f16", "bnb4", "quantized")

register_processor(
    kind="asr",
    name="safetensor",
    lazy_target="stt_v2.processors.asr_engines:SafetensorEngine",
    capabilities=[
        Capability(device="cuda", compute=_HF_COMPUTE),
        Capability(device="mps", compute=("float32", "auto")),  # fp16 coerced to fp32
        Capability(device="cpu", compute=("float32", "int8", "auto")),
    ],
    traits=("initial_prompt", "word_timestamps", "gloss"),
    metadata={"aliases": ("pytorch", "ctranslate2", "transformers", "hf", "huggingface")},
)

register_processor(
    kind="asr",
    name="onnx",
    lazy_target="stt_v2.processors.asr_engines:OnnxEngine",
    capabilities=[
        # Raw ORT session path: batch-only stub, no processor → no streaming.
        Capability(device="cuda", compute=_ONNX_QUANT, streaming=False),
        Capability(device="cpu", compute=_ONNX_QUANT, streaming=False),
    ],
    traits=(),
)

register_processor(
    kind="asr",
    name="onnx_optimum",
    lazy_target="stt_v2.processors.asr_engines:OnnxEngine",
    capabilities=[
        # No MPS: Optimum ORT auto-detects cuda/cpu only.
        Capability(device="cuda", compute=_ONNX_QUANT),
        Capability(device="cpu", compute=_ONNX_QUANT),
    ],
    traits=("initial_prompt", "word_timestamps", "gloss"),
)

register_processor(
    kind="asr",
    name="nemo",
    lazy_target="stt_v2.processors.asr_engines:NemoEngine",
    capabilities=[
        Capability(device="cuda", compute=("float32",)),
        Capability(device="mps", compute=("float32",)),
        Capability(device="cpu", compute=("float32",)),
    ],
    # Word timestamps only for RNNT/TDT/Hybrid classes — declared at the
    # engine level as supported; the adapter degrades per model class.
    traits=("word_timestamps",),
)

register_processor(
    kind="asr",
    name="faster_whisper",
    lazy_target="stt_v2.processors.asr_engines:FasterWhisperEngine",
    capabilities=[
        Capability(device="cuda", compute=_CT2_COMPUTE),
        # MPS unsupported by CTranslate2 → resolver must fall through to CPU.
        Capability(device="cpu", compute=_CT2_COMPUTE),
    ],
    # Batch support since TASK-505 P1 increment 1 (_run_faster_whisper_inference).
    traits=("initial_prompt", "word_timestamps", "gloss"),
)

register_processor(
    kind="asr",
    name="azure_speech",
    lazy_target="stt_v2.processors.asr_engines:AzureSpeechEngine",
    capabilities=[Capability(device="cloud")],
    traits=("word_timestamps",),
    metadata={"aliases": ("azure",)},
)

# TASK-505 P3 — new engines.

register_processor(
    kind="asr",
    name="parakeet_cpp",
    lazy_target="stt_v2.processors.asr_engines:ParakeetCppEngine",
    capabilities=[
        # ggml runtime: CPU everywhere; Metal (mps) and CUDA when the library
        # is built with those backends.
        Capability(device="cpu", compute=("q4_k", "q5_k", "q6_k", "q8_0", "f16", "f32")),
        Capability(device="mps", compute=("q4_k", "q5_k", "q8_0", "f16")),
        Capability(device="cuda", compute=("q4_k", "q5_k", "q8_0", "f16", "f32")),
    ],
    traits=("word_timestamps",),
)

register_processor(
    kind="asr",
    name="azure_foundry",
    lazy_target="stt_v2.processors.asr_engines:AzureFoundryEngine",
    capabilities=[
        # Decision D4: preview → batch-only; realtime needs Voice Live API.
        Capability(device="cloud", streaming=False),
    ],
    traits=("word_timestamps", "phrase_list"),
    metadata={"aliases": ("foundry", "mai")},
)

# TASK-507 — whisper.cpp (GGUF whisper-large-v3-turbo), via pywhispercpp.

register_processor(
    kind="asr",
    name="whisper_cpp",
    lazy_target="stt_v2.processors.asr_engines:WhisperCppEngine",
    capabilities=[
        # ggml runtime: CPU everywhere; Metal (mps) and CUDA when pywhispercpp
        # is built with those backends.
        Capability(device="cpu", compute=("q4_k", "q5_k", "q6_k", "q8_0", "f16", "f32")),
        Capability(device="mps", compute=("q4_k", "q5_k", "q8_0", "f16")),
        Capability(device="cuda", compute=("q4_k", "q5_k", "q8_0", "f16", "f32")),
    ],
    # Per-utterance streaming (single inference pass) + batch, mirroring the
    # faster-whisper precedent — whisper (unlike RNNT) supports both well.
    traits=("initial_prompt", "word_timestamps"),
)
