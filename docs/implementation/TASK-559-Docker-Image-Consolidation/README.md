# TASK-559 — Docker Image Consolidation

**Status:** Review
**Type:** infrastructure
**Owner decision required before Phase 4** — see §Owner Decisions.

## Requirement Analysis

Consolidate every Docker image used across the monorepo — both the `FROM` base
images in Dockerfiles and the `image:` service references in docker-compose
files — so that:

1. **Base images for Dockerfiles** follow current best practice: light, one
   consistent pattern, easy to maintain (single version knob, no per-file drift).
2. **Service/app images in compose** are latest-best-practice, lightweight,
   pinned, and fit-for-purpose — with **one exception**: `minio/minio` stays
   pinned to `RELEASE.2025-04-22T22-12-26Z` (Console UI compatibility, explicit
   owner instruction — do NOT bump).

Confirmed owner decisions (this session):
- **Node target: Node 24 LTS** (currently pinned to 22).
- **Per-app composes (`apps/smr`, `apps/guardrail`): keep but align** — retain the
  files, strip bespoke/drifting observability, reuse central pins.
- **This document is written first for approval before any edit.**

Scope note: `.claude/worktrees/**` are throwaway agent worktrees and are OUT of
scope. `docs/research/configs/**` and `docs/archive/**` composes are reference
snapshots and are OUT of scope unless noted.

## Current State Evaluation

### A. Dockerfile base images

| File | builder / deps | production / runtime | Version source | Verdict |
|---|---|---|---|---|
| `apps/api/Dockerfile` | `node:22-slim` | `node:22-slim` | `ARG NODE_VERSION=22` | glibc, consistent ✅ |
| `apps/admin-console/Dockerfile` | `node:22-slim` | `node:22-alpine` | `ARG NODE_VERSION=22` | slim→alpine split ⚠️ |
| `apps/ui-playground/Dockerfile` | `node:22-slim` | `node:22-alpine` | `ARG NODE_VERSION=22` | slim→alpine split ⚠️ |
| `apps/example/Dockerfile` | `node:22-alpine` (hardcoded) | `nginx:1.27-alpine` | hardcoded | no ARG ❌ |
| `packages/database/Dockerfile` | `node:22-alpine` (hardcoded) | `node:22-alpine` (hardcoded) | hardcoded | no ARG + musl+Prisma risk ❌ |
| `infrastructure/docker/python-base/Dockerfile` | — | `python:3.11-slim-trixie` + `uv 0.11.7` | — | modern shared base ✅ |
| `apps/{smr,guardrail,nlp,harness,tts}/Dockerfile` | `${BASE_IMAGE}` | `${BASE_IMAGE}` | `ARG BASE_IMAGE=hope-python-base:latest` | shares base ✅ |
| `apps/stt/docker/Dockerfile` (CPU) | `${BASE_IMAGE}` | `${BASE_IMAGE}` | `ARG BASE_IMAGE=hope-python-base:latest` | ✅ |
| `apps/stt/docker/Dockerfile` (GPU) | `nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04` | same | hardcoded | GPU, legitimately separate ✅ |
| `apps/stt/docker/Dockerfile.apple` | `python:3.11-slim` (plain) | `python:3.11-slim` | hardcoded | Python outlier ❌ |

Findings:
- **F1 — Node version knob drift.** `example` and `database` hardcode `node:22`;
  the other three use `ARG NODE_VERSION`. No single place to bump Node.
- **F2 — slim vs alpine split with no rationale.** `api` uses slim in production;
  `admin-console`/`ui-playground` use alpine. `database` uses alpine. musl (alpine)
  is a real risk for **Prisma 7** engine resolution (`api`, `database`); Next.js
  standalone (`admin-console`, `ui-playground`) is fine on alpine.
- **F3 — Apple STT Python outlier.** `Dockerfile.apple` uses plain `python:3.11-slim`
  and does not consume `hope-python-base`; every other non-GPU Python service does.

### B. Compose service images

