"""Platform Detection Utility.

Detects the compute platform (CPU, CUDA, MPS) for optimal model execution.
Supports:
- CPU-only environments
- NVIDIA GPU environments (CUDA)
- Apple Silicon (MPS) environments

Usage:
    from stt_v2.core.platform import detect_platform, get_platform_info, PlatformType

    platform_type = detect_platform()
    if platform_type == PlatformType.CUDA:
        # Use CUDA-optimized code
        pass

    info = get_platform_info()
    if info.is_apple_silicon:
        # Apple Silicon specific handling
        pass
"""

from dataclasses import dataclass
from enum import Enum
import platform
from typing import Optional


class PlatformType(Enum):
    """Supported compute platforms."""

    CPU = "cpu"
    CUDA = "cuda"
    MPS = "mps"


def _has_torch() -> bool:
    """Check if PyTorch is installed."""
    try:
        import torch  # noqa: F401

        return True
    except ImportError:
        return False


def _torch_cuda_available() -> bool:
    """Check if CUDA is available via PyTorch."""
    try:
        import torch

        return torch.cuda.is_available()
    except ImportError:
        return False


def _torch_mps_available() -> bool:
    """Check if MPS (Apple Silicon) is available via PyTorch."""
    try:
        import torch

        return hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    except ImportError:
        return False


def detect_platform() -> PlatformType:
    """Detect the current compute platform.

    Returns:
        PlatformType: The detected platform (CPU, CUDA, or MPS).

    Detection order:
        1. CUDA (NVIDIA GPU) - if torch.cuda.is_available()
        2. MPS (Apple Silicon) - if torch.backends.mps.is_available()
        3. CPU - fallback
    """
    if not _has_torch():
        return PlatformType.CPU

    if _torch_cuda_available():
        return PlatformType.CUDA

    if _torch_mps_available():
        return PlatformType.MPS

    return PlatformType.CPU


@dataclass
class PlatformInfo:
    """Detailed platform information."""

    platform_type: PlatformType
    has_torch: bool
    has_cuda: bool
    has_mps: bool
    system: str
    machine: str
    python_version: str
    cuda_version: Optional[str] = None
    torch_version: Optional[str] = None

    @property
    def is_apple_silicon(self) -> bool:
        """Check if running on Apple Silicon."""
        return self.system == "Darwin" and self.machine == "arm64"

    @property
    def is_nvidia_gpu(self) -> bool:
        """Check if NVIDIA GPU is available."""
        return self.has_cuda


def get_platform_info() -> PlatformInfo:
    """Get detailed platform information.

    Returns:
        PlatformInfo: Detailed information about the current platform.
    """
    has_torch = _has_torch()
    has_cuda = _torch_cuda_available()
    has_mps = _torch_mps_available()

    cuda_version = None
    torch_version = None

    if has_torch:
        try:
            import torch

            torch_version = torch.__version__
            if has_cuda:
                cuda_version = torch.version.cuda
        except ImportError:
            pass

    return PlatformInfo(
        platform_type=detect_platform(),
        has_torch=has_torch,
        has_cuda=has_cuda,
        has_mps=has_mps,
        system=platform.system(),
        machine=platform.machine(),
        python_version=platform.python_version(),
        cuda_version=cuda_version,
        torch_version=torch_version,
    )


def get_device_string() -> str:
    """Get the device string for PyTorch.

    Returns:
        str: Device string ('cpu', 'cuda', or 'mps').
    """
    return detect_platform().value


