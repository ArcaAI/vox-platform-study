# Research Report: Whisper ONNX Runtime & Optimum Inference Optimization (2025–2026)

**Date**: 2026-02-12  
**Topic**: Whisper model inference optimization using ONNX Runtime and Hugging Face Optimum  
**Scope**: Production best practices, batched inference, per-call overhead, faster-whisper comparison, CPU/Apple Silicon tuning

---

## Executive Summary

This research provides actionable findings for optimizing Whisper inference with ONNX Runtime and Optimum. The main conclusions:

1. **VAD + Whisper pipelines**: Segment merging before inference is a standard pattern; avoid aggressive `merge_segments` post-processing that can corrupt timestamps.
2. **Batched inference**: Optimum `ORTModelForSpeechSeq2Seq.generate()` supports batching, but padding/attention masks have caveats; explicitly pass `attention_mask` and use recent Transformers versions.
3. **Per-call overhead**: The ~6s fixed cost per `generate()` on CPU is dominated by encoder + decoder loop; the mel spectrogram is always 30s (3000 frames); short audio is zero-padded. Segment merging reduces calls; batched inference amortizes encoder cost.
4. **faster-whisper vs Optimum ONNX**: faster-whisper (CTranslate2) is widely used in production, often 4× faster; Optimum ONNX offers better HuggingFace integration and all-in-one Olive optimization. Choose based on latency vs. ecosystem needs.
5. **CPU/Apple Silicon**: Use `intra_op_num_threads=0` (auto); disable spinning for multi-session workloads; CoreML EP is production-ready with `MLComputeUnits="ALL"` and `ModelFormat="MLProgram"`.

---

## Query 1: Whisper ONNX Runtime Optimum Inference Performance Best Practices

### Production Handling of Variable-Length Audio

- **30-second limit**: Whisper’s feature extractor uses a fixed 30s window (`N_SAMPLES=480000`, `N_FRAMES=3000`). Shorter audio is zero-padded; longer audio must be chunked.
- **Chunking**: Long audio is split into overlapping chunks (~30s, stride ~5s). The Hugging Face pipeline and Optimum support chunking.
- **Practical approach**: Use manual chunking with `generate()` for full control; `chunk_length_s=30`, `stride_length_s=chunk_length_s/6` (~5s overlap).

### VAD + Whisper Pipelines

- **VAD first**: VAD (e.g. Silero) reduces hallucinations and enables batching by isolating speech segments.
- **Segment merging**: Merge adjacent speech segments before inference to cut the number of `generate()` calls. Each call has ~6s overhead on CPU.
- **Warnings**: faster-whisper `merge_segments` can corrupt timestamps and double-count padding when `max_speech_duration_s` is exceeded. Prefer merging only adjacent segments and preserving VAD boundaries.
- **WhisperX**: Uses VAD-based batching and forced alignment; good reference for VAD + Whisper pipelines.

### Segment Merging Before Inference

- **Yes, it’s standard**: Merging adjacent speech segments up to `chunk_length_s` before inference is a common pattern.
- **Goal**: Reduce calls to `generate()` (each has ~6s encoder overhead on CPU).
- **Constraints**: Use `gap_threshold_s` between segments; don’t merge beyond `max_duration_s` (e.g. 15–30s).

```python
# Reference: merge_vad_segments pattern (from TASK-017)
def merge_vad_segments(
    segments: list[AudioSegment],
    max_duration_s: float = 15.0,
    gap_threshold_s: float = 2.0,
) -> list[AudioSegment]:
    """Merge adjacent VAD segments to reduce inference calls."""
    # Adjacent segments within gap_threshold_s merged up to max_duration_s
    ...
```

---

## Query 2: ORTModelForSpeechSeq2Seq Batched Inference

### Can You Batch Multiple Audio Segments in a Single `generate()` Call?

- **Yes**: Optimum’s `ORTModelForSpeechSeq2Seq` supports batched `generate()`.
- **Flow**: Preprocess each segment with the processor, stack into a batch, pass to `model.generate()`.
- **Use `use_io_binding` and `CUDAExecutionProvider`** for best throughput on GPU.

### Padding and Attention Mask Caveats

