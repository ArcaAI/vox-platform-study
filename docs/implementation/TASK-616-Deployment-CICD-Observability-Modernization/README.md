# TASK-616 — Staging Deployment, CI/CD & Observability Modernization

**Status**: Pending (assessment complete, plan awaiting approval)
**Classification**: infrastructure
**Created**: 2026-08-06
**Scope**: `arca/hope-v2-deployment` (k3s manifests) · `hope-v2/.gitlab/ci/**` · observability across dev/staging/prod
**Primary target**: **staging** (Proxmox VM 200 `10.10.1.10`, k3s + GPU passthrough). Production templates are produced but not deployed.
**Supersedes/extends**: [TASK-596 Production Readiness Playbook](../TASK-596-ArcaAI-Production-Readiness/README.md) — that ticket could not audit the manifests because they were "somewhere else". This ticket found them and audited them.

**Appendices**
- [Appendix H — Vault HA Deployment Record](./vault-ha-deployment-2026-08.md) (2026-08-07) — **Track V phase 1 is LIVE**: 3-node Raft on VMs 430-432 + seal-Vault on 434, TLS via an internal CA, Transit auto-unseal **verified against a hard power cycle**. Read §5 before relying on it — the seal-Vault does not auto-unseal, and key material is still on disk
- [Appendix A — 2026 SOTA Research Brief](./sota-research-2026.md) (GitOps, k3s hardening, GPU sharing, supply chain, OTel)
- [Appendix G — Zero-Downtime Deployment & HA](./component-design-zero-downtime-ha.md) — **leads with a 3-line fix that unblocks everything else**: the readiness probe points at an endpoint that always returns 200, so the entire graceful-drain implementation is unreachable code
- [Appendix F — CI/CD, Auto-Deployment & Promotion Pipeline](./component-design-cicd-promotion.md) — **starts with a credential rotation you should do today**; Image Updater's three defects; digest promotion; per-env auto-sync matrix; AppProject gaps
- [Appendix E — Configuration Plane Design](./component-design-config-plane.md) — ConfigMap architecture, the 7 drifted keys and *why* they drifted, CI guardrails, safe `selfHeal` enablement order
- [Appendix D — Execution Plan & Agent Allocation](./execution-plan.md) — **the how**: wave structure, per-task agent tier, concurrency, and what must not be delegated
- [Appendix B — Live Cluster State](./live-state-2026-08.md) (read-only discovery, 2026-08-07) — **read this alongside §2**; it answers §7 Q1/Q3/Q4/Q5/Q6, adds 12 runtime findings (`L-01`…`L-12`), and **corrects §2.5's GPU claim**

---

## 1. Requirement Analysis

The ask, restated:

| # | Requirement | Interpretation |
|---|---|---|
| R1 | "All templates ready for any kind of deployment, for now focusing on staging" | One manifest set that renders correctly for dev/staging/prod, with staging actually working end-to-end and prod being a credible template rather than a stub |
| R2 | "Auto CI/CD following latest best practice" | A working, automated commit→build→deploy path with no human hand-editing image tags, gated by tests and security scans |
| R3 | "Observability ready for production usage with multiple environments including staging" | Metrics + logs + traces from every service, correctly labelled per environment, queryable in one place, with alerting that reaches a human |

Constraints taken as given (not up for redesign): self-hosted GitLab as SCM + registry + CI, Argo CD for GitOps, Rancher for cluster management, k3s on Proxmox with GPU passthrough, Docker. Domain constraint: **multi-tenant healthcare, PHI in scope** — this drives severity ranking throughout.

### Method

Five parallel evidence-based audits (manifests, CI/CD, observability, VM topology) plus a 2026 SOTA research sweep. Every finding below carries a `file:line` citation or a verified live-API observation. Claims that could not be verified from the repos are marked ❓ and listed in §7 rather than guessed at.

---

## 2. Current State Evaluation

### 2.1 Headline finding — there is no working CI→CD path at all

This is not a quality problem. It is a wiring problem, and everything else in this ticket sits downstream of it.

The pipeline's `deploy-staging` job clones a deployment repo, rewrites Helm values, and pushes:

```
DEPLOY_REPO_URL — http://10.10.1.110/arcaai/hope-deployments.git   .gitlab/ci/deploy.yml:27
values_file="apps/${service}/values-staging.yaml"                   .gitlab/ci/deploy.yml:76
git push origin main                                                .gitlab/ci/deploy.yml:90
```

**That repository does not exist.** Verified live against the GitLab API: the instance hosts 11 projects total, there is no `arcaai` namespace, and the only deployment repo is `arca/hope-v2-deployment` — which uses **Kustomize `base/` + `overlays/`**, not the `apps/<svc>/values-staging.yaml` Helm layout the CI job expects. The two artifacts have never been compatible.

The consequence is visible in the deployment repo's git history: **20 of the last 40 commits are hand-typed image-tag bumps** (`update tag`, `update tag: api`, `update stt`) touching only `overlays/dev/kustomization.yaml`. There is no `.gitlab-ci.yml` in that repo at all. So:

- Staging is deployed by a human editing YAML and pushing.
- The `staging` overlay's tags have never been bumped past the mutable `staging-latest` (`overlays/staging/kustomization.yaml:41`).
- The `prod` overlay pins every image to the literal placeholder `"0.0.0"` (`overlays/prod/kustomization.yaml:59-91`) — it has never been deployed.
- **`dev` is the only overlay anyone actually uses**, which means the environment the user calls "staging" (VM 200, hostname `api-staging.taphuynh.dev`) is very likely being served by the `hope-v2-dev` namespace, not `hope-v2-staging`. ❓ Needs live confirmation (§7 Q1).

Three further structural gaps compound it:

1. **No Argo CD `Application`, `ApplicationSet`, or `AppProject` manifest exists in either repo.** The deployment repo carries Argo *annotations* (sync waves on Vault/Temporal, a `PreSync` hook on `db-migrate`) but nothing to interpret them. Whatever Argo CD is running on VM 400 was configured by hand, out of version control.
   > **Refined by live inspection** (Appendix B §B2): Argo CD **is** running and **is** correctly wired to `hope-v2-deployment` at `overlays/dev` with auto-sync, and an `AppProject hope-v2` exists — all hand-created, none in Git. So the *config-repo → cluster* half of GitOps works; only the *CI → config-repo* half is missing. Two live defects, though: the Application reports `OutOfSync`/`Missing` (L-01), and **Argo CD Image Updater is deployed, configured, and has never updated anything** — `images_considered=3 images_skipped=3 images_updated=0`, every 2 minutes, because two of its six image names are stale (L-02, L-03). Fixing it is **S effort** and is the fastest path to R2.
2. **No production deploy job exists.** `prod-*` branches run the full test suite and build every image (`.gitlab/ci/build.yml:22`), then stop. Nothing ships them anywhere.
3. **`deploy-staging` silently skips 3 of 11 services.** Its hard-coded loop (`deploy.yml:75`) omits `admin-console`, `tts`, and `harness` — all three of which are built. Missing files are skipped without warning (`deploy.yml:76-77`).

### 2.2 Deployment manifests — `arca/hope-v2-deployment`

**Inventory**: 24 base manifests covering 11 HOPE workloads + Vault, Temporal, Ollama, and a full Prometheus/Loki/Tempo/Grafana/OTel-Collector stack. Three overlays: `dev` (maintained), `staging` (stub), `prod` (placeholder tags).

**The pattern this repo re-implements was already rejected once.** The monorepo deleted its own k3s tree on 2026-07-24 (`hope-v2/deployment/README.md:5-13`, commit `1de5b8c1`, −2622 lines) explicitly because it used `envFrom: secretRef` plaintext Secrets and `latest` tags. `hope-v2-deployment` reproduces both (`base/api.yaml:29,40-41`), and implements none of the Vault Agent injection contract the monorepo defines as authoritative (`hope-v2/deployment/vault-agent/README.md:12-27`).

**Coverage vs. buildable images**: 11 of 12 built images have a manifest. Gaps:
- `harness` Temporal **worker** has no manifest and no build target — `apps/harness/Dockerfile` only runs `uvicorn`, and `build.yml` has no worker variant (contrast `build-stt-worker`). Per `06-python-services.md` the worker is a separate process that workflows depend on. If it isn't running elsewhere, anything enqueued on `harness-task-queue` never executes. ❓ (§7 Q4)
- `example` has no manifest — correct and expected.
- `ui-playground` has a manifest (`ui.yaml`) that is excluded from `base/kustomization.yaml:27`, yet the prod overlay still carries a dead image override for it.
- **Qdrant appears nowhere** — zero hits repo-wide, despite being a core RAG dependency. Neither deployed nor externalized. ❓ (§7 Q5)

**Defect register — deployment (D)**