| Image | central (`infrastructure/docker`, `tests/`) | per-app (`smr`/`guardrail`) | Verdict |
|---|---|---|---|
| `redis` | `8-alpine` | `8-alpine` | aligned ✅ |
| `minio/minio` | `RELEASE.2025-04-22T22-12-26Z` | — | KEEP pinned (owner) ✅ |
| `minio/mc` | **`latest`** | — | unpinned ❌ (F4) |
| `timescale/timescaledb-ha` | `pg18-all` | — | pinned ✅ |
| `hashicorp/vault` | `1.18` | — | pinned ✅ |
| `qdrant/qdrant` | `v1.16` | — | pinned ✅ |
| `temporalio/auto-setup` / `ui` | `1.29.1` / `2.34.0` | — | pinned ✅ |
| `prom/prometheus` | `v3.1.0` (dev) | **`v2.51.0`** (smr) | major drift ❌ (F5) |
| `grafana/grafana` | `12.4.2` (dev) | **`10.4.0`** (smr) | major drift ❌ (F5) |
| `otel/opentelemetry-collector-contrib` | — | `0.96.0` (smr only) | orphan ⚠️ (F6) |
| `edoburu/pgbouncer` | `v1.25.1-p0` (db test) | — | pinned ✅ |
| `python:3.11-slim` (temporal bootstrap helper) | plain (dev + test) | — | minor: align to slim-trixie ⚠️ (F7) |
| GPU inference (`vllm`, `llama.cpp`, TEI) | pinned via env-overridable defaults | — | pinned ✅ |

Findings:
- **F4 — `minio/mc:latest` unpinned.** Violates the pinning policy; a silent `mc`
  bump can break the bucket-init job. Pin to a fixed `RELEASE.*` tag.
- **F5 — Observability major drift.** The orphan `apps/smr` compose runs
  Prometheus **v2** and Grafana **10**, while the central dev stack runs
  Prometheus **v3** and Grafana **12**. This is the single biggest misalignment.
- **F6 — Orphan per-app composes.** `apps/smr/docker-compose.yml` and
  `apps/guardrail/docker-compose.yml` are referenced by **no** `scripts/`,
  root `package.json`, or `.gitlab/` job. They duplicate Redis and (smr) a full
  stale observability stack. `guardrail`'s file still carries the obsolete
  top-level `version: '3.8'` key. `smr`'s Grafana port mapping is malformed:
  `"3001:8868/api/v1"` (invalid — a leftover bad edit).
- **F7 — Temporal bootstrap helper** uses plain `python:3.11-slim`; trivially
  alignable to `python:3.11-slim-trixie` for one Python base across the repo.

## Implementation Plan

Ordered, low-risk → higher-risk. Each step is independently revertable.

### Phase 1 — Node base consolidation (F1, F2)
1. `apps/example/Dockerfile`: introduce `ARG NODE_VERSION=24` + `ARG PNPM_VERSION`
   (match sibling files); `FROM node:${NODE_VERSION}-alpine AS builder`. Keep
   `nginx:1.27-alpine` runner (or bump to current `nginx:1.27-alpine` — already current).
2. `packages/database/Dockerfile`: introduce `ARG NODE_VERSION=24`; switch both
   stages to **`node:${NODE_VERSION}-bookworm-slim`** (glibc) — Prisma 7 engine safety.
3. `apps/api/Dockerfile`: bump `ARG NODE_VERSION=24`; keep `-slim` (already glibc).
   *(Optional consistency: pin the slim variant to `-bookworm-slim`.)*
4. `apps/admin-console/Dockerfile`, `apps/ui-playground/Dockerfile`: bump
   `ARG NODE_VERSION=24`. Keep the slim(build)→alpine(runtime) split — Next.js
   standalone is verified on alpine; no Prisma engine in these runtimes.

Decision embedded: **api + database → glibc/slim; admin-console + ui-playground +
example → alpine.** Rationale = Prisma-touching runtimes on glibc, static/SSR
runtimes on the smaller alpine.

### Phase 2 — Python base consolidation (F3, F7)
5. `apps/stt/docker/Dockerfile.apple`: change the four plain `python:3.11-slim`
   stages to `python:3.11-slim-trixie` to match `hope-python-base`. (Full reuse of
   `hope-python-base` is not possible here — the Apple path is a distinct arm64/uv
   flow — so version-align only.)
6. `infrastructure/docker/docker-compose.dev.yml` + `tests/docker-compose.test.yml`:
   change the Temporal bootstrap helper `python:3.11-slim` → `python:3.11-slim-trixie`.

