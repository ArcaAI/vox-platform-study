# TASK-1025: Tenant bucket lifecycle gaps — silent provision failures, no cleanup on tenant delete, quota not enforced

**Status:** Pending
**Type:** bugfix
**Branch:** `dev-2.2`
**Related:** TASK-1024 (found while scoping), TASK-847 (`hope-platform` identity + tenant-bucket policy)

## Requirement Analysis

Owner request (2026-09-30): fix three gaps in how the two per-tenant buckets (`hope-attachments-<tenantKey>`, `hope-recordings-<tenantKey>`) are managed.

| # | Gap | Evidence |
|---|---|---|
| G1 | **Provisioning failures are hidden.** Physical create and bucket-policy errors are caught and logged as warnings, so a `TenantBucket` row can point at a bucket that does not exist, and later reads fail with `NoSuchBucket`. The seed step `05b` also warns and skips on any S3 error. Only the lazy `ensureProviderBucket` path repairs this. | `tenant.service.ts:156` (try/catch around `provisionSystemBuckets`), `tenant-bucket.service.ts:314-378` (~330-360 swallowed), `05b-tenant-bucket-provision.ts:72-74`, `minio-bootstrap.yaml` 326-331 (deployment repo) |
| G2 | **Deleting a tenant leaves its buckets and objects behind**, including PHI audio. `TenantService.deleteById` only soft-deletes the tenant row and broadcasts an event. | `tenant.service.ts:~712-722`; bucket delete path `tenant-bucket.service.ts:705-765` refuses SYSTEM buckets (403) |
| G3 | **The plan storage quota is not enforced.** `applyPlanStorageQuota` copies `storageQuotaBytes` onto the recordings bucket row as metadata only; MinIO has no quota on tenant buckets (the bootstrap quotas cover platform buckets only). | `tenant-bucket.service.ts:392-410`, `tenant.service.ts:~683` |

## Open Decisions (owner, before planning)

| # | Question |
|---|---|
| OD-1 (G1) | Should tenant creation **fail** (roll back) when the buckets cannot be created, or succeed with the tenant flagged `storage: degraded` plus a retrying repair job and a visible console status? |
| OD-2 (G2) | On tenant delete: purge immediately, or retain for N days (data-retention / legal hold for PHI) and then purge by a scheduled job? Should disable/suspend change bucket access? Should this be an explicit admin action with confirmation? |
| OD-3 (G3) | Enforce with a MinIO hard bucket quota (`mc quota set`, needs the admin credential — `hope-platform` cannot set it), and/or an application-side pre-upload check against usage? Which buckets does the plan quota cover (recordings only, or both)? |

## Current State Evaluation

Mapped on 2026-09-30 by a read-only discovery pass; line numbers marked `~` are approximate. Before planning, re-verify: `tenant-bucket.service.ts`, `tenant.service.ts`, `blob-storage.provider.factory.ts`, seeds `05a` / `05b`, and the deployment repo's `base/db-migrate.yaml` (whether it passes `MINIO_*` to the seed).

## Implementation Plan

_To be written after the OD round._

## Implementation Summary

_Not started._

## Change History

| Date | Change |
|---|---|
| 2026-09-30 | Ticket opened from the TASK-1024 scoping (gaps 1–3). |
