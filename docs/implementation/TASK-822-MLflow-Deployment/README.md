# TASK-822 — MLflow: deployment and integration

| | |
|---|---|
| **Status** | **In Progress** — *"awaiting orchestrator commit" is stale.* Phase 2 is **committed and deployed** (`arca/hope-v2-deployment@main` `4062cead`, `15977113`), and `hope-mlflow` is live at `replicas: 0`, Synced/Healthy. Phase 3 (exposure) and Phase 4 (the `AiModelSource.MLFLOW` resolver) are **not started**, and **control S-5 is contradicted by what shipped** — see §13. Scaling above 0 is gated only on operator steps, no hardware |
| **Type** | infrastructure |
| **Branch** | `dev-2.2` |
| **Depends on** | nothing (greenfield) |
| **Feeds** | TASK-823 (vLLM model promotion) |
| **Related** | TASK-818 (router), TASK-824 (LM Studio) |

> ### ⚠️ Four statements in §2–§5 were CORRECTED against a running MLflow 3.15.2 (2026-08-30)
> Read **§10 Findings** before implementing from §2–§5. In short: the image must be the **`-full`**
> variant (F-1); `--allowed-hosts` is **mandatory** and must include the pod CIDR or Prometheus
> silently 403s (F-2); the R-1 invariant holds by a **different mechanism** than the box in §2 says
> (F-3); and the MLflow artifact bucket must **not** be versioned or `mlflow gc` stops erasing
> (F-4). Every correction is backed by pasted output in §10.

## 1. Requirement Analysis

Deploy and integrate a self-hosted **MLflow** instance as the platform's model registry, reusing existing infrastructure rather than duplicating it: **PostgreSQL 18** (backend store), **MinIO** (artifact store), **Vault** (secrets), **k3s + Argo CD** (GitOps, digest-pinned promotion), **Prometheus/Grafana**. Day-1 scale is small — a handful of models, ~200 platform users.

**Greenfield, verified.** MLflow exists nowhere in this repo: no compose service, no code, no dependency, no docs. `AiModelSource.MLFLOW` (`packages/domains/src/enums/generated/AiModelSource.ts:8`) is a **declared enum value with no implemented resolver** — `apps/stt/src/stt/pipeline/dto.py:26` marks it *"Reserved: self-hosted MLFlow model registry"*, and no service's `resolve_model_dir` handles it (only `hf:`, `file://`, `s3://` per `stt.prisma:33-42`). A MinIO bucket named `mlflow` is already created by the init container (`infrastructure/docker/docker-compose.yml:144-152`) and is **empty and orphaned** — a parked backlog note (`docs/backlog/2026-07-04-FEDL-MLFLOW-LEGACY.md`) says exactly that.

## 2. Rulings (decide once, here)

### R-1 — Proxied artifact access, not direct
`--serve-artifacts --artifacts-destination s3://mlflow/artifacts`. Clients use `mlflow-artifacts:/` URIs and hold **no MinIO credentials**; the server holds them once. Direct mode requires issuing MinIO credentials to every client — credential sprawl you cannot claw back, and MLflow's own docs warn: *"All users who have access to the Tracking Server in this mode will have access to artifacts served through this assumed role."* The historic throughput objection to proxying is largely answered by **3.15's presigned URLs** (both directions) plus proxy multipart.

**Trap:** `--default-artifact-root` is now the **direct-access** knob. Using it when you meant proxied silently gives you direct mode and requires client credentials you never issued. This is pitfall #1.

> #### ⚠️ R-1 is only safe because R-2 holds. State it as an invariant.
> **In proxied mode the underlying `s3://` path is unreachable.** `mlflow/store/artifact/mlflow_artifacts_repo.py`
> defines `_validate_uri_scheme` with `allowable_schemes = {"http", "https"}` and resolves every URI
> onto `/api/2.0/mlflow-artifacts/artifacts`, delegating to `HttpArtifactRepository`. The bucket and
> key are **server-side-only configuration** (`--artifacts-destination`); **no REST endpoint exposes
> them.** An API client can only stream bytes over HTTP through the tracking server.
>
> **vLLM's `runai_streamer` needs a real `s3://` URI.** So proxied mode and vLLM are compatible
> *only* because R-2 keeps serving weights in a plain MinIO bucket that MLflow merely references by
> tag. **If anyone later "simplifies" by putting weights into MLflow's artifact store, vLLM breaks
> silently.** Guardrail: assert in CI that every resolved `weights_uri` starts with `s3://`.

### R-2 — MLflow holds metadata; MinIO holds the weights
- **In MLflow**: experiment metadata, params, eval metrics, lineage, registered-model versions and **aliases**, plus a tag recording the MinIO URI **and a checksum** of the weights.
- **In a plain versioned MinIO bucket**: the multi-GB weight files, uploaded by `mc`/boto3 multipart directly, under immutable prefixes.

Reasoning: MLflow's value here is lineage and the alias→version pointer, not blob storage. `mlflow.transformers.log_model()` copies full weights by default; MLflow's own community recommends this split for 50GB+ models. Decisively: **vLLM cannot read a `models:/` URI at all** — weights must land as a plain path or `s3://` regardless, so storing them in MLflow adds a hop that must be immediately undone. **A vLLM pod's startup path must never depend on the MLflow artifact proxy.**

### R-3 — Do NOT deploy the MLflow AI Gateway
MLflow ≥3.0 ships a database-backed AI Gateway inside the tracking server (`/gateway/{endpoint}/mlflow/invocations`). It **overlaps `apps/text` directly**. Two routers means tenant policy, BYOK credentials and audit live in two places. MLflow stays registry + eval + lineage; `apps/text` stays the only router.

### R-4 — Single shared instance, platform-admin only, never tenant-facing
MLflow 3.10+ Workspaces isolate experiments/models/prompts, but MLflow's own docs disclaim the use we would be tempted to make of them: *"Workspaces provide logical separation and authorization controls inside one MLflow server. For strict data-plane or compliance isolation, run independent MLflow deployments instead of sharing a server."* The tenant boundary is already enforced by the NestJS gateway (404-over-403, `X-Tenant-Id`). **Do not map tenants onto workspaces** — a soft boundary presented as a compliance boundary is worse than no boundary.

### R-5 — Aliases, not stages
Model registry **Stages** (`/Staging`, `/Production`) have been deprecated since 2.9 and are slated for removal. Use aliases — `models:/<name>@champion` — plus tags. Promotion is repointing an alias, which is also instant rollback. **Do not copy stage-based tutorials.**

### R-6 — Plain Kustomize, cribbing the official chart
An **official image exists**: `ghcr.io/mlflow/mlflow`, published per release (`v3.15.2`, plus `-full` variants) — building your own is no longer the norm. An **official Helm chart also now exists**, but note: the docs link to `github.com/mlflow/charts`, **which 404s**. The chart actually lives inside `mlflow/mlflow` at `charts/`, published OCI to `oci://ghcr.io/mlflow/charts/mlflow`, at **chart `0.1.1` / appVersion `3.15.2`** — version-zero.

Read it as a reference implementation, not a dependency: our deployment repo is already Kustomize base+overlays, a Helm indirection buys nothing, **and the chart has no migration Job or init container** (only a generic `extraInitContainers` passthrough) — which we need. Its security defaults are worth copying verbatim: `runAsNonRoot: true`, `runAsUser: 1000`, `readOnlyRootFilesystem: true`, `drop: [ALL]`, `automountServiceAccountToken: false`.

## 3. PHI posture — the part that actually matters

**The leak vector is MLflow 3 GenAI tracing.** Spans capture inputs and outputs; MLflow's docs warn traces *"may contain sensitive data, such as Personal Identifiable Information (PII)."* Redaction via `mlflow.tracing.configure(span_processors=[...])` is applied **client-side and is strictly opt-in** — **by default, traces capture full prompts and responses unfiltered.**

For a clinical transcription platform this is unambiguous: an autologged GenAI call would capture consultation text verbatim into MLflow.

