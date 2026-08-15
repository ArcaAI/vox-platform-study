# TASK-698 — Residual Infra / CI / Security Pins

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `infrastructure` |
| **Ticket number** | TASK-698 (TASK-694 landed the first pin pass; TASK-696 is residual TS; TASK-697 avoided) |
| **Classification** | Leftover same-line / security image and CI pins after TASK-694. No product-line migrations. No lockfile edits. |
| **Date** | 2026-08-15 |

---

## Requirement Analysis

Finish the residual **patch-level / security** image and CI pins that TASK-694 left behind or did not land. Same pin everywhere a component appears. No EOL engines. Scanners stay current.

Do **not** do product-line migrations. Hard denylist this pass: Temporal auto-setup / Temporal UI, MinIO community→AIStor, vLLM, llama.cpp, TEI, Vault 2.x, Grafana 13, `docker:27`→29, CUDA retag, Qdrant v1.16→v1.19 (unless a CVE on 1.16 with a 1.16.x-only patch), pnpm 11, Node 26, Python 3.12/3.14.

Do **not** edit `pnpm-lock.yaml`, `package.json` deps, `uv.lock`, or Python `pyproject.toml`. Do not bump `packageManager` pnpm. Playwright image stays `v1.62.1-noble` unless drifted from `package.json` (it has not).

---

## Current State Evaluation

Re-scan of compose, Dockerfiles, GitLab CI, GitHub Actions, and `infrastructure/single-deployment` (2026-08-15) after TASK-694:

| Name | Current (before this pass) | Latest same-line | Latest any | Action |
|---|---|---|---|---|
| Vault | `hashicorp/vault:1.21.2` | Hub: `1.21.4` (`1.21.9` still missing) | 2.0.4 (denylist) | **Bump 1.21.4** |
| Prometheus (dev compose) | `v3.13.2` | `v3.13.2` (3.14 is RC only) | `v3.14.0-rc.0` | Keep |
| Prometheus (SMR compose) | `v3.1.0` (TASK-694 claimed this file; it did not land) | `v3.13.2` | same | **Bump v3.13.2** |
| Grafana (dev compose) | `12.4.8` | `12.4.8` (`12.4.9` image tag missing) | 13.x (denylist) | Keep |
| Grafana (SMR compose) | `12.4.2` (same TASK-694 miss) | `12.4.8` | 13.x | **Bump 12.4.8** |
| Trivy | `0.74.0` | `0.74.0` (`0.74.1` missing) | `0.74.0` | Keep |
| gitleaks | `v8.30.1` | `v8.30.1` (`v8.31.0` missing) | `v8.30.1` | Keep |
| nginx | `1.30.4-alpine` | `1.30.4-alpine` | `1.31.3` mainline | Keep |
| alpine CI | `3.22` (floating patch) | `3.22.5` / `3.22` | `3.24.1` | Keep floating `3.22` |
| GitLab Node | `node:24-alpine` | floating 24 | 24 (26 denylist) | Keep |
| GHA Node / actions | Node 24, `checkout`/`setup-*` `@v7` | current | — | Keep |
| Playwright | `v1.62.1-noble` | matches `@playwright/test ^1.62.1` | newer Playwright | Keep (TS-owned) |
| uv (python-base / STT CUDA) | `0.11.7` | `0.11.33` | `0.12.5` | **Bump 0.11.33**; skip 0.12.5 |
| uv (STT apple Dockerfile) | `0.8.13` | align to python-base | `0.12.5` | **Align 0.11.33** |
| vault-k8s injector | `1.7.2` | `1.7.6` | `1.7.6` | **Bump 1.7.6** |
| alpine/k8s (Vault init Job) | `1.33.1` | `1.33.13` | `1.34.x` | **Bump 1.33.13** |
| PgBouncer | `edoburu/pgbouncer:v1.25.1-p0` | `v1.25.2-p0` | same 1.25 line | **Bump v1.25.2-p0** |
| Helm chart `hashicorp/vault` | `0.32.0` (app default 1.21.2) | no 0.32.x patch | `0.34.0` (app **2.0.3**) | **Keep 0.32.0** |
| python CI / Dockerfiles | `3.11-slim` / `3.11-slim-trixie` | `3.11.15-slim*` exists | 3.14 (denylist) | Keep floating-by-policy |
| `docker:27` | floating major 27 | 27.x still published | 28.5.2 / 29 denylist | Keep (denylist 27→29) |
| cosign | `v2.6.5-dev@sha256:76029a…417` | `v2.6.5` (`v2.6.6-dev` missing) | v3.1.3 | Keep |
| Qdrant | `v1.16` (floating 1.16.x) | `v1.16.3` (tag `v1.16` already tracks it) | v1.19 (denylist) | Keep floating `v1.16` |
| OTEL collector (SMR) | `0.96.0` | no later 0.96.x on Hub | ~0.140+ | Skip (line jump) |
| MinIO / mc | `RELEASE.2025-04-22` / `2025-04-16` | community stale | AIStor | Skip (denylist) |
| Temporal | `auto-setup:1.29.1` + UI `2.34.0` | n/a | new image layout | Skip (denylist) |
| vLLM / llama.cpp / TEI | `v0.11.0` / `server-b9853` / `cpu-1.9` | n/a | newer builds | Skip (denylist) |
| CUDA | `12.8.1-cudnn-*-ubuntu22.04` | n/a | retag | Skip (denylist) |
| Redis / Timescale | `redis:8-alpine` / `pg18-all` | floating-by-policy | — | Keep |
| busybox | `1.37` | `1.37.0` (same line, floating) | 1.37 | Keep |
| pnpm `packageManager` | TS-owned (10.31 / 10.34.5) | — | 11 denylist | Do not touch |

