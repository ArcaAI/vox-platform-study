# HOPE Python Base Image Specification & Operational Guide

**Image:** `hope-python-base`
**Dockerfile Location:** [`infrastructure/docker/python-base/Dockerfile`](file:///Users/apple/Desktop/project-hope/infrastructure/docker/python-base/Dockerfile)
**Target Environment:** Linux Container Runtime (Docker / Kubernetes, `linux/amd64` & `linux/arm64`)
**Base Distribution:** Debian Trixie (`python:3.11-slim-trixie`)
**Status:** Canonical Platform Base

---

## 1. Executive Summary

`hope-python-base` is the single shared foundation Docker image for **all Python microservices and workers** across the HOPE monorepo. It standardizes the language runtime (Python 3.11), package management tool chain (`uv`), security posture (non-root `hope` execution), and common C-runtime dependencies across both local development and production Kubernetes deployments.

### Consumer Services Matrix

| Service                      | Subsystem / Function                             | Base Role in Service Dockerfile                             |
| :--------------------------- | :----------------------------------------------- | :---------------------------------------------------------- |
| **`apps/text`**      | Multi-Provider LLM Summarization & SSE Streaming | Builder stage (`uv sync`) & Production runtime (`8862`) |
| **`apps/stt`**       | Speech-to-Text WebSocket Gateway (`stt:api`)   | Builder stage (`uv sync`) & CPU runtime (`8861`)        |
| **`apps/guardrail`** | Medical Safety & Clinical Gating Service         | Builder stage (`uv sync`) & Production runtime (`8863`) |
| **`apps/nlp`**       | Clinical MedNER, Assertion & Ontology Linking    | Builder stage (`uv sync`) & Production runtime (`8864`) |
| **`apps/harness`**   | Clinical Verification & Documentation Engine     | Builder stage (`uv sync`), API (`8865`) & Worker        |
| **`apps/tts`**       | Text-to-Speech Voice Synthesis Service           | Builder stage (`uv sync`) & Production runtime (`8866`) |

---

## 2. Core Architectural Guarantees

```
                     ┌────────────────────────────────────────────────────────┐
                     │          infrastructure/docker/python-base/            │
                     │                 (hope-python-base)                     │
                     │                                                        │
                     │  - Debian 13 (python:3.11-slim-trixie)                 │
                     │  - Pinned uv:0.11.33 package manager                   │
                     │  - Non-root user: hope (uid 1001: gid 1001)            │
                     │  - Runtime libs: libgomp1 (OpenMP) + curl              │
                     └──────────────────────────┬─────────────────────────────┘
                                                │
                 ┌──────────────────────────────┼──────────────────────────────┐
                 ▼                              ▼                              ▼
      ┌────────────────────┐         ┌────────────────────┐         ┌────────────────────┐
      │     apps/text      │         │      apps/stt      │         │  apps/guardrail    │
      │  FROM python-base  │         │  FROM python-base  │         │  FROM python-base  │
      │ (builder + prod)   │         │ (builder + runtime)│         │ (builder + prod)   │
      └────────────────────┘         └────────────────────┘         └────────────────────┘
```

1. **Dual-Stage Utility (Builder + Production in One):**
   - **As a Builder Stage (`FROM hope-python-base:latest AS builder`):** `uv` binary is present in `/bin/uv`, enabling ultra-fast `uv sync --frozen --package <svc>` from the repo root context.
   - **As a Production Stage (`FROM hope-python-base:latest AS production`):** The non-root `hope` user and shared runtime libraries exist out of the box, allowing simple venv and source copying.
2. **Unified Dependency Resolution (`uv.lock`):**
   - All Python images are built from the **monorepo root context** consuming the top-level `uv.lock`.
   - Ensures zero version drift between shared workspace packages (`packages/py-runtime-models`, `packages/py-env`, `packages/py-otel`, `packages/py-obs`, `packages/py-async-contract`) across all services.
3. **No Standalone Execution Contract:**
   - Per `tests/contracts/dockerfile-build-info.test.ts`, `hope-python-base` deliberately carries **no `CMD` or `ENTRYPOINT`** and never bakes `/app/build-info.json`.
   - It is purely an abstract base layer; each consumer service bakes its own commit metadata, ports, and execution entrypoints.

---

## 3. Image Contents & Toolchain Details

### Base Layer Composition

```dockerfile
FROM python:3.11-slim-trixie

# uv pinned to workspace lock generator version
COPY --from=ghcr.io/astral-sh/uv:0.11.33 /uv /uvx /bin/

# Runtime environment flags
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random \
    PATH="/app/.venv/bin:$PATH" \
    UV_HTTP_TIMEOUT=900
```

### Essential OS Packages

- **`libgomp1` (GNU OpenMP Runtime):** Critical dependency required by `onnxruntime`, `numpy`, and PyTorch CPU inference routines in `apps/text`, `apps/guardrail`, `apps/nlp`, and `apps/stt`. Without this, container startup crashes with `ImportError: libgomp.so.1: cannot open shared object file`.
- **`curl`:** Required for native container `HEALTHCHECK` probes (`http://localhost:<PORT>/api/v1/health/live`).

### Security & User Sandbox

- Non-root user: `hope` (`uid=1001`, `gid=1001`)
- Working directory: `/app` (owned by `hope:hope`)
- Container filesystem runs with non-privileged permissions; no container executes as `root`.

---

## 4. Build & Operations Guide

### Prerequisites

- Docker Engine 24+ or Docker Desktop
- Build executed from the **monorepo repository root**

### Build Commands

#### 1. Local Development Build (Native Architecture)

```bash
docker build -t hope-python-base:latest infrastructure/docker/python-base/
```

#### 2. Linux Server Build (`linux/amd64` Cross-Compilation on Apple Silicon)

```bash
docker build --platform linux/amd64 \
  -t hope-python-base:latest \
  infrastructure/docker/python-base/
```

#### 3. Building Consumer Services on top of `hope-python-base`

Once `hope-python-base:latest` exists locally, consumer services build against it by default:

```bash
# Example: Building Text Service
docker build --platform linux/amd64 \
  -f apps/text/Dockerfile \
  --target production \
  --build-arg BUILD_SERVICE=text \
  --build-arg BUILD_VERSION=2.0.0 \
  --build-arg BUILD_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main") \
  --build-arg BUILD_GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "local") \
  --build-arg BUILD_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t hope-text:latest .
```

---

## 5. GitLab CI/CD Pipeline Lifecycle

In `.gitlab/ci/build.yml`, the base image is governed by the `build-python-base` job:

- **Build Precedence:** `build-python-base` runs before all Python service builds (`needs:` dependency).
- **Tagging Strategy:** CI pushes the image tagged with `$REGISTRY/$CI_PROJECT_PATH/hope-python-base:$CI_COMMIT_SHA`.
- **Downstream Injection:** Downstream jobs (`build-text`, `build-stt`, `build-guardrail`, `build-nlp`, `build-harness`, `build-tts`) receive the registry tag via:
  ```yaml
  BUILD_ARGS: "--build-arg BASE_IMAGE=$REGISTRY/$CI_PROJECT_PATH/hope-python-base:$CI_COMMIT_SHA"
  ```
- **Image Lifecycle:** The base image is build-time only (`promotable: false`); it is not directly deployed to Kubernetes as a running Pod.

---

## 6. Troubleshooting & Gotchas

1. **`Distribution not found` during `uv sync`:**
   - **Root Cause:** A consumer Dockerfile failed to `COPY` one of the shared monorepo path dependencies (`packages/py-runtime-models`, `packages/py-env`, `packages/py-otel`, `packages/py-obs`, `packages/py-async-contract`) into the build context.
   - **Remedy:** Ensure all workspace path packages declared in `pyproject.toml` `[tool.uv.sources]` are copied before calling `uv sync`.
2. **`uv: download timed out (30s)` on large wheels:**
   - **Root Cause:** Default 30s read deadline in `uv` when fetching large ML wheels on slow links.
   - **Remedy:** `UV_HTTP_TIMEOUT=900` is baked into `hope-python-base` environment, providing a 15-minute tolerance.
3. **`exec format error` on Linux Server:**
   - **Root Cause:** `hope-python-base` was built on an Apple Silicon Mac without `--platform linux/amd64`.
   - **Remedy:** Rebuild both `hope-python-base` and the consumer image with `--platform linux/amd64`.
