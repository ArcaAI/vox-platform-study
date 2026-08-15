# TASK-701 — Coordinated Infra Major Upgrades

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `infrastructure` |
| **Ticket number** | TASK-701 (TASK-699 / TASK-700 reserved for sibling TS/Python agents) |
| **Classification** | Coordinated image-line upgrades so compose servers match Python `qdrant-client` 1.19 and `temporalio` 1.31. Optional Grafana 13 / docker 28. No lockfile edits. |
| **Date** | 2026-08-15 |

---

## Requirement Analysis

Move HOPE compose / CI images onto the **same lines** as the Python (TASK-700) and TS clients:

- **I1 (required):** `qdrant/qdrant:v1.16` → `v1.19.0` (pair with `qdrant-client` 1.19).
- **I2 (required):** Temporal server toward **1.31.x** (pair with `temporalio` 1.31). Replace deprecated `temporalio/auto-setup` if a current layout exists. Sequential hop if 1.31 needs a schema migration. No volume wipe.
- **I3 (optional):** Grafana `12.4.8` → `13.1.x` only if classic provisioning YAML still works.
- **I4:** GitLab `docker:27` → `docker:28` (not 29).
- **I5:** Vault 2 / MinIO / vLLM — skip unless safe without breaking dev unseal.
- **I6:** OTEL 0.96.x patch only; do not freeze Python 3.11-slim unless the repo already wants frozen tags.

Do **not** edit `pnpm-lock.yaml`, `package.json`, `uv.lock`, or Python `pyproject.toml`. No commit / push. No `docker compose down -v`. No `DELETE`/`DROP`/`TRUNCATE`.

---

## Current State Evaluation

After TASK-694 / TASK-698 (Vault 1.21.4, Prometheus v3.13.2, Grafana 12.4.8, Trivy 0.74.0, gitleaks v8.30.1, uv 0.11.33, PgBouncer v1.25.2-p0, nginx 1.30.4, alpine 3.22, Node 24, Playwright v1.62.1-noble):

| Name | Before this pass | Latest relevant | Action |
|---|---|---|---|
| Qdrant | `qdrant/qdrant:v1.16` (dev + test) | Hub `v1.19.0` (= `v1.19` digest) | **I1 bump v1.19.0** |
| Temporal | `temporalio/auto-setup:1.29.1` + UI `2.34.0` | auto-setup last line **1.29.7**; no auto-setup 1.30/1.31. Recommended: `temporalio/server` + `admin-tools` 1.31.2, UI 2.53.1 | **I2 switch layout + 1.31.2** |
| Grafana | `12.4.8` (dev + SMR) | `13.1.2` | **I3 bump 13.1.2** |
| docker CI | `docker:27` (dind 27.5.1) | `docker:28` (dind 28.5.2); 29 exists | **I4 bump docker:28** |
| Vault | `1.21.4` | 2.0.4 | **I5 skip** (dev `-dev` unseal) |
| MinIO | `RELEASE.2025-04-22` | AIStor | **I5 skip** |
| vLLM / llama.cpp | `v0.11.0` / `server-b9853` | newer | **I5 skip** |
| OTEL (SMR) | `0.96.0` | no 0.96.1/0.96.2 on Hub | **I6 skip** |
| python CI | floating `3.11-slim` | `3.11.15-slim*` exists | **I6 skip** (floating-by-policy) |

---

## Implementation Plan

1. Verify Hub tags + `docker buildx imagetools inspect` before writing.
2. Apply I1 and I2 first (client/server fit), then I3–I6.
3. Temporal: replace auto-setup with samples-server postgres layout; schema script must be idempotent (existing 1.29 DBs get `update-schema` only).
4. Ticket pin table + Temporal migration notes for the Python agent.

---

## Implementation Summary

### Tag verification (2026-08-15)

| Target | Result |
|---|---|
| `qdrant/qdrant:v1.19.0` | Exists. Index digest `sha256:057ee3a8da769fe7310dd3537b4dc7583bf87a95ce8ac43c0af5a46bc580d1fc`. Same digest as floating `v1.19`. amd64+arm64. |
| `qdrant/qdrant:v1.19` | Exists (same digest as v1.19.0). Pinned **v1.19.0**. |
| `temporalio/server:1.31.2` | Exists. Index `sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da`. |
| `temporalio/admin-tools:1.31.2` | Exists. Index `sha256:dbc5fcd6ee8f0f4d808bf765af9a87dea9d8a283abfdcfbd2fc148496ba66107`. |
| `temporalio/admin-tools:1.29.7` | **Missing.** Cannot split images on the 1.29 line. |
| `temporalio/auto-setup:1.29.7` | Exists (last auto-setup line). **No** auto-setup tags for 1.30.4 / 1.31.x. |
| `temporalio/server:1.30.4` / `admin-tools:1.30.4` | Exist (sequential hop images). |
| `temporalio/ui:2.53.1` | Exists. Index `sha256:102edb3cc9a549c8408bb5a867be944f6bc3889479770362e4c4c2067a4b8700`. UI requires server ≥ 1.16. |
| `grafana/grafana:13.1.2` | Exists. Index `sha256:d177053ab62253815f130d81504f77063baf5fd4ca93299d6048453bd31e047a`. |
| `docker:28` | Exists (= `28.5.2-dind`, same family as current `docker:27` = `27.5.1-dind`). |
| `otel/...-contrib:0.96.1` | **Missing.** Keep `0.96.0`. |

