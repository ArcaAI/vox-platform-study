# TASK-840 — MLflow Service Bring-Up

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `infrastructure` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track A |
| **Tier / Effort** | `opus` / medium |
| **Depends on** | TASK-839 ✅ |
| **Blocked by** | **Cluster ops + the external `arca/hope-v2-deployment` repo.** Not startable from this monorepo alone. |

## 1. Requirement Analysis

Platform admin must manage the model registry, experiments and datasets through MLflow (**OD-6**: platform admin only). MLflow is the lowest-risk of the three zeroed services — no GPU, no PVC — and goes first. **OD-9** confirms the GPU/CUDA target for the vLLM side.

## 2. Current State Evaluation

Program findings **F-2**, **F-3**. `replicas: 0` in Git with written rationale; Argo applied it faithfully and reports it **Healthy**, because Argo reports a zero-replica Deployment as healthy. Prerequisites never created: the `mlflow` database, the MinIO service account, and the `MLFLOW_*` keys in `hope-secrets`. Image is real and digest-pinned. Service DNS exists; no Ingress. Platform runs MLflow **3.15.2** — which postdates Workspaces (3.10) and proxy-less presigned artifact transfer (3.15). Four defects in the prior research doc's manifest must be fixed before scaling: wrong image variant (needs `-full`), missing `--allowed-hosts` (silently 403s `/metrics`), missing `mlflow db upgrade`, ambiguous artifact flags. **PHI control:** MLflow 3 GenAI tracing captures full payloads by default.

## 3. Implementation Plan

The authoritative step-by-step plan is **[TASK-837 §4 → TASK-840 — MLflow Service Bring-Up](../TASK-837-AI-Platform-Consolidation-Program/README.md)**,
which carries the numbered steps, the traps, and the per-step evidence requirements. It is reproduced here by
reference rather than copied, so the two cannot drift while this ticket is unstarted.

**Expand this section into the full step list at the moment work starts**, per
`01-development-workflow.md` Phase 3 — and get owner approval before any code is written.

## 4. Verification Criteria

See TASK-837 §4 for this ticket's verification block. Program-wide gates in TASK-837 §3.5 apply regardless.

## 5. Implementation Summary

Not started.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket document created and aligned to TASK-837 §4. Not started. |
