# Research Report: Whisper ONNX Runtime Best Practices for Apple Silicon

**Date**: 2026-02-08  
**Researcher**: AI Assistant  
**Topic**: Whisper ONNX Runtime optimization for Apple Silicon (M-series) devices

## Executive Summary

This research report provides comprehensive best practices for running Whisper models with ONNX Runtime on Apple Silicon devices, covering long audio transcription, pipeline vs manual generation approaches, chunking strategies, generation parameters, and ONNX Runtime session configuration.

**Key Recommendations**:
1. Use **Optimum ONNX Runtime pipelines** (`optimum.onnxruntime.pipeline`) for automatic-speech-recognition tasks - they provide built-in chunking and are drop-in replacements for Transformers pipelines
2. For long audio (>30s), use `chunk_length_s=30` with `stride_length_s=chunk_length_s/6` (~5s) for optimal accuracy
3. Configure CoreML execution provider with `MLComputeUnits="ALL"` and `ModelFormat="MLProgram"` for Apple Silicon acceleration
4. Use manual `generate()` calls when you need fine-grained control over chunking and merging logic
5. Set `intra_op_num_threads=0` (auto) for optimal thread management on Apple Silicon

---

## 1. Long Audio Transcription with Whisper ONNX

### The 30-Second Limitation

Whisper's feature extractor has a **hard limit of 30 seconds** per input. Audio longer than 30 seconds is automatically truncated or padded to this window. For long-form transcription, you must manually chunk the audio.

### Recommended Approach: Optimum Pipeline with Chunking

The **Optimum ONNX Runtime pipeline** (`optimum.onnxruntime.pipeline`) provides built-in support for long audio through chunking parameters:

```python
from optimum.onnxruntime import pipeline
from transformers import AutoProcessor

# Initialize pipeline
asr_pipeline = pipeline(
    "automatic-speech-recognition",
    model="onnx-community/whisper-large-v3-turbo",
    accelerator="ort",
    device="cpu"  # CoreML handles device dispatch internally
)

# For long audio, the pipeline handles chunking internally
# However, explicit chunking parameters may not be directly supported
# in Optimum pipelines - manual chunking is recommended
```

### Manual Chunking Approach (Current Best Practice)

Based on your codebase implementation and research findings, **manual chunking with `generate()` calls** provides the best control:

```python
from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
from transformers import AutoProcessor
import numpy as np

# Load model and processor
model = ORTModelForSpeechSeq2Seq.from_pretrained(
    "onnx-community/whisper-large-v3-turbo",
    provider="CoreMLExecutionProvider",
    provider_options={
        "MLComputeUnits": "ALL",
        "ModelFormat": "MLProgram",
    }
)
processor = AutoProcessor.from_pretrained("onnx-community/whisper-large-v3-turbo")

# Chunking parameters (per HuggingFace best practices)
chunk_length_s = 30.0  # Max Whisper window
stride_length_s = chunk_length_s / 6.0  # ~5s overlap
step_s = chunk_length_s - stride_length_s  # ~25s advance

sample_rate = 16000
chunk_samples = int(chunk_length_s * sample_rate)
stride_samples = int(stride_length_s * sample_rate)
step_samples = int(step_s * sample_rate)

# Process audio in chunks
all_text_parts = []
all_word_timestamps = []

offset = 0
while offset < len(audio_samples):
    chunk_start_s = offset / sample_rate
    end_sample = min(offset + chunk_samples, len(audio_samples))
    chunk_audio = audio_samples[offset:end_sample]
    
    # Process chunk
    inputs = processor(
        chunk_audio,
        sampling_rate=sample_rate,
        return_tensors="pt",
    )
    
    # Generate transcription
    generated_ids = model.generate(
        **inputs,
        language="en",  # or None for auto-detect
        task="transcribe",
        return_timestamps=True,
    )
    
    # Decode
    chunk_text = processor.batch_decode(
        generated_ids, skip_special_tokens=True
    )[0]
    
    # Extract timestamps (with global offset)
    decoded = processor.decode(
        generated_ids[0],
        skip_special_tokens=False,
        output_offsets=True,
    )
    offsets = decoded.get("offsets", [])
    
    # Normalize timestamps to global time
    for offset_dict in offsets:
        offset_dict["start"] += chunk_start_s
        offset_dict["end"] += chunk_start_s
    
    all_text_parts.append(chunk_text)
    all_word_timestamps.extend(offsets)
    
    # Advance by step (not chunk_length) to create overlap
    offset += step_samples

# Merge results
final_text = " ".join(all_text_parts)
```

