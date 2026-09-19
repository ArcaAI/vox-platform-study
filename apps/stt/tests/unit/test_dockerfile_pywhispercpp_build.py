"""Regression tests for the STT CUDA pywhispercpp image-build contract."""

import re
from pathlib import Path

DOCKERFILE = Path(__file__).parents[2] / "docker" / "Dockerfile"


def _dockerfile_text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def test_pywhispercpp_build_passes_static_cuda_settings_through_cmake_args() -> None:
    dockerfile = _dockerfile_text()

    assert (
        'CMAKE_ARGS="-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCHITECTURES}' in dockerfile
    )
    assert "-DBUILD_SHARED_LIBS=OFF" in dockerfile
    assert "-DCMAKE_POSITION_INDEPENDENT_CODE=ON" in dockerfile


def test_default_cuda_architectures_cover_every_card_we_deploy_on() -> None:
    """The arch list used to be the single value `89`, which is a silent CPU decode elsewhere.

    whisper.cpp does not error when asked for a GPU it has no kernel for — it logs
    `use gpu = 1` and runs on the CPU thread pool. So a card missing from this
    list is not a build failure, it is a 10x latency regression nothing reports.
    Both cards HOPE targets must stay in the default (TASK-985 M-51).
    """
    match = re.search(r'^ARG CUDA_ARCHITECTURES="([^"]+)"', _dockerfile_text(), re.MULTILINE)
    assert match, "the CUDA architecture list must be a build arg with a default"
    declared = match.group(1)

    assert "86-real" in declared, "sm_86 = A10G, the AWS plan's g5 instance"
    assert "89-real" in declared, "sm_89 = the RTX 2000 Ada on VM 200"


def test_pywhispercpp_verification_checks_native_dependencies_in_driverless_builder() -> None:
    dockerfile = _dockerfile_text()
    verification_start = dockerfile.index("# Build-time gate")
    verification = dockerfile[verification_start:]

    extension_lookup = verification.index("find /opt/venv/lib/python3.11/site-packages")
    native_check = verification.index('ldd "$ext"')

    assert extension_lookup < native_check
    assert "libwhisper.so" in verification
    assert 'grep -qiE "libcudart|libcublas"' in verification
    assert "import _pywhispercpp" not in verification


def test_the_gate_also_checks_which_kernels_were_compiled_in() -> None:
    """`ldd` proves linkage; only cuobjdump proves the kernels match the deploy card."""
    verification = _dockerfile_text()

    assert "cuobjdump" in verification and "--list-elf" in verification, (
        "the build gate must inspect the embedded SASS images — an sm_89-only "
        "extension links perfectly on an sm_86 card and then decodes on the CPU."
    )


def test_the_source_build_refreshes_uvs_cached_wheel() -> None:
    """uv keys its built-wheel cache on the source, not on CMAKE_ARGS.

    Without `--refresh-package`, widening `CUDA_ARCHITECTURES` re-runs the RUN
    layer and uv still returns the wheel a previous pipeline compiled for the
    OLD architecture list — which is how the first `86-real;...` build shipped an
    sm_89-only extension. `--reinstall-package` reinstalls FROM the cache and
    does not help.
    """
    dockerfile = _dockerfile_text()
    install_start = dockerfile.index("CMAKE_ARGS=\"-DGGML_CUDA=ON")
    install = dockerfile[install_start : dockerfile.index("# Build-time gate")]

    assert "--refresh-package pywhispercpp" in install
