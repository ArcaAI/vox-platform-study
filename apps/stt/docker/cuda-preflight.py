"""Fail loudly when this image's CUDA kernels cannot run on the GPU it was given.

WHY THIS EXISTS (TASK-985 M-51)

`apps/stt/docker/Dockerfile` compiles whisper.cpp's CUDA backend from source for
an explicit `CMAKE_CUDA_ARCHITECTURES` list. That list is a BUILD-TIME guess
about the DEPLOY-TIME card, and until this file nothing ever checked the guess:

  * The Dockerfile's `ldd` gate proves the extension LINKED against libcudart /
    libcublas. Linkage says nothing about which GPUs the compiled kernels run on.
  * whisper.cpp does not error when asked for a GPU it has no kernel for. It
    logs `use gpu = 1` and decodes on the CPU thread pool — at which point
    realtime transcription is quietly 10x too slow while `/health/ready` is
    green, because readiness has no opinion about decode latency.

So a wrong-arch image is invisible in exactly the places an operator looks. This
turns it into a named, non-zero exit before uvicorn or dramatiq ever starts.

WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT

`/dev/nvidiactl` is the honest "a GPU was allocated to this container" signal:
the NVIDIA container runtime creates it, and no image env var can fake it
(`NVIDIA_VISIBLE_DEVICES=all` is baked into this image and is therefore true
even on a laptop with no GPU at all). When it is absent this exits 0 with a
line saying so — the image advertises CPU fallback and that path stays usable.

When it IS present, three things must hold or the container refuses to start:
  1. the CUDA driver initialises (`cuInit`), which is the assertion the finding
     asked for — a driver that cannot initialise is not a slow GPU, it is no GPU;
  2. at least one device is visible;
  3. every visible device's compute capability is covered by the architectures
     this image was actually compiled for (`STT_CUDA_ARCHITECTURES`, baked from
     the `CUDA_ARCHITECTURES` build arg).

It asserts nothing about whisper.cpp itself, on purpose: proving ggml's backend
came up means loading a model, and which model is runtime configuration that
does not exist yet at this point in the boot. Driver init plus kernel coverage
is what can be checked cheaply and is what actually fails.

Any UNEXPECTED error here is a warning, never a failure. A bug in this file must
not be able to crashloop every STT pod; it may only refuse the two conditions it
was written to recognise.
"""

from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

# CUDA driver API attribute ids (cuda.h).
_CC_MAJOR = 75
_CC_MINOR = 76

#: Created by the NVIDIA container runtime when a GPU is allocated.
_NVIDIA_CONTROL_DEVICE = Path("/dev/nvidiactl")


def _say(message: str) -> None:
    print(f"cuda-preflight: {message}", flush=True)


def _parse_architectures(raw: str) -> tuple[set[tuple[int, int]], set[tuple[int, int]]]:
    """Split a `CMAKE_CUDA_ARCHITECTURES` list into (real SASS, virtual PTX) sets.

    `86-real` embeds SASS for sm_86 only. `89-virtual` embeds PTX, which the
    driver JIT-compiles for any device at least that capable. A bare `89` means
    both. Capabilities are compared as (major, minor) so sm_120 sorts above
    sm_89 rather than below it, which a plain integer compare gets wrong.
    """
    real: set[tuple[int, int]] = set()
    virtual: set[tuple[int, int]] = set()
    for entry in raw.replace(",", ";").split(";"):
        token = entry.strip()
        if not token:
            continue
        targets = [real, virtual]
        if token.endswith("-real"):
            token, targets = token[: -len("-real")], [real]
        elif token.endswith("-virtual"):
            token, targets = token[: -len("-virtual")], [virtual]
        if not token.isdigit():
            _say(f"WARNING: ignoring unrecognised architecture entry {entry!r}")
            continue
        capability = divmod(int(token), 10)
        for target in targets:
            target.add(capability)
    return real, virtual


def _device_capabilities() -> list[tuple[int, int]]:
    """Compute capability of every visible device, via the CUDA driver API.

    ctypes against `libcuda.so.1` rather than torch: this runs on the boot path
    of every pod, and a torch import costs ~9s of wall clock to learn something
    the driver answers in microseconds. It also tests the driver directly, which
    is the layer that has to work.
    """
    driver = ctypes.CDLL("libcuda.so.1")

    status = driver.cuInit(0)
    if status != 0:
        raise RuntimeError(f"cuInit failed with CUresult {status}")

    count = ctypes.c_int()
    status = driver.cuDeviceGetCount(ctypes.byref(count))
    if status != 0:
        raise RuntimeError(f"cuDeviceGetCount failed with CUresult {status}")

    capabilities: list[tuple[int, int]] = []
    for index in range(count.value):
        device = ctypes.c_int()
        if driver.cuDeviceGet(ctypes.byref(device), index) != 0:
            raise RuntimeError(f"cuDeviceGet({index}) failed")
        major, minor = ctypes.c_int(), ctypes.c_int()
        if driver.cuDeviceGetAttribute(ctypes.byref(major), _CC_MAJOR, device) != 0:
            raise RuntimeError(f"cuDeviceGetAttribute(major, {index}) failed")
        if driver.cuDeviceGetAttribute(ctypes.byref(minor), _CC_MINOR, device) != 0:
            raise RuntimeError(f"cuDeviceGetAttribute(minor, {index}) failed")
        capabilities.append((major.value, minor.value))
    return capabilities


def _is_covered(
    capability: tuple[int, int],
    real: set[tuple[int, int]],
    virtual: set[tuple[int, int]],
) -> bool:
    if capability in real:
        return True
    return any(ptx <= capability for ptx in virtual)


def main() -> int:
    if not _NVIDIA_CONTROL_DEVICE.exists():
        _say(f"no GPU allocated ({_NVIDIA_CONTROL_DEVICE} absent) — continuing on CPU")
        return 0

    declared = os.environ.get("STT_CUDA_ARCHITECTURES", "").strip()
    if not declared:
        _say("WARNING: STT_CUDA_ARCHITECTURES is unset — cannot verify kernel coverage")
        return 0

    try:
        real, virtual = _parse_architectures(declared)
        capabilities = _device_capabilities()
    except OSError as exc:
        # libcuda.so.1 is injected by the container runtime. Missing it while
        # /dev/nvidiactl exists is a broken GPU allocation, not a CPU node.
        _say(f"FATAL: a GPU is allocated but the CUDA driver could not be loaded: {exc}")
        return 1
    except RuntimeError as exc:
        _say(f"FATAL: the CUDA driver did not initialise: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001 - a bug here must not crashloop the pod
        _say(f"WARNING: preflight could not run ({exc!r}) — continuing")
        return 0

    if not capabilities:
        _say("FATAL: a GPU is allocated but the CUDA driver reports zero devices")
        return 1

    uncovered = [cc for cc in capabilities if not _is_covered(cc, real, virtual)]
    if uncovered:
        names = ", ".join(f"sm_{major}{minor}" for major, minor in uncovered)
        _say(
            f"FATAL: this image has no runnable kernels for {names}. It was compiled for "
            f"CMAKE_CUDA_ARCHITECTURES={declared!r}. whisper.cpp would report `use gpu = 1` "
            "and decode on the CPU. Rebuild with --build-arg CUDA_ARCHITECTURES covering "
            "this card."
        )
        return 1

    present = ", ".join(f"sm_{major}{minor}" for major, minor in capabilities)
    _say(f"CUDA driver up; {present} covered by {declared}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
