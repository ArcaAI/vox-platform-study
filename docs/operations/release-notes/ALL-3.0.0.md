# Release note — `ALL-3.0.0`

| | | | |
|---|---|---|---|
| **Train** | `ALL-3.0.0` (platform-wide) | **Date** | 2026-08-18 |
| **Status** | Draft — not yet tagged | **SDK family** | `@arcaai/*` 3.0.0 |

> **How to use this file.** Per [versioning.md](../versioning.md) §3, CI creates a DRAFT
> `ChangelogEntry` on an `ALL-` tag, pre-filled from `feat` + breaking-change commits, and a
> global admin edits it into plain language before publishing. **This file is the source text
> for that edit** — it is written for the person doing it, not for the machine. The tag is the
> version; nothing here is derived from a `package.json`.

Four changes are **breaking for integrators**; the rest are
internal hardening, seeds and tests.

---

## 1. Breaking — the admin plane no longer accepts API keys

`/api/v1/admin/*` is **JWT only**. 65 controllers / 386 handlers previously accepted a tenant
API key carrying an `admin:*` scope; they now return **403** to any key, including one holding
`'*'`.

All 56 `admin:*` scopes and the 3 `webhook:*` scopes are **reserved**, not deleted: they can no
longer be granted on `POST /admin/api-keys` and no longer appear in
`GET /admin/api-keys/scopes`. They remain as the vocabulary the service-account credential uses.

**Who is affected:** any integration driving an admin endpoint with an API key. The admin
console is unaffected — it has always used a session JWT through its BFF proxy.

**What to do:** move admin automation to a **service account** (below). There is no supported
API-key path to administration.

## 2. Breaking — business-plane URIs are normalized

Every retired path answers **308** with a `Location` header for one release, then becomes a 404
in `ALL-2.0.0`. 308 specifically: a 301/302 would let a client rewrite POST→GET and drop the body.

| Retired | New |
|---|---|
| `user/me/{preferences,settings,departments}` | `users/me/{…}` |
| `tenant`, `tenant/me/config` | `tenants/me`, `tenants/me/config` |
| `tenant/me/context-schema` | `tenants/me/context-schema` |
| `billing/me/{invoices,spend}` | `tenants/me/{invoices,spend}` |
| `usage/me/{summary,burndown}` | `tenants/me/usage-{summary,burndown}` |
| `entitlements/me` | `tenants/me/entitlements` |
| `voice-profile` | `voice-profiles` |
| `rbac/check{,/bulk,/my-permissions}` | `users/me/permission-checks`, `users/:id/permission-checks` |
| `ai/guardrail/analyze` | `safety-checks` |
| `ai/nlp/*` | `text-analyses/*` |
| `text/*` | `text-generations/*` |

**The two-alias split is the part to tell integrators.** `/users/me/**` is USER-scoped and
`/tenants/me/**` is TENANT-scoped. Under an API key, `users/me` resolves to the key's **bound
user** and `tenants/me` to the key's **tenant**. Folding both under one alias would have stated
something false about ownership.

`speech/*` is unchanged — its backing service is `apps/tts`, so it was already capability-shaped.
The frozen v1 compat surfaces (`api/smr/api/v1/*`, `api/stt/*`, `ws /stt`) are untouched and
remain out of scope for deprecation until their own ticket.

## 3. Breaking — downstream-unreachable now answers 503

A dependency that cannot be reached used to surface as **400** — and the body carried the
internal host and port (`connect ECONNREFUSED 127.0.0.1:8862`). Two changes:

