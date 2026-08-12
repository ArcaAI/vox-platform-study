# TASK-618 — PHI Security Baseline (k3s Hardening, Pod Security Admission, NetworkPolicy, Vault Cutover)

**Status**: Closed
**Classification**: infrastructure
**Created**: 2026-08-08
**Parent**: [TASK-616 Phase 2](../TASK-616-Deployment-CICD-Observability-Modernization/README.md#phase-2--phi-security-baseline--m) · [Program index](../TASK-616-Deployment-CICD-Observability-Modernization/phase-program-index.md)
**Scope**: k3s server config on VM 200 · every workload in `arca/hope-v2-deployment` `base/` · Kyverno + NetworkPolicy · the Vault-HA cutover (TASK-616 Track V phase 2) · GitLab branch protection
**Conventions**: [Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md)
**Evidence base**: [Live-state recheck 2026-08-08](../TASK-616-Deployment-CICD-Observability-Modernization/live-state-recheck-2026-08-08.md) · [Appendix B](../TASK-616-Deployment-CICD-Observability-Modernization/live-state-2026-08.md) · [Appendix H — Vault HA](../TASK-616-Deployment-CICD-Observability-Modernization/vault-ha-deployment-2026-08.md) · [SOTA §A5, §A8](../TASK-616-Deployment-CICD-Observability-Modernization/sota-research-2026.md)

---

## 1. Requirement Analysis

TASK-616 called this *"the highest compliance-per-effort work in the ticket."* That framing holds.
The restated requirement, for a platform processing clinical audio and notes:

| Part | Restated requirement |
|---|---|
| **A — Substrate** | The k3s cluster stops running on stock defaults: secrets encrypted at rest, an audit log, kubelet hardening, resources reserved for the system |
| **B — Workload isolation** | Every pod runs unprivileged under Pod Security Admission `restricted`; every namespace is default-deny at the network layer with explicit, derived allow rules |
| **C — Secrets** | Application credentials stop living as base64 in etcd. The Vault HA cluster that already exists gets wired to the workloads that need it |
| **D — Boundary** | The Vault CI deploy role's `ref` scoping stops being decorative |

**Classification**: `infrastructure`.

### This ticket absorbs the never-created TASK-623

TASK-616 §4 proposed TASK-623 for "Phase 7a — Vault HA + auth migration". **The VM half was
executed inside the parent** (Track V phase 1: 3-node Raft + Transit auto-unseal on VMs 430-432/434,
verified against a hard power cycle — Appendix H). What remains is *"Track V phase 2 (k8s auth,
policies, injector, secret migration, snapshots) is unblocked and unstarted."*

That remainder has no meaning independent of this ticket's D-01/D-02/D-03 gates — it *is* how they
close. Splitting it into a separate ticket would duplicate every acceptance criterion. It lives here
as §3 Wave D.

### Explicitly out of scope

| Excluded | Owned by |
|---|---|
| Getting Argo to sync at all; manifest correctness; GPU; dead pods | [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) — **hard prerequisite** |
| Argo `AppProject`/`Application` architecture, digest promotion, the credential leak | [TASK-619](../TASK-619-GitOps-CICD-Delivery-Loop/README.md) |
| Kyverno *image-signature* admission policy (needs cosign to exist first) | [TASK-621](../TASK-621-Supply-Chain-Integrity/README.md) — this ticket installs Kyverno; 621 adds `verifyImages` |
| Branch-model design | [TASK-629](../TASK-629-Branch-Model-Vault-Boundary-And-Release-Gates/README.md) — this ticket consumes it |
| Audit-log *shipping* and alerting on it | [TASK-636](../TASK-636-Observability-Coverage-And-Dependency-Monitoring/README.md) — this ticket produces the log; 636 makes it queryable |

---

## 2. Current State Evaluation