| ID | Sev | Defect | Evidence |
|---|---|---|---|
| D-01 | **Critical** | Every secret (DB URLs, `JWT_SECRET_KEY`, provider API keys, MinIO creds) delivered as a plaintext k8s `Secret` via `envFrom`/`secretKeyRef` — base64 in etcd, readable by anyone with namespace read, present in etcd backups | `base/api.yaml:40-41,50-56,80-94`; no `vault.hashicorp.com/agent-inject` anywhere |
| D-02 | **Critical** | Vault is a **single-replica dev instance**: `tls_disable = true`, `storage "file"`, `disable_mlock`. An init Job writes the **root token and all 5 unseal keys in plaintext into a k8s Secret** (`hope-vault-init`) | `base/vault.yaml:21-32,144-158` |
| D-03 | **Critical** | Vault AppRole bootstrap credentials (`VAULT_ROLE_ID`/`VAULT_SECRET_ID`) are themselves delivered via the plaintext Secret — the key to the vault is stored next to the vault | `base/api.yaml:43-56` |
| D-04 | **Critical** | Staging overlay omits `compat-playground` from `images:` → deploys as unqualified `hope-v2/compat-playground:latest`, guaranteed `ImagePullBackOff` | `overlays/staging/kustomization.yaml:38-68` vs `base/compat-playground.yaml:28` (verified by rendering) |
| D-05 | **Critical** | No `nvidia.com/gpu` resource request on any GPU workload. GPU selection uses a **malformed** `NVIDIA_VISIBLE_DEVICES: "nvidia.com/gpu=1"` env var (not valid syntax), and `stt-v2-worker` + `ollama` both claim index 1 with no arbitration | `base/stt-v2.yaml:57-58`, `stt-v2-worker.yaml:55-56`, `ollama.yaml:46-47`; README.md:95 falsely claims GPU requests exist |
| D-06 | **Critical** | `secrets.dev.yaml.example` — the only secret template — has a typo'd Secret name (`hope-registry-credsf`) and omits 5+ keys manifests mark required. Following it verbatim yields `ImagePullBackOff` + `CreateContainerConfigError` | `secrets.dev.yaml.example:49` vs `base/api.yaml:26,85-89`; missing `JWT_SECRET_KEY`, `VAULT_ROLE_ID/SECRET_ID`, `ADMIN_SESSION_SECRET`, `HARNESS_SERVICE_TOKEN` |
| D-07 | **High** | Zero `securityContext` anywhere — no `runAsNonRoot`, no `readOnlyRootFilesystem`, no dropped capabilities, no seccomp. The **only** securityContext in the repo explicitly runs a container as **root** | `grep securityContext` → only `stt-v2.yaml:33-35`, `stt-v2-worker.yaml:33-35`, both `runAsUser: 0` |
| D-08 | **High** | Zero `NetworkPolicy` resources — fully flat pod network on a PHI platform | `grep NetworkPolicy` → no results |
| D-09 | **High** | The Ingress patches every overlay ships for `hope-api`/`hope-ui` target a resource **that does not exist** — silent no-ops. The only real Ingress in the repo is Grafana's. API traffic is NodePort-only, no TLS, no cert-manager anywhere | `overlays/{dev:113,staging:28,prod:39}/kustomization.yaml` vs `base/api.yaml` (no Ingress); `grep "tls:\|cert-manager"` → no results |
| D-10 | **High** | Guardrail points at `http://hope-lmstudio:1234/v1`, a Service deliberately excluded from the base kustomization. SMR correctly uses the raw node IP. DNS fails whenever guardrail's OpenAI-compat path is exercised | `base/guardrail.yaml:62-65`, `base/kustomization.yaml:16`, `base/configmap.yaml:56` |
| D-11 | **High** | Every base image pinned to mutable `:latest`; staging uses mutable `staging-latest`. Violates the project's own rule mandating immutable `staging-<sha8>` + `sha-<sha8>` | all `base/*.yaml`; `overlays/staging/kustomization.yaml:41`; contra `09-infrastructure-devops.md` §Dockerfiles |
| D-12 | **High** | No PDB and no HPA for any workload except `hope-api`, prod-only. Everything else is a single-replica Deployment with no eviction protection | `overlays/prod/{hpa,pdb}.yaml` only |
| D-13 | **High** | `stt-v2-worker` has **no probes at all** — no liveness, readiness, or startup | `base/stt-v2-worker.yaml` |
| D-14 | **Medium** | `CORS_ALLOWED_ORIGINS: "*"` is stale vs. the API's actual code, which does an exact-string `.includes()` match — so `"*"` matches nothing. The bootstrap fallback **denies all browser origins** during exactly the outage it exists to cover | `base/configmap.yaml:12` vs `hope-v2/apps/api/src/cors.config.ts:145-152` |
| D-15 | **Medium** | `smr` OTel env is patched **by array index** (`env/5/value`) — silently patches the wrong variable if the env list is ever reordered, with no CI check | `overlays/dev/kustomization.yaml:84-92` |
| D-16 | **Medium** | Grafana admin password secret key is `optional: true` → falls back to `admin/admin`; advertises `https://grafana.local` with no TLS config backing it | `base/grafana.yaml:36-45,111-130` |
| D-17 | **Medium** | Ollama's readiness/liveness probes fire before its 11-model `ollama pull` loop finishes | `base/ollama.yaml:26-42,53-66` |
| D-18 | **Medium** | No `storageClassName` set on any PVC; STT model cache uses `hostPath`. All state (Vault, Grafana, Prometheus, Loki, Tempo, Ollama) is node-pinned on k3s `local-path` | all PVCs; `base/stt-v2.yaml` volumes |
| D-19 | **Medium** | In-cluster Temporal is deployed but functionally dead — harness is configured against VM-hosted `10.10.1.10:7233` | `base/temporal.yaml` vs `README.md:156-174` |
| D-20 | **Low** | README documents a `base/charts/temporal/` Helm subtree that does not exist on disk | `README.md:32-36` |

### 2.3 CI/CD pipeline — `hope-v2/.gitlab/ci/**`

3,042 lines across 13 files. The engineering is genuinely good in places — the Vault OIDC exchange script with self-revoking short-TTL tokens (`vault-login.sh:199-234`), the BuildKit registry cache, the 5-stage STT Dockerfile with an `ldd` build-time CUDA link gate. The problem is that **the security gates are all switched off and a third of the pipeline cannot fail.**

**Defect register — CI/CD (C)**

| ID | Sev | Defect | Evidence |
|---|---|---|---|
| C-01 | **Critical** | The secret scanner is **entirely commented out**. `.gitleaks.toml` (291 lines, custom HOPE rule pack) exists and is unused. The job header still claims "MUST pass" | `.gitlab/ci/scan.yml:132-176` |
| C-02 | **Critical** | Trivy **cannot fail a pipeline under any configuration** — three independent layers all neutralize it: `--exit-code 0`, then a CRITICAL recheck whose exit code is swallowed by `\|\| echo`, then `allow_failure: true` on the template | `scan.yml:24-38` |
| C-03 | **Critical** | 4 of 6 Python services' test suites are `allow_failure: true` (stt, smr, guardrail, nlp). Their `build-*` jobs `needs:` them, but `allow_failure` makes GitLab treat them as passed — so red tests build and ship | `test.yml:331,388,485,780`; `build.yml:166,185,205` |
| C-04 | **Critical** | `deploy-staging` targets a nonexistent repo with an incompatible layout (§2.1) | `deploy.yml:27,76`; verified against GitLab API |
| C-05 | **High** | `dev-2.1` — the branch carrying most recent work per the ticket history — has **all validate, test, and scan jobs disabled** by a "TEMPORARY" carve-out plus `SKIP_TESTS: "true"`. Any push there builds and can deploy with zero verification | `rules.yml:17-27`, `.gitlab-ci.yml:60-63` |
| C-06 | **High** | No production deploy job exists at all (§2.1) | `deploy.yml` (3 jobs, all staging) |
| C-07 | **High** | `deploy-staging` silently drops `admin-console`, `tts`, `harness` | `deploy.yml:75,125` |
| C-08 | **High** | Shared CI database with a destructive `db:push:force` reset, **no `resource_group:` anywhere in the repo**, and `interruptible: true` inherited — two concurrent pipelines race on one schema, and a cancelled reset leaves it half-migrated for everyone | `prepare.yml:16-104`; `.gitlab-ci.yml:33-34,102-103`; `grep resource_group` → 0 hits |
| C-09 | **High** | Vault OIDC is fully built but **inactive** — `VAULT_ADDR: ""` makes `vault-login.sh` no-op into long-lived masked CI variables. Actual secret custody today is unscoped, unrotated, unaudited project variables | `.gitlab-ci.yml:121`; `vault-login.sh:70-73` |
| C-10 | **High** | Self-documented privilege gap: the Vault deploy role scopes `bound_claims.ref` to `{staging, dev, v*}`, but **neither `staging` nor `dev` is a protected branch** — anyone who can push a branch can mint deploy credentials | `vault.yml:105-119` |
| C-11 | **High** | 7 of 12 built images are **never scanned** — including `guardrail` (the PII/safety engine) and `harness` (clinical documentation) | `scan.yml:42-105` (5 jobs) vs `build.yml` (12 images) |
| C-12 | **Medium** | Turbo cache provides **zero cross-job benefit in CI** — no `TURBO_TOKEN`/remote cache, no `.turbo/` in any `cache:` block. The `database→exceptions→logger→domains→applications` chain is rebuilt from scratch in **6 separate jobs every pipeline** | `grep TURBO_TOKEN` → 0 hits; `validate.yml:44-49`, `test.yml:79-84,113-119,709-714`, `prepare.yml:84-88`, `validate.yml:157-158` |
| C-13 | **Medium** | `COMPAT-*` release tags are unreachable — the top-level `workflow:` tag regex omits `COMPAT`, so no pipeline is ever created, making `build-compat-playground`'s own tag rule dead code | `.gitlab-ci.yml:42` vs `rules.yml:36`, `build.yml:157` |
| C-14 | **Medium** | `hope-python-base` pushes `:latest` — the one image every Python service builds `FROM` is the sole exception to the documented no-`latest` policy | `build.yml:89` |
| C-15 | **Medium** | No coverage collection anywhere despite `test:cov` scripts existing — no cobertura, no MR coverage diff | `grep coverage` across `.gitlab/ci/` → no reports |
| C-16 | **Medium** | Zero `retry:` in the entire pipeline — any transient runner blip is a hard failure | `grep retry:` → 0 hits |
| C-17 | **Medium** | Header comments contradict implementation: claims "manual builds" on staging (no `when: manual` exists on any build job) and semver tag derivation `1.2.3→1.2→1` (not implemented; `templates.yml:127-128` admits it) | `.gitlab-ci.yml:16,22-23`; `rules.yml:11`; `templates.yml:126-146` |
| C-18 | **Medium** | GPU images (`stt-ml-runtime`, `stt-worker`) are built blind — no GPU runner exists (the k8s-executor runner is commented out), and the Dockerfile itself says the CUDA path "must be validated on a GPU CI runner" | `apps/stt/docker/Dockerfile:25`; `deploy-vm411-gitlab-runner.md:744-773` |
| C-19 | **Low** | Build uses socket-bind Docker-outside-of-Docker (`DOCKER_HOST: unix:///var/run/docker.sock`) against a **plaintext HTTP** registry — any `[build]`-tagged job has root-equivalent access to the runner host | `.gitlab-ci.yml:107-110`; `templates.yml:108` |
| C-20 | ~~Low~~ **Medium** | ~~No registry cleanup policy~~ — **CORRECTED 2026-08-07**: a policy *does* exist (`cadence: 7d`, `keep_n: 25`, `older_than: 90d`, `name_regex: ".*"`). The real defect is the opposite of what I first reported: `.*` with no `name_regex_keep` matches **release tags too**, so release images are reaped after 90 days — silently capping the rollback horizon | `GET /projects/6` (live, 2026-08-07); see [Appendix F §F12](./component-design-cicd-promotion.md) |
| C-21 | **High** | **`only_allow_merge_if_pipeline_succeeds: false`** — an MR can be merged with a red pipeline. Every "tests gate the merge" assumption is false at the project level, independent of per-job `allow_failure` | `GET /projects/6` (live) |
| C-22 | **Medium** | **`restrict_user_defined_variables: false`** with `ci_pipeline_variables_minimum_override_role: "developer"` — any Developer can override CI variables (`VAULT_ADDR`, `DEPLOY_REPO_URL`, `SKIP_TESTS`) when triggering a pipeline, on branches that are not protected | `GET /projects/6` (live) |
| C-23 | **Medium** | The **default branch is `dev`** and it is **not protected** — direct pushes to the default branch are unrestricted | `GET /projects/6`, `GET /projects/6/protected_branches` (live) |

