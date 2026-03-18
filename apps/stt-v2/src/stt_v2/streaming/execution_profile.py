"""Hardware auto-detection and adaptive execution profiles.

Extends the existing ``stt_v2.core.platform`` module with streaming-specific
tuning parameters that adapt to the detected hardware. All values can be
overridden via environment variables through ``Settings``.

Supported hardware profiles:
- A100 / H100 80 GB (production)
- Apple Silicon 48 GB (development)
- RTX A2000 16 GB (development)
- 2x RTX A2000 16 GB (staging, multi-GPU)
- CPU 96-core 256 GB (CI / fallback)
"""

from __future__ import annotations

from dataclasses import dataclass

import psutil
import structlog

from stt_v2.core.config.settings import get_settings
from stt_v2.core.platform import PlatformType, detect_platform

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# ExecutionProfile dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExecutionProfile:
    """Hardware-adaptive execution configuration.

    Auto-detected at startup via :func:`detect_execution_profile`, then
    optionally overridden by environment-variable settings.
    """

    # Identity
    platform: PlatformType
    device_name: str
    gpu_count: int
    total_vram_gb: float
    total_ram_gb: float
    cpu_cores: int

    # Inference tuning
    asr_device: str  # "cuda:0", "mps", "cpu"
    asr_compute_type: str  # "float16", "int8", "float32"
    asr_max_batch_size: int  # 32 / 8 / 4 / 2
    asr_model_quantization: str  # "fp16" / "q4"

    # Embedding tuning
    embedding_device: str  # "cuda:1", "cpu", "mps"
    embedding_batch_size: int

    # Preprocessing tuning
    preprocess_pool_size: int  # ThreadPoolExecutor workers
    denoise_enabled_default: bool

    # Streaming tuning
    max_concurrent_streams: int
    batch_scheduler_max_wait_ms: int
    vad_silence_threshold_ms: int

    # Multi-GPU
    multi_gpu_strategy: str  # "replicate", "split", "none"


# ---------------------------------------------------------------------------
# GPU introspection helpers
# ---------------------------------------------------------------------------


def _get_cuda_gpu_count() -> int:
    """Return the number of available CUDA GPUs, or 0 if unavailable."""
    try:
        import torch

        return torch.cuda.device_count()
    except (ImportError, Exception):
        return 0


def _get_cuda_vram_gb(device_index: int = 0) -> float:
    """Return total VRAM in GB for the given CUDA device, or 0."""
    try:
        import torch

        if not torch.cuda.is_available() or device_index >= torch.cuda.device_count():
            return 0.0
        props = torch.cuda.get_device_properties(device_index)
        return round(props.total_mem / (1024**3), 1)
    except (ImportError, Exception):
        return 0.0


def _get_total_cuda_vram_gb() -> float:
    """Return aggregate VRAM across all CUDA GPUs."""
    try:
        import torch

        if not torch.cuda.is_available():
            return 0.0
        total = 0.0
        for i in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(i)
            total += props.total_mem / (1024**3)
        return round(total, 1)
    except (ImportError, Exception):
        return 0.0


def _get_cuda_device_name(device_index: int = 0) -> str:
    """Return the CUDA device name string, or empty string."""
    try:
        import torch

        if not torch.cuda.is_available() or device_index >= torch.cuda.device_count():
            return ""
        return torch.cuda.get_device_name(device_index)
    except (ImportError, Exception):
        return ""


def _get_mps_unified_memory_gb() -> float:
    """Estimate unified memory on Apple Silicon.

    Apple does not expose VRAM separately; we use total system RAM as a
    proxy because MPS shares the unified memory pool.
    """
    return round(psutil.virtual_memory().total / (1024**3), 1)


# ---------------------------------------------------------------------------
# Profile detection
# ---------------------------------------------------------------------------


def _build_a100_h100_profile(
    gpu_count: int, total_vram_gb: float, device_name: str
) -> ExecutionProfile:
    """A100 80 GB / H100 — production profile."""
    return ExecutionProfile(
        platform=PlatformType.CUDA,
        device_name=device_name,
        gpu_count=gpu_count,
        total_vram_gb=total_vram_gb,
        total_ram_gb=round(psutil.virtual_memory().total / (1024**3), 1),
        cpu_cores=psutil.cpu_count(logical=False) or 1,
        asr_device="cuda:0",
        asr_compute_type="float16",
        asr_max_batch_size=32,
        asr_model_quantization="fp16",
        embedding_device="cuda:0",
        embedding_batch_size=16,
        preprocess_pool_size=16,
        denoise_enabled_default=True,
        max_concurrent_streams=100,
        batch_scheduler_max_wait_ms=1000,
        vad_silence_threshold_ms=500,
        multi_gpu_strategy="none",
    )


