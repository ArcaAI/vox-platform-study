# TASK-661 — Schema compatibility and lifecycle

- **Status:** Review
- **Type:** feature
- **Wave:** W2 of [TASK-654](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md), parallel with TASK-659 (agent configuration) and TASK-660 (loop event plane)
- **Depends on:** [TASK-658](../TASK-658-Consultation-Context-Schema/README.md) (Wave 1 — data model, validation, discovery)
- **Baseline:** `dev-2.1` @ `370a3672b` (docs(TASK-654): Wave 1 merged; add build-order and db:migrate contract notes)
- **Branch/worktree:** `worktree-agent-ad3b22aa2630b1eb5`
- **Spec:** [execution-plan.md § TASK-661](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/execution-plan.md)

---

## 1. Requirement Analysis

**Objective.** Once tenants can version a schema, the platform owns an API-versioning problem —
close it deliberately, the way Stripe/Notion version their APIs: pin the version a client built
against, validate against exactly that version, and let deprecation be a signal with a stated
window rather than a silent removal.

| # | Scope item (from the ticket) |
|---|---|
| S1 | Version pinning on writes — carry the schema version a client built against in a request header; validate the payload against **that** version, not whatever is current |
| S2 | Deprecation signalling — a kind can be marked deprecated with a stated migration window rather than deleted outright; surfaced in the discovery bundle |
| S3 | Superseded versions stay readable — a years-old `ContextItem` whose `contextSchemaVersionId` points at a superseded version must still be readable and renderable |
| S4 | **K7** — every existing consultation, with no schema configured and no `kindKey`, behaves exactly as it does today, end to end — as a **tested** contract, not an assumption |

### 1.1 Hard constraints honored

- No Prisma migration — everything is authored inside the existing `ConsultationContextSchemaVersion.definition` JSON document or computed at read-time; no new column, no `ALTER TABLE`.
- Did not touch `packages/agentic-sdk-v2/src/compat.ts`, `src/compat/**`, `apps/harness/.../workflows.py`.
- `apps/ui-playground` no longer exists — no references added.
- **Concurrency boundary with TASK-660**: TASK-660 owns the `LIVE_CONTEXT_TYPES` region (~line 64) of `context.service.ts`. My only edits to that file are inside the `resolveContextKind`/`addContext` region (~lines 220–285) — confirmed by `git diff --stat` and a manual diff read before committing; `LIVE_CONTEXT_TYPES` (line 65) is untouched.
- Cross-tenant access stays 404 — no change to that posture; `validateContextPayload`'s ownership checks are unmodified.

---

## 2. Current State Evaluation

Verified against `dev-2.1` @ `370a3672b` (TASK-658 merged).

### 2.1 What TASK-658 already delivered — do not rebuild

| Capability | Where | Verified behaviour |
|---|---|---|
| Change classification | `definition-diff.ts` → `classifyDefinitionChange` | `IDENTICAL` / `ADDITIVE` / `BREAKING`, conservative (anything unprovable is `BREAKING`) |
| Additive-only enforcement | `consultation-context-schema.service.ts#publish` | A `BREAKING` change is refused with 400 (naming every break) unless `allowBreakingChange: true` is passed. This **is** the ticket's "additive-only enforcement" requirement — conceptually Confluent's `BACKWARD` compatibility mode (a new schema version must still accept everything the old one accepted) |
| Explicit version pin, service layer | `validateContextPayload` | Already accepted `input.contextSchemaVersionId` and, when present, resolved that exact version via `loadVersionByIdOwned` instead of the tenant's current pin — **but nothing upstream of it ever supplied one on a NEW write.** `updateContext` passed the *item's own* stored `contextSchemaVersionId` (an edit re-validates against what the item was written with); `addContext` passed nothing |
| Discovery bundle | `getEffectiveBundle` | Returns the full `definition` JSON verbatim with a strong ETag; any field authored inside a kind (including a new `deprecated` block) is already surfaced with zero extra plumbing |
| Version history | `listVersions` / `ConsultationContextSchemaVersionRepository` | Immutable rows, never deleted on schema soft-delete — a superseded version was already retrievable by id; nothing enforced that it stays *validatable*, and nothing tested it |
| K7-shaped regression | `context.service.context-schema.task658.test.ts` | Already proves a no-`kindKey` write consults nothing — the exact regression K7 requires, but written as part of TASK-658's own AC-9, not framed as the cross-cutting programme gate, and predates the version-header mechanism this ticket adds |