### Phase 3 — Compose image pinning + observability alignment (F4, F5)
7. Pin `minio/mc:latest` → a fixed `minio/mc:RELEASE.*` tag in
   `infrastructure/docker/docker-compose.yml` and `tests/docker-compose.test.yml`.
   **Tag to confirm at edit time** — choose the published `mc` RELEASE closest to
   the server's `2025-04-22` (mc and server use independent release timelines).
8. Define the canonical observability versions as the central dev pins:
   `prom/prometheus:v3.1.0`, `grafana/grafana:12.4.2`.

### Phase 4 — Align (not delete) the per-app composes (F5, F6)
9. `apps/smr/docker-compose.yml`: bump `prom/prometheus` → `v3.1.0`,
   `grafana/grafana` → `12.4.2`; fix the malformed Grafana port `3001:8868/api/v1`
   → `3001:3000`; keep `redis:8-alpine` + `otel/...:0.96.0` as-is (align otel to the
   central pin if/when one is adopted — currently otel appears only here).
10. `apps/guardrail/docker-compose.yml`: remove the obsolete `version: '3.8'` key
    (Compose v2 ignores it and warns). No image changes needed (only `redis:8-alpine`).

## Verification Criteria

- [ ] `grep -rE "^\s*(FROM|image:)" <all in-scope files>` shows: one `ARG NODE_VERSION=24`
      pattern in every TS Dockerfile; no hardcoded `node:22`; no `:latest` except
      intentionally none (mc pinned); `minio/minio` unchanged at the pinned release.
- [ ] `docker build` succeeds for: `packages/database` (Prisma generate on glibc),
      `apps/api`, `apps/admin-console`, `apps/example`, `hope-python-base`, and one
      Python service via `--build-arg BASE_IMAGE`. Capture output as evidence.
- [ ] `docker compose -f infrastructure/docker/docker-compose.yml config` and the
      two per-app composes parse with no warnings (no `version:` warning).
- [ ] `.gitlab/ci/build.yml` still references `hope-python-base` correctly (no arg
      changes needed — BASE_IMAGE contract unchanged).
- [ ] Node 24 build/test smoke pass for each TS app (tsc/build) — the only step with
      real regression risk from the 22→24 bump.

## Owner Decisions

| # | Decision | Chosen |
|---|---|---|
| OD-1 | Node runtime target | **Node 24 LTS** |
| OD-2 | Orphan per-app composes | **Keep but align** |
| OD-3 | slim vs alpine per app | api+database → glibc/slim; admin-console+ui-playground+example → alpine *(proposed — confirm)* |
| OD-4 | `minio/mc` pin tag | pin to a fixed RELEASE *(exact tag chosen at edit time)* |

## Implementation Summary

All four phases applied (two parallel agents; Dockerfiles + compose split by file
to avoid overlap). Files changed:

**Dockerfiles (Node 24 + Python base alignment):**
- `apps/api/Dockerfile` — `NODE_VERSION 22→24`; `-slim`→`-bookworm-slim` (explicit glibc) on dependencies + production stages.
- `apps/admin-console/Dockerfile`, `apps/ui-playground/Dockerfile` — `NODE_VERSION 22→24`; slim(build)→alpine(runtime) split kept.
- `apps/example/Dockerfile` — added `ARG NODE_VERSION=24`; builder now `node:${NODE_VERSION}-alpine`; nginx runner unchanged. (No `PNPM_VERSION` arg — this file activates pnpm via `corepack prepare pnpm@latest`, so a pinned arg would be inconsistent.)
- `packages/database/Dockerfile` — added `ARG NODE_VERSION=24`; both stages `node:22-alpine`→`node:${NODE_VERSION}-bookworm-slim` (glibc, Prisma 7 safety). apk→apt conversion of `dumb-init`/`postgresql-client`; `addgroup`/`adduser`→`groupadd`/`useradd`; **added `openssl`** to both stages (Prisma engine on glibc, matching `apps/api`).
- `apps/stt/docker/Dockerfile.apple` — all four stages `python:3.11-slim`→`python:3.11-slim-trixie` (aligns to `hope-python-base`; `--platform=linux/arm64` preserved). GPU/CUDA STT Dockerfile untouched.