def _build_multi_gpu_profile(
    gpu_count: int, total_vram_gb: float, device_name: str
) -> ExecutionProfile:
    """Multi-GPU (e.g. 2x RTX A2000 16 GB) — staging profile."""
    return ExecutionProfile(
        platform=PlatformType.CUDA,
        device_name=device_name,
        gpu_count=gpu_count,
        total_vram_gb=total_vram_gb,
        total_ram_gb=round(psutil.virtual_memory().total / (1024**3), 1),
        cpu_cores=psutil.cpu_count(logical=False) or 1,
        asr_device="cuda:0",
        asr_compute_type="float16",
        asr_max_batch_size=8,
        asr_model_quantization="q4",
        embedding_device="cuda:1",
        embedding_batch_size=8,
        preprocess_pool_size=12,
        denoise_enabled_default=True,
        max_concurrent_streams=40,
        batch_scheduler_max_wait_ms=800,
        vad_silence_threshold_ms=500,
        multi_gpu_strategy="split",
    )


def _build_rtx_a2000_profile(device_name: str, vram_gb: float) -> ExecutionProfile:
    """RTX A2000 16 GB (single GPU) — development profile."""
    return ExecutionProfile(
        platform=PlatformType.CUDA,
        device_name=device_name,
        gpu_count=1,
        total_vram_gb=vram_gb,
        total_ram_gb=round(psutil.virtual_memory().total / (1024**3), 1),
        cpu_cores=psutil.cpu_count(logical=False) or 1,
        asr_device="cuda:0",
        asr_compute_type="float16",
        asr_max_batch_size=8,
        asr_model_quantization="q4",
        embedding_device="cpu",
        embedding_batch_size=4,
        preprocess_pool_size=8,
        denoise_enabled_default=True,
        max_concurrent_streams=20,
        batch_scheduler_max_wait_ms=800,
        vad_silence_threshold_ms=500,
        multi_gpu_strategy="none",
    )


def _build_apple_silicon_profile(unified_memory_gb: float) -> ExecutionProfile:
    """Apple Silicon (M-series) with unified memory — development profile."""
    # Scale streams with available unified memory
    if unified_memory_gb >= 48:
        max_streams = 15
        batch_size = 4
    elif unified_memory_gb >= 32:
        max_streams = 10
        batch_size = 4
    else:
        max_streams = 5
        batch_size = 2

    return ExecutionProfile(
        platform=PlatformType.MPS,
        device_name=f"MPS ({unified_memory_gb:.0f}GB unified)",
        gpu_count=1,
        total_vram_gb=unified_memory_gb,  # unified memory
        total_ram_gb=unified_memory_gb,
        cpu_cores=psutil.cpu_count(logical=False) or 1,
        asr_device="mps",
        asr_compute_type="float16",
        asr_max_batch_size=batch_size,
        asr_model_quantization="q4",
        embedding_device="mps",
        embedding_batch_size=4,
        preprocess_pool_size=min(8, psutil.cpu_count(logical=False) or 4),
        denoise_enabled_default=True,
        max_concurrent_streams=max_streams,
        batch_scheduler_max_wait_ms=1500,
        vad_silence_threshold_ms=500,
        multi_gpu_strategy="none",
    )


def _build_cpu_profile() -> ExecutionProfile:
    """CPU-only profile (CI / fallback)."""
    cores = psutil.cpu_count(logical=False) or 1
    ram_gb = round(psutil.virtual_memory().total / (1024**3), 1)

    # Scale with available cores
    if cores >= 64:
        max_streams = 50
        pool_size = 32
    elif cores >= 32:
        max_streams = 25
        pool_size = 16
    elif cores >= 16:
        max_streams = 10
        pool_size = 8
    else:
        max_streams = 5
        pool_size = max(2, cores)

    return ExecutionProfile(
        platform=PlatformType.CPU,
        device_name=f"CPU ({cores} cores, {ram_gb:.0f}GB RAM)",
        gpu_count=0,
        total_vram_gb=0.0,
        total_ram_gb=ram_gb,
        cpu_cores=cores,
        asr_device="cpu",
        asr_compute_type="float32",
        asr_max_batch_size=2,
        asr_model_quantization="q4",
        embedding_device="cpu",
        embedding_batch_size=8,
        preprocess_pool_size=pool_size,
        denoise_enabled_default=False,  # too slow on CPU for real-time
        max_concurrent_streams=max_streams,
        batch_scheduler_max_wait_ms=2000,
        vad_silence_threshold_ms=500,
        multi_gpu_strategy="none",
    )