`docker compose … config` succeeds for dev (temporal + observability), test compose, and SMR monitoring profile.

### Pins applied

| Set | Component | From | To | Files |
|---|---|---|---|---|
| I1 | Qdrant | `v1.16` | **`v1.19.0`** | `infrastructure/docker/docker-compose.dev.yml`, `tests/docker-compose.test.yml` |
| I2 | Temporal server | `auto-setup:1.29.1` | **`temporalio/server:1.31.2`** + **`admin-tools:1.31.2`** | `docker-compose.dev.yml` + `configs/temporal/scripts/{setup-postgres,create-namespace}.sh` |
| I2 | Temporal UI | `2.34.0` | **`2.53.1`** | `docker-compose.dev.yml` |
| I3 | Grafana | `12.4.8` | **`13.1.2`** | `docker-compose.dev.yml`, `apps/smr/docker-compose.yml` |
| I4 | GitLab docker CLI/dind | `docker:27` | **`docker:28`** | `.gitlab/ci/{templates,build,deploy}.yml` |

### Set I2 — Temporal migration notes

`temporalio/auto-setup` is **deprecated** and unpublished past 1.29.x. Current recommended compose (temporalio/samples-server `compose/docker-compose-postgres.yml`) is:

- `temporalio/admin-tools` — `temporal-sql-tool` create / setup-schema / update-schema
- `temporalio/server` — frontend :7233, SQL visibility (no Elasticsearch)
- `temporalio/ui`

**Schema (1.31.0 release notes):** before starting 1.31, PostgreSQL core must be **v1.19** and visibility **v1.14**. The admin-tools 1.31.2 image’s versioned SQL dirs include those migrations. `setup-postgres.sh` is idempotent:

- `create` / `setup-schema -v 0.0` are allowed to fail (DB already exists).
- `update-schema` always runs (in-place `ALTER` / `CREATE TABLE`, not DROP of the `hope` app DB, not a volume wipe).

**Sequential server hop (docs.temporal.io):** do not skip minors for *cluster data format* (shard metadata). SQL schema can be applied in one `update-schema` from 1.31 admin-tools; the **server binary** still prefers consecutive minors.

| Hop | Images | Notes |
|---|---|---|
| 1.29.1 → 1.29.7 | `auto-setup:1.29.7` only | Same line. `admin-tools:1.29.7` **does not exist**. |
| 1.29.7 → 1.30.4 | `server` + `admin-tools` **1.30.4** | First version with the new image split. Visibility schema → v1.13. |
| 1.30.4 → **1.31.2** | `server` + `admin-tools` **1.31.2** | Core v1.19, visibility v1.14. |

If an **existing** local `temporal` / `temporal_visibility` database from auto-setup 1.29.x fails to start under 1.31.2, do **not** `down -v`. Override without wiping volumes:

```
TEMPORAL_VERSION=1.30.4 TEMPORAL_ADMINTOOLS_VERSION=1.30.4 pnpm infra:dev:up
# wait until hope-temporal is healthy, then
pnpm infra:dev:up   # defaults 1.31.2
```

Canonical operator runbook + print-only helper: [TASK-702](../TASK-702-Dependency-Blocker-Resolutions/README.md) (`pnpm infra:dev:temporal-hop`).

(If even 1.30.4 refuses 1.29 data, briefly run `temporalio/auto-setup:1.29.7` with the old single-service compose, then 1.30.4, then 1.31.2.)

Fresh clones / empty Temporal DBs: admin-tools 1.31.2 creates schema at current and the server starts on 1.31.2.

**Python `temporalio` 1.31 vs server 1.29:** Temporal does **not** publish a lockstep SDK↔server matrix; SDKs are expected to talk to older servers (new server features need a new SDK). **1.29 server + 1.31 client is supported.** This ticket still moved the server to **1.31.2** so the pair matches. Python should **not** revert `temporalio` 1.31.

### Set I3 — Grafana 13

