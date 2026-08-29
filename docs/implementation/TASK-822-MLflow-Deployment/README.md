# TASK-822 — MLflow: deployment and integration

| | |
|---|---|
| **Status** | Pending |
| **Type** | infrastructure |
| **Branch** | `dev-2.2` |
| **Depends on** | nothing (greenfield) |
| **Feeds** | TASK-823 (vLLM model promotion) |
| **Related** | TASK-818 (router), TASK-824 (LM Studio) |

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
| S-5 | TLS everywhere; `MLFLOW_S3_IGNORE_TLS` stays **false** | Use `AWS_CA_BUNDLE=/path/ca.pem` for the MinIO CA. |
| S-6 | Encryption at rest | MinIO SSE (KMS-backed) for the bucket; Postgres at the volume layer. **Vault-Transit does not apply** — MLflow has no envelope-encryption hook. |
| S-7 | Wire `mlflow gc` deliberately | MLflow **soft-deletes**. `mlflow gc --older-than` is the *only* hard-deletion path and the only right-to-erasure mechanism. The official chart ships a CronJob for it. |
| S-8 | NetworkPolicy egress allow-list | DNS, Postgres, MinIO. Nothing else. |
| S-9 | Prompt registry + evaluation datasets are PHI vectors too | A dataset built from real consultations is PHI at rest in Postgres. |
| S-10 | Backup Postgres before every `mlflow db upgrade` | Vendor's own warning: migrations *"can be slow and are not guaranteed to be transactional."* |

## 4. Implementation Plan

### Phase 1 — Local dev first (mirror prod exactly)
Compose profile `mlflow`, differing from prod **only in endpoints**:
1. Service `mlflow`: `ghcr.io/mlflow/mlflow:v3.15.2`, port 5000, healthcheck `GET /health`.
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
that anything changed. Enable MinIO object versioning and object locking so an accidental overwrite
is recoverable.

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
- [ ] `MLFLOW_S3_IGNORE_TLS` is false and `AWS_CA_BUNDLE` resolves the MinIO CA
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

## 8. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Ticket created from research. Rulings R-1..R-6 and PHI controls S-1..S-10 recorded. |