CVE note on Qdrant: **CVE-2026-25628** is `>=1.9.3,<1.16.0`, fixed in **1.16.0**. Current pin `v1.16` already includes that fix. No 1.16.x-only CVE patch required; 1.16→1.19 remains denylisted.

---

## Implementation Plan

1. Verify candidate tags with Docker Hub API + `docker buildx imagetools inspect` (index digest for digest-pinned overlays).
2. Apply leftover same-line bumps. Align duplicate pins (SMR Prometheus/Grafana, uv apple Dockerfile, Vault compose + single-deployment).
3. Skip missing tags and denylisted majors. Document leftovers.
4. No compose volume wipe. No commit / push.

---

## Implementation Summary

### Tag verification (2026-08-15)

| Target | Result |
|---|---|
| `hashicorp/vault:1.21.4` | Exists. Index digest `sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569`. |
| `hashicorp/vault:1.21.9` | **Missing** (Hub + imagetools). Community images still “available soon” after the 2026-08-05 note. |
| `hashicorp/vault-k8s:1.7.6` | Exists. Index digest `sha256:55e27b080c9b0469fd420dfb3631243488c6319504b779423caa46c529a95490`. |
| `alpine/k8s:1.33.13` | Exists. Index digest `sha256:e521cee1f1cb8699bc6e906b4ce6fe50e84addae97f52d5dcf05d3974002ac26`. |
| `ghcr.io/astral-sh/uv:0.11.33` | Exists. Latest 0.11.x. |
| `ghcr.io/astral-sh/uv:0.12.5` | Exists, **not used** (see skip). |
| `grafana/grafana:12.4.9` | **Missing** (helm-chart 12.4.9 is not the OSS image). Latest OSS 12.4 image is `12.4.8`. |
| `aquasec/trivy:0.74.1` | **Missing**. `0.74.0` is current (released 2026-08-14). |
| `zricethezav/gitleaks:v8.31.0` | **Missing**. `v8.30.1` is current. |
| `edoburu/pgbouncer:v1.25.2-p0` | Exists. |
| `gcr.io/projectsigstore/cosign:v2.6.6-dev` | **Missing**. `v2.6.5-dev` digest already matches the GHSA-fx35-mq7g-6g98 backport. |
| `prom/prometheus:v3.13.2` | Still latest 3.13 LTS. `v3.14.0-rc.0` only. |

### Pins applied

| Component | From | To | Files |
|---|---|---|---|
| Vault | `1.21.2` | `1.21.4` | `infrastructure/docker/docker-compose.dev.yml`, `tests/docker-compose.test.yml`, `infrastructure/single-deployment/vault` (helm values + digest overlay, seal-vault tag/digest, kind-e2e) |
| vault-k8s | `1.7.2` | `1.7.6` | helm `values.yaml` (now explicit `injector.image`), `values.digests.yaml`, `test/kind-e2e.sh` |
| alpine/k8s | `1.33.1` | `1.33.13` | `bootstrap/init-job.yaml`, `bootstrap/kustomization.yaml` digest, `test/kind-e2e.sh` |
| Prometheus (SMR leftover) | `v3.1.0` | `v3.13.2` | `apps/smr/docker-compose.yml` |
| Grafana (SMR leftover) | `12.4.2` | `12.4.8` | `apps/smr/docker-compose.yml` |
| uv | `0.11.7` / apple `0.8.13` | `0.11.33` | `infrastructure/docker/python-base/Dockerfile`, `apps/stt/docker/Dockerfile`, `apps/stt/docker/Dockerfile.apple`, `.gitlab/ci/build.yml` warm-up |
| PgBouncer | `v1.25.1-p0` | `v1.25.2-p0` | `packages/database/tests/pgbouncer-validation/docker-compose.yml` (+ README), `docs/research/configs/postgres-ha/docker-compose.yml`, `docs/research/deployments/deploy-vm500-502-postgres-ha.md` |