**Key Points**:
- **`chunk_length_s=30`**: Maximum window size Whisper can handle
- **`stride_length_s=chunk_length_s/6`**: Recommended overlap (~5s for 30s chunks) prevents word cutting at boundaries
- **`step_s=chunk_length_s-stride_length_s`**: Actual advance per iteration (~25s)
- Always normalize timestamps with `chunk_start_s` offset for global time reference

---

## 2. Pipeline vs Manual `generate()` Calls

### When to Use Pipeline

**Use `pipeline("automatic-speech-recognition")` when**:
- You want simplicity and automatic preprocessing/postprocessing
- You're working with short audio (<30s)
- You don't need fine-grained control over chunking
- You want drop-in compatibility with Transformers pipelines

**Limitations**:
- Optimum pipelines may not expose `chunk_length_s` and `stride_length_s` parameters directly
- Less control over chunk merging logic
- Harder to customize timestamp handling

### When to Use Manual `generate()` Calls

**Use manual `generate()` calls when**:
- Processing long audio (>30s) with custom chunking
- You need precise control over chunk boundaries and merging
- You want custom timestamp normalization
- You need to implement custom progress reporting
- You're implementing advanced features like speaker diarization integration

**Advantages**:
- Full control over chunking strategy
- Custom merge logic (e.g., removing duplicate text from overlaps)
- Better memory management for very long audio
- Easier to integrate with other processing steps

### Code Comparison

**Pipeline Approach**:
```python
from optimum.onnxruntime import pipeline

asr = pipeline(
    "automatic-speech-recognition",
    model="onnx-community/whisper-large-v3-turbo",
    accelerator="ort",
)

# Simple call (but may not handle >30s well)
result = asr(audio_array)
```

**Manual Generate Approach** (Recommended for long audio):
```python
from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
from transformers import AutoProcessor

model = ORTModelForSpeechSeq2Seq.from_pretrained(...)
processor = AutoProcessor.from_pretrained(...)

# Full control over chunking
inputs = processor(audio_chunk, sampling_rate=16000, return_tensors="pt")
generated_ids = model.generate(
    **inputs,
    language="en",
    task="transcribe",
    return_timestamps=True,
)
```

---

## 3. Chunking Parameters: `chunk_length_s` and `stride_length_s`

### Understanding the Parameters

