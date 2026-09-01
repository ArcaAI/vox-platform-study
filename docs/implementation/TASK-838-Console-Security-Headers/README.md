# TASK-838 — Console Security Headers

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `infrastructure` / `bugfix` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track A |
| **Tier / Effort** | `sonnet` / medium |
| **Opened / Completed** | 2026-09-01 |
| **Merge** | `c60c01c8a` (impl `a3659b8a2`) |

> **Process note.** This README was written RETROSPECTIVELY on 2026-09-01, after the work merged.
> That is a deviation from `01-development-workflow.md` Phase 3, which requires the ticket document
> to exist and be approved BEFORE code is written. Recorded here rather than quietly backdated.
> Root cause and the corrective action are in [TASK-837 §10](../TASK-837-AI-Platform-Consolidation-Program/README.md).

## 1. Requirement Analysis

Close a live security exposure: the admin console could be framed by any site. Finding **F-16(a)** of the
TASK-837 program.

Scope is deliberately narrow — framing control only. A full `script-src`/`style-src` CSP requires nonce
plumbing through the App Router render path and is a separate, larger effort; letting it in here would turn
a two-hour security fix into a week.

## 2. Current State Evaluation (pre-change)

Verified across `apps/admin-console/src`, `next.config.ts`, `deployment/`, and the gateway: **no
`Content-Security-Policy` and no `X-Frame-Options` were emitted anywhere.** `helmet` is not installed. The
console was framable by any origin.

Constraint discovered during evaluation: `apps/admin-console/src/features/db-studio/` renders a **same-origin
iframe** of `/api/hope/admin/pstudio`, proxied by the app's own route handler. `X-Frame-Options: DENY` or
`frame-ancestors 'none'` would have broken it — and would have pre-emptively broken TASK-851's embedded
consoles.

## 3. Implementation Plan (as executed)

1. Add an `async headers()` block to `next.config.ts` covering all routes (`source: '/:path*'`).
2. Use `frame-ancestors 'self'` — **not** `'none'`, **not** `X-Frame-Options: DENY`.
3. Add `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
4. Add `X-Frame-Options: SAMEORIGIN` as a legacy fallback — the exact behavioural analogue of `'self'`,
   so it cannot be stricter than the CSP directive nor break the db-studio embed.
5. Add a unit test pinning the header block's shape and exact values.
6. **Out of scope, deliberately:** the `TEMPORAL_DISABLE_WRITE_ACTIONS` half of F-16, which lives in the
   external `arca/hope-v2-deployment` manifest repository.

## 4. Implementation Summary

**Files changed**
- `apps/admin-console/next.config.ts` — the `headers()` block, with a comment explaining the `'self'` choice
  and its db-studio dependency.
- `apps/admin-console/src/__tests__/next-config.test.ts` — **new**, 5 cases.

**The shipped header set**
```
Content-Security-Policy: frame-ancestors 'self'
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

**Evidence** — build exit 0; lint clean at `--max-warnings 0`; **254 files / 2206 tests passed** at the time
of merge. Verified against a running production build with `curl`: `/login` (200), `/db-studio` (307 redirect
— proving `proxy.ts` middleware responses also carry the headers), and `/api/hope/admin/pstudio` (401) — the
literal iframe target — all four headers present on each.

**Not done, tracked elsewhere**
- `TEMPORAL_DISABLE_WRITE_ACTIONS=true` on `hope-temporal-ui` — external manifest repo, still OPEN.
- Recommended follow-ups not implemented: a nonce-based `script-src`/`style-src` CSP; `Permissions-Policy`;
  `Strict-Transport-Security`.

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Implemented, verified, merged as `c60c01c8a`. |
| 2026-09-01 | README written retrospectively; process deviation recorded above. |
