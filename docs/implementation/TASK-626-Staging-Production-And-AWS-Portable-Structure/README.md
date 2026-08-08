# TASK-626 — Staging + Production Environments & AWS-Portable Structure

**Status**: Pending (plan authored 2026-08-08, awaiting owner approval)
**Classification**: infrastructure
**Created**: 2026-08-08
**Parent**: [TASK-616 Phase 8](../TASK-616-Deployment-CICD-Observability-Modernization/README.md#phase-8--staging-production-and-aws-portable-structure--l) · [Program index](../TASK-616-Deployment-CICD-Observability-Modernization/phase-program-index.md)
**Scope**: `arca/hope-v2-deployment` — `deployment/k8s/base/` (new `components/` split), `deployment/k8s/overlays/{staging,prod}/`, `deployment/argocd/{application,appproject}-{staging,prod}.yaml`; the live `hope-v2` Rancher cluster (`c-nfhxq`, new `hope-v2-staging`/`hope-v2-prod` namespaces)
**Conventions**: [Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md)
**Evidence base**: [component-design-aws-portability.md](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-aws-portability.md) (read in full) · live Rancher/ArgoCD API checks 2026-08-08 (this document) · [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) · [TASK-622](../TASK-622-Portability-Hygiene-And-Operations-Docs/README.md)

---

## 1. Requirement Analysis

TASK-616 Phase 8 was scoped as *"all three environments production-ready" and "AWS-compatible"*
— six steps (8.1–8.6): a Kustomize `components/` split, explicit `storageClassName`, a real
staging namespace/overlay/Application, a genuine (non-placeholder) production overlay, a
documented hybrid AWS boundary, and a HIPAA-on-AWS gap list. Full design in
[`component-design-aws-portability.md`](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-aws-portability.md).

Re-verified against `arca/hope-v2-deployment` and the live cluster on 2026-08-08, the design
doc's "these are stubs" framing from 2026-08-07 is **partly stale** — real progress landed since:

| Restated requirement | What changed since the design doc |
|---|---|
| Real staging/prod Argo `Application` + `AppProject` manifests | **Already authored and committed** — `application-{staging,prod}.yaml`, `appproject-{dev,staging,prod}.yaml` all exist with real RBAC and sync policy (§2). What's missing is proof they *sync live* |
| A built-out staging overlay | **Already substantially done** — `NODE_ENV=staging`, OTel on, ingress hostname patch, all 11 services + `compat-playground` in `images:` (fixes TASK-616 D-04) |
| Prod HPA/PDB | **Partially done** — exist for `hope-api` only, as top-level `overlays/prod/kustomization.yaml` resources |
| Digest-pinned promotion | **Working as designed but invisible in Git** — committed overlays carry placeholder tags (`staging-latest`, `"0.0.0"`); real digests are set only at promotion time via `kustomize edit set image` and never committed back. State plainly what that means for diff review (§2) |
| Kustomize `components/` split (storage/ingress/GPU/secrets axes) | **Zero progress** — no `components/` directory exists at all; this is genuinely greenfield (8.1) |
| Explicit `storageClassName` everywhere | **Zero progress** — not one PVC in `base/` sets it; STT's model cache is still `hostPath` (8.2) |
| Real staging/prod namespaces live on the cluster | **Zero progress** — the cluster has exactly one HOPE namespace (`hope-v2-dev`) and exactly one Argo `Application`, hand-created via `kubectl`, not from Git (§2, LIVE-08 cross-reference to TASK-617) |

So this ticket's first real deliverable is **proving the already-committed staging manifests
actually sync live** — not authoring more YAML that joins the four unpushed commits TASK-617
is already recovering.

**Classification**: `infrastructure`. **Not** a feature ticket — no user-visible product
capability; the AWS-portability and HIPAA-gap deliverables are explicitly analysis/decision
records, not new capability either.

### Explicitly out of scope

| Excluded | Owned by |
|---|---|
| GitOps delivery-path recovery itself (Argo panic, unpushed commits, Rancher-proxy destination) | [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) — this ticket's staging/prod work is blocked on 617 landing first (§5) |
| Real API Ingress (`Ingress/hope-api` does not exist; three overlay patches silently no-op against it) | [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) C.5 — cross-reference only, do not duplicate |
| NetworkPolicy (any of it) | [TASK-618](../TASK-618-PHI-Security-Baseline/README.md) — listed here as a hard **dependency** for any credible "production-ready" claim (§4 ⚠) |
| Vault HA wiring into the k8s secret-delivery path (`vault.yaml` is still dev-mode: `storage "file"`, `replicas: 1`) | [TASK-618](../TASK-618-PHI-Security-Baseline/README.md) §2.4/2.5 (Vault HA Track V phase 2) — this ticket documents the gap, does not close it |
| Qdrant and harness-worker resource registration in `base/kustomization.yaml` | [TASK-624](../TASK-624-Qdrant-Deployment-And-Auth/README.md), [TASK-625](../TASK-625-Harness-Temporal-Worker-And-Consolidation/README.md) — this ticket's "all 11 workloads Healthy" acceptance criterion cannot be true until both land (§5) |
| Base-level anti-affinity/PDB/HPA rollout across all 11 services | [TASK-622](../TASK-622-Portability-Hygiene-And-Operations-Docs/README.md) — this ticket owns **prod-overlay tiering** (replica counts, resource classes) built on top of that base; see the file-ownership split at §4 ⚠ 1 |
| Operations runbooks (staging deploy, rollback, k3s upgrade) | [TASK-622](../TASK-622-Portability-Hygiene-And-Operations-Docs/README.md) §Wave B |
| Full EKS migration itself (Terraform, Control Tower landing zone, actual account creation) | Not this ticket, not any ticket in this program yet — this ticket produces the **decision record and gap list** (8.5/8.6); execution is a future ticket triggered by the ⚠ decision at §4 |

---

## 2. Current State Evaluation

### 2.1 Argo application/project layer — further along than the design doc assumed

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **S-01** | — | ✅ **Done** | `application-staging.yaml` and `application-prod.yaml` exist and are real, each bundling a `Namespace` + Argo `Application`. Staging: `syncPolicy.automated: {prune: true, selfHeal: true}`. Prod: **no `automated:` block at all** — deliberate, since its absence is the only reliable "off" switch on GitLab CE; manual sync only, with `retry` (limit 3, exponential backoff) and `ignoreDifferences` on `spec.replicas` (so a manual `kubectl scale` isn't fought) | `deployment/argocd/application-staging.yaml`; `deployment/argocd/application-prod.yaml` |
| **S-02** | — | ✅ **Done** | `appproject-{dev,staging,prod}.yaml` all exist with real RBAC via `namespaceResourceWhitelist`/`clusterResourceWhitelist`; `Secret` is blacklisted at the namespace-resource level in each | `deployment/argocd/appproject-{dev,staging,prod}.yaml` |
| **S-03** | Critical | ❌ **Not started — the actual blocker** | **Live cluster reality (verified 2026-08-08 via the Rancher and ArgoCD APIs)**: cluster `hope-v2` (`c-nfhxq`) has exactly **one** HOPE namespace — `hope-v2-dev`. No `hope-v2-staging`, no `hope-v2-prod`. Exactly **one** Argo `Application` exists cluster-wide, created 2026-03-31 with `managedFields.manager: kubectl` — **hand-made, not from Git**, matching TASK-617's LIVE-08. So this ticket's committed `application-staging.yaml`/`application-prod.yaml` have never been applied to `argocd` — they are unregistered manifests, not unhealthy ones | Rancher API namespace list; ArgoCD API `Application` list (both queried 2026-08-08) |
| **S-04** | High | ⚠️ **Same destination-server risk TASK-617 is diagnosing** | Both `application-staging.yaml` and `application-prod.yaml` set `spec.destination.server: https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq` — the same Rancher-proxy destination TASK-617's L-01 names as the likely cause of `health.status: Missing` on the existing dev Application. Registering staging/prod through the same proxy risks reproducing that failure mode on two more Applications before it's even diagnosed once | `application-staging.yaml`; `application-prod.yaml`; TASK-617 §2.1 L-01 |

### 2.2 Overlay content — staging is real, prod is a real template with two gaps

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| S-05 | — | ✅ **Done** | `overlays/staging/kustomization.yaml` is genuinely built out: `NODE_ENV=staging`, OTel on, an Ingress hostname patch, and a complete `images:` list covering all 11 services **including `compat-playground`** — the exact fix for TASK-616's D-04 | `overlays/staging/kustomization.yaml:37-79` |
| S-06 | Medium | ⚠️ **Partial** | `overlays/prod/kustomization.yaml` now includes `hpa.yaml` and `pdb.yaml` as top-level `resources:` — but **only for `hope-api`** (`overlays/prod/hpa.yaml` scopes `scaleTargetRef.name: hope-api`; `pdb.yaml` scopes `selector.matchLabels.app: hope-api`). The other 10 services have neither, in prod or anywhere else | `overlays/prod/kustomization.yaml`; `overlays/prod/hpa.yaml`; `overlays/prod/pdb.yaml` |
| **S-07** | Medium | ⚠️ **Working as designed, but invisible in Git — call this out explicitly for diff review** | Both overlays carry placeholder tags **in the committed file**: staging `newTag: staging-latest` (mutable, auto-updated by CI on branch push), prod `newTag: "0.0.0"`. Both are overwritten only at promotion time by `kustomize edit set image <name>=<repo>@sha256:<digest>` (`promote-staging`/`promote-prod` in `.gitlab/ci/deploy.yml:71,84`), which replaces `newTag:` with a `digest:` field. **The committed state in `git show`/`git diff` never shows a real tag** — reviewing a PR against this repo shows only the placeholder, never the deployed digest. Document this explicitly so a reviewer doesn't mistake `"0.0.0"` for a stale pin | `overlays/staging/kustomization.yaml:37-41` (comment already states this); `overlays/prod/kustomization.yaml:44-47` (same); `.gitlab/ci/deploy.yml:71,84` |

### 2.3 Portability primitives — genuinely greenfield

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| **S-08** | High | ❌ **Not started** | **Zero `storageClassName` anywhere** in `deployment/k8s/base/` — Phase 8.2 fully unstarted. STT's model cache is still a `hostPath` volume, not a PVC, in both `stt-v2.yaml` and `stt-v2-worker.yaml` | `grep -rn "storageClassName" deployment/k8s/` → 0 hits; `stt-v2.yaml:192`, `stt-v2-worker.yaml:143` (`hostPath:`) |
| **S-09** | High | ❌ **Not started** | **No `components/` directory exists** — only `base/` and `overlays/{dev,staging,prod}`. Phase 8.1's entire structure (`storage-k3s`/`storage-aws`, `ingress-k3s`/`ingress-aws`, `gpu-passthrough`/`gpu-karpenter`, `secrets-k8s`/`secrets-vault-agent`) is greenfield — the design doc's proposed layout in §2 item 3 is the closest thing to a spec | `find deployment -maxdepth 2 -type d` → `base`, `argocd`, `overlays` only; [component-design-aws-portability.md §2 item 3](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-aws-portability.md) |
| **S-10** | High | ❌ **Not started — owned elsewhere, cross-referenced only** | **No real API Ingress** — only `grafana.yaml` defines one (`ingressClassName: traefik`, the only IngressClass verified present in the cluster). All three overlays JSON6902-patch a `target: {kind: Ingress, name: hope-api}` that matches zero resources; kustomize silently no-ops the patch. Do not fix this here — TASK-617 C.5 owns it; this ticket's Ingress-related work (if any) is limited to the `ingress-aws` component's shape, which is moot until the k3s-side Ingress exists | `overlays/dev/kustomization.yaml:139-140`; `overlays/staging/kustomization.yaml:30-31`; `overlays/prod/kustomization.yaml:39-42`; `grafana.yaml:118` (the one real `ingressClassName: traefik`) |
| **S-11** | Critical | ❌ **Not started — blocks any "production-ready" claim** | **No NetworkPolicy anywhere** in `arca/hope-v2-deployment`. Owned by TASK-618, but listed as a finding here because this ticket's own acceptance criteria cannot honestly claim "production-ready" while every pod in every namespace can reach every other pod | `grep -rln "kind: NetworkPolicy" deployment/k8s/` → 0 hits |
| **S-12** | Critical | ❌ **Not started** | `vault.yaml:29,42` — the k8s Vault manifest is **still dev-mode**: `storage "file"` (not Raft), `replicas: 1`. The live Vault HA cluster (TASK-616 Track V, 3-node Raft + Transit auto-unseal, on separate Proxmox VMs 430-432/434) is **not yet wired into this secret-delivery path** — the two Vaults are currently unrelated systems | `vault.yaml:29,42`; TASK-616 Track V memory (`task616-vault-ha-track-v.md`) |
| **S-13** | High | ❌ **Not started** | `api.yaml` still delivers `VAULT_ROLE_ID`/`VAULT_SECRET_ID` via plaintext `secretKeyRef` into the materialized `hope-secrets` Kubernetes `Secret` — the exact posture `09-infrastructure-devops.md` §"In-cluster secret delivery" rejects for a PHI platform already running Vault HA (ESO/materialized-Secret pattern acceptable only for non-PHI, periodically-rotated values) | `api.yaml:47-56` |

### 2.4 AWS portability analysis — inputs already exist, decision record does not

| ID | Sev | State | Statement | Evidence |
|---|---|---|---|---|
| S-14 | — | ✅ **Done — cite, don't re-derive** | Object storage is already a credential/endpoint change, not a code change: `packages/applications/src/services/baseServices/storage/s3/s3.service.ts` uses `@aws-sdk/client-s3`'s `S3Client` against a configurable endpoint (currently a MinIO override) | `packages/applications/src/services/baseServices/storage/s3/s3.service.ts:13-14,207` |
| S-15 | — | ✅ **Analysis done, decision record not yet written** | Cost basis from the design doc: a 3-environment EKS footprint with 24/7 GPU capacity runs **≈ $4,000–6,000+/mo**, dominated by the GPU line (~$2,300/mo for 2× G6.xlarge on-demand vs. sunk/amortized Proxmox hardware) — recommendation is **control plane AWS-portable, GPU inference stays on-prem**, roughly a 4–8× cost saving on the GPU half. This ticket's 8.5 deliverable is the *written decision record*, not new cost analysis | [component-design-aws-portability.md §3c–4](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-aws-portability.md) |
| S-16 | — | ✅ **Analysis done, gap list not yet extracted into a standalone deliverable** | HIPAA-on-AWS: every service this platform would use is HIPAA-eligible (EKS, RDS, ElastiCache, S3, EFS, KMS, Secrets Manager, CloudWatch, ECR) — eligibility is necessary but not sufficient; the design doc maps each to the specific technical controls it must still configure (KMS CMK encryption, private endpoints, IAM auth, no static passwords, VPC isolation). The multi-account Control Tower landing zone is named as "a bigger structural change than moving to EKS" and its own decision | [component-design-aws-portability.md §3a](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-aws-portability.md) |

---

> ### Surfaced by TASK-617 Wave C (2026-08-08) — a host collision waiting for this ticket
>
> Only the **dev** overlay patches Grafana's Ingress hostname. Staging and prod both render
> `host: grafana.local`, the unpatched base placeholder. Harmless while `hope-v2-dev` is the only
> namespace — but **this ticket is what creates the other two**, and the moment staging and prod
> coexist on this single-node cluster, two Ingress objects claim the same host and Traefik resolves
> it arbitrarily. This is the concrete form of TASK-616's O-12 "Grafana Ingress-host collision".
>
> TASK-617 C.5 added per-overlay hostname patches for `hope-api`, `hope-admin-console` and
> `hope-compat-playground` following the live `grafana-dev.taphuynh.dev` precedent, so the pattern to
> copy already exists — Grafana was simply never brought along. Fold it into the staging/prod overlay
> work rather than treating it as a separate defect.

## 3. Implementation Plan

Four waves. Everything inside a wave runs concurrently. Tier and effort per the
[Agent Operating Contract](../TASK-616-Deployment-CICD-Observability-Modernization/agent-operating-contract.md).

**⚙ = human-applied** (agent authors, owner executes). **⚠ = owner decision.**

### Wave A — Prove the already-committed manifests, before writing more (no cluster risk)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **A.1** | **Audit `application-staging.yaml`/`application-prod.yaml`/the three `appproject-*.yaml` files against the live ArgoCD API** — confirm they render correctly with `kustomize build`, that the `AppProject` RBAC is internally consistent (no orphaned role references), and produce the exact `argocd app create`/`kubectl apply` commands needed to register them. Do not apply | S-01, S-02, S-03 | Moderate — review with live cross-check, no mutation | `sonnet-5` | medium | This is the ticket's actual starting point per §1 — proving the committed work syncs, not authoring more of it |
| **A.2** | **Flag S-04's shared destination-server risk to TASK-617** — do not independently re-diagnose the Rancher-proxy issue; cross-reference TASK-617's A.4 (direct-API re-registration) and state that staging/prod registration should use whatever destination A.4 lands on, not the proxy URL currently committed | S-04 | Trivial — cross-ticket flag, one sentence + a citation | `haiku-4-5` | default | Do not duplicate TASK-617's diagnosis work |
| **A.3** | **Document the digest-pinning/placeholder-tag behavior (S-07) in the overlay files' own comments** if not already sufficiently explicit, and add a one-line note to the PR/review template (or the ticket README) so reviewers know `git diff` on these overlays will never show a real tag | S-07 | Trivial — documentation of existing, correct behavior | `haiku-4-5` | default | The comments already partially explain this (`overlays/staging/kustomization.yaml:37-41`) — confirm completeness, don't rewrite the mechanism |

**Wave A gate**: a written verdict on whether the committed staging/prod Argo objects are
registration-ready as-is, with the exact ⚙ commands to register them.

### Wave B — Portability primitives (concurrent, disjoint files)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **B.1** | **Build the `components/` split** per the design doc's proposed structure: `storage-k3s`/`storage-aws`, `ingress-k3s`/`ingress-aws`, `gpu-passthrough`/`gpu-karpenter`, `secrets-k8s`/`secrets-vault-agent`. Move every currently-implicit cloud-specific field (storage class, ingress class, GPU runtime class, secret delivery mechanism) out of `base/` into the matching component; `base/` becomes a pure app description with explicit (not implicit-default) resource requests | 8.1 | Complex — cross-cutting Kustomize architecture change touching every service's storage/ingress/GPU/secrets wiring | `opus-4-8` | high | This restructures the primitive every later environment (including AWS) composes from — architecture-tier work per the operating contract's tier table, not mechanical file-by-file editing |
| **B.2** | **Add explicit `storageClassName: local-path` to all 7 PVCs**, and replace the STT `hostPath` model cache with a real PVC, via the `storage-k3s` component from B.1 | 8.2 | Moderate — mechanical once B.1's component shape exists | `sonnet-5` | medium | Sequenced after B.1 lands the component skeleton (§5) |
| **B.3** | **Wire `application-staging.yaml`/`application-prod.yaml` into the `hope-v2-staging`/`hope-v2-prod` Argo Projects** and confirm the `AppProject` RBAC (S-02) correctly scopes each — author only, do not register | 8.3 (partial) | Moderate | `sonnet-5` | medium | Depends on Wave A's audit (A.1) confirming no RBAC defect first |

**Wave B gate**: `kustomize build --enable-helm` produces a correct render for both a k3s overlay
and a stub `aws-dev` overlay from one `base/`, per Phase 8.1's own verification line; no implicit-
default PVC remains anywhere in the tree.

### Wave C — Production overlay hardening + decision records (concurrent)

| # | Task | Closes | Complexity | Tier | Effort | Notes |
|---|---|---|---|---|---|---|
| **C.1** | **Extend prod HPA/PDB to the remaining 10 services** — `overlays/prod/hpa.yaml`/`pdb.yaml` today scope `hope-api` only. Build on the base-level anti-affinity/PDB/HPA rollout TASK-622 delivers (see the file-ownership split at §4 ⚠ 1) — this task owns the **prod-specific tiering** (replica counts, resource classes) layered on top, not the base primitives themselves | 8.4 | Moderate — 10 services, same shape, tier decisions per service | `sonnet-5` | medium | Do not start until TASK-622's base-level rollout has landed or the ⚠ 1 split is otherwise resolved |
| **C.2** | **Write the hybrid-boundary decision record (8.5)**: control plane (Postgres→RDS, Redis→ElastiCache, MinIO→S3, Vault→KMS auto-unseal, CPU services) AWS-portable; GPU inference stays on-prem. Cite the design doc's cost basis (S-15) directly rather than re-deriving it; the deliverable is the **written decision**, framed as a recommendation for the ⚠ owner decision at §4, not a unilateral architecture change | 8.5 | Complex — synthesizes an existing cost/risk analysis into an actionable decision record | `opus-5` | high | Architecture-tier per the operating contract: "the hybrid AWS boundary" is explicitly listed there as something the agent supplies analysis for, the owner decides |
| **C.3** | **Write the HIPAA-on-AWS gap list (8.6)**: BAA scope, HIPAA-eligible service list, multi-account landing zone note, Pod Identity over IRSA, encryption/audit controls — as **a gap list against technical safeguards, never a compliance claim**. Say that in those exact words in the document itself | 8.6 | Complex — regulatory-adjacent synthesis; must not overstate compliance posture | `opus-5` | high | S-16's source material already exists in the design doc §3a/§3b — this task extracts and formats it as a standalone, citable gap list, it does not re-research HIPAA from scratch |

**Wave C gate**: a dry-run render of the hardened prod overlay passes against a simulated
multi-node cluster (Phase 8.4's own verification line); both decision records exist as standalone,
owner-reviewable documents, not buried in the design doc.

### Wave D — Registration and live verification ⚙ (after TASK-617, -618, -624, -625 land)

| # | Task | Tier |
|---|---|---|
| D.1 | ⚙ Register `application-staging.yaml`/`appproject-staging.yaml` against the destination TASK-617's A.4 lands (not the Rancher proxy, per S-04) | **human** |
| D.2 | ⚙ Confirm `hope-v2-staging` namespace and all resources reach `Synced`/`Healthy`; capture the evidence | **human** |
| D.3 | ⚙ Repeat D.1/D.2 for `hope-v2-prod`, with a manual `argocd app sync hope-v2-prod` (no `automated:` block, per S-01) | **human** |
| D.4 | Capture evidence for every §6 gate and write the Implementation Summary | `sonnet-5` (medium) |

---

## 4. Owner decisions and blocked items

| # | Item | Why it is owner-only |
|---|---|---|
| **⚠ 1** | **File-ownership split with TASK-622 on `overlays/prod/{hpa,pdb}.yaml`.** TASK-622 also touches these files for the base-level anti-affinity/PDB/HPA rollout across all 11 services. This ticket (TASK-626) owns **prod-overlay tiering** (C.1) built on top of that base; TASK-622 owns the base primitives themselves. Confirm this split explicitly before C.1 and TASK-622's equivalent tasks run concurrently — see the identical flag in TASK-622 §4 ⚠ 1 | Cross-ticket sequencing decision; must be picked explicitly, not discovered as a merge conflict |
| **⚠ 2** | **Whether staging/prod should go live on the shared single-node VM 200 at all.** Three namespaces on one kernel, one disk (89% full per TASK-617 L-10), one GPU pair, one failure domain is "production-grade" configuration, **not production isolation**. Decide whether `hope-v2-staging`/`hope-v2-prod` land on VM 200 as planned, or whether that decision should wait for dedicated hardware | Capacity/risk-acceptance decision the design doc explicitly declines to make unilaterally |
| **⚠ 3** | **The full-EKS migration trigger.** C.2's decision record recommends hybrid (control plane AWS, GPU on-prem) for now, but names two conditions that would revisit it: sustained GPU saturation making spot/Karpenter cost-competitive, or a deliberate choice to stop operating physical hardware regardless of cost. Confirm the hybrid recommendation, or set the trigger condition explicitly | Business/cost decision — the agent supplies the analysis, the owner decides, per the operating contract |
| **⚠ 4** | **The Control Tower multi-account landing-zone structure.** The design doc calls this "a bigger structural change than moving to EKS" and explicitly scopes it as its own decision, separate from "move to EKS." Confirm whether this ticket's HIPAA gap list (C.3) should assume single-account or multi-account as the target model | Determines the shape of C.3's gap list; a wrong assumption there gets extracted and acted on later |
| **⚙ 5** | Registering the staging/prod Argo `Application`/`AppProject` objects against the live cluster (Wave D) requires `argocd app create`/`kubectl apply` — non-negotiable human-applied per the operating contract | Agents author, humans apply |
| **⚙ 6** | AWS account creation, IAM/Control Tower setup, and any actual cloud spend are entirely outside this session's access and this ticket's execution scope — C.2/C.3 produce decision records only | No access; explicit scope boundary from §1 |

---

## 5. Sequencing constraints

1. **This entire ticket is gated on TASK-617 (§1's dependency chain: 617–625).** Nothing here can be verified live while GitOps cannot deliver — a staging/prod Argo `Application` registered against a controller that panics on every sync (TASK-617 LIVE-02) produces no signal. Wave A's audit work can start immediately; Wave D cannot start until TASK-617's Wave B/D gates are green.
2. **The "all 11 workloads Healthy" criterion (§6) cannot be true until TASK-624 (Qdrant) and TASK-625 (harness worker) register their new resources in `base/kustomization.yaml`.** Do not attempt to satisfy that criterion before both land.
3. **B.1 (the `components/` split) before B.2 (`storageClassName`) and before C.1's prod tiering assumes a stable base shape.** B.2 targets the `storage-k3s` component B.1 creates; building B.2 against the old flat `base/` produces throwaway work.
4. **A.1 before Wave D.** Do not register anything against the live cluster before the audit confirms the committed manifests are actually registration-ready — S-03 establishes they have never been tried.
5. **⚠ 1 resolved before C.1 and TASK-622's base-level rollout run concurrently.** Identical constraint to TASK-622 §5 item 2 — stated in both tickets so neither one misses it.
6. **NetworkPolicy (TASK-618, out of scope here) should land before Wave D's live registration**, or the newly-registered staging/prod namespaces go live with the same open-mesh networking S-11 already flags as blocking any "production-ready" claim. Not a hard technical blocker for Wave A–C authoring work, but a hard blocker for honestly claiming the acceptance criteria in §6.
7. **Vault HA wiring (S-12/S-13, owned by TASK-618 §2.4/2.5) should land before Wave D**, or staging/prod register with the same dev-mode, single-replica Vault and plaintext `secretKeyRef` delivery the dev namespace already has — no isolation improvement from the environment split alone.

---

## 6. Acceptance criteria

Wave A — proving existing manifests:
- [ ] A written audit confirms `application-{staging,prod}.yaml` and `appproject-{dev,staging,prod}.yaml` render correctly and their RBAC is internally consistent
- [ ] The exact `argocd`/`kubectl` registration commands are documented, not applied

Wave B — portability primitives:
- [ ] `deployment/k8s/components/` exists with all eight named components (`storage-k3s`/`storage-aws`, `ingress-k3s`/`ingress-aws`, `gpu-passthrough`/`gpu-karpenter`, `secrets-k8s`/`secrets-vault-agent`)
- [ ] `kustomize build --enable-helm` renders correctly for both a k3s overlay and a stub `aws-dev` overlay from one `base/`
- [ ] All 7 PVCs carry an explicit `storageClassName`; the STT model cache is a PVC, not `hostPath`

Wave C — production hardening + decision records:
- [ ] All 11 services carry an HPA and a PDB in the prod overlay, each service's tiering justified (not copy-pasted from `hope-api`)
- [ ] A dry-run render of the hardened prod overlay passes against a simulated multi-node cluster
- [ ] A standalone hybrid-boundary decision record exists, citing the design doc's cost basis, framed as input to owner decision ⚠ 3
- [ ] A standalone HIPAA-on-AWS gap list exists, explicitly labeled as a gap list and not a compliance claim

Wave D — live registration (blocked on TASK-617/618/624/625):
- [ ] `hope-v2-staging` namespace exists on the live cluster with Argo reporting `sync.status: Synced` / `health.status: Healthy`
- [ ] `hope-v2-prod` namespace exists with the same, registered via manual sync only (no `automated:` block)
- [ ] All 11 workloads report `Healthy` in both namespaces (blocked on TASK-624/625 per §5 item 2)
- [ ] A trivial commit to the staging overlay is observed reaching the cluster end-to-end without hand-editing

---

## 7. Implementation Summary

*Not started — awaiting owner approval of this plan (Phase 3 gate).*

---

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Ticket created from TASK-616 Phase 8, re-verified against `arca/hope-v2-deployment` and the live Rancher/ArgoCD APIs. The 2026-08-07 design doc's "these are stubs" framing corrected: the Argo `Application`/`AppProject` layer and the staging overlay are substantially built (S-01/S-02/S-05); what remains unstarted is the `components/` split (S-09), `storageClassName` (S-08), and — the actual blocker — proof that anything committed has ever synced to the live cluster, which has exactly one HOPE namespace and one hand-made Argo `Application` today (S-03). File-ownership overlap with TASK-622 on `overlays/prod/{hpa,pdb}.yaml` recorded explicitly as ⚠ 1 in both tickets. Dependency on TASK-617/618/624/625 stated as a hard sequencing constraint, not a soft note. Status `Pending` pending owner approval. | Claude |
