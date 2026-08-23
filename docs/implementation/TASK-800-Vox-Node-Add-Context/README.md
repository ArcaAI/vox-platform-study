# TASK-800 — consultation context write + schema discovery for `@arcaai/vox-node`

| | |
|---|---|
| **Ticket** | TASK-800 |
| **Type** | feature |
| **Status** | Completed |
| **Branch** | `dev-2.2` |
| **Opened / Closed** | 2026-08-23 |

## Requirement Analysis

`@arcaai/vox-node` exposed no way to write a consultation context item. A backend integration that
wanted to submit a case note — or an instance of a tenant-declared context kind — had to bypass the
SDK entirely and hand-roll `fetch` against the gateway, because `core/transport.ts#Transport` is
deliberately not exported and there is no raw-request escape hatch on `HopeClient`.

That mattered most for the schema-aware path. `POST /consultations/:id/context` carries two
subtleties a raw `fetch` gets wrong silently:

- the write must be **pinned** with `X-Context-Schema-Version` so a schema publish landing mid-run
  does not re-validate an in-flight caller against a declaration it never saw; and
- `payload` without `kindKey` is a 400 — a programming error the caller only discovers in
  production.

Scope, after the follow-up was pulled in: the **write** (`hope.consultations.addContext`) AND the
**discovery read** (`hope.tenants.contextSchema`). The two are only useful together — the write's
`contextSchemaVersionId` is a field of the bundle the read returns, so shipping the write alone left
every caller hand-rolling a `fetch` for the one value the write most wants.

## Current State Evaluation

| | Before |
|---|---|
| `hope.consultations` | `get()` + `.summaries` sub-resource, nothing else |
| Context-item types | none — `types/consultation.ts` modelled summaries and jobs only |
| `Transport` | not exported (`src/index.ts` documents this as deliberate) |

Gateway route, verified against `apps/api/route-manifest.json`:

```json
{ "controller": "ConsultationController", "handler": "addContext",
  "method": "POST", "path": "/api/v1/consultations/{id}/context",
  "svcScopes": [], "apiKeyForbidden": false,
  "apiKeyScopes": ["consultation:session:write"],
  "requiredPermissions": [], "requiresIfMatch": false }
```

Two consequences that shaped the implementation:

1. **`svcScopes: []` ⇒ a service account cannot reach this route.** An absent scope declaration is a
   deny-by-default 403 for both machine classes. The method is reachable by a user JWT and by an API
   key holding `consultation:session:write` — documented on the method rather than left to be
   discovered as a 403.
2. **No idempotency key** on `AddContextRequest`, and `forbidNonWhitelisted` would reject one if the
   SDK invented it — so `hasIdempotencyKey` is deliberately unset and the POST is never retried.

## Implementation Plan (TDD)

1. **RED** — six tests in `src/resources/__tests__/consultations.test.ts`: path + body, id
   percent-encoding, header sent when pinned, header absent when not, local `TypeError` for
   `payload` without `kindKey` (with no request issued), and no retry on 503.
2. **GREEN** — wire types in `types/consultation.ts`; `addContext` + `AddContextOptions` in
   `resources/consultations.ts`.
3. **RED** — five tests in `src/resources/__tests__/tenants.test.ts`: plural path, `departmentId`
   query present/absent, the unconfigured bundle returned as an ordinary value, and `HopeClient.tenants`
   wired to the shared transport.
4. **GREEN** — `types/consultation-context-schema.ts`; `TenantsResource` in `resources/tenants.ts`;
   `HopeClient.tenants`.
5. Barrels: `types/index.ts`, `resources/index.ts`, `src/index.ts`.
6. Gates: `test`, `typecheck`, `lint`, `build`, `check:exports`.

## Implementation Summary

### Files changed

| File | Change |
|---|---|
| `packages/vox-node/src/types/consultation.ts` | Added `ContextItemType`, `ContextItemSource`, `CONTEXT_CONTENT_MAX_LENGTH`, `AddContextRequest`, `ContextItemResponse` |
| `packages/vox-node/src/resources/consultations.ts` | Added `AddContextOptions` and `ConsultationsResource.addContext()` |
| `packages/vox-node/src/types/consultation-context-schema.ts` | **New.** `ConsultationSchemaBundle`, `ConsultationContextSchemaDefinition`, `ContextKindDeclaration`, `ContextOutputDeclaration`, `ContextKindDeprecation`, `ContextPrimitive`, `CONTEXT_PRIMITIVES` |
| `packages/vox-node/src/resources/tenants.ts` | **New.** `TenantsResource.contextSchema()` + `ContextSchemaDiscoveryOptions` |
| `packages/vox-node/src/client.ts` | `HopeClient.tenants` |
| `packages/vox-node/src/resources/__tests__/consultations.test.ts` | +6 tests |
| `packages/vox-node/src/resources/__tests__/tenants.test.ts` | **New.** +5 tests |
| `packages/vox-node/src/types/index.ts` | Re-exports (incl. the one VALUE export, `CONTEXT_CONTENT_MAX_LENGTH`) |
| `packages/vox-node/src/resources/index.ts` | Re-exports `AddContextOptions` |
| `packages/vox-node/src/index.ts` | Public barrel re-exports |
| `docs/consultation-context-schema-integration-guide.md` | §4.4 rewritten, §4.5 added — both halves of the backend gap are now closed |

### Decisions worth keeping