# ---------------------------------------------------------------------------
# Main detection function
# ---------------------------------------------------------------------------


def detect_execution_profile() -> ExecutionProfile:
    """Auto-detect hardware and return an appropriate ExecutionProfile.

    Detection order:
    1. CUDA with high VRAM (>= 40 GB) -> A100 / H100 production profile
    2. CUDA multi-GPU (>= 2 GPUs) -> multi-GPU staging profile
    3. CUDA single GPU (< 40 GB) -> RTX A2000-class dev profile
    4. MPS (Apple Silicon) -> Apple Silicon dev profile
    5. CPU-only -> CPU fallback profile

    After detection, environment-variable overrides from ``Settings`` are
    applied for fields where the user explicitly set a non-zero / non-auto
    value.

    Returns:
        A fully-populated ``ExecutionProfile``.
    """
    platform_type = detect_platform()
    settings = get_settings()

    # --- CUDA ---
    if platform_type == PlatformType.CUDA:
        gpu_count = _get_cuda_gpu_count()
        total_vram = _get_total_cuda_vram_gb()
        primary_vram = _get_cuda_vram_gb(0)
        device_name = _get_cuda_device_name(0)

        if primary_vram >= 40:
            profile = _build_a100_h100_profile(gpu_count, total_vram, device_name)
        elif gpu_count >= 2:
            profile = _build_multi_gpu_profile(gpu_count, total_vram, device_name)
        else:
            profile = _build_rtx_a2000_profile(device_name, primary_vram)

    # --- MPS (Apple Silicon) ---
    elif platform_type == PlatformType.MPS:
        unified_mem = _get_mps_unified_memory_gb()
        profile = _build_apple_silicon_profile(unified_mem)

    # --- CPU fallback ---
    else:
        profile = _build_cpu_profile()

    # --- Apply environment-variable overrides ---
    profile = _apply_settings_overrides(profile, settings)

    logger.info(
        "Execution profile detected",
        platform=profile.platform.value,
        device_name=profile.device_name,
        gpu_count=profile.gpu_count,
        total_vram_gb=profile.total_vram_gb,
        max_concurrent_streams=profile.max_concurrent_streams,
        asr_device=profile.asr_device,
        asr_max_batch_size=profile.asr_max_batch_size,
        embedding_device=profile.embedding_device,
        multi_gpu_strategy=profile.multi_gpu_strategy,
    )

    return profile


def _apply_settings_overrides(
    profile: ExecutionProfile, settings: object
) -> ExecutionProfile:
    """Override auto-detected profile values with explicit settings.

    Only non-zero / non-``auto`` values in ``Settings`` take effect,
    allowing selective overrides while keeping auto-detected defaults.
    """
    overrides: dict[str, object] = {}

    max_concurrent = getattr(settings, "streaming_max_concurrent", 0)
    if max_concurrent > 0:
        overrides["max_concurrent_streams"] = max_concurrent

    max_batch = getattr(settings, "streaming_max_batch_size", 0)
    if max_batch > 0:
        overrides["asr_max_batch_size"] = max_batch

    batch_wait = getattr(settings, "streaming_batch_wait_ms", 0)
    if batch_wait > 0:
        overrides["batch_scheduler_max_wait_ms"] = batch_wait

    embed_dev = getattr(settings, "streaming_embedding_device", "auto")
    if embed_dev and embed_dev.lower() != "auto":
        overrides["embedding_device"] = embed_dev

    multi_gpu = getattr(settings, "streaming_multi_gpu_strategy", "auto")
    if multi_gpu and multi_gpu.lower() != "auto":
        overrides["multi_gpu_strategy"] = multi_gpu

    if not overrides:
        return profile

    # frozen dataclass — rebuild with overrides
    fields = {f.name: getattr(profile, f.name) for f in profile.__dataclass_fields__.values()}
    fields.update(overrides)
    return ExecutionProfile(**fields)
