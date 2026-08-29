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

Object list: Deployment (replicas 1, RollingUpdate, `/health` liveness **and** readiness, emptyDir at `/tmp` — required because `readOnlyRootFilesystem: true` + `--expose-prometheus` needs a writable multiprocess dir), Service (ClusterIP), Ingress (TLS at edge, oauth2-proxy forward-auth), **PreSync migration Job** (`hook-delete-policy: BeforeHookCreation`, same image digest as the Deployment, exactly one runner — migration is not concurrency-safe), Vault-injected Secret, ServiceMonitor, NetworkPolicy, `mlflow gc` CronJob.

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