- **`contextSchemaVersionId` is an OPTION, not a body field.** It travels as a header on the wire,
  and the gateway ignores it when `kindKey` is absent. Modelling it as an option keeps
  `AddContextRequest` a faithful mirror of the server DTO — which matters because
  `forbidNonWhitelisted` makes that interface's closedness load-bearing.
- **`payload` without `kindKey` throws locally.** Follows the precedent in
  `admin/admin-resource.ts`, which validates `If-Match` locally and throws `TypeError` rather than
  letting a caller discover a 400 in production. Both are programming errors, not server conditions.
- **`ContextItemResponse` is a declared PARTIAL VIEW**, in the same spirit as
  `ConsultationGetResponse`. The server DTO additionally carries media/derivative fields, the `is*`
  classification booleans, and the `audioRecordings`/`summaryMeta`/`namedEntities`/`versions`
  expansions — all of which model the transcript-and-summary surface this SDK does not otherwise
  touch. The type's docstring says so, rather than implying the wire shape is exhausted.
- **Neither `kindKey` nor `contextSchemaVersionId` appear on the response** — verified against
  `context.dto.mapper.ts`, which projects neither. Not modelled, and the omission is documented.
- **Not retried.** Stated on the method with its reason: a duplicated clinical note is a worse
  outcome than a surfaced 503.
- **Discovery lives on `hope.tenants`, not `hope.consultations`.** The route is `tenants/me/context-schema`,
  one of a NINE-route `tenants/me/*` family (`/config`, `/entitlements`, `/invoices`, `/spend`,
  `/usage-*`). Hanging a tenant-plane read off the consultation resource for call-site convenience
  would misrepresent the URL and leave nowhere sensible for the rest of that family to land later.
- **Bundle enum-ish fields are widened with `| string`, and the interfaces carry index signatures.**
  The declaration is tenant-authored and versioned independently of this SDK; narrowing to today's
  unions would make a client one release behind fail to PARSE a bundle it could have handled by
  ignoring the unrecognised parts. Same posture as `@arcaai/vox-codegen`'s local mirror and the
  browser SDK's permissive client-side validation.
- **The unconfigured tenant is returned, never thrown.** `GET` answers 200 with all-null fields and
  `etag: "none"`; a 404 would be indistinguishable from a routing mistake, so the SDK preserves that
  distinction rather than "helpfully" converting it.
- **The `departmentId` trap is documented on the option itself.** `validateContextPayload` gives an
  explicit `contextSchemaVersionId` outright precedence — it does no department resolution when one
  is supplied. So discovering the tenant default, pinning it, and writing to a consultation in a
  department with its own vocabulary fails as `does not declare a kind '<key>'`, which reads like a
  typo rather than the scope mismatch it is. The docstring names it at the point of use.

## Verification

```
$ pnpm --filter @arcaai/vox-node test
 Test Files  19 passed (19)
      Tests  244 passed (244)

$ pnpm --filter @arcaai/vox-node typecheck
> tsc --noEmit                                    # clean

$ pnpm --filter @arcaai/vox-node lint
> eslint src                                      # clean (0 errors, 0 warnings)

$ pnpm --filter @arcaai/vox-node build
CJS dist/index.js     296.8 KB    ⚡️ Build success
ESM dist/index.mjs    294.33 KB   ⚡️ Build success
DTS dist/index.d.ts   580.57 KB   ⚡️ Build success

$ pnpm --filter @arcaai/vox-node check:exports
node10 🟢 · node16 (CJS) 🟢 · node16 (ESM) 🟢 · bundler 🟢
publint … All good!
```

RED was observed before each implementation step: the six `addContext` tests failed with
`TypeError: resource.addContext is not a function` while the three pre-existing tests passed; the
`tenants.test.ts` suite then failed to resolve `../tenants` at all, and the `HopeClient.tenants`
test failed on an undefined property before the client was wired.

`typecheck` also earned its place: it rejected a dynamic `await import('../../client')` in the new
test under `moduleResolution: node16` (TS2835) even though vitest ran it green. Replaced with a
static import.

### Out of scope — pre-existing failure

`pnpm --filter @arcaai/vox-node gen:admin:check` reports DRIFT in `admin-namespace.ts`, `harness.ts`
and `schemas.ts`. **Pre-existing on `dev-2.2` and untouched by this ticket** — `git status` shows none
of the three in the working tree. Regenerating the admin surface is a separate change with its own
diff; not folded in here.

## Follow-up

- The other eight `tenants/me/*` routes (`/`, `/config`, `/entitlements`, `/invoices`,
  `/invoices/{id}`, `/spend`, `/usage-summary`, `/usage-burndown`) are absent from `TenantsResource`
  by omission, not by policy. Each carries its own API-key scope; add them when a caller needs them.
- Conditional discovery (`If-None-Match` → 304) is not modelled. The bundle carries its own `etag`,
  so a caller can cache on it, but the transport maps non-2xx to the error hierarchy and a 304 would
  need explicit handling before it could be offered.

## Change History

| Date | Change |
|---|---|
| 2026-08-23 | Ticket opened, implemented and verified. `addContext` + context-item wire types added to `@arcaai/vox-node`; integration guide §4.4 updated. |
| 2026-08-23 | Scope extended on request: discovery read added — `hope.tenants.contextSchema()`, `TenantsResource`, context-schema wire types, `HopeClient.tenants`. Guide §4.5 added. All gates re-run green (244 tests). |