Helm chart stays **`hashicorp/vault` 0.32.0**. Chart 0.33.0 / 0.34.0 default app version is Vault **2.x**.

Comment-only alignment: `docs/development-patterns-and-standards.md` gitleaks pin `v8.21.2` → `v8.30.1` (TASK-694 already moved the CI image).

### Skipped because the tag did not exist

| Requested | Why skipped | Fallback |
|---|---|---|
| `hashicorp/vault:1.21.9` | Not on Docker Hub | `1.21.4` (latest published 1.21.x) |
| `grafana/grafana:12.4.9` | Image tag not published (helm chart only) | keep / land `12.4.8` |
| `aquasec/trivy:0.74.1` | Not published | keep `0.74.0` |
| `zricethezav/gitleaks:v8.31.0` | Not published | keep `v8.30.1` |
| `gcr.io/projectsigstore/cosign:v2.6.6-dev` | Not published | keep digest-pinned `v2.6.5-dev` |

### Skipped with a tag that exists

| Target | Why skipped |
|---|---|
| `ghcr.io/astral-sh/uv:0.12.5` | `uv.lock` is still `revision = 3` and 0.12 still *reads* revision 3, but **0.12.0 has frozen-sync breaking changes** (rejects legacy sdist/wheel archive formats *including when referenced by an existing lockfile*; pre-release selection change). Brief said skip if unsure. Stayed on latest **0.11.33**. |
| Helm `hashicorp/vault` 0.33.0 / 0.34.0 | Defaults Vault **2.x** (denylist). |
| `python:3.11.15-slim*` | Repo already uses floating `3.11-slim` / `3.11-slim-trixie` by policy. Pinning would churn every Python Dockerfile + GitLab job without a security-tag mismatch. |
| `alpine:3.22.5` | CI already uses floating `alpine:3.22` (tracks 3.22.5). |
| `qdrant/qdrant:v1.16.3` | Compose already uses floating `v1.16`, which Hub publishes as the 1.16.x tip (`v1.16.3`). CVE-2026-25628 is fixed in 1.16.0. |
| `docker:28` / `29` | Denylist is 27→29; 28 is still a Docker Engine line jump. Keep floating `docker:27`. |
| OTEL collector `0.140+` | No 0.96.x patch; that is a product-line jump. |
| Grafana 13, Vault 2.x, Temporal images, MinIO→AIStor, vLLM / llama.cpp / TEI, CUDA retag, Playwright, pnpm 11 | Denylist / owned by other agents. |

### Digest pins refreshed

| Image | New index digest |
|---|---|
| `hashicorp/vault:1.21.4` | `sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569` |
| `hashicorp/vault-k8s:1.7.6` | `sha256:55e27b080c9b0469fd420dfb3631243488c6319504b779423caa46c529a95490` |
| `alpine/k8s:1.33.13` | `sha256:e521cee1f1cb8699bc6e906b4ce6fe50e84addae97f52d5dcf05d3974002ac26` |

Trivy / gitleaks remain **tag-pinned** (not digest). Only cosign is digest-pinned among scanners/signers, matching TASK-694 policy.

### Security leftovers (not migrated this pass)

