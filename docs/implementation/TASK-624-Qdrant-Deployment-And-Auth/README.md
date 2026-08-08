# TASK-624 — Qdrant Production Deployment & Auth (Harness Retrieval)

**Status**: Pending (plan authored 2026-08-08, awaiting owner approval)
**Classification**: infrastructure
**Created**: 2026-08-08
**Parent**: [TASK-616 Phase 7b](../TASK-616-Deployment-CICD-Observability-Modernization/README.md) · [Program index](../TASK-616-Deployment-CICD-Observability-Modernization/phase-program-index.md) — depends on [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md)
**Scope**: `apps/harness` (`core/config.py`, `guides/retrieval/qdrant_store.py`) · `infrastructure/docker/scripts/init-qdrant-collections.py` · `arca/hope-v2-deployment` (new `qdrant.yaml`, `kustomization.yaml`, `configmap.yaml`, overlay patches, `hope-qdrant-init` Job + its CI-built image) · `turbo.json#globalEnv` / `.env.sample`
**Conventions**: [Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md)
**Evidence base**: [Qdrant component design](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-qdrant.md) · [Program index §1](../TASK-616-Deployment-CICD-Observability-Modernization/phase-program-index.md#1-the-ten-tickets)

---

## 1. Requirement Analysis

TASK-616 Phase 7b scoped a design-only exercise: work out what standing up Qdrant in the
`hope-v2-dev` cluster actually requires, given that today it does not exist there at all.

> `kubectl get all -A` returns zero Qdrant resources. Qdrant exists only in local-dev
> `docker-compose`. `grep -rn "QDRANT\|HARNESS_RETRIEVAL" arca/hope-v2-deployment/` returns
> zero hits — the deployment repo has never mentioned Qdrant.

The design doc (component-design-qdrant.md) also found something the phase name doesn't
capture: **the runtime client cannot authenticate even if the manifest supplies a key.**
`KnowledgeQdrantStore.__init__` never accepts an `api_key`. Shipping an authenticated Qdrant
to a PHI-adjacent cluster therefore requires a code change first — the manifest alone cannot
make auth real.

| Part | Restated requirement |
|---|---|
| **A — Code (auth capability)** | `RetrievalConfig` gains `qdrant_api_key: SecretStr \| None`; `KnowledgeQdrantStore` threads it into `QdrantClient(...)`. TDD: a failing test first. |
| **B — Manifest authoring** | `qdrant.yaml` (StatefulSet + headless Service), kustomization registration, `configmap.yaml` keys, per-overlay PVC/resource patches, the `hope-qdrant-init` provisioning Job and its new CI-built image. |
| **C — Provisioning hygiene** | Remove the dead `stt_speaker_embeddings` collection from `init-qdrant-collections.py` so production provisioning never creates a collection nothing reads; correct the stale reference in `docs/architecture/overview.md:303`. |

**Classification**: `infrastructure`. **Not** a feature ticket — `HARNESS_RETRIEVAL_ENABLED`
stays `False` in every environment throughout this ticket. Standing up Qdrant as reachable
infrastructure and turning on retrieval are two separate, separately-gated approvals.

### Explicitly out of scope

| Excluded | Owned by |
|---|---|
| Flipping `HARNESS_RETRIEVAL_ENABLED` / corpus ingestion / tenant enablement | [`docs/operations/retrieval-corpus-ingestion/README.md`](../../operations/retrieval-corpus-ingestion/README.md) §3 — an owner-run, eval-gated runbook explicit that it must not run in CI or automation |
| Distributed / multi-node Qdrant, sharding, `replication_factor` | Future ticket — component design §e defers this; the trigger condition itself is an open question (⚠ below) |
| Qdrant Cloud / Qdrant Hybrid Cloud migration (build-vs-buy) | Future decision once real production query volume exists (design §e) |
| Platform-wide in-cluster pod-to-pod TLS | A cross-cutting platform decision, not Qdrant-specific — no other `hope-*` service encrypts internal traffic today either (⚠ below) |
| Prometheus/OTel scrape-pipeline routing for every service | [TASK-636](../TASK-636-Observability-Coverage-And-Dependency-Monitoring/README.md) — TASK-636's OBS-28 already names this ticket as owning *deployment*; TASK-636 owns wiring the scrape target once Qdrant exists |
| General k3s `NetworkPolicy` authoring | [TASK-618](../TASK-618-PHI-Security-Baseline/README.md) — this ticket flags the need (design §d.1) but does not author the policy |
| GitOps recovery — making a push actually reach the cluster | [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) — hard dependency, see §5 |

---

## 2. Current State Evaluation

### 2.1 Deployment — entirely absent

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **Q-01** | Critical | **NOT-DONE** | Qdrant has no manifest anywhere in the deployment repo. `harness.yaml` carries zero `HARNESS_RETRIEVAL_*` env vars. | `kubectl get all -A` (zero Qdrant resources); `grep -rn "QDRANT\|HARNESS_RETRIEVAL" arca/hope-v2-deployment/` (zero hits) |
| **Q-02** | High | **NOT-DONE** | No `qdrant-init` collection-provisioning Job or image exists in k8s — this is a new artifact, not a partially-built one. The dev-only sidecar pip-installs `qdrant-client` at pod start; that pattern is rejected for a PHI cluster. | `component-design-qdrant.md` §b.6; `infrastructure/docker/docker-compose.dev.yml:129-146` |
| **Q-07** | Medium | **NOT-DONE** | The dev `qdrant-init` sidecar's `pip install -q qdrant-client && python /scripts/init.py` pattern (untrusted network install at pod start) has no production-safe equivalent yet — needs a CI-built `hope-v2/qdrant-init` image instead. | `infrastructure/docker/docker-compose.dev.yml:135-146` |
| **Q-08** | Low | **NOT-DONE** | `turbo.json` has zero `QDRANT` hits — no `HARNESS_RETRIEVAL_QDRANT_*` var is registered in `globalEnv`. | `grep -n "QDRANT" turbo.json` → no matches |

### 2.2 Auth — code cannot authenticate even if the manifest provides a key

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **Q-03** | Critical | **NOT-DONE** | `KnowledgeQdrantStore.__init__` has no `api_key` parameter at all. | `apps/harness/src/harness/guides/retrieval/qdrant_store.py:70-88`; line 88 is `self._client = QdrantClient(url=url, timeout=cast(int, timeout))` |
| **Q-04** | Critical | **NOT-DONE** | `RetrievalConfig(BaseSettings)`, `env_prefix="HARNESS_RETRIEVAL_"`, has `qdrant_url` and `qdrant_timeout_s` — no `qdrant_api_key` field. | `apps/harness/src/harness/core/config.py:131-187` (fields at `:162`, `:180`) |
| **Q-05** | Medium | **PARTIAL** | The *provisioning script* already reads an API key (`QDRANT_API_KEY = os.getenv("QDRANT_API_KEY", None)`, used at `:123`), but no compose file sets the var, so it is `None` in practice today. This is the only place `api_key` is threaded through any client in the repo. | `infrastructure/docker/scripts/init-qdrant-collections.py:23,120-125` |
| **Q-09** | — | **DONE (correct as-is — do not reopen)** | `QDRANT_API_KEY` is deliberately excluded from the application secrets registry: its only reader is the provisioning script, which "runs outside the application env surface." This remains correct after this ticket — the key becomes a `hope-secrets` k8s key consumed only by the init Job and the StatefulSet, never registered as an application secret. | `packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts:29-41` |

### 2.3 Provisioning hygiene

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **Q-06** | Low | **NOT-DONE** | `init-qdrant-collections.py` still declares `stt_speaker_embeddings` (`STT_COLLECTION_NAME`, 512-dim) even though STT's Qdrant-backed speaker store was removed by design — cross-session speaker identity now lives in Postgres `UserVoiceProfile.embedding` (pgvector). Left in place, production provisioning would create a collection nothing reads. | `infrastructure/docker/scripts/init-qdrant-collections.py:24-26`; `apps/stt/tests/unit/diarization/test_no_qdrant_vectorstore.py`; `component-design-qdrant.md` §a.1 |
| **Q-10** | Low | **NOT-DONE** | `docs/architecture/overview.md:303` still describes STT voice enrollment as writing into Qdrant `stt_speaker_embeddings` — stale since the pgvector migration. | `component-design-qdrant.md` §a.1 |

### 2.4 The tenant-isolation boundary — context any change must preserve

Not a defect: `_tenant_approved_filter` (`qdrant_store.py:114-119`) is the **entire** tenant
boundary for `knowledge_chunks` — a single shared collection with no server-side per-tenant
partitioning. It is applied to both the dense and sparse `Prefetch` branches inside
`hybrid_query` (`qdrant_store.py:97-112`); an incomplete filter on either branch would leak
cross-tenant hits through RRF fusion. **This function is the one place a code review for this
ticket must scrutinize if the auth-threading change (Q-03/Q-04) touches `qdrant_store.py`'s
constructor or query path at all** — the boundary lives entirely in application code, not in
anything Qdrant itself enforces.

---

## 3. Implementation Plan

Four waves. Wave 1 and Wave 2 run concurrently (disjoint files: Python vs. the deployment
repo). Tier and effort per the
[Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md).

**⚙ = human-applied** (agent authors, owner executes). **⚠ = owner decision.**

### Wave 1 — Auth code (TDD)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **1.1** | Write a failing test asserting `RetrievalConfig` accepts `HARNESS_RETRIEVAL_QDRANT_API_KEY` / `qdrant_api_key: SecretStr \| None = None`, then add the field. | Q-04 | Trivial | `sonnet-5` | default | RED first, per `01-development-workflow.md`; `SecretStr` per `06-python-services.md` |
| **1.2** | Write a failing test asserting `KnowledgeQdrantStore.__init__` accepts `api_key` and passes `api_key.get_secret_value()` into `QdrantClient(...)` when set, `None` when unset. Then implement. | Q-03 | Moderate | `sonnet-5` | medium | Test in `apps/harness/src/harness/tests/`; assert the constructor call, not just that the field exists — the bug today is the value never reaches `QdrantClient` |
| **1.3** | Remove the `stt_speaker_embeddings` block from `init-qdrant-collections.py`; correct `docs/architecture/overview.md:303`. | Q-06, Q-10 | Trivial | `haiku-4-5` | default | Text + one dead-code deletion; no live dependency |

**Wave 1 gate**: `pnpm py:harness:test` green including the two new tests; both were RED before
the corresponding implementation commit (paste both runs as evidence).

### Wave 2 — Manifest authoring (deployment repo, disjoint files)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **2.1** | Author `deployment/k8s/base/qdrant.yaml` — StatefulSet (`hope-qdrant`, 1 replica, `volumeClaimTemplates`) + headless Service, per component-design-qdrant.md §b.2: `/readyz`/`/livez` probes, optional-secret `QDRANT__SERVICE__API_KEY`/`_READ_ONLY_API_KEY`, `QDRANT__SERVICE__JWT_RBAC: "true"`, optional S3-snapshot env block against the platform's existing MinIO. | Q-01 | Moderate | `sonnet-5` | medium | Follow the `ollama.yaml` StatefulSet+PVC-template style, not `vault.yaml`'s standalone-PVC style (design's stated house-style choice) |
| **2.2** | Register `qdrant.yaml` in `base/kustomization.yaml` (single-line insert, before `harness.yaml`); add `QDRANT_URL: "http://hope-qdrant:6333"` and `QDRANT_SNAPSHOTS_STORAGE: "local"` to `configmap.yaml`. | Q-01 | Trivial | `haiku-4-5` | default | Follows the exact `SMR_URL`/`HARNESS_URL` internal-DNS convention already in `configmap.yaml:24-28` |
| **2.3** | Author per-overlay PVC/resource patches: dev 10Gi / 250m CPU / 512Mi mem; staging inherits base's 50Gi/500m/1Gi unpatched; prod 200Gi / 1–4 CPU / 4–16Gi. | Q-01 | Moderate | `sonnet-5` | medium | Sizes are **placeholders** pending ⚠1 (corpus point-count estimate) — state that explicitly in the PR description, not just in this README |
| **2.4** | Author `deployment/k8s/base/qdrant-init.yaml` — a `Sync`-hook Job (not `PreSync` — Qdrant must already be `Ready`), `hook-delete-policy: BeforeHookCreation`, `sync-wave: "1"`, running `hope-v2/qdrant-init` against `hope-qdrant:6333` with the optional `QDRANT_API_KEY` secret. | Q-02 | Moderate | `sonnet-5` | medium | Model on `vault.yaml`'s `hope-vault-init` Job precedent, not `db-migrate.yaml`'s `PreSync` hook — the ordering constraint is opposite |
| **2.5** | Author a `Dockerfile` for `hope-v2/qdrant-init` (bakes `infrastructure/docker/scripts/init-qdrant-collections.py` + `qdrant-client` into an image, no pip-install-at-pod-start) and a `build-qdrant-init` CI job wired the same way every other `hope-v2/*` image is built. | Q-02, Q-07 | Moderate | `sonnet-5` | high | New image + new CI job in the deployment repo's own `.gitlab-ci.yml` — verify against its existing five-job `render`/`schemas`/`config-refs`/`image-hygiene`/`secrets` gate before calling this done |
| **2.6** | Register `HARNESS_RETRIEVAL_QDRANT_URL`, `HARNESS_RETRIEVAL_QDRANT_API_KEY`, `HARNESS_RETRIEVAL_COLLECTION`, `HARNESS_RETRIEVAL_QDRANT_TIMEOUT_S` in `turbo.json#globalEnv`; add the empty placeholder to `.env.sample` / `apps/harness/.env.sample`. | Q-08 | Trivial | `haiku-4-5` | default | Per `00-project-context.md`: "New runtime env vars must be added to `turbo.json#globalEnv`" |

**Wave 2 gate**: `kustomize build` of all three overlays succeeds; the deployment repo's five CI
jobs pass against the new files; `hope-qdrant`/`hope-qdrant-init` appear in the rendered output
of every overlay.

> **Not in Wave 2**: wiring `HARNESS_RETRIEVAL_QDRANT_*` into `harness.yaml` itself and flipping
> `HARNESS_RETRIEVAL_ENABLED`. Both are explicitly deferred to the eval-gated runbook (§1) — this
> ticket makes Qdrant reachable infrastructure, not a live retrieval backend.

### Wave 3 — Owner-decision support (analysis only)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **3.1** | Draft the quantization recommendation as a reviewable diff-note (scalar int8 + `always_ram: true`) against the collection-creation call, for the owner to approve or reject alongside ⚠2. | — | Moderate | `sonnet-5` | medium | Not applied — nothing in the current `create_collection` call sets quantization (§a.2 of the design); this is a proposal, not a code change, until ⚠2 is decided |

### Wave 4 — Apply ⚙ + verification

| # | Task | Tier |
|---|---|---|
| **4.1** | ⚙ Apply Wave 2 via a normal Argo sync (blocked on TASK-617 Part A — GitOps must be able to deliver first) | **human** |
| **4.2** | ⚙ Confirm `hope-qdrant` reaches `Ready`, `hope-qdrant-init` completes, `knowledge_chunks` exists with the expected dense(1024, COSINE)+sparse(`bm25`, IDF) shape, and `stt_speaker_embeddings` is **not** created | **human** |
| **4.3** | Capture evidence for every §6 gate; write the Implementation Summary | `sonnet-5` (medium) |

---

## 4. Owner decisions and blocked items

| # | Item | Why it is owner-only |
|---|---|---|
| **⚠ 1** | **Corpus point-count estimate.** Nothing in the repo — not the runbook, not the seed data, not the ingestion tooling — states an expected point count for `knowledge_chunks`. The 10Gi/50Gi/200Gi PVC sizes in §2.3 are a generic sizing-formula placeholder, not a real estimate. | Needs input from whoever owns `docs/operations/retrieval-corpus-ingestion/` |
| **⚠ 2** | **Quantization.** Recommend scalar (int8) + `always_ram: true` (Wave 3.1) — a real design choice with an accuracy tradeoff against the citation-faithfulness eval gate the runbook requires, not something the code already assumes. | Affects retrieval quality; must be approved before Wave 3.1's proposal is applied |
| **⚠ 3** | **In-cluster TLS posture.** The query vector sent to Qdrant is entity/transcript-derived and can contain PHI, even though the stored corpus itself is not PHI. No other `hope-*` service encrypts pod-to-pod traffic today — doing it only for Qdrant would be a new, isolated precedent. | Platform-wide PHI-posture decision, not Qdrant-specific |
| **⚠ 4** | **Snapshot cadence / RPO for `knowledge_chunks`.** The design flags the need for a scheduled snapshot `CronJob` against MinIO but does not set a schedule — `knowledge_chunks` is re-derivable from source documents + the embedding pipeline, so its RPO tolerance may be much looser than the Postgres primary. | Needs input from whoever owns data-retention policy for the institutional corpus |
| **⚠ 5** | **Metrics routing.** Scrape `/metrics` directly with the existing `prometheus.yaml`, or route through the existing OTel collector like other `hope-*` services? A house-style consistency question the design explicitly declines to decide. | Cross-cuts TASK-636's scope; TASK-636 (OBS-28) is waiting on this ticket's deployment, not the other way around |
| **⚠ 6** | **Distributed-cluster trigger condition.** A point-count threshold, a query-latency SLO breach, or "before this becomes customer-facing GA"? Not determined anywhere in the code or docs today. | Product/SLO decision, not an infrastructure one |
| **⚙ 7** | Applying Wave 2 manifests to the cluster | Blocked on [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) Part A — Argo cannot deliver anything today |

---

## 5. Sequencing constraints

0. **Blocked on TASK-617 Part A.** This ticket's manifests are additive and low-risk in
   isolation, but they still funnel through the same Argo Application that has been panicking
   on every sync for 7 days (LIVE-02). Nothing in Wave 4 is meaningful until that is fixed.
1. **Wave 1 (auth code) should land before anyone assumes the manifest alone makes auth real.**
   The manifest's optional `QDRANT__SERVICE__API_KEY` secretKeyRef is a no-op from the harness
   client's side until Q-03/Q-04 are closed — ship the code first so this gap is explicit rather
   than silently relied upon.
2. **1.3 (drop `stt_speaker_embeddings`) before 2.4 (author the init Job).** The Job runs
   whatever the script declares — landing the cleanup first means the Job is never authored
   against a script that still provisions a dead collection.
3. **2.4's hook is `Sync`, not `PreSync`, and must run after the StatefulSet is `Ready`** — this
   is the opposite ordering from `db-migrate.yaml`'s `PreSync` hook; get it backwards and
   `create_collection` runs against a Qdrant that doesn't exist yet.
4. **Do not wire `HARNESS_RETRIEVAL_QDRANT_API_KEY` into `harness.yaml` or flip
   `HARNESS_RETRIEVAL_ENABLED` as part of this ticket.** Both are the eval-gated runbook's
   decision, deliberately kept separate from "Qdrant infrastructure exists."
5. **Do not add `QDRANT_API_KEY` to `platform-secrets.descriptors.ts`.** Q-09 documents this as
   already correct — the key stays a `hope-secrets` k8s Secret consumed only by the init Job and
   the StatefulSet, never an application-registry entry.
6. **⚠1 (corpus estimate) should be answered before 2.3's PVC sizes are treated as final** —
   `volumeClaimTemplates` are immutable after StatefulSet creation; a wrong initial size means a
   later snapshot-restore-into-larger-PVC migration, not a simple patch.

---

## 6. Acceptance criteria

- [ ] A new harness test proves `RetrievalConfig` accepts `qdrant_api_key`, and was RED before
      the field existed
- [ ] A new harness test proves `KnowledgeQdrantStore` passes a provided `api_key` into
      `QdrantClient(...)`, and was RED before the constructor change
- [ ] `pnpm py:harness:test` green including both new tests
- [ ] `stt_speaker_embeddings` no longer appears in `init-qdrant-collections.py`;
      `docs/architecture/overview.md:303` no longer describes STT writing to Qdrant
- [ ] `kubectl kustomize` (or the deployment repo's CI render) of all three overlays includes
      `hope-qdrant` StatefulSet + Service + `hope-qdrant-init` Job with no errors
- [ ] The deployment repo's five CI jobs (`render`, `schemas`, `config-refs`, `image-hygiene`,
      `secrets`) pass against the new manifests
- [ ] `turbo.json#globalEnv` contains the four new `HARNESS_RETRIEVAL_QDRANT_*` keys
- [ ] Live: `hope-qdrant` pod `Running`; `/readyz` and `/livez` return 200
- [ ] Live: `hope-qdrant-init` Job completes; `knowledge_chunks` exists with dense(1024,
      COSINE) + sparse(`bm25`, IDF) shape; `stt_speaker_embeddings` is **not** created
- [ ] `HARNESS_RETRIEVAL_ENABLED` remains `False` in every environment after this ticket
      (verifies the scope boundary in §1 held)

---

## 7. Implementation Summary

*Not started — awaiting owner approval of this plan.*

---

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Ticket created from TASK-616 Phase 7b / the Qdrant component design. Splits the design's findings into a code-first auth track (Q-03/Q-04, closed via TDD) and a manifest track (Q-01/Q-02/Q-07/Q-08), plus a small provisioning-hygiene cleanup (Q-06/Q-10). Six owner decisions (⚠1–⚠6) carried forward verbatim from the design's open questions §f. Status `Pending` pending owner approval. | Claude |