| # | Control | Detail |
|---|---|---|
| S-1 | **Disable tracing on any path touching clinical text** | `log_traces=False` in autolog. Do **not** rely on redaction as the primary control — opt-in masking on a default-on capture is the wrong way round for PHI. |
| S-2 | Audit the OTLP export path separately | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` + `MLFLOW_TRACE_ENABLE_OTLP_DUAL_EXPORT` are a **second egress** for the same payloads. |
| S-3 | Authenticating reverse proxy in front, always | MLflow ships **no** native OAuth2/SAML/LDAP. Built-in `--app-name basic-auth` is a second layer, never the only one. Use oauth2-proxy forward-auth at the ingress. |
| S-4 | Rotate the default basic-auth admin on first boot | It creates a default admin at first start. Requires `MLFLOW_FLASK_SERVER_SECRET_KEY` for CSRF. Note MLflow's RBAC (`READ/USE/EDIT/MANAGE/NO_PERMISSIONS`) has **no explicit-deny override** — you cannot grant broadly then except a resource. |
| S-5 | ~~TLS everywhere; `MLFLOW_S3_IGNORE_TLS` stays **false**~~ ⚠️ **SUPERSEDED — see §13** | ~~Use `AWS_CA_BUNDLE=/path/ca.pem` for the MinIO CA.~~ The private CA was CANCELLED by owner decision; the shipped `base/mlflow.yaml` sets `MLFLOW_S3_IGNORE_TLS: "true"` and carries no `AWS_CA_BUNDLE`. |
| S-6 | Encryption at rest | MinIO SSE (KMS-backed) for the bucket; Postgres at the volume layer. **Vault-Transit does not apply** — MLflow has no envelope-encryption hook. |
| S-7 | Wire `mlflow gc` deliberately | MLflow **soft-deletes**. `mlflow gc --older-than` is the *only* hard-deletion path and the only right-to-erasure mechanism. The official chart ships a CronJob for it. |
| S-8 | NetworkPolicy egress allow-list | DNS, Postgres, MinIO. Nothing else. |
| S-9 | Prompt registry + evaluation datasets are PHI vectors too | A dataset built from real consultations is PHI at rest in Postgres. |
| S-10 | Backup Postgres before every `mlflow db upgrade` | Vendor's own warning: migrations *"can be slow and are not guaranteed to be transactional."* |

## 4. Implementation Plan

### Phase 1 — Local dev first (mirror prod exactly)
Compose profile `mlflow`, differing from prod **only in endpoints**:
1. Service `mlflow`: `ghcr.io/mlflow/mlflow:v3.15.2-full` (**corrected — F-1**; the plain
   image has no psycopg2, no boto3 and no prometheus_flask_exporter, so it can do none of the
   three things this deployment needs), port 5000, healthcheck `GET /health`.
2. **Separate `mlflow` database** in the existing Postgres 18 container. **Never put MLflow tables in the Prisma-managed database** — Alembic's ledger and Prisma's drift detection must not share a schema.
3. Extend the **existing** MinIO init job with `mc mb --ignore-existing local/mlflow` + a scoped policy. Do not add a second init container.
4. Service `mlflow-migrate`: one-shot, `depends_on: postgres(service_healthy)`, runs `mlflow db upgrade "$BACKEND_STORE_URI"`, `restart: "no"`. `mlflow` then `depends_on: mlflow-migrate(service_completed_successfully)`. **This is the compose analogue of the PreSync Job and is what keeps dev and prod honest.**
5. Verify: `mlflow db upgrade` against a throwaway DB (**Postgres 18 compatibility is not stated anywhere in MLflow's docs** — low risk, plain SQLAlchemy DDL, but prove it).

### Phase 2 — Cluster deployment (deployment repo, Kustomize)
Server flags:
```
mlflow server --host 0.0.0.0 --port 5000 --workers 4
  --backend-store-uri $BACKEND_STORE_URI
  --serve-artifacts --artifacts-destination s3://mlflow/artifacts
  --expose-prometheus=/tmp/metrics
  --allowed-hosts mlflow.internal.<domain>
  --app-name basic-auth
```
MinIO env: `MLFLOW_S3_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID/SECRET`, `MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true`, `MLFLOW_MULTIPART_UPLOAD_MINIMUM_FILE_SIZE=524288000`, `MLFLOW_MULTIPART_UPLOAD_CHUNK_SIZE=104857600`, `MLFLOW_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS=300`.

> **Unverified — test, do not assume:** MLflow documents **no S3 path-style toggle**. boto3 generally defaults to path-style against a custom endpoint, but confirm against MinIO explicitly. Also unconfirmed: whether MLflow's multipart code path is exercised against MinIO (docs name S3 and GCS).

Object list: Deployment (replicas 1, RollingUpdate, `/health` liveness **and** readiness, emptyDir at `/tmp` — required because `readOnlyRootFilesystem: true` + `--expose-prometheus` needs a writable multiprocess dir), Service (ClusterIP), **PreSync migration Job** (`hook-delete-policy: BeforeHookCreation`, same image digest as the Deployment, exactly one runner — migration is not concurrency-safe), HPA + PDB placeholders, `mlflow gc` CronJob.

> **Corrected against the real deployment repo (2026-08-29).** Three objects in the sentence above
> do not match house convention and must not be copied from generic MLflow guides:
> - **No `ServiceMonitor`.** The Prometheus Operator is not installed; `deployment/k8s/base/prometheus.yaml`
>   is a plain Deployment that self-scrapes via `prometheus.io/scrape|port|path` **pod annotations**
>   (`observability-config.yaml:546-584`). Expose metrics that way, or make introducing the Operator
>   an explicit, separate decision.
> - **No Vault Agent injection / VSO / ESO.** None is installed — zero hits for `vault.hashicorp.com`,
>   `vault-agent` or `ExternalSecret` in the whole repo. The house pattern is a hand-applied
>   `hope-secrets` Secret (template: `deployment/secrets.dev.yaml.example`) carrying the bootstrap
>   AppRole pair, with each app performing **its own Vault AppRole login at boot**
>   (`SECRETS_PROVIDER=vault`, `VAULT_ADDR: http://hope-vault:8200`). Follow that.
>   Note also: the `AppProject` **blacklists `{group:"", kind: Secret}`** — Argo CD may never manage Secrets.
> - **No `NetworkPolicy` anywhere** and **no `CronJob` anywhere.** `mlflow gc` would be the repo's
>   first CronJob; there is no naming/annotation/hook convention to copy, so establish one and say so.
> - **No Ingress except Grafana**, no TLS, no cert-manager. `hope-api` is reached in dev via a fixed
>   NodePort. An MLflow Ingress inherits Grafana's plain-HTTP pattern unless cert-manager is
>   introduced separately — which makes the oauth2-proxy forward-auth in S-3 a new dependency, not a
>   configuration detail.

**Secrets: Vault Agent injection, not the chart's External Secrets Operator templates** — per `.claude/rules/09` §L7, ESO writes plaintext into etcd Secrets, which is the wrong posture for a PHI platform. Vault kv-v2 path `platform/mlflow` holds `backend_store_uri`, `minio_access_key`, `minio_secret_key`, `flask_secret_key`, `webhook_secret_encryption_key`.

