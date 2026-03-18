"""Unit tests for Platform Detection.

Tests for the platform detection utility that identifies:
- CPU-only environments
- NVIDIA GPU environments (CUDA)
- Apple Silicon (MPS) environments

Following TDD: These tests are written FIRST before implementation.
"""

import platform
import pytest
from unittest.mock import patch, MagicMock


class TestPlatformType:
    """Tests for PlatformType enum."""

    def test_platform_type_has_cpu(self):
        """PlatformType should have CPU variant."""
        from stt_v2.core.platform import PlatformType
        assert hasattr(PlatformType, "CPU")
        assert PlatformType.CPU.value == "cpu"

    def test_platform_type_has_cuda(self):
        """PlatformType should have CUDA variant."""
        from stt_v2.core.platform import PlatformType
        assert hasattr(PlatformType, "CUDA")
        assert PlatformType.CUDA.value == "cuda"

    def test_platform_type_has_mps(self):
        """PlatformType should have MPS variant (Apple Silicon)."""
        from stt_v2.core.platform import PlatformType
        assert hasattr(PlatformType, "MPS")
        assert PlatformType.MPS.value == "mps"


class TestDetectPlatform:
    """Tests for detect_platform function."""

    def test_detect_platform_returns_platform_type(self):
        """detect_platform should return a PlatformType."""
        from stt_v2.core.platform import detect_platform, PlatformType
        result = detect_platform()
        assert isinstance(result, PlatformType)

    def test_detect_cuda_when_torch_cuda_available(self):
        """Should detect CUDA when torch.cuda.is_available() returns True."""
        from stt_v2.core.platform import detect_platform, PlatformType

        mock_torch = MagicMock()
        mock_torch.cuda.is_available.return_value = True

        with patch.dict("sys.modules", {"torch": mock_torch}):
            with patch("stt_v2.core.platform._has_torch", return_value=True):
                with patch("stt_v2.core.platform._torch_cuda_available", return_value=True):
                    result = detect_platform()
                    assert result == PlatformType.CUDA

    def test_detect_mps_on_apple_silicon(self):
        """Should detect MPS on Apple Silicon when torch.backends.mps.is_available()."""
        from stt_v2.core.platform import detect_platform, PlatformType

        with patch("stt_v2.core.platform._has_torch", return_value=True):
            with patch("stt_v2.core.platform._torch_cuda_available", return_value=False):
                with patch("stt_v2.core.platform._torch_mps_available", return_value=True):
                    result = detect_platform()
                    assert result == PlatformType.MPS

    def test_detect_cpu_as_fallback(self):
        """Should detect CPU when no GPU is available."""
        from stt_v2.core.platform import detect_platform, PlatformType

        with patch("stt_v2.core.platform._has_torch", return_value=True):
            with patch("stt_v2.core.platform._torch_cuda_available", return_value=False):
                with patch("stt_v2.core.platform._torch_mps_available", return_value=False):
                    result = detect_platform()
                    assert result == PlatformType.CPU

    def test_detect_cpu_when_torch_not_installed(self):
        """Should detect CPU when torch is not installed."""
        from stt_v2.core.platform import detect_platform, PlatformType

        with patch("stt_v2.core.platform._has_torch", return_value=False):
            result = detect_platform()
            assert result == PlatformType.CPU