### 2.1 Substrate — verified stock

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **Q2** | High | ❌ **Confirmed stock** | k3s runs on **complete stock defaults**: no `secrets-encryption`, no `protect-kernel-defaults`, no apiserver audit logging, no kubelet hardening flags, no PSA config file. The datastore is **SQLite**, not embedded etcd | TASK-616 Change History 2026-08-07 |
| **LIVE-05** | Medium | ❌ **Live** | Node `dell` reports `allocated == capacity` — cpu 16/16, memory 49309144Ki. **No `system-reserved`, no `kube-reserved`.** A runaway pod can starve kubelet itself, which is precisely how the 2026-08-06 DiskPressure incident escalated | Rancher node analysis, 2026-08-08 |
| — | Medium | ❌ **Live** | **Rancher/Fleet is also actively reconciling this cluster** (`cattle-fleet-system` fleet-agent Running) alongside Argo CD. A second controller writing to the same namespace can silently revert any hardening this ticket delivers via GitOps | Appendix B §B1 Q6 |

### 2.2 Workload isolation — verified absent

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **LIVE-12** | High | ❌ **Zero** | Namespace `hope-v2-dev` carries **no Pod Security Admission labels at all** — only `kubernetes.io/metadata.name`. No `enforce`, no `warn`, no `audit` | `kubernetes_get namespace hope-v2-dev`, 2026-08-08 |
| **LIVE-11** | High | ❌ **Zero** | **No NetworkPolicy exists in `hope-v2-dev`.** The only one in the entire cluster is Fleet's own `default-allow-all` in `cattle-fleet-system`. East-west traffic is completely unrestricted | `kubernetes_list networkpolicy` (all namespaces), 2026-08-08 |
| **D-07** | High | ❌ **Live** | Zero `securityContext` anywhere in the manifests **except two `runAsUser: 0`** (root) entries. No `runAsNonRoot`, no `readOnlyRootFilesystem`, no dropped capabilities, no seccomp profile | `stt-v2.yaml:33-35`, `stt-v2-worker.yaml:33-35` are the only hits |
| **D-08** | High | ❌ **Live** | Consequence of LIVE-11: any compromised pod — e.g. a Python service with a dependency issue — can reach every other service, including Vault and Postgres | manifest grep + live confirmation |

### 2.3 Secrets — the pattern this repo already rejected once

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **D-01** | **Critical** | ❌ **Live** | Every secret — DB URLs, `JWT_SECRET_KEY`, provider API keys, MinIO credentials — is delivered as a plaintext k8s `Secret` via `envFrom`/`secretKeyRef`. Base64 in etcd, readable by anyone with namespace read, and **present in every etcd backup**. This reproduces exactly the pattern the monorepo deleted its own k3s tree over on 2026-07-24 | `base/api.yaml:40-41,50-56,80-94`; confirmed live, Appendix B §B6 |
| **D-02** | **Critical** | ❌ **Live** | The in-cluster Vault is a **single-replica dev instance**: `tls_disable=true`, `storage "file"`, `disable_mlock`. Its init Job writes the root token **and all five unseal keys** in plaintext into a k8s Secret. *The key to the vault is stored next to the vault.* | `base/vault.yaml:21-32,144-158`; live: `Storage: file, HA Enabled: false, Shamir 5/3, v1.18.3` |
| **D-03** | **Critical** | ❌ **Live** | Vault AppRole bootstrap credentials (`VAULT_ROLE_ID`/`VAULT_SECRET_ID`) ride the same plaintext Secret | `base/api.yaml:43-56` |
| **D-01b** | **Critical** | ❌ **Live — found 2026-08-08** | **`Secret/hope-secrets` carries every credential a second time, in plaintext, inside its `kubectl.kubernetes.io/last-applied-configuration` annotation.** The `data` block is at least base64 and is what tooling masks; the annotation is a plain JSON string embedding the original `stringData`, so it is returned in full by any `kubectl get secret -o yaml` and by API clients that mask `data` — the masking is defeated. **31 keys are exposed**, including the Postgres superuser password (twice — standalone and inside `DATABASE_URL`), `JWT_SECRET_KEY`, `API_GATEWAY_KEY`, Azure OpenAI and Azure Speech keys, a HuggingFace token, the MinIO secret key, the Redis password, a Sarvam API key, and **`VAULT_ROLE_ID` + `VAULT_SECRET_ID` + `VAULT_TOKEN`** — i.e. the credentials that unlock the secrets manager are themselves in the plaintext Secret. It persists into every etcd backup. Created 2026-03-20 by `kubectl apply`, so it has been present for ~4.5 months | Live read of `Secret/hope-secrets`, `metadata.annotations` |
| **I-04** | High | ✅ **Resolved** | The two competing Vault designs are settled: Track V phase 1 deployed **Vault 1.21.2, 3-node Raft, Transit auto-unseal**, TLS from a new internal CA, file audit devices — with auto-unseal **verified against a `qm reset` hard power cycle** (returned unsealed, rejoined as voter in ~20s, no human interaction) | Appendix H |
| **Track V ph.2** | Critical | ❌ **Unstarted** | *"Track V phase 2 (k8s auth, policies, injector, secret migration, snapshots) is unblocked and unstarted."* **D-01/D-02/D-03 stay open until this cutover happens** — the HA Vault exists and nothing in `hope-v2-dev` uses it | TASK-616 Change History 2026-08-07 |