**Pooling:** `MLFLOW_SQLALCHEMYSTORE_POOL_SIZE` / `_MAX_OVERFLOW` / `_POOL_RECYCLE`. At this scale the pool is tiny — **connect direct or use PgBouncer session mode and remove the variable.** (PgBouncer transaction-mode tolerance is *reasoned, not sourced*: MLflow uses synchronous SQLAlchemy/psycopg2, and the documented prepared-statement breakage is an asyncpg problem — but nothing confirms it, so don't take the risk for no gain.)

### Phase 3 — Registry → serving handoff (feeds TASK-823)
**MLflow promotion deploys nothing.** An alias is a label. The bridge:

`model_version_alias.created` webhook → CI job calls `MlflowClient.get_model_version_by_alias(name, alias)` → resolves to an **immutable MinIO URI + checksum** → commits that into the deployment repo's vLLM manifest → Argo CD syncs.

Why this and not the alternatives: the alias flip becomes the **trigger**, never the deployed state, so Git stays the single source of truth and Argo CD stays fully declarative — matching the existing digest-pinned promotion posture. Every other route is unproven: no maintained OSS registry-watching controller was found; **every concrete init-container example downloads from HF Hub or S3, not MLflow**; KServe has no native MLflow runtime and needs an already-resolved path; **ModelMesh is archived**; and **no MLflow vLLM flavor exists**.

Webhook mechanics: HMAC-SHA256 in `X-MLflow-Signature` (`v1,<b64>` over `delivery_id.timestamp.payload`), retries on 429/5xx with exponential backoff + jitter, requires SQL backend + `MLFLOW_WEBHOOK_SECRET_ENCRYPTION_KEY`. **Webhooks are experimental.** **`MLFLOW_WEBHOOK_ALLOW_PRIVATE_IPS` is off by default — an in-cluster CI target fails silently until you turn it on** (pitfall #7).

### Phase 4 — Wire `AiModelSource.MLFLOW`
Implement the resolver that is currently a dangling enum value: resolve `MLFLOW` sources through the registry to the MinIO URI recorded per R-2. Add `AiModel` rows for registered models. Keep `hf:`, `file://`, `s3://` working unchanged.

## 5. Observability
`GET /health` (both probes). **Prometheus is native**: `--expose-prometheus=<dir>` exposes `/metrics` via `prometheus-flask-exporter` with a multiprocess dir. Metrics are HTTP-level, not domain-level — a domain exporter is unnecessary at this scale. Backup: Postgres logical dump (mandatory pre-migration) + MinIO bucket versioning. Upgrade: backup → `mlflow db upgrade` → roll pods; MLflow does **not** support upgrading a live server. Server is backward compatible with clients **one major version** back; **newer clients against older servers is unsupported** — pin the SDK. Downgrade is undocumented; assume forward-only.

## 5A. Registry conventions (added 2026-08-29)

### 5A.1 One registered model per (logical model × format)

Register `clinical-summariser-awq` and `clinical-summariser-gguf` as **separate registered models**,
each with a `format` tag and a shared `logical_model: clinical-summariser` tag.

**Why not one model with two artifacts:** aliases attach to a *registered model*, not to an artifact
inside a version. With both formats under one model, `@champion` is ambiguous — you cannot promote
the AWQ build without promoting whatever GGUF shares that version, and you cannot roll back one
backend independently. Separate models give each backend its own flippable `@champion`, its own
version counter and its own rollback. Multiple artifacts per version also forces every consumer to
download both multi-GB artifacts to get one.

The router resolves `models:/clinical-summariser-<format>@champion`, choosing `<format>` from the
backend it is dispatching to, and reads `logical_model` to present one name to callers.

### 5A.2 Required model-version tags

`weights_uri`, `weights_sha256`, `format` (`safetensors-awq` | `gguf-q4_k_m`), `quantization`,
`context_length`, `size_bytes`, `tokenizer_uri`.

**Tags, not params** — params are immutable run inputs and are not settable on a *model version* at
all. Use `MlflowClient.set_model_version_tag`.

### 5A.3 The tokenizer trap

MLflow's `transformers` flavor writes weights to `<artifacts>/model/` but the tokenizer to
`<artifacts>/components/tokenizer/` (`mlflow/transformers/model_io.py:23-24,41,64,80`). **`model/`
is therefore not servable by vLLM as-is** — either point `--tokenizer` at `components/tokenizer` or
merge the two directories at sync time. This is the most likely silent breakage in a naive
integration; the sync job must assert `tokenizer_config.json` exists in the served directory before
emitting a GitOps commit.

### 5A.4 Immutable, content-addressed prefixes

Write weights to `s3://hope-models/<name>/<version>/<sha256>/…` and **never overwrite**. Overwriting
in place is the failure that breaks everything at once: running pods keep serving stale cached
weights, new pods get different bytes under an identical URI, the MLflow version no longer describes
what is stored, and rollback is impossible because the prior bytes are gone — with **zero signal**
that anything changed. Enable MinIO object versioning and object locking **on `hope-models` only**,
so an accidental overwrite is recoverable.

> ### ⚠️ Never enable versioning on the `mlflow` artifact bucket (F-4)
> Versioning and erasure are in direct tension, and this section and S-7 pulled in opposite
> directions until the lane caught it. With versioning on, **`mlflow gc`'s delete becomes a delete
> marker and the bytes survive as a non-current version** — and since gc is the *only*
> right-to-erasure path (S-7), versioning silently converts erasure into retention. That is a
> compliance failure with no error message.
>
> The two buckets have opposite requirements and must be configured separately:
> **`hope-models`** holds immutable weights → versioning + object lock **ON**.
> **`mlflow`** holds artifacts that must be erasable → versioning **OFF**.
> Verified by a test asserting no version of a gc'd run remains.

**The sync job verifies, it does not trust**: recompute sha256 against the tag; for GGUF additionally
run `gguf-dump.py --no-tensors --json` and assert `general.file_type` and `<arch>.context_length`
match. Fail loudly — in a clinical setting a silently-swapped quantization is a patient-safety
issue, not config drift.

### 5A.5 `mlflow gc` must never be able to delete served weights

`gc` deletes "all files in the run's artifact location". Because R-2 keeps served weights **outside**
the run artifact tree under an immutable `s3://hope-models/` prefix that MLflow only references by
tag, `gc` structurally cannot reach them. MinIO object-lock is the backstop. Do not undo this by
moving weights into MLflow artifacts.

---

## 5B. Two registries: HuggingFace AND our MLflow (owner ruling 2026-08-29)

The platform uses **both** — HuggingFace as an upstream source, and our own MLflow as the registry
of record for models we publish, fine-tune or promote. `AiModel.source` already encodes this
(`HUGGINGFACE | GITHUB | MLFLOW | LOCAL | S3`), but **only `hf:`, `file://` and `s3://` have
resolvers today** (`stt.prisma:33-42`); `MLFLOW` is a declared enum value with nothing behind it.

### 5B.1 HuggingFace is natively supported by every backend — MLflow is not

This asymmetry drives the design. HF needs **no resolution step at all**:

| Backend | HuggingFace | MLflow |
|---|---|---|
| **vLLM** | `--model <user>/<model>` directly | ✗ cannot parse `models:/`; resolve to `s3://` or a local path first |
| **LM Studio** | `POST /api/v1/models/download` accepts a catalog id **or a full HF URL** (+ `quantization`); CLI `lms get <hf-repo>` | ✗ no MLflow awareness; resolve, then `lms import` (TASK-824 §4.10) |
| **llama.cpp** | `-hf/--hf-repo <user>/<model>[:quant]`, `--hf-file`, `-hft/--hf-token` | ✗ same as LM Studio |

**So the resolver is source-aware, and the HF path is a pass-through.** Only `MLFLOW` sources take
the alias-resolution chain; `HUGGINGFACE` sources hand the repo id straight to the backend.

### 5B.2 When to use which

| Use | Registry |
|---|---|
| An off-the-shelf public model, unmodified | **HuggingFace** — pass the repo id through; no artifacts to manage |
| Anything we fine-tune, quantize, evaluate or promote | **MLflow** — it is the registry of record, and carries the lineage, eval scores and the `@champion` alias |
| Anything that must be reproducible or auditable for a clinical decision | **MLflow** — a HF repo id is a mutable pointer; an MLflow version plus `weights_sha256` is not |

### 5B.3 ⚠️ The PHI-cluster conflict this creates

**Pulling from HuggingFace at pod start requires egress from a PHI namespace to `huggingface.co`.**
That directly contradicts the default-deny egress NetworkPolicy recommended for the inference
workloads (TASK-824 §5 L-3, TASK-823 V-3), and it makes a pod's startup depend on a third-party's
availability and on a repo whose contents can change under a mutable tag.

**Recommendation: mirror HF models into MinIO rather than pulling at runtime.** A one-off job
fetches the HF repo, records a checksum, writes it to `s3://hope-models/<publisher>/<model>/…`, and
registers an `AiModel` row whose `source` is `S3` with the HF origin recorded in metadata. The
serving pods then never egress. This keeps one artifact path (MinIO) for every backend, keeps the
egress policy intact, and makes the model reproducible.

**If runtime HF pulls are wanted anyway**, that is an owner decision, and it needs: an explicit
egress allow-list entry, pinning by **revision SHA** (never a bare tag or `main`), and a documented
acceptance that a HF outage is a cold-start outage. Say so in the manifest comment.

## 6. Verification Criteria
- [ ] `mlflow db upgrade` succeeds against Postgres 18 (evidence pasted)
- [ ] Proxied artifacts confirmed: a client with **no** MinIO credentials can log and download an artifact
- [ ] ~~`MLFLOW_S3_IGNORE_TLS` is false and `AWS_CA_BUNDLE` resolves the MinIO CA~~ — **VOID.** This criterion cannot be met and is not meant to be: the CA it depends on was cancelled. Replaced by: *`MLFLOW_S3_IGNORE_TLS` reverts to `false` on the day a publicly-trusted certificate is installed on the MinIO listener* (§13)
- [ ] Tracing disabled on every clinical-text path; a test asserts no prompt text reaches MLflow
- [ ] Ingress requires auth; unauthenticated request returns 401/403
- [ ] `/metrics` scrapes with `readOnlyRootFilesystem: true` (proves the `/tmp` emptyDir)
- [ ] `mlflow gc` CronJob removes a soft-deleted run **and its artifacts**
- [ ] Webhook fires to an in-cluster endpoint (proves `ALLOW_PRIVATE_IPS`) with a valid HMAC signature
- [ ] Dev compose and cluster manifests use the same image digest and the same flags
- [ ] CI asserts every resolved `weights_uri` starts with `s3://` (the R-1/R-2 invariant)
- [ ] A resolved transformers-flavor artifact has `tokenizer_config.json` in the served directory
- [ ] Metrics scrape via `prometheus.io/*` pod annotations, not a ServiceMonitor
- [ ] Secrets arrive via `hope-secrets` + app-level AppRole login, not an injector
- [ ] `AiModelSource.MLFLOW` has a working resolver; `HUGGINGFACE` still resolves unchanged
- [ ] No inference pod egresses to huggingface.co (or the exception is explicit in the manifest)

## 7. Pitfalls (ranked)
1. `--default-artifact-root` vs `--artifacts-destination` confusion → silent direct mode.
2. **Assuming tracing is safe.** Default-on full payload capture is the single largest PHI risk in MLflow 3.
3. Forgetting `mlflow db upgrade` — the server hard-fails on a stale schema.
4. Copying stage-based tutorials instead of aliases.
5. Trusting the docs' `github.com/mlflow/charts` link — it 404s.
6. Expecting a migration hook in the official chart — there isn't one.
7. `MLFLOW_WEBHOOK_ALLOW_PRIVATE_IPS` off by default → silent webhook failure.
8. `readOnlyRootFilesystem` + `--expose-prometheus` without a writable dir → metrics break.
9. Putting MLflow tables in the Prisma database → Alembic and Prisma drift-detection fight.
10. Client newer than server — unsupported direction.

---

## 9. Implementation Summary (2026-08-30)

### 9.1 What shipped

| File | Change |
|---|---|
| `infrastructure/docker/docker-compose.dev.yml` | **NEW** `mlflow` + `mlflow-migrate` services behind `profiles: ["mlflow"]` |
| `infrastructure/docker/docker-compose.yml` | Two lines on the **existing** `minio-setup` entrypoint: an explanatory guard on the `mlflow` bucket, plus the `hope-models` weights bucket (versioned) |
| `scripts/dev-infra.sh` | `-m/--mlflow` flag; `mlflow` added to `UP_PROFILES` (opt-in) **and** `ALL_PROFILES` (so `infra:dev:down` never orphans it) |
| `docs/implementation/TASK-822-MLflow-Deployment/deployment/*.yaml` | Phase-2 manifests, authored here for the orchestrator to commit to `hope-v2-deployment` (§9.3) |
| `docs/implementation/TASK-822-MLflow-Deployment/verify/*` | The throwaway harness that produced every piece of evidence below, re-runnable |

Nothing in `packages/**`, `apps/**`, `turbo.json` or the root `package.json` was touched, and
no shared Docker/DB state was mutated — all verification ran in an isolated compose project
(`hope-mlflow-verify`, own network, ports 55432/59000/59001/55000), torn down afterwards.

### 9.2 Evidence

Re-run everything with `verify/run-verification.sh`.

**`mlflow db upgrade` on PostgreSQL 18** — ticket §6 item 1:

```
PostgreSQL 18.4 (Ubuntu 18.4-1.pgdg22.04+1) on aarch64-unknown-linux-gnu, ... 64-bit
--- mlflow-migrate container log ---
2026/08/30 01:48:42 INFO mlflow.store.db.utils: Creating initial MLflow database tables...
2026/08/30 01:48:42 INFO mlflow.store.db.utils: Updating database tables
--- migrate exit code ---
0
--- alembic ledger in the mlflow database ---
 public | alembic_version            | table | postgres
 public | experiments                | table | postgres
 public | runs (…27 tables total)    | table | postgres
6f8d9c3b2a1e
```

MLflow's tables are in their own database, not the Prisma one (`0` = no `experiments` /
`runs` / `registered_models` table in the default database).

**Proxied artifacts from a credential-free client** — §6 item 2 (12/12 checks):

```
  [PASS] no MinIO/S3 credentials in the client env — clean
  client env MLFLOW_* keys: ['MLFLOW_TRACKING_URI']
  [PASS] upload succeeded via the tracking server (proxied) — 2176 bytes
  [PASS] artifact_uri uses the mlflow-artifacts scheme, not s3://
  [PASS] downloaded bytes are identical — 2176 bytes
  [PASS] resolve_uri rewrites the artifact URI onto the tracking server over HTTP
         -> http://mlflow:5000/api/2.0/mlflow-artifacts/artifacts/1/<run>/artifacts
  [PASS] no REST payload exposes the underlying s3:// location
  [PASS] /metrics returns 200          (under readOnlyRootFilesystem + uid 1000)
  [PASS] /metrics emits Prometheus exposition format — 6122 bytes
RESULT: 12/12 checks passed
```

Server-side, the bytes really landed in MinIO:
`2.1KiB STANDARD artifacts/1/<run>/artifacts/task822-artifact.txt`.

**`mlflow gc` really erases** — §6 item 7, and S-7's whole purpose:

```
--- 6b. gc WITH MLFLOW_TRACKING_URI (the shipped CronJob configuration) ---
Run with ID 8a87b9c14ccf407390d6fe8407061ace has been permanently deleted.
objects in bucket AFTER correct gc: 1     (was 2)
--- run row gone from the backend store? --- 0   (0 = hard-deleted)
--- 6c. erasure is REAL, not a delete marker ---
local/mlflow is un-versioned
>> PASS: no version of <run> remains. Erasure is real.
```

**Compose ↔ manifest parity** — §6 item 9 (`verify/parity_check.py`):

```
IMAGE PARITY
  ✓ compose and dev overlay pin the SAME digest: sha256:2c9c50ca…30c3647
  ✓ all 3 cluster containers use one image: ghcr.io/mlflow/mlflow:v3.15.2-full
SERVER FLAG PARITY
  ✓ identical flag set (8): --allowed-hosts --artifacts-destination --backend-store-uri
    --expose-prometheus --host --port --serve-artifacts --workers
  ✓ compose/k8s: no --default-artifact-root (proxied mode intact)
ARTIFACT-STORE ENV PARITY   ✓ ×6
S-1 (PHI): no tracing/OTLP egress enabled anywhere   ✓ ×2
```

**Manifests against the deployment repo's own CI gates** (same pinned tool versions):

```
kustomize build .            EXIT=0   (426 lines)
kubeconform -strict …        Summary: 8 resources found — Valid: 8, Invalid: 0, Errors: 0
image-hygiene                PASS: no mutable tags
patch-hygiene                PASS  (no index-based JSON6902)
pull-secrets                 PASS
config-refs                  OK configMapKeyRef hope-mlflow-config/MLFLOW_S3_ENDPOINT_URL
                             required hand-applied hope-secrets keys:
                               MLFLOW_BACKEND_STORE_URI, MLFLOW_MINIO_ACCESS_KEY, MLFLOW_MINIO_SECRET_KEY
gitleaks detect --no-git     no leaks found  (ticket dir, infrastructure/docker, scripts)
```

**The migrate Job's preflight**, all three branches:

```
A. happy path      -> preflight OK: 'mlflow' reachable on postgres            exit=0
B. missing DB      -> PREREQUISITE MISSING: database 'nope_missing' … CREATE DATABASE  exit=1
C. Prisma DB       -> REFUSING TO MIGRATE: backend store points at 'postgres' exit=1
```

**The R-1/R-2 guard** (`verify/check_weights_uri.py`) — 7/7 unit cases, and against a live
registry seeded with one compliant and one violating version:

```
✗ 1 problem(s) across 2 model version(s):
    clinical-summariser-gguf v1: weights_uri does not start with s3://
      (got 'mlflow-artifacts:/1/…/artifacts/model').
      -> weights were logged INTO MLflow's artifact store. vLLM cannot read this …
GUARD EXIT=1
```

### 9.3 Handover — orchestrator actions

**A. Copy into `hope-v2-deployment` (branch `main`)** — from
`docs/implementation/TASK-822-MLflow-Deployment/deployment/`:

| From | To |
|---|---|
| `mlflow.yaml` | `deployment/k8s/base/mlflow.yaml` |
| `mlflow-migrate.yaml` | `deployment/k8s/base/mlflow-migrate.yaml` |
| `mlflow-gc.yaml` | `deployment/k8s/base/mlflow-gc.yaml` |
| `mlflow.env` | `deployment/k8s/base/config/mlflow.env` |

**B. `deployment/k8s/base/kustomization.yaml`** — add to `resources:` (after `db-migrate.yaml`)
and to `configMapGenerator:`:

```yaml
  # MLflow model registry (TASK-822). Registry of record for models we
  # fine-tune/quantize/promote. Metadata + lineage only — served WEIGHTS live in the
  # plain `hope-models` MinIO bucket, referenced by tag, because MLflow's proxied
  # artifact mode can never hand vLLM the s3:// URI runai_streamer needs.
  - mlflow.yaml
  - mlflow-migrate.yaml
  # The repo's FIRST CronJob. `mlflow gc` is MLflow's only hard-delete path and
  # therefore the only right-to-erasure mechanism for anything logged here.
  - mlflow-gc.yaml
```

```yaml
  - name: hope-mlflow-config
    envs: [config/mlflow.env]
```

**C. `deployment/k8s/overlays/dev/kustomization.yaml`** — add to `images:` (alphabetical, after
`hope-v2/harness-worker`; note this one is a PUBLIC image, so `newName` is not rewritten):

```yaml
- digest: sha256:2c9c50ca72e314cb1b8b301ceaa43882629ad91873d7271f3be92796930c3647
  name: ghcr.io/mlflow/mlflow
  newTag: v3.15.2-full
```

…and add this patch, mirroring the existing `hope-db-migrate` one **and for the same reason**
(a failing hook wedges the whole Application; a plain Job then needs `Replace=true` because
`Job.spec.template` is immutable):

```yaml
- patch: |
    - op: remove
      path: /metadata/annotations/argocd.argoproj.io~1hook
    - op: remove
      path: /metadata/annotations/argocd.argoproj.io~1hook-delete-policy
    - op: remove
      path: /metadata/annotations/argocd.argoproj.io~1sync-wave
    - op: add
      path: /metadata/annotations/argocd.argoproj.io~1sync-options
      value: Replace=true
  target:
    kind: Job
    name: hope-mlflow-migrate
```

**D. One-time operator prerequisites** (none of these can be, or should be, automated):

1. `CREATE DATABASE mlflow;` on the external Postgres. The migrate Job deliberately does not
   hold CREATEDB; its preflight prints this exact command if the database is absent.
2. A MinIO **service account scoped to the `mlflow` bucket only** — *not* the platform root key
   already in `hope-secrets` as `MINIO_ACCESS_KEY`. In proxied mode this server holds the
   credential on behalf of every client, so a root key here would expose `recordings` and
   `documents` to anyone who can reach the artifact API.
3. `mc mb hope-models && mc version enable hope-models && mc ilm/object-lock` on the cluster
   MinIO — the weights bucket (§5A.4). **Do not enable versioning on `mlflow`** (F-4).
4. Add to the hand-applied `hope-secrets` (Argo may never manage Secrets — the AppProject
   blacklists them) and to `deployment/secrets.dev.yaml.example` as placeholders:
   `MLFLOW_BACKEND_STORE_URI`, `MLFLOW_MINIO_ACCESS_KEY`, `MLFLOW_MINIO_SECRET_KEY`.

**E. Optional, low priority** — `scripts/check-envfrom-coverage.py`'s `WORKLOAD_TO_SERVICE` map
silently SKIPS unlisted workloads. `hope-mlflow` is legitimately absent (it is a third-party
image with no entry in the HOPE env-consumer inventory), but the file's own comment warns that
silent skipping is the trap the map exists to prevent — worth a one-line comment saying so.

### 9.4 Deliberately NOT shipped

| Item | Why |
|---|---|
| **Ingress** (S-3) | MLflow has no native auth, the cluster has no cert-manager/TLS, and Grafana is the only Ingress in the repo. An MLflow Ingress would be unauthenticated plain HTTP in front of a registry that can hold evaluation datasets built from real consultations (S-9). Access is `kubectl port-forward svc/hope-mlflow 5000:5000`. A NodePort (the `hope-api` pattern) would be strictly worse — `hope-api` authenticates. **oauth2-proxy forward-auth + cert-manager are a NEW DEPENDENCY and a separate owner decision, not a config detail.** |
| **NetworkPolicy** (S-8) | Would be the repo's first, and two prerequisites are unverified: whether k3s here runs the network-policy controller at all (an unenforced policy is false assurance), and the egress CIDRs for the EXTERNAL Postgres and MinIO. Shipping an unverifiable control is worse than naming the gap. Draft is in §9.5. |
| **MLflow AI Gateway** (R-3) | Ruled out — it overlaps `apps/text` and would split tenant policy, BYOK and audit across two planes. |
| **`--app-name basic-auth`** (S-4) | Not enabled: it creates a default admin at first boot and needs `MLFLOW_FLASK_SERVER_SECRET_KEY` + a rotation step. With no Ingress there is no unauthenticated exposure to defend, and the ticket is explicit that basic-auth is "a second layer, never the only one". Enable it together with the Ingress decision, not before. |
| **Webhooks / Phase 3–4** | Out of this lane's scope. Note for whoever picks it up: `MLFLOW_WEBHOOK_ALLOW_PRIVATE_IPS` is off by default, so an in-cluster CI target fails silently (pitfall #7). |

### 9.4b ~~RULING — no Ingress~~ **SUPERSEDED 2026-08-30. DO NOT ACT ON THIS SECTION.**

> ## ⛔ This ruling was made on incomplete information and is WRONG.
>
> **Owner correction, 2026-08-30:** MLflow is exposed exactly like every other internal
> service — **behind Cloudflare, on its own domain, authenticated with Azure Entra OAuth**,
> the same as GitLab, Argo CD and Rancher.
>
> **How I got it wrong, recorded so the mistake is not repeated:** I reviewed the Kustomize
> manifests in `hope-v2-deployment` and nothing else. Finding no cert-manager, no `tls:`, no
> oauth2-proxy and no Traefik middleware, I concluded no safe exposure existed. **The edge is
> not in that repo** — Cloudflare and Entra are configured outside git, so the manifests were
> silently a partial view. The domain pattern was visible all along (`git.`, `grafana.`,
> `rancher.`, `registry.`, `minio.` — all `*.taphuynh.dev`) and I read it as incidental.
>
> The reasoning below is retained ONLY as a record of the error. Its central premise — "no
> TLS, therefore every exposed option leaks credentials in cleartext" — **is false**: TLS
> terminates at Cloudflare. The correct recipe is in §9.4c.
>
> *(One line from it does survive and is worth keeping: whatever the edge does, a
> Cloudflare **SSL/TLS mode of "Flexible" would still mean plaintext Cloudflare→origin**,
> which on a PHI platform is a finding in its own right. That is being verified.)*

#### Superseded reasoning (historical record only)

**Confirmed after checking what the cluster actually has.** There is no oauth2-proxy,
and the correct response is not to substitute a different HTTP-exposed auth — it is
to not expose MLflow over HTTP at all.

**Verified on `hope-v2-deployment@main`:** no cert-manager, no `ClusterIssuer`, **no
`tls:` block on any Ingress**, and **no Traefik `Middleware` CRD used anywhere**.
Grafana is the only Ingress in the repo and it is unauthenticated plain HTTP on
`grafana.local`.

That single fact disqualifies every HTTP-exposed option, because **without TLS,
every one of them puts credentials in cleartext on the wire** in front of a registry
that can hold evaluation datasets built from real consultations (S-9):

| Option | Why not, today |
|---|---|
| Traefik `BasicAuth` middleware | One CRD, no new Deployment — genuinely cheap. But plain HTTP ⇒ the credential is sent in cleartext on every request. Cheap and wrong. |
| MLflow `--app-name basic-auth` | Same cleartext problem, plus a second auth system to operate, a default admin to rotate at first boot, and an RBAC model with **no explicit-deny override**. MLflow's own docs say it is "a second layer, never the only one". |
| NodePort (the `hope-api` pattern) | **Strictly worse than an Ingress** — `hope-api` authenticates every request; MLflow would authenticate none. |
| oauth2-proxy + cert-manager | The correct end state, and **two new platform components**. On a cluster with no TLS anywhere, this is a project, not a configuration step. |

**Ruling: `type: ClusterIP`, no Ingress, no NodePort. Access is**

```bash
kubectl -n hope-v2-dev port-forward svc/hope-mlflow 5000:5000
```

**Why this is the fast win and not a cop-out.** It costs zero new components, adds
zero attack surface, and needs no cert-manager. It is also *strictly more secure
than the "proper" oauth2-proxy path would be on day one*, because that path is only
meaningful once TLS terminates in front of it. And it fits the users: MLflow is
**platform-admin-only and never tenant-facing** (R-4), so its entire population is a
handful of people who already hold cluster credentials. `port-forward` authenticates
them with the credential they already have — the cluster's own RBAC — which is a
stronger control than any basic-auth password would be.

**The trigger to revisit** is not "someone finds port-forward annoying". It is either
of: a non-cluster-admin needs access, or MLflow starts holding something a
port-forward user should not see. At that point the order is **cert-manager first,
then oauth2-proxy forward-auth, then the Ingress** — and enabling
`--app-name basic-auth` alongside, as the second layer S-4 describes. Doing them in
any other order ships an exposure.

**Pre-existing finding, NOT this ticket's to fix but worth naming:** Grafana's
Ingress is unauthenticated plain HTTP. Grafana holds no PHI, but it does expose
per-tenant metric labels and infrastructure topology, and it is the precedent a
future service will copy. Whoever adopts cert-manager should fix Grafana in the same
change.

### 9.4c ✅ RULING — Cloudflare Tunnel + Cloudflare Access with the existing Entra IdP

**Verified against the LIVE estate 2026-08-30** (Cloudflare API, Rancher/k3s, Argo CD, GitLab),
not against the manifests. Supersedes §9.4b entirely.

**How every sibling is actually reached:** a proxied CNAME → the single Cloudflare Tunnel
`arca-dev` (`e917ee9e-c140-47d1-9c34-f9e555bc3095.cfargotunnel.com`) → a **k3s NodePort on
`10.10.1.10`**. Traefik is bypassed; the cluster's only `Ingress` (`grafana`, host
`grafana.local`) is targeted by no tunnel route and is dead. **No public origin IP is exposed.**

