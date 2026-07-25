# Plan: STT Apple Silicon Performance Optimization

**Required Skill**: executing-plans

## Goal

Optimize the stt transcription pipeline to leverage Apple Silicon hardware acceleration (CoreML, MPS, Neural Engine) instead of falling back to CPU-only execution.

## Architecture Overview

Four targeted changes to the existing model loader abstraction layer: (1) enable CoreML execution provider for ONNX Whisper models, (2) use float16 for PyTorch models on MPS, (3) make ONNX thread count configurable and dynamic, (4) add MPS memory cleanup on model unload. All changes are behind platform detection guards to ensure zero regression on Linux/CUDA.

## Tech Stack

- Python 3.11+
- ONNX Runtime >= 1.23.0 (CoreML execution provider)
- PyTorch 2.8.x (MPS backend)
- Pydantic Settings (environment configuration)
- pytest / pytest-asyncio (testing)

## Best Practices from Official Documentation

### ONNX Runtime CoreML EP (source: onnxruntime.ai/docs)

1. **Provider format**: Python API requires tuple-based format: `[('CoreMLExecutionProvider', {options})]`
   not the string-based format `["CoreMLExecutionProvider"]`. This is critical for passing options.
2. **MLComputeUnits options**: `"ALL"` (CPU+GPU+ANE), `"CPUOnly"`, `"CPUAndGPU"`, `"CPUAndNeuralEngine"`.
   Use `"ALL"` for maximum performance unless power-constrained.
3. **ModelFormat**: `"MLProgram"` (iOS 15+/macOS 12+, recommended) vs `"NeuralNetwork"` (legacy default).
   MLProgram is required for latest ANE optimizations.
4. **RequireStaticInputShapes**: Set to `"0"` for Whisper models (audio length varies).
5. **EnableOnSubgraphs**: Set to `"0"` (default, safest for complex models).
6. **Model caching**: CoreML compiles ONNX → CoreML on first load (slow). Use
   `ModelCacheDirectory` to cache compiled models for faster subsequent loads.
7. **Whisper limitations**: CoreML primarily accelerates the encoder on ANE.
   The decoder with attention may partially fall back to CPU. This is still net
   positive since the encoder dominates inference time for long audio.
8. **All option values must be strings** (e.g., `"0"` not `0`, `"ALL"` not `ALL`).

### PyTorch MPS (source: pytorch.org/docs + Apple developer docs)

1. **torch.mps.empty_cache()**: Available since PyTorch 2.x. Releases unoccupied
   cached memory from the MPS allocator. Does NOT release memory still referenced
   by tensors — must `del` model/tensors first, then `gc.collect()`, then `empty_cache()`.
2. **Known MPS LSTM memory leak**: Iterative LSTM operations on MPS can leak memory
   even after `empty_cache()`. This validates our decision to keep Silero VAD
   (which uses LSTM) on CPU only.
3. **float16 on MPS**: Natively supported and ~2x faster than float32 for inference.
   Safe for Whisper encoder/decoder and Wav2Vec2 models.
4. **Device check order**: Always check `torch.backends.mps.is_built()` AND
   `torch.backends.mps.is_available()` to handle PyTorch installs without MPS support.

### ONNX Runtime Threading (source: onnxruntime.ai/docs/performance/threading)

1. **Best default**: Set `intra_op_num_threads = 0` to let ONNX Runtime auto-size
   to physical CPU core count. This is superior to hardcoding because it adapts to
   the machine.
2. **Thread spinning**: Default spinning (enabled) trades CPU power for lower
   latency. For battery-constrained Apple Silicon, consider disabling with
   `session.intra_op.allow_spinning = 0`.
3. **inter_op_num_threads**: Only effective with `execution_mode = ORT_PARALLEL`.
   For sequential models like Whisper, keep default sequential mode.
4. **P-core vs E-core**: ONNX Runtime does not currently distinguish Apple Silicon
   performance/efficiency cores. Setting threads to 0 (auto) is safest.

### HuggingFace Optimum (source: optimum docs + source code)

1. **`provider` parameter**: `ORTModel.from_pretrained()` accepts `provider` (string)
   and separately `provider_options` (dict or list of dicts). These are distinct params.
2. **`provider_options`**: Accepts `Sequence[dict[str, Any]]` or `dict[str, Any]`.
   When using CoreML, pass: `provider_options={"MLComputeUnits": "ALL", "ModelFormat": "MLProgram"}`.