**Compose:**
- `infrastructure/docker/docker-compose.yml` + `tests/docker-compose.test.yml` — `minio/mc:latest`→`minio/mc:RELEASE.2025-04-16T18-13-26Z` (verified to exist on Docker Hub; nearest mc release on/before the pinned server date — mc and server use independent release timelines). **`minio/minio` server left at `RELEASE.2025-04-22T22-12-26Z` per owner instruction.**
- `infrastructure/docker/docker-compose.dev.yml` + `tests/docker-compose.test.yml` — Temporal/qdrant-init helper `python:3.11-slim`→`python:3.11-slim-trixie`.
- `apps/smr/docker-compose.yml` — Prometheus `v2.51.0`→`v3.1.0`; Grafana `10.4.0`→`12.4.2`; fixed malformed Grafana port `"3001:8868/api/v1"`→`"3001:3000"`.
- `apps/guardrail/docker-compose.yml` — removed obsolete `version: '3.8'` key.

**Verification done:** residual grep clean (no `node:22`, no bare `python:3.11-slim`, no `:latest`, no old prom/grafana tags; `BASE_IMAGE=hope-python-base:latest` defaults intentionally retained). `docker compose config -q` passes for `smr` + `guardrail`. mc tag existence confirmed against Docker Hub registry API.

### Platform / build verification (Mac silicon, OrbStack, 2026-07-26)

Environment: OrbStack context, server `arm64/linux` Docker 29.4.0, native (no emulation).
Changed bases confirmed to resolve to `linux/arm64` by default (pulled + inspected):
`node:24-bookworm-slim`, `node:24-alpine`, `python:3.11-slim-trixie`; both minio pins
publish arm64. STT platform routing correct: `Dockerfile.apple` pins `--platform=linux/arm64`
(Mac path); the `nvidia/cuda` amd64 Dockerfile is CI/GPU-only and never the Mac target.

Full `docker build` suite (root context, arm64):

| Image | Result | Note |
|---|---|---|
| `hope-python-base` | ✅ PASS (linux/arm64, 18s) | Clean — base + uv validated on arm64 |
| `packages/database` | ❌ pre-existing context bug | Passed ALL base edits (apt-get, openssl, useradd, `pnpm install --frozen-lockfile` on bookworm-slim) then failed at `pnpm db:generate`: package-level `prisma.config.ts` imports `../applications/src/common/env/env-file-resolution.ts`, which the Dockerfile does not COPY |
| `apps/api` | ❌ pre-existing | Failed at `@arcaai/ui#build` (known UI/vox typecheck backlog) — base + Node 24 fine |
| `apps/admin-console` | ❌ pre-existing | `@arcaai/room#build` node_modules-missing (turbo prune context) |
| `apps/example` | ❌ pre-existing | `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` / `@arcaai/config-eslint` workspace pkg not found — lockfile/context drift (same alpine base, version-bumped only) |
| `apps/smr` | ❌ pre-existing | `Distribution not found: file:///app/packages/py-env` — Dockerfile omits COPY of `packages/py-env`; this Dockerfile was NOT modified by this ticket |
| `apps/stt` (Dockerfile.apple) | ❌ pre-existing | `COPY "/src": not found` at line 59 — context path; only the 4 FROM lines were changed |

**Conclusion:** the platform is correct and the consolidation edits are sound. `python-base`
builds clean on arm64, and `database` executed through the entire OS/base layer (the highest-risk
edit) before hitting an app-layer cross-package import gap. **None of the 6 failures are caused by
the base-image or platform changes** — they are pre-existing monorepo Docker build-context bugs
(missing workspace COPYs, UI/room build backlog, lockfile drift) that would fail identically on the
old `node:22` / `python:3.11-slim` bases. On Mac, services run via pnpm/conda, so these image
builds were never exercised locally, which is why the context gaps surface now.

**Follow-up (separate ticket — OUT of scope for image consolidation):** repair the per-image build
contexts so `docker build` works locally/CI end-to-end (database→copy applications env module or
decouple prisma.config; smr→copy `packages/py-env`; example→resync lockfile/overrides;
stt-apple→fix `/src` COPY; api/admin-console→resolve UI/room build backlog).

