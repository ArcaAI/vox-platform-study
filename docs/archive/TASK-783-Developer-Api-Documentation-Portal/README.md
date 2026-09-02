# TASK-783 — Developer API Documentation Portal (admin-console)

| Field | Value |
|---|---|
| **Status** | Review — all five phases implemented; unit + e2e suites green; see Remaining Work for deliberately-deferred items |
| **Type** | feature |
| **Branch** | `wt/task-783` (to be created off `feat/loop`) |
| **Surface** | `apps/admin-console`, `apps/api` (spec metadata only), `packages/tools` (new enrichment generator), `.gitlab/ci/validate.yml` |
| **Opened** | 2026-08-20 |
| **Depends on** | [TASK-776](../TASK-776-API-Contract-Test-Suite/README.md) (`route-manifest.json` as the authorization oracle), [TASK-773](../TASK-773-Vox-Node-Admin-Plane-Access/README.md) (`openapi.json` emitted offline + drift-gated) |
| **Related** | [TASK-757](../TASK-757-Admin-Plane-Jwt-Only/README.md), [TASK-758](../TASK-758-Business-Plane-Auth-Model/README.md), [TASK-759](../TASK-759-Api-Plane-Taxonomy-Corrections/README.md) — the plane taxonomy this portal renders |

> **Ticket number**: `docs/implementation/` tops out at TASK-782, so this is TASK-783.
> `docs/archive/**` is off-limits this sprint and was not re-checked — confirm the number before work starts.

---

## Requirement Analysis

Expose the HOPE API's documentation **inside the admin console**, to two audiences that must be
served by the same pipeline but not the same view:

| Audience | Who | Needs |
|---|---|---|
| **Platform administrators** | super admins, tenant admins | the admin plane (`/api/v1/admin/**`, 409 routes) — what each screen calls, which ability/scope gates it, what a 403 vs 404 means |
| **Integrating developers** | tenant developers holding a granted permission | the business plane — API-key-reachable routes, auth setup, the `@arcaai/vox-node` SDK, error contract, streaming |

Both are **behind console authentication and an explicit permission**. Nothing about this portal is
public: no anonymous URL, no static asset served off the CDN, no spec in the client bundle for a user
who is not entitled to it.

### Why not just `/api/v1/docs`

The gateway's Swagger UI is `!isProduction` only (`apps/api/src/main.ts:113`) and is unauthenticated
where it exists. It is a developer convenience, not a product surface: no permission gate, no audience
split, no credential-class guidance, no version stamp, no guides. It stays as-is for local dev; this
ticket does not extend or productionise it.

### Non-goals

- A public developer portal on its own domain. (Possible later — the pipeline built here feeds it.)
- Rewriting DTOs to improve the spec. Spec quality gaps are **measured** below and fixed by a
  narrowly-scoped decorator sweep, not a refactor.
- Adopting Cache Components. This is a dynamic, gated surface (`13-nextjs-apps.md` §Caching).
- Publishing the spec to an external registry (Scalar Registry / Redocly / SwaggerHub) — for a
  multi-tenant PHI platform that is an owner decision, not a default.

---

## Current State Evaluation

Measured 2026-08-20 on `feat/loop`, against the committed artifacts.

### What already exists (and is good)

| Asset | State |
|---|---|
| `apps/api/openapi.json` | **Committed, emitted offline** by `pnpm api:openapi` (`src/scripts/emit-openapi.ts`) — no DB, no port bound, deep key-sorted for meaningful diffs. 455 paths / 586 operations / 494 schemas |
| `apps/api/route-manifest.json` | **Committed**, 657 routes, the authorization oracle: `isPublic`, `requiredPermissions`, `permissionMode`, `apiKeyForbidden`, `apiKeyScopes`, `svcScopes`, `forbidServiceAccount`, `requiresIfMatch`, `apiExcluded` |
| CI drift gate | `generate-vox-node-admin-check` already fails on any change to either artifact that is not reconciled (`.gitlab/ci/validate.yml:186`) |
| `build-info.json` | Every image carries service/version/releaseTag/gitCommitSha — the version stamp this portal must display |
| `@arcaai/vox-node` | 52 generated admin areas + the business-plane resources — the SDK the docs must reference |

**This is most of the hard part already done.** The spec is a reproducible build artifact joined to a
machine-readable authorization oracle. What is missing is presentation, gating, and metadata quality.

### Measured gaps

```
$ node -e "…join openapi.json × route-manifest.json…"
ops: 586   operationId: 586   summary: 585   tagged: 586
description: 173        (30% — 413 operations have a one-line summary and nothing else)
with a 4xx response: 294 (50% — half the operations document no failure mode at all)
security declared: 569  (17 operations declare no security scheme)
distinct tags: 87       (top-level `tags` array is EMPTY — no descriptions, no ordering, no grouping)
in manifest but NOT in spec: 71
```

Five concrete defects:

1. **`info` is a placeholder.** `swagger.config.ts` hardcodes `title: 'Api'`,
   `description: 'Main api backend'`, `version: '1.0'`. The version is not the release tag —
   the exact failure mode `09-infrastructure-devops.md` §Release Versioning already calls out for
   `health.controller.ts`.
2. **Tag naming is not one taxonomy.** 87 tags mixing `admin-ai-models` (kebab) with
   `Admin: AI Runtime Profiles` (title case) and `Admin: AI Provider Connections (legacy alias)`.
   With no top-level `tags` array, every renderer sorts them alphabetically and inconsistently.