Two live traps recorded in Appendix H that this ticket must carry forward:

- `disable_mlock=true` plus the VM template's swap partition would have let Vault page **decrypted
  secrets to disk**. Swap was disabled on all four VMs as the fix — any new Vault VM must repeat it.
- **Template 903 clones onto `redis-01`'s live static IP.** Corrected within ~2 min last time and
  `redis-01` verified unaffected, but it remains a live trap for the next person who clones it.

### 2.4 Boundary

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **C-10** | High | ❌ **Live** | The Vault deploy role scopes `bound_claims.ref` to `{staging, dev, v*}`, but **neither is a protected branch** — only `main` and `release` are. Anyone who can push a branch could mint deploy credentials. The RBAC-looking control is decorative until branch protection lands | `vault.yml:105-119`; live query 2026-08-07 |

---

## 3. Implementation Plan

**⚙ = human-applied. ⚠ = owner decision.** Tier/effort per the
[Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md).
This ticket carries the program's heaviest `opus` allocation — not because the files are large, but
because a wrong NetworkPolicy silently severs a clinical pipeline and a wrong hardening flag makes
snapshots unrestorable.

### Wave A — Cheap, independent, do first

| # | Task | Closes | Complexity | Tier | Effort |
|---|---|---|---|---|---|
| **A.1** | ⚙ **Protect the `dev` and `staging` branches** in GitLab so the Vault deploy role's `ref` scoping becomes real | C-10 | — | **human** | — |
| **A.2** | **Resolve Fleet vs Argo.** Determine which controller owns `hope-v2-dev`, decide, and document. Check `helm list -A` for `catalog.cattle.io/*` on `gpu-operator` while there (⚠ N4) — if it is Rancher-marketplace-owned, adopting it under Argo needs a deliberate migration, not an `Application` pointed at a live release | — | Complex — a live conflict with silent revert as the failure mode | `sonnet-5` | high |

### Wave B — Substrate ⚙ (needs TASK-617 complete)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **B.1** | **Author the k3s hardening config**: `/etc/rancher/k3s/config.yaml` (currently absent) with `secrets-encryption`, `protect-kernel-defaults`, apiserver audit policy, kubelet flags, and `system-reserved`/`kube-reserved` sized for this node. Include a **pre-flight validation script** and an explicit rollback | Q2, LIVE-05 | Very high — cluster-wide blast radius | `opus-5` | high | ⚙ **applied by the owner in a window.** **The join token goes into Vault first** (§5) |
| **B.2** | **Author the k3s datastore backup + a rehearsed restore.** The datastore is **SQLite, not etcd** — there is no Raft snapshot backstop, so the backup mechanism differs from every k3s-HA runbook you will find | — | Complex — the SQLite detail invalidates the obvious approach | `sonnet-5` | high | ⚙ the drill is human. *An untested backup is not a backup* |