3. **Session options**: Passed via `session_options` parameter (standard `ort.SessionOptions`).

---

## Task 1: Enable CoreML Execution Provider for Optimum ONNX Loader

**Priority**: Critical (main inference bottleneck)
**Estimated speedup**: 2-5x for Whisper ONNX inference on Apple Silicon

### Context

The `_load_with_optimum()` method in `onnx_loader.py` handles the primary Whisper ONNX models (e.g., `onnx-community/whisper-large-v3-turbo`). Currently, it forces `CPUExecutionProvider` on all non-CUDA platforms, completely bypassing CoreML even though ONNX Runtime ships with `CoreMLExecutionProvider` on macOS.

The CoreML execution provider dispatches operations to CPU, GPU, and Apple Neural Engine (ANE) simultaneously. With `MLComputeUnits=ALL` and `ModelFormat=MLProgram`, it can achieve significant speedups over CPU-only execution.

### Files

- Modify: `apps/stt/src/stt/models/onnx_loader.py`
- Modify: `apps/stt/tests/unit/test_onnx_loader.py` (or create if not exists)

### Steps

#### 1.1 Add CoreML detection helper to ONNXLoader

Add a static method to detect CoreML availability. This must be a separate method so it can be mocked in tests and reused by both the standard and Optimum loaders.

**File**: `apps/stt/src/stt/models/onnx_loader.py`

Add after the existing `_determine_device()` method:

```python
@staticmethod
def _is_coreml_available() -> bool:
    """Check if CoreML execution provider is available (macOS only)."""
    try:
        import onnxruntime as ort
        return "CoreMLExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False
```

#### 1.2 Update `_load_with_optimum()` to use CoreML on macOS

Replace the device/provider resolution block (lines 393-403) with CoreML-aware logic:

**Current code** (`onnx_loader.py` lines 393-403):
```python
requested_device = self._get_device(model_config.compute_type or "auto")
if requested_device == "cuda":
    provider = "CUDAExecutionProvider"
    device = "cuda"
else:
    # MPS / CPU / anything else → use CPU for ONNX Runtime
    provider = "CPUExecutionProvider"
    device = "cpu"
```

**Replace with**:
```python
requested_device = self._get_device(model_config.compute_type or "auto")
if requested_device == "cuda":
    provider = "CUDAExecutionProvider"
    device = "cuda"
elif self._is_coreml_available():
    provider = "CoreMLExecutionProvider"
    # CoreML manages its own device dispatch (CPU + GPU + ANE);
    # ONNX Runtime still reports the host device as "cpu".
    device = "cpu"
    logger.info(
        "Using CoreML execution provider for Apple Silicon acceleration "
        "(model=%s)",
        model_config.slug,
    )
else:
    provider = "CPUExecutionProvider"
    device = "cpu"
```

#### 1.3 Add CoreML provider options to the Optimum `from_pretrained` call

Optimum's `ORTModel.from_pretrained()` accepts `provider` (string) and
`provider_options` (dict) as **separate** parameters (confirmed from official docs).
CoreML options must use **string values** per the ONNX Runtime API.

Add CoreML provider options construction (after the provider is selected):

```python
# CoreML-specific configuration: use all compute units (CPU + GPU + ANE)
# and prefer the newer MLProgram format for better performance.
# Per ONNX Runtime docs: all option values MUST be strings.
coreml_provider_options: dict[str, str] = {}
if provider == "CoreMLExecutionProvider":
    settings = get_settings()
    coreml_provider_options = {
        "MLComputeUnits": "ALL",           # CPU + GPU + Neural Engine
        "ModelFormat": "MLProgram",         # Modern format (macOS 12+)
        "RequireStaticInputShapes": "0",    # Audio length varies
        "EnableOnSubgraphs": "0",           # Safest for complex models
    }
    # Cache compiled CoreML models to avoid slow re-compilation on restart.
    # CoreML compiles ONNX → CoreML on first load; caching skips this.
    coreml_cache_dir = os.path.join(settings.huggingface_cache_dir, "coreml_cache")
    os.makedirs(coreml_cache_dir, exist_ok=True)
    coreml_provider_options["ModelCacheDirectory"] = coreml_cache_dir

    logger.debug("CoreML provider options: %s", coreml_provider_options)
```

Then update the `from_pretrained_kwargs` to include the provider options.