**⚠️ Correction to the premise.** The pattern is *per-app OIDC with partial coverage*, not a
uniform edge gate: **GitLab** has omniauth OIDC with Azure AD and **Rancher** has the native
Azure AD provider — but **Argo CD has NO SSO at all** (no `oidcConfig`, no `dexConfig`, no Access
app; built-in `admin` only) and **Grafana has none either**. So "expose it the same way as Argo"
would mean *exposing it unauthenticated*. See **TASK-828 §1** — that is a P1 finding in its own
right and more urgent than this ticket.

**MLflow has no OIDC of its own**, so the GitLab/Rancher per-app pattern is unavailable to it.
The correct mechanism is the one the account already has an IdP registered for.

#### The recipe, in order

1. **Service** — `type: NodePort` in `hope-v2-dev`, port 5000 → pod 5000, on an unused port
   (30300/30081/30082/30088 are taken; **30500** is free). **No Ingress** — the only one in the
   estate is dead. `deployment/k8s/base/mlflow.yaml` + `kustomization.yaml`, digest-pinned via the
   promote flow, with `imagePullSecrets` (the deployment-repo CI gates both).
2. **Tunnel route** — add to tunnel `arca-dev`: `hostname: mlflow.taphuynh.dev` →
   `service: http://10.10.1.10:30500`, **before** the terminal `http_status:404` rule.
   ⚠️ This tunnel is `config_src: "cloudflare"` — edited via dashboard/API, **not** through either
   Git repo (TASK-828 §6 flags that as a governance gap).
