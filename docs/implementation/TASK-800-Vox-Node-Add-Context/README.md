# TASK-800 — `hope.consultations.addContext()` for `@arcaai/vox-node`

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

Scope: the **write** only. A typed read for `GET /tenants/me/context-schema` (discovery) is a
separate surface and is deliberately NOT part of this ticket.

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
3. Barrels: `types/index.ts`, `resources/index.ts`, `src/index.ts`.
4. Gates: `test`, `typecheck`, `lint`, `build`, `check:exports`.

## Implementation Summary

### Files changed

| File | Change |
|---|---|
| `packages/vox-node/src/types/consultation.ts` | Added `ContextItemType`, `ContextItemSource`, `CONTEXT_CONTENT_MAX_LENGTH`, `AddContextRequest`, `ContextItemResponse` |
| `packages/vox-node/src/resources/consultations.ts` | Added `AddContextOptions` and `ConsultationsResource.addContext()` |
| `packages/vox-node/src/resources/__tests__/consultations.test.ts` | +6 tests |
| `packages/vox-node/src/types/index.ts` | Re-exports (incl. the one VALUE export, `CONTEXT_CONTENT_MAX_LENGTH`) |
| `packages/vox-node/src/resources/index.ts` | Re-exports `AddContextOptions` |
| `packages/vox-node/src/index.ts` | Public barrel re-exports |
| `docs/consultation-context-schema-integration-guide.md` | §4.4 rewritten — the write gap is closed, discovery remains open |

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

## Verification

```
$ pnpm --filter @arcaai/vox-node test
 Test Files  18 passed (18)
      Tests  239 passed (239)

$ pnpm --filter @arcaai/vox-node typecheck
> tsc --noEmit                                    # clean

$ pnpm --filter @arcaai/vox-node lint
> eslint src                                      # clean (0 errors, 0 warnings)

$ pnpm --filter @arcaai/vox-node build
CJS dist/index.js     294.45 KB   ⚡️ Build success
ESM dist/index.mjs    292.02 KB   ⚡️ Build success
DTS dist/index.d.ts   571.38 KB   ⚡️ Build success

$ pnpm --filter @arcaai/vox-node check:exports
node10 🟢 · node16 (CJS) 🟢 · node16 (ESM) 🟢 · bundler 🟢
publint … All good!
```

RED was observed before implementation: the six new tests failed with
`TypeError: resource.addContext is not a function` while the three pre-existing tests passed.

### Out of scope — pre-existing failure

`pnpm --filter @arcaai/vox-node gen:admin:check` reports DRIFT in `admin-namespace.ts`, `harness.ts`
and `schemas.ts`. **Pre-existing on `dev-2.2` and untouched by this ticket** — `git status` shows none
of the three in the working tree. Regenerating the admin surface is a separate change with its own
diff; not folded in here.

## Follow-up

A typed discovery read (`hope.consultations.contextSchema()` or `hope.tenants.contextSchema()` for
`GET /tenants/me/context-schema`) would close the other half of the gap: today the caller must fetch
the bundle with raw `fetch` in order to obtain the `contextSchemaVersionId` this method wants. Left
out deliberately — it is a different route on a different controller, and this ticket was scoped to
the write.

## Change History

| Date | Change |
|---|---|
| 2026-08-23 | Ticket opened, implemented and verified. `addContext` + context-item wire types added to `@arcaai/vox-node`; integration guide §4.4 updated. |