- **Padding**: Short clips are padded to the longest in the batch. Whisper expects fixed-length mel input (3000 frames); processor handles padding.
- **Attention mask**: Whisper originally did not respect `attention_mask`; a bug was fixed in Transformers (issue #32228). Always pass `attention_mask` explicitly.
- **Pad token**: If `pad_token == eos_token`, the mask cannot be inferred; pass `attention_mask` manually.
- **Device mismatch**: `_pad_to_max_length` previously stacked tensors across devices (GPU/MPS); fixed in a later PR.

### Stability and Recommendation

- **Stable**: Batched inference is supported but has edge cases.
- **Best practices**:
  1. Use Transformers/Optimum versions that include the attention mask fixes.
  2. Pass `attention_mask` explicitly.
  3. Use `padding=True` and `return_attention_mask=True` in the processor.
  4. Avoid KV-cache “with-past” export when using chunked pipelines (Optimum issue #1816: `_retrieve_segment` AttributeError).

```python
# Batched inference with explicit attention mask
inputs = processor(
    audio_segments,
    sampling_rate=16000,
    return_tensors="pt",
    padding=True,
    return_attention_mask=True,
)
outputs = onnx_model.generate(**inputs, **generate_kwargs)
```

---

## Query 3: Whisper Encoder Fixed Overhead Per Generate Call

### Why ~6s Per Call on CPU for large-v3-turbo?

- **Encoder + decoder**: Each `generate()` runs the encoder (fixed 30s mel window) and the autoregressive decoder loop. Both contribute to a per-call cost.
- **Encoder**: Processes 3000 mel frames regardless of real audio length.
- **Decoder**: One step per token; cost scales with output length.
- **Profiling**: Use ONNX Runtime benchmark scripts to separate encoder vs decoder cost.

### Can You Reduce Per-Call Overhead?

1. **Segment merging**: Merge adjacent VAD segments to reduce the number of calls (main lever).
2. **Batched inference**: Batch multiple segments in one `generate()` to amortize encoder cost.
3. **All-in-one ONNX model**: Microsoft Olive combines encoder, decoder, and beam search into one model; KV-cache optimization can reduce latency.
4. **Quantization**: int8 or q4 reduces compute and memory.
5. **Turbo variant**: large-v3-turbo uses fewer decoder layers (32→4), faster decoding.

### Is the Mel Spectrogram Always 30s? Can It Be Truncated?

- **Fixed 30s**: `CHUNK_LENGTH=30`, `N_SAMPLES=480000`, `N_FRAMES=3000`. Shorter audio is zero-padded via `pad_or_trim`.
- **No official truncation**: Hugging Face declined to add variable-length support (positional embeddings). Truncating positional embeddings is a non-standard hack.
- **Practical approach**: Accept the 30s window; optimize by merging segments and batching instead of shortening the mel input.

---

## Query 4: faster-whisper vs Optimum ONNX Comparison

### Performance

- **faster-whisper (CTranslate2)**: Often ~4× faster than `openai/whisper` at similar accuracy.
- **Batching**: Batched inference can give large speedups (e.g. batch_size 8–16).
- **Quantization**: int8 reduces GPU memory and inference time.
- **Example (large-v3-turbo)**: ~19s for 13 min audio on GPU (fp16); int8 ~19.59s, ~1.5GB VRAM.

### Which Is More Common in Production?

- **faster-whisper**: Widely used in production (CLI, Docker, batched inference, int8).
- **Optimum ONNX**: Better for Hugging Face–centric workflows and Olive-based optimization.
- **WhisperX**: Combines faster-whisper-style inference with VAD and diarization.

### Should You Consider CTranslate2?

- **Use faster-whisper when**:
  - High throughput and low latency are top priorities.
  - You can use CTranslate2/CUDA (CUDA 12 + cuDNN 9).
  - You need batched inference and int8 out of the box.
- **Use Optimum ONNX when**:
  - You want Hugging Face pipelines and model hub integration.
  - You use Olive for all-in-one optimized models.
  - You need CoreML or other ONNX execution providers.
- **Hybrid**: Use faster-whisper for production inference and Optimum for export/optimization workflows.

---

## Query 5: ONNX Runtime Session Options & Apple Silicon

### CPU Session Options

```python
import onnxruntime as ort

sess_options = ort.SessionOptions()

# Threading (defaults are usually good)
sess_options.intra_op_num_threads = 0   # Auto = physical cores
sess_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL  # Default
# For branched graphs: ORT_PARALLEL + inter_op_num_threads

# Graph optimization
sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

# Disable spinning (for multi-session or lower CPU usage)
sess_options.add_session_config_entry("session.intra_op.allow_spinning", "0")
sess_options.add_session_config_entry("session.inter_op.allow_spinning", "0")
```

### Threading Notes

- **`intra_op_num_threads=0`**: Auto-size to physical cores (recommended).
- **Spinning**: Disabling spinning reduces CPU load when running multiple sessions serially.
- **Affinity**: Use `session.intra_op.thread_affinities` for NUMA tuning on multi-node systems.

### Apple Silicon (CoreML execution provider)

- **Production-ready**: CoreML EP is suitable for production.
- **Configuration**:

```python
providers = [
    ("CoreMLExecutionProvider", {
        "ModelFormat": "MLProgram",      # macOS 12+, iOS 15+
        "MLComputeUnits": "ALL",         # CPU + GPU + ANE
        "RequireStaticInputShapes": "0", # Variable audio length
        "EnableOnSubgraphs": "0",
        "ModelCacheDirectory": "/path/to/cache",  # Speeds up subsequent loads
    }),
    "CPUExecutionProvider",
]
```

- **Cache**: Use `ModelCacheDirectory` to avoid repeated CoreML compilation.
- **ANE**: `MLComputeUnits="ALL"` lets CoreML use CPU, GPU, and ANE when available.
- **Alternative**: whisper.cpp with Metal/CoreML is another option for Apple Silicon.

---

## Recommendations Summary

### Do

1. **Segment merging**: Merge adjacent VAD segments before inference.
2. **Attention mask**: Pass `attention_mask` explicitly for batched Whisper.
3. **Chunking**: Use `chunk_length_s=30`, `stride_length_s=5` for long audio.
4. **Session options**: `intra_op_num_threads=0`, `ORT_ENABLE_ALL` graph optimization.
5. **Apple Silicon**: Use CoreML with `MLComputeUnits="ALL"` and `ModelFormat="MLProgram"`.
6. **Quantization**: Prefer q4 or int8 for CPU; fp16 on CPU can hit kernel issues.
7. **Olive**: Use Olive for all-in-one Whisper ONNX and quantization.

### Don’t

1. **Don’t** rely on aggressive post-VAD `merge_segments` that alters timestamps.
2. **Don’t** use fp16 on CPU-only systems (SimplifiedLayerNormFusion lacks fp16 kernels).
3. **Don’t** export Whisper “with-past” for chunked pipelines (Optimum bug).
4. **Don’t** assume variable-length mel input; the model expects 30s (3000 frames).
5. **Don’t** set `intra_op_num_threads` to small values without profiling; it can hurt performance.

### Pitfalls

- **Merge + batch**: Merging VAD segments can change overlap and duplicate handling; test timestamp correctness.
- **Batch padding**: Highly variable segment lengths increase padding and can reduce batch efficiency.
- **CoreML conversion**: Large models may hit memory limits; cache compilation with `ModelCacheDirectory`.
- **Spinning**: Disable spinning if you run many sessions serially and want to limit CPU usage.

---

## Code Examples

### Segment Merging + Single Inference

```python
from stt.transcription.segment_merger import merge_vad_segments

# After VAD
merged = merge_vad_segments(
    vad_segments,
    max_duration_s=15.0,
    gap_threshold_s=2.0,
)

for seg in merged:
    audio = samples[int(seg.start_time * sr):int(seg.end_time * sr)]
    inputs = processor(audio, sampling_rate=sr, return_tensors="pt")
    out = model.generate(**inputs, return_timestamps=False)
```

### Batched Inference with Attention Mask

```python
inputs = processor(
    audio_arrays,
    sampling_rate=16000,
    return_tensors="pt",
    padding=True,
    return_attention_mask=True,
)
outputs = model.generate(**inputs, task="transcribe", return_timestamps=False)

for i, out in enumerate(outputs):
    decoded = processor.decode(out, skip_special_tokens=True, output_offsets=True)
    # Apply segment.start_time offset to word timestamps
```

### ONNX Session Options (CPU + CoreML)

```python
import onnxruntime as ort

sess_opts = ort.SessionOptions()
sess_opts.intra_op_num_threads = 0
sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

# Apple Silicon
providers = [
    ("CoreMLExecutionProvider", {
        "ModelFormat": "MLProgram",
        "MLComputeUnits": "ALL",
        "RequireStaticInputShapes": "0",
        "ModelCacheDirectory": tempfile.gettempdir() + "/ort_coreml_cache",
    }),
    "CPUExecutionProvider",
]

model = ORTModelForSpeechSeq2Seq.from_pretrained(
    "onnx-community/whisper-large-v3-turbo",
    provider=providers[0] if isinstance(providers[0], tuple) else providers,
    session_options=sess_opts,
)
```

---

## Sources

1. [Build and deploy Whisper with ONNX Runtime](https://medium.com/microsoftazure/build-and-deploy-fast-and-portable-speech-recognition-applications-with-onnx-runtime-and-whisper-5bf0969dd56b) — Microsoft Azure
2. [ONNX Runtime Thread Management](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)
3. [CoreML Execution Provider](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
4. [faster-whisper VAD docs](https://tessl.io/registry/tessl/pypi-faster-whisper/1.2.0/files/docs/voice-activity-detection.md)
5. [Hugging Face Transformers #32228](https://github.com/huggingface/transformers/issues/32228) — attention_mask fix
6. [Optimum #1816](https://github.com/huggingface/optimum/issues/1816) — KV-cache chunking bug
7. [OpenAI Whisper audio.py](https://github.com/openai/whisper/blob/main/whisper/audio.py) — N_FRAMES=3000
8. [WhisperX](https://github.com/m-bain/whisperx) — VAD + batching
9. HOPE codebase: `apps/stt`, `research/whisper-onnx-apple-silicon-best-practices.md`, TASK-017