| Item | Risk | Why left |
|---|---|---|
| MinIO `RELEASE.2025-04-22T22-12-26Z` + mc `2025-04-16` | Community image is stale; MinIO is steering new work to AIStor | Product-line decision, denylist |
| Temporal `temporalio/auto-setup` | Image is deprecated vs server + setup split | Denylist (auto-setup / UI migration) |
| `docker:27` (floating) | Engine 28.5.2 exists; 29 denylisted | Same-major float; no 27→29 |
| Node 20 | **None in live CI/Dockerfiles.** Research runbooks (`docs/research/deployments/*`) and `infrastructure/docker/README.md` still mention `node:22-*` | Docs/research only |
| Trivy tag vs digest | Tag can be retagged; cosign is the only digest-pinned signer | Do not digest-pin scanners unless the others already are |
| OTEL collector `0.96.0` (SMR monitoring profile) | Far behind current contrib (~0.140) | Not a 0.96.x patch |
| Qdrant `v1.16` | Behind v1.19; CVE-2026-25628 already fixed in 1.16.0 | Denylist 1.16→1.19 |
| python `3.11-slim` unpinned patch | Tracks latest 3.11.15 today, but tag is mutable | Floating-by-policy |
| `apps/example/.gitlab-ci.example.yml` `docker:24.0` | Stale example CI, not the real pipeline | Out of production CI scope |
| uv 0.12.5 | Latest uv; 0.12.0 can reject some lockfile archives on `--frozen` | Skipped until a dedicated uv minor bump + lock check |

### Files changed

- `apps/smr/docker-compose.yml`
- `infrastructure/docker/docker-compose.dev.yml`
- `tests/docker-compose.test.yml`
- `infrastructure/docker/python-base/Dockerfile`
- `apps/stt/docker/Dockerfile`
- `apps/stt/docker/Dockerfile.apple`
- `.gitlab/ci/build.yml`
- `packages/database/tests/pgbouncer-validation/docker-compose.yml`
- `packages/database/tests/pgbouncer-validation/README.md`
- `docs/research/configs/postgres-ha/docker-compose.yml`
- `docs/research/deployments/deploy-vm500-502-postgres-ha.md`
- `infrastructure/single-deployment/vault/helm/values.yaml`
- `infrastructure/single-deployment/vault/helm/values.digests.yaml`
- `infrastructure/single-deployment/vault/seal-vault/seal-vault.yaml`
- `infrastructure/single-deployment/vault/seal-vault/kustomization.yaml`
- `infrastructure/single-deployment/vault/bootstrap/init-job.yaml`
- `infrastructure/single-deployment/vault/bootstrap/kustomization.yaml`
- `infrastructure/single-deployment/vault/test/kind-e2e.sh`
- `infrastructure/single-deployment/vault/README.md`
- `docs/development-patterns-and-standards.md`

Untouched by policy: `pnpm-lock.yaml`, `package.json`, `uv.lock`, Python `pyproject.toml`, Playwright image, `packageManager` pnpm.

Verification this pass: registry tag existence + index digests. No compose `down -v`. No pipeline run (no commit / push).

### Verification (2026-08-16)

Re-checked live compose, Dockerfiles, GitLab CI, GitHub Actions, and `infrastructure/single-deployment/vault` against this ticket’s bump / keep / skip lists. Every TASK-698 **Bump** is present (Vault 1.21.4 + claimed digests, vault-k8s 1.7.6, alpine/k8s 1.33.13, Prometheus `v3.13.2` in SMR + dev, uv `0.11.33`, PgBouncer `v1.25.2-p0`, Helm chart still `0.32.0`). Keep pins still match (Trivy `0.74.0`, gitleaks `v8.30.1`, nginx `1.30.4-alpine`, alpine `3.22`, Node 24, Playwright `v1.62.1-noble`, GHA `checkout`/`setup-*` `@v7`, cosign digest-pinned `v2.6.5-dev`, OTEL `0.96.0`, CUDA `12.8.1`, python `3.11-slim*` floating).

Later **TASK-701** (out of this ticket’s denylist) superseded Grafana `12.4.8` → `13.1.2` (dev + SMR, same pin both places), `docker:27` → `docker:28`, Qdrant `v1.16` → `v1.19.0`, and Temporal auto-setup → `server`/`admin-tools` 1.31.2 + UI 2.53.1. Those are not TASK-698 leftovers. Documented skips (MinIO community, uv 0.12, Vault 2.x / chart 0.33+, vLLM / llama.cpp / TEI, `apps/example/.gitlab-ci.example.yml` `docker:24.0`) remain as scoped.

---

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-08-15 | Infra residual-pin agent | Created TASK-698. Re-scanned pins after TASK-694. Landed leftover same-line bumps (Vault 1.21.4, SMR Prometheus/Grafana, vault-k8s 1.7.6, alpine/k8s 1.33.13, uv 0.11.33, PgBouncer 1.25.2). Skipped missing Hub tags and uv 0.12. Status `Review`. |
| 2026-08-16 | Completeness review | Verified claimed pins against current implementation. All TASK-698 bumps present; Grafana/docker/Qdrant/Temporal later moved by TASK-701 (denylisted here). No scoped leftovers. Status `Completed`. |
