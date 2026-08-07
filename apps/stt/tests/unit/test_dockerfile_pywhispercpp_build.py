"""Regression tests for the STT CUDA pywhispercpp image-build contract."""

from pathlib import Path

DOCKERFILE = Path(__file__).parents[2] / "docker" / "Dockerfile"


def _dockerfile_text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def test_pywhispercpp_build_passes_static_cuda_settings_through_cmake_args() -> None:
    dockerfile = _dockerfile_text()

    assert 'CMAKE_ARGS="-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89' in dockerfile
    assert "-DBUILD_SHARED_LIBS=OFF" in dockerfile
    assert "-DCMAKE_POSITION_INDEPENDENT_CODE=ON" in dockerfile


def test_pywhispercpp_verification_checks_native_dependencies_in_driverless_builder() -> None:
    dockerfile = _dockerfile_text()
    verification_start = dockerfile.index("# Build-time gate.")
    verification = dockerfile[verification_start:]

    extension_lookup = verification.index("find /opt/venv/lib/python3.11/site-packages")
    native_check = verification.index('ldd "$ext"')

    assert extension_lookup < native_check
    assert "libwhisper.so" in verification
    assert 'grep -qiE "libcudart|libcublas"' in verification
    assert 'import _pywhispercpp' not in verification
