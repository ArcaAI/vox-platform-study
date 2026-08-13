# TASK-616 Phase Program — Ticket Index

**Created**: 2026-08-08 · **Parent**: [TASK-616](./README.md)

TASK-616's §4 proposed a sub-ticket split (617–626) and reserved the number range. **None of
617–626 were ever created.** This index creates them, records what each inherits, and states the
dependency order. It supersedes the "Suggested sub-ticket split" table in [README §4](./README.md).

Shared conventions: [Agent Operating Contract](./agent-operating-contract.md).
Fresh evidence: [Live-state recheck 2026-08-08](./live-state-recheck-2026-08-08.md).

---

## 1. The ten tickets

| Ticket | Phase | Status | Depends on |
|---|---|---|---|
| [TASK-617](../TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/README.md) | 1 — `hope-v2-dev` correctness + GitOps recovery + live-incident triage | **Created 2026-08-08** | 616 |
| [TASK-618](../TASK-618-PHI-Security-Baseline/README.md) | 2 — PHI security baseline (k3s hardening, PSA, NetworkPolicy) | **Created 2026-08-08** | 617 |
| [TASK-619](../TASK-619-GitOps-CICD-Delivery-Loop/README.md) | 3 — GitOps CI/CD delivery loop | **Created 2026-08-08** | 617 |
| ~~TASK-620~~ | 4 — observability | **Never created; superseded by [TASK-636](../TASK-636-Observability-Coverage-And-Dependency-Monitoring/README.md)** | 617 |
| [TASK-621](../TASK-621-Supply-Chain-Integrity/README.md) | 5 — supply-chain integrity | **Created 2026-08-08** | 619 |
| [TASK-622](../TASK-622-Portability-Hygiene-And-Operations-Docs/README.md) | 6 — portability hygiene + operations docs | **Created 2026-08-08** | 617–621 |
| ~~TASK-623~~ | 7a — Vault HA | **Never created; the work was executed under TASK-616 itself** (Track V phase 1, commits `76e05dcb`/`3e85616d`/`79a89ffd`, merged to `dev-2.1`). Phase 2 of Track V — k8s auth, policies, injector, secret migration — is unstarted and is folded into **TASK-618 §2.4/2.5** | 616 |
| [TASK-624](../TASK-624-Qdrant-Deployment-And-Auth/README.md) | 7b — Qdrant deployment + auth code change | **Created 2026-08-08** | 617 |
| [TASK-625](../TASK-625-Harness-Temporal-Worker-And-Consolidation/README.md) | 7c — harness Temporal worker + Temporal consolidation | **Created 2026-08-08** | 617, 619 |
| [TASK-626](../TASK-626-Staging-Production-And-AWS-Portable-Structure/README.md) | 8 — staging + production environments + AWS-portable structure | **Created 2026-08-08** | 617–625 |

**Why 620 and 623 are not created.** 620's scope was re-scoped, re-verified against the live
cluster, and widened into TASK-636 on 2026-08-08 — creating 620 now would fork one register across
two tickets. 623's scope was executed inside the parent while the phase split was still a proposal;
its *remaining* half (the k3s-side cutover) has no meaning independent of the PSA/secrets work in
618, so it lives there rather than in a ticket that would duplicate 618's gates.

## 2. Dependency graph

```
                       ┌──────────────────────────────── TASK-636 (observability)
                       │
TASK-617 ──┬── TASK-618 (security baseline)
  (dev     │
 correct + ├── TASK-619 ──┬── TASK-621 (supply chain)
  GitOps   │  (CI/CD)     │
 recovery) │              └── TASK-625 (Temporal worker) ──┐
           │                                               │
           └── TASK-624 (Qdrant) ────────────────────────┐ │
                                                         │ │
                       TASK-622 (docs/portability) ◄─────┴─┴── TASK-626 (staging/prod/AWS)
```

TASK-617 is the sole root. Nothing downstream can be verified while GitOps cannot deliver
(LIVE-01/LIVE-02) — a change that cannot reach the cluster cannot be gated on live evidence, and
every ticket below has live-evidence gates.

## 3. What changed since the 2026-08-07 assessment

Three findings from the 2026-08-08 recheck reshape the program. Full detail in the
[recheck](./live-state-recheck-2026-08-08.md).

1. **The remediation was never delivered.** Four commits in `arca/hope-v2-deployment` — the probe
   fixes, GPU fixes, Argo manifests, the DB-05 fix, and the repo's first CI — are **unpushed**
   (`origin/main` is still `08d1651`). The assessment's Change History records them as done; they
   are authored, not shipped. TASK-617 opens on this.
2. **Argo CD has been failing to sync for 7 days** with a nil-pointer panic. The last successful
   deploy was 2026-08-01. Pushing the four commits into a crashing controller changes nothing, so
   the panic is diagnosed *before* the push, not after.
3. **The GPU plan's premise is wrong.** Phase 1 step 1.2 assumes "the cluster already exposes 8
   time-sliced slots". The node advertises **2**, and no time-slicing ConfigMap exists. Adding
   `nvidia.com/gpu: 1` to three workloads against two physical GPUs strands one of them `Pending`
   permanently. Time-slicing is configured first; requests follow. (Appendix B §B5 and Appendix G
   §G4.1 already say this — the Phase-1 table was never reconciled with them.)

## 4. Tier distribution across the program

Counted from the per-ticket task tables. Tier meanings in the
[Agent Operating Contract](./agent-operating-contract.md).

| Tier | Share | Where it clusters |
|---|---|---|
| `haiku-4-5` | ~13% | Doc-claim corrections, dead-file deletion, single-key manifest edits, registry cleanup policy |
| `sonnet-5` | ~60% | Manifest authoring, CI jobs, single-service code changes, runbooks |
| `opus-4-8` / `opus-5` | ~27% | PHI-safety design, blast-radius-wide policy (k3s hardening, NetworkPolicy), GitOps architecture, irreversible migration, the AWS boundary |

The `opus` allocations are deliberately not proportional to code volume. They track *consequence*:
a NetworkPolicy is a small file that can silently sever a clinical pipeline, and a secrets migration
is a short script that is irreversible.

## 5. Change history

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Index created. Eight tickets (617, 618, 619, 621, 622, 624, 625, 626) created; 620 and 623 explicitly not created, with reasons. Live recheck folded in as the program's opening constraint. | Claude |
