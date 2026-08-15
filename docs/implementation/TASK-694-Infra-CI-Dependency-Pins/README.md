# TASK-694 — Infra / CI Dependency Pins

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `infrastructure` |
| **Ticket number** | TASK-694 (TASK-693 already exists as GitLab→GitHub migration; TASK-691 / TASK-692 reserved for TS / Python bump agents) |
| **Classification** | Safe image and CI tool pin bumps. No product-line migrations. No lockfile edits. |
| **Date** | 2026-08-15 |

---

## Requirement Analysis

Bump **stale or EOL image and CI tool pins** that are on the allowlist. Do not migrate product runtimes, do not touch lockfiles owned by the TS / Python agents, and do not take denylisted majors (Vault 2.x, Grafana 13, docker:29, Temporal, MinIO, vLLM, Qdrant, uv, Playwright, pnpm).

Allowlist (this pass):

1. Vault `1.18` → `1.21.2` (or `1.21.9` if that Docker Hub tag exists). Never 2.x.
2. Prometheus `v3.1.0` → `v3.13.2`. Review `prometheus.yml` for 3.1→3.13 config breaks.
3. Grafana `12.4.2` → `12.4.8` only. Never 13.x. Confirm provisioning YAML still valid.
4. Trivy `0.58.2` → `0.74.0`. Never `0.69.4` / `0.69.5` / `0.69.6`. Digest-pin only if other scanners already use digests.
5. gitleaks `v8.21.2` → `v8.30.1`.
6. GitHub Actions harness-eval: Node `20` → `24`. May bump `actions/checkout` / `setup-python` / `setup-node` toward current major `v7`, matching existing tag-vs-SHA style.
7. GitLab CI Node image `node:22-alpine` → `node:24-alpine` to match app Dockerfiles (`NODE_VERSION=24`).
8. nginx `1.27-alpine` → `1.30.4-alpine` in GitLab warm-up and `apps/example/Dockerfile`.
9. alpine CI images `3.20` → `3.22` (conservative; 3.24 optional for tiny notify/deploy jobs).

Hard constraints: no commit, no push, no `DELETE`/`DROP`/`TRUNCATE`, no `docker compose down -v`.

---

## Current State Evaluation

Grep of compose, GitLab CI, GitHub Actions, and the example Dockerfile (2026-08-15) found these live pins:

| Pin | Before | Where |
|---|---|---|
| Vault | `hashicorp/vault:1.18` | `infrastructure/docker/docker-compose.dev.yml` (vault + vault-init), `tests/docker-compose.test.yml` (vault-test + vault-init-test) |
| Vault (already current) | `hashicorp/vault:1.21.2` | `infrastructure/single-deployment/vault` (seal-vault + helm digest overlay) |
| Prometheus | `prom/prometheus:v3.1.0` | compose.dev + `apps/smr/docker-compose.yml` |
| Grafana | `grafana/grafana:12.4.2` | compose.dev + `apps/smr/docker-compose.yml` |
| Trivy | `aquasec/trivy:0.58.2` (tag, no digest) | `.gitlab/ci/scan.yml` (×2), `.gitlab/ci/publish.yml` |
| gitleaks | `zricethezav/gitleaks:v8.21.2` (tag, no digest) | `.gitlab/ci/scan.yml` |
| GitHub Actions | `checkout@v4`, `setup-python@v5`, `setup-node@v4`, Node `20` | `.github/workflows/harness-eval.yml` |
| GitLab Node | `node:22-alpine` | `.gitlab/ci/templates.yml` (`.node-base`, `.test-node-base`) |
| nginx | `nginx:1.27-alpine` | `.gitlab/ci/build.yml` warm-up, `apps/example/Dockerfile` |
| alpine | `alpine:3.20` | `.gitlab/ci/notify.yml`, `.gitlab/ci/deploy.yml` |

Scanner images are **tag-pinned**, not digest-pinned. The only digest-pinned CI image is `gcr.io/projectsigstore/cosign` (signer, not a scanner). App Dockerfiles already use `NODE_VERSION=24` / `node:24-alpine`; GitLab job images were the leftover Node 22 pin.