```python
from_pretrained_kwargs: dict[str, Any] = {
    "subfolder": subfolder,
    "revision": revision,
    "cache_dir": cache_dir,
    "use_merged": True,
    "provider": provider,
    "session_options": session_options,
    **quant_kwargs,
}
if coreml_provider_options:
    from_pretrained_kwargs["provider_options"] = coreml_provider_options
if generation_config is not None:
    from_pretrained_kwargs["generation_config"] = generation_config
```

> **Note on Whisper + CoreML**: CoreML primarily accelerates the encoder on
> the Neural Engine. The decoder with cross-attention may partially fall back
> to CPU. This is still net positive since the encoder dominates inference
> time for long audio (encoder processes full audio once; decoder runs
> incrementally per token).

#### 1.4 Update standard ONNX loader to use tuple-based provider format with options

The standard ONNX loader (`_load_with_onnxruntime`) already auto-detects CoreML in
`_get_providers()` but passes no configuration. Per ONNX Runtime's official Python
API, providers with options must be specified as **tuples**: `('ProviderName', {options})`.

Refactor `_get_providers()` to return the tuple-based format:

```python
def _get_providers(self) -> list[str | tuple[str, dict[str, str]]]:
    """Get ONNX execution providers in order of preference.

    Returns providers in the format accepted by ort.InferenceSession:
    - Simple string for providers with no options: "CPUExecutionProvider"
    - Tuple for providers with options: ("CoreMLExecutionProvider", {options})

    Per ONNX Runtime docs, all option values must be strings.
    """
    try:
        import onnxruntime as ort

        available = ort.get_available_providers()
        logger.debug(f"Available ONNX providers: {available}")

        providers: list[str | tuple[str, dict[str, str]]] = []

        if "CUDAExecutionProvider" in available:
            providers.append("CUDAExecutionProvider")

        if "CoreMLExecutionProvider" in available:
            settings = get_settings()
            coreml_options: dict[str, str] = {
                "MLComputeUnits": "ALL",
                "ModelFormat": "MLProgram",
                "RequireStaticInputShapes": "0",
                "EnableOnSubgraphs": "0",
            }
            # Cache compiled CoreML models for faster subsequent loads
            coreml_cache_dir = os.path.join(
                settings.huggingface_cache_dir, "coreml_cache"
            )
            os.makedirs(coreml_cache_dir, exist_ok=True)
            coreml_options["ModelCacheDirectory"] = coreml_cache_dir
            providers.append(("CoreMLExecutionProvider", coreml_options))

        # Always include CPU as fallback (no options needed)
        providers.append("CPUExecutionProvider")
        return providers

    except Exception:
        return ["CPUExecutionProvider"]
```

The `_load_with_onnxruntime()` call to `ort.InferenceSession` does NOT need
to change — it already passes `providers=providers`, and the ONNX Runtime
`InferenceSession` constructor natively accepts mixed lists of strings and tuples.

Also remove the now-redundant `provider_options` parameter from the
`InferenceSession` call if it exists.

#### 1.5 Write unit tests

Create tests verifying:
- CoreML detected -> Optimum loader uses `CoreMLExecutionProvider`
- CoreML not available -> falls back to `CPUExecutionProvider`
- CUDA available -> CUDA takes priority over CoreML
- Standard loader passes CoreML provider options
- `_is_coreml_available()` returns correct values

```python
# Test: CoreML detection enables CoreML provider for Optimum
@pytest.mark.unit
async def test_optimum_loader_uses_coreml_when_available(mocker):
    """Optimum loader should select CoreML provider on Apple Silicon."""
    mocker.patch.object(ONNXLoader, "_is_coreml_available", return_value=True)
    mocker.patch.object(ONNXLoader, "_get_device", return_value="mps")
    # ... mock ORTModelForSpeechSeq2Seq.from_pretrained to capture kwargs
    # Assert: provider == "CoreMLExecutionProvider"
    # Assert: provider_options includes MLComputeUnits=ALL

@pytest.mark.unit
async def test_optimum_loader_falls_back_to_cpu_without_coreml(mocker):
    """Optimum loader should fall back to CPU when CoreML is unavailable."""
    mocker.patch.object(ONNXLoader, "_is_coreml_available", return_value=False)
    mocker.patch.object(ONNXLoader, "_get_device", return_value="cpu")
    # Assert: provider == "CPUExecutionProvider"

@pytest.mark.unit
async def test_cuda_takes_priority_over_coreml(mocker):
    """CUDA should be preferred over CoreML when available."""
    mocker.patch.object(ONNXLoader, "_is_coreml_available", return_value=True)
    mocker.patch.object(ONNXLoader, "_get_device", return_value="cuda")
    # Assert: provider == "CUDAExecutionProvider"
```