3. **DNS** — `CNAME mlflow.taphuynh.dev → e917ee9e-….cfargotunnel.com`, **proxied = true**, exactly
   like `grafana-dev`.
4. **Auth — Cloudflare Access self-hosted application** for `mlflow.taphuynh.dev`:
   `allowed_idps: ["25722ca1-8f8a-4ccf-be82-8272c60dd3e2"]` (the **existing** azureAD IdP), one
   `allow` policy, `auto_redirect_to_identity: true`. Then set
   `originRequest.access = {required: true, teamName: "taphuynh", audTag: [<app AUD>]}` on the
   tunnel rule, so the origin **rejects anything that did not traverse Access**.
   **Nothing needs creating first** — the Entra IdP and the `taphuynh` team domain already exist.
5. **Backing stores** — Postgres and the MinIO bucket per §4/§9.3D. Credentials go to **Vault, not
   a k8s Secret**: the `hope-v2-dev` AppProject **blacklists `Secret`**, so a materialized Secret
   will not sync.

#### Worth stating plainly

This makes MLflow **the account's second Access application and the first with
`originRequest.access.required = true`** — i.e. **stricter than every sibling**, not a copy of one.
That is the correct outcome for a registry that can hold evaluation datasets built from real
consultations (S-9), but it should be recorded as a deliberate raising of the bar rather than
described as "matching the existing pattern", because the existing pattern is weaker.

