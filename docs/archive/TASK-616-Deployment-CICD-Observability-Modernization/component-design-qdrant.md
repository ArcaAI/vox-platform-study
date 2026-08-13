<!-- Extracted from the design artifact; tables are lightly reflowed. -->

# Qdrant Production Deployment — Design Document

**Status:** Draft for review (Phase 2/3 — Explore & Plan; no manifest has been applied to `hope-v2-deployment`)
**Date:** 2026-08-07
**Scope:** `apps/harness` institutional RAG only — the only live Qdrant consumer in the platform today
**Live fact confirmed:** `kubectl get all -A` returns zero Qdrant resources. Qdrant exists only in local-dev `docker-compose`. One namespace exists in-cluster: `hope-v2-dev`.

---

## a) What the code actually requires

### a.1 There is exactly one live collection: `knowledge_chunks`

`infrastructure/docker/scripts/init-qdrant-collections.py` declares **two** collections, but only one is real:

| 

| Collection
| Status
| Evidence

| `knowledge_chunks`
| **Live** — created and read/written by `apps/harness` institutional RAG
| see below

| `stt_speaker_embeddings`
| **Dead** — STT's Qdrant-backed speaker store was removed by design
| `apps/stt/tests/unit/diarization/test_no_qdrant_vectorstore.py:1-15`, `apps/stt/README.md:42-46` — cross-session speaker identity now lives in Postgres `UserVoiceProfile.embedding` (pgvector), not Qdrant

| *(none named)* `context_items`
| **Never provisioned**
| `ContextItem.qdrantSynced`/`qdrantSyncedAt` columns exist (`packages/database/src/prisma/db_main/consultation.prisma:110-118`) with an inline comment stating the collection "was never actually provisioned-and-used" and was "removed from `init-qdrant-collections.py` as orphaned" — additive-safe dead weight, not an active integration

**Implication for this design:** production Qdrant needs to provision and operate exactly **one** collection, `knowledge_chunks`. Do not carry `stt_speaker_embeddings` into production provisioning — it is legacy from a design that was replaced. `docs/architecture/overview.md:303` still describes STT voice enrollment as writing into Qdrant `stt_speaker_embeddings`; that line is stale and should be corrected as a documentation fast-follow (flagged in §f).

### a.2 Collection shape (from `infrastructure/docker/scripts/init-qdrant-collections.py:35-96`)

```python
KNOWLEDGE_CHUNKS_COLLECTION = os.getenv("QDRANT_KNOWLEDGE_COLLECTION", "knowledge_chunks")
KNOWLEDGE_CHUNKS_VECTOR_SIZE = int(os.getenv("QDRANT_KNOWLEDGE_DIM", "1024"))
KNOWLEDGE_DENSE_VECTOR_NAME = "dense"
KNOWLEDGE_SPARSE_VECTOR_NAME = "bm25"
DISTANCE_METRIC = Distance.COSINE

client.create_collection(
    collection_name=KNOWLEDGE_CHUNKS_COLLECTION,
    vectors_config={
        "dense": VectorParams(size=1024, distance=Distance.COSINE),
    },
    sparse_vectors_config={
        "bm25": SparseVectorParams(modifier=Modifier.IDF),
    },
)

```