3. ~~**71 routes exist but are undocumented**~~ — **CORRECTED during implementation. This
   reading was wrong, and the reason it was wrong is itself the defect.**

   `route-manifest.json` reported `apiExcluded: false` for all 657 routes, so the 71 routes
   absent from `openapi.json` looked like missing Swagger metadata. They were not. **The
   manifest's `apiExcluded` flag was broken**: `emit-route-manifest.ts` read
   `@nestjs/swagger`'s exclusion metadata with `=== true`, but neither decorator stores a
   boolean — `@ApiExcludeEndpoint()` stores `{ disable: true }` and `@ApiExcludeController()`
   stores `[true]` (both go through that package's `decorators/helpers.ts`). The comparison was
   therefore always false.

   With the reader fixed, 70 of the 71 are deliberate `@ApiExclude*` exclusions (every
   `*RedirectShimController` from TASK-760, every `/internal/*` controller). **The 71st was
   real, and of a different kind**: `openapi.json` was one commit stale — TASK-733 added
   `DELETE /admin/dna-writing-styles/doctor/{doctorId}` and only the manifest was re-emitted.
   Regenerating the spec surfaced genuine drift in `@arcaai/vox-node`'s generated admin surface
   (`dna-writing-style.ts`, `schemas.ts`, `admin-namespace.ts`, `workflow-definition.ts`) that
   the existing `generate-vox-node-admin-check` gate had never seen, because it compares the
   generator's output against two artifacts that were themselves out of step.

   So the real finding is **two documentation gates that could not fire**: `apiExcluded`
   distinguishes "deliberately hidden" from "undocumented", and its own comment in
   `emit-route-manifest.ts` says it is *"load-bearing for the cross-check"* — but no cross-check
   existed, and the flag it depended on had never worked. Both are now fixed and gated.
4. **The credential model is invisible in the spec.** `apiKeyForbidden: true` on 444 routes,
   `apiKeyScopes`/`svcScopes` per route, `requiresIfMatch` on 60 — all of it lives only in the
   manifest. The single most support-expensive question ("why does my API key get a 403 here?")
   is answered by data we already have and do not render.
5. **No 428/412/404-over-403 documentation.** The house OCC pattern and the tenancy posture are
   documented in rules and nowhere in the spec.

### What does not exist at all

- No docs route in `apps/admin-console` (52 features, none of them documentation).
- No ability/subject for documentation access in the RBAC model.
- No spec-linting gate (no Spectral, no Redocly CLI).
- No guides, no changelog-for-developers, no SDK reference site. (`/changelog` and `/releases`
  exist but are *platform* changelogs for admins, not API-contract changelogs.)

---

## Best-Practice Standard Adopted (the rules this ticket institutes)

1. **The spec is the artifact; the portal is a renderer.** No prose lives in the portal that could
   live in the spec. Both audience views are *derived* — never hand-maintained.
2. **The authorization oracle is joined into the spec, not re-typed.** `route-manifest.json` ×
   `openapi.json` → enriched spec. One source, mechanically merged, drift-gated.
3. **Two derived views, one pipeline.** `openapi.admin.json` and `openapi.business.json` are filtered
   projections. A route cannot appear in the business view unless the manifest says an API key can
   reach it.
4. **Version: contract vs build, kept separate.** `info.version` is the CONTRACT version and is a
   constant — `openapi.json` is committed and drift-gated, so a value derived from the release tag,
   git, or the environment would differ per machine and fail the gate on a clean tree. (It is also
   the correct reading of OpenAPI's `info.version`: it describes the *document*, not the
   deployment.) The BUILD identity is a property of the running image and is read from it — the
   portal footer shows the gateway's own `GET /health` version. Developers must be able to see
   which deployment they are reading, without making a reproducible artifact irreproducible.
5. **Every operation documents its failure modes**, and the four house-wide ones (428, 412, 409 quota,
   404-over-403) are injected globally rather than re-declared per route.
6. **Docs are gated exactly like data.** Session cookie + CASL ability, checked server-side, spec
   served from a server-only route handler. Never a public file.
7. **No live "Try it" against production.** See Decision D-3.
8. **No PHI, no real tenant ids, no real keys in examples** — ever, including in generated examples.
9. **Docs are part of the definition of done.** A new route without a summary, a description, a 4xx
   response and a tag from the approved taxonomy fails CI.
10. **Deprecation is written down**: `deprecated: true` + `Deprecation`/`Sunset` headers + the
    replacement named in the description + a minimum two-release notice.

---

## Tooling Decision (latest options, evaluated 2026-08-20)

| Tool | Fit | Verdict |
|---|---|---|
| **Scalar** (`@scalar/api-reference-react`) | Modern OpenAPI 3.1 renderer, built-in client, dark mode, CSS-variable theming mappable to Tailwind tokens. Actively released (react wrapper 0.9.x, weekly). No free-form MDX pages. | **Recommended** for the reference view |
| **Redoc** (`redoc`) | Mature, read-only, excellent three-pane reference, no client. Heavier React footprint, dated look. | Fallback if Scalar's CSS bleed is unacceptable |
| **Zudoku** | OpenAPI **plus** free-form MDX in the OSS tier — the only one that does both free. But it is a *site framework*: it wants to own routing and the shell. | Rejected for an embedded console surface; reconsider for a future standalone portal |
| **Fumadocs** | Excellent Next.js docs framework, `fumadocs-openapi` renders specs. Also wants to own the app shell. | Rejected for the same reason |
| **Swagger UI** | Already at `/api/v1/docs`, dev-only. | Keep for local dev; not the product surface |
| **Redocly CLI / Spectral** | Spec **linting and governance**, not rendering. | **Adopt** — `redocly lint` in CI is the gate that keeps rule 9 honest |

**Known risk with Scalar in React**: the wrapper is a Vue app mounted into React; there are open
upstream issues about theme regressions (scalar/scalar #2392, #3388) and its stylesheet is global.
Mitigation is Decision D-2.

---

## Decisions (RESOLVED — owner, 2026-08-20)

| Id | Decision |
|---|---|
| **D-1** | **(a)** New CASL subject `ApiDocumentation` |
| **D-2** | **(a)** Embed Scalar natively (`@scalar/api-reference-react`), no iframe |
| **D-3** | **(a)** "Try it" client OFF — read-only reference |
| **D-4** | **Approved to proceed WITHOUT Figma frames.** Explicit owner waiver of the `12-design-workflow.md` design gate for this ticket; screens follow `ScreenTemplate` + tokens + a11y gates instead |

Rationale captured below as originally written.

### Original options as presented

### D-1 — Who may read the docs?

| Option | Meaning |
|---|---|
| **(a) New CASL subject `ApiDocumentation`** *(recommended)* | `read:ApiDocumentation` for the business view; `manage:all` (super admin) additionally unlocks the admin view. Grantable per role, per tenant — matches "developers with granted access permissions" literally |
| (b) Reuse `manage:all` | Super-admin only. Simplest, but tenant developers cannot be granted access — which is the stated requirement |
| (c) Reuse `manage:ApiKey` | "If you can mint a key you can read the docs". Cheap, but conflates two different privileges |

Recommendation **(a)**. It needs a `ResourceType`/subject addition and a seed role update, both small.

### D-2 — How is the reference embedded?

| Option | Trade-off |
|---|---|
| **(a) `@scalar/api-reference-react` in a client leaf** *(recommended)* | Native routing, deep links, keyboard/a11y intact, `next-themes` drives dark mode. Risk: global Scalar CSS in the console bundle — must be scoped to the docs route segment and audited for bleed |
| (b) `@scalar/nextjs-api-reference` route handler in an `<iframe>` | Total CSS isolation, zero bleed risk. Costs deep-linking, focus management, and an a11y exception — a WCAG 2.2 AA gate this repo enforces per screen |

Recommendation **(a)** with a hard verification step (Phase 4 step 8) and (b) as the documented
fallback if bleed cannot be contained.

### D-3 — Is "Try it" enabled?

Scalar ships a live API client. In a console where the operator is authenticated as a real admin
against a real tenant, that is a button that fires real mutations against production data.

| Option | |
|---|---|
| **(a) Client hidden entirely** *(recommended for v1)* | Docs are read-only. `servers` lists the gateway URL for reference; requests are copy-paste curl/SDK snippets |
| (b) Client enabled, `servers` restricted to a sandbox/dev host | Useful, but requires a sandbox tenant with synthetic data to exist first |
| (c) Client enabled against the live gateway | **Not recommended.** PHI platform, destructive verbs, no undo |

Recommendation **(a)** for v1, **(b)** as a follow-up once a sandbox tenant exists.

### D-4 — Design gate

`12-design-workflow.md` is a **hard gate**: no screen is implemented before its Figma frame is
approved. This portal is a tier **20–29** (shared audience) screen and needs a frame number allocated
in the live `HOPE-Admin-Console` file — the capabilities matrix is a 2026-07-04 snapshot and its
numbers are the floor, not the ceiling. **Phases 1–3 below are non-visual and are not gated by this**;
Phase 4 (the screens) is.

---

## Implementation Plan

Five phases. Phases 1–3 are non-visual and can start immediately; Phase 4 waits on D-4.

### Phase 1 — Spec metadata quality (`apps/api`)

Fixes the five measured defects at the source, so every consumer benefits (portal, `vox-node`
codegen, future public portal).

1. **`swagger.config.ts`**: real `title`, `description`, `contact`, `license`; `version` from
   `RELEASE_TAG`/`build-info.json` falling back to the untagged `0.0.0-<branch>.<sha8>` grammar
   (`packages/utils/src/version-grammar.ts`). Add `addServer()` entries. Add the
   `service-account` security scheme (`X-Service-Account-Token`) — currently only `bearer` and
   `api-key` are registered, so the third credential class renders as no scheme at all.
   → extend the existing `swagger.config` unit test.
2. **Tag taxonomy**: one canonical list in a new `apps/api/src/openapi/tags.ts` — `{ name,
   description, x-displayName, x-plane }` per tag, wired via `.addTag()` so the top-level `tags`
   array is populated and ordered. Rename the 3 title-case outliers to the kebab convention.
   → a unit test asserts every operation tag appears in the canonical list (fails on a new
   undeclared tag).
3. **Global responses**: register 401/403/404/409/412/428/429 component responses once and reference
   them, rather than 586 hand-declared copies. Document the 404-over-403 posture in
   `info.description` and on the 404 component.
4. **Close the 71-route gap**: for each, either add the missing `@ApiOperation`/`@ApiResponse`
   metadata or mark it `@ApiExcludeEndpoint()` with a reason comment. → new gate in step 5.
5. **New CI gate `openapi-coverage-check`**: joins `openapi.json` × `route-manifest.json` and fails
   when a manifest route is neither in the spec nor `apiExcluded`. This is the gate that makes
   "the docs are complete" a fact instead of a hope.

**Verify**: `pnpm api:openapi` → coverage gate green; `pnpm --filter @arcaai/api test`.

### Phase 2 — Enrichment + audience projections (`packages/tools`)

New generator `pnpm gen:api-portal` (script `packages/tools/src/gen-api-portal.ts`), same shape as the
existing `gen:*` family: reads two committed JSON artifacts, writes committed JSON, idempotent, no DB.

Per operation, join the manifest row and inject vendor extensions:

| Extension | From |
|---|---|
| `x-hope-plane` | `admin` \| `business` \| `internal` \| `public` — derived from path + `apiKeyForbidden` |
| `x-hope-credentials` | which of the four classes may call it (JWT super / JWT tenant / API key / service account) |
| `x-hope-api-key-scopes`, `x-hope-svc-scopes` | verbatim from the manifest |
| `x-hope-abilities` | `requiredPermissions` + `permissionMode` |
| `x-hope-occ` | `requiresIfMatch` → renders the 428/412 note |

Outputs (all committed):

- `apps/api/openapi.enriched.json` — everything, admin view
- `apps/api/openapi.business.json` — only operations an API key or service account can reach

Plus `pnpm gen:api-portal:check` and CI gate `generate-api-portal-check`, mirroring
`generate-vox-node-admin-check`.

**Verify**: generator is byte-idempotent on a clean tree; check-mode fails on a hand-edit.

### Phase 3 — Spec governance gate

6. Add `redocly` (or `@stoplight/spectral-cli`) as a root devDependency with a HOPE ruleset:
   `operation-summary`, `operation-description`, `operation-4xx-response`, `operation-operationId`,
   `tag-description`, `no-server-example.com`, plus a custom rule banning UUIDs matching the reserved
   tenant prefixes (`00000000-`, `50000000-`) and any `@` e-mail literal in examples.
7. Root script `pnpm api:lint:spec`; CI job `lint-openapi` in `validate.yml`.
   Start at `warn` severity for `operation-description` (413 operations would fail on day one),
   with an owner-agreed ratchet — **not** a silent exclusion.

**Verify**: `pnpm api:lint:spec` output pasted into the Implementation Summary; error-severity rules at zero.

### Phase 4 — The console surface (`apps/admin-console`) — gated on D-4

8. Route `(console)/(shared)/developer/` — tier 20–29, per `13-nextjs-apps.md`:
   - `page.tsx` — **Overview**: what the API is, the four credential classes, first successful call in
     five minutes (curl + `@arcaai/vox-node`), link to `/api-keys` to mint a key, error-contract table,
     version stamp from `build-info.json`.
   - `reference/page.tsx` — the Scalar reference (`contentMode="fill"`, client leaf, D-2 option a).
   - `sdk/page.tsx` — `@arcaai/vox-node` install/auth/first-call, admin-plane vs business-plane
     reachability, link to the generated area list.
   - `changelog/page.tsx` — API-contract changelog (distinct from the platform `/changelog`).
   - `loading.tsx` per segment with `<Skeleton>`; `error.tsx` per segment.
9. Spec delivery: `src/app/api/docs/spec/[plane]/route.ts` — `server-only`, reads the session, asserts
   the D-1 ability, returns `openapi.enriched.json` or `openapi.business.json`. A user without
   `manage:all` can never receive the admin projection. Emits a `ResourceViewed` sys-event so access
   is audited like every other read.
10. Nav: one `/developer` entry in `nav-config.ts`, tier `20-29`, `required: [['read','ApiDocumentation']]`,
    plus a "API reference" link from `/api-keys`.
11. RBAC: add the `ApiDocumentation` subject, grant `read` to the tenant-admin and developer seed
    roles, `manage` to super admin (`packages/database/src/prisma/db_main/seed/`). Add to
    `ResourceType` in **both** `audit.prisma` (+ `ADD VALUE` migration) and
    `packages/domains/src/enums/generated/ResourceType.ts` — the TASK-366 failure mode.
12. Every page composes `ScreenTemplate` + `StatusFooter` (`11-ux-ui-principles.md` §1). Semantic
    tokens only; no hardcoded colors; Scalar's CSS variables mapped to the "Calm Clinical Teal" tokens.

**Verify**: `pnpm --filter @arcaai/admin-console build lint test`; runtime pass via the `next-dev-loop`
skill; both themes; axe scan 0 violations per screen; a negative test proving a session without the
ability gets 403 from the spec route and no nav entry.

### Phase 5 — Documentation & closure

13. `apps/api/docs/05-api-reference.md` updated to point at the portal and describe the pipeline.
14. New `docs/operations/api-documentation.md`: how to add a route so it documents itself, the tag
    taxonomy, the deprecation policy, how to regenerate everything.
15. `.claude/rules/05-nestjs-api.md` §Definition of Done gains the two new gates
    (`openapi-coverage-check`, `generate-api-portal-check`) and the doc-metadata requirement.
16. This README's Implementation Summary + Change History completed with pasted evidence.

---

## Implementation Summary

All five phases are implemented and verified. Phase 3 was delivered as a ratchet inside the
existing coverage gate rather than as a Redocly/Spectral adoption — the measurement behind that
deviation is below. Four items are deliberately deferred; see *Remaining Work*.

### Phase 1 — spec metadata quality (`apps/api`)

| File | Change |
|---|---|
| `src/openapi/api-exclude-metadata.ts` | **NEW.** Correct readers for `@ApiExcludeController()` / `@ApiExcludeEndpoint()`, mirroring `@nestjs/swagger`'s own explorers. Fixes the always-false `=== true` comparison described in Current State #3 |
| `src/openapi/__tests__/api-exclude-metadata.test.ts` | **NEW.** 8 tests applying the REAL decorators, so an upstream key or shape change fails here rather than silently reporting "nothing is excluded" |
| `src/scripts/emit-route-manifest.ts` | Uses the new readers. `apiExcluded` went from `0/657` to `70/657` |
| `src/openapi/tags.ts` | **NEW.** Canonical taxonomy: 88 tags, each with a description, display name, and plane (`business` / `admin` / `platform`), ordered by plane — the order a renderer uses for its sidebar |
| `src/openapi/__tests__/tags.test.ts` | **NEW.** 7 tests. Scans controller SOURCES for `@ApiTags(...)` and fails on any undeclared tag, so a new group cannot ship without a description |
| `src/swagger.config.ts` | Real title/description (planes, error contract, OCC); third security scheme (`service-account`, pinned to `SERVICE_ACCOUNT_TOKEN_HEADER`); populates the previously-empty top-level `tags` array |
| 8 controllers | Tag renames only: `Admin: Settings Catalog` → `admin-settings-catalog`, `RBAC - Roles` → `admin-rbac-roles`, and 6 more, into one kebab-case taxonomy |
| `scripts/check-openapi-coverage.ts` + `__tests__` | **NEW.** The cross-check gate. 7 tests proving it goes RED on both failure modes |

`Prometheus` is deliberately left as-is: it comes from the vendored
`@willsoto/nestjs-prometheus` controller, which we do not own and cannot re-tag at the source.
Declaring it verbatim keeps the closed-set test honest rather than uniform-looking.

**`contact` and `license` are deliberately NOT set.** The values that previously appeared
(`support@arcaai.com`, `https://arcaai.com/license`) existed only inside the vacuous test
described below and are referenced nowhere else in the repo. A developer-facing document
publishes whatever goes there, and a support channel that does not answer is worse than none.
**This needs real values from the owner.**

`src/__tests__/swagger-config.test.ts` was **deleted**. It constructed its own inline
`new DocumentBuilder()` and asserted on that — it exercised `@nestjs/swagger`, never
`buildSwaggerConfig`, so every assertion passed regardless of what this repo configured. It is
replaced by 11 real assertions in `swagger.config.test.ts`.

### Phase 2 — enrichment + audience projections

`scripts/gen-api-portal.ts` (+ 23 tests) joins `openapi.json` × `route-manifest.json` and emits
two committed projections into the console's server bundle:

| Output | Operations |
|---|---|
| `openapi.admin.json` | 587 — every documented route |
| `openapi.business.json` | 178 — only what a tenant credential can reach |

Each operation gains `x-hope-plane`, `x-hope-credentials`, `x-hope-api-key-scopes`,
`x-hope-service-account-scopes`, `x-hope-abilities`, `x-hope-permission-mode`,
`x-hope-requires-if-match`, plus a rendered prose note. Membership in the business projection is
derived from `apiKeyForbidden` / `apiKeyScopes` / `svcScopes` — never a hand-maintained list.
Two guard rules are encoded literally and tested: `@ForbidApiKey()` is unconditional (a broad
scope does not help), and **no declared scope means DENY**, not "unknown".

> **Deviation from the plan**: the generator lives in `scripts/` beside
> `check-openapi-coverage.ts` rather than in `packages/tools`. The `gen:*` family there is the
> Prisma-domain generator set and routes through `gen-guard.sh`; this reads two committed JSONs
> and writes JSON, which is the `vox-node-codegen` shape, not that one. Scripts are
> `pnpm api:portal` / `api:portal:check`.

### Phase 4 — the console surface

| File | Purpose |
|---|---|
| `src/server/api-docs/index.ts` | Server-only gate. Fetches the caller's CASL rules from the gateway (the session cookie carries tokens, not abilities) and **fails closed** on any error |
| `src/app/api/docs/spec/[plane]/route.ts` | Serves one projection to an entitled caller; uniform 403 so an under-privileged caller cannot probe which projections exist |
| `(console)/(shared)/developer/{layout,page,loading}.tsx` | `notFound()` gate + overview screen, matching the tier-10–19 existence-hiding posture |
| `.../developer/reference/{page,loading}.tsx` | The Scalar reference, `contentMode="fill"` |
| `.../developer/sdk/page.tsx` | `@arcaai/vox-node` vs `@arcaai/vox`, per credential class |
| `features/developer-docs/**` | 5 components + the gateway-version hook + 10 tests (incl. 2 axe scans) |
| `seed/01-policy.ts`, `seed/03-role.ts` | New GLOBAL policy `api-documentation-read` on the `PrismaStudio` precedent; granted to `TENANT_ADMIN` and `DOCTOR` (which already holds `api-key-own-manage`) |
| `shared/navigation/nav-config.ts` | `/developer`, tier 20-29, `read:ApiDocumentation` |

**Three outbound affordances in Scalar were disabled after seeing them render.** Its developer
toolbar defaults to `'localhost'` — i.e. ON in development — and carries **Share / Deploy**
actions that push the document to Scalar's own cloud, plus an **Ask AI** sidebar entry that ships
document context to a model endpoint we do not control. For the full surface of a private
healthcare API sitting inside an authenticated console, that is one-click egress. Now
`showDeveloperTools: 'never'`, `agent: { disabled: true }`, `mcp: { disabled: true }` — explicitly,
in every environment, not only the ones where the default happens to hide them.
(`showToolbar` is the deprecated alias and is `Omit`ted from the public config type, so it cannot
be set — `showDeveloperTools` is the live key.)

`forceDarkModeState` is set alongside `darkMode`: without it Scalar restores its OWN persisted
preference and renders light inside a dark console. Hiding its toggle does not prevent that — it
only hides the way back.

### Phase 3 — spec governance (delivered as a ratchet, not Redocly)

The plan called for `redocly`/`spectral` plus a `lint-openapi` CI job. **Measured first, then
deviated.** A scan of the emitted spec found what a generic linter would actually catch here:

```
reserved SYSTEM tenant id      1   (documented platform constant — correct to show)
reserved GLOBAL tenant id      1   (documented platform constant — correct to show)
e-mail literals                2   (both @example.com — RFC 2606 reserved, correct)
server urls                    0   (no `servers` block by design)
```

Near-zero findings for a new external toolchain. Meanwhile the checks that DO matter here are
HOPE-specific — a generic linter does not know that `70000000-…` is a seeded credential id — and
the debt worth gating is the description coverage. So both went into the existing
`check-openapi-coverage.ts` instead:

| Check | Behaviour |
|---|---|
| **Quality ratchet** (`QUALITY_RATCHET`) | Records the worst the repo may be — currently 1 summary / 412 descriptions / 290 4xx missing. Fails when a change makes any of them larger. Lowering needs no justification; raising one must be argued in the commit message |
| **Example hygiene** (`checkExampleHygiene`) | Fails on an e-mail outside the RFC 2606 reserved domains, and on a seeded credential identity (`60000000-…`, `70000000-…`) appearing in the document. The two platform tenant constants are deliberately permitted — a caller has to recognise them |

Failing on the absolute counts today would block every unrelated change, and a gate that has to
be bypassed is not a gate. The ratchet is the version that can be switched on now, and it puts
the debt in the diff rather than in a report nobody reads.

The ratchet is injectable (`checkOpenApiCoverage(doc, manifest, ratchet)`) specifically so its
REGRESSION branch is exercised on a small fixture — a gate whose failure path has never run is a
gate you are guessing about. That lesson came from the vacuous `swagger-config.test.ts` this
ticket deleted.

### Phase 5 — documentation

| File | Change |
|---|---|
| `docs/operations/api-documentation.md` | **NEW.** The whole pipeline: the four artifacts and their gates, how to make a new route document itself, the tag taxonomy, how the audience split is derived, who may read the portal, contract-vs-build versioning, the Scalar settings and why each is off, the description debt, and the deprecation policy |
| `.claude/rules/05-nestjs-api.md` | New §Documentation Surface + 3 new Definition-of-Done items. States flatly that `@ApiExclude*` hides a route from the DOCUMENT, not from the network — the conflation that caused both bugs this ticket found |
| `apps/api/docs/05-api-reference.md` | Points readers at `/developer/reference` for the endpoint reference and clarifies that this file is the gateway's INTERNAL architecture |

## Evidence

```
$ pnpm api:openapi:check
  manifest routes       657      spec operations       587
  deliberately excluded 70       (was 0 before the apiExcluded fix)
  missing summary 1 · missing description 412/587 · missing 4xx 290/587 · missing tag 0
[openapi-coverage] OK — every served route is either documented or deliberately excluded.

$ pnpm api:portal:check      -> [gen-api-portal] no drift (admin 587 ops, business 178 ops)
$ pnpm --filter @arcaai/vox-node gen:admin:check
                             -> [vox-node-codegen] no drift (52 areas, 391 routes, 354 schemas)

$ pnpm --filter @arcaai/api test        -> 253 passed | 2 skipped (255 files), 3968 passed
$ npx vitest run scripts/__tests__/{check-openapi-coverage,gen-api-portal}.test.ts
                                        -> 2 files, 30 passed
$ pnpm --filter @arcaai/admin-console lint       -> clean (--max-warnings 0)
$ pnpm --filter @arcaai/admin-console typecheck  -> clean
$ pnpm --filter @arcaai/admin-console test       -> 1682 passed, 3 pre-existing failures (below)
$ pnpm --filter @arcaai/admin-console build      -> compiled; /developer, /developer/reference,
                                                    /developer/sdk, /api/docs/spec/[plane] all present
```

### Runtime verification (live gateway on :8868, console on :5178)

| Check | Result |
|---|---|
| `super_admin` → `/api/docs/spec/business` | **200**, 585 KB |
| `super_admin` → `/api/docs/spec/admin` | **200**, 1.17 MB |
| `super_admin` → `/api/docs/spec/bogus` | **404** |
| `doctor` (seeded DB predates the new policy) → both planes | **403** |
| unauthenticated → any spec route | **401** (`proxy.ts` intercepts before the handler; the handler's own gate is defence in depth and is unit-tested directly) |
| `/developer`, `/developer/reference`, `/developer/sdk` as super admin | render their real content |
| Scalar reference | mounts, renders the plane/error prose, both plane tabs, credential notes |
| Credential note on `POST /auth/logout` | *"user JWT accepted; API key rejected (403); service-account token rejected"* — a fact that existed only in the manifest before this ticket |
| Dark mode | verified (`bodyBg rgb(15,15,15)`, Scalar follows) |
| axe | 0 violations on the overview and SDK screens |

## Follow-on fixes (the failures TASK-783 surfaced elsewhere)

Making `apiExcluded` truthful, and adding a documentation portal, broke three things that had
been passing for the wrong reason. Two were fixed by parallel worktree agents, one inline.

### 1. e2e authorization sweep silently lost 70 routes

`apps/api/tests/e2e/helpers/route-manifest.helper.ts` skipped routes where `apiExcluded` was
true, justified as *"not part of the public HTTP surface"*. **False premise.** `@ApiExclude*`
hides a route from the OpenAPI DOCUMENT; it stays mounted, served, and guarded. The predicate
was dormant only because the flag was always `false`. Once truthful, it dropped 70 of 657 routes
out of the authorization conformance sweep — including the 24 `@Public()` `/internal/*` routes
assertion A5b exists to prove are service-token-gated, which is why A5b's inventory collapsed
to 0.

Fix: `skipReasonFor` no longer skips on `apiExcluded`, with a doc comment stating why it must not
be reinstated. **No assertion was weakened and no hardcoded count changed** — A5b's 24 is
restored, not altered. Derivation, verified independently against the manifest: 20
`HarnessInternalController` + 2 `ServiceReleaseInternalController` + 1 `ConsentInternalController`
+ 1 `EffectiveConfigController` = 24.

The other consumer of the flag, `packages/vox-node-codegen/src/surface.ts`, uses it correctly as
a documentation-visibility oracle and is unaffected — it inspects only `/admin/*` routes, and
**zero of the 70 flagged routes are under `/admin/`** (confirmed).

### 2. `turbo.json#globalEnv` polluted by documentation snippets

`scanTypeScriptReads()` in `scripts/env-sync.mts` matches `process.env.X` as TEXT. The portal's
copy-pasteable SDK snippets live in `.tsx` template literals, so `HOPE_API_KEY`, `HOPE_API_URL`,
`HOPE_SA_CLIENT_ID`, `HOPE_SA_CLIENT_SECRET` and `HOPE_TENANT_ID` — the **reader's** variables,
which nothing in this repo reads — were being pulled into the turbo cache key and into
`env-surface.generated.md` as part of HOPE's platform env surface. Both wrong.

Fix: a declared `DOCUMENTATION_SURFACES` list, on the precedent that the scanner **already**
excludes `docs/` for exactly this reason — prose about a variable is not a program that reads one.

**One correction applied to the agent's version.** It excluded matching files *wholesale*, on the
stated grounds that `turbo/no-undeclared-env-vars` would still catch a genuine read there. That
safety net does not exist: `flat/next.js` is deliberately self-contained and does NOT spread
`flat/core.js`, so `eslint-config-turbo` is not active on the admin console —
`eslint --print-config` resolves **zero** `turbo/*` rules, and a probe read passed lint cleanly.
A whole-file skip would therefore let a real read silently miss the cache key with nothing to
catch it.

Narrowed to blank **template-literal contents only** in those trees. Snippets are ignored; a
genuine member expression outside a snippet is still detected. Proven both ways:

```
$ # genuine read planted in a documentation surface
$ pnpm env:sync --check   ->  FAILS: "Run `pnpm env:sync` and commit the result."
$ # probe removed
$ pnpm env:sync --check   ->  OK — 6 artifacts match (163 keys)
```

The per-file scan was extracted as `scanSourceForTests` so that distinction is asserted on a
string rather than by planting a probe file in the repo.

### 4. The offline emit scripts printed a wall of errors on a clean, successful run

`pnpm api:openapi` and `pnpm api:route-manifest` both exited **0**, wrote correct artifacts, and
then printed a `prisma:error` block plus ~200 raw `ECONNREFUSED` stack dumps. A build command whose
success is indistinguishable from its failure is not a usable gate — an operator cannot tell that
run apart from a broken one, and in CI the log reads as a failure. Two independent causes, both
real defects rather than script noise:

**(a) `AppSettingsService` did database I/O from its constructor.** *"Initialize cache immediately
but don't wait for it"* fired an unawaited `findAll({})` at DI time. A constructor cannot await, so
that promise raced the awaited load in `onModuleInit` — on a healthy boot it simply duplicated the
query, and in any process that builds the DI graph WITHOUT running lifecycle hooks (exactly what
these two scripts do: `NestFactory.create()`, never `init()`/`listen()`) it dialled a database that
by design is not there, then lost the race to `process.exit()` and surfaced as an unattributable
`prisma:error`.

Fixed by deleting the constructor call and the `initializeCache()` wrapper it used;
`ensureCacheInitialized()` in `onModuleInit` is now the ONE load path. **No boot outcome changes** —
the constructor path swallowed its error, so the P0-5 duplicate-key invariant and a DB-down boot
were already being decided by `onModuleInit`, which re-throws. `_cachedAppSettings` also stops being
definitely-unassigned (it is `new Map()` at the field): with no constructor load, `hasSetting()` /
`getAllKeys()` in the pre-`onModuleInit` window would otherwise throw a `TypeError` rather than
report an empty cache. `_cacheInitialized`, not the map's existence, remains the "loaded yet?" flag.

`appSettings.service.test.ts` was reworked accordingly — its `createService` helper waited on that
floating promise with `await sleep(10)`, so 14 tests were transitively asserting the constructor
side effect. It now loads through the real path, plus two new tests pinning the new invariant
(the constructor issues no query; an unloaded cache reports empty instead of throwing).

**(b) BullMQ queues had no `'error'` listener, so BullMQ fell back to `console.error`.** The
bootstrap brings up 40 `Queue`s, each of which dials Redis eagerly from its constructor — against
the deliberately unreachable `REDIS_HOST=127.0.0.1 REDIS_PORT=1` these scripts must pass in
(`BullModule.forRootAsync`'s factory throws synchronously if the pair is absent, so "no Redis" is
not an option). `QueueBase#emit` re-throws what `EventEmitter#emit` throws, Node throws on an
`'error'` event with no listener, and BullMQ's last resort is `console.error(err)` — a path that
also bypasses `@arcaai/logger` entirely.

Fixed with `apps/api/src/scripts/offline-infrastructure.ts`: the scripts attach a no-op `'error'`
listener to every queue in the container as the FIRST statement after `create()`. That is not a
mute — the connection error is *expected* under the script's own "no infrastructure" premise, so
this process is the one that should own it, and nothing is hidden that could matter (the emit reads
compiled metadata and never touches a queue). Timing is load-bearing and measured: `create()`
resolves at ~1.2s, the first `ECONNREFUSED` lands at ~1.34s, so that call site catches all of them.
`ModulesContainer` is the walk root rather than `DiscoveryService` because it is an
internal-core, always-global provider, and `emit-route-manifest.ts` already walks it.

The module is separate from the two scripts (which self-execute on import and so cannot be
imported by a test) for the same reason `openapi/api-exclude-metadata.ts` is — it is unit-tested,
including a test that reproduces the `console.error` fallback and then proves it stops.

Both emits are now silent, and both artifacts re-emit **byte-identical** — the fix changed nothing
about what is produced:

```
$ pnpm api:openapi
[emit-openapi] wrote 455 paths to …/openapi.json (40 offline queues quiesced)
    stderr: 0 lines            git status: clean

$ pnpm api:route-manifest
[emit-route-manifest] wrote 657 routes (409 admin, 391 machine-reachable) to …/route-manifest.json (40 offline queues quiesced)
    stderr: 0 lines            git status: clean
```

The header comment in `emit-openapi.ts` claiming this was *"harmless"* and *"cannot be avoided
without editing application code, which is out of scope here"* was wrong on the second half and
misleading on the first, and has been corrected: (a) was application code that needed fixing, and
the emit now reaches **no** network service at all.

### 3. Seed policy count

`api-documentation-read` took `DEFAULT_POLICIES` from 21 to 22. Count updated, plus a shape
assertion that it is GLOBAL-scoped with exactly `read:ApiDocumentation` — a bare count bump would
not have caught a malformed rule. The existing role→policy referential-integrity test already
covers the `TENANT_ADMIN` / `DOCTOR` wiring and is green. `SEED_POLICY_IDS` deliberately does not
register it, matching the `prisma-studio-manage` precedent.

## Final verification

```
$ pnpm test:unit                    1163 files, 19941 passed, 0 failed   (was 3 failed)
$ RESET_DB=false playwright test    1162 passed, 36 skipped, 0 failed    (was 1 failed)
    task-776 matrix: 7/7 — swept 657 routes (was 587), A5b 24 (was 0),
                     2xx findings 0, transport errors 0
$ pnpm env:sync --check             OK — 6 artifacts match (163 keys)
$ pnpm api:openapi:check            OK — ratchet 1/412/290, hygiene clean
$ pnpm api:portal:check             no drift (admin 587, business 178)
$ pnpm --filter @arcaai/vox-node gen:admin:check   no drift
$ pnpm --filter @arcaai/admin-console lint         clean (--max-warnings 0)
$ pnpm --filter @arcaai/admin-console typecheck    clean
```

Re-verified after follow-on fix 4 (offline emit noise):

```
$ pnpm api:openapi                  exit 0, 0 stderr lines, artifact byte-identical
$ pnpm api:route-manifest           exit 0, 0 stderr lines, artifact byte-identical
$ pnpm api:openapi:check            OK — ratchet 1/412/290, hygiene clean
$ pnpm api:portal:check             no drift (admin 587, business 178)
$ pnpm --filter @arcaai/vox-node gen:admin:check    no drift (52 areas, 391 routes, 354 schemas)
$ pnpm --filter @arcaai/applications test           528 files, 9698 passed, 0 failed
$ pnpm --filter @arcaai/applications build          clean
$ pnpm --filter @arcaai/applications typecheck      clean
$ pnpm --filter @arcaai/api test                    254 files, 3974 passed, 0 failed
$ pnpm --filter @arcaai/api typecheck               clean
$ pnpm --filter @arcaai/api lint                    0 errors (63 pre-existing warnings, none in touched files)
```

The full sweep newly covers 70 routes that had dropped out — 34 `/internal/*`, 35 TASK-760
redirect shims, and the text proxy — with **zero** authorization findings among them.

## Remaining Work

| Item | Status |
|---|---|
| Changelog screen (`/developer/changelog`) | **Deliberately not built.** The API-contract changelog has no backing source yet; a screen with nothing in it is worse than its absence. The deprecation policy it would render is written down in `docs/operations/api-documentation.md` |
| Audit event on spec reads | **Not built.** The BFF cannot broadcast a gateway sys-event; doing it properly needs a gateway endpoint. Flagged rather than half-built |
| `contact` / `license` in `info` | **Blocked on the owner** — needs a real support address and license URL. Deliberately empty until then: publishing a support channel that does not answer is worse than publishing none |
| Working the description debt down | Ongoing. 412/587 operations have a summary and nothing else; the ratchet stops it worsening but does not improve it. Business-plane operations first |
| Re-seed the dev DB | **Owner's call** — `api-documentation-read` is in the seed but the local DB predates it, so only super admins can open the portal locally until `pnpm db:seed` runs. Not run unprompted because it rewrites the developer's local data |

## Pre-existing issues found (NOT caused by this ticket, NOT fixed)

| Issue | Evidence |
|---|---|
| ~~3 failing console tests in `dev-service-down-hint`~~ | **RESOLVED elsewhere.** Those tests failed against an uncommitted working-tree edit; commits `06f098b5`/`60a6224` landed it properly. Re-verified 2026-08-20: `pnpm --filter @arcaai/admin-console test` → 212 files, **1685 passed, 0 failed** |
| ~~1 lint error in `apps/api/tests/e2e/password-security-hardening.spec.ts:386`~~ | **RESOLVED elsewhere.** `pnpm --filter @arcaai/api lint` (which globs `{src,tests}/**/*.ts`) → **0 errors** |
| ~~2 typecheck errors in `consultation.controller.test.ts` and `entitlements-admin.controller.test.ts`~~ | **RESOLVED elsewhere.** `pnpm --filter @arcaai/api typecheck` → clean |
| `throttle-guard.test.ts` flake | Failed once under full-suite parallelism, passed alone and on re-run. Not reproduced since |
| `notFound()` returns HTTP **200** with a 404 body | App-wide in dev: `/dashboard`, `/tenants`, `/audit-logs` all behave identically. The content gate works; the status code does not match it |
| `GET /api/v1/consultations` requires the scope `consultation:session:write` | A read requiring a write scope. Surfaced by rendering scopes in the reference; worth a look, out of scope here |

## Verification Criteria

Three criteria named scripts the plan expected to create. Phase 3 deviated (no Redocly — see its
Implementation Summary), so the real script names are recorded here; the stale names never existed.

- [x] `pnpm api:openapi` → `pnpm api:openapi:check` green — 0 manifest routes missing from the spec (657 routes = 587 documented + 70 deliberately excluded)
- [x] `pnpm api:portal:check` (planned as `gen:api-portal:check`) green and byte-idempotent — no drift, admin 587 ops / business 178 ops
- [x] Spec quality gate green — delivered as the ratchet + example hygiene inside `api:openapi:check` (planned as `pnpm api:lint:spec`, a Redocly run that was measured to be worth ~nothing here): 1/412/290 at or under their maxima, hygiene clean
- [x] `pnpm --filter @arcaai/admin-console build lint test` green — 212 files, 1685 passed, 0 failed; lint clean at `--max-warnings 0`; build emits all four routes
- [x] `pnpm --filter @arcaai/api test` green (swagger-config + tag-taxonomy tests) — 254 files, 3974 passed, 0 failed
- [x] Both emit commands are clean, not merely exit-0 — `pnpm api:openapi` / `pnpm api:route-manifest` produce **zero** stderr output and byte-identical artifacts (follow-on fix 4)
- [~] axe scan 0 violations, both themes — run on the **overview** and **SDK** screens. The reference screen is a third-party Scalar embed and the spec route returns JSON, so neither is an authored screen to scan; the two authored screens are covered. Dark mode verified on all of them
- [x] E2E: user WITH the ability sees the portal; user WITHOUT it gets a 403 from the spec route and no nav entry; `/api/docs/spec/bogus` → 404 (Runtime verification table above)
- [x] No spec bytes reachable without a session — unauthenticated → 401 on every new route (`proxy.ts` first, and the handler's own gate unit-tested directly as defence in depth)
- [~] Version stamp on the portal matches `build-info.json` in the running image — the portal renders the gateway's `GET /health` payload, which is the correct source (`info.version` is deliberately a constant). Verified against the LOCAL dev gateway, which reports the untagged `0.0.0-<branch>.<sha8>` form; matching against a real `build-info.json` needs a CI-built image and is not verifiable from a workstation

---

## Risks

| Risk | Mitigation |
|---|---|
| Scalar's global CSS bleeds into the console design system | Scope to the docs route segment; audit adjacent screens in Phase 4 step 8; fall back to D-2 option (b) |
| Scalar React wrapper theming regressions (upstream #2392, #3388) | Pin the version; snapshot-test the docs screen in both themes; Redoc is the documented fallback |
| 413 operations lack descriptions — a "complete" portal that reads as empty | Phase 3 ratchet with an owner-agreed target; prioritise business-plane operations first |
| Spec leaks internal-only routes to tenant developers | The business projection is derived from `apiKeyForbidden`/`apiKeyScopes`, not hand-curated; a route defaults to admin-only |
| Doc examples carry real ids or PHI | Custom lint rule bans reserved tenant prefixes and e-mail literals in examples |
| Two more committed generated artifacts to keep in sync | Both drift-gated in CI, exactly like the three existing `generate-*-check` gates |

---

## Change History

| Date | Change |
|---|---|
| 2026-08-20 | Ticket created. Current state measured; tooling evaluated; plan drafted. Status **Pending**. |
| 2026-08-20 | Owner resolved D-1 (new CASL subject), D-2 (native Scalar embed), D-3 (try-it off), D-4 (design gate waived — proceed without Figma). Plan approved; status **In Progress**. |
| 2026-08-20 | Phases 1, 2 and 4 implemented and verified. Current State defect #3 CORRECTED — the "71 undocumented routes" were 70 deliberate exclusions hidden by a broken `apiExcluded` reader, plus one genuinely stale spec. Best-practice item #4 corrected: `info.version` stays a constant so the committed artifact remains reproducible; build identity comes from the running gateway instead. Generator homed in `scripts/` rather than `packages/tools`. Three Scalar cloud-egress affordances disabled after observing them at runtime. Phases 3 and 5 not started — see Remaining Work. |
| 2026-08-20 | Phases 3 and 5 completed. Phase 3 deviated from the plan: measured what a spec linter would catch here (near zero — both e-mails use RFC 2606 `example.com`, both tenant ids are documented platform constants), so the quality **ratchet** and HOPE-specific **example hygiene** went into `check-openapi-coverage.ts` instead of adopting Redocly. Ratchet made injectable so its regression branch is genuinely tested. Phase 5 added `docs/operations/api-documentation.md`, a §Documentation Surface + 3 DoD items in rule 05, and a pointer from `apps/api/docs/05-api-reference.md`. Seed policy-count test corrected 21 -> 22 with a shape assertion for `api-documentation-read`. |
| 2026-08-20 | Fixed the three suite failures TASK-783 surfaced: the e2e authz sweep silently dropping 70 routes (`apiExcluded` is documentation visibility, not authorization reach), `turbo.json#globalEnv` polluted by portal doc snippets, and the seed policy count. Narrowed the env-sync exclusion from whole-file to template-literal-only after disproving the agent's claim that `turbo/no-undeclared-env-vars` would catch a genuine read — that rule is not active on `apps/admin-console`. Full unit (19941) and e2e (1162) suites green. |
| 2026-08-20 | Follow-on fix 4: `pnpm api:openapi` / `pnpm api:route-manifest` printed a `prisma:error` block and ~200 raw `ECONNREFUSED` dumps on a successful exit-0 run. Two real causes, both fixed at the source — `AppSettingsService` did unawaited DB I/O from its CONSTRUCTOR (moved to the `onModuleInit` load path it already had; no boot outcome changes), and 40 BullMQ queues had no `'error'` listener so BullMQ fell back to raw `console.error` (new unit-tested `scripts/offline-infrastructure.ts` gives them an owner right after `create()`). `emit-openapi.ts`'s header claim that this was harmless and unavoidable was corrected. Both emits are silent and both artifacts re-emit byte-identical. |
