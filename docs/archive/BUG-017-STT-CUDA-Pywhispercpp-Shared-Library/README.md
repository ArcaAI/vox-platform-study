# BUG-017 — STT CUDA pywhispercpp build leaves unresolved libwhisper.so.1

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `bugfix` |
| **Branch** | `dev-2.1` |
| **Discovered** | 2026-08-03, GitLab Docker build of the STT ML image |
| **Severity** | High — the STT CUDA ML and worker images cannot be built or released |
| **Affected apps/packages** | `apps/stt/docker/Dockerfile`, STT CUDA builder stage |
| **Related tickets** | BUG-011, BUG-015, BUG-016; the failure is in the CUDA/whisper.cpp build path added by the current Dockerfile refactor |

---

## Requirement Analysis

The GitLab build must produce the `ml-runtime` and `worker` STT images. The CUDA-enabled `pywhispercpp` extension must be packaged without a transient `libwhisper.so.1` dependency and must link to CUDA runtime libraries so it can load and use the GPU when the NVIDIA Kubernetes runtime supplies `libcuda.so.1`. The whisper.cpp path must not silently fall back to CPU execution.

Observed failure:

```text
ImportError: libwhisper.so.1: cannot open shared object file: No such file or directory
```

The failure occurs in the Dockerfile verification step while importing `_pywhispercpp`, before the existing CUDA-link assertion can run.

## Current State Evaluation

At commit `95a961e4c`, `apps/stt/docker/Dockerfile` compiled `pywhispercpp` from the pinned `v1.5.0` source and set the CUDA/static-link options only as inline environment variables. The subsequent verification imported `_pywhispercpp` inside the driverless CUDA builder, so it failed first on `libwhisper.so.1` and, after static-linking, would also fail on the expected missing `libcuda.so.1` driver.

The upstream v1.5.0 build passes CMake definitions through `CMAKE_ARGS`. Its bundled whisper.cpp defaults to shared libraries and emits `libwhisper.so.1`. The deployed `stt-v2` pod already requests `nvidia.com/gpu: 1`, uses `runtimeClassName: nvidia`, and the loader passes `context_params={"use_gpu": True}` for an `auto` device. The image therefore needs to carry a statically linked whisper/ggml extension with dynamic CUDA runtime dependencies; the cluster supplies the driver library at runtime.

External research:

- pywhispercpp v1.5.0 setup.py: `CMAKE_ARGS` is the documented CMake override channel; the package build otherwise uses the upstream shared-library default.
- whisper.cpp at the pinned submodule revision: `BUILD_SHARED_LIBS` controls whether the `whisper` target is static or shared.
- CMake documentation: `BUILD_SHARED_LIBS=OFF` makes library targets without an explicit type static, provided the option is present before dependent subdirectories configure.
- pywhispercpp issue #170 reports the same v1.5.0 `libwhisper.so.1` failure for direct source installation.

## Implementation Plan

### TDD / regression checks

1. Add a static Dockerfile regression test that asserts the pywhispercpp build command passes `-DBUILD_SHARED_LIBS=OFF` and `-DCMAKE_POSITION_INDEPENDENT_CODE=ON` through `CMAKE_ARGS`, not only as shell environment variables.
2. Assert the verification block discovers the extension from site-packages without importing it first, runs `ldd`, rejects any `libwhisper.so` dependency, and verifies CUDA runtime linkage without requiring the host driver.
3. Run the regression test before the implementation to record RED, then make the minimal Dockerfile change and rerun for GREEN.

### File modification order

1. `apps/stt/tests/unit/test_dockerfile_pywhispercpp_build.py` — regression test for the Dockerfile build contract.
2. `apps/stt/docker/Dockerfile` — pass explicit CMake arguments and harden the verification sequence.
3. This README — implementation summary, evidence, and change history.

### Verification criteria

- The Dockerfile regression test passes.
- The `ml-builder` target builds through the pywhispercpp verification step when Docker/buildx and the required network/cache are available.
- The verification output shows `_pywhispercpp` has no unresolved `libwhisper.so.1` and has a CUDA runtime dependency.
- The repository’s actual STT test script is `pnpm stt:test:unit` (not `pnpm py:stt:test`); it could not run because this host has no `conda`/`arcaenv`. The isolated Dockerfile regression test passed.
- No unrelated files are changed and the ticket documents actual command output.

## Implementation Summary

- Changed the `pywhispercpp` source build to pass `GGML_CUDA`, the pinned CUDA architecture, `BUILD_SHARED_LIBS=OFF`, and PIC through explicit `CMAKE_ARGS`. This makes whisper/ggml static while retaining dynamic CUDA runtime linkage.
- Replaced the builder-time Python import with an `ldd` gate. The builder has no NVIDIA driver by design, so it now verifies that the extension exists, has no `libwhisper.so` dependency that would be lost when only `/opt/venv` is copied, and links `libcudart`/`libcublas`.
- The resulting `ml-runtime` image remains compatible with the existing Kubernetes `stt-v2` GPU configuration: `runtimeClassName: nvidia`, `nvidia.com/gpu: 1`, and `NVIDIA_VISIBLE_DEVICES=all`. At runtime the NVIDIA container runtime supplies `libcuda.so.1`; the STT loader requests `use_gpu=True` for `device=auto`.
- Deployment audit found that `stt-v2-worker` does not request a GPU, while `stt-v2` does. That allocation was intentionally not changed here because the deployment repository documents a single-GPU cluster and assigning the same GPU to both workloads would make one unschedulable. If GGUF inference is routed to the worker rather than the API pod, the deployment needs an explicit GPU ownership decision.

### Verification evidence

- TDD RED: `PYTHONPATH=apps/stt/src pytest -c /dev/null -q apps/stt/tests/unit/test_dockerfile_pywhispercpp_build.py` → `2 failed` before the Dockerfile change.
- TDD GREEN: same command after the change → `2 passed in 0.03s`.
- `docker buildx build --progress=plain --target ml-builder -f apps/stt/docker/Dockerfile .` → latest run exported successfully (`#33 DONE 0.0s`, cached); the uncached gate output showed `libcudart.so.12`, `libcublas.so.12`, and no `libwhisper.so.1`. `libcuda.so.1 => not found` was expected in the driverless builder.
- `docker buildx build --progress=plain --target ml-runtime -f apps/stt/docker/Dockerfile .` → exported successfully (`#40 DONE 35.1s`).
- `docker buildx build --progress=plain --target worker -f apps/stt/docker/Dockerfile .` → exported successfully (`#42 DONE 0.1s`, fully cached after the ml-runtime build).
- `git diff --check` → passed.
- Existing `test_whisper_cpp_loader.py` could not collect on the host because the host Python lacks the STT dependency environment (`ModuleNotFoundError: No module named 'azure'`). `uv run` was also blocked by a pre-existing root `pyproject.toml` parse error at the `conflicts` table (line 63).

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-08-03 | implementation agent | Ticket created from the GitLab failure at Dockerfile line 250; exploration identified an unresolved shared whisper.cpp library in the source-install verification path. |
| 2026-08-03 | implementation agent | Implemented and verified the explicit CMake static-link/CUDA build contract and driverless `ldd` gate. `ml-builder` and `ml-runtime` builds pass; status moved to `Review`. |
