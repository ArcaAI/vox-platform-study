# TASK-616 Appendix C — Component Designs

**Date**: 2026-08-07 · **Status**: Draft for owner decision — nothing has been applied to any cluster or repo.

Covers the four components the owner called out (Q3 Vault, Q4 harness worker, Q5 Qdrant, Q6 Rancher). Qdrant has its own file: [`component-design-qdrant.md`](./component-design-qdrant.md).

Read alongside [README §2](./README.md) (defect register), [Appendix A](./sota-research-2026.md) (2026 SOTA), [Appendix B](./live-state-2026-08.md) (live cluster state).

---

## C1. Vault (Q3)

### C1.0 The finding that reframes this work

`infrastructure/single-deployment/vault/` is a **fully built, `kind`-tested, never-deployed** target architecture — Transit auto-unseal, per-service Kubernetes-auth roles, complete HCL policies per service, chaos drills, monitoring rules, an operator runbook written as if it were live. **None of it is running.** The Vault that *is* running (`hope-v2-deployment/deployment/k8s/base/vault.yaml`) is a far more primitive system that predates and ignores that design.

Separately, `deployment/vault-agent/` in the monorepo declares the authoritative Agent-injection contract — also never deployed.

So this is not a design problem. It is a **deployment and bootstrap problem against work that already exists**, which materially lowers the cost.

### C1.1 Decision summary