#### 1.6 Verify and commit

```bash
cd apps/stt
python -m pytest tests/unit/test_onnx_loader.py -v --tb=short
# Expected: all tests pass, including new CoreML tests
```

```bash
git add apps/stt/src/stt/models/onnx_loader.py apps/stt/tests/unit/test_onnx_loader.py
git commit -m "feat(stt): enable CoreML execution provider for ONNX Whisper on Apple Silicon

Add CoreML detection and configuration for both Optimum and standard ONNX
loaders. On macOS with Apple Silicon, ONNX Runtime now uses CoreML
(CPU+GPU+ANE) instead of falling back to CPU-only execution.

Ref: TASK-010"
```

---

## Task 2: Enable float16 for PyTorch Models on MPS

**Priority**: Critical
**Estimated speedup**: ~2x for Transformers inference on Apple Silicon

### Context

The `_get_torch_dtype()` method in `base_loader.py` only enables float16 when CUDA is detected. Apple Silicon MPS backend supports float16 natively and is approximately 2x faster with it compared to float32. This affects all PyTorch-based models: Transformers Whisper, Wav2Vec2, and any future PyTorch ASR models.

### Files

- Modify: `apps/stt/src/stt/models/base_loader.py`
- Modify: `apps/stt/tests/unit/test_base_loader.py` (or create if not exists)

### Steps

#### 2.1 Update `_get_torch_dtype()` to detect MPS

**File**: `apps/stt/src/stt/models/base_loader.py`

**Current code** (lines 113-135):
```python
def _get_torch_dtype(self, compute_type: str) -> Any:
    """
    Convert compute type string to torch dtype.

    Args:
        compute_type: Compute type (float16, float32, int8, auto)

    Returns:
        torch.dtype
    """
    try:
        import torch

        mapping = {
            "float16": torch.float16,
            "float32": torch.float32,
            "bfloat16": torch.bfloat16,
            "int8": torch.int8,
            "auto": torch.float16 if torch.cuda.is_available() else torch.float32,
        }
        return mapping.get(compute_type, torch.float32)
    except ImportError:
        return None
```

**Replace with**:
```python
def _get_torch_dtype(self, compute_type: str) -> Any:
    """
    Convert compute type string to torch dtype.

    Auto-detection selects float16 for GPU-capable backends:
    - CUDA: float16 (well-supported on all NVIDIA GPUs)
    - MPS: float16 (Apple Silicon GPU, natively supported, ~2x faster)
    - CPU: float32 (float16 is slower on CPU due to emulation)

    Args:
        compute_type: Compute type (float16, float32, int8, auto)

    Returns:
        torch.dtype
    """
    try:
        import torch

        def _auto_dtype() -> torch.dtype:
            if torch.cuda.is_available():
                return torch.float16
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                return torch.float16
            return torch.float32

        mapping = {
            "float16": torch.float16,
            "float32": torch.float32,
            "bfloat16": torch.bfloat16,
            "int8": torch.int8,
            "auto": _auto_dtype(),
        }
        return mapping.get(compute_type, torch.float32)
    except ImportError:
        return None
```

#### 2.2 Write unit tests

```python
@pytest.mark.unit
def test_auto_dtype_returns_float16_on_mps(mocker):
    """Auto dtype should return float16 when MPS is available."""
    import torch
    mocker.patch("torch.cuda.is_available", return_value=False)
    mocker.patch("torch.backends.mps.is_available", return_value=True)

    loader = ConcreteLoader()  # Test subclass of BaseModelLoader
    dtype = loader._get_torch_dtype("auto")
    assert dtype == torch.float16

@pytest.mark.unit
def test_auto_dtype_returns_float32_on_cpu(mocker):
    """Auto dtype should return float32 when only CPU is available."""
    import torch
    mocker.patch("torch.cuda.is_available", return_value=False)
    mocker.patch("torch.backends.mps.is_available", return_value=False)

    loader = ConcreteLoader()
    dtype = loader._get_torch_dtype("auto")
    assert dtype == torch.float32

@pytest.mark.unit
def test_auto_dtype_returns_float16_on_cuda(mocker):
    """Auto dtype should still return float16 for CUDA (no regression)."""
    import torch
    mocker.patch("torch.cuda.is_available", return_value=True)

    loader = ConcreteLoader()
    dtype = loader._get_torch_dtype("auto")
    assert dtype == torch.float16

@pytest.mark.unit
def test_explicit_float32_overrides_auto(mocker):
    """Explicit float32 request should override auto-detection."""
    import torch
    mocker.patch("torch.cuda.is_available", return_value=True)

    loader = ConcreteLoader()
    dtype = loader._get_torch_dtype("float32")
    assert dtype == torch.float32
```