#### What §9.4b got right, and keep

Nothing about the auth argument survives. The one durable point: **`--app-name basic-auth` stays
off for now** and is enabled later as the *second* layer behind Access, never as the only one.

### 9.5 NetworkPolicy draft (do not apply until the two blockers are cleared)

```yaml
# BLOCKERS: (1) confirm k3s here runs its network-policy controller — if not, this
# is decorative; (2) fill the CIDRs for the EXTERNAL postgres.taphuynh.dev and
# minio.taphuynh.dev. Both are unknown from the repo alone.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: hope-mlflow, labels: {app: hope-mlflow}}
spec:
  podSelector: {matchLabels: {app: hope-mlflow}}
  policyTypes: [Egress]
  egress:
    - to: [{namespaceSelector: {}, podSelector: {matchLabels: {"k8s-app": kube-dns}}}]
      ports: [{protocol: UDP, port: 53}, {protocol: TCP, port: 53}]
    - to: [{ipBlock: {cidr: "<POSTGRES_IP>/32"}}]
      ports: [{protocol: TCP, port: 5432}]
    - to: [{ipBlock: {cidr: "<MINIO_IP>/32"}}]
      ports: [{protocol: TCP, port: 9000}]
```

---

## 10. Findings — corrections to §2–§5, each with evidence (2026-08-30)