### Wave C — Workload isolation

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **C.1** | **Label every namespace `pod-security.kubernetes.io/{warn,audit}: restricted` — `warn` and `audit` ONLY, not `enforce`.** Collect what the audit log surfaces | LIVE-12 | Moderate | `sonnet-5` | medium | Staged rollout is mandatory (§5) |
| **C.2** | **Add `securityContext` to every workload** — `runAsNonRoot`, `readOnlyRootFilesystem`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault` — and **fix the two `runAsUser: 0` init containers in `stt-v2*`**. Partition by service so agents work disjoint files | D-07 | Complex — 15 workloads, per-service breakage risk | `sonnet-5` | max | Driven by C.1's audit output, not guessed |
| **C.3** | ⚙ **Flip PSA to `enforce: restricted`** once C.2's audit log is clean | — | — | **human** | — | |
| **C.4** | **Derive the service dependency graph from real traffic** — not from reading manifests — and author default-deny + explicit-allow NetworkPolicies, Kyverno-generated per namespace with `synchronize: true` | LIVE-11, D-08 | **Very high** — getting it wrong breaks a clinical pipeline silently, and the failure surfaces as a timeout, not an error | `opus-5` | max | Install Kyverno here; [TASK-621](../TASK-621-Supply-Chain-Integrity/README.md) adds `verifyImages` later |

### Wave D — Vault cutover (absorbs TASK-623 phase 2)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **D.1** | ⚙ **Retrieve the Track V key material offline and revoke both root tokens** — the outstanding owner tail from Appendix H | — | — | **human** | — | Do before anything depends on the new Vault |
| **D.2** | **Port the existing auth/policy layer**: Vault Kubernetes auth for the six Python services with per-service roles and HCL policies; keep AppRole for `hope-api` only (its client implements nothing else). This layer **already exists and is tested** in `infrastructure/single-deployment/vault/` — reuse, do not reinvent | D-03 | Complex — reuse, not invention | `sonnet-5` | high | |
| **D.3** | **Deploy the Vault Agent Injector** into k3s pointed at the *external* Vault; author per-service manifests shaped like `deployment/vault-agent/reference-deployment.yaml` — memory-backed `emptyDir`, no `envFrom: secretRef` | D-01 | Complex | `sonnet-5` | high | |
| **D.4** | **Author the export/migrate/rotate scripts.** The dev Vault's **file backend cannot be Raft-snapshotted**, so this is a scripted export, not a snapshot restore | — | **Very high** — irreversible, PHI | `opus-5` | max | ⚙ execution is human |
| **D.5** | ⚙ **Cut over, then rotate every credential that was ever in a plaintext Secret.** Decommission the dev Vault and both plaintext Secrets | D-01, D-02, D-03 | — | **human** | — | **The rotation *is* the security boundary of this migration**, not cleanup afterwards |
| **D.6** | **Author the Raft snapshot CronJob** + a rehearsed restore | — | Moderate | `sonnet-5` | medium | ⚙ the drill is human |

---

## 4. Owner decisions and blocked items

| # | Item | Why it is owner-only |
|---|---|---|
| **⚙ 1** | **Root/sudo on VM 200.** Needed to read the current baseline (`secrets-encrypt status`, `/etc/rancher/k3s/config.yaml`) and to apply B.1. Without it the post-hardening state cannot be diffed against the pre-hardening state | No access |
| **⚙ 2** | Applying B.1 — a cluster-wide restart in a maintenance window | Blast radius |
| **⚙ 3** | D.1 key-material retrieval and dual root-token revocation | Irreversible, PHI |
| **⚙ 4** | **D.5 credential rotation — scope is much larger than first assessed.** D-01b means the rotation list is **every one of the 31 keys in `hope-secrets`**, not just the two GitLab tokens in [TASK-619 F0-1](../TASK-619-GitOps-CICD-Delivery-Loop/README.md). That includes the Postgres superuser password (shared with the Temporal DB user), `JWT_SECRET_KEY` (rotating it invalidates every live session), the Azure/HuggingFace/Sarvam third-party keys, and the Vault AppRole + token. Sequence it against D.2/D.3 so services are already reading from Vault before the underlying values change — rotating first and migrating second means an outage per service | Irreversible; the actual security boundary |
| **⚙ 4a** | **Strip the `last-applied-configuration` annotation** as an immediate containment step, independently of the full rotation. `kubectl apply` will recreate it on the next apply, so the durable fix is to stop applying this Secret with `kubectl apply` at all — which is what D.3's Vault Agent injection achieves. Note this annotation is *also* what [TASK-617's withdrawn L-06](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) was misread from: on workload objects it is Argo's own client-side apply and harmless; on this Secret it is a plaintext credential dump | Cheap, reduces exposure now |
| **⚠ 5** | **N2 — does an internal CA already exist** for VM-to-VM TLS (e.g. Postgres HA)? Track V created "a new internal CA"; whether that answered N2 as *no* or created a second hierarchy is unrecorded. **Do not invent a second CA hierarchy if one exists** | Architecture |
| **⚠ 6** | **N3 — Vault 1.21.2 vs the runbook's 1.18** — a deliberate deviation to run one version, not two. Deployed, but formal sign-off is unrecorded | Sign-off |
| **⚠ 7** | **N4 — is `gpu-operator` Rancher-marketplace-owned?** Interacts with A.2's Fleet-vs-Argo decision and with any Kyverno policy applied near GPU workloads | Ownership |
| **⚠ 8** | **N5 — is `hope-v1` (`c-9lwv8`) live production?** It has its own `hope`, `vault`, `storage`, `kafka`, `observability` namespaces. If it is live, D.5's rotation may touch shared credential infrastructure | Risk calculus |
| **⚠ 9** | **Scope honesty.** TASK-616 §9: *"'All three environments production-ready' — Achievable for the manifests; not for the substrate. Three namespaces on one single-node VM share a kernel, one disk (currently 89% full), one GPU pair, and one failure domain."* PSA/NetworkPolicy/securityContext harden the manifests; **node-level isolation is out of reach without a second node** | Must be stated, not implied |

### Surfaced by TASK-617 Wave A — candidate scope for this ticket

**Argo CD holds cluster-admin on `hope-v2-dev`.** [TASK-617 A.4](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/wave-a4-argo-direct-api-runbook.md)
found a live `ClusterRole/argocd-manager-role` on `c-nfhxq` granting `*` verbs on `*` resources in
`*` API groups, plus `*` on all `nonResourceURLs` — created 2026-03-19. It is byte-identical to
upstream Argo CD's bootstrap manifest, so it is the vendor default rather than a local mistake, and
it is **not** broader than what the Rancher-proxy path already grants. But on a PHI platform it
means a compromised Argo controller owns the cluster outright.

Not scoped into a wave yet because narrowing it needs the same input as C.4 — a derived inventory of
what Argo actually applies. **Fold it into C.4's evidence-gathering**: the same traffic/resource
survey that produces the NetworkPolicy graph also produces the resource list an Argo role would need.
Do not narrow it by guesswork; a missing verb surfaces as a sync failure at the worst moment.

### Adjacent, deliberately not scoped here

Redis persistence is disabled *"for PHI safety"*, yet Redis is now also the durability layer for
refresh tokens and in-flight audio (Appendix G §G3). That is a genuine policy conflict, not an
oversight. It is flagged for the owner to scope — it is not a Phase-2 acceptance criterion.

---

## 5. Sequencing constraints

These four orderings are the difference between a hardened cluster and an unrecoverable one.

1. **The k3s join token goes into Vault BEFORE `secrets-encryption` is enabled.** TASK-616 Risk
   Register: *"`secrets-encryption` on k3s without the join token in Vault → unrestorable snapshots"*
   — Likelihood Low, Impact **Critical**. Getting this backwards makes every future restore
   impossible. Verify with the B.2 restore drill.
2. **PSA rolls out as `warn`+`audit` first, then `enforce`.** Risk Register: *"Enabling PSA
   `restricted` makes pods unschedulable (STT's root init containers)"* — Likelihood **High**.
   Flipping `enforce` first breaks STT immediately.
3. **Vault Agent injection migrates one service at a time**, starting with `nlp` (lowest blast
   radius). **Keep the plaintext Secret in place until every service is cut over, then delete.**
   Migrating fleet-wide breaks every service at once.
4. **NetworkPolicy: default-deny and the allow rules ship together, derived from observed traffic.**
   Default-deny first with allow rules retrofitted after outages is how you take down a clinical
   pipeline. And the graph must come from real traffic — a manifest read misses the calls that only
   happen on an error path.

Two softer ones:

5. **A.2 (Fleet vs Argo) should precede any GitOps-delivered Phase-2 change.** With two reconcilers
   live on one namespace, a securityContext or PSA label applied through one can be reverted by the
   other — and the revert looks like the change never applied.
6. **Do not enable Argo `selfHeal` as part of this work.** The live ConfigMap still carries untracked
   keys; TASK-616 Change History: *"enabling Argo `selfHeal` today would break harness."*

---

## 6. Acceptance criteria

Substrate:
- [ ] `k3s check-config` passes; CIS profile output captured as evidence in §8
- [ ] **A test Secret is confirmed encrypted at rest** (read it directly from the datastore)
- [ ] The join token is in Vault **and** a restore drill using it succeeds
- [ ] `kubectl describe node dell` shows `Allocatable` strictly less than `Capacity` for cpu and memory

Workload isolation:
- [ ] Every pod starts under PSA `restricted`; **zero PSA warnings in the audit log**
- [ ] No workload runs as root; the two `stt-v2*` init containers are fixed
- [ ] **A `kubectl exec` curl from `nlp` to `vault` is refused**
- [ ] The documented service graph still functions end-to-end — a full consultation completes: audio → STT → NLP → guardrail → SMR → summary

Secrets:
- [ ] `kubectl get secret hope-secrets` **returns nothing**
- [ ] Every service starts with secrets sourced from an injected file; no `envFrom: secretRef` remains on any Python service
- [ ] Vault reports `sealed: false, ha_enabled: true`; a snapshot is taken and **one restore is rehearsed**
- [ ] Every credential that was ever in a plaintext Secret has been rotated
- [ ] The dev-mode Vault and both plaintext Secrets are deleted

Boundary:
- [ ] A push to `staging` from a non-maintainer is rejected
- [ ] Exactly one controller reconciles `hope-v2-dev`, and which one is documented

---

## 7. Implementation Summary

*Not started — awaiting owner approval of this plan (Phase 3 gate).*

---

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Ticket created. TASK-616 Phase 2 was never spun out; this creates it and **absorbs the never-created TASK-623**, whose VM half was executed inside the parent (Track V phase 1, Appendix H) and whose remaining half — k8s auth, injector, secret migration, snapshots — is how D-01/D-02/D-03 close, so it lives here as Wave D rather than duplicating every gate in a separate ticket. Live verification on 2026-08-08 confirmed all three isolation gaps are **total, not partial**: zero PSA labels on `hope-v2-dev`, zero NetworkPolicies anywhere in the cluster except Fleet's own `default-allow-all`, and `allocated == capacity` on the node (no `system-reserved`). Recorded the four destructive-if-reordered sequencing constraints and the two Track V traps (swap-vs-`disable_mlock`, template 903's IP collision). Status `Pending` pending owner approval. | Claude |
| 2026-08-12 | Closed — plan deprioritized, not being pursued at this time. | owner |