| # | Decision | Recommendation | Confidence |
|---|---|---|---|
| 1 | Topology | **VM 430-432, 3-node Raft** (owner's stated choice) — honored, with one amendment below | High |
| 2 | Unseal | **Transit auto-unseal** via a 4th dedicated seal-Vault — **not** the runbook's manual Shamir | High (amendment) |
| 3 | Seal-Vault placement | **Dedicated VM 434**, not in k3s | Medium — see C1.4 |
| 4 | Version | **1.21.2**, not the runbook's 1.18 — matches the already-validated k3s design | Medium (deliberate deviation) |
| 5 | Auth — gateway | **AppRole**, response-wrapped `secret_id`, delivered as **files** | High |
| 6 | Auth — 6 Python services | **Kubernetes auth** against the external Vault | High |
| 7 | Delivery — gateway | **No sidecar** — `SecretsService` is already a full Vault client | High |
| 8 | Delivery — Python services | **Vault Agent Injector, sidecar mode** | High |
| 9 | Operator access | Cloudflare Tunnel + Vault **OIDC to Entra ID** (a *separate* App Registration from GitLab's) | High |

### C1.2 Gap table

| Concern | Deployed today | VM runbook | k3s Helm design (built, unused) | 2026 best practice |
|---|---|---|---|---|
| Storage | `storage "file"`, single dir (`vault.yaml:29-31`) | Raft, 3-node (`:123-138`) | Raft, 3-node (`values.yaml:147-158`) | Raft; Consul is legacy |
| HA | `replicas: 1`, `HA Enabled: false` | 3 nodes via `retry_join` | 3 nodes + PDB `maxUnavailable: 1` | ≥3 odd voters, autopilot cleanup |
| Unseal | Init Job generates 5/3 shares **and unseals with them in the same script** (`vault.yaml:147-158`) | Manual Shamir 5-of-3 — 3 humans per restart (`:150-174`) | Transit auto-unseal via seal-Vault | Auto-unseal in prod; Shamir only for the seal root |
| TLS | `tls_disable = true` (`vault.yaml:27`) | TLS + HAProxy — **cert issuance is an unfilled `<SRE:>` placeholder** (`:146,213`) | `tlsDisable: true`, assumes a mesh that isn't deployed | TLS everywhere |
| Auth | AppRole only, **raw** `secret_id` as plain env from a plaintext Secret (`api.yaml:47-56`); other 6 services never touch Vault | AppRole, wrapped `secret_id` (`:297-320`) | AppRole (gateway) + Kubernetes auth (6 services), per-service policies | K8s auth for in-cluster; AppRole for non-k8s |
| Audit | **Not enabled at all** | File audit + logrotate, 90d (`:217-249`) | File audit + PVC + shipper to Loki | Mandatory for PHI — **Vault blocks all requests if its only audit device can't write** |
| Backup | **None** | Raft snapshot 4h → MinIO, 14d (`:253-293`) | Snapshot CronJob + documented restore | Automated snapshots + a *tested* restore |
| Policies | None — init Job writes none | Deferred to SRE (`:392`, unwritten) | Full per-service HCL at `infrastructure/docker/configs/vault/policies/k8s/hope-*.hcl` | Least privilege, one policy per identity |
| Root token | **Plaintext in Secret `hope-vault-init`, never revoked** | "rotate it" — no revocation step | Explicit revocation + Secret deletion, asserted by `test/kind-e2e.sh` | Root should not exist as a standing credential |

### C1.3 Honest evaluation of the VM topology

**For** — matches the estate's existing VM pattern (Postgres HA, Redis are VM-based); decouples Vault from the k3s cluster, which matters because that cluster is a **single node on stock defaults with no secrets encryption** ([Appendix B](./live-state-2026-08.md)); cleaner compliance story for a minimal hardened tier.

**Against** — the VM runbook is materially less mature than the k3s design it would replace: no auto-unseal, no per-service auth/policy, no e2e test, seven `<SRE:>` placeholders, and sections 3, 4, 8, 10, 11, 14, 17 marked "deferred to SRE" (i.e. **unwritten**). The k3s design's own README states the AWS path — "reuse this same chart with a per-cloud overlay… the only thing that changes per platform is auto-unseal and role_id delivery" — and no equivalent plan exists for the VM path.

**Resolution — a hybrid.** Build the VM Raft topology as asked, but reuse the k3s design's **auth / policy / injector layer unchanged**. That layer is topology-agnostic: Vault's Kubernetes auth method validates pod ServiceAccount tokens via the cluster's TokenReview API and **does not require Vault to run inside that cluster**. This turns "VM Vault + k3s workloads" from a gap into a non-issue, and it is also precisely the layer that ports to AWS untouched.

### C1.4 Unseal — why the runbook's Shamir is wrong here

Manual Shamir 5-of-3 on three production Raft nodes means every restart — patch, OOM, reboot — blocks on **three humans being simultaneously available**. That directly contradicts the owner's requirement that operators can manage Vault themselves: one on-call engineer cannot unseal alone.

Transit auto-unseal fixes it: the 3 Raft nodes decrypt their root key against a dedicated seal-Vault on every boot, no human interaction. Only the seal-Vault is Shamir-sealed, and it restarts rarely (no application traffic, no upgrade pressure).

```hcl
# vault-{1,2,3} vault.hcl — replaces the runbook's plain Shamir config
seal "transit" {
  address         = "https://10.10.1.134:8200"   # VM 434, seal-Vault
  token           = "<token scoped to encrypt/decrypt on the 'autounseal' key ONLY>"
  disable_renewal = "false"
  key_name        = "autounseal"
  mount_path      = "transit/"
}
```

**Where the seal-Vault lives — the one genuinely open decision.** Option B (reuse the existing, `kind`-tested `seal-vault/` manifests in the k3s cluster) is zero new engineering. But [Appendix B](./live-state-2026-08.md) settles the risk question against it: **the k3s datastore is SQLite, not embedded etcd** (no `--cluster-init` in argv, no `node-role.kubernetes.io/etcd` label), so there is no built-in etcd-snapshot backstop, and the node has no demonstrated PVC backup. Losing that disk would leave every Raft node permanently sealed. **Recommend Option A: dedicated VM 434.**

### C1.5 Auth model

The stated problem — "the AppRole `secret_id` sits in a plaintext Secret; that must die" — is solved by Kubernetes auth for the services that can use it:

| | AppRole (today, all 7) | Kubernetes auth (recommended, 6 of 7) |
|---|---|---|
| Credential at rest | Static `secret_id` — today **plaintext in `hope-secrets`** | The pod's **projected ServiceAccount token** — k8s mints and rotates it natively |
| What `kubectl get secret` yields | A reusable Vault credential | Nothing — no Vault credential is stored in the cluster |
| Rotation | Manual (`rotate-secret-id.sh`) | Automatic (kubelet-managed) |

**`hope-api` is the one deliberate exception.** `VaultSecretsProvider` implements **only** AppRole login — there is no Kubernetes-auth code path in the TS client. Changing that is new engineering; AppRole with a wrapped, single-use `secret_id` delivered as a file closes the plaintext-Secret gap without touching app code. Justified by existing code, not convenience.

**The 6 Python services are proven Vault-unaware** — no `hvac`, no `VAULT_ADDR` read anywhere. They only read files from `HOPE_SECRETS_DIR` via `hope_env`'s pydantic-settings source. The Agent Injector performs the login *for* them: **zero Python changes needed.**

```bash
vault auth enable kubernetes
vault write auth/kubernetes/config \
  kubernetes_host="https://10.10.1.10:6443" \
  kubernetes_ca_cert=@k3s-ca.pem \
  token_reviewer_jwt=@vault-reviewer-sa-token   # long-lived SA with system:auth-delegator —
                                                # required because Vault is NOT in-cluster and
                                                # cannot use its own pod identity for TokenReview

for svc in api smr guardrail nlp harness tts stt; do
  vault policy write "hope-$svc" "infrastructure/docker/configs/vault/policies/k8s/hope-$svc.hcl"
  vault write "auth/kubernetes/role/hope-$svc" \
    bound_service_account_names="hope-$svc" \
    bound_service_account_namespaces=hope-v2-dev \
    policies="hope-$svc" ttl=1h
done
```

### C1.6 Secret delivery — per service, not one-size-fits-all

**`hope-api`: no sidecar.** `SecretsService` is a stateful Vault client — LRU cache with per-secret TTL, Redis pub/sub eviction (`arca:secrets:invalidate`), background re-warm, Transit encrypt/decrypt for PHI and GlobalSetting, dynamic Postgres credential issuance/renewal. None of that is replaceable by file injection. It needs only the two AppRole bootstrap values delivered as files (`secrets.module.ts` already supports `*_FILE` paths).

**The 6 Python services: Agent Injector, sidecar mode.**

| Mechanism | Materializes a k8s Secret? | Go templating? | Verdict |
|---|---|---|---|
| External Secrets Operator | **Yes** — its whole design | No | **Rejected for PHI** — already the repo's documented rationale (`deployment/vault-agent/README.md:12-27`) |
| Vault Secrets Operator | **Yes**, by default | Limited | Same objection |
| Secrets Store CSI | No | Weak | Viable but inferior — HOPE depends on exact trim-newline templates (`{{- with secret ... -}}`); a trailing `\n` breaks every `hmac.compare_digest` |
| **Agent Injector, sidecar** | No — memory-backed `emptyDir` | Yes, already authored | **Already fully designed** in `deployment/vault-agent/reference-deployment.yaml` |

Never `agent-pre-populate-only: "true"` — it renders once and exits, so rotation never reaches a running pod.

### C1.7 AWS portability

| Layer | Portable as-is | AWS change |
|---|---|---|
| Raft topology, kv-v2 layout, Transit key separation, DB secrets engine, AppRole pattern, K8s-auth roles/policies, Agent Injector manifests, HCL policies, GitLab CI OIDC | ✅ | — |
| **Unseal** | ❌ | `seal "transit"` → `seal "awskms"`. Needs IRSA (in EKS) or an instance profile (EC2) with `kms:Encrypt/Decrypt/DescribeKey` on one CMK. **No Shamir-holding seal-Vault needed at all** — AWS *simplifies* this topology |
| **Raft storage** | ❌ | Local disk → **EBS gp3**, one volume per node. **Never EFS** — Raft needs low-latency local `fsync`; a network filesystem is the wrong choice for any Raft-backed store |
| TLS material | ❌ | Internal CA → ACM behind an NLB, or cert-manager |
| Ingress | Conditional | Cloudflare Tunnel runs identically as an EKS Deployment. If an ALB is used instead, health checks must handle `/v1/sys/health?standbyok=true` — the logic already exists in the HAProxy config and ports across |

**Net: the auth/policy/injector layer is what to build carefully now** — it survives the AWS move unchanged. Only the seal backend and storage class should be written as explicit overlays (`vm/`, `aws/`) from day one.

### C1.8 Migration — no Raft snapshot is possible

**The current Vault uses `storage "file"`, so `vault operator raft snapshot` does not work.** Migration must be a scripted read/write of every key.

1. Inventory: `vault kv list -recurse secret/` — don't trust the descriptor list alone (`vault-kv-coverage.test.ts` exists because drift has happened).
2. Export every key's `value` field, root token, one-time use, never printed.
3. Stand the new Vault up completely **first**; prefer regenerating fresh values over replaying the export.
4. Cutover: roll `hope-api` + the 6 services with new `VAULT_ADDR` and auth wiring. Acceptable maintenance window — this is `hope-v2-dev`, not live-traffic prod.
5. Validate: a GlobalSetting read/write exercises kv + Transit in one shot; a login exercises `JWT_SECRET_KEY`.
6. **Rotate everything that was ever in the plaintext Secrets.** The root token, every `secret_id`, every kv value sat unencrypted in the datastore for the cluster's lifetime. This is the actual security boundary of the migration, not optional cleanup.
7. Decommission the old StatefulSet, PVC, and both plaintext Secrets — grep the **applied** manifests, not just the repo, given known drift.
8. Rollback: keep the old Vault running untouched until step 5 passes.

### C1.9 Blocking decisions

1. Seal-Vault placement — VM 434 (recommended) vs. in-cluster.
2. TLS/CA — the runbook punts cert issuance to `<SRE:>`. Does an internal CA already exist for VM-to-VM TLS (e.g. for Postgres HA)? Confirm before inventing a new hierarchy.
3. Vault 1.21.2 vs. the runbook's 1.18 — needs owner sign-off as a deliberate deviation.
4. Runbook sections 3, 4, 8, 10, 11, 14, 17 are **unwritten** and must be authored before a build can start.
5. A **second** Entra ID App Registration for Vault OIDC (do not reuse GitLab's — different audience, and a Vault compromise must not reach GitLab's OIDC client secret). Needs Entra admin action outside this repo.

---

## C2. Harness Temporal worker (Q4)

### C2.1 What it is

- **Task queue** `harness-task-queue`; workflows `HarnessPingWorkflow` + `HarnessDocWorkflow`; **17 activities** (`activities.py:2051-2068`).
- Tuning actually used: only `max_concurrent_activities` (default 8) and `graceful_shutdown_timeout` (30s). Workflow-task concurrency and sticky cache are left at SDK defaults.
- Dependencies: `apps/api`, `apps/nlp`, `apps/smr` over HTTP; **Qdrant** (`retrieve_context`); LM Studio for embeddings + safety; the HF TEI reranker; MinIO/S3 for claim-check payloads ≥64 KiB; MCP tool servers (opt-in). **No direct Postgres or Redis.** GPU is optional and off by default.
- A resident MiniCheck GGUF entailer is loaded **in-process by an activity** — which is why the worker (not the API) runs a model-cache sweeper every 60s.

### C2.2 The load-bearing detail

`_assert_claim_check_store_is_deployable` (`worker.py:122-155`) **refuses to boot** when `HARNESS_ENVIRONMENT` is `production|prod|staging` and `HARNESS_CLAIM_CHECK_STORE=memory`. The k3s harness deployment already sets `HARNESS_ENVIRONMENT: production`.

This is also the precondition for >1 replica: the in-memory store is a per-process singleton, so cross-worker activity retries against it raise `ClaimCheckNotFound`.

**Verified live**: `HARNESS_CLAIM_CHECK_STORE = s3` is already set in the running ConfigMap, so the guard would pass today.

### C2.3 The two-Temporal-servers problem

Two servers run simultaneously: `temporal-server`/`temporal-ui` as **Docker containers on the k3s host VM**, and `hope-temporal`/`hope-temporal-ui` as **k8s Deployments**. The live ConfigMap points apps at the VM one (`TEMPORAL_ADDRESS = 10.10.1.10:7233`).

**Recommendation: the in-cluster `hope-temporal` survives; the VM Docker pair is retired from anything cluster-facing.** It is declarative, versioned, Argo-managed, and has a portability story to EKS; the Docker containers have none. **Because the worker has never run, no workflow has ever been picked off either queue — this is a clean-slate decision with no in-flight-history migration risk.** Cutting over now costs nothing; cutting over later does.

⚠️ Note the ConfigMap drift: **7 keys exist only in the live cluster** (live 55 vs rendered-overlay 48) — `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `HARNESS_CLAIM_CHECK_ENABLED`, `HARNESS_CLAIM_CHECK_STORE`, `HARNESS_API_BASE_URL`, `SMR_GATEWAY_URL`. Every one is harness-related, and the three `TEMPORAL_*` are referenced **non-optionally**. Getting them into Git is a prerequisite for this change *and* for ever enabling Argo `selfHeal`.

### C2.4 Health checks — a worker has no HTTP server

The Python Temporal SDK ships no health surface for a worker process. Recommended MVP: a **heartbeat file** touched every 15s by a background task (mirroring the existing `_sweep_model_caches_forever` pattern), with exec probes:

```yaml
livenessProbe:
  exec:
    command: ["/bin/sh", "-c", "find /tmp/harness-worker-heartbeat -mmin -1 2>/dev/null | grep -q ."]
```

Honest limitation: this conflates "process alive" with "connected to Temporal" — a network partition to `hope-temporal` wouldn't fail it. An embedded HTTP server calling `client.service_client.check_health()` is the better follow-up.

**Do not copy `stt-v2-worker.yaml`, which has no probes at all** — that is defect D-13, and it means a wedged STT worker currently runs forever with no self-healing.

### C2.5 Shutdown, scaling, versioning

**Shutdown**: `graceful_shutdown_timeout_s` (30s) bounds only how long *in-flight* activities get before cancellation — it does not wait for the 900s inferential ceiling. That's correct by design: `_INFERENTIAL_RETRY` allows 2 attempts and every failure path degrades to `reduced_assurance` rather than crashing. Set `terminationGracePeriodSeconds: 90` — enough for cancellation-ack plus exit, not the full activity ceiling.

**Scaling**: defer KEDA. Going past one replica needs no code change (the S3 claim-check store is already required regardless). The real blocker first is that **no Temporal SDK metrics are exposed at all** — `Settings.metrics_enabled` only wires the *FastAPI* instrumentator, not the worker. Wire a `temporalio.runtime.Runtime` with `PrometheusConfig` before any backlog-based autoscaling decision is meaningful.

**Versioning**: this codebase already solved forward-compatible deploys the in-workflow way — `workflow.patched()` markers gate every behavior change, backed by `test_replay_compat.py` replaying frozen histories. Keep that as the primary discipline; Temporal Worker Versioning / Build IDs is heavier than a single-replica, single-queue deployment warrants.

**Therefore CI must run `test_replay_compat.py` before building the worker image** — non-optional, unlike `build-harness`'s current `needs`. `HarnessDocWorkflow` parks at a durable `wait_condition` for a clinician approval signal with a 24h SLA; a non-deterministic change wedges every parked execution, not just new ones.

### C2.6 Artifacts to produce

- `apps/harness/Dockerfile`: add a `FROM production AS worker` stage with `ENTRYPOINT ["python", "-m", "harness.temporal.worker"]`. (The existing header comment claiming `docker run harness python -m harness.temporal.worker` works is **wrong** — exec-form ENTRYPOINT appends those args to uvicorn rather than replacing it. It was never exercised.)
- `.gitlab/ci/build.yml`: a `build-harness-worker` job mirroring `build-stt-worker`, with a **non-optional** `needs: test-harness`.
- `deployment/k8s/base/harness-worker.yaml`: a Deployment with the probes above, `terminationGracePeriodSeconds: 90`, explicit `HARNESS_CLAIM_CHECK_STORE=s3` + MinIO creds, requests `1 CPU / 2Gi`, limits `4 CPU / 6Gi` (sized for the always-on in-process PHI redaction model plus the 8-way activity cap, not for the mostly-network-bound activities).
- `configmap.yaml`: add the `TEMPORAL_*` keys currently living only in the live cluster.

---

## C3. Rancher (Q6)

### C3.1 The headline

**SUSE's own guidance names Argo CD among software "known to interfere with Rancher performance" and states it is "not supported on the upstream cluster,"** recommending Rancher run on a dedicated cluster free of other workloads.

[Appendix B](./live-state-2026-08.md) confirms Argo CD runs in namespace `argocd` on the **same** single-node k3s that runs Rancher (VM 400). This is that exact anti-pattern, independent of everything else below.

### C3.2 Decisions

| Question | Recommendation |
|---|---|
| Fleet vs Argo | Keep the Fleet agent (it cannot be removed without uninstalling Rancher — `rancher#31044`, marked `wontfix`), but create **zero** GitRepos/Bundles targeting either downstream cluster. Argo owns all app namespaces. Don't chase removal; scope Fleet to a zero footprint |
| Argo via the Rancher proxy | **Anti-pattern at this scale.** Re-register against the downstream API directly with a standard `argocd-manager` ServiceAccount. Verified feasible: VM 400 reaches `https://10.10.1.10:6443` (HTTP 401 = reachable) |
| Rancher HA | `replicas=1` risks the **management plane only** — downstream workloads keep running. SUSE wants 3-node RKE2, dedicated. **Fix this before adding staging/prod clusters**, not after — expanding blast radius while it's a SPOF is the wrong order |
| Version matrix | Rancher v2.12–v2.14 certify Kubernetes v1.33–v1.35; the downstream k3s v1.34.5 is in range. Trap: v2.12 dropped 1.30 — always check the matrix *before* a Rancher upgrade |
| Backup | `rancher-backup` covers **only** the management cluster's own CRs. Downstream workloads need Velero or equivalent — a gap nothing currently fills |
| Upgrade order | Backup → verify matrix covers every downstream version → Rancher first → downstream clusters, one minor at a time, servers before agents |
| Projects vs namespaces | Don't fake environment isolation with Projects inside one cluster. For PHI, isolate at the **cluster** boundary; use Projects within a cluster to separate PHI namespaces from tooling |
| SSO | Rancher supports Entra ID natively — reuse the tenant already wired into GitLab, map groups → Rancher roles via the OIDC `Roles` claim |
| Audit log | **Level 1–2, not 3.** Level 3 logs response bodies, which risks capturing PHI. Ship the sidecar's stream to the existing OTel stack rather than deploying `rancher-logging` for it |
| `rancher-monitoring` / `rancher-logging` | **Do not install on the downstream cluster** — a second `kube-prometheus-stack` fights over the same cluster-scoped CRDs, and a second Fluent Bit DaemonSet doubles log I/O. Accept that Rancher's built-in per-cluster graphs will be empty; that's a deliberate trade, not a surprise |
| Promtail EOL | **Not a Rancher issue** — `rancher-logging` was never Promtail-based (Fluent Bit + Fluentd). Only relevant to HOPE's own Loki stack |
| Rancher on EKS | Value drops sharply. Provision with Terraform, **import** (never "hosted" — deleting a hosted cluster from the UI destroys the real EKS cluster), use Rancher for unified RBAC/audit only, register Argo directly, skip Fleet and rancher-monitoring/logging |

### C3.3 Responsibility split

| Concern | Owner |
|---|---|
| Cluster inventory / registration, SSO, cross-cluster RBAC & audit | **Rancher** |
| Cluster provisioning (RKE2/EKS) | **Terraform** — not Rancher's EKS driver, not Fleet |
| Bootstrap primitives (CNI, cert-manager, GPU operator) | **Decide once, explicitly** — Rancher Apps **or** Argo, never both |
| Application workloads | **Argo CD**, via the direct API |
| Cluster observability | **The self-managed OTel/Prometheus/Loki/Tempo stack** |
| Rancher management-plane backup | `rancher-backup` |
| Downstream workload backup | **Velero or equivalent** — currently nothing |

⚠️ Before adopting Argo for `gpu-operator`: check `helm list -A` for a `catalog.cattle.io/*` label. If it was installed via Rancher's Apps & Marketplace it is Rancher-owned, and dual-ownership needs a deliberate migration (delete the Rancher release, re-adopt under Argo) — not an `Application` pointed at a live release.

---

## C4. Qdrant (Q5) — summary

Full design: [`component-design-qdrant.md`](./component-design-qdrant.md).

Five findings that shape it:

1. **Only one collection matters** — `knowledge_chunks` (harness institutional RAG). `stt_speaker_embeddings` is dead (STT moved to Postgres `pgvector`); `context_items` was never provisioned. Do not carry either into production.
2. **Multi-tenancy is single-collection + payload filter**, not per-tenant collections. The entire isolation boundary is one function, `_tenant_approved_filter` (`qdrant_store.py:132-141`), applied to **both** the dense and sparse RRF prefetch branches. Qdrant has no server-side backstop — any new read path must be reviewed for it.
3. **Nothing authenticates to Qdrant anywhere today.** `KnowledgeQdrantStore.__init__` doesn't even accept an `api_key`. **Shipping auth to production requires a harness code change, not just a manifest.**
4. **The retrieval feature is off in every environment** (`HARNESS_RETRIEVAL_ENABLED` defaults false; `harness.yaml` carries zero `HARNESS_RETRIEVAL_*` vars) and is explicitly degrade-safe on Qdrant outage. That lowers the HA bar: a Qdrant outage is a **quality regression, not a platform incident**.
5. Vectors: named dense `"dense"` (1024-dim, COSINE, `BAAI/bge-m3` via self-hosted LM Studio) + named sparse `"bm25"` (fastembed, in-process). **No HNSW / quantization / on-disk config exists in the code** — every such choice is a genuinely new production decision, and `embeddings_dim` must match the collection, so changing the embedding model requires coordinated recreation.

Deliverables in that file: a complete `qdrant.yaml` StatefulSet + Service, kustomization registration, per-overlay patches, the missing `qdrant-init` provisioning Job, TS/Python env wiring, security/backup/observability, a k3s-vs-EKS table, and nine open questions the code does not answer (corpus size, quantization, TLS).