`prometheus.yml` uses only standard 3.x keys (`global`, `scrape_configs`, `static_configs`, `metric_relabel_configs`). It does not use `scrape_classic_histograms`, native-histogram flags, or `remote_write`. Grafana provisioning is `apiVersion: 1` datasources + file providers — valid on 12.4.x.

---

## Implementation Plan

1. Verify each target tag with `docker buildx imagetools inspect` (and Docker Hub API for Vault 1.21.x).
2. Apply surgical tag replacements in the files above.
3. Review Prometheus / Grafana config; change only if a 3.13 / 12.4.8 incompatibility exists.
4. Leave denylisted pins and lockfiles untouched.
5. Document before/after + skipped tags in this README. Status → `Review`.

Verification (this pass): registry tag existence. No compose volume wipe. No pipeline run (no commit / push).

---

## Implementation Summary

### Tag verification (2026-08-15)

| Target | Result |
|---|---|
| `hashicorp/vault:1.21.9` | **Missing** on Docker Hub (`imagetools`: not found). Hub API lists `1.21`, `1.21.0`–`1.21.4` only. |
| `hashicorp/vault:1.21.2` | Exists. Index digest `sha256:eb0ba6836e8d4699b7a1e8ca70d8433f7b87dcd067e6d82dff237d3ed2600ea0` (matches single-deployment overlay). |
| `prom/prometheus:v3.13.2` | Exists. |
| `grafana/grafana:12.4.8` | Exists. |
| `aquasec/trivy:0.74.0` | Exists. Index digest `sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969`. |
| `zricethezav/gitleaks:v8.30.1` | Exists. |
| `nginx:1.30.4-alpine` | Exists. |
| `alpine:3.22` | Exists. (`alpine:3.24` also exists; not used — conservative 3.22.) |
| `node:24-alpine` | Exists. |
| GitHub Actions `checkout` / `setup-python` / `setup-node` `@v7` | Current majors as of 2026-07. Workflow already used floating tags, not SHAs. `pull_request` (not `pull_request_target`) so checkout v7 fork-PR guard does not apply. |

### Pins applied

| Component | From | To | Files |
|---|---|---|---|
| Vault | `hashicorp/vault:1.18` | `hashicorp/vault:1.21.2` | `infrastructure/docker/docker-compose.dev.yml`, `tests/docker-compose.test.yml` |
| Prometheus | `prom/prometheus:v3.1.0` | `prom/prometheus:v3.13.2` | `infrastructure/docker/docker-compose.dev.yml`, `apps/smr/docker-compose.yml` |
| Grafana | `grafana/grafana:12.4.2` | `grafana/grafana:12.4.8` | `infrastructure/docker/docker-compose.dev.yml`, `apps/smr/docker-compose.yml` |
| Trivy | `aquasec/trivy:0.58.2` | `aquasec/trivy:0.74.0` | `.gitlab/ci/scan.yml`, `.gitlab/ci/publish.yml` |
| gitleaks | `zricethezav/gitleaks:v8.21.2` | `zricethezav/gitleaks:v8.30.1` | `.gitlab/ci/scan.yml` |
| GitHub Node | `20` | `24` | `.github/workflows/harness-eval.yml` |
| GitHub actions | `checkout@v4`, `setup-python@v5`, `setup-node@v4` | `@v7` (tags, matching existing style) | `.github/workflows/harness-eval.yml` |
| GitLab Node | `node:22-alpine` | `node:24-alpine` | `.gitlab/ci/templates.yml` |
| nginx | `nginx:1.27-alpine` | `nginx:1.30.4-alpine` | `.gitlab/ci/build.yml`, `apps/example/Dockerfile` |
| alpine CI | `alpine:3.20` | `alpine:3.22` | `.gitlab/ci/notify.yml`, `.gitlab/ci/deploy.yml` |

Comment-only follow-ups so the pins and the docs that name them stay aligned: `.gitlab/ci/validate.yml`, `.gitlab/ci/vault-login.sh`, `.gitlab/ci/publish.yml` (Trivy version in comments).