| Cause | Was | Now |
|---|---|---|
| Transport failure (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNRESET`, DNS) | 400 or opaque 500 | **503** + `Retry-After` |
| Upstream returned 5xx | 400 or opaque 500 | **502** (deliberately no `Retry-After`) |

The split lets alerting separate "dependency down" from "dependency erroring" on status alone.
**No client-facing error body contains a host, port, IP, internal service name or stack any
more** — the operator still gets all of it in the log, keyed by the `correlationId` the client
already receives.

**What to do:** treat 503 as retryable with backoff and 502 as not. Clients that keyed off the
old 400 for downstream failure must change; a 400 now means what it says.

## 4. New — service accounts, and what they can reach

A third credential class, separate from user JWTs and tenant API keys:

- **Issued by a SUPER_ADMIN only**, with its own `svc:*` scope namespace and short-lived
  bearer tokens (two-slot rotation, revocation effective within one request).
- **Reaches the standalone features**: speech-to-text and summarization, on both the native
  and the v1-compat surfaces, via `svc:stt:transcription:write`, `svc:stt:stream:write`,
  `svc:consultation:report:write`.
- **Deny-by-default everywhere else.** A route that does not declare `@RequiredSvcScopes`
  refuses a service account, so nothing is reachable by accident.

**Two limits, stated plainly rather than implied away:**

- **The live STT WebSocket is not machine-drivable.** A service account can create a stream
  session but cannot drive it — stream ownership is bound to a human clinician (see §5), the
  handshake closes `4401`, and stream tickets require a user. Batch transcription and both
  summarization surfaces work.
- **The SDKs cannot send a service-account credential.** `@arcaai/vox-node` and
  `@arcaai/vox/compat` are API-key-only. Service-account access is raw HTTP today.
  **API-key standalone summarization through `@arcaai/vox-node` works and is unchanged.**

## 5. Security fixes

- **Same-tenant live-session hijack (`/ws/stt/stream`)** — any authenticated user in a tenant
  who learned another user's `sessionId` could mint a ticket and have the live audio and
  transcript stream transplanted onto their socket, orphaning the clinician silently. Stream
  bindings now carry an owner; a rebind whose ticket user is not the incumbent is refused.
- **API-key minting had no privilege ceiling** — a tenant admin could mint a key carrying
  `admin:*` or `'*'`. Minting now refuses any scope whose implied ability the caller does not
  itself hold.
- **CSWSH on the TTS gateway** — `/ws/tts/stream` had no `Origin` check at all. It now has the
  same fail-closed check as the STT gateway. Browsers exempt WebSockets from CORS entirely, so
  this is the one surface the HTTP CORS gate cannot cover.

## 6. Operational — a fresh deploy can now be logged into

`RUN_SEED="safe"`, the documented production bootstrap, produced **zero users** and there is no
registration route — a fresh deploy had no way in. Two env-driven, create-only bootstrap phases
now provision the first platform super-admin and the first tenant admin. Both no-op when unset,
hard-error when half-set, refuse well-known passwords, and never log the password.

A tenant-bound **service account is seeded for the ArcaAI tenant**. Its authority reconciles on
re-seed; its credential never does, so a rotated secret survives. Outside dev/test the seeded
verifier is inert by construction — 32 random bytes for which no preimage was ever generated —
and is replaced by one `rotate` call.

---

## Upgrade checklist

1. Move any admin automation off API keys onto a service account, or onto a human JWT.
2. Repoint retired URIs — the 308s buy you exactly one release.
3. Re-test error handling: downstream failure is 503/502, not 400.
4. Set `BOOTSTRAP_SUPER_ADMIN_*` and `BOOTSTRAP_TENANT_ADMIN_*` before first boot of a new
   environment, or you will have a configured platform with nobody who can sign in.
5. Rotate the seeded service account's secret in any non-dev environment before use.

## Known gaps carried into this release

- `voiceProfile` forwards the STT service's upstream `detail` verbatim — an upstream-response
  passthrough, not a transport leak, retained as a documented deliberate choice.
- A tenant admin cannot manage its own custom roles: `Role` and `Policy` have no `tenantId`
  column and CASL conditions run in shadow mode, so the grant cannot be constrained from a seed.
- Every seeded tenant has `plan = NULL` — unlimited quotas, but a cloud provider without a
  tenant key returns 403. Local engines are unaffected, so day-1 works.
- The `publish-sdk` CI job calls `changeset version` / `changeset publish`, but Changesets is
  not initialized (no `.changeset/`). SDK versions are hand-maintained until that is resolved.
