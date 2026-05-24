# @arcaai/vox — Changelog

All notable changes to the `@arcaai/vox` SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added — TASK-302 Stream D (optimistic locking on config writes)

- `useGlobalSettings.get(id)` now captures the response `ETag` header
  into a module-level cache keyed by setting id (`AgenticClient.getWithEtag`).
- `useGlobalSettings.update(id, input)` replays the cached `ETag` as the
  `If-Match` request header (`AgenticClient.patchWithIfMatch`).
- `ConfigConflictError` (exported from `@arcaai/vox` and `@arcaai/vox/core`)
  is thrown when the server returns `412 Precondition Failed`. Carries
  `settingId` / `expectedVersion` / `currentVersion`. Callers can branch
  on `err instanceof ConfigConflictError` to surface a conflict modal.
- `AgenticClient.getWithEtag<T>(endpoint)` — public helper returning
  `{ body, etag }`.
- `AgenticClient.patchWithIfMatch<T>(endpoint, body, ifMatch)` — public
  helper that sets an `If-Match` request header.

### Server compatibility — **REQUIRED API version**

These features require the HOPE API to ship Phase D of TASK-302
(commits `cbf6da9`, `9b33725`, `2405d5a`):

- `ETag` header rendered by the global `ETagInterceptor` (D.1).
- `@RequiresIfMatch()` enforcement + `@ExpectedVersion()` parsing on
  mutating routes (D.2).
- The `PATCH /tenant/me/config` route applies `@RequiresIfMatch()` (D.3).

**Deploy ordering (R4):** API → SDK → UI. Shipping the SDK against an
older API will:

- Cause every `useGlobalSettings.get(id)` to silently fall back to
  bare GET (no `ETag` returned, no cache populated). The subsequent
  `update()` will throw `Error: No ETag cached for setting <id>…`.
- Cause every `PATCH` to a `@RequiresIfMatch()`-annotated route to
  return `428 Precondition Required` (the route requires `If-Match`
  but the client is sending it correctly — this is expected once the
  API rolls forward).

**Migration path for existing apps:**

1. After upgrading to this SDK, every `useGlobalSettings.update(id, input)`
   call MUST be preceded by a `useGlobalSettings.get(id)` so the SDK
   can capture the strong validator. The hook throws synchronously
   (with a clear error) if no validator is cached — no silent 428.
2. Wrap your save handler in `try / catch (err instanceof ConfigConflictError)`
   to surface a refresh-and-retry UX. The conflict modal stub at
   `apps/ui-playground/src/features/admin/configurations/conflict-modal.tsx`
   is a working reference.

---
