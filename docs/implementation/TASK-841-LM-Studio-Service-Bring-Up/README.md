# TASK-841 — LM Studio Service Bring-Up

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `infrastructure` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track A |
| **Tier / Effort** | `opus` / high |
| **Depends on** | TASK-839 ✅, TASK-842 ✅ |
| **Blocked by** | **Cluster ops + the external manifest repo**, and a manifest that does not yet exist must be authored. |

## 1. Requirement Analysis

"lmster" is LM Studio's own official headless daemon, **`llmster`**. Platform admin (never tenant admin) configures the server URL and the S3/MinIO bucket URI. OpenAI-compatible API with streaming. Per **TASK-799 D-6** LM Studio is already platform-managed, so the "tenant admin not allowed" requirement needs no new work.

**⚠ Risk Accepted (OD-1, 2026-09-01):** LM Studio's ToS (eff. 2026-08-23) forbid *"service bureau use… or software-as-a-service"* — which is what HOPE is. The owner elected to proceed and record the risk. **A standing item to revisit with counsel, not a closed question.**

## 2. Current State Evaluation

Program finding **F-3**, and three stale claims corrected: (1) TASK-824's "the image has never been built" is **stale** — jobs 15666/15667 succeeded in pipeline 1048; (2) the manifest's image path is not where CI publishes, with no overlay `images:` entry and a mutable tag; (3) the assumed out-of-band `hope-lmstudio` Service **does not exist in the namespace at all**. Also missing: PVC `hope-models-cache`, Secret `hope-models-reader`, the model-sync Job. `models.tsv` still reads `SET-AT-PUBLISH`. **`lmstudio-service-cutover.yaml` does not exist and must be authored.** Two runtime traps: the `full+cuda12` bundle **defaults to CPU** unless `lms runtime select` says otherwise, and LM Studio **returns 200 on every HTTP path**, so a naive probe reports healthy regardless of state.

## 3. Implementation Plan

The authoritative step-by-step plan is **[TASK-837 §4 → TASK-841 — LM Studio Service Bring-Up](../TASK-837-AI-Platform-Consolidation-Program/README.md)**,
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