**Absent entirely** (a 2026-grade pipeline would have these; this has zero): SBOM generation · image signing (cosign/sigstore) · SLSA/in-toto provenance · dedicated SCA · DAST · pipeline-status notifications (the `notify` stage is a GitHub *mirror*, not a notification) · rollback automation · multi-arch builds · review/ephemeral environments.

### 2.4 Observability

The architecture is better than the reality. A complete Prometheus + Loki + Tempo + Grafana + OTel-Collector stack is deployed, with genuinely well-designed Grafana datasource cross-linking (trace→logs, trace→metrics, logs→traces, `observability-config.yaml:237-293`). **It is almost entirely unfed.**

**Maturity scorecard** (0–5)

| Signal | dev | staging | prod |
|---|---|---|---|
| Metrics | 3 | **1** | **1** |
| Logs | 2 | **2** | **2** |
| Traces | **0** | **1** | **1** |
| Dashboards | 2 | **1** | **1** |
| Alerting | **0** | **0** | **0** |
| Multi-env | 1 | **0** | **0** |
| PHI-safety | 2 | **1** | **1** |

**Defect register — observability (O)**

| ID | Sev | Defect | Evidence |
|---|---|---|---|
| O-01 | **Critical** | The NestJS API's OTel SDK **never starts in staging or prod**. `instrumentation.ts` requires `OTEL_EXPORTER_OTLP_ENDPOINT`; only the **dev** overlay sets it. Staging/prod flip `OTEL_TRACES_ENABLED`, which the code does not read | `hope-v2/apps/api/src/instrumentation.ts:16-21`; `overlays/dev/kustomization.yaml:50-55` vs `overlays/{staging,prod}/kustomization.yaml` |
| O-02 | **Critical** | NLP's real tracing gate is `NLP_OTEL_ENABLED` (default false), distinct from the generic flag the overlays set — **never set in any environment**, so NLP tracing is dead everywhere despite having the most complete OTel code of any service | `apps/nlp/src/nlp/core/config.py:132,176`; `base/nlp.yaml:37-41` |
| O-03 | **Critical** | k8s Prometheus scrapes only **3 of 7** app services (`api`, `stt`, `smr`). Guardrail, NLP, Harness, TTS have zero metrics in staging or prod — same config in all three environments, no overlay patches it | `observability-config.yaml:80-121` |
| O-04 | **Critical** | **Guardrail has zero OpenTelemetry code.** The safety/PII/prompt-injection engine — the most compliance-sensitive service — has no tracing anywhere | `grep opentelemetry apps/guardrail/` → no results; `base/guardrail.yaml:56-57` |
| O-05 | **Critical** | **TTS has zero OTel code and is never scraped** in dev or k8s — its `/metrics` endpoint is a complete orphan | `grep opentelemetry apps/tts/` → no results; absent from both Prometheus job lists |
| O-06 | **High** | `deployment.environment: "dev"` and Prometheus `external_labels.environment: "dev"` are **hardcoded in the shared base config** and never overridden. Any telemetry reaching the collector in staging or prod is **mislabelled as dev** | `observability-config.yaml:27-29,79`; no overlay patches that ConfigMap |
| O-07 | **High** | Harness has no `TracerProvider` at all — only a structlog processor that reads a span that will always be `INVALID_SPAN`. Its manifest doesn't even set `OTEL_SERVICE_NAME` (every other service does) | `apps/harness/src/harness/core/logging.py:16-33`; `base/harness.yaml:37-69` |
| O-08 | **High** | **Nothing ships container logs to Loki.** No Promtail, no Alloy, no Fluent Bit anywhere. The only designed path is app→collector→Loki, which (per O-01) doesn't fire. `kubectl logs` is the only real log access in staging | `grep "promtail\|alloy\|fluent-bit"` → no matches |
| O-09 | **High** | **No alerting layer exists.** No Alertmanager manifest, no Prometheus `rule_files`, no Loki ruler rules, no routing. An incident pages nobody | `base/prometheus.yaml`; `grep alertmanager` → no matches |
| O-10 | **High** | Each namespace gets its own isolated Prometheus/Loki/Tempo/Grafana with **identical fixed datasource UIDs** and ClusterIP-only services. No federation, no remote-write aggregation, no cross-env view. One Grafana cannot serve dev+staging+prod as built | `observability-config.yaml:237-293`; `base/{prometheus,loki,tempo}.yaml` |
| O-11 | **High** | Grafana Ingress host is only patched by the dev overlay — staging and prod both fall back to `grafana.local` and collide | `base/grafana.yaml:111-129`; only `overlays/dev` patches it |
| O-12 | **Medium** | 8 purpose-built dashboards exist in `infrastructure/grafana/dashboards/` but are wired only into a **separate standalone** `apps/smr/docker-compose.yml` Grafana — never packaged into the deployment repo. k8s Grafana ships one dashboard with a single `up` panel | `apps/smr/docker-compose.yml:61-77`; `observability-config.yaml:308-331` |
| O-13 | **Medium** | NLP defines a PHI span-redaction hook but **never wires it** to the instrumentor — dead code. SMR's equivalent is wired but only fires when OTel is on (it isn't, in staging) | `apps/nlp/src/nlp/core/observability.py:34-38` vs `:108-127`; contrast `apps/smr/.../observability.py:108-112` |
| O-14 | **Medium** | No log-field redaction pipeline exists. The only primitive is a `redactFields?` type field that is **declared and never read** | `packages/applications/src/services/baseServices/logging/transports/types.ts:318-319` |
| O-15 | **Medium** | STT hardcodes `"deployment.environment": "production"` in its resource builder regardless of actual environment — an independent mislabelling bug on top of O-06 | `apps/stt/src/stt/core/telemetry.py:44` |
| O-16 | **Medium** | No trace-context propagation across async boundaries — `traceparent` appears only in the CORS allow-list. Redis Streams, SSE, WebSocket, and Temporal hops all break the trace | `grep traceparent` → only `apps/api/src/cors.headers.ts:31` |
| O-17 | **Medium** | Prometheus uses 100% `static_configs` — no `kubernetes_sd_configs`, no Prometheus Operator, no ServiceMonitor CRDs. Every new service requires a manual scrape-target edit | `observability-config.yaml:80-121` |
| O-18 | **Low** | Grafana auth is one shared admin credential, no SSO, no per-user RBAC, no query audit. Dev Grafana additionally enables anonymous Viewer | `base/grafana.yaml:36-41`; `docker-compose.dev.yml:339-341` |
| O-19 | **Low** | No SLOs, error budgets, or on-call runbooks anywhere in `docs/operations/` | `find docs/operations` → 11 files, none observability-related |

### 2.5 Infrastructure reality — what staging actually is

From the `docs/research/deployments/` track (VM 400 master inventory, 2026-03-24):