### Skipped because the tag did not exist

| Requested | Why skipped | Fallback used |
|---|---|---|
| `hashicorp/vault:1.21.9` | Docker Hub tag not published (images “available soon” as of the 2026-08-05 release note; still absent 2026-08-15). | `1.21.2` as specified. |

`1.21.3` and `1.21.4` exist on Hub but were **not** used — allowlist named `1.21.2` or `1.21.9` only.

### Left unchanged (already on the chosen Vault pin)

`infrastructure/single-deployment/vault` is already `hashicorp/vault:1.21.2` (tag + digest overlay). No patch needed.

### Prometheus / Grafana config notes

**Prometheus `v3.1.0` → `v3.13.2` — no `prometheus.yml` edit.**

- The 3.0 migration breaks (`scrape_classic_histograms` rename, Content-Type strictness, UTF-8 metric names, `remote_write` HTTP/2 default) already apply to 3.1. This file does not use the renamed histogram keys, native-histogram feature flags, or `remote_write`.
- 3.13.0 changelog changes (credential-forwarding on cross-host redirects; native-histogram flag becoming a no-op) do not touch this scrape-only config.
- Compose command flags (`--config.file`, `--storage.tsdb.path`, `--storage.tsdb.retention.time`, `--web.enable-lifecycle`) remain valid.

**Grafana `12.4.2` → `12.4.8` — no provisioning edit.**

- Patch-only bump on the 12.4 line. `datasources/datasource.yml` and `dashboards/dashboards.yml` stay on `apiVersion: 1`. Datasource `uid`s (`hope-prometheus`, `hope-postgres`) and the file provider path `/var/lib/grafana/dashboards` are unchanged. `editable` / `allowUiUpdates` remain accepted on 12.4.x.

### Trivy / gitleaks CLI notes

- Trivy 0.74.0 still accepts `--exit-code`, `--severity`, `--format table|cyclonedx`, `--ignore-unfixed`, `--scanners vuln,secret,misconfig`, `--no-progress`, `--quiet`, `--output`. Did **not** digest-pin: other scanners are tag-only; only cosign is digest-pinned. Avoided 0.69.4–0.69.6.
- gitleaks `detect --no-git` is deprecated-but-supported in 8.30.x (`dir` is the successor). Left the command unchanged so the working-tree gate behaviour stays identical.

### Node 22 → 24 CI scripts

`.node-base` / `.test-node-base` only run `corepack enable`, the pinned pnpm tarball, and `pnpm install --frozen-lockfile`. `NODE_OPTIONS=--max-old-space-size=4096` in `test.yml` is not Node-22-specific. No script assumes Node 22-only APIs. pnpm / corepack tarball **not** changed (owned by the TS agent).

### Denylist (untouched)

Temporal `auto-setup` / Temporal UI, MinIO, vLLM / llama.cpp / TEI, Vault 2.x, Grafana 13, `docker:27`, CUDA bases, Playwright image (`.gitlab/ci/test.yml`), pnpm / `packageManager`, uv `0.11.7`, Qdrant `v1.16`, Postgres / Redis floating tags, `pnpm-lock.yaml`, `package.json`, `uv.lock`, Python `pyproject.toml`.

### Residual risk

- Vault 1.18 → 1.21.2 is a minor-line jump in `-dev` mode. Healthcheck still uses `wget` + `/v1/sys/health`. Existing Vault file volumes (dev named volume) may need a one-time unseal/re-init if storage format differs; test compose is ephemeral (no volume). Do **not** wipe the dev volume without operator approval.
- Trivy 0.58 → 0.74 and gitleaks 8.21 → 8.30 can surface new findings (new rules / DB). That is intended for a scanner bump; first pipeline after merge is the evidence gate.

---

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-08-15 | Infra/CI pin agent | Created TASK-694. Verified tags. Applied allowlisted pin bumps. Vault 1.21.9 skipped (tag missing). Prometheus/Grafana configs unchanged. Status `Review`. |