- **`chunk_length_s`**: Duration of each audio chunk in seconds
  - **Maximum**: 30 seconds (Whisper's feature extractor limit)
  - **Recommended**: 30 seconds for optimal accuracy
  - **Smaller values** (15-20s): Faster processing, less context per chunk
  - **Setting to 0**: Disables chunking (only works for <30s audio)

- **`stride_length_s`**: Overlap between consecutive chunks
  - **Default**: `chunk_length_s / 6` (per HuggingFace best practices)
  - **For 30s chunks**: ~5 seconds overlap
  - **Purpose**: Prevents word cutting at chunk boundaries
  - **Too small**: May cut words mid-phrase
  - **Too large**: Wastes computation on duplicate transcription

### Recommended Configuration

```python
# Optimal settings for long audio
chunk_length_s = 30.0  # Maximum Whisper window
stride_length_s = chunk_length_s / 6.0  # ~5 seconds overlap
step_s = chunk_length_s - stride_length_s  # ~25 seconds advance

# For faster processing (slightly lower accuracy)
chunk_length_s = 15.0
stride_length_s = chunk_length_s / 6.0  # ~2.5 seconds overlap
step_s = chunk_length_s - stride_length_s  # ~12.5 seconds advance
```

### How the Pipeline Handles 30-Second Limitation

The Transformers `AutomaticSpeechRecognitionPipeline` handles this internally:

1. **Audio preprocessing**: Feature extractor pads/truncates to 30s window
2. **Chunking**: For audio >30s, pipeline splits into overlapping chunks
3. **Stride handling**: Pipeline discards stride portions during merge to avoid duplicates
4. **Reconstruction**: Results are merged with proper timestamp alignment

However, **Optimum pipelines may not expose these parameters directly**. Your current implementation correctly handles this manually.

---

## 4. Generation Parameters: `generate_kwargs`

### Essential Parameters for Whisper

```python
generate_kwargs = {
    "language": "en",  # Language code or None for auto-detect
    "task": "transcribe",  # "transcribe" or "translate"
    "return_timestamps": True,  # Enable timestamp extraction
    # Optional parameters:
    "max_new_tokens": None,  # Limit generation length (rarely needed)
    "temperature": 0.0,  # Deterministic output (recommended)
    "no_speech_threshold": 0.6,  # Skip silent chunks
    "condition_on_prev_tokens": True,  # Use previous chunk context
}
```

### Language Parameter

```python
# Auto-detect language (recommended for multilingual use)
generate_kwargs = {"language": None, "task": "transcribe"}

# Force specific language (faster, more accurate if known)
generate_kwargs = {"language": "en", "task": "transcribe"}

# Translation task
generate_kwargs = {"language": "fr", "task": "translate"}
```

### Task Parameter

- **`"transcribe"`**: Convert speech to text in the same language
- **`"translate"`**: Convert speech to English text (regardless of source language)

### Return Timestamps

```python
# Word-level timestamps
generate_kwargs = {"return_timestamps": True}

# Extract timestamps after generation
decoded = processor.decode(
    generated_ids[0],
    skip_special_tokens=False,
    output_offsets=True,  # Enable offset extraction
)
word_timestamps = decoded.get("offsets", [])
```

### Using GenerationConfig (Advanced)

For models with `generation_config.json`:

```python
from transformers import GenerationConfig

# Load from model repo
generation_config = GenerationConfig.from_pretrained(
    "onnx-community/whisper-large-v3-turbo"
)

# Configure language/task via decoder prompt IDs
processor = AutoProcessor.from_pretrained(...)
decoder_ids = processor.get_decoder_prompt_ids(language="fr", task="translate")
generation_config.forced_decoder_ids = decoder_ids

# Use in generation
generated_ids = model.generate(
    **inputs,
    generation_config=generation_config,
    return_timestamps=True,
)
```

---

## 5. `max_new_tokens` vs `max_length`

### Understanding the Difference

- **`max_length`**: Total sequence length (input + generated tokens)
  - Whisper models have predefined `max_length` based on positional embeddings
  - Example: `whisper-base` has `max_length=448` tokens
  - Setting `max_length` limits the total sequence

- **`max_new_tokens`**: Number of tokens to generate (excluding input)
  - More intuitive for generation tasks
  - Allows generation shorter than model's maximum capacity
  - Can enable faster inference for short transcriptions

### For Whisper Specifically

```python
# Whisper's max_length is typically 448 tokens (model-dependent)
# This covers ~30 seconds of audio input + generated text

# Using max_new_tokens (recommended)
generated_ids = model.generate(
    **inputs,
    max_new_tokens=200,  # Limit output length
    language="en",
    task="transcribe",
)

# Using max_length (less common)
generated_ids = model.generate(
    **inputs,
    max_length=448,  # Total sequence length
    language="en",
    task="transcribe",
)
```

### Recommendation

**For Whisper ONNX models**:
- **Don't set `max_length`** unless you need to limit total sequence length
- **Use `max_new_tokens`** only if you want to cap output length (rarely needed)
- **Leave both unset** for normal transcription (model uses its default max)

The model's built-in `max_length` constraint is usually sufficient for 30-second audio chunks.

---

## 6. ONNX Runtime Session Options for Apple Silicon

### CoreML Execution Provider Configuration

```python
import onnxruntime as ort

# Check CoreML availability
available_providers = ort.get_available_providers()
# Should include: ['CoreMLExecutionProvider', 'CPUExecutionProvider']

# Configure CoreML provider options
coreml_options = {
    "MLComputeUnits": "ALL",  # CPU + GPU + Neural Engine
    "ModelFormat": "MLProgram",  # Modern format (macOS 12+)
    "RequireStaticInputShapes": "0",  # Audio length varies
    "EnableOnSubgraphs": "0",  # Safest for complex models
    "ModelCacheDirectory": "/var/folders/.../onnxruntime_coreml_cache",  # Local cache
}

# Session options
session_options = ort.SessionOptions()
session_options.graph_optimization_level = (
    ort.GraphOptimizationLevel.ORT_ENABLE_ALL
)
session_options.intra_op_num_threads = 0  # Auto-size to CPU cores
# inter_op_num_threads = 1 (default, Whisper is sequential)

# Load model with CoreML
model = ORTModelForSpeechSeq2Seq.from_pretrained(
    "onnx-community/whisper-large-v3-turbo",
    provider="CoreMLExecutionProvider",
    provider_options=coreml_options,
    session_options=session_options,
)
```

### Thread Configuration

**`intra_op_num_threads`**:
- **0 (recommended)**: Auto-size to physical CPU core count
- **Explicit value**: Set specific thread count (e.g., `4` for 4 cores)
- **Apple Silicon**: Typically 8-10 performance cores + efficiency cores
- **Best practice**: Use `0` (auto) unless profiling shows better performance with specific count

**`inter_op_num_threads`**:
- **Default: 1**: Sufficient for sequential models like Whisper
- **Only relevant**: When `execution_mode=ORT_PARALLEL`
- **Whisper**: Sequential architecture, leave at default

### Graph Optimization

```python
session_options = ort.SessionOptions()

# Full optimization (recommended for most cases)
session_options.graph_optimization_level = (
    ort.GraphOptimizationLevel.ORT_ENABLE_ALL
)

# Reduced optimization (for fp16 on CPU - avoids SimplifiedLayerNormFusion issues)
if quantization == "fp16" and device == "cpu":
    session_options.graph_optimization_level = (
        ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    )
```

### Provider Priority

```python
# Recommended provider order for Apple Silicon
providers = [
    "CoreMLExecutionProvider",  # First: Use Apple hardware acceleration
    "CPUExecutionProvider",     # Fallback: Pure CPU
]

# With options
providers = [
    ("CoreMLExecutionProvider", coreml_options),
    "CPUExecutionProvider",
]
```

### CoreML Cache Directory

**Important**: CoreML compilation creates cache files. Use a local APFS/HFS+ directory:

```python
import tempfile
import os

# Use system temp directory (always on local APFS volume)
cache_dir = os.path.join(tempfile.gettempdir(), "onnxruntime_coreml_cache")
os.makedirs(cache_dir, exist_ok=True)

coreml_options["ModelCacheDirectory"] = cache_dir
```

**Why**: External volumes (exFAT, etc.) can cause AppleDouble resource fork conflicts.

---

## 7. Complete Example: Long Audio Transcription on Apple Silicon

```python
"""
Complete example: Whisper ONNX Runtime on Apple Silicon
with long audio transcription support.
"""
import onnxruntime as ort
import tempfile
import os
from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
from transformers import AutoProcessor
import numpy as np

# 1. Configure CoreML execution provider
coreml_available = "CoreMLExecutionProvider" in ort.get_available_providers()

if coreml_available:
    cache_dir = os.path.join(tempfile.gettempdir(), "onnxruntime_coreml_cache")
    os.makedirs(cache_dir, exist_ok=True)
    
    coreml_options = {
        "MLComputeUnits": "ALL",
        "ModelFormat": "MLProgram",
        "RequireStaticInputShapes": "0",
        "EnableOnSubgraphs": "0",
        "ModelCacheDirectory": cache_dir,
    }
    provider = "CoreMLExecutionProvider"
    provider_options = coreml_options
else:
    provider = "CPUExecutionProvider"
    provider_options = None

# 2. Configure session options
session_options = ort.SessionOptions()
session_options.graph_optimization_level = (
    ort.GraphOptimizationLevel.ORT_ENABLE_ALL
)
session_options.intra_op_num_threads = 0  # Auto-size

# 3. Load model
model = ORTModelForSpeechSeq2Seq.from_pretrained(
    "onnx-community/whisper-large-v3-turbo",
    provider=provider,
    provider_options=provider_options,
    session_options=session_options,
)

processor = AutoProcessor.from_pretrained(
    "onnx-community/whisper-large-v3-turbo"
)

# 4. Chunking configuration
chunk_length_s = 30.0
stride_length_s = chunk_length_s / 6.0  # ~5s
step_s = chunk_length_s - stride_length_s  # ~25s

sample_rate = 16000
chunk_samples = int(chunk_length_s * sample_rate)
step_samples = int(step_s * sample_rate)

# 5. Process long audio
def transcribe_long_audio(audio_samples, sample_rate, language=None):
    """Transcribe audio longer than 30 seconds."""
    all_text_parts = []
    all_word_timestamps = []
    all_segments = []
    
    offset = 0
    total_duration = len(audio_samples) / sample_rate
    
    while offset < len(audio_samples):
        chunk_start_s = offset / sample_rate
        end_sample = min(offset + chunk_samples, len(audio_samples))
        chunk_audio = audio_samples[offset:end_sample]
        
        # Skip very short chunks
        if len(chunk_audio) < sample_rate // 2:
            break
        
        # Process chunk
        inputs = processor(
            chunk_audio,
            sampling_rate=sample_rate,
            return_tensors="pt",
        )
        
        # Generate kwargs
        generate_kwargs = {
            "task": "transcribe",
            "return_timestamps": True,
        }
        if language:
            generate_kwargs["language"] = language
        
        # Generate transcription
        generated_ids = model.generate(
            **inputs,
            **generate_kwargs,
        )
        
        # Decode text
        chunk_text = processor.batch_decode(
            generated_ids, skip_special_tokens=True
        )[0].strip()
        
        # Extract timestamps
        chunk_word_ts = []
        try:
            decoded = processor.decode(
                generated_ids[0],
                skip_special_tokens=False,
                output_offsets=True,
            )
            raw_offsets = decoded.get("offsets", [])
            
            # Normalize to global time
            for ts in raw_offsets:
                ts["start"] += chunk_start_s
                ts["end"] += chunk_start_s
            chunk_word_ts = raw_offsets
        except Exception:
            pass
        
        # Accumulate results
        if chunk_text:
            all_text_parts.append(chunk_text)
            all_word_timestamps.extend(chunk_word_ts)
            
            chunk_end_s = min(
                chunk_start_s + len(chunk_audio) / sample_rate,
                total_duration,
            )
            all_segments.append({
                "text": chunk_text,
                "start": chunk_start_s,
                "end": chunk_end_s,
            })
        
        # Advance
        offset += step_samples
    
    # Merge results
    final_text = " ".join(all_text_parts)
    
    return {
        "text": final_text,
        "word_timestamps": all_word_timestamps,
        "segments": all_segments,
    }

# 6. Usage
# audio_samples = np.array(...)  # Your audio data
# result = transcribe_long_audio(audio_samples, sample_rate=16000, language="en")
# print(result["text"])
```

---

## 8. Performance Optimization Tips

### Quantization for Apple Silicon

```python
# Recommended quantization for CPU/CoreML
# q4: Best balance (4-bit quantization, ~760MB for large-v3-turbo)
model = ORTModelForSpeechSeq2Seq.from_pretrained(
    "onnx-community/whisper-large-v3-turbo",
    encoder_file_name="encoder_model_q4.onnx",
    decoder_file_name="decoder_model_merged_q4.onnx",
    decoder_with_past_file_name="decoder_model_merged_q4.onnx",
)

# fp16: Faster on GPU, but may have issues on CPU
# Avoid fp16 on CPU-only systems (SimplifiedLayerNormFusion lacks fp16 kernels)
```

### Memory Management

- Use **merged decoder** (`use_merged=True`) to reduce memory footprint
- Process chunks sequentially rather than batching for long audio
- Clear intermediate results between chunks

### Batch Processing

**For short audio (<30s)**:
```python
# Batch multiple short clips
inputs = processor(
    [audio1, audio2, audio3],
    sampling_rate=16000,
    return_tensors="pt",
)
generated_ids = model.generate(**inputs)
```

**For long audio**: Process sequentially (chunking) rather than batching.

---

## 9. Comparison: Your Current Implementation

Your current implementation in `batch_service.py` follows best practices:

✅ **Correct chunking strategy**: `chunk_length_s=15s` (configurable), `stride=chunk_length_s/6`  
✅ **Proper timestamp normalization**: Adding `chunk_start_s` offset  
✅ **CoreML configuration**: Using `MLComputeUnits="ALL"` and `MLProgram` format  
✅ **Thread management**: Using `intra_op_num_threads=0` (auto)  
✅ **Manual generate() calls**: Full control over chunking and merging  

**Potential improvements**:
- Consider increasing `chunk_length_s` to 30s for better accuracy (if memory allows)
- Add `no_speech_threshold` to skip silent chunks
- Consider using `condition_on_prev_tokens=True` for better chunk continuity

---

## 10. Summary of Recommendations

### For Long Audio Transcription (>30s)

1. **Use manual `generate()` calls** with custom chunking (not pipeline)
2. **Chunk parameters**: `chunk_length_s=30`, `stride_length_s=5` (chunk_length/6)
3. **Normalize timestamps** with `chunk_start_s` offset
4. **Merge text** by joining chunks, handling overlaps appropriately

### For Apple Silicon Optimization

1. **Use CoreML execution provider** with `MLComputeUnits="ALL"`
2. **Set `ModelFormat="MLProgram"`** for modern macOS
3. **Use local cache directory** (system temp) for CoreML compilation
4. **Thread configuration**: `intra_op_num_threads=0` (auto-size)
5. **Graph optimization**: `ORT_ENABLE_ALL` (except fp16 on CPU)

### Generation Parameters

1. **Language**: `None` for auto-detect, or specific code if known
2. **Task**: `"transcribe"` for same-language, `"translate"` for English output
3. **Return timestamps**: Always `True` for word-level timestamps
4. **Max tokens**: Leave unset unless you need to limit output length

### Model Selection

1. **Quantization**: Use `q4` for CPU/CoreML (best balance)
2. **Avoid fp16 on CPU**: Use `q4` or `int8` instead
3. **Use merged decoder**: Reduces memory footprint

---

## Sources

1. [ONNX Runtime CoreML Execution Provider](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
2. [Optimum ONNX Runtime Pipelines](https://huggingface.co/docs/optimum-onnx/en/onnxruntime/usage_guides/pipelines)
3. [Transformers AutomaticSpeechRecognitionPipeline](https://huggingface.co/docs/transformers/main_classes/pipelines#transformers.AutomaticSpeechRecognitionPipeline)
4. [ONNX Runtime Thread Management](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)
5. HuggingFace Community Discussions on Whisper ONNX
6. Your codebase: `apps/stt-v2/src/stt_v2/models/onnx_loader.py` and `batch_service.py`

---

## Next Steps

1. **Test chunk_length_s=30** vs current 15s to measure accuracy improvement
2. **Profile CoreML performance** vs CPU-only to quantify speedup
3. **Experiment with stride values** to optimize overlap vs computation tradeoff
4. **Consider pipeline approach** for short audio (<30s) to simplify code paths
5. **Add `no_speech_threshold`** to skip silent chunks and improve efficiency