**Staging = VM 200 `ubuntu-live-gpu` @ `10.10.1.10`** — the only k3s+GPU cluster documented, and its public hostname is literally `api-staging.taphuynh.dev → http://10.10.1.10:30080` (`deploy-ct101-cloudflare-tunnel.md:28`). 16 cores / 48 GB / **2× NVIDIA RTX 2000 Ada 16 GB** via VFIO passthrough, k3s single-node with Traefik + servicelb **enabled** (not disabled), NVIDIA GPU Operator with **time-slicing `replicas: 4` → 8 allocatable GPU slots** (`deploy-vm200-k3s-gpu.md:128-160`).

> **⚠️ Corrected by live inspection** (Appendix B §B5). The time-slicing configuration in `deploy-vm200-k3s-gpu.md` describes an *intended* setup that was **never applied**. Live: `allocatable["nvidia.com/gpu"] = 2` (not 8), **no time-slicing ConfigMap exists**, and **zero pods cluster-wide request `nvidia.com/gpu`**. D-05 is therefore worse than the manifest audit alone suggested — there is no GPU-aware scheduling at all. The GPU Operator itself *is* healthy, and `nvidia-dcgm-exporter` is already running, so the metrics half of step 4.6 is nearly free.

Supporting VMs, all **external to k3s**: GitLab (VM 410, CE 18.8.6 + registry on MinIO S3), Runner (VM 411, 4 Docker-executor runners, **no GPU runner registered**), MinIO (VM 402, **single-node, object data has no backup**), Redis (VM 420 dev / VM 421 staging), Postgres HA (VM 500-502, Patroni + HAProxy + Keepalived VIP `10.10.1.250` + pgBackRest to MinIO). Ingress is a single Cloudflare Tunnel from CT 101 — zero WAN ports open.

**Key infrastructure findings (I)**

| ID | Sev | Finding |
|---|---|---|
| I-01 | **High** | **Zero IaC exists.** Verified by direct filesystem search: no Terraform, no Ansible, no Pulumi, no cloud-init templates. All 14 infrastructure docs are manual SSH runbooks. The only declarative artifact is `deployment/vault-agent/` — a contract reference, not a deployment |
| I-02 | **High** | **There is no documented production cluster.** One k3s+GPU cluster exists (VM 200). The docs never formalize a staging-vs-prod boundary — "AI apps v2 (VM 200)" vs "AI apps v1 (VM 401)" is a *version* split, not an environment split |
| I-03 | **High** | Rancher (VM 400) is documented with `replicas=1` — single-node, not HA. Whether VM 200 was ever actually *imported* into Rancher is written as a procedure, never confirmed done ❓ |
| I-04 | **High** | **Two irreconcilable Vault designs**: a bare-metal 3-VM plan (VMs 430-432, full of unresolved `<SRE: fill…>` placeholders, absent from the current-state inventory) vs. a newer k3s Helm design with Transit auto-unseal. Nothing retires the older doc. And the deployed manifest (D-02) is neither |
| I-05 | **Medium** | MinIO object data has **no backup** — only `.minio.sys` metadata is backed up. PHI recordings and attachments have no recovery path (carried over from TASK-596 D3, still open) |
| I-06 | **Medium** | Three 2026-03-12 infra-planning docs describe a 5-bridge VLAN design with entirely different VM IDs that **was never built** — the live network is a flat single-bridge `10.10.1.0/24`. These docs are actively misleading and should be marked superseded |
| I-07 | **Medium** | Neither Qdrant nor Temporal has any VM deploy doc — both appear only in local dev compose |

### 2.6 Cross-cutting themes

Four patterns explain most of the register:

1. **Documentation asserts capabilities that don't exist.** The deployment README claims CI updates image tags (it doesn't), claims GPU resource requests (there are none), and documents a Helm subtree that isn't on disk. The CI headers claim manual builds, semver derivation, and "nothing ships from red tests" — all three false. **Treat every prose claim in these two repos as unverified until re-checked.**
2. **Controls are built, then switched off.** Gitleaks (`.gitleaks.toml`, 291 lines) — commented out. Vault OIDC (a well-engineered 221-line integration) — `VAULT_ADDR: ""`. Trivy — triple-neutralized. The observability stack — deployed but unfed. The work is largely *done*; the wiring is missing. This is good news for effort estimates.
3. **`dev` is the only environment that works.** Staging and prod overlays are stubs; the observability env label is hardcoded `dev`; the only maintained image tags are dev's. R1's "templates ready for any deployment" is currently "one template that works, two that don't render correctly."
4. **The PHI posture the codebase enforces internally is abandoned at the infrastructure boundary.** The app layer does Vault Transit envelope encryption, 404-over-403 tenancy, and per-tenant credential scoping. The cluster it runs on has plaintext secrets in etcd, a dev-mode Vault holding its own root token in a Secret, a flat pod network, and root-capable containers.

---

### 2.7 The database seed runs unconditionally in every environment — including production

Added 2026-08-07 from [TASK-630](../TASK-630-Database-Migration-Strategy-Per-Environment/README.md). Verified directly:

```sh
# packages/database/migrate.sh
11  if [ "$NODE_ENV" = "production" ] || [ "$NODE_ENV" = "staging" ]; then
13    prisma migrate deploy
14  else
16    prisma db push
17  fi
19  echo "Running database seed..."          ← OUTSIDE the if/else
20  tsx packages/database/dist/index.js      ← full 25-phase seed, EVERY run
```

The migration mechanism is correctly environment-aware. **The seed is not.** All 25 phases run after every migration, in every environment, on every Argo sync.

| ID | Sev | Defect | Evidence |
|---|---|---|---|
| **DB-01** | **Critical** | **`seedAuditLog` writes fabricated rows into the HIPAA audit trail**, using `upsert` with `update: entry` — so it also *overwrites* existing rows with those ids on every run. Synthetic records in a tamper-evident log is a compliance problem, not a config problem | `seed/10-audit-log.ts:377-389` |
| **DB-02** | **Critical** | **`seedConsultation` writes synthetic Vault-encrypted PHI** to whatever database it runs against | `seed/09-consultation.ts:1399-1500` |
| **DB-03** | **High** | 14 of 25 phases overwrite live configuration. `11-global-setting.ts:621-627` writes `value` in the `ALL_SETTINGS` loop while the `PLATFORM_SETTINGS` loop 40 lines below (`:661`) correctly omits it — the same file gets it right and wrong. `91-user.ts:1042` force-repoints the default STT pipeline on every sync | as cited |
| **DB-04** | — | **Mitigating**: 9 phases are already correctly create-only (`11a`, `12`, `14`, `15`, `16`–`19`, `05c`). The codebase already knows the right pattern; it just isn't applied uniformly | as cited |

| **DB-05** | **Critical** | **The `SEED_DEMO_DATA` guard is unreachable.** `deployment/k8s/base/db-migrate.yaml:27-32` gives the Job only `DATABASE_URL` — **no `envFrom`** — so `NODE_ENV` is *absent* in the migrate container. `getNodeEnv()` (`src/env.ts:55-61`) falls back to `'development'`, so `shouldSeedApiKeys()` returns **true** and demo API keys carrying **raw secrets, ACTIVE and broadly scoped** are seeded. The same absence also sent **every** environment — production included — down the `db push` branch, which alters schema with no migration record | `db-migrate.yaml:27`, `src/env.ts:55`, `seed/02-apikey.ts:17` |

Found 2026-08-07 while implementing the fix. DB-05 is the one that reframes the rest: the guard against demo credentials in production existed, was correct, and was defeated by the same missing variable that broke the migration mechanism.

#### ✅ Fixed 2026-08-07 — commit `5b2e1b83`

`RUN_SEED=all|safe|none`, **defaulting to `none`**, in `seed/seed-mode.ts`:

- `seed()` resolves the mode **before** creating a client — `RUN_SEED` unset opens no connection and writes nothing.
- `all` is **refused unless `NODE_ENV` is explicitly `development` or `test`**. An *absent* `NODE_ENV` is refused, never defaulted — that is DB-05 closed at the code layer, so the fix holds even while the Job still lacks `NODE_ENV`.
- `safe` skips `02-apikey`, `08-dna-writing-style`, `09-consultation`, `10-audit-log` and `91-user`, leaving platform configuration only.
- `migrate.sh` now always runs `migrate deploy`; the `db push` branch is gone.

Evidence: 994/994 package tests pass, typecheck clean, both new guards mutation-tested (each fails when its branch is removed), and verified end-to-end through the real `dist` entrypoint.

⚠️ **Consequence to action**: deployed environments now seed **nothing** until `RUN_SEED` is set. That is deliberate. A dev overlay wanting fixtures must set `RUN_SEED=all` **and** `NODE_ENV=development`; a production bootstrap wants `RUN_SEED=safe`. The `db-migrate` Job still needs `NODE_ENV` wired in (`envFrom` the `hope-config` ConfigMap) — tracked as the remaining half of DB-05.

Note `safe` seeds **no users at all**, so a production bootstrap must provision its first admin rather than inherit a seeded credential. That is the correct posture, but it is a decision worth confirming before the first production sync.

---

## 3. Gap Analysis vs. 2026 SOTA

Full research in [Appendix A](./sota-research-2026.md). The deltas that matter here:

| Area | SOTA (2026) | HOPE today | Delta |
|---|---|---|---|
| CI→CD handoff | CI commits a **digest** to the config repo; Argo reconciles | CI writes to a nonexistent repo; humans hand-edit tags | **No handoff at all** |
| Argo structure | ApplicationSet (git generator) + AppProject per env, sync waves, PreSync migrations, `ignoreDifferences` | Annotations only; no Application/AppProject in Git | Argo config is un-versioned |
| Secrets | Vault Agent Injector / VSO; ESO for static KV only | Plaintext k8s Secrets | Contract exists (`deployment/vault-agent/`), unimplemented |
| k3s hardening | `secrets-encryption`, PSA `restricted`, audit log, kubelet flags | ❓ unverified; no PSA labels in manifests | Unknown → must verify (§7 Q2) |
| Network | Default-deny NetworkPolicy per namespace (Kyverno-generated) | None | Full gap |
| GPU | GPU Operator + `nvidia.com/gpu` requests + DCGM metrics | Operator **is** installed; manifests don't use it; no DCGM | Half-built |
| Supply chain | cosign keyless + SBOM + blocking Trivy + admission verification | None of the four | Full gap |
| Logs | Grafana Alloy (**Promtail EOL 2026-03-02**) | No shipper at all | Skip Promtail entirely |
| Multi-env telemetry | `deployment.environment.name` + `service.namespace` + per-env `X-Scope-OrgID` | Hardcoded `"dev"` everywhere | Full gap |
| Alerting/SLO | Alertmanager + Sloth SLO-as-code | Nothing | Full gap |

One SOTA recommendation is **explicitly declined**: Argo Rollouts (canary/blue-green). Blue-green needs 2× concurrent resources on a single GPU-passthrough VM with no headroom, and canary needs traffic-splitting infrastructure that doesn't exist. Revisit only when prod is multi-node.

---

## 4. Implementation Plan

Nine workstreams over six phases. Phase 0 is a **hard gate** — it contains decisions only the owner can make, and several later workstreams branch on the answers.

Effort: **S** ≤1 day · **M** 2–5 days · **L** >1 week. Total ≈ 6–8 weeks of focused work; Phases 0–2 (≈2 weeks) get staging to "correct and safe" and are the minimum viable slice.

### Phase 0 — Decisions & ground truth (gate) · S

No code. Resolves the ambiguities in §7 and establishes what is actually running.

| Step | Verify |
|---|---|
| 0.1 Answer §7 Q1–Q8 with the owner | All eight answered in writing, appended to §7 |
| 0.2 Live cluster inventory on VM 200: `kubectl get ns,all -A`, `kubectl get nodes -o yaml`, k3s flags, Argo CD Applications, Rancher import status | A written snapshot committed to this ticket folder as `live-state-2026-08.md` |
| 0.3 Decide the config-repo shape (see below) | Decision recorded; Phase 1 unblocked |

**The one decision that shapes everything else — config repo layout.** Three options:

| Option | Description | Recommendation |
|---|---|---|
| **A** | Keep `arca/hope-v2-deployment` (Kustomize) as the single config repo; **rewrite `deploy-staging`** to edit `overlays/<env>/kustomization.yaml` | ✅ **Recommended** — the Kustomize tree already exists, is complete, and matches Appendix A §A3's guidance. Cheapest path to a working handoff |
| B | Create `arcaai/hope-deployments` with the Helm layout CI expects | Rejected — builds a second config repo from scratch and abandons 24 working manifests |
| C | Hybrid: Kustomize for in-house services, Helm for vendored charts (GPU Operator, Kyverno, Prometheus Operator), composed via `helmCharts:` | ✅ **Adopt as the Phase 3 end-state**, layered on top of A |

Plan below assumes **A → C**.

### Phase 1 — Make staging render and run correctly · M

Closes the defects that make staging non-functional today. No new capability, just correctness.