| # | Finding |
|---|---|
| **F-1** | **The image in §4 was unusable.** `ghcr.io/mlflow/mlflow:v3.15.2` ships mlflow + SQLAlchemy + alembic and nothing else. Verified by importing in both images: plain → `psycopg2 MISSING, boto3 MISSING, prometheus_flask_exporter MISSING`; `-full` → all three present. So the plain image cannot reach Postgres, cannot reach MinIO and cannot serve `--expose-prometheus` — it cannot do any of the three things this deployment exists to do. **Corrected to `-full` throughout.** This also softens R-6's "building your own is no longer the norm": an official image exists, but only one of its two variants is viable. |
| **F-2** | **`--allowed-hosts` is mandatory, and getting it wrong breaks metrics silently.** Not mentioned in §4's flag list as load-bearing. Two facts, both verified: (a) omitting it 403s every client that connects by DNS name — the first harness run died on `403 'Invalid Host header - possible DNS rebinding attack detected'`; (b) an explicit list **replaces** the private-IP defaults, and `/metrics` is host-validated while `/health` and `/version` are exempt (`HEALTH_ENDPOINTS` in `mlflow/server/security_utils.py`). Endpoint matrix: `Host: 10.42.0.7:5000` → `/health` **200**, `/metrics` **403**. So a pod-IP Prometheus scrape 403s while the pod stays Ready and looks healthy. `10.*` (the k3s pod CIDR) is in the shipped allow-list for exactly this. Matching is `fnmatch` and **port-exact** (`localhost:5000` ≠ `localhost:55000`). |
| **F-3** | **The R-1 invariant box names the wrong mechanism.** `_validate_uri_scheme`'s `allowable_schemes = {"http","https"}` gates the **TRACKING URI**, not the artifact URI — its own message reads *"the tracking URI must be a valid http or https URI"*. Constructing `MlflowArtifactsRepository("s3://…")` does **not** raise. The conclusion is unchanged and still correct, but by a different route: `resolve_uri` takes the tracking URI's scheme+netloc and forces the path onto `/api/2.0/mlflow-artifacts/artifacts`, so a client can only ever address the tracking server over HTTP. Verified, plus: no REST payload (run, experiment, artifact list) contains an `s3://` string. |
| **F-4** | **Versioning the MLflow artifact bucket defeats `mlflow gc` — a PHI control failure.** Not anticipated anywhere in §3/§5A. With versioning on, gc's delete became a **delete marker** and the artifact bytes survived as a non-current version (`v2 DEL` over `v1 PUT 1.8KiB`) — invisible to `mc ls`, fully recoverable. Since gc is MLflow's only hard-delete path (S-7), versioning silently converts erasure into retention. **Ruling: `mlflow` bucket unversioned; versioning + object lock belong on `hope-models` only**, where immutability is the goal (§5A.4). The two requirements are in direct tension and must not be applied uniformly. |
| **F-5** | **`mlflow gc` fails LOUDER than documented, but is still fragile.** Docs say a missing `MLFLOW_TRACKING_URI` means artifact deletion is "bypassed" while gc "continues" (a silent half-delete). On 3.15.2 it raises `MlflowException: Tracking URL is not set` and exits non-zero, deleting nothing. Better — but it means the CronJob fails every run if that variable is lost, so `failedJobsHistoryLimit` must stay **> 0** or the failure of the erasure mechanism is itself invisible. |
| **F-6** | **`pg_isready` is not a readiness signal for `timescale/timescaledb-ha`.** It answers over the local socket while Patroni is still starting, so compose's `service_healthy` fires before the server accepts TCP. A cold-volume run died with `connection to server at "postgres" … Connection refused`. The shipped `mlflow-migrate` one-shot retries on TCP for this reason. Likely to bite any future service that gates on the platform Postgres's healthcheck. |
| **F-7** | **`ghcr.io/mlflow/mlflow` runs as root by default** (`User=` empty, `id` → `uid=0`). The chart's `runAsNonRoot: true` / `runAsUser: 1000` (R-6) is therefore load-bearing, not decorative. Verified the server starts, serves artifacts and serves `/metrics` as uid 1000 with `readOnlyRootFilesystem` + a writable `/tmp`. |
| **F-8** | **The dev overlay de-hooks `hope-db-migrate`** (removes the three Argo hook annotations, adds `sync-options: Replace=true`), because a failing hook wedges the entire Application — `hope-vault-init` did exactly that on 2026-08-07/09 and blocked every Git change for days. §4's "PreSync migration Job" instruction is right for `base/` but incomplete: the dev overlay needs the matching patch, supplied in §9.3C. |

## 11. `AiModelSource.MLFLOW` resolver — design notes (NOT implemented here)

Design only. The resolver lives in `packages/**`, which is TASK-818 Lane F's exclusive surface
(EXECUTION-PLAN §11); this lane must not write it.

**The resolver is source-aware, and only `MLFLOW` does any work** (§5B.1): `HUGGINGFACE` hands
the repo id straight to the backend, `S3`/`LOCAL` pass through. So this is a new branch, not a
new abstraction.

Resolution chain for `MLFLOW`:

```
AiModel.source = MLFLOW, ref = "clinical-summariser-<format>@champion"
  → MlflowClient.get_model_version_by_alias(name, alias)      # R-5: alias, never Stage
  → read tags: weights_uri, weights_sha256, format, tokenizer_uri
  → ASSERT weights_uri.startswith("s3://")                    # the R-1/R-2 invariant
  → return { uri: weights_uri, sha256: weights_sha256, tokenizer: tokenizer_uri }
```

Five things the implementer must not get wrong:

1. **Never return a `models:/` or `mlflow-artifacts:/` URI.** vLLM cannot parse either, and in
   proxied mode the underlying `s3://` is unreachable. `verify/check_weights_uri.py` encodes this
   assertion and already runs green against a live registry — reuse it rather than re-deriving it.
2. **Resolve at PROMOTION time, not at pod start** (§3). The alias flip is the *trigger*; the
   resolved immutable URI is committed into the deployment repo and Argo syncs it. A vLLM pod's
   startup path must never depend on the MLflow artifact proxy. This also keeps Git the single
   source of truth, matching the existing digest-pinned promotion posture.
3. **Tags, not params** (§5A.2) — params are immutable run inputs and are not settable on a model
   version at all. Use `set_model_version_tag`.
4. **The tokenizer trap** (§5A.3): the `transformers` flavor writes weights to `model/` and the
   tokenizer to `components/tokenizer/`, so `model/` is not servable as-is. The sync job must
   assert `tokenizer_config.json` exists in the served directory before emitting a GitOps commit.
5. **One registered model per (logical model × format)** (§5A.1) — aliases attach to a registered
   model, not to an artifact inside a version, so a shared model makes `@champion` ambiguous and
   makes independent rollback impossible.

Config-tier placement: an MLflow registry URL is **topology**, so `MLFLOW_TRACKING_URI` is
`env`-tier (bootstrap floor). Which model a tenant gets is `AiTaskDefault` + `AiModel`, resolved
tenant → SYSTEM, `failMode: closed` — MLflow is where the artifact is described, never where the
selection policy lives.

## 13. Where this actually stands (2026-08-31) — verified against `hope-v2-deployment@main` and the live cluster

### Phase 2 is committed and deployed, not "awaiting a commit"

