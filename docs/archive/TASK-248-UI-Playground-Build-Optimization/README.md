# TASK-248: UI Playground Docker Build Optimization

| Field       | Value                              |
|-------------|------------------------------------|
| Ticket      | TASK-248                           |
| Created     | 2026-03-27                         |
| Updated     | 2026-03-27                         |
| Status      | Completed                          |
| Type        | Infrastructure / Optimization      |

## Requirement Analysis

### Description

The `build-ui-playground` GitLab CI job takes ~7 minutes to complete. The primary bottlenecks are:

1. **pnpm install downloads all 1,899 packages from scratch** every build (0 reused) — ~2m
2. **Sequential package builds** instead of leveraging Turborepo parallelism — ~2m 43s
3. **`--no-frozen-lockfile`** forces dependency resolution instead of using lockfile — adds ~10-15s
4. The `install-node` CI stage is NOT reused by Docker builds (they run in separate environments)

### Business Context

CI pipeline efficiency directly impacts developer velocity. A 7-minute build blocks deployment feedback loops and wastes runner compute time.

### Acceptance Criteria

- [ ] pnpm install uses BuildKit cache mount for cross-build store persistence
- [ ] pnpm install uses `--frozen-lockfile` for deterministic, faster installs
- [ ] Package builds use Turborepo for parallelism and correct dependency ordering
- [ ] Estimated build time reduced from ~7m to ~3-4m (warm cache: ~2m)

## Current State Evaluation

### Before (7m 14s breakdown)

| Phase                          | Time     | Issue                                           |
|--------------------------------|----------|--------------------------------------------------|
| Git clone                      | 1m 11s   | Fixed cost                                       |
| Docker login + BuildKit setup  | ~3s      | Fine                                             |
| Pull base images               | ~22s     | Cached after first pull                          |
| Install pnpm globally          | 3s       | Fine                                             |
| **pnpm install (1,899 pkgs)**  | **2m 6s**| **0 reused — no store persistence in Docker**    |
| **Sequential package builds**  | **2m 43s**| **8 builds in series, no parallelism**          |
| Production stage               | 15s      | Parallel with dependency stage                   |
| Cache export to registry       | 55s      | Fixed cost                                       |

### Root Causes

1. **No pnpm store in Docker**: The `install-node` CI job mounts `/pnpm-store` as a host volume, but the Docker-in-Docker build has no access to it. Result: `reused 0` in every build.

2. **`--no-frozen-lockfile`**: Forces pnpm to resolve the dependency tree instead of reading the lockfile directly. Slower and non-deterministic.

3. **Manual sequential builds**: The Dockerfile runs 8 `pnpm --filter` commands in series. Turborepo can parallelize independent packages (room, vad, stt, noise-filter, med-ner can all build concurrently).

## Implementation Plan

### Changes

1. **Dockerfile** (`apps/ui-playground/Dockerfile`):
   - Add `turbo@2` to global installs
   - Add BuildKit cache mount (`--mount=type=cache`) for pnpm store persistence across builds
   - Switch to `--frozen-lockfile` for deterministic installs
   - Replace 8 sequential `pnpm --filter` builds with `turbo run build --filter=@arcaai/ui-playground...`

2. **No CI template changes needed**: The `.build-template` already uses BuildKit with `docker-container` driver, which supports `--mount=type=cache` natively.

## Implementation Summary

### Files Changed

| File | Change |
|------|--------|
| `apps/ui-playground/Dockerfile` | Optimized dependency install and build stages |

### Key Changes Explained

#### 1. BuildKit Cache Mount for pnpm Store

```dockerfile
RUN --mount=type=cache,id=pnpm-store-ui-playground,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile
```

BuildKit `--mount=type=cache` creates a persistent cache volume managed by the BuildKit daemon. Since the `cibuilder` builder instance persists across pipeline runs on the same runner, the pnpm content-addressable store survives between builds. On warm cache, `pnpm install` links from the store (~10-15s) instead of downloading everything (~2m).

#### 2. Frozen Lockfile

Switched from `--no-frozen-lockfile` to `--frozen-lockfile`. This:
- Skips dependency resolution (uses lockfile directly)
- Ensures deterministic builds
- Fails fast if lockfile is out of sync (desirable in CI)

#### 3. Turborepo Parallel Builds

```dockerfile
RUN turbo run build --filter=@arcaai/ui-playground...
```

The `...` suffix tells Turborepo to build `@arcaai/ui-playground` and all its workspace dependencies, respecting the dependency graph from `turbo.json`. Independent packages (room, vad, stt, noise-filter, med-ner) build in parallel after `@arcaai/ui` completes.

### Expected Performance

| Phase                    | Before  | After (cold) | After (warm) |
|--------------------------|---------|--------------|--------------|
| pnpm install             | 2m 6s   | ~2m (first)  | **~15s**     |
| Package builds           | 2m 43s  | ~1m 30s      | ~1m 30s      |
| Other (clone, push, etc) | 2m 25s  | 2m 25s       | 2m 25s       |
| **Total**                | **7m 14s** | **~6m**   | **~4m 10s**  |

### Notes

- The `install-node` CI job remains unchanged. It serves lint/typecheck/test jobs that run on GitLab runners with the host-mounted `/pnpm-store`. It does NOT feed into Docker builds.
- The BuildKit cache mount is scoped with `id=pnpm-store-ui-playground` to avoid collisions with other service builds.
- The `turbo.json` `build` task has `"cache": false`, so Turborepo won't cache build outputs — but it still provides parallelism and correct dependency ordering.