| Step | Closes | Verify |
|---|---|---|
| 1.1 Add `compat-playground` to the staging `images:` list; audit all three overlays for image-list completeness | D-04 | `kubectl kustomize overlays/staging \| grep -c "image:.*hope-v2"` matches the workload count; no unqualified image names |
| 1.2 Replace `NVIDIA_VISIBLE_DEVICES` env hack with `resources.limits."nvidia.com/gpu": 1` on `stt-v2`, `stt-v2-worker`, `ollama` (the cluster already exposes 8 time-sliced slots) | D-05 | `kubectl describe node` shows correct GPU allocation; all three pods Running with GPU visible via `nvidia-smi` in-container |
| 1.3 Add liveness/readiness/startup probes to `stt-v2-worker`; fix Ollama probe timing with a startup probe sized for the model-pull loop | D-13, D-17 | Rolling restart of each; no premature `Ready` |
| 1.4 Author a real `Ingress` for `hope-api`, `admin-console`, `compat-playground` (Traefik ingressClass, matching VM 200's actual setup) and delete the three dead Ingress patches | D-09 | The rendered output of all three overlays contains the Ingress; `curl` through the Cloudflare tunnel reaches the API by hostname, not NodePort |
| 1.5 Point guardrail at the same LM Studio address SMR uses | D-10 | Guardrail's OpenAI-compat path resolves; no NXDOMAIN in logs |
| 1.6 Fix `CORS_ALLOWED_ORIGINS` to a real origin list (not `"*"`) | D-14 | Browser request from the admin-console origin succeeds with the DB registry disabled |
| 1.7 Regenerate `secrets.dev.yaml.example` **from the manifests** (script it) so the key set cannot drift; fix the `hope-registry-credsf` typo | D-06 | A CI check renders all overlays and asserts every `secretKeyRef` without `optional: true` exists in the example |
| 1.8 Replace index-based Kustomize patches with name-based ones | D-15 | Reordering an env list in a base manifest does not change rendered output |
| 1.9 Delete the dead `ui-playground` manifest + prod override; fix the README's false claims (CI tags, GPU requests, `base/charts/temporal/`) | D-20, theme 1 | README claims match `git grep` reality |
| 1.10 **Add a `.gitlab-ci.yml` to the deployment repo**: `kustomize build` all three overlays + `kubeconform` schema validation + a policy check, on every push | — | A malformed overlay fails CI instead of failing at sync time |

### Phase 2 — PHI security baseline · M

The highest compliance-per-effort work in the ticket. Appendix A §A5, §A8.

| Step | Closes | Verify |
|---|---|---|
| 2.1 Verify/enable k3s hardening on VM 200: `secrets-encryption`, `protect-kernel-defaults`, apiserver audit logging, kubelet flags, `system-reserved`. **Store the join token in Vault** (snapshot restore depends on it) | SOTA gap | `k3s check-config`; CIS profile output captured as evidence; a test Secret is confirmed encrypted at rest |
| 2.2 Label all namespaces `pod-security.kubernetes.io/{enforce,warn,audit}: restricted`; add `securityContext` (`runAsNonRoot`, `readOnlyRootFilesystem`, `drop: [ALL]`, seccomp `RuntimeDefault`) to every workload. Fix the root init containers in `stt-v2*` | D-07 | Every pod starts under `restricted`; zero PSA warnings in the audit log |
| 2.3 Deploy Kyverno; generate a default-deny NetworkPolicy per namespace (`synchronize: true`) plus explicit allow rules per service dependency graph | D-08 | A `kubectl exec` curl from `nlp` to `vault` is refused; the documented service graph still functions end-to-end |
| 2.4 **Migrate secrets to Vault Agent injection**, implementing the contract in `hope-v2/deployment/vault-agent/`: per-service ServiceAccount → Vault role, memory-backed `emptyDir`, no `envFrom: secretRef` | D-01, D-03 | `kubectl get secret hope-secrets` no longer exists; every service starts with secrets sourced from the injected file |
| 2.5 Replace the dev-mode Vault with a real deployment (TLS, Raft, auto-unseal). **Resolve I-04 first** — pick one of the two competing designs. Add a Raft snapshot CronJob | D-02, I-04 | Vault reports `sealed: false, ha_enabled: true`; a snapshot is taken and **one restore is rehearsed** |
| 2.6 Automate the k3s datastore backup and **rehearse one full restore** | SOTA gap | A restore drill is performed and documented — an untested backup is not a backup |
| 2.7 Protect the `dev` and `staging` branches in GitLab so the Vault deploy role's `bound_claims.ref` scoping becomes real | C-10 | A push to `staging` from a non-maintainer is rejected |

### Phase 3 — Real GitOps CI/CD · L

Delivers R2. Appendix A §A1, §A2.

| Step | Closes | Verify |
|---|---|---|
| 3.1 Rewrite `deploy-staging` to target `arca/hope-v2-deployment`, editing `overlays/staging/kustomization.yaml` **with `kustomize edit set image` pinned to the image digest**, not a tag. Cover all 11 services (add admin-console, tts, harness) | C-04, C-07, D-11 | A push to `staging` produces a commit in the deployment repo with digest-pinned images for every service; **zero hand-edited tag commits thereafter** |
| 3.2 **Commit Argo CD `AppProject` + `ApplicationSet`** (git generator over `overlays/*`) to the deployment repo. Sync waves for ordering; `PreSync` for `db-migrate`; `ignoreDifferences` for HPA `spec.replicas` and Vault-injector annotations; `ServerSideApply=true` | §2.1 gap 1 | `argocd app list` shows apps created from Git, not by hand; deleting an app and re-syncing the ApplicationSet recreates it |
| 3.3 Add `deploy-production` mirroring staging, with `environment: production` and a **manual approval gate** | C-06 | A `prod-*` pipeline exposes a manual deploy job; the prod overlay's `"0.0.0"` placeholders are replaced by real digests |
| 3.4 Write and **rehearse** the rollback runbook (revert the config-repo commit → Argo self-heals). Add Argo CD Notifications for `OutOfSync`/`Degraded`/sync failure | §2.1, O-09 partial | One rollback is performed end-to-end against staging and timed |
| 3.5 Remove the `dev-2.1` validation carve-out, or time-box it with a documented expiry | C-05 | `rules.yml` has no unconditional skip fragment; `SKIP_TESTS` is gone |
| 3.6 Fix CI hygiene: `resource_group` on DB-touching jobs + per-pipeline DB naming; `retry` for `runner_system_failure`; add `COMPAT` to the workflow tag regex; drop `:latest` from `hope-python-base`; correct the false header comments | C-08, C-13, C-14, C-16, C-17 | Two concurrent pipelines on different branches both pass; a `COMPAT-*` tag creates a pipeline |
| 3.7 Turbo remote cache (or an artifact-cached `dist/`) so the package chain builds **once** per pipeline instead of six times | C-12 | Pipeline wall-clock measured before/after; the 5-package build appears once |
| 3.8 Register the GPU runner (k8s executor against VM 200) and add a smoke job that runs the built STT image with `--device` to prove the CUDA link | C-18 | A CI job executes `python -c "import torch; assert torch.cuda.is_available()"` inside the built image |

### Phase 4 — Observability for real, multi-environment · L

Delivers R3. Appendix A §A9. **Order matters: 4.1 before 4.3** — redaction must be in place before broad tracing turns on.

| Step | Closes | Verify |
|---|---|---|
| 4.1 Move the OTel Collector to **agent DaemonSet + gateway Deployment**; put the `redaction` processor and an **attribute allowlist** (not a denylist) at the gateway. Add tail sampling and a memory limiter | O-08 partial, PHI | A span carrying a deliberately-planted PHI-shaped attribute is confirmed dropped at the gateway before Tempo |
| 4.2 Parameterize the environment: `deployment.environment.name` + `service.namespace` + `k8s.cluster.name` as **overlay-patched** values; set `X-Scope-OrgID` per environment on the exporters. Fix STT's hardcoded `"production"` | O-06, O-15 | Telemetry from the staging namespace carries `deployment.environment.name=staging`; no `dev` labels outside dev |
| 4.3 Turn tracing on for every service: set `OTEL_EXPORTER_OTLP_ENDPOINT` in **all** overlays; set `NLP_OTEL_ENABLED`; **add OTel to guardrail and tts** (currently zero code); add a `TracerProvider` to harness | O-01, O-02, O-04, O-05, O-07 | A single request produces one connected trace spanning gateway → ≥2 Python services in Tempo |
| 4.4 Propagate trace context across async boundaries — W3C `traceparent` through Redis Streams, SSE, WebSocket, and Temporal (Temporal ships an OTel interceptor) | O-16 | A trace survives an STT streaming session and a Temporal workflow end-to-end |
| 4.5 Deploy **Grafana Alloy** (never Promtail — EOL 2026-03-02) as the container-log shipper into Loki, with trace-correlated structured logs | O-08 | `kubectl logs` output is queryable in Loki within seconds, with a clickable trace link |
| 4.6 Complete metrics coverage: scrape all 7 services (add guardrail, nlp, harness, tts), plus **DCGM exporter** for GPU. Move from `static_configs` toward Prometheus Operator ServiceMonitors | O-03, O-17 | All 7 `/metrics` targets `up`; GPU utilization/memory/temperature visible per-pod |
| 4.7 Implement the log-redaction pipeline the logging package only declares (`redactFields`); wire NLP's dead redaction hook | O-13, O-14 | A unit test asserts a PHI-shaped field is redacted before transport |
| 4.8 Package the 8 existing dashboards into the deployment repo as provisioned ConfigMaps; fix the Grafana Ingress-host collision; replace `optional: true` on the admin password | O-11, O-12, O-16 | Every dashboard loads in the staging Grafana with live data; each env has a distinct hostname |
| 4.9 Decide and implement the cross-environment view: **one Grafana + Mimir/Loki/Tempo with `X-Scope-OrgID` tenancy** (recommended) vs. per-env Grafana with a mixed datasource | O-10 | One Grafana can chart the same metric for dev and staging side by side |
| 4.10 Alerting: deploy **Alertmanager** with the minimal alert set (Appendix A §A10) and **at least one working route to a human**. Then define 2–3 real SLIs and generate SLOs via Sloth | O-09, O-19 | A deliberately-failed pod produces an alert that arrives in the destination channel |

### Phase 5 — Supply chain · M

Appendix A §A7. The realistic healthcare minimum bar — not SLSA L3.

| Step | Closes | Verify |
|---|---|---|
| 5.1 **Re-enable `scan-gitleaks`** (uncomment; the ruleset is already good) | C-01 | A planted test secret fails the pipeline |
| 5.2 Make Trivy blocking: remove `\|\| echo`, set `--exit-code 1`, drop `allow_failure`. Extend to **all 12 images** | C-02, C-11 | A known-CRITICAL base image fails the build |
| 5.3 Un-`allow_failure` the four Python test suites — fix the underlying infra gap rather than muting the signal | C-03 | A deliberately broken STT test fails `build-stt` |
| 5.4 cosign **keyless** signing via GitLab OIDC (`id_tokens: {SIGSTORE_ID_TOKEN: {aud: sigstore}}`, cosign ≥2.0) on every pushed image | supply chain | `cosign verify` succeeds for a freshly built image |
| 5.5 CycloneDX SBOM per image, attached as an in-toto attestation | supply chain | SBOM retrievable for any deployed digest |
| 5.6 Kyverno admission policy rejecting unsigned images outside dev | supply chain | An unsigned image is refused admission in `hope-v2-staging` |
| 5.7 Registry cleanup policy scoped to `dev-*`/`staging-*` tags (never release tags) | C-20 | Registry storage growth flattens |
| 5.8 Activate Vault OIDC in CI (set `VAULT_ADDR`) — the integration is already built and self-revokes | C-09 | A test job obtains a secret via OIDC; the Vault audit log shows the token revoked at job end |

### Phase 6 — Production templates & documentation · M

Delivers the "any kind of deployment" half of R1 without deploying prod.

| Step | Verify |
|---|---|
| 6.1 Make manifests dual-shape: `preferredDuringScheduling` anti-affinity everywhere (never `required`), PDBs with `minAvailable < HPA.minReplicas`, HPAs on all stateless services | The same base renders and schedules on single-node staging **and** passes a dry-run against a simulated multi-node prod |
| 6.2 Adopt the Phase-0 Option C hybrid: vendored Helm charts (GPU Operator, Kyverno, Prometheus Operator, Alloy) composed via `helmCharts:`, in-house services stay Kustomize | `kustomize build --enable-helm` renders the full stack from one entry point |
| 6.3 Write the operations docs that don't exist: `docs/operations/deployment/` (staging runbook, rollback, k3s upgrade with the passthrough-VM downtime caveat, GPU time-slicing re-tuning) and `docs/operations/observability/` (on-call, alert response, SLOs) | A new engineer can deploy and roll back staging from the docs alone |
| 6.4 Mark the superseded infra research docs (I-06) as historical; reconcile `09-infrastructure-devops.md` with reality (it still describes the deleted `deployment/k3s/` tree) | No rule file or doc describes a path that no longer exists |
| 6.5 Close out the still-open TASK-596 P0s that this ticket does not otherwise cover: MinIO object-data backup (I-05), Postgres restore drill, tenant storage credentials in Vault | Each row in TASK-596 §4 is either done or explicitly deferred with a date |

### Phase 7 — Missing components: Vault HA, Qdrant, harness worker · L

Designs are complete in [Appendix C](./component-designs.md) and [`component-design-qdrant.md`](./component-design-qdrant.md). This phase builds them. **Phase 7.1 is blocked on owner action** — see §9.

| Step | Verify |
|---|---|
| 7.1 **Vault HA on VMs 430-432 (+434 seal-Vault)** per [C1](./component-designs.md). Amendments to the runbook: Transit auto-unseal (not manual Shamir), v1.21.2, and reuse of the existing `infrastructure/single-deployment/vault/` auth/policy layer. **Owner must provision the VMs — I have no Proxmox access** | 3/3 unsealed, Raft quorum healthy, audit device enabled, one **rehearsed** snapshot restore |
| 7.2 Enable Vault **Kubernetes auth** for the 6 Python services + per-service roles/policies; keep AppRole for `hope-api` only (its client implements nothing else) | `kubectl get secret hope-secrets` no longer carries a Vault credential; each service starts with secrets from an injected file |
| 7.3 Deploy the **Vault Agent Injector** into k3s pointed at the external Vault; roll out `deployment/vault-agent/reference-deployment.yaml`-shaped manifests for the 6 services | No `envFrom: secretRef` remains on any Python service |
| 7.4 **Migrate secrets off the dev Vault** — scripted export (file backend cannot be Raft-snapshotted), then **rotate everything** that was ever in the plaintext Secrets. That rotation *is* the security boundary of this migration | Old Vault + both plaintext Secrets deleted; a GlobalSetting read/write and a login both succeed against the new Vault |
| 7.5 **Deploy Qdrant** (StatefulSet + Service + the missing `qdrant-init` provisioning Job) and register it in the base kustomization | `knowledge_chunks` exists with the correct dense/sparse vector shape and payload indexes |
| 7.6 **Add Qdrant auth** — this needs a *code* change: `KnowledgeQdrantStore.__init__` does not accept an `api_key` today | Qdrant rejects an unauthenticated query; harness still retrieves successfully |
| 7.7 **Build the harness Temporal worker**: Dockerfile `worker` target, `build-harness-worker` CI job with a **non-optional** `needs: test-harness`, and `harness-worker.yaml` with heartbeat-file exec probes | A `HarnessDocWorkflow` started via the API actually executes to completion |
| 7.8 **Resolve the two Temporal servers** — retire the host-Docker pair, point everything at in-cluster `hope-temporal`. Zero migration risk: nothing has ever consumed the queue | One Temporal server remains cluster-facing; `TEMPORAL_ADDRESS` is in Git, not just live |

### Phase 8 — Staging, production, and AWS-portable structure · L

Delivers the "all three environments production-ready" and "AWS-compatible" requirements. Full analysis in [`component-design-aws-portability.md`](./component-design-aws-portability.md).

| Step | Verify |
|---|---|
| 8.1 Restructure the config repo into **Kustomize `components/`** so `base/` is genuinely cloud-agnostic: `storage-k3s` / `storage-aws`, `ingress-k3s` / `ingress-aws`, `gpu-passthrough` / `gpu-karpenter`, `secrets-vault-agent` | `kustomize build` produces a correct render for both a k3s overlay and an EKS overlay from one base |
| 8.2 Give every PVC an explicit `storageClassName`; replace the STT `hostPath` model cache with a PVC | No implicit-default PVC remains; the same manifest works on `local-path` and on EBS gp3 |
| 8.3 Create a real **`hope-v2-staging`** namespace + overlay + Argo Application, with digest-pinned images promoted from dev | A commit to the staging overlay deploys without hand-editing; all 11 workloads Healthy |
| 8.4 Author the **production** overlay as a genuine template (not `"0.0.0"` placeholders): PDBs, HPAs, `preferred` anti-affinity, resource tiers | A dry-run render passes against a simulated multi-node cluster |
| 8.5 Decide and document the **hybrid boundary** — control plane (Postgres→RDS, Redis→ElastiCache, MinIO→S3, Vault with KMS auto-unseal, CPU services) is AWS-portable; **GPU inference stays on-prem** at roughly 4–8× cost saving. The app already speaks native S3 via `S3Client`, so object storage is a credential change, not a code change | A written decision record with the cost basis |
| 8.6 HIPAA-on-AWS baseline: BAA scope, HIPAA-eligible service list, multi-account landing zone, Pod Identity over IRSA, encryption/audit controls | A gap list against the technical safeguards, not a claim of compliance |

### Suggested sub-ticket split

Phases map cleanly to standalone tickets if the work is parallelized:

| Ticket | Scope | Depends on |
|---|---|---|
| TASK-616 | This assessment + Phase 0 (done) | — |
| TASK-617 | Phase 1 — `hope-v2-dev` correctness + live-incident triage | 616 |
| TASK-618 | Phase 2 — PHI security baseline (k3s hardening, PSA, NetworkPolicy) | 616 |
| TASK-619 | Phase 3 — GitOps CI/CD (Image Updater repair, direct Argo registration, Argo config into Git) | 616, 617 |
| TASK-620 | Phase 4 — observability | 617 |
| TASK-621 | Phase 5 — supply chain | 619 |
| TASK-622 | Phase 6 — portability hygiene + operations docs | 617–621 |
| TASK-623 | Phase 7a — **Vault HA** (VMs 430-432/434) + auth migration | 616, owner VM provisioning |
| TASK-624 | Phase 7b — **Qdrant** deployment + auth code change | 617 |
| TASK-625 | Phase 7c — **harness Temporal worker** + Temporal consolidation | 617, 619 |
| TASK-626 | Phase 8 — **staging + production environments** and the AWS-portable component structure | 617–625 |

### Follow-up tickets spun out 2026-08-07

Created from findings in this assessment. Numbered from 627 so the 617–626 range stays reserved for the phased work above.

| Ticket | Scope | Triggered by |
|---|---|---|
| [TASK-627](../TASK-627-Service-Health-Probes-And-Lifecycle-Standards/README.md) | Service health, probe & lifecycle standards across all 11 services + Prometheus/Grafana/k8s integration | The always-200 probe defect ([Appendix G §G0](./component-design-zero-downtime-ha.md)) |
| [TASK-628](../TASK-628-STT-Pipeline-Production-Readiness-And-Test-Coverage/README.md) | STT SDK→backend end-to-end review + production-scenario test coverage as a CI/CD entry gate | Lost clinical speech on gateway restart ([Appendix G §G2](./component-design-zero-downtime-ha.md)) |
| [TASK-629](../TASK-629-Branch-Model-Vault-Boundary-And-Release-Gates/README.md) | Branch model (`dev-*`/`staging-*`/`prod-*`/`production-*`), Vault CI boundary, release gates | Vault `bound_claims` matching nothing real ([Appendix F §F10](./component-design-cicd-promotion.md)) |
| [TASK-630](../TASK-630-Database-Migration-Strategy-Per-Environment/README.md) | Per-environment migration strategy + the DevOps deployment runbook template | The unconditional seed and unenforced expand/contract ([Appendix G §G5](./component-design-zero-downtime-ha.md)) |

### Sequencing note

Phases 1–3 are the critical path — everything else depends on a correct, version-controlled `hope-v2-dev` and a working CI→CD loop. Phase 7a (Vault) can run fully in parallel because it is VM work, and it is the **longest lead time** since it needs VM provisioning the owner must do. Start it early.

---

## 5. Verification Criteria

Infrastructure work has no unit tests, so "tests first" becomes **gates first** — every phase adds an automated check that would have caught the defect it fixes.

**Per-phase gates**

| Phase | Automated gate added |
|---|---|
| 1 | Deployment-repo CI: `kustomize build` × 3 overlays + `kubeconform` + image-completeness assertion + secret-key-parity check |
| 2 | Kyverno policy reports clean; PSA `restricted` produces zero audit warnings; `conftest`/Kyverno CLI runs in the deployment repo's CI |
| 3 | A push to `staging` produces a digest-pinned config-repo commit with **no human involvement**; Argo reports Synced+Healthy |
| 4 | Synthetic request produces one connected trace across ≥3 services; a planted PHI attribute is confirmed dropped; a forced failure produces an alert that arrives |
| 5 | Planted secret fails CI; known-CVE image fails CI; unsigned image refused admission |
| 6 | Base renders correctly for both single-node and multi-node topologies |

**Definition of done for the ticket as a whole**

- [ ] Staging deploys end-to-end from a `git push` with zero hand-edited YAML, and the commit is digest-pinned
- [ ] All 11 workloads Running and Healthy in `hope-v2-staging`, all probes green
- [ ] Argo CD `AppProject` + `ApplicationSet` are in Git; deleting an Application and re-syncing recreates it
- [ ] No plaintext `Secret` carries application credentials; Vault reports unsealed + HA, with a **rehearsed** restore
- [ ] Default-deny NetworkPolicy in every namespace; every pod passes PSA `restricted`
- [ ] One connected trace spans gateway → Python services; logs are in Loki with trace links; all 7 services scraped; GPU metrics visible
- [ ] Telemetry is correctly labelled per environment; one Grafana serves dev + staging
- [ ] At least one alert route is proven to reach a human
- [ ] Gitleaks and Trivy both **block** the pipeline; images are signed and admission-verified
- [ ] Rollback runbook written **and rehearsed once**, with a measured time
- [ ] Every ❓ in §7 is resolved; `live-state-2026-08.md` committed

---

## 6. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Phase 2.4 (Vault injection) breaks every service at once | Medium | High | Migrate one service (`nlp`, lowest blast radius) end-to-end first; keep the plaintext Secret in place until all services are cut over, then delete |
| Enabling PSA `restricted` makes pods unschedulable (STT's root init containers) | High | Medium | Roll out `warn`+`audit` first, fix everything the audit log surfaces, then flip `enforce` |
| `secrets-encryption` on k3s without the join token in Vault → unrestorable snapshots | Low | **Critical** | 2.1 explicitly stores the token in Vault *before* enabling; verify with a restore drill in 2.6 |
| GPU resource requests (1.2) reduce effective GPU slots and starve a service | Medium | Medium | Time-slicing already exposes 8 slots for 3 consumers; measure with DCGM (4.6) before and after; time-slicing has **no memory isolation**, so validate concurrent ASR+LLM+TTS load explicitly |
| Digest pinning (3.1) makes rollback less obvious to humans | Low | Low | Rollback runbook (3.4) uses `git revert` on the config repo, not tag surgery |
| Turning tracing on (4.3) leaks PHI into Tempo | Medium | **Critical** | Hard-ordered: 4.1 (gateway redaction + allowlist) ships and is verified **before** 4.3 |
| k3s upgrade on a GPU-passthrough VM requires real downtime (no live migration) | Certain | Medium | Document as a known staging constraint in 6.3; plan prod's GPU allocation model accordingly |
| Argo auto-sync + selfHeal fights the Vault injector webhook | Medium | Medium | `ignoreDifferences` for injector annotations is explicitly in 3.2 |

---

## 7. Open Questions — Resolved 2026-08-07

All eight were answered by live read-only discovery ([Appendix B](./live-state-2026-08.md)) and the component design pass ([Appendix C](./component-designs.md)).

| # | Question | **Answer** |
|---|---|---|
| **Q1** | Which namespace serves staging? | **`hope-v2-dev` is the only HOPE namespace.** No staging or prod namespace exists on the workload cluster. VM 400 carries empty `hope-v2-dev`/`hope-v2-prod` namespaces — 140-day-old leftovers, never used. The owner has confirmed: work `hope-v2-dev` first, then design staging and production |
| **Q2** | k3s hardening? | **None whatsoever.** `/etc/rancher/k3s/` holds only `k3s.yaml` + `registries.yaml` — no `config.yaml`; `ExecStart` and `ps` both show `/usr/local/bin/k3s server` with **zero arguments**. No `secrets-encryption`, no audit logging, no PSA config, no kubelet hardening. **Datastore is SQLite**, not embedded etcd (no `--cluster-init`, no `node-role.kubernetes.io/etcd` label) |
| **Q3** | Which Vault design is real? | **Neither.** The running Vault is the dev-mode manifest: `Storage Type: file`, `HA Enabled: false`, Shamir 5/3, v1.18.3, single replica. Design for the VM 430-432 build is in [Appendix C §C1](./component-designs.md) — with the runbook's manual-Shamir unseal replaced by Transit auto-unseal |
| **Q4** | Is the harness Temporal worker running? | **No.** Only `hope-stt-v2-worker` exists; `hope-harness` overrides no command so it runs uvicorn only. **Nothing has ever consumed `harness-task-queue`** — which also means there is no in-flight history to migrate, making the Temporal cutover a clean-slate decision |
| **Q5** | Where is Qdrant? | **Deployed nowhere.** Design in [`component-design-qdrant.md`](./component-design-qdrant.md). Mitigating: the retrieval feature is off in every environment and is explicitly degrade-safe, so this is a capability gap, not an outage |
| **Q6** | Rancher import / Fleet? | **Both.** VM 200 is imported and **the Fleet agent is running** — the Fleet/Argo conflict is live. Also: **two** downstream clusters are registered (`c-nfhxq` = hope-v2, `c-9lwv8` = hope-v1) |
| **Q7** | GitLab tier? | **Community Edition 18.8.6.** No immutable container tags (Ultimate), no protected environments or required approvals (Premium), no built-in SAST/DAST/Dependency/Container Scanning (Ultimate), no merge trains. **Digest-pinning becomes the sole defense against tag mutation**, and the hand-rolled Trivy + gitleaks jobs are the entire security stack |
| **Q8** | Production cluster plan? | **None documented.** Only one k3s+GPU cluster exists. Owner intent is now explicit: make all three environments production-grade and keep the deployment pattern **AWS-compatible** — see Phase 8 and [`component-design-aws-portability.md`](./component-design-aws-portability.md) |

### New questions raised by the discovery pass

| # | Question | Why it matters |
|---|---|---|
| **N1** | Should the **seal-Vault** live on a dedicated VM 434 or in the k3s cluster? | Recommended VM 434 — the k3s datastore is SQLite with no snapshot backstop and no PVC backup (Q2), so losing that disk would leave every Raft node permanently sealed |
| **N2** | Does an **internal CA** already exist for VM-to-VM TLS (e.g. for Postgres HA)? | The Vault runbook punts cert issuance to an unfilled `<SRE:>` placeholder. Don't invent a second CA hierarchy if one exists |
| **N3** | Vault **1.21.2 vs the runbook's 1.18** | Deliberate deviation to match the already-validated design and run one version, not two. Needs sign-off |
| **N4** | Was `gpu-operator` installed via **Rancher Apps & Marketplace**? | Check `helm list -A` for a `catalog.cattle.io/*` label. If Rancher-owned, adopting it under Argo needs a deliberate migration, not an `Application` pointed at a live release |
| **N5** | Is **hope-v1** (`c-9lwv8`) serving real users? | It is a second registered cluster nobody mentioned. If it is live production, it changes the risk calculus for anything touching shared Postgres/Redis/MinIO |
| **N6** | Corpus size for **Qdrant** capacity planning | No estimate exists anywhere in the repo; PVC sizing and the quantization decision both depend on it |
| **N7** | Should **Argo CD move off the Rancher cluster**? | SUSE explicitly does not support Argo CD on Rancher's upstream cluster ([Appendix C §C3](./component-designs.md)) |

---

## 8. Implementation Summary

*(Not started — assessment and plan only. This section is filled in as phases land.)*

---

## 9. Blocked on the Owner

Two capabilities I do not have, and one scope caveat.

| Item | Status |
|---|---|
| ~~**Proxmox VM creation** (Vault VMs 430-432/434)~~ | ✅ **RESOLVED 2026-08-07.** The Proxmox MCP is registered and its container's SSH tunnel was re-established (it only connects at startup, so it had outlived a `cloudflared` restart). All four VMs are provisioned and Vault is running — see [Appendix H](./vault-ha-deployment-2026-08.md). Owner tail: retrieve key material offline and revoke both root tokens |
| **Cloudflare tunnel ingress rules** | **Partial.** `cloudflared` 2026.7.1 is authenticated locally — I can list tunnels and create DNS routes. But the `arca-dev` tunnel is *remotely managed*, so its hostname→service ingress mapping needs the Cloudflare API, which I don't have a token for. Note: your local `~/.cloudflared/config.yml` points at tunnel `f7ea9579…`, which **no longer exists in the account** — a dead March-2025 config |
| **"All three environments production-ready"** | Achievable for the *manifests*; not for the *substrate*. Three namespaces on one single-node VM share a kernel, one disk (currently 89% full), one GPU pair, and one failure domain. `hope-v2-dev` and `hope-v2-staging` can be production-**grade** on this box; genuine production wants its own cluster. Phase 8 designs for both shapes so the choice stays open |

## 10. Change History

- **2026-08-07 (seed gating — fixed)** — Closed §2.7's red defect: seeding is now **opt-in via `RUN_SEED`, defaulting to `none`** (`5b2e1b83`). Implementing it surfaced **DB-05**, which reframes the finding: `db-migrate.yaml` gives the Job only `DATABASE_URL` (no `envFrom`), so **`NODE_ENV` is absent in the migrate container**. `getNodeEnv()` falls back to `'development'` — which meant every environment including production took the **`db push`** branch, *and* `shouldSeedApiKeys()` returned true, seeding **demo API keys with raw secrets**. The guard against exactly that existed and was unreachable. The new gate therefore refuses `all` on an *absent* `NODE_ENV` rather than defaulting it, so it holds even before the Job is fixed. `migrate.sh` now always `migrate deploy`s. 994/994 tests, typecheck clean, both guards mutation-tested, verified end-to-end through the real `dist` entrypoint. Remaining: wire `NODE_ENV` + `RUN_SEED` into the Job; decide the production bootstrap admin (see §2.7).

- **2026-08-07 (Track V phase 1 — deployed)** — Provisioned VMs 430/431/432 (`vault-1/2/3`, 1 vCPU / 2 GB / 38 GB) and 434 (`vault-seal`, 2 vCPU / 2 GB / 18 GB) from Alpine template 903, and deployed **Vault 1.21.2 as a 3-node Raft cluster with Transit auto-unseal**, TLS from a new internal CA, and file audit devices. **Auto-unseal verified against `qm reset` (a hard power cycle): the node returned unsealed and rejoined as a voter in ~20 s with no human interaction** — the exact failure mode §C1.4 rejected the runbook's manual Shamir design over. Record + caveats: [Appendix H](./vault-ha-deployment-2026-08.md). Two findings beyond the design: (a) the design would have shipped a defect — `disable_mlock = true` (correct for Raft) combined with the template's 2 GB swap partition would let Vault page decrypted secrets to disk, so **swap was disabled on all four VMs**; (b) **template 903 carries `redis-1`'s static IP `10.10.1.120`**, so all four clones booted onto the live `redis-01` address — corrected within ~2 min, `redis-01` verified unaffected, but the template is a live trap for the next person who clones it. Track V phase 2 (k8s auth, policies, injector, secret migration, snapshots) is unblocked and unstarted.
- **2026-08-07 (later)** — Component design pass for the owner's expanded scope. Added [Appendix C](./component-designs.md) (Vault HA, harness worker, Rancher), [`component-design-qdrant.md`](./component-design-qdrant.md), and [`component-design-aws-portability.md`](./component-design-aws-portability.md). **All eight open questions resolved** (§7) plus seven new ones raised. Added Phase 7 (Vault/Qdrant/harness worker) and Phase 8 (staging, production, AWS-portable component structure); sub-ticket split extended to TASK-626. Key discoveries: k3s runs on **complete stock defaults** with no secrets encryption and a SQLite datastore; GitLab is **Community Edition** (digest-pinning becomes the sole tag-mutation defense); the live ConfigMap carries **7 untracked keys**, so enabling Argo `selfHeal` today would break harness; `infrastructure/single-deployment/vault/` is a **fully built, never-deployed** target architecture, which sharply lowers the cost of Phase 7a.
- **2026-08-07** — Read-only live discovery against VM 200 and VM 400 (owner-authorized, no mutating command issued). Added [Appendix B](./live-state-2026-08.md): answers Q1/Q3/Q4/Q5/Q6, adds 12 runtime findings `L-01`…`L-12`, and **corrects §2.5's GPU claim** (no time-slicing exists; allocatable is 2, not 8; no pod requests a GPU). Two discoveries reshape the plan: (a) Argo CD is already correctly wired to the deployment repo with an existing AppProject — the config-repo→cluster half of GitOps works, only CI→config-repo is missing; (b) **Argo CD Image Updater is already deployed and running but has never updated an image**, failing on two stale image names — repairing it is S-effort and the fastest route to R2. Also surfaced a **live incident** (STT crash-looping, node hit DiskPressure, `/mnt/data` at 89%) that should be triaged before modernization work starts. Status remains Pending.
- **2026-08-06** — Initial creation. Five parallel evidence-based audits (k3s manifests · GitLab CI/CD · observability · VM topology · 2026 SOTA research), producing a 66-item defect register (20 deployment, 20 CI/CD, 19 observability, 7 infrastructure) and a six-phase implementation plan. Headline finding verified live against the GitLab API: the CI `deploy-staging` job targets `arcaai/hope-deployments`, a repository that does not exist on the instance — there is no working CI→CD path, and staging is deployed by hand-editing image tags.