- **Named dense vector `"dense"`**: 1024 dimensions, **COSINE** distance.
- **Named sparse vector `"bm25"`**: server-side IDF-weighted sparse vector (Qdrant's native BM25 scoring path), produced in-process by `fastembed`'s `Qdrant/bm25` model (`apps/harness/src/harness/guides/retrieval/sparse.py:27`) — no external sparse-embedding service.
- **Creation is idempotent/additive**: if the collection exists, the script leaves it untouched (no drop/recreate) — `init-qdrant-collections.py:60-64`.
- **No HNSW / on-disk / optimizer overrides anywhere in the codebase.** Collection creation uses only bare `VectorParams`/`SparseVectorParams` — every quantization, mmap-threshold, and on-disk-payload decision below is a **new** production choice, not something the code already assumes.
- **Payload indexes** (keyword type) on `tenant_id`, `knowledge_document_id`, `status`, `chunk_id` — `init-qdrant-collections.py:87-92`.

### a.3 Payload schema per point (`apps/harness/src/harness/api/endpoints/knowledge.py:164-171`)

```python
payload = {
    "tenant_id": body.tenant_id,
    "knowledge_document_id": body.knowledge_document_id,
    "chunk_id": point_id,
    "status": APPROVED_STATUS,        # "APPROVED"
    "chunk_index": chunk.chunk_index,
    "text": chunk.text,
}

```

Point id is deterministic — `uuid5(tenant_id, document_id, chunk_index)` (`knowledge.py:98-99`) — so re-ingestion is idempotent by construction, not by any Qdrant-side dedup logic.

### a.4 Embedding models that produce the vectors

- **Dense**: `BAAI/bge-m3`, 1024-dim, served self-hosted through LM Studio's OpenAI-compatible `/v1/embeddings` under the model id `text-embedding-bge-m3` — `apps/harness/src/harness/core/config.py:151-171` (class `RetrievalConfig`, field defaults `embeddings_model`/`embeddings_dim`), mirrored in `.env.sample:1389-1414`. This is a **config default**, not a DB-seeded row — `grep -rn "bge-m3" packages/database/src/prisma/db_main/seed/` returns nothing.
- **Sparse**: `fastembed`'s `Qdrant/bm25`, in-process, no external call — `apps/harness/src/harness/guides/retrieval/sparse.py:27`.
- **Reranker** (not an embedding into Qdrant, but downstream of it): `BAAI/bge-reranker-v2-m3` via HF Text-Embeddings-Inference, `HARNESS_RETRIEVAL_RERANKER_BASE_URL`.
- The "embedding" hits inside `packages/database/src/prisma/db_main/seed/` and the settings-registry descriptors are for a **different, unrelated** pipeline — STT speaker/diarization embeddings (ECAPA-TDNN / WeSpeaker ResNet34, `seed/ai-models/audio.ts:407-457`) that write to Postgres `pgvector`, not Qdrant. Don't conflate the two when reading the seed data.

**Critical operational coupling**: `RetrievalConfig`'s docstring (`config.py:151-153`) states `embeddings_dim` "MUST match both the loaded model and the Qdrant collection" — changing the embedding model in production requires a coordinated collection recreation, not just a config flip.

### a.5 Multi-tenancy model — single collection, payload-filter isolation (the load-bearing finding)

**There is one shared `knowledge_chunks` collection for every tenant.** Isolation is enforced entirely by a `tenant_id` (+ `status=APPROVED`) payload filter applied on **every** query — not by per-tenant collections, not by per-tenant Qdrant instances.

Verbatim, `apps/harness/src/harness/guides/retrieval/qdrant_store.py:107-141`:

```python
def hybrid_query(
    self, *, dense, sparse, tenant_id: str, limit: int, with_payload: bool = True,
) -> list[RetrievedPoint]:
    """Run the dense+sparse RRF hybrid, tenant + APPROVED scoped, return hits."""
    flt = self._tenant_approved_filter(tenant_id)
    response = self._client.query_points(
        collection_name=self._collection,
        prefetch=[
            models.Prefetch(query=dense, using=self._dense_name, filter=flt, limit=limit),
            models.Prefetch(query=sparse, using=self._sparse_name, filter=flt, limit=limit),
        ],
        query=models.FusionQuery(fusion=models.Fusion.RRF),
        limit=limit,
        with_payload=with_payload,
    )
    return [self._to_retrieved(pt) for pt in getattr(response, "points", [])]

@staticmethod
def _tenant_approved_filter(tenant_id: str) -> models.Filter:
    return models.Filter(must=[
        models.FieldCondition(key="tenant_id", match=models.MatchValue(value=tenant_id)),
        models.FieldCondition(key="status", match=models.MatchValue(value=APPROVED_STATUS)),
    ])

```

The module docstring is explicit about why this is safety-critical (`qdrant_store.py:13-16`):

> 

"The `tenant_id` + `status=APPROVED` filter on **both** prefetch branches is the load-bearing tenant-isolation + approval gate: only a tenant's own APPROVED chunks are ever retrievable."

Two details matter for a PHI platform's threat model:

- The filter is applied identically to **both** the dense and the sparse `Prefetch` branch. An incomplete filter (only one branch) would leak cross-tenant hits through RRF fusion — the code gets this right today, but it means the tenant boundary lives entirely in **one function** (`_tenant_approved_filter`), not in Qdrant's own access-control layer. Qdrant has no native concept of "this collection is tenant-partitioned" — the platform owns that invariant, not the database.
- `tenant_id` is indexed as a keyword payload index at creation time (`init-qdrant-collections.py:87-92`), so the filter is served by an index, not a full scan — this matters for both correctness-under-load and for not silently degrading into a full collection scan as data grows.

No `create_collection` call is ever parameterized by tenant anywhere in the repo — it's called exactly twice, both fixed global names. **This is a deliberate architectural choice already in production code, not something this design doc is proposing.** It does mean: (a) a single point-count/QPS ceiling is shared across every tenant on one collection, and (b) any future code change that adds a Qdrant read/write path (e.g. a new endpoint) must be reviewed for whether it also applies `_tenant_approved_filter` — there is no server-side backstop.

### a.6 Authentication — currently none, anywhere

- `packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts:29-41` explicitly documents that `QDRANT_API_KEY` is **not** in the application secrets registry: no application service authenticates to Qdrant today; its only reader is the provisioning script, which "runs outside the application env surface."
- `KnowledgeQdrantStore.__init__` (`qdrant_store.py:70-88`) constructs `QdrantClient(url=url, timeout=...)` with **no `api_key` parameter at all** — the harness runtime client cannot authenticate even if you wanted it to; the constructor doesn't accept one.
- Neither `infrastructure/docker/docker-compose.dev.yml:120-146` nor `tests/docker-compose.test.yml:160-198` sets an API-key env var on the Qdrant container.
- The only place `api_key` is threaded through a client is the provisioning script (`init-qdrant-collections.py:23,120-125`), reading `QDRANT_API_KEY` from env — but nothing sets it in either compose file, so it's `None` in practice today.

**Implication for this design: shipping Qdrant to a PHI-adjacent production cluster with auth requires a code change, not just an infra change.** `KnowledgeQdrantStore.__init__` and `RetrievalConfig` need an `api_key` field before the k8s manifest's `QDRANT__SERVICE__API_KEY` does anything useful end-to-end. This is called out as an explicit gap in §f, not something the manifest alone can close.

### a.7 Every `QDRANT_*` / `qdrant_*` identifier in the repo

| 

| Identifier
| `env_prefix` / location
| Default
| Registered in `turbo.json#globalEnv`?

| `qdrant_url` (field `RetrievalConfig.qdrant_url`)
| `apps/harness/src/harness/core/config.py:162`, env `HARNESS_RETRIEVAL_QDRANT_URL`
| `http://localhost:6333`
| No — zero `QDRANT` hits in `turbo.json`

| `collection` (field)
| `config.py:163`, env `HARNESS_RETRIEVAL_COLLECTION`
| `knowledge_chunks`
| No

| `qdrant_timeout_s` (field)
| `config.py:180`, env `HARNESS_RETRIEVAL_QDRANT_TIMEOUT_S`
| `10.0`
| No

| `QDRANT_HOST`
| `init-qdrant-collections.py:21`; also `docker-compose.dev.yml:143`, `tests/docker-compose.test.yml:194`
| `localhost`
| Provisioning-script only, not app config

| `QDRANT_PORT`
| `init-qdrant-collections.py:22`, same compose files
| `6333`
| Provisioning-script only

| `QDRANT_API_KEY`
| `init-qdrant-collections.py:23`; documented, unset, in `infrastructure/docker/env.stt-dev.example:35`, `apps/stt/.env:149`
| unset
| **Deliberately unregistered** in the app secrets registry (`platform-secrets.descriptors.ts:29-41`) — its only reader is the provisioning script

| `QDRANT_KNOWLEDGE_COLLECTION`
| `init-qdrant-collections.py:35`
| `knowledge_chunks`
| No (provisioning override only)

| `QDRANT_KNOWLEDGE_DIM`
| `init-qdrant-collections.py:36`
| `1024`
| No

| `QDRANT_HTTP_PORT` / `QDRANT_GRPC_PORT`
| `infrastructure/docker/env.stt-dev.example:33-34`
| `6333` / `6334`
| Compose-only

| `QDRANT_URL`, `QDRANT_COLLECTION_SPEAKERS`, `QDRANT_POOL_SIZE`, `QDRANT_TIMEOUT`
| `apps/stt/.env:147-153`
| various
| **Legacy/dead** — STT's Qdrant store was removed; nothing reads these anymore

Python pydantic-settings side: `RetrievalConfig(BaseSettings)` at `apps/harness/src/harness/core/config.py:131-187`, `model_config = SettingsConfigDict(env_prefix="HARNESS_RETRIEVAL_")` — the **only** class touching Qdrant in the repo. There is no standalone `QdrantSettings`.

`docs/architecture/environment-configuration-reference.md:62` records that TASK-558 already found and fixed a `QDRANT_URL` double-declaration ("silent last-line-wins") once — worth remembering when wiring the new k8s env, since duplicate keys across `configmap.yaml` + inline `env:` are an easy way to reintroduce that class of bug.

TS side: no application service touches Qdrant directly (`packages/applications` calls `apps/harness` over HTTP — `packages/applications/src/services/knowledge/knowledge-ingest.client.ts`); Qdrant connectivity is entirely a Python/`apps/harness` concern.

### a.8 What `docs/operations/retrieval-corpus-ingestion/README.md` actually says

It is an **owner-run runbook**, not an infrastructure doc — its own preface: "do not execute in CI or automation." Relevant points:

- Precondition §0: "Qdrant reachable; `knowledge_chunks` collection exists with the expected shape" — it points at the dev init script and assumes Qdrant is already running; it gives **no guidance on production sizing, replication, backup, or auth**.
- Corpus candidates (§1) are license-gated: PMC-OA, CDC public-health guidance, ICD-11 — none has a documented expected point count, so there is **no volume estimate anywhere in the repo** to size storage against (see open question in §f).
- The whole institutional-RAG feature sits behind `HARNESS_RETRIEVAL_ENABLED` (default `False`), and is item #1 of 7 independently-gated flags in §3, each requiring a harness-eval faithfulness/citation-delta gate before flipping — **the feature is off in every environment today**, confirmed independently by `harness.yaml` in the deployment repo carrying zero `HARNESS_RETRIEVAL_*` env vars (see §c).
- §4 Verification requires retrieval to be tenant-scoped, `APPROVED`-only, with no cross-tenant bleed — i.e., the payload-filter behavior in §a.5 is treated as a release gate, not an assumption.
- Explicitly degrade-safe: "an embeddings/Qdrant/reranker outage already yields an empty context (`degraded=True`), never breaking the loop" — this sets the SLO bar for this design: Qdrant availability affects **retrieval quality**, not consultation-loop uptime. That materially changes the HA calculus in §e — a hard outage is a quality regression, not an incident that pages on-call for the whole platform.

### a.9 `apps/nlp` — confirmed no Qdrant dependency

`grep -rli "qdrant" apps/nlp` returns nothing. NLP's only relationship to the RAG pipeline is indirect — harness calls NLP for entity extraction that feeds the retrieval query builder (`apps/harness/src/harness/guides/retrieval/retriever.py:66-81`) — not a Qdrant integration.

---

## b) Proposed manifests

**These are proposals for review — nothing below has been applied to `hope-v2-deployment`.** Per the project's 5-phase workflow, this is Phase 2/3 output; Phase 4 (implementation) starts only after this plan is approved.

### b.1 Style baseline (from reading `ollama.yaml`, `guardrail.yaml`, `vault.yaml`, `kustomization.yaml`)

- Object names: StatefulSet + Service both `hope-<component>` → `hope-qdrant`.
- Labels: `app: hope-qdrant` on every object; `app.kubernetes.io/part-of: project-hope` is injected by base `commonLabels` (`kustomization.yaml:4-5`) but is also written redundantly on top-level `metadata.labels`, matching `ollama.yaml:5-7` / `guardrail.yaml:5-7`.
- StatefulSet + PVC: `volumeClaimTemplates` (the `ollama.yaml` pattern), not a standalone PVC object — `vault.yaml` is the one precedent for a standalone-PVC StatefulSet, but `ollama.yaml` is the cleaner/more-conventional template and is what this design follows.
- No `storageClassName` anywhere in the repo — cluster default is used everywhere; same here (k3s local-path by default; see §e for the EKS equivalent).
- No `securityContext` anywhere in base except `stt-v2*.yaml`'s outlier `runAsUser: 0` — house style omits it, so this manifest omits it too rather than introduce a new precedent unreviewed.
- Public vendor images are hardcoded with an explicit tag directly in base (`ollama/ollama:0.18.2`, `hashicorp/vault:1.18.3`) — same for `qdrant/qdrant`. The dev compose pins `v1.16` (`infrastructure/docker/docker-compose.dev.yml:122`); current upstream stable is materially newer (v1.17.x line as of March 2026 per Qdrant's GitHub releases — see §e sources). **Recommendation: bump dev compose and the new manifest together** to the same current-stable tag rather than let dev drift from prod on day one; exact tag TBD at implementation time, shown as `v1.17.4` below as a placeholder — pin the real latest stable at merge time.
- Resources are set directly in base (no repo precedent for per-overlay resource patches on ollama/vault/temporal); overlays only patch `namespace`/`commonLabels`/`images`/select ConfigMap values today.
- `envFrom: [configMapRef: hope-config, secretRef: hope-secrets]` + individual `env:` for service-specific values, `secretKeyRef` with `optional: true` for not-yet-populated secrets — the `GUARDRAIL_SERVICE_TOKEN` pattern in `guardrail.yaml:50-55` is the template this design copies for `QDRANT__SERVICE__API_KEY`.

### b.2 `deployment/k8s/base/qdrant.yaml` (new file)

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: hope-qdrant
  labels:
    app: hope-qdrant
    app.kubernetes.io/part-of: project-hope
spec:
  serviceName: hope-qdrant
  replicas: 1
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: hope-qdrant
  template:
    metadata:
      labels:
        app: hope-qdrant
    spec:
      containers:
        - name: qdrant
          image: qdrant/qdrant:v1.17.4   # placeholder — pin to current stable at implementation time; keep in lockstep with infrastructure/docker/docker-compose.dev.yml
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 6333
            - name: grpc
              containerPort: 6334
          env:
            # Auth is OFF unless hope-secrets carries these keys — same optional-secret
            # pattern as GUARDRAIL_SERVICE_TOKEN (guardrail.yaml:50-55). This lets dev
            # run unauthenticated (as it does today) while staging/prod populate the
            # secret out-of-band, with no manifest diff between environments.
            - name: QDRANT__SERVICE__API_KEY
              valueFrom:
                secretKeyRef:
                  name: hope-secrets
                  key: QDRANT_API_KEY
                  optional: true
            - name: QDRANT__SERVICE__READ_ONLY_API_KEY
              valueFrom:
                secretKeyRef:
                  name: hope-secrets
                  key: QDRANT_READ_ONLY_API_KEY
                  optional: true
            # Granular (collection-scoped) JWT access control — no-op unless API_KEY is
            # also set; see qdrant.tech/documentation/security.
            - name: QDRANT__SERVICE__JWT_RBAC
              value: "true"
            - name: QDRANT__LOG_LEVEL
              value: "INFO"
            # S3 snapshot storage — points at the platform's existing in-cluster MinIO
            # (see docs/architecture/overview.md; MinIO already runs at hope-minio:9000).
            # Optional-secret so it no-ops (falls back to local-disk snapshots) until the
            # bucket + credentials exist; see open question in §f before relying on this.
            - name: QDRANT__STORAGE__SNAPSHOTS_CONFIG__SNAPSHOTS_STORAGE
              valueFrom:
                configMapKeyRef:
                  name: hope-config
                  key: QDRANT_SNAPSHOTS_STORAGE
                  optional: true
            - name: QDRANT__STORAGE__SNAPSHOTS_CONFIG__S3_CONFIG__BUCKET
              valueFrom:
                secretKeyRef:
                  name: hope-secrets
                  key: QDRANT_SNAPSHOTS_S3_BUCKET
                  optional: true
            - name: QDRANT__STORAGE__SNAPSHOTS_CONFIG__S3_CONFIG__ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: hope-secrets
                  key: QDRANT_SNAPSHOTS_S3_ACCESS_KEY
                  optional: true
            - name: QDRANT__STORAGE__SNAPSHOTS_CONFIG__S3_CONFIG__SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: hope-secrets
                  key: QDRANT_SNAPSHOTS_S3_SECRET_KEY
                  optional: true
            - name: QDRANT__STORAGE__SNAPSHOTS_CONFIG__S3_CONFIG__ENDPOINT_URL
              valueFrom:
                configMapKeyRef:
                  name: hope-config
                  key: MINIO_ENDPOINT
                  optional: true
          volumeMounts:
            - name: data
              mountPath: /qdrant/storage
          readinessProbe:
            httpGet:
              path: /readyz
              port: 6333
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /livez
              port: 6333
            initialDelaySeconds: 60
            periodSeconds: 30
            failureThreshold: 10
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
  volumeClaimTemplates:
    - apiVersion: v1
      kind: PersistentVolumeClaim
      metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 50Gi   # see §f — no corpus-size estimate exists in the repo to size this against
---
apiVersion: v1
kind: Service
metadata:
  name: hope-qdrant
  labels:
    app: hope-qdrant
spec:
  clusterIP: None
  selector:
    app: hope-qdrant
  ports:
    - name: http
      port: 6333
      targetPort: 6333
    - name: grpc
      port: 6334
      targetPort: 6334

```

Notes on choices that deviate from a naive lift of the compose service:

- **`/readyz` / `/livez`** rather than compose's total absence of a healthcheck — these have been available since Qdrant v1.5.0 and are documented to return HTTP 200 "regardless of whether an API key is configured" (Qdrant monitoring docs), so they work whether or not `QDRANT__SERVICE__API_KEY` is set — important because dev intentionally runs unauthenticated.
- **`QDRANT__SERVICE__JWT_RBAC: "true"`** is safe to leave on unconditionally — it's a no-op without an `api_key` set (JWT RBAC is layered on top of API-key auth), so it doesn't change dev's unauthenticated behavior but means staging/prod get collection-scoped tokens for free the moment a key is populated, with no manifest change.
- **Two named container ports** (http/grpc) even though the current harness client only speaks HTTP (`qdrant_store.py:86-88` uses `QdrantClient(url=...)`, no gRPC) — exposing gRPC now avoids a manifest change if/when the client is switched to gRPC for lower-latency internal calls (a cheap, non-committal addition, not a new dependency).
- **No `imagePullSecrets`** — `qdrant/qdrant` is a public image, matching the `ollama.yaml` convention.

### b.3 `deployment/k8s/base/kustomization.yaml` — registration

```yaml
resources:
  - configmap.yaml
  - observability-config.yaml
  - otel-collector.yaml
  - prometheus.yaml
  - loki.yaml
  - tempo.yaml
  - grafana.yaml
  - ollama.yaml
  - qdrant.yaml          # NEW — placed before harness.yaml since harness's retrieval feature depends on it
  - api.yaml
  - smr.yaml
  - guardrail.yaml
  - stt-v2.yaml
  - stt-v2-worker.yaml
  - tts-v2.yaml
  - nlp.yaml
  - harness.yaml
  - admin-console.yaml
  - compat-playground.yaml
  - db-migrate.yaml
  - vault.yaml
  - temporal.yaml

```

(Single-line insertion; no other change to the file.)

### b.4 `deployment/k8s/base/configmap.yaml` — new keys

Add alongside the existing `*_URL` block (`configmap.yaml:23-28`):

```yaml
  QDRANT_URL: "http://hope-qdrant:6333"
  QDRANT_SNAPSHOTS_STORAGE: "local"   # flip to "s3" per-overlay once the MinIO bucket exists (see §f)

```

`QDRANT_URL` here is the **internal cluster DNS name**, following the exact convention already used for every other in-cluster service (`SMR_URL: "http://hope-smr:8862"`, `HARNESS_URL: "http://hope-harness:8866"` — `configmap.yaml:24-28`). `harness.yaml` wires this into `HARNESS_RETRIEVAL_QDRANT_URL` (§c.2).

### b.5 Overlay patches

**Design choice**: put every environment-sensitive *value* (API keys, S3 credentials) in `hope-secrets` (out-of-band, per `deployment/secrets.{dev,staging,prod}.yaml.example`) rather than in kustomize JSON6902 patches, so dev/staging/prod share one manifest and differ only in secret contents — this matches how the repo already treats `GUARDRAIL_SERVICE_TOKEN` and avoids fragile index-based patches for anything security-sensitive (the existing `smr.yaml` dev patch that replaces `containers/0/env/5/value` by array index is exactly the kind of fragility to avoid for auth material). The patches below are limited to what genuinely differs *structurally* per environment: resource sizing and PVC capacity.

**`deployment/k8s/overlays/dev/kustomization.yaml`** — add to the existing `patches:` list:

```yaml
  # --- Qdrant: smaller PVC for the dev node ---
  - target:
      kind: StatefulSet
      name: hope-qdrant
    patch: |
      - op: replace
        path: /spec/volumeClaimTemplates/0/spec/resources/requests/storage
        value: 10Gi
      - op: replace
        path: /spec/template/spec/containers/0/resources/requests/cpu
        value: "250m"
      - op: replace
        path: /spec/template/spec/containers/0/resources/requests/memory
        value: "512Mi"

```

**`deployment/k8s/overlays/staging/kustomization.yaml`** — add:

```yaml
  # --- Qdrant: parity-with-prod sizing for pre-prod validation ---
  - target:
      kind: StatefulSet
      name: hope-qdrant
    patch: |
      - op: replace
        path: /spec/volumeClaimTemplates/0/spec/resources/requests/storage
        value: 50Gi

```

(No change needed beyond the base default — staging keeps base's 50Gi/500m/1Gi to validate against prod-like sizing before promotion.)

**`deployment/k8s/overlays/prod/kustomization.yaml`** — add:

```yaml
  # --- Qdrant: production capacity ---
  - target:
      kind: StatefulSet
      name: hope-qdrant
    patch: |
      - op: replace
        path: /spec/volumeClaimTemplates/0/spec/resources/requests/storage
        value: 200Gi
      - op: replace
        path: /spec/template/spec/containers/0/resources/requests/cpu
        value: "1"
      - op: replace
        path: /spec/template/spec/containers/0/resources/requests/memory
        value: "4Gi"
      - op: replace
        path: /spec/template/spec/containers/0/resources/limits/cpu
        value: "4"
      - op: replace
        path: /spec/template/spec/containers/0/resources/limits/memory
        value: "16Gi"

```

All three overlays inherit `commonLabels: {environment: <env>}` and `namespace: hope-v2-<env>` automatically from the existing overlay structure (`overlays/dev/kustomization.yaml:4-7` pattern) — no Qdrant-specific change needed there. **Note**: `volumeClaimTemplates` are immutable after StatefulSet creation in Kubernetes — the per-overlay storage sizes above are the *initial* size for each environment; growing a live PVC later requires either a storage class with `allowVolumeExpansion: true` (in-place resize) or a manual snapshot-restore-into-larger-PVC migration (see §d.2).

### b.6 Collection provisioning — the `qdrant-init` gap

The compose `qdrant-init` sidecar (`docker-compose.dev.yml:129-146`) — `python:3.11-slim-trixie` + `pip install qdrant-client` + run `init-qdrant-collections.py` — has **no k8s equivalent proposed here**, and it needs one before `harness.yaml` can safely enable retrieval, because `create_collection` is never called by the application at runtime (only by this script). Recommended shape, following the `vault.yaml` `hope-vault-init` Job precedent (`sync-wave: "1"`, `hook: Sync`) rather than `db-migrate.yaml`'s `PreSync` (Qdrant must already be `Ready` before this Job runs, so it belongs *after* the StatefulSet, not before it):

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: hope-qdrant-init
  labels:
    app: hope-qdrant-init
    app.kubernetes.io/part-of: project-hope
  annotations:
    argocd.argoproj.io/hook: Sync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
    argocd.argoproj.io/sync-wave: "1"
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: qdrant-init
          image: hope-v2/qdrant-init:latest   # NEW image — build infrastructure/docker/scripts/init-qdrant-collections.py into a small CI-built image, same as every other hope-v2/* image, rather than pip-installing at pod-start against an untrusted network (acceptable for local dev, not for a PHI cluster)
          env:
            - name: QDRANT_HOST
              value: "hope-qdrant"
            - name: QDRANT_PORT
              value: "6333"
            - name: QDRANT_API_KEY
              valueFrom:
                secretKeyRef:
                  name: hope-secrets
                  key: QDRANT_API_KEY
                  optional: true

```

This needs a small CI addition (a Dockerfile for `qdrant-init`, wired into the existing image-build pipeline the same way every other `hope-v2/*` service is) — flagged as an explicit dependency in §f, not something this manifest alone delivers. It also needs the `stt_speaker_embeddings` block removed from `init-qdrant-collections.py` first (§a.1) so production never provisions a collection nothing reads.

---

## c) Config/env wiring

### c.1 Python side — `apps/harness`

Two code changes are required before the manifest in §b does anything beyond "Qdrant is reachable":

- **`RetrievalConfig` needs an `api_key` field** (`apps/harness/src/harness/core/config.py:131-187`) — currently only `qdrant_url`, `collection`, `qdrant_timeout_s` exist under `env_prefix="HARNESS_RETRIEVAL_"`. Add `qdrant_api_key: SecretStr | None = None` following the existing `SecretStr` convention used elsewhere in the repo for secrets (`06-python-services.md`: "Secrets typed as `SecretStr`").
- **`KnowledgeQdrantStore.__init__` needs to accept and pass it** (`qdrant_store.py:70-88`) — `QdrantClient(url=url, api_key=api_key.get_secret_value() if api_key else None, timeout=...)`.

Without these two changes, deploying an authenticated Qdrant to production makes the harness client fail every request (401), because there is currently no code path that would send the key even if the manifest provides it.

- **`harness.yaml`** in the deployment repo currently carries **zero** `HARNESS_RETRIEVAL_*` env vars (confirmed by grep against the live manifest) — matching the fact that `HARNESS_RETRIEVAL_ENABLED` defaults `False` everywhere (§a.8). Wiring for when the flag is ready to flip on:

```yaml
            - name: HARNESS_RETRIEVAL_QDRANT_URL
              value: "$(QDRANT_URL)"          # from hope-config, see §b.4
            - name: HARNESS_RETRIEVAL_QDRANT_API_KEY
              valueFrom:
                secretKeyRef:
                  name: hope-secrets
                  key: QDRANT_API_KEY
                  optional: true
            - name: HARNESS_RETRIEVAL_COLLECTION
              value: "knowledge_chunks"
            - name: HARNESS_RETRIEVAL_ENABLED
              value: "false"    # flip only after the eval-gated rollout in docs/operations/retrieval-corpus-ingestion/README.md §3

```

This block is **not** added in this design doc's proposed `harness.yaml` diff — flipping `HARNESS_RETRIEVAL_ENABLED` is an explicit, owner-run, evaluation-gated decision per the runbook (§a.8), separate from "Qdrant infrastructure exists." Standing up Qdrant and turning on retrieval are two different approvals; conflating them would violate the runbook's own flag-flip discipline.

### c.2 Env-var registration housekeeping

- Add `HARNESS_RETRIEVAL_QDRANT_URL`, `HARNESS_RETRIEVAL_QDRANT_API_KEY`, `HARNESS_RETRIEVAL_COLLECTION`, `HARNESS_RETRIEVAL_QDRANT_TIMEOUT_S` to `turbo.json#globalEnv` — currently absent (zero `QDRANT` hits in `turbo.json`), which is a pre-existing gap independent of this design (per `00-project-context.md`: "New runtime env vars must be added to `turbo.json#globalEnv`").
- `.env.sample` (root) and `apps/harness/.env.sample` already carry `HARNESS_RETRIEVAL_QDRANT_URL` / `HARNESS_RETRIEVAL_COLLECTION` (`.env.sample:1396,1398`) — add `HARNESS_RETRIEVAL_QDRANT_API_KEY=` (empty placeholder) alongside them once the code change in §c.1 lands.
- `QDRANT_API_KEY` for the **provisioning script** stays deliberately out of the application secrets registry per the existing documented rationale (`platform-secrets.descriptors.ts:29-41`) — it becomes a `hope-secrets` k8s Secret key instead, consumed only by the `qdrant-init` Job and the `hope-qdrant` StatefulSet itself, never by an application service. Do not add it to `platform-secrets.descriptors.ts`; that would contradict the existing, correct rationale there.

### c.3 TS side

No TS code touches Qdrant — `packages/applications/src/services/knowledge/knowledge-ingest.client.ts` calls `apps/harness` over HTTP (`POST /api/v1/internal/knowledge/ingest`), not Qdrant directly. No TS-side wiring is needed beyond what already exists for reaching `HARNESS_URL` (already registered, `configmap.yaml:28`).

---

## d) Security, backup, observability

### d.1 Security

| 

| Layer
| Recommendation
| Grounding

| API-key auth
| `QDRANT__SERVICE__API_KEY` (admin) + `QDRANT__SERVICE__READ_ONLY_API_KEY` — set via `hope-secrets`, optional today so dev is unaffected; **required** before this design is production-ready given §a.6's finding that nothing authenticates today
| qdrant.tech/documentation/security

| Collection-scoped access
| `jwt_rbac: true` alongside the API key — Qdrant's JWT tokens can be scoped to a specific collection and to read-only vs. read-write, which is the closest Qdrant gets to a tenant boundary; still **not** a substitute for the app-level `tenant_id` filter in §a.5, since a single `knowledge_chunks` collection is shared by every tenant — JWT scoping only helps separate *service identities* (e.g. `qdrant-init` write-access vs. `harness` query-only), not tenants
| requires Qdrant ≥ 1.9 (well below the proposed `v1.17.4`); qdrant.tech blog, 1.9.0 RBAC

| Transport
| Internal cluster traffic is unencrypted HTTP by default in this design (matches every other internal `hope-*` service today — none of `smr.yaml`/`guardrail.yaml`/etc. use TLS between pods). Qdrant supports `service.enable_tls` + a `tls:` cert/key block, and separately `cluster.p2p.enable_tls` for inter-node traffic if the cluster ever goes distributed (§e). Recommend leaving in-cluster TLS as a NetworkPolicy-backed decision rather than per-pod TLS, matching house convention, **unless** the platform's PHI threat model requires pod-to-pod encryption — flagged as an open question in §f, since the query vector sent to Qdrant is derived from transcript/entity text and "can contain PHI" per `RetrievalConfig`'s own docstring (`config.py:149-150`), even though the *collection contents* (institutional literature) are not PHI
| 

| Network isolation
| Restrict `hope-qdrant`'s Service to be reachable only from `hope-harness` (and the `hope-qdrant-init` Job) via a `NetworkPolicy` — no such policy exists in the repo today for any service (confirmed no `NetworkPolicy` kind anywhere in `deployment/k8s/`), so this would be a new pattern; worth introducing here specifically because `hope-qdrant` has no app-level authorization model at all — everything reachable at the socket has full read/write to every tenant's chunks unless the API key blocks it
| 

| Host binding
| `service.host` defaults to `0.0.0.0` inside the container, which is correct for a ClusterIP-less headless Service reached only via cluster DNS — no change needed, just don't NodePort/LoadBalancer-expose this Service
| 

### d.2 Backup / DR

- **Snapshots API**: collection-level (`POST /collections/knowledge_chunks/snapshots`, `GET .../snapshots`, `PUT .../snapshots/recover`) and full-storage (`POST /snapshots`) — qdrant.tech/documentation/snapshots.
- **S3 storage**: `storage.snapshots_config.snapshots_storage: s3` + `s3_config.{bucket,region,access_key,secret_key,endpoint_url}`, with env-var equivalents `QDRANT__STORAGE__SNAPSHOTS_CONFIG__S3_CONFIG__*` — wired in §b.2 against the platform's **existing in-cluster MinIO** (already S3-compatible, already used for tenant blob storage per `00-project-context.md`'s port table) rather than provisioning a separate AWS S3 bucket. This reuses infrastructure the platform already operates and secures, instead of adding a new credential surface.
- **Known limitation** (2025-era, still worth planning around): there is currently no way to restore a collection *directly* from an S3-stored snapshot — the documented workaround is a presigned URL fed to the recover endpoint. Practically: back up to S3/MinIO for durability, but the restore runbook should assume "download via presigned URL, then `PUT .../snapshots/recover` with the local path or a fetched URL," not a one-command S3-native restore.
- **Version compatibility**: snapshots restore only across nodes on the **same minor version** — pin the image tag precisely (§b.1) and treat a Qdrant minor-version bump as requiring a fresh snapshot taken *after* the upgrade, not reliance on pre-upgrade snapshots as a rollback path across the version boundary.
- **Cadence**: recommend a `CronJob` (no precedent in the repo for one, but `db-migrate.yaml`'s Job pattern is the closest template) calling the collection-snapshot endpoint on a schedule, retaining N snapshots in MinIO with a lifecycle policy — this is infrastructure this design flags but does not fully specify (open question, §f), since snapshot *frequency* should be driven by how often `knowledge_chunks` actually mutates (ingestion is described as infrequent/owner-run in the runbook, §a.8), not by a generic RPO number invented here.
- **PVC growth**: since `volumeClaimTemplates` are immutable post-creation (§b.5), the practical resize path if 200Gi (prod) proves too small is: (1) if the StorageClass supports `allowVolumeExpansion`, patch the PVC directly (bypassing the StatefulSet template) — supported by k8s but needs verification against whatever StorageClass k3s/EKS ends up using; or (2) snapshot → provision a larger PVC → restore. Either path should be exercised at least once in staging before it's needed in prod.

### d.3 Observability

- **Prometheus**: native `/metrics` endpoint (port 6333, Prometheus/OpenMetrics format) — qdrant.tech monitoring docs. The platform already runs an in-cluster `prometheus.yaml` (`deployment/k8s/base/prometheus.yaml`) — add `hope-qdrant:6333` as a scrape target. **Caveat directly from the docs**: `/metrics` "only reports metrics for the peer connected to" — matters if/when this ever becomes a multi-node cluster (§e); irrelevant for the single-replica design proposed here.
- **Health endpoints** (available since v1.5.0, "always accessible" regardless of API key): `/healthz`, `/livez`, `/readyz` — used directly in the probes in §b.2.
- **Telemetry**: `/telemetry` (single-node state: vector/shard counts) and `/cluster/telemetry` (multi-peer aggregate, more reliable for shard-transfer progress) — useful for a Grafana panel on collection size/point-count growth, not required for the MVP dashboard.
- **Key SLIs to dashboard** (derived from what the code actually stresses, §a): query latency (harness's hybrid RRF path has a `qdrant_timeout_s` default of 10s — a good alert threshold), point count and disk usage growth (against the PVC ceiling in §b.5), and — because retrieval failure is explicitly degrade-safe (§a.8) — an **availability** SLI is lower priority than a **staleness** SLI (are ingested documents actually queryable within some bound after `APPROVED`), which nothing in this design currently measures and would need to come from the harness-eval scorecard referenced in the runbook, not from Qdrant metrics directly.
- The platform's existing OTel collector (`otel-collector.yaml`) is the natural place to scrape/forward `/metrics` if the team wants it flowing through the same pipeline as every other `hope-*` service rather than a standalone Prometheus scrape target — a house-style question, not a Qdrant question (flagged, not decided, in §f).

---

## e) k3s today vs. EKS later — portability table

| 

| Concern
| k3s (`hope-v2-dev` today)
| EKS (future)
| What changes in the manifest

| Storage class
| No `storageClassName` set anywhere in the repo — k3s's built-in `local-path` provisioner is the implicit default, which is **node-local** (no live migration if the pod reschedules to a different node)
| `ebs.csi.eks.amazonaws.com` provisioner, `gp3` (recommended default: 3000 IOPS / 125 MB/s baseline, tunable up without a volume-type change) unless a benchmarked I/O-bound workload justifies `io2` Block Express; requires the EBS CSI driver installed as an EKS add-on with an IRSA-scoped IAM role, since the in-tree AWS EBS plugin is deprecated
| Overlay-specific `StorageClass` object + `storageClassName: gp3-encrypted` (or similar) added to the PVC template in an EKS-specific overlay; base manifest stays cloud-agnostic (omits `storageClassName`, as it does today)

| Replica / HA model
| 1 replica, single k3s node — matches this design's §b proposal; a node failure means Qdrant is down until the pod reschedules and the PVC reattaches (feasible with `local-path` only if it reschedules back to the *same* node)
| EKS multi-AZ nodegroups make a single-replica StatefulSet's PVC **zone-locked** (EBS volumes are AZ-bound) — either pin the pod to a zone via `nodeSelector`/`topologySpreadConstraints`, or move to a real 3-node distributed Qdrant cluster (§ below) so a zone loss doesn't take the only replica down
| k3s: no change needed. EKS: add a zone-aware `nodeSelector` or graduate to distributed mode

| Distributed cluster
| Not warranted — single collection, feature-flagged off in every environment today, degrade-safe on outage (§a.8, §d.3)
| Same reasoning holds until real production query volume exists; if/when it's needed, Qdrant's Raft-based consensus requires ≥3 voting nodes for quorum, with `replication_factor` and `write_consistency_factor` configured per collection (qdrant.tech distributed deployment guide)
| Not part of this design — flagged for a future ticket once §f's volume questions are answered

| Snapshot storage
| In-cluster MinIO (§d.2) — already deployed, already the platform's S3-compatible store
| Same MinIO-first approach works unchanged on EKS (MinIO doesn't care which cluster it runs in) **or** swap to real AWS S3 with an IRSA role instead of static access keys — a strict security improvement available only on EKS
| `S3_CONFIG__ENDPOINT_URL` becomes unnecessary against real S3 (defaults to AWS's endpoint); access via IRSA instead of `secretKeyRef` static keys is an EKS-only capability

| Image pull
| Public `qdrant/qdrant` image straight from Docker Hub — same as `ollama/ollama` today
| Same; no registry mirroring needed unless the org mandates a private mirror for supply-chain reasons (no current precedent for that in this repo either way)
| No change

| Secrets delivery
| `hope-secrets` applied out-of-band from a filled `deployment/secrets.dev.yaml.example` template (current repo pattern; §b.5)
| `09-infrastructure-devops.md` already states the target-state preference for EKS-class clusters: Vault Agent / Vault Secrets Operator injection over materialized k8s Secrets, since the platform runs Vault HA already
| Not Qdrant-specific — inherits whatever the platform decides for secret delivery generally; this design's `secretKeyRef` wiring works either way (Vault Agent can populate the same-named k8s Secret, or inject via sidecar instead)

| Managed alternative
| N/A — self-hosting is the only option on k3s
| **Qdrant Cloud** (fully managed, ~$300–600/mo mid-size workload) or **Qdrant Hybrid Cloud** (bring-your-own-EKS, Qdrant manages the control plane) are both real options once real production traffic exists — worth an explicit build-vs-buy decision at that point rather than defaulting to self-hosted by inertia, since self-hosting carries the operational burden documented in §d (backup cadence, version-pinned snapshot restores, RBAC/TLS configuration) that a managed offering absorbs
| Out of scope for k3s (no managed k3s-hosted option exists); becomes a real decision point at EKS migration time

---

## f) Open questions (not determined by the code)

- **Corpus volume estimate.** Nothing in the repo — not the runbook, not the seed data, not the ingestion tooling — states an expected point count for `knowledge_chunks` (PMC-OA alone can be millions of documents before chunking). The 50Gi/200Gi PVC sizes in §b.5 are placeholders based on the generic quantization-aware sizing formula (`points × dim × 4 bytes × ~1.3 HNSW overhead`, plus payload text, plus sparse vectors), not a real estimate. **Needs an answer from whoever owns the corpus-ingestion runbook (`docs/operations/retrieval-corpus-ingestion/`) before PVC sizes are finalized.**
- **Quantization.** Given clinical citation grounding is the whole point of this collection (the runbook gates the feature on a faithfulness/citation-delta eval, §a.8), recommend **scalar (int8) quantization with `always_ram: true`** rather than binary/product — 4x compression with minimal (~1-2%) recall loss is a reasonable default; binary/product's larger accuracy tradeoff should not be adopted without re-running that eval gate against the quantized index. This is a recommendation, not a code requirement — nothing in the current collection-creation call sets any quantization config today (§a.2), so this is a genuinely open design choice, not a gap-fill.
- **In-cluster TLS.** Is pod-to-pod TLS a hard requirement for this platform's PHI posture, given the query vector (not the stored corpus) can be PHI-derived (§d.1)? No other `hope-*` service encrypts internal traffic today, so doing it only for Qdrant would be a new, isolated precedent — worth a platform-wide decision, not a Qdrant-specific one.
- **`qdrant-init` image ownership.** §b.6 proposes a new `hope-v2/qdrant-init` CI-built image; this needs a CI/CD ticket (Dockerfile + pipeline wiring) that is out of scope for this design doc.
- **Snapshot cadence and retention.** §d.2 flags the need for a scheduled snapshot Job but doesn't specify an RPO — needs input from whoever owns data-retention policy for the institutional corpus (note: `knowledge_chunks` is re-derivable from source documents + the embedding pipeline, so its RPO tolerance may be much looser than, say, the Postgres primary DB's).
- **`stt_speaker_embeddings` cleanup.** Confirmed dead (§a.1) — recommend removing its `create_collection` call from `init-qdrant-collections.py` as a small, separate cleanup so production provisioning never creates a collection nothing reads. Also recommend correcting the stale reference in `docs/architecture/overview.md:303`.
- **Code changes gating auth** (§c.1) — adding `api_key` support to `RetrievalConfig` and `KnowledgeQdrantStore` is required before the security posture in §d.1 is real, not just configured. This is a small, well-scoped harness change but is code, not infra, and belongs in its own PR following the repo's TDD workflow (`01-development-workflow.md`).
- **Metrics pipeline routing** — scrape `/metrics` directly with the existing `prometheus.yaml`, or route through the existing OTel collector like other `hope-*` services (§d.3)? A house-style consistency question, not a Qdrant-specific one.
- **Distributed cluster trigger.** §e defers sharding/replication entirely. What's the actual trigger condition — a point-count threshold, a query-latency SLO breach, or simply "before this becomes customer-facing GA"? Not determined anywhere in the code or docs today.

---

## Sources (Task 3 research)

- Qdrant Security — API key, read-only key, JWT RBAC, TLS config keys
- Qdrant 1.9.0 — RBAC announcement
- Qdrant Snapshots — snapshot API, S3 config keys
- Qdrant Monitoring & Telemetry — `/metrics`, `/healthz`, `/livez`, `/readyz`, `/telemetry`
- Qdrant Distributed Deployment guide
- Qdrant Quantization guide
- Qdrant Helm charts and Qdrant Operator
- Deploy a Qdrant vector database on GKE (Google Cloud docs) — general k8s StatefulSet pattern reference
- Deploying Qdrant OSS on Kubernetes — HA + PVC + Auth/RBAC + ALB Ingress (Medium) — EKS/EBS pattern reference
- Qdrant Cloud / self-hosted pricing overviews (2026): Qdrant Cloud pricing tiers, vector DB pricing comparison