### 2.2 What was actually missing (grep-confirmed, 2026-08-11)

- **No request header anywhere.** `apps/api/src/modules/consultation/consultation.controller.ts#addContext` took only `(id, request)` — there was no channel for a client to say "I built against version N."
- **`ContextService.addContext` never threaded a version through.** `resolveContextKind` already had a `contextSchemaVersionId` parameter (added for `updateContext`'s use), but `addContext` called it with only 3 arguments — the parameter was always `undefined` for a fresh write.
- **No `deprecated` vocabulary.** `KIND_KEYS` in `context-schema-definition.ts` rejected any key not in its closed list — authoring `deprecated: {...}` on a kind failed publish with "unknown key".
- **No compatibility judgement between a pinned-by-caller version and the current pin.** `classifyDefinitionChange` was only ever called from `publish` (comparing consecutive versions); nothing compared an *old, still-in-use* version against the *current* one to produce a caller-facing signal.
- **No test proving a superseded version stays validatable**, as opposed to merely fetchable by id.

---

## 3. Implementation Plan (as executed)

| # | Change | File(s) |
|---|---|---|
| 1 | `deprecated?: { since, migrateBy?, message? }` on `ContextKindDeclaration`; `deprecatedProblems` validator; wired into `kindProblems` | `context-schema-definition.ts` |
| 2 | `versionSkew` compatibility judgement on `ValidatedContextPayload`, computed via `classifyDefinitionChange` when an explicit `contextSchemaVersionId` differs from the tenant's current servable version | `IConsultationContextSchemaService.ts`, `consultation-context-schema.service.ts` |
| 3 | `X-Context-Schema-Version` request header on `POST :id/context`, threaded to `ContextService.addContext` as a new trailing optional parameter, then into `resolveContextKind` | `consultation.controller.ts`, `IContextService.ts`, `context.service.ts` |
| 4 | Log (not fail) when a write's `versionSkew` comes back `BREAKING` — visibility without changing what was validated | `context.service.ts` (inside the `addContext` region TASK-661 owns) |
| 5 | Tests — RED-then-GREEN for all of the above, plus explicit superseded-version-readable and K7 coverage | 3 new test files (below) |

### TDD list (RED first) — mapped to what actually drove code

| # | Test | Drove |
|---|---|---|
| 1 | A write carrying an old version header validates against that version, not the latest | Header threading (already-correct service behaviour, newly reachable) |
| 2 | A write with no version header behaves as today (back-compat) | Regression — passed immediately, locking existing behaviour |
| 3 | Adding an optional field does not require a bump; a rename still refuses without `allowBreakingChange` | Regression against TASK-658 (re-asserted, not re-implemented) — plus the NEW case: marking/un-marking a kind `deprecated` is always `ADDITIVE` |
| 4 | A superseded version is still readable | New — `listVersions` + `validateContextPayload` against a non-pinned version |
| 5 | A deprecated kind is flagged in the discovery bundle but still accepted during its window | New — `deprecated` authoring + validator; bundle surfacing proven via `findKind`/definition passthrough |
| 6 | **K7** — a tenant with no schema, and a context write with no `kindKey`, behaves identically to today | Written first in the new test file; extended TASK-658's K7 to also prove the NEW header parameter has zero effect when `kindKey` is absent |

---

## 4. Implementation Summary

**Status: Review.** All four scope items implemented and covered by tests; every gate green.

### 4.1 The header, and how skew is resolved

- **Header name:** `X-Context-Schema-Version` (Stripe/Notion-pattern — a version identifier on the request, not in the URL or body). Read via `@Headers('x-context-schema-version')` in `ConsultationController#addContext`, following the existing `@Headers('idempotency-key')` / `@Headers('x-internal-tenant-id')` house pattern (`stt-internal.controller.ts`, `harness-internal.controller.ts`).
- **Value:** a `ConsultationContextSchemaVersion` id — the same id the discovery bundle (`GET /tenant/me/context-schema`) returns as `contextSchemaVersionId`. A client reads it once at session open and pins it for the life of the session (TASK-665's job to wire client-side; this ticket only had to make the server side safe to call).
- **Resolution:** unchanged from TASK-658's `validateContextPayload` — when the header is present, `loadVersionByIdOwned` resolves **that exact version** (tenant-owned, 404-shaped `BadRequestException` — a caller-supplied id, not a route, so it's a 400 not a 404) and the payload validates against **its** `fields`, never the tenant's current pin. This is what makes an old client **safe**, not merely *detectable* as stale: the write either conforms to the version the client actually built against, or it is rejected — it is never silently upgraded to a newer, possibly incompatible, schema.
- **Skew signal (new, `versionSkew`):** when the header names a version that differs from the tenant's current servable (pinned) version, the service reuses `classifyDefinitionChange` — the **exact same classifier** `publish` uses — to compare the two definitions and returns `IDENTICAL` / `ADDITIVE` / `BREAKING` as `ValidatedContextPayload.versionSkew`. `ContextService.addContext` logs a structured warning when it comes back `BREAKING` (`reason: 'context_schema_version_skew'`). This is deliberately a **signal only**: it never changes `contextSchemaVersionId` (always the version the caller pinned) or rejects the write — the write already validated safely against the version it was pinned to; the log is for operability (a tenant admin/SRE can see a client population still on a version now incompatible with the latest, without that translating into failed clinical writes).
- **No header supplied:** `contextSchemaVersionId` flows through as `undefined` at every layer, and `validateContextPayload` falls back to `resolveServableVersion` (the tenant's current pin) — byte-identical to TASK-658's behaviour. `versionSkew` is `undefined` in this path — there is nothing to compare against.

### 4.2 Deprecation — representation and surfacing

- Authored **inside** the existing `definition` JSON document, not a new column: `kinds[].deprecated?: { since: string; migrateBy?: string; message?: string }` (`since`/`migrateBy` are `YYYY-MM-DD`; `message` ≤ 500 chars). Validated by a new `deprecatedProblems` in `context-schema-definition.ts`, wired into `kindProblems` exactly like every other per-kind field (unknown keys rejected, fail-closed).
- **Surfaced in discovery "for free."** `getEffectiveBundle` (TASK-658, unmodified) already returns the full `definition` verbatim with a strong ETag — a `deprecated` block on a kind is present in that JSON the moment it's authorable, no bundle/DTO change needed. Proven in `deprecation.task661.test.ts` via `findKind`, the exact seam a discovery-bundle reader (or the SDK codegen in TASK-668) would use.
- **Still accepted during its window.** `validateContextPayload` never reads `deprecated` — a deprecated kind validates exactly like any other kind. Deprecation is a stated intent for clients to react to (and, per `classifyDefinitionChange`, always classifies as `ADDITIVE` — marking or un-marking a kind deprecated changes nothing about the substrate old clients depend on: `primitive`, `phiClass`, `cardinality`, `fields`).
- No server-side enforcement of the window's end (no auto-rejection after `migrateBy`) — that's a deliberate scope boundary: this ticket makes deprecation *representable and visible*, not *enforced*. Enforcing a hard cutoff is a product decision (soft warning vs. hard block) that belongs to whichever ticket builds the client-facing warning UX (TASK-665/666) once it exists to react to.

### 4.3 A superseded version stays readable

- `listVersions` (TASK-658, unmodified) never deletes version rows on schema soft-delete — proven directly: publish v1 → v2 → v3, then confirm `listVersions` still returns v1 with its **original** `definition` byte-for-byte.
- `validateContextPayload` with an explicit `contextSchemaVersionId` naming v1 while the tenant is pinned to v3 validates a payload that is valid under v1 (`{ severity: 'mild' }`) but would be **rejected** under v3 (which renamed the field to `severityLevel`) — proving the write actually resolved against v1's `fields`, not merely that the id was fetchable.

### 4.4 K7 — the fallback contract, as a test

`context.service.context-schema.task661.test.ts`, first `describe` block, first test: a write naming no `kindKey` — **with the new version header present** — never calls `validateContextPayload`. This extends TASK-658's original K7 test (`context.service.context-schema.task658.test.ts`, still present, still passing, not modified) to the surface TASK-661 actually adds: proving the header itself is inert unless a `kindKey` is also present, so introducing version pinning cannot regress the one guarantee the whole programme depends on — every existing clinician, on every existing tenant, with no schema configured, sees no behavioural change.

### 4.5 Files changed

**Applications (`packages/applications/src/services/`)**

| File | Change |
|---|---|
| `consultation-context-schema/context-schema-definition.ts` | `KindDeprecation` type, `deprecated` on `ContextKindDeclaration`, `DEPRECATED_KEYS`, `ISO_DATE_PATTERN`, `deprecatedProblems`, wired into `kindProblems` |
| `consultation-context-schema/IConsultationContextSchemaService.ts` | `ValidatedContextPayload.versionSkew?: DefinitionChangeClassification` |
| `consultation-context-schema/consultation-context-schema.service.ts` | `validateContextPayload` computes `versionSkew` by reusing `classifyDefinitionChange` when an explicit version differs from the current pin |
| `consultation/context/IContextService.ts` | `addContext` gains trailing optional `contextSchemaVersionId` |
| `consultation/context/context.service.ts` | `addContext` accepts + threads `contextSchemaVersionId` into `resolveContextKind`; logs on `BREAKING` skew |
| `consultation-context-schema/__tests__/deprecation.task661.test.ts` | **NEW** — 10 tests |
| `consultation-context-schema/__tests__/version-pinning.task661.test.ts` | **NEW** — 6 tests |
| `consultation/context/__tests__/context.service.context-schema.task661.test.ts` | **NEW** — 7 tests |

**API (`apps/api/src/`)**

| File | Change |
|---|---|
| `modules/consultation/consultation.controller.ts` | `Headers` import, `ApiHeader` import; `addContext` reads `X-Context-Schema-Version` and forwards it |
| `modules/consultation/__tests__/consultation.controller.test.ts` | +2 tests — header threads through; no-header case passes `undefined` unchanged |

No `packages/database`, `packages/domains`, or Prisma changes — none were needed, and per the hard constraint none were made.

### 4.6 Decisions worth reviewing

| # | Decision | Reasoning |
|---|---|---|
| D-1 | `versionSkew` is a **log**, not a rejected write or a response field | The write already validated safely against the version the caller pinned — refusing it because a *different, unrelated* pin has since moved would break exactly the client this ticket is supposed to protect. A response-level surface (header/DTO field) is a reasonable follow-up but was not required by the TDD list and would touch `ContextItemResponse`, widening the diff beyond the owned validation-hook region. |
| D-2 | `deprecated` carries no server-enforced expiry | Deleting/blocking after `migrateBy` is a product decision (grace period? hard block? admin override?) with no client yet to react to it — TASK-666 (admin console schema editor) is the natural place to decide how a countdown is surfaced, and TASK-665 (SDK) for how a client warns. |
| D-3 | `updateContext` does **not** gain a header parameter | It already validates against the **item's own** `contextSchemaVersionId` (TASK-658) — that is correct: an edit to an existing item should stay pinned to whatever version the item was originally written against, never a header supplied on the PATCH call (which would let a caller silently re-point an existing item at a different schema version). This was verified as an explicit regression test, not merely left alone. |
| D-4 | `versionSkew` reuses `classifyDefinitionChange` directly rather than a second comparator | The ticket asks for "reusing definition-diff.ts for compatibility judgements" — a second implementation of compatibility logic is exactly the drift risk a single classifier is supposed to prevent. `publish` and `validateContextPayload` now share one source of truth for what counts as breaking. |

---

## 5. Verification Evidence

All commands run from the worktree at `dev-2.1` @ `370a3672b`, in the build order required by execution-plan §1.1b (`pnpm install` → `pnpm db:generate` → `@arcaai/database` build → `@arcaai/domains` build → `@arcaai/applications` build → tests; `@arcaai/exceptions`, `@arcaai/utils`, `@arcaai/types`, `@arcaai/logger` also built first as applications-layer prerequisites; `room`/`noise-filter`/`vad`/`stt`/`med-ner`/`pipeline`/`vox`/`ui` built before `pnpm test:unit`, per the same section).

### `pnpm --filter @arcaai/applications build`

```
> @arcaai/applications@0.0.1 build
> rimraf dist tsconfig.tsbuildinfo && tsc
(clean — no errors)
```

### `pnpm --filter @arcaai/applications test`

```
Test Files  462 passed | 1 skipped (463)
     Tests  8708 passed | 4 skipped (8712)
```

**Baseline comparison** (TASK-658, same worktree lineage): **459 files / 8,685 passed** → **462 / 8,708** (+3 files, +23 tests — exactly the 10 + 6 + 7 new tests in the three new files; every pre-existing test still passes unmodified).

### `pnpm api:build`

```
Tasks:    9 successful, 9 total
Time:     19.003s
```

Matches the baseline's 9/9.

### `pnpm test:unit` (whole monorepo)

```
Test Files  967 passed | 2 skipped (969)
     Tests  16477 passed | 4 skipped | 9 todo (16490)
packages/ui test:              Test Files  242 passed (242)   Tests   656 passed
packages/agentic-sdk-v2 test:  Test Files  255 passed (255)   Tests  4131 passed
apps/compat-playground test:   Test Files   21 passed  (21)   Tests   223 passed
apps/admin-console test:       Test Files  172 passed (172)   Tests  1339 passed
```

**Baseline comparison**: **964 files / 16,452 tests** → **967 / 16,477** (+3 files, +25 tests: the +23 in `@arcaai/applications` plus +2 in the new `apps/api` controller test cases). `ui` / `agentic-sdk-v2` / `compat-playground` / `admin-console` sub-suites are byte-identical to baseline — nothing outside the owned surface moved.

### `pnpm lint` (whole monorepo)

```
Tasks:    31 successful, 31 total
Time:     22.165s
```

Exit 0, no errors. `apps/api` reports **65 warnings** (all pre-existing `eslint-comments/require-description` on `eslint-disable` comments predating this ticket — matches the TASK-658 baseline of 65 exactly; a `prettier/prettier` quote-style error on the new `@ApiHeader` description was caught and auto-fixed with `prettier --write` before this run). `@arcaai/applications` reports 187 pre-existing warnings, none newly introduced — the targeted lint run below isolates the files this ticket touched:

```
$ eslint <7 files this ticket changed, incl. the 3 new test files>
✖ 11 problems (0 errors, 11 warnings)
```

8 of the 11 are the same 8 pre-existing `eslint-disable` warnings on `context.service.ts` TASK-658's own README already called out ("8 `eslint-disable` comments in that file... none were added"); the remaining 3 are "file ignored by pattern" notices on the 3 new test files (test files are outside this package's lint glob — matches how the existing `*.task658.test.ts` files are treated).

### AC → test map

| Scope item | Test | File |
|---|---|---|
| S1 (header → validate against THAT version) | "honours an explicitly supplied version pin over the schema default" (TASK-658, unmodified) + "passes the header value as `contextSchemaVersionId`..." | `consultation-context-schema.service.test.ts`, `context.service.context-schema.task661.test.ts` |
| S1 (no header = back-compat) | "with NO header, `contextSchemaVersionId` is undefined..." + controller "with no header, passes `undefined` through unchanged" | `context.service.context-schema.task661.test.ts`, `consultation.controller.test.ts` |
| S1 (versionSkew via definition-diff.ts) | "is ADDITIVE when..." / "is BREAKING when..." | `version-pinning.task661.test.ts` |
| S2 (deprecated authorable, ADDITIVE, discoverable) | 10 tests in `deprecation.task661.test.ts` |
| S3 (superseded version readable) | "listVersions still returns a superseded version..." / "a write pinned to the superseded version validates against it, not the current v3 pin" | `version-pinning.task661.test.ts` |
| S4 / K7 | "does not consult the schema service, header or not" (written first) + 6 siblings | `context.service.context-schema.task661.test.ts` |
| Regression (TASK-658 additive/breaking behaviour unchanged) | "marking a kind deprecated is ADDITIVE, never BREAKING" + all pre-existing `definition-diff.test.ts` / `consultation-context-schema.service.test.ts` tests, unmodified and still passing | `deprecation.task661.test.ts`, existing suites |

---

## 6. Incomplete / explicitly out of scope

- **No response-level surfacing of `versionSkew`** (e.g. a response header or `ContextItemResponse` field) — logged only (D-1). A follow-up ticket can decide the client-facing shape once TASK-665 has a client to consume it.
- **No hard enforcement of a deprecation window's end** — by design (D-2); a product decision for a later ticket.
- **No admin-console UI** for authoring `deprecated` or reading `versionSkew` logs — that is TASK-666/667's surface, unaffected here.

---

## Change History

- 2026-08-11 — Ticket opened from the TASK-654 execution-plan spec. Worktree reset to `dev-2.1` @ `370a3672b`. Read TASK-658's README and code in full before writing any test — confirmed the version-pinning *mechanism* (`validateContextPayload`'s explicit `contextSchemaVersionId` path) already existed but nothing supplied it on `addContext`; confirmed no deprecation vocabulary existed; confirmed no test proved a superseded version stays validatable.
- 2026-08-11 — RED-then-GREEN in three stages: (1) `deprecated` authoring + validation, (2) `versionSkew` compatibility judgement + superseded-version readability, (3) `X-Context-Schema-Version` header threading from controller → service → validation seam, plus the extended K7 regression. All gates green; status **Review**. Not merged, not pushed.