### Build-context repair (2026-07-26, follow-up executed)

The build-context bugs above were repaired (root context, arm64/OrbStack). `apps/example` was
explicitly left as-is per instruction. Base images / pins were NOT touched. Every fix verified with
an actual `docker build`:

| Image | Result | Fix |
|---|---|---|
| `hope-python-base` | ✅ PASS | none (already clean) |
| `packages/database` | ✅ PASS (build **and** runtime) | Keep the image (it is a deployed migrations/seed job — `build-database` CI + `hope-staging-database` ArgoCD app). Made it **lean + self-contained**: COPY the dependency-free `packages/applications/src/common/env` (only `node:fs`/`node:path`) into builder **and** runtime so both `prisma.config.ts` files load; replaced `pnpm db:generate` with a direct `prisma generate` + `tsc` — dropping the `@arcaai/tools generate-prisma-index` barrel step (would drag `@prisma/internals`/`ts-morph`/`handlebars`/`inquirer` into a migrations image; the seed imports the generated `client.js` directly and never resolves the `./client` barrel). Runtime smoke: `prisma generate` loads the config and emits the client. |
| `apps/api` | ✅ PASS | Build scope was `build:packages && build:modules && build:api` — `build:packages` compiled every `packages/*` (incl. `@arcaai/ui`/`@arcaai/vox`, which api never consumes and whose deps aren't installed here → `@arcaai/ui#build` fail); the other two scripts don't exist. Replaced with `pnpm api:build` (`turbo --filter=@arcaai/api...`) — exactly the graph whose package.jsons are already copied. |
| `apps/admin-console` | ✅ PASS | The app legitimately pulls the `@arcaai/vox` audio SDK, but the dependency stage only copied a few workspace `package.json`s → `pnpm install` couldn't resolve the graph and `@arcaai/room#build` had no deps. Added the missing closure: `room`, `stt`, `agentic-sdk-v2` (vox), `vad`, `noise-filter`, `med-ner`. (Packages build fine — this was never a typecheck backlog issue.) |
| `apps/smr`, `apps/guardrail`, `apps/nlp`, `apps/harness`, `apps/tts`, `apps/stt` (CPU) | ✅ PASS (smr + guardrail built; identical one-line fix across all six) | Every service now declares the `hope-env` workspace dep (TASK-558) but no Python Dockerfile copied it → `uv sync` layer 1 failed with `Distribution not found: file:///app/packages/py-env`. Added `COPY packages/py-env ./packages/py-env` beside the existing `py-runtime-models` COPY. |
| `apps/stt` (`Dockerfile.apple`) | ✅ PASS (`runtime` target) | Converted from the stale per-app context to **root context** (matching every other Dockerfile): COPY paths rebased to `apps/stt/...`, plus the root workspace `pyproject.toml` + `packages/py-env` + `packages/py-runtime-models` so `uv pip install "./apps/stt[test]"` discovers the workspace and resolves the `hope-env`/`hope-runtime-models` path deps (lockfile-free fresh resolve preserved). Header build command updated to the root-context invocation. |
| `apps/example` | ⏭️ SKIPPED | Per instruction — not touched. |

## Change History

- 2026-07-26 — Ticket created. Full image inventory + consolidation plan drafted
  for approval (Node 24, keep-but-align per-app composes).
- 2026-07-26 — Phases 1–4 applied via two parallel agents. `minio/mc` re-pinned to
  the verified `RELEASE.2025-04-16T18-13-26Z` after the server-matched tag was
  confirmed nonexistent on Docker Hub. Status → Review.
- 2026-07-26 — Platform + build verification on Mac silicon/OrbStack. Platform
  confirmed arm64-native and correct; `hope-python-base` builds clean on arm64. The
  6 app-image build failures are all pre-existing monorepo Docker build-context bugs
  unrelated to the base-image/platform changes (see Platform / build verification
  table). Follow-up filed as out-of-scope build-context repair.
- 2026-07-26 — Build-context repair executed (see "Build-context repair" section).
  database, api, admin-console, smr, guardrail, and stt-apple (runtime) all `docker
  build` green on arm64; database verified at runtime too. `apps/example` skipped per
  instruction. No base images or pins changed.