#### 2.3 Verify and commit

```bash
cd apps/stt
python -m pytest tests/unit/test_base_loader.py -v --tb=short
# Expected: all tests pass
```

```bash
git add apps/stt/src/stt/models/base_loader.py apps/stt/tests/unit/test_base_loader.py
git commit -m "feat(stt): enable float16 for PyTorch models on Apple Silicon MPS

Auto-detection in _get_torch_dtype() now selects float16 for MPS in
addition to CUDA. Apple Silicon GPU natively supports float16, providing
~2x inference speedup for Transformers-based ASR models.

Ref: TASK-010"
```

---

## Task 3: Make ONNX Thread Count Configurable and Dynamic

**Priority**: Medium
**Estimated speedup**: 20-50% on high-core-count Apple Silicon chips

### Context

`intra_op_num_threads` and `inter_op_num_threads` are hardcoded to 4 in `onnx_loader.py`. Per ONNX Runtime official docs, the recommended default is `0` (auto-size to physical core count with proper thread affinity). This change replaces the hardcoded `4` with `0` (auto) and adds an `ONNX_NUM_THREADS` environment variable for manual override when needed.

### Files

- Modify: `apps/stt/src/stt/core/config/settings.py`
- Modify: `apps/stt/src/stt/models/onnx_loader.py`
- Modify: `apps/stt/.env.example`
- Modify: `apps/stt/tests/unit/test_onnx_loader.py`

### Steps

#### 3.1 Add `onnx_num_threads` to Settings

**File**: `apps/stt/src/stt/core/config/settings.py`

Add after the `inference_pool_size` field (around line 177):

```python
    # ONNX Runtime threading
    onnx_num_threads: int = Field(
        default=0,
        description=(
            "Number of threads for ONNX Runtime intra_op parallelism. "
            "0 = auto (recommended): ONNX Runtime auto-sizes to physical "
            "CPU core count with proper thread affinity. Set explicitly "
            "only if profiling shows benefit."
        ),
    )
```

#### 3.2 Add helper to resolve thread count in ONNXLoader

**File**: `apps/stt/src/stt/models/onnx_loader.py`

Per ONNX Runtime official docs: **setting `intra_op_num_threads = 0` lets the
runtime auto-size to physical CPU core count** and handle thread affinity. This
is superior to hardcoding because it adapts to the machine. However, we add a
configurable override and a sensible cap for shared workloads.

Also note: `inter_op_num_threads` only matters with `execution_mode = ORT_PARALLEL`.
Whisper is sequential, so `inter_op` can stay at 1 (default).

```python
@staticmethod
def _resolve_num_threads() -> int:
    """Resolve ONNX Runtime intra_op thread count from settings.

    Per ONNX Runtime docs, 0 means auto-size to physical CPU core count.
    This is the recommended default. We allow explicit override for
    tuning when ONNX shares CPU with CoreML or other workloads.

    Returns:
        Thread count: from settings if > 0, otherwise 0 (auto).
    """
    settings = get_settings()
    configured = settings.onnx_num_threads
    if configured > 0:
        return configured

    # 0 = let ONNX Runtime auto-size to physical core count.
    # This is the official recommended default.
    return 0
```

#### 3.3 Use dynamic thread count in `_load_with_onnxruntime()`

**File**: `apps/stt/src/stt/models/onnx_loader.py`

**Current code** (lines 73-78):
```python
session_options = ort.SessionOptions()
session_options.graph_optimization_level = (
    ort.GraphOptimizationLevel.ORT_ENABLE_ALL
)
session_options.intra_op_num_threads = 4
session_options.inter_op_num_threads = 4
```

**Replace with**:
```python
num_threads = self._resolve_num_threads()

session_options = ort.SessionOptions()
session_options.graph_optimization_level = (
    ort.GraphOptimizationLevel.ORT_ENABLE_ALL
)
session_options.intra_op_num_threads = num_threads
# inter_op_num_threads only matters with ORT_PARALLEL execution mode.
# Whisper is sequential, so leave at default (1).

logger.debug(
    "ONNX session options: intra_op_num_threads=%d (0=auto), "
    "graph_optimization=ORT_ENABLE_ALL",
    num_threads,
)
```