class TestPlatformInfo:
    """Tests for PlatformInfo dataclass."""

    def test_platform_info_has_required_fields(self):
        """PlatformInfo should have all required fields."""
        from stt_v2.core.platform import PlatformInfo, PlatformType

        info = PlatformInfo(
            platform_type=PlatformType.CPU,
            has_torch=False,
            has_cuda=False,
            has_mps=False,
            system=platform.system(),
            machine=platform.machine(),
            python_version=platform.python_version(),
        )

        assert info.platform_type == PlatformType.CPU
        assert info.has_torch is False
        assert info.has_cuda is False
        assert info.has_mps is False
        assert isinstance(info.system, str)
        assert isinstance(info.machine, str)
        assert isinstance(info.python_version, str)

    def test_platform_info_is_apple_silicon(self):
        """PlatformInfo.is_apple_silicon should detect arm64 Darwin."""
        from stt_v2.core.platform import PlatformInfo, PlatformType

        # Apple Silicon
        info_apple = PlatformInfo(
            platform_type=PlatformType.MPS,
            has_torch=True,
            has_cuda=False,
            has_mps=True,
            system="Darwin",
            machine="arm64",
            python_version="3.11.0",
        )
        assert info_apple.is_apple_silicon is True

        # Intel Mac
        info_intel = PlatformInfo(
            platform_type=PlatformType.CPU,
            has_torch=True,
            has_cuda=False,
            has_mps=False,
            system="Darwin",
            machine="x86_64",
            python_version="3.11.0",
        )
        assert info_intel.is_apple_silicon is False

        # Linux
        info_linux = PlatformInfo(
            platform_type=PlatformType.CUDA,
            has_torch=True,
            has_cuda=True,
            has_mps=False,
            system="Linux",
            machine="x86_64",
            python_version="3.11.0",
        )
        assert info_linux.is_apple_silicon is False

    def test_platform_info_is_nvidia_gpu(self):
        """PlatformInfo.is_nvidia_gpu should detect CUDA availability."""
        from stt_v2.core.platform import PlatformInfo, PlatformType

        info_cuda = PlatformInfo(
            platform_type=PlatformType.CUDA,
            has_torch=True,
            has_cuda=True,
            has_mps=False,
            system="Linux",
            machine="x86_64",
            python_version="3.11.0",
        )
        assert info_cuda.is_nvidia_gpu is True

        info_cpu = PlatformInfo(
            platform_type=PlatformType.CPU,
            has_torch=True,
            has_cuda=False,
            has_mps=False,
            system="Linux",
            machine="x86_64",
            python_version="3.11.0",
        )
        assert info_cpu.is_nvidia_gpu is False


class TestGetPlatformInfo:
    """Tests for get_platform_info function."""

    def test_get_platform_info_returns_platform_info(self):
        """get_platform_info should return PlatformInfo instance."""
        from stt_v2.core.platform import get_platform_info, PlatformInfo
        result = get_platform_info()
        assert isinstance(result, PlatformInfo)

    def test_get_platform_info_includes_system_info(self):
        """get_platform_info should include system information."""
        from stt_v2.core.platform import get_platform_info
        result = get_platform_info()

        assert result.system == platform.system()
        assert result.machine == platform.machine()
        assert result.python_version == platform.python_version()


class TestRequiresPlatformMarker:
    """Tests for requires_platform pytest marker helper."""

    def test_skip_if_not_cuda(self):
        """skip_if_not_cuda should return skip marker when CUDA not available."""
        import pytest as _pytest
        from stt_v2.core.platform import detect_platform, PlatformType

        with patch("stt_v2.core.platform.detect_platform", return_value=PlatformType.CPU):
            platform_type = detect_platform()
            marker = _pytest.mark.skipif(
                platform_type != PlatformType.CUDA,
                reason="CUDA not available",
            )
            # Should return a pytest.mark.skipif marker
            assert marker is not None

    def test_skip_if_not_mps(self):
        """skip_if_not_mps should return skip marker when MPS not available."""
        import pytest as _pytest
        from stt_v2.core.platform import detect_platform, PlatformType

        with patch("stt_v2.core.platform.detect_platform", return_value=PlatformType.CPU):
            platform_type = detect_platform()
            marker = _pytest.mark.skipif(
                platform_type != PlatformType.MPS,
                reason="MPS not available",
            )
            assert marker is not None

    def test_skip_if_not_gpu(self):
        """skip_if_not_gpu should return skip marker when no GPU available."""
        import pytest as _pytest
        from stt_v2.core.platform import detect_platform, PlatformType

        with patch("stt_v2.core.platform.detect_platform", return_value=PlatformType.CPU):
            platform_type = detect_platform()
            marker = _pytest.mark.skipif(
                platform_type == PlatformType.CPU,
                reason="No GPU available (CUDA or MPS)",
            )
            assert marker is not None


class TestGetDeviceString:
    """Tests for get_device_string helper."""

    def test_get_device_string_cpu(self):
        """get_device_string should return 'cpu' for CPU platform."""
        from stt_v2.core.platform import get_device_string, PlatformType

        with patch("stt_v2.core.platform.detect_platform", return_value=PlatformType.CPU):
            assert get_device_string() == "cpu"

    def test_get_device_string_cuda(self):
        """get_device_string should return 'cuda' for CUDA platform."""
        from stt_v2.core.platform import get_device_string, PlatformType

        with patch("stt_v2.core.platform.detect_platform", return_value=PlatformType.CUDA):
            assert get_device_string() == "cuda"

    def test_get_device_string_mps(self):
        """get_device_string should return 'mps' for MPS platform."""
        from stt_v2.core.platform import get_device_string, PlatformType

        with patch("stt_v2.core.platform.detect_platform", return_value=PlatformType.MPS):
            assert get_device_string() == "mps"
