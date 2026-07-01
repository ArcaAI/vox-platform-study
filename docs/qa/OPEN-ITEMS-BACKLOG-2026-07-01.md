# Admin Console + Platform — Open Items Backlog (2026-07-01)

**Method:** Read-only reconciliation of `docs/admin-console-open-items-review.md` (§3a–§3e), every
`docs/implementation/TASK-3*/README.md`, `docs/qa/RUN-RESULTS-2026-07-01.md`, the QA traceability/
manual-test suites, and `TASK-387-…/ENTITLEMENTS-PROPOSAL.md`, against the TASK-386→393 work that
landed on the uncommitted working tree this session.

**Excluded (landed after this audit):** TASK-392 **Q7 rate-limit guard binding** and
**concurrency-based seat gating (C7)** — both implemented + verified (27/27 live E2E), enforcement OFF by default.

**Effort:** S ≤1d · M 2–4d · L ≥1wk.

---

## Recently closed this session (TASK-386–393)

| Cluster | Ticket | What landed | Residual |
|---|---|---|---|
| Platform runtime metrics (§3a #16–21, T1, #4/#5 usage) | **TASK-386** | Metrics/sockets/consumption/consultation-aggregate/tenant-usage endpoints, tenant-scoped telemetry, **TD3/DEF-1 fixed**, `TenantBucket.quotaBytes` | Prometheus-derived **values** (P95, req/min, per-model latency) are env-dependent → em-dash unless a `prometheus` profile runs |
| Tenant data model (§3a #1,2,3,6,7) | **TASK-387** | SUSPENDED/ARCHIVED+restore, tags, plan, dept→users listing, per-dept DNA slot; **FE wired**; SDK If-Match OCC fixed | `dnaWritingStylePromptId` is a loose ref (no FK/category enforcement) |
| Users backend (§3a #8–13) | **TASK-388** | reset-password, server bulk actions, xlsx/pdf export, admin-edit-other settings (SDK), per-user prompt scope, cross-user DNA | **FE wiring is an open follow-up** (see P0-1); bulk `assign-role` + export dept-name enrichment deferred |
| Agents backend (§3a #14,15) | **TASK-389** | server-side version diff endpoint, SDK test sub-metrics mapping | **FE wiring of the diff view is an open follow-up** (see P0-2) |
| Super-admin tier backend (§3a #22–25) | **TASK-390** | policy anti-lockout guard, api-key rotate (+owner-scope), global-settings CRUD, audit xlsx/pdf export | protected set is name-based |
| Super-admin tier FE | **TASK-391** | wired Roles/API-Keys/Settings/Audit; per-surface nav gating; D1/D2 fixed; **live FE E2E 42/0** | §7 Figma richness deferred (see P1) |
| Plan entitlements | **TASK-392** | full resolution→metering→enforcement→gates→SDK/FE; Q7 guard binding + C7 concurrency gating; **enforcement OFF by default** | matrix numbers unvalidated |
| Tenant-config DTO decouple | **TASK-393** | `TenantConfigDtoMapper`; removed fragile superset cast; `GlobalSettingResponse.locked` required | — |
| Verification (§3c) | RUN-RESULTS | Backend 85/86→green, FE 96/0/12; DEF-1 fixed; OCC 428 fixed | manual suites not hand-executed (automated coverage exists) |

**Net: every §3a backend item (#1–#25) is backend-closed.** Remaining leverage is FE wiring, doc
refresh, one security guard (R1), and product decisions to turn on entitlement enforcement.

---

## P0 — Highest leverage (ship value already paid for; correctness/security)

| Item | Source | Description | Effort | Depends on | Needs decision? | Recommendation |
|---|---|---|---|---|---|---|
| P0-1 Wire TASK-381 Users TARGETs to the TASK-388 backends | TASK-388 §5 "FE follow-up"; review §3a #8–13, §3d(381) | Build the FE for reset-password (temp + link), server-side bulk bar (enable/disable/delete/assign-depts), Excel/PDF export, admin-edit **another** user's preferences, per-user (`USER_PERSONAL`) prompts, cross-user DNA panels. All endpoints+SDK exist. | **L** | TASK-388 (done) | No | **Build.** This is the single biggest "backend done, UI TARGET" gap. |
| P0-2 Wire TASK-382 version-diff to the TASK-389 server diff | TASK-389 §6 note; review §3a #14; traceability AG8 | Repoint `features/agents/version-diff.tsx` / `diff-model.ts` at the server `…/diff/…` result (SDK already returns `DiffResult`); optionally surface the richer per-field breakdown. Sub-metrics (AG12) already consumed. | **S–M** | TASK-389 (done) | No | **Build.** Removes the last "client-side only" agent caveat. |
| P0-3 Route-level super-admin `beforeLoad` guard (R1) | TASK-383 §hdr (R1 OPEN); review §1(383) | `/dashboard` + `/system-health` (and the other `requireSuperAdmin` routes) have **only** nav-hide + API-403 — no route guard. Add a role-aware `beforeLoad` once router context carries roles. | **S** | router context exposing roles | No (impl detail) | **Build (defense-in-depth).** |
| P0-4 Refresh stale QA docs | review §3d; RUN-RESULTS (traceability/manual not edited) | `docs/qa/traceability/*` + `manual-tests/*` still show plan/tags/lifecycle/dept-users/DNA-slot/version-diff/sub-metrics/platform-metrics/policy-guard/key-rotate/global-settings/audit-export as 🔴/🎯/OPEN and V1/V2/F-NAV1/D10/TASK-380-status as open — all now landed. They mislead testers and understate completion. | **M** | 386–393 (done) | No | **Update** matrices + manual suites to the landed reality; flip TASK-380 header/status. |

---

## P1 — Strong leverage (unblock enforcement + finish the redesign richness)

| Item | Source | Description | Effort | Depends on | Needs decision? | Recommendation |
|---|---|---|---|---|---|---|
| P1-1 Validate entitlement matrix + enable enforcement per-env | ENTITLEMENTS-PROPOSAL Q2; TASK-392 §2/§6 | Enforcement ships **OFF**. Confirm §2 numbers (esp. ENTERPRISE ~100 **total** seats assumption, and the new C7 concurrency limits) then flip `entitlements.enabled` per-env. | **S** (config) + review | TASK-392 (done) | **Yes** (product numbers + go-live) | Ratify numbers, enable in a non-prod env first. |
| P1-2 Stand up Prometheus/Grafana in dev compose | TASK-386 §2.2/§5.1; review §3a #16/#19 | DB roll-ups are live, but P95 / req-min / per-model latency need a scrape source — dev compose has none, so those tiles em-dash. Add an opt-in `prometheus` profile. | **M** | TASK-386 (done) | No | Add profile so the metric **values** render in dev/demo. |
| P1-3 Roles & Policies richness (R3) | TASK-391 §7 (§5.1/24b) | SUBJECTS×ACTIONS **permission matrix**, master-detail **inheritance tree**, live **effective-abilities preview**. Kept today: tabs + CASL rule-builder + Protected affordance. | **L** | TASK-390 guard (done) | **Yes** (design approval) | Design → build. |
| P1-4 Sectioned Settings form + secret-reveal | TASK-391 §7 (§5.6) | Replace KV table with a sectioned form (Switch/Select/number) + gated `encryptedValue` reveal. Kept: namespace grouping + locked affordance. | **M** | TASK-390/391 (done) | Minor | Build after P0-4. |
| P1-5 API-Keys per-key rate-limit/env/IP-allowlist columns + create fields | TASK-391 §7 (§5.2) | Surface `rateLimit`/environment/IP-allowlist columns + create-dialog fields (data present). Rotate/scopes/masked-key already shipped. | **S–M** | TASK-390/391 (done) | No | Build. |
| P1-6 Server bulk `assign-role` action | TASK-388 decision #6 | Add the deferred bulk enum arm (single-user route already exists). | **S** | TASK-388 (done) | Minor | Add when P0-1's bulk bar lands. |
| P1-7 Export dept-name + email enrichment | TASK-388 deviation/flag | `UserResponse` lacks email/dept-**names**, so export columns render id-only. Add read-only enrichment (avoid N+1). | **S** | TASK-388 (done) | No | Enrich. |
| P1-8 Mobile full-screen dialogs long tail (D6) | TASK-384 §7 | Apply `MOBILE_DIALOG_CONTENT` + footer fragment to `agent-instruction-dialog`, `policy-form-dialog`, `AlertDialog` confirms, agent/role sheets; in-form inputs to 44px. | **S–M** | pattern ready | No | Apply pattern; clears RSP-04.7. |
| P1-9 Impersonation (T5) | TASK-384/371 | "Impersonate user" action + indigo `--ai` banner not built. | **M** | — | **Yes** (scope) | Decide scope, then build. |
| P1-10 Self-service "forgot password" (public) | TASK-388 decision #3 | Admin reset (returns link) exists; a **public** unauthenticated flow must NOT return the token (email-only). | **M** | TASK-388 mailer | **Yes** (email infra + policy) | Design with real MS-Graph delivery. |

---

## P2 — Lower leverage (polish, unbuilt legacy surfaces, hygiene, minor decisions)

| Item | Source | Description | Effort | Depends on | Needs decision? | Recommendation |
|---|---|---|---|---|---|---|
| P2-1 Deferred design polish | review §3e | Lucide icon swap, per-screen dark mode, real chart series (vs illustrative rects), tablet/mobile Figma frames across 371/379–384. | **L** (ongoing) | — | No | Dedicated design pass. |
| P2-2 Remaining unbuilt surfaces | review §3b | `01 · Components` library, **Rate Limits (14)**, **Queues & Jobs (15)**, **Prisma Studio (16)**, tenant-admin tail (Stores detail, Audio processing, Agent Jobs, Harness), Playground tier (50–59). | **L** | — | Some (scope/priority) | Schedule per demand. |
| P2-3 `apps/admin` Prettier one-shot pass | TASK-374 | ~4k–5.7k `prettier/prettier` + `exhaustive-deps` warnings (0 errors), project-wide. | **S** | — | No | Separate hygiene ticket. |
| P2-4 TASK-372 deferred hygiene | TASK-372 | `.js` dynamic-import specifiers, `@ts-expect-error` pdf-worker, off-barrel names, 2 `@deprecated` components; D10 wording. | **S** | — | No | Opportunistic. |
| P2-5 TASK-377 metrics follow-ups | TASK-377 | Migrate `system-health.tsx` onto `StatCard`/`ServiceStatusBar`; retire legacy `service-status-bar`; forward `Progress` value to Radix root. | **S–M** | — | No | Fold into P0-3/P0-4 work. |
| P2-6 TASK-375 residuals | TASK-375 | `getContextItemsPaginated` enrichment; enum-member + JSON-path validation; model-aware coercion for other list resources. | **S** each | — | No | Low priority. |
| P2-7 TASK-376 fixtures | TASK-376 | Recording-shaped audio fixture; parameterize media-test owner via env. | **S** | — | No | When timeline playback is tested. |
| P2-8 TASK-373 cursor mode | TASK-373 | Optionally migrate consultation/context-item history to cursor pagination (opt-in; offset acceptable). | **S** | — | No | Skip unless needed. |
| P2-9 `dnaWritingStylePromptId` hard FK + `DNA_ANALYSIS` category | TASK-387 flag #5 | Currently a loose `String?` ref (parity with siblings). | **S** | — | **Yes** | Only if product wants strict validation. |
| P2-10 Reset-token & password-policy hardening | TASK-388 flags #2,#5 | Stateless JWT reset token → optional revocable DB-backed table; min-length-8 → complexity/rotation policy. | **M** | — | **Yes** | Revisit for prod. |
| P2-11 Policy-guard fragility + break-glass | TASK-390 §3.1 | Protected set is **name-based** (rename risk); optional second-confirmation/break-glass flow. | **S** | — | **Yes** | Document deployment constraint. |
| P2-12 API-key rotate: immediate-invalidation option | TASK-390 §3.2 | 24 h grace is the only mode today; optional revoke-on-rotate flag. | **S** | — | **Yes** | Add if requested. |
| P2-13 Manual QA suite hand-execution | RUN-RESULTS §4 | Suites 01–09 not step-by-step run (covered by automated FE E2E + screenshots). | **M** | seeded stack | No | Optional formal sign-off. |

---

## Needs a product decision

1. **Entitlement matrix values + enforcement go-live** (P1-1) — ratify §2 numbers (incl. C7 concurrency) and per-env enable order.
2. **Self-service forgot-password** public flow + real email delivery (P1-10).
3. **Impersonation (T5)** scope — is it in the redesign MVP? (P1-9).
4. **Roles permission-matrix / effective-abilities UX** — design approval before build (P1-3).
5. **`dnaWritingStylePromptId`** — keep loose ref or add hard FK + `DNA_ANALYSIS` category enforcement (P2-9).
6. **Reset-token model** (stateless JWT vs revocable DB table) + **password complexity policy** (P2-10).
7. **Protected-policy** name-based guard + optional break-glass flow (P2-11).
8. **API-key rotation** — offer immediate-invalidation mode? (P2-12).
9. **Tenant-admin visibility** into clinicians' `USER_PERSONAL` prompt **content** vs metadata (TASK-388 flag #10).
10. **Bulk `assign-role`** inclusion in the bulk bar (P1-6).