> **Why 0 is better than min(cpu_count, 8)**: ONNX Runtime's auto-sizing
> considers physical cores (not logical/hyperthreaded), handles Apple Silicon
> P/E core topology, and sets proper thread affinity. Hardcoding any number
> bypasses these optimizations. The manual override via `ONNX_NUM_THREADS`
> is the escape hatch for specific tuning needs.

#### 3.4 Document in .env.example

**File**: `apps/stt/.env.example`

Add after the `INFERENCE_POOL_SIZE` entry (around line 193):

```
ONNX_NUM_THREADS=0                            # [OPTIONAL] ONNX Runtime intra_op_num_threads
                                              #   0 = auto (recommended): ONNX Runtime auto-sizes to
                                              #     physical CPU core count with proper thread affinity.
                                              #     This is the official ONNX Runtime best practice.
                                              # [DEV Apple Silicon] 0 works best (adapts to P/E cores)
                                              # [PROD GPU] Keep at 0 or low (2-4), GPU handles heavy ops
                                              # [ADVANCED] Set explicitly only if profiling shows benefit
```

#### 3.5 Write unit tests

```python
@pytest.mark.unit
def test_resolve_num_threads_uses_settings_when_positive(mocker):
    """Should use settings value when ONNX_NUM_THREADS > 0."""
    mock_settings = mocker.MagicMock()
    mock_settings.onnx_num_threads = 6
    mocker.patch(
        "stt.models.onnx_loader.get_settings", return_value=mock_settings
    )
    assert ONNXLoader._resolve_num_threads() == 6

@pytest.mark.unit
def test_resolve_num_threads_returns_zero_for_auto(mocker):
    """Should return 0 (ONNX Runtime auto) when ONNX_NUM_THREADS is 0."""
    mock_settings = mocker.MagicMock()
    mock_settings.onnx_num_threads = 0
    mocker.patch(
        "stt.models.onnx_loader.get_settings", return_value=mock_settings
    )
    # 0 means let ONNX Runtime auto-size to physical core count
    assert ONNXLoader._resolve_num_threads() == 0
```

#### 3.6 Verify and commit

```bash
cd apps/stt
python -m pytest tests/unit/test_onnx_loader.py -v --tb=short
# Expected: all tests pass
```

```bash
git add apps/stt/src/stt/core/config/settings.py \
        apps/stt/src/stt/models/onnx_loader.py \
        apps/stt/.env.example \
        apps/stt/tests/unit/test_onnx_loader.py
git commit -m "feat(stt): make ONNX Runtime thread count configurable

Replace hardcoded intra_op_num_threads=4 with ONNX_NUM_THREADS setting
(default: 0 = auto). Per ONNX Runtime docs, 0 lets the runtime auto-size
to physical core count with proper thread affinity — the recommended
approach for all platforms including Apple Silicon P/E cores.

Ref: TASK-010"
```

---

## Task 4: Add MPS Memory Cleanup on Model Unload

**Priority**: Medium
**Impact**: Prevents memory growth / OOM during model cache evictions

### Context

When models are unloaded (LRU eviction, TTL expiry, or shutdown), the `HuggingFaceLoader.unload()` and `ONNXLoader.unload()` methods run garbage collection but only clear the CUDA memory cache. On Apple Silicon, the MPS backend maintains its own memory pool that grows over time if not explicitly emptied. This is especially important for the model cache which loads and unloads models frequently.

### Files

- Modify: `apps/stt/src/stt/models/base_loader.py` (new `cleanup_accelerator_memory()` utility)
- Modify: `apps/stt/src/stt/models/huggingface_loader.py`
- Modify: `apps/stt/src/stt/models/onnx_loader.py`
- Modify: `apps/stt/tests/unit/test_base_loader.py` (or create if not exists)
- Modify: `apps/stt/tests/unit/test_huggingface_loader.py` (or create if not exists)
- Modify: `apps/stt/tests/unit/test_onnx_loader.py`

### Steps

#### 4.1 Create a shared memory cleanup utility

To avoid duplicating cleanup logic across loaders, add a helper to `base_loader.py`.

**File**: `apps/stt/src/stt/models/base_loader.py`

Add at the end of the file (after the `BaseModelLoader` class):