| Landed | Commit |
|---|---|
| `base/mlflow.yaml`, `base/mlflow-gc.yaml` (this repo's FIRST CronJob), registered in `base/kustomization.yaml` | `4062cead` — *"MLflow lands as the registry of record, inert and digest-pinned"* |
| `out-of-band/mlflow-bootstrap.yaml` (idempotent database + least-privilege role) and `minio/policies/mlflow-artifacts-rw.json` (bucket policy scoped to `artifacts/*`) | `15977113` — *"one database server, a bootstrapped least-privilege role, a scoped artifact key"* |
| `hope-mlflow-migrate` de-hooked and moved out-of-band; `hope-mlflow` dropped from `replicas: 1` to `0` | `de8dc03e` |

Live: Deployment `hope-mlflow` 0/0 (`ScaledToZero`), Service `hope-mlflow`, HPA, PDB, CronJob
`hope-mlflow-gc` and ConfigMap `hope-mlflow-config-gc7bkft25d` all present and **Synced/Healthy**
in the `hope-v2-dev` Argo Application. The image is digest-pinned in the dev overlay
(`ghcr.io/mlflow/mlflow@sha256:2c9c50ca…`, `newName` deliberately not rewritten — it is a public
image not in `registry.taphuynh.dev`, so the pull secret does not apply).

**It shipped at `replicas: 1` first, and that was a mistake worth recording.** The pod sat in
`CreateContainerConfigError` — *"couldn't find key `MLFLOW_MINIO_ACCESS_KEY` in Secret
hope-v2-dev/hope-secrets"* — dragging the whole Application to Degraded for a missing
**prerequisite** rather than a defect. `de8dc03e` set it to 0 to match vLLM and LM Studio. Scaling
to 1 is the last step of bring-up, not the first.

### ⚠️ Control S-5 is contradicted by what shipped, and §9.4c is a plan, not a state

Two places where this document no longer describes reality. Neither is a defect in the manifests;
both are the document failing to follow an owner reversal.

1. **S-5 (`MLFLOW_S3_IGNORE_TLS` stays false, `AWS_CA_BUNDLE` resolves the MinIO CA) is dead.**
   The committed `base/mlflow.yaml` sets **`MLFLOW_S3_IGNORE_TLS: "true"`** and carries **no**
   `AWS_CA_BUNDLE` at all. That is correct, not drift: the private CA (`ROOT_CONFIG_REQUEST R-1`)
   was **cancelled by owner decision**, and the platform-wide posture is now HTTPS with
   verification disabled until a **publicly-trusted certificate** is installed on the MinIO
   listener. TASK-823 recorded the identical reversal for vLLM as `OPEN-823-TLS`; this ticket
   never wrote its equivalent down, so S-5 sat here reading like an unmet requirement. It is not
   unmet — it is **withdrawn**. The replacement criterion is: flip `MLFLOW_S3_IGNORE_TLS` back to
   `false` on the day that certificate lands.
2. **§9.4c's exposure design has not shipped.** It describes Cloudflare Tunnel + a Cloudflare
   Access application on the existing Entra IdP, NodePort 30500, `mlflow.taphuynh.dev`. **None of
   it exists**: the committed Service is `type: ClusterIP` and its own comment still says access is
   `kubectl port-forward svc/hope-mlflow 5000:5000` — the older §9.4b posture. §9.4c is the
   decision; the implementation is Phase 3 and is not started. The tunnel route in particular lives
   only in the Cloudflare dashboard (`config_src: cloudflare`), outside both repos and outside CI —
   see TASK-828 §6.

### What still gates `hope-mlflow` above `replicas: 0`

Operator-sequenced only. **No hardware blocker** — unlike TASK-823, nothing here is waiting on a
GPU. In order:

1. `kubectl create secret generic hope-mlflow-bootstrap --from-literal=ADMIN_URI=…` (by hand — the
   admin URI is never committed).
2. `kubectl apply -f deployment/k8s/out-of-band/mlflow-bootstrap.yaml`, then verify it completed.
   This is the improvement `15977113` bought: §9.3D used to say these prerequisites "cannot be, and
   should not be, automated", and creating the database now *is* a re-runnable idempotent Job.
3. Mint the MinIO service account (`mc admin user svcacct add`) under
   `deployment/minio/policies/mlflow-artifacts-rw.json`, and patch
   `MLFLOW_BACKEND_STORE_URI`, `MLFLOW_MINIO_ACCESS_KEY`, `MLFLOW_MINIO_SECRET_KEY` into
   `hope-secrets`. **Still fully manual** — documented in the deployment repo's
   `docs/mlflow-database.md` §5.
4. Run `out-of-band/mlflow-migrate.yaml` by hand.
5. Flip `replicas: 0 → 1`.

Steps 1–4 are deliberately outside every kustomization. That is not an oversight: a PreSync hook
that cannot yet succeed does not gate a sync, it **deadlocks** it — which is exactly what
`hope-mlflow-migrate` did on its first real sync, and what `hope-vault-init` did for days in
2026-08.

### Verification criteria that are NOT met, restated plainly

- **`AiModelSource.MLFLOW` has no resolver** (Phase 4). Grepped `packages/domains`, `apps/stt`,
  `apps/text`, `apps/harness`: the only artifacts are the enum member
  (`packages/domains/src/enums/generated/AiModelSource.ts:8`) and the boolean helper
  `AiModelEntity.isMLFlow()`. No `MlflowClient`, no resolution chain, no
  `get_model_version_by_alias` call anywhere. §11 already says these are design notes; the
  checklist did not.
- **The promotion webhook** (Phase 3) is not built.
- **The `weights_uri` CI assertion is proven-correct, not enforced.** `verify/check_weights_uri.py`
  passes 7/7 plus a live run, but it lives under this ticket's own `verify/` directory as a
  re-runnable harness. **It is wired into no pipeline**, so nothing re-checks it on a change.
- **Ingress auth** — cannot be met while there is no Ingress (above).
- **The transformers-flavor `tokenizer_config.json` assertion** has no evidence anywhere; it is a
  design note in §5A.3 that was never exercised.

## 12. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Ticket created from research. Rulings R-1..R-6 and PHI controls S-1..S-10 recorded. |
| 2026-08-30 | Phase 1 built and verified end to end against a running MLflow 3.15.2 + PostgreSQL 18.4; Phase 2 manifests authored for handover; Phase 4 resolver design notes recorded (§11). Eight findings (§10) correct §2–§5, four of them materially: the image must be `-full`, `--allowed-hosts` is mandatory and gates `/metrics`, the R-1 invariant holds by a different mechanism than stated, and versioning the artifact bucket defeats `mlflow gc`. Ingress, NetworkPolicy and basic-auth deliberately not shipped, with reasons (§9.4). |
| 2026-08-31 | **Status `Review` → `In Progress`; the "awaiting orchestrator commit" line was stale and control S-5 was contradicted by what shipped.** New §13. Phase 2 is committed AND deployed — `4062cead` (mlflow + the repo's first CronJob), `15977113` (idempotent DB-bootstrap Job + a MinIO bucket policy scoped to `artifacts/*`), `de8dc03e` (migrate de-hooked to out-of-band; `replicas: 1 → 0`). `hope-mlflow` is live at 0/0, Synced/Healthy, digest-pinned. Recorded that it shipped at `replicas: 1` first and sat in `CreateContainerConfigError` on a missing prerequisite, dragging the Application to Degraded — hence the rule that nothing which cannot yet succeed may gate the sync. **S-5 is WITHDRAWN, not unmet:** the private CA (R-1) was cancelled by owner decision, so `base/mlflow.yaml` correctly sets `MLFLOW_S3_IGNORE_TLS: "true"` with no `AWS_CA_BUNDLE`; TASK-823 recorded the same reversal as `OPEN-823-TLS` and this ticket had not. Its verification-criteria checkbox is marked VOID with the replacement criterion (revert on the day a publicly-trusted certificate is installed). **§9.4c is a plan, not a state** — the Service is still `ClusterIP` with a `port-forward` comment; no NodePort, no tunnel route, no Access application exists. Restated the criteria that are genuinely not met: no `AiModelSource.MLFLOW` resolver anywhere (only the enum member and `AiModelEntity.isMLFlow()`), no promotion webhook, and `check_weights_uri.py` is proven-correct but wired into no pipeline. Bring-up is now five named operator steps with no hardware blocker. |
