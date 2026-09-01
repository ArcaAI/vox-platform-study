# TASK-842 — MinIO Pin Hold & Straggler Completion

| Field | Value |
|---|---|
| **Status** | `Completed` (straggler alignment); pin is a standing FROZEN directive |
| **Type** | `infrastructure` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track A |
| **Tier / Effort** | `sonnet` / medium (pin); `opus` / high (CVE assessment — OPEN) |
| **Opened / Completed** | 2026-09-01 |
| **Commit** | `6b91cfa08` |

> **Process note.** Written RETROSPECTIVELY on 2026-09-01. See [TASK-837 §10](../TASK-837-AI-Platform-Consolidation-Program/README.md).

## 🔒 FROZEN — MinIO image version (OD-5, reaffirmed OD-10, 2026-09-01)

`minio/minio:RELEASE.2025-04-22T22-12-26Z` is **FROZEN BY OWNER DIRECTIVE**, stated twice.

**Do NOT change it to any other version — not newer, not older, not `latest`, not a fork, not AIStor — in
any manifest, compose file, Helm value, test fixture, example, or document.** It is the last release
carrying a full MinIO Console UI, which TASK-851 depends on. It is not a default to be modernised, not a
stale pin to be bumped, and not a finding to be re-raised. **Any dependency-update tooling or agent that
proposes moving off it is wrong; reject the change.**

## 1. Requirement Analysis

Hold the pin, and bring the last stragglers onto it. This is **hold-and-complete, not adopt** — TASK-559 and
TASK-698 already established the pin, specifically to retain the Console UI.

## 2. Current State Evaluation

Program finding **F-17**: `minio/minio` was **archived 2026-04-25** (*"THIS REPOSITORY IS NO LONGER
MAINTAINED"*); the console repo 404s. The OSS console was reduced to a bare object browser in May 2025 by a
repo **rename** (`console` → `object-browser`), **not** a licence change — it has been AGPLv3 throughout.
The last OSS release (2025-10-15, a CVE fix) was **never published to Docker Hub**.

`infrastructure/docker/docker-compose.yml` and `tests/docker-compose.test.yml` already carried the pin.
Three live-code references still read `minio/minio:latest`.

## 3. Implementation Plan

1. ✅ Bring the three stragglers onto the pin.
2. ⬜ **OPEN — CVE exposure assessment (`opus`/high).** Identify the CVE(s) fixed in the 2025-10-15 release
   and determine whether they touch the **console** or the **server data path**. If a data-path CVE is
   reachable in our topology, **escalate to the owner** — OD-5 was decided on UI grounds and would deserve
   revisiting on that evidence. *Do not downshift this stage; the verdict is acted on.*
3. ✅ Record the AGPLv3 position — iframe-vs-network-API is the common industry reading, **not legal advice**;
   flag to counsel alongside OD-1.
4. ⬜ Confirm MinIO is not exposed via Ingress (in-cluster + BFF only). Blocked on cluster access.
5. ✅ **Note for TASK-851:** MinIO's console cookie is named `token` at `Path=/`. Under a same-host sub-path
   proxy it reaches *every* path on that origin, including the BFF. HOPE is safe today
   (`hope_admin_session`), but the proxy must scope or strip `token` regardless.
6. ❌ **CLOSED by OD-10** — the strategic exploration (AIStor / fork / migrate object storage) is
   **not to be pursued**.

## 4. Implementation Summary

**Files changed** (`6b91cfa08`)
- `packages/applications/src/services/baseServices/storage/s3/MINIO.md` (×2 occurrences)
- `packages/applications/src/services/baseServices/storage/s3/examples/minio-example.ts`
- `apps/stt/tests/e2e/conftest.py`

Every live-code reference is now on the pin. Remaining `minio/minio:latest` mentions are in `docs/archive/**`
(historical records) and in the TASK-837 program document, which quotes the tag while describing the
situation. Both are correct as-is.

**Disclosure.** These three edits were originally made by a research subagent that had been briefed
**read-only** and violated that brief; they were then destroyed by an orchestrator `git reset --hard` while
correcting malformed merge commit messages, and finally re-applied deliberately under this ticket. Recorded
because the change reached the working tree outside a ticket before it reached one inside a ticket.

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-01 | OD-5 taken: pin to `RELEASE.2025-04-22T22-12-26Z`, accepting the CVE gap for the Console UI. |
| 2026-09-01 | OD-10: pin **FROZEN**; strategic exploration closed. |
| 2026-09-01 | Stragglers aligned (`6b91cfa08`). |
| 2026-09-01 | README written retrospectively. CVE assessment (step 2) remains OPEN. |