> **Critical cleanup order** (per PyTorch docs):
> 1. `del model` / `del tensors` — release Python references
> 2. `gc.collect()` — ensure reference cycles are broken
> 3. `empty_cache()` — release the allocator's free memory pool
>
> `empty_cache()` does NOT release memory still referenced by tensors.
> Callers must `del` their model objects first.

```python
def cleanup_accelerator_memory() -> None:
    """Release GPU/accelerator memory pools after model unload.

    IMPORTANT: This must be called AFTER deleting model references and
    running gc.collect(). The empty_cache() calls only release memory
    that is no longer referenced by any tensor.

    Supports:
    - CUDA: ``torch.cuda.empty_cache()``
    - MPS (Apple Silicon): ``torch.mps.empty_cache()``
    - CPU: no-op (standard GC is sufficient)

    Safe to call on any platform — silently skips unsupported backends.
    """
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        elif hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()
    except ImportError:
        pass
    except Exception:
        # Non-critical: log but don't fail
        logger.debug("Accelerator memory cleanup skipped (non-fatal)")
```

#### 4.2 Update HuggingFaceLoader.unload() to use the shared helper

**File**: `apps/stt/src/stt/models/huggingface_loader.py`

**Current code** (lines 207-234):
```python
async def unload(self, loaded_model: LoadedModel) -> None:
    """Unload model from memory."""
    try:
        import gc

        import torch

        # Delete model components
        if loaded_model.model is not None:
            del loaded_model.model
        if loaded_model.tokenizer is not None:
            del loaded_model.tokenizer
        if loaded_model.processor is not None:
            del loaded_model.processor
        if loaded_model.feature_extractor is not None:
            del loaded_model.feature_extractor

        # Force garbage collection
        gc.collect()

        # Clear CUDA cache if available
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        logger.info(f"Unloaded model {loaded_model.model_slug}")

    except Exception as e:
        logger.warning(f"Error during model unload: {e}")
```

**Replace with**:
```python
async def unload(self, loaded_model: LoadedModel) -> None:
    """Unload model from memory."""
    try:
        import gc

        from .base_loader import cleanup_accelerator_memory

        # Delete model components
        if loaded_model.model is not None:
            del loaded_model.model
        if loaded_model.tokenizer is not None:
            del loaded_model.tokenizer
        if loaded_model.processor is not None:
            del loaded_model.processor
        if loaded_model.feature_extractor is not None:
            del loaded_model.feature_extractor

        # Force garbage collection
        gc.collect()

        # Release GPU/accelerator memory (CUDA, MPS, etc.)
        cleanup_accelerator_memory()

        logger.info(f"Unloaded model {loaded_model.model_slug}")

    except Exception as e:
        logger.warning(f"Error during model unload: {e}")
```

#### 4.3 Update ONNXLoader.unload() to use the shared helper

**File**: `apps/stt/src/stt/models/onnx_loader.py`

**Current code** (lines 125-138):
```python
async def unload(self, loaded_model: LoadedModel) -> None:
    """Unload ONNX model from memory."""
    try:
        import gc

        # ONNX sessions don't have explicit cleanup
        if loaded_model.model is not None:
            del loaded_model.model

        gc.collect()
        logger.info(f"Unloaded ONNX model {loaded_model.model_slug}")

    except Exception as e:
        logger.warning(f"Error during ONNX model unload: {e}")
```

**Replace with**:
```python
async def unload(self, loaded_model: LoadedModel) -> None:
    """Unload ONNX model from memory."""
    try:
        import gc

        from .base_loader import cleanup_accelerator_memory

        # ONNX sessions don't have explicit cleanup
        if loaded_model.model is not None:
            del loaded_model.model

        gc.collect()

        # Release GPU/accelerator memory (CUDA, MPS, etc.)
        # Relevant when CoreML or future GPU providers are used.
        cleanup_accelerator_memory()

        logger.info(f"Unloaded ONNX model {loaded_model.model_slug}")

    except Exception as e:
        logger.warning(f"Error during ONNX model unload: {e}")
```

#### 4.4 Write unit tests