Provisioning YAML is unchanged `apiVersion: 1` datasources + `type: file` providers (`infrastructure/docker/configs/grafana/provisioning/**` and `infrastructure/grafana/provisioning/**`). Dashboards are classic v1 JSON (`schemaVersion` 38–39, `panels[]`). Grafana 13 still file-provisions that shape; the k8s/v2 wrapper is only required for Grafana-13-native v2 dashboards. Git Sync is not used (13.0.0 Git Sync data-loss N/A). First start of 13 migrates `grafana-data` to unified storage automatically (not a volume wipe). Landed **13.1.2**.

### Set I4 — docker 28

Live CI used `docker:27`, which is already the **dind** tag (`27.5.1-dind`) against the host socket. `docker:28` is the same family (`28.5.2-dind`). Jobs are CLI/`buildx` + `apk add`; no conceptual break vs 27. Did **not** take `docker:29`.

### Skipped

| Set | Target | Why |
|---|---|---|
| I5 | Vault `2.0.4` | Would break the 1.21.4 helm chart + `-dev` unseal/dev-mode workflow. Stay **1.21.4**. |
| I5 | MinIO after 2025-04-22 | Community image is stale; next line is AIStor (product decision). |
| I5 | vLLM / llama.cpp | Inference profile, large. |
| I6 | OTEL `0.96.0` | No 0.96.x patch on Hub. Do not jump to 0.140. |
| I6 | `python:3.11.15-slim*` | Repo already floats `3.11-slim` / `3.11-slim-trixie` by policy. |

### Leftovers (not live pins)

| Item | Why left |
|---|---|
| `infrastructure/docker/QDRANT-SETUP.md` `qdrant/qdrant:v1.7.4` | Historical STT Orchestra runbook (`docker-compose.stt-dev.yml` does not exist). |
| `docs/research/deployments/deploy-vm411-gitlab-runner.md` + runner `config.toml` `docker:27` | Research runbook for the runner VM, not GitLab job images. |
| `apps/example/.gitlab-ci.example.yml` `docker:24.0` | Example CI, not the real pipeline. |

### Python agent contract (TASK-700)

| Client (Python) | Server image to match |
|---|---|
| `qdrant-client` **1.19** | **`qdrant/qdrant:v1.19.0`** (dev :6333, test :6335) |
| `temporalio` **1.31** | **`temporalio/server:1.31.2`** (gRPC :7233), UI `temporalio/ui:2.53.1` |

### Files changed

- `infrastructure/docker/docker-compose.dev.yml`
- `tests/docker-compose.test.yml`
- `apps/smr/docker-compose.yml`
- `infrastructure/docker/configs/temporal/development-sql.yaml`
- `infrastructure/docker/configs/temporal/scripts/setup-postgres.sh` (new)
- `infrastructure/docker/configs/temporal/scripts/create-namespace.sh` (new)
- `.gitlab/ci/templates.yml`, `.gitlab/ci/build.yml`, `.gitlab/ci/deploy.yml`
- `infrastructure/README.md`
- `.env.sample`, `apps/harness/.env.sample` (namespace comment only)
- `docs/implementation/TASK-701-Coordinated-Infra-Major-Upgrades/README.md`

Untouched by policy: `pnpm-lock.yaml`, `package.json`, `uv.lock`, Python `pyproject.toml`. Vault 1.21.4, Prometheus v3.13.2, Playwright v1.62.1-noble, uv 0.11.33 unchanged.

Verification: Hub API + imagetools + `docker compose config`. No compose `down -v`. No pipeline run (no commit / push).

### Completion verification (2026-08-16)

Re-checked live pins against this ticket’s scope (I1–I4 required/optional; I5–I6 skip). `docker compose … config --quiet` succeeded for:

- `infrastructure/docker/docker-compose.yml` + `docker-compose.dev.yml` (`--profile temporal --profile observability`)
- `tests/docker-compose.test.yml`
- `apps/smr/docker-compose.yml` (`--profile monitoring`)

Postgres (`timescale/timescaledb-ha:pg18-all`), Redis (`redis:8-alpine`), k3s, and ArgoCD were **not** in this ticket’s requirement list. Documented leftovers (`QDRANT-SETUP.md` v1.7.4, research runner `docker:27`, example CI `docker:24.0`) remain out of live compose/CI.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-15 | Created TASK-701. Landed I1 Qdrant v1.19.0, I2 Temporal server/admin-tools 1.31.2 + UI 2.53.1 (replaced auto-setup), I3 Grafana 13.1.2, I4 docker:28. Skipped I5 Vault 2 / MinIO / vLLM and I6 OTEL / python patch freeze. Status `Review`. |
| 2026-08-15 | Temporal 1.29 volume hop runbook moved to [TASK-702](../TASK-702-Dependency-Blocker-Resolutions/README.md) (`pnpm infra:dev:temporal-hop`). Image pins unchanged. |
| 2026-08-16 | Verified completion against current implementation: I1–I4 pins present, I5–I6 still skipped as scoped, compose config clean. Status `Completed`. |