```python
@pytest.mark.unit
def test_cleanup_accelerator_memory_calls_mps_empty_cache(mocker):
    """Should call torch.mps.empty_cache() on Apple Silicon."""
    mock_torch = mocker.MagicMock()
    mock_torch.cuda.is_available.return_value = False
    mock_torch.mps.empty_cache = mocker.MagicMock()
    mocker.patch.dict("sys.modules", {"torch": mock_torch})

    from stt.models.base_loader import cleanup_accelerator_memory
    cleanup_accelerator_memory()

    mock_torch.mps.empty_cache.assert_called_once()

@pytest.mark.unit
def test_cleanup_accelerator_memory_calls_cuda_on_nvidia(mocker):
    """Should call torch.cuda.empty_cache() on NVIDIA GPU (no regression)."""
    mock_torch = mocker.MagicMock()
    mock_torch.cuda.is_available.return_value = True
    mocker.patch.dict("sys.modules", {"torch": mock_torch})

    from stt.models.base_loader import cleanup_accelerator_memory
    cleanup_accelerator_memory()

    mock_torch.cuda.empty_cache.assert_called_once()

@pytest.mark.unit
def test_cleanup_accelerator_memory_noop_on_cpu(mocker):
    """Should be a no-op when only CPU is available."""
    mock_torch = mocker.MagicMock()
    mock_torch.cuda.is_available.return_value = False
    del mock_torch.mps  # Simulate no MPS attribute
    mocker.patch.dict("sys.modules", {"torch": mock_torch})

    from stt.models.base_loader import cleanup_accelerator_memory
    cleanup_accelerator_memory()  # Should not raise

@pytest.mark.unit
async def test_huggingface_unload_cleans_mps_memory(mocker):
    """HuggingFace unload should trigger MPS memory cleanup."""
    mock_cleanup = mocker.patch(
        "stt.models.huggingface_loader.cleanup_accelerator_memory"
    )
    loader = HuggingFaceLoader()
    mock_model = mocker.MagicMock(spec=LoadedModel)
    mock_model.model_slug = "test-model"

    await loader.unload(mock_model)

    mock_cleanup.assert_called_once()

@pytest.mark.unit
async def test_onnx_unload_cleans_mps_memory(mocker):
    """ONNX unload should trigger MPS memory cleanup."""
    mock_cleanup = mocker.patch(
        "stt.models.onnx_loader.cleanup_accelerator_memory"
    )
    loader = ONNXLoader()
    mock_model = mocker.MagicMock(spec=LoadedModel)
    mock_model.model_slug = "test-model"

    await loader.unload(mock_model)

    mock_cleanup.assert_called_once()
```

#### 4.5 Verify and commit

```bash
cd apps/stt
python -m pytest tests/unit/test_base_loader.py tests/unit/test_huggingface_loader.py tests/unit/test_onnx_loader.py -v --tb=short
# Expected: all tests pass
```

```bash
git add apps/stt/src/stt/models/base_loader.py \
        apps/stt/src/stt/models/huggingface_loader.py \
        apps/stt/src/stt/models/onnx_loader.py \
        apps/stt/tests/unit/test_base_loader.py \
        apps/stt/tests/unit/test_huggingface_loader.py \
        apps/stt/tests/unit/test_onnx_loader.py
git commit -m "feat(stt): add MPS memory cleanup on model unload

Add cleanup_accelerator_memory() utility that clears CUDA or MPS memory
pools after model unload. Prevents memory growth during model cache
evictions on Apple Silicon.

Ref: TASK-010"
```

---

## Execution Order and Dependencies

```
Task 1: CoreML for ONNX ──────┐
                               │
Task 2: float16 on MPS ───────┤── All independent, can be
                               │   executed in any order
Task 3: Configurable threads ──┤
                               │
Task 4: MPS memory cleanup ────┘
```

All four tasks are **independent** — they modify different methods/sections and can be implemented in any order or in parallel. The recommended order above (1→2→3→4) goes from highest impact to lowest.

## Verification Checklist

After all tasks are complete:

- [ ] `python -m pytest tests/unit/ -v --tb=short` — all unit tests pass
- [ ] On Apple Silicon Mac: verify CoreML provider is selected in logs
- [ ] On Apple Silicon Mac: verify float16 dtype in logs for Transformers models
- [ ] On Apple Silicon Mac: verify thread count shows `0 (auto)` in logs (ONNX Runtime auto-sizes)
- [ ] On Linux/CUDA: verify no regressions (CUDA still selected, float16 still used)
- [ ] On Linux/CPU: verify CPU fallback works unchanged
- [ ] `ONNX_NUM_THREADS=2 stt-worker` — verify override works via env var
- [ ] Memory monitoring: watch RSS during multiple model load/unload cycles on MPS
