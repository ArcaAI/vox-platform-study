# TASK-665 — SDK: schema discovery, validated context add, event hook

- **Status:** Review
- **Type:** feature
- **Wave:** W4 of [TASK-654](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md) · Tier sonnet-5 / medium · Size M
- **Depends on:** TASK-658 (context schema data model + discovery endpoint), TASK-661 (version pinning + `X-Context-Schema-Version` header contract), TASK-660 (loop event plane / `consultation:loop:{id}` SSE)
- **Baseline:** `dev-2.1` @ `5a675d3d5` (docs(TASK-654): harness baseline depends on .env.dev presence)
- **Worktree:** `agent-a0f13e6f93fea0d73` — `git reset --hard dev-2.1` performed before any work (it spawned checked out to a stale local branch, not `dev-2.1`)
- **Spec:** [execution-plan.md § TASK-665](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/execution-plan.md)

---

## 1. Requirement Analysis

**Objective.** The client (`@arcaai/vox`) discovers the tenant's consultation-context schema at
session start, pins the version it built against for the life of the session, validates a
`STRUCTURED` payload against that schema before sending it, and gets a live feed of
consultation-loop workflow events — all **additively**, since `@arcaai/vox` is consumed by
`apps/compat-playground` through a small set of shared modules that must never change shape.

| # | Acceptance criterion (from the ticket) |
|---|---|
| AC-1 | `useConsultationSchema()` fetches at `AgenticProvider` mount, cached in a ref exactly like `ModelRegistry.loadTenantConfig`, awaited inside `init()` before `setConfigReady(true)` |
| AC-2 | The mount-time fetch/cache/await sequence is **replicated in the tenant-switch block** so a working-tenant switch doesn't leave the schema stale |
| AC-3 | The session **pins** the schema version; it is sent as `X-Context-Schema-Version` on writes (TASK-661's header contract); version skew is handled (the server, not the SDK, is the authority — see §4.5) |
| AC-4 | `AddContextInput` gains optional `mediaId`, `kindKey`, `payload`; mirrored onto `ContextItem`; `SIGNED_NOTE` added to the `ContextItemType` union (it was missing) |
| AC-5 | `StorageFile` gains `mediaId?: string`; `addAttachment` accepts and forwards it |
| AC-6 | `useConsultationEvents()` subscribes to the loop event SSE stream, modeled on `useArcaLiveSummary` (the leaner exemplar) |
| AC-7 | The hook's doc comment states the no-`Last-Event-Id`-resume limitation rather than implying resumability |
| AC-8 | Nothing in the additive-only list (`src/compat.ts`, `src/compat/**`, the `compat` tsup block, `"./compat"` exports, `docs/Compat-API-Reference.md`, or the shape/signature of `AgenticConfig`/`Consultation`/`AudioProcessingConstraints`/`AgenticClient`/`SSEClient`/`agenticStore` selectors/`useArcaAudio`/`useArcaSession`) changes shape |
| AC-9 | `apps/compat-playground` builds |
| AC-10 | Client-side payload validation uses **valibot** (already bundled) — no Ajv, no Zod |

### 1.1 Design constraints inherited from the parent

- **C7 (whitelist envelope)**: `kindKey`/`payload` ride the same declared `AddContextInput` envelope the server's `AddContextRequest` already declares — nothing new on the wire, only new optional client-side fields.
- **Additive-only on the six shared modules** (execution-plan §1.4): verified per-module in §4.4 below.
- **No `Last-Event-Id` resume anywhere in `SSEClient`** (execution-plan "document, don't silently inherit"): stated in `useConsultationEvents`'s doc comment (§4.3).

---

## 2. Current State Evaluation

Verified against `dev-2.1` @ `5a675d3d5`, before any TASK-665 code.

| Area | Finding |
|---|---|
| Discovery endpoint | `GET /tenant/me/context-schema` (TASK-658) returns `ConsultationContextSchemaBundleResponse` — `{ schemaId, slug, name, versionNumber, contextSchemaVersionId, checksum, definition, etag }`, all nullable, `etag: "none"` for an unconfigured tenant (never 404). |
| Version-pin header | TASK-661 wired `X-Context-Schema-Version` end-to-end on the **server**: `ConsultationController#addContext` reads it and threads it into `ContextService.addContext(consultationId, request, contextSchemaVersionId?)`, which resolves that EXACT version via `validateContextPayload`. Nothing on the SDK side ever sent it — the header existed but was unreachable from this client. |
| `AddContextInput`/`ContextItem` | `type: ContextItemType \| string`, `content`, `structuredData`, `source` only — no `mediaId`, `kindKey`, or `payload`, even though the server's `AddContextRequest` (TASK-658) already declares `kindKey`/`payload`, and `mediaId` on `AddContextRequest` predates TASK-658 entirely. |
| `ContextItemType` union | Missing `SIGNED_NOTE` (server enum has carried it since before this wave) and `STRUCTURED` (added by TASK-658). Because the type is `ContextItemType \| string`, this was a documentation gap, not a compile error — callers could already pass either string; the union just didn't say so. |
| `types/consultation.ts` re-declaration claim | The ticket text says this file "re-declares rather than imports" `AddContextInput`. **Not true today** — `consultation.ts:7` imports `type { ContextItem, AddContextInput } from './context'` and re-exports it at `:238`. Whoever wrote the execution-plan spec was describing an earlier state (or a different file) — the import already keeps it in sync automatically, so `AddContextInput`'s new optional fields propagate with zero additional edits to `consultation.ts`. No change was needed or made to that file. |
| `useStorage.ts` `StorageFile.mediaId` | **Already present** (`useStorage.ts:34`, with a doc comment naming TASK-656 explicitly). The execution-plan's "StorageFile gains mediaId" line was already done by a prior ticket. What was still missing: `addAttachment` (in `useArcaContext.ts`, NOT `useStorage.ts` — `addAttachment` isn't defined there) never accepted or forwarded a `mediaId` parameter at all. |
| `AgenticClient` | `post<T>(endpoint, body?, options?: { signal })` has no way to add a custom header. `patchWithIfMatch<T>` is the existing precedent for a one-off-header POST-shaped helper (mirrors `If-Match`). No `postWithHeaders` existed. |
| `AgenticProvider` mount | `tenantConfigPromiseRef` (ref-cached fetch, kicked off once `apiClient` exists, `.then()`-populated into the store immediately, AND awaited again inside `init()` — Step 2 — before `configReady` flips) is the exact pattern to mirror (`AgenticProvider.tsx:475-490` pre-change). |
| `AgenticProvider` tenant-switch | The rehydrate effect (`:705-889` pre-change) re-fetches `tenantConfig` via `modelRegistry.loadTenantConfig()` inside its own try/catch, after `clearTenantSessionData()` synchronously nulls the outgoing tenant's `tenantConfig`. No equivalent existed for a schema bundle because the field didn't exist yet. |
| Loop event stream | TASK-660 shipped `GET /consultations/:id/loop/stream` (`@StreamScope({ namespace: 'consultation_loop', param: 'id' })`, scope `consultation_loop:<id>`, relays `consultation:loop:{id}`, `LoopEventDto` payload, no snapshot/fold/late-join — mirrors the trajectory stream exactly). No SDK hook consumed it. |
| `SSEClient` | Confirmed by reading the whole file: `connect()`/`openWithTicket()`/`scheduleReconnect()` never read or send an `Event-Id`/`Last-Event-Id`. A reconnect (auto or manual `start()`) always mints a fresh single-use ticket and opens a brand-new `EventSource`. There is no cursor anywhere in this class. |
| valibot | Already used for STATIC, compile-time-known shapes only (`ConfigSchema.ts`, `ModelRegistry.ts`'s `SELECTED_MODELS_SCHEMA`). No precedent for building a validator from a runtime-authored JSON-Schema-like document. |
| Server's JSON-Schema-subset evaluator | `packages/applications/src/services/consultation-context-schema/json-schema-subset.ts` is **hand-written**, not built on a library, specifically because the schema being evaluated (`kind.fields`) is tenant-authored at runtime — a static-schema library has nothing to compile against, and a general-purpose one would silently accept keywords the AUTHORING gate forbids. |

---

## 3. Implementation Plan (as executed)

| # | Layer | Files |
|---|---|---|
| 1 | Types | `src/types/consultationSchema.ts` (new — envelope + valibot parser + lookup helpers), `src/types/loopEvent.ts` (new), `src/types/context.ts` (`ContextItemType` +`SIGNED_NOTE`/+`STRUCTURED`; `ContextItem`/`AddContextInput` +`mediaId`/`kindKey`/`payload`; `ContextActions.addAttachment` +`mediaId` param) |
| 2 | Core | `src/core/contextPayloadValidation.ts` (new — ported JSON-Schema-subset VALUE evaluator + `validateConsultationContextPayload` orchestration), `src/core/ConsultationSchemaClient.ts` (new — `fetchConsultationSchema`, mirrors `ModelRegistry.loadTenantConfig`'s retry + fail-open posture), `src/core/AgenticClient.ts` (+`postWithHeaders`), `src/core/constants.ts` (+`MY_TENANT_ENDPOINTS.CONTEXT_SCHEMA`, +`CONSULTATION_ENDPOINTS.LOOP_STREAM`, +`loopEventsScopeFor`) |
| 3 | Store | `src/store/agenticStore.ts` (+`consultationSchema` state/action, wired into `clearTenantSessionData`/`clearOnLogout`), `src/store/index.ts` (+`selectConsultationSchema`) |
| 4 | Provider | `src/providers/AgenticProvider.tsx` — mount-time fetch/cache/await (mirrors `tenantConfigPromiseRef`), replicated in the tenant-switch rehydrate effect |
| 5 | Hooks | `src/hooks/useConsultationSchema.ts` (new), `src/hooks/useConsultationEvents.ts` (new, copies `useArcaLiveSummary`), `src/hooks/useArcaSession.ts` (`addContext`: client-side validation + `X-Context-Schema-Version`), `src/hooks/useArcaContext.ts` (`addAttachment`: `mediaId` param) |
| 6 | Barrels | `src/hooks/index.ts`, `src/types/index.ts`, `src/core.ts` |
| 7 | Tests | 8 new files (see §5 AC → test map) + 1 pre-existing test fixed (see §4.6) |

### 3.1 TDD list (RED first) → what actually drove code

| # | Test | Drove |
|---|---|---|
| 1 | Unknown kind is ignored gracefully, not fatal | `validateConsultationContextPayload` returns `{ valid: true, problems: [] }` for an unresolved `kindKey` — never throws, never blocks the write |
| 2 | Payload validated client-side before send | `useArcaSession.addContext` calls `validateConsultationContextPayload` and throws `AgenticError('VALIDATION_ERROR', ...)` BEFORE `apiClient.post`/`postWithHeaders` when invalid |
| 3 | Session keeps its pinned version when the tenant publishes a new one | `AgenticProvider` never re-fetches mid-session — proven directly: mock the schema endpoint to return a NEW version after mount, confirm the store still reads the ORIGINAL version and the endpoint was hit exactly once |
| 4 | `mediaId` threads from `uploadFile` through to the attachment | `useArcaContext.addAttachment(content, metadata, mediaId)` forwards `mediaId` on the POST body |
| 5 | The schema fetch is replicated on tenant switch | New `AgenticProvider.consultationSchema.task665.test.ts` — same-tab switch clears the outgoing bundle synchronously, then fetches and applies the incoming tenant's own bundle |
| 6 | `apps/compat-playground` builds | `pnpm --filter compat-playground build` — exit 0 (§6) |

---

## 4. Implementation Summary

**Status: Review.** All ten acceptance criteria implemented and covered by tests; every gate green.

### 4.1 Discovery — `useConsultationSchema()` and the provider wiring

- **Fetch**: `fetchConsultationSchema(apiClient, logger?, { departmentId? })` (`ConsultationSchemaClient.ts`) — `GET /tenant/me/context-schema`, retried exactly like `ModelRegistry.loadTenantConfig` (`maxRetries: 2, delayMs: 1000`), and **fail-open**: any error (network, non-2xx, malformed body) resolves to `UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE` (`{ ...all null, etag: 'none' }` — the exact shape the server itself returns for an unconfigured tenant) rather than rejecting. This is the same posture as the tenant-config fetch and for the same reason: a schema-plane outage must never block `configReady`.
- **Envelope validation**: `parseConsultationSchemaBundle` uses `valibot` (`v.object` with `v.nullish`/`v.optional` per field) to guard against a malformed response — mirrors `ModelRegistry`'s `SELECTED_MODELS_SCHEMA` guarding poisoned localStorage JSON. The `definition` document itself is validated only as "a JSON object" — see §4.5 for why its contents are read defensively instead.
- **Provider wiring** (`AgenticProvider.tsx`): a `consultationSchemaPromiseRef` is declared alongside `tenantConfigPromiseRef` and follows the IDENTICAL dual pattern — kicked off once `apiClient` exists (so it populates the store even in the no-credentials path, where `init()` returns early and never reaches `configReady`), `.then()`-populated immediately, AND awaited again inside `init()` (new **Step 4.5**, right before Step 5 flips `configReady`) so a consumer that observes `configReady === true` can trust `consultationSchema` is already settled — not still in flight.
- **Hook**: `useConsultationSchema()` is a pure READ over the store slice (`selectConsultationSchema`) plus three helpers — `findKind`, `isDeprecated` (TASK-661's `deprecated` block), `validatePayload`. It does **not** fetch; the provider owns the fetch so every consumer in the tree observes the SAME pinned bundle.

### 4.2 Session pin + `X-Context-Schema-Version`

- `AgenticClient.postWithHeaders<T>(endpoint, body, headers, options?)` — a new public method, mirroring `patchWithIfMatch` exactly (thin wrapper around the private `request`). Purely additive: no existing method's signature changed.
- `useArcaSession().addContext(input)`: when the store has a pinned `consultationSchema.contextSchemaVersionId`, the write goes through `postWithHeaders` with `{ 'X-Context-Schema-Version': pinnedVersionId }`; otherwise it is the UNCHANGED plain `apiClient.post` call — byte-identical to pre-TASK-665 behaviour, which is what keeps K7 (every existing consultation, no schema configured, behaves exactly as before) true on the client side too.
- **Client-side validation, before the request is sent**: if `input.kindKey` AND `input.payload !== undefined`, `validateConsultationContextPayload(consultationSchema, kindKey, payload)` runs first. An invalid payload throws `AgenticError('VALIDATION_ERROR', ...)` immediately — `apiClient.post`/`postWithHeaders` is never called. A `kindKey` the resolved bundle doesn't recognize (schema not loaded yet, or a kind newer than this SDK build) is **not** a client-side error: `validateConsultationContextPayload` returns `{ valid: true, problems: [] }` and the write proceeds to the server, which is the final authority — this is the forward-compatibility guarantee TASK-654 D2/D4 requires (AC-1 of the TDD list, tested directly).
- **Version skew (AC-3's "handled")**: the SDK does not attempt to detect or react to skew itself — TASK-661 already put that logic server-side (`versionSkew` computed via `classifyDefinitionChange`, logged, never rejected). "Handled" on the client means: the session's pin is sent verbatim on every write and is **never silently swapped** for a newer one mid-session (§4.5 test), so the server always validates against the version the client actually built against — the write is either safe or explicitly rejected, never silently upgraded. A response-level skew signal for the SDK to render a UI warning does not exist yet server-side either (TASK-661 §6, explicitly deferred) — nothing to consume here.

### 4.3 `useConsultationEvents()` and the documented resume gap

- Copies `useArcaLiveSummary` structurally: `useApiOperation`, teardown-before-restart on every `start()` (no zombie `EventSource` across single-use tickets), `new SSEClient(scope, apiClient, logger)`, connects against `apiClient.getStreamBaseUrl()` (not the REST base) using `CONSULTATION_ENDPOINTS.LOOP_STREAM(id)` and `loopEventsScopeFor(id)` (new constants, mirroring `LIVE_SUMMARY_STREAM`/`liveSummaryScopeFor`).
- **Differs from `useArcaLiveSummary` on purpose**: the loop stream is an APPEND-ONLY feed of discrete `LoopEvent`s (no full-state snapshot, no terminal `closed` event, mirrors `consultation:trajectory:{id}` server-side), so the hook keeps an `events: LoopEvent[]` log (capped at 500 entries) plus `latestEvent`, rather than folding into one snapshot. It also filters out the stream's `{ type: 'heartbeat', ts }` pings (the same `merge(relay$, heartbeat$)` shape the trajectory/loop routes share server-side) so only real `LoopEvent`s enter the log.
- **The doc comment states, explicitly**: `SSEClient` has NO `Last-Event-Id`/cursor mechanism — a reconnect (auto or manual) mints a fresh single-use ticket and opens a brand-new `EventSource`; events published while disconnected are gone, because this stream deliberately carries no server-side buffer (no snapshot/fold/late-join, same as the trajectory stream it mirrors). The 200-message resume buffer elsewhere in this SDK belongs to the WebSocket TRANSCRIPT path only — this hook says so rather than letting a consumer assume otherwise.

### 4.4 Additive-only verification, per named shared module

| Module | What changed | Why it's additive |
|---|---|---|
| `src/core/AgenticClient.ts` | +1 public method, `postWithHeaders<T>` | Every existing method (`get`, `post`, `patch`, `patchWithIfMatch`, `getWithEtag`, ...) has the IDENTICAL signature and behaviour. `postWithHeaders` is new surface, not a change to existing surface. |
| `src/core/SSEClient.ts` | **Zero changes** | Not touched at all — `useConsultationEvents` uses the existing public `connect`/`onMessage`/`onOpen`/`onError`/`disconnect` API exactly as `useArcaLiveSummary` does. |
| `agenticStore` selectors | +1 state field (`consultationSchema`), +1 action (`setConsultationSchema`), +1 selector (`selectConsultationSchema`) | Every existing selector/action keeps its exact signature. `clearTenantSessionData`/`clearOnLogout` gained one more field in the object they already `set()` — their own signatures (`() => void`) are unchanged. |
| `src/types/*` — `AgenticConfig`, `Consultation`, `AudioProcessingConstraints` | **Zero changes** | Not touched. (`ContextItem`/`AddContextInput` — NOT on this named list — gained optional fields; see the general additive-only rule below.) |
| `useArcaAudio` | **Zero changes** | Not touched at all. |
| `useArcaSession` | Internal `addContext` implementation gained a validation branch + a conditional `postWithHeaders` call | The hook's PUBLIC signature — `UseArcaSessionReturn` (`open`, `addContext: (input) => Promise<ContextItem>`, `getSharedContext`, ...) — is byte-identical. `AddContextInput` gained optional fields only. |

General additive-only rule applied beyond the six named modules: `ContextItemType` gained two new union MEMBERS (never removed one); `ContextItem`/`AddContextInput`/`ContextActions.addAttachment` gained optional fields/a trailing optional parameter only.

### 4.5 Why `definition.kinds[]` and the payload validator are hand-written, not `valibot`

Both are runtime-authored documents (a tenant's schema, and the payload a user submits against it) — nothing for a static-schema builder to compile against ahead of time. Wrapping either in a general-purpose JSON Schema library would let the CLIENT silently accept schema/payload shapes the SERVER's authoring gate explicitly forbids (`if`/`then`/`else`, undiscriminated `oneOf`), which is worse than a client that doesn't validate those cases at all. `contextPayloadValidation.ts` is therefore a direct, dependency-free PORT of the server's `json-schema-subset.ts` `jsonSchemaValueProblems` — same supported keyword set (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `min/maxLength`, `pattern`, `minimum`, `maximum`, `min/maxItems`, `anyOf`, `allOf`, discriminated `oneOf`), same semantics, so a payload this evaluator accepts is a payload the server accepts too. `valibot` is used everywhere it correctly applies: the STATIC discovery-bundle envelope (`parseConsultationSchemaBundle`).

### 4.6 One pre-existing test fixed (URL-substring collision, not a regression)

`AgenticProvider.task297.test.ts`'s DEF-H5 test asserted `/tenant/me/config` is fetched exactly once, using `url.includes('/tenant/me')` as its match — which now ALSO matches the new sibling `/tenant/me/context-schema` endpoint, double-counting. Narrowed the check to `/tenant/me/config` specifically (and added an explicit branch for `/tenant/me/context-schema`) — the test's actual intent (dedup of the CONFIG fetch) is unchanged and still verified; it just no longer conflates two different endpoints that happen to share a path prefix.

### 4.7 Decisions worth reviewing

| # | Decision | Reasoning |
|---|---|---|
| D-1 | `STRUCTURED` added to `ContextItemType` even though the ticket text names only `SIGNED_NOTE` | `STRUCTURED` is the platform primitive `kindKey`/`payload` exist to serve (TASK-658) and was ALSO missing from the client union (the server enum has carried it since TASK-658). Both additions are equally safe (the union already accepted any string via `\| string`) and equally in-scope for "the client discovers the schema and builds against it." |
| D-2 | Mount-time schema fetch does NOT pass `departmentId`, even though the discovery endpoint accepts one | `me.departmentId` isn't known until `/auth/me` resolves INSIDE `init()`, but the ticket explicitly asks the fetch to be cached in the ref "exactly as `ModelRegistry.loadTenantConfig`" — which ALSO fetches without any department scoping, at the same point in the mount sequence. A tenant-scoped-default bundle is a safe, fully valid discovery result; department-scoped preference is a documented simplification, not a silent gap — `fetchConsultationSchema` already accepts an options bag so a follow-up can wire it once `me.departmentId` matters enough to justify a second request in the mount path. |
| D-3 | `X-Context-Schema-Version` is sent on EVERY write once a schema is pinned, not only when `kindKey` is present | TASK-661: the server ignores the header entirely when `request.kindKey` is absent (K7). Sending it unconditionally is simpler than conditioning on `kindKey` and is provably harmless — proven directly in `useArcaSession.contextSchema.task665.test.ts`. |
| D-4 | `useConsultationEvents` keeps a capped 500-entry log instead of "latest only" (unlike `useArcaLiveSummary`) | The loop stream publishes discrete EVENTS (action started/finished, specialist dispatched), not full-state snapshots — folding to "latest only" would drop information a consumer legitimately wants (an event timeline), unlike the live-summary stream where the server already sends the complete resolved state each time. |
| D-5 | `types/consultation.ts` was left untouched | Verified it already imports (not re-declares) `AddContextInput` from `context.ts` — the execution-plan's description of this file was stale. See §2 "types/consultation.ts re-declaration claim." |

---

## 5. Verification Evidence

All commands run from the worktree at `dev-2.1` @ `5a675d3d5`. Per execution-plan §1.1b, workspace deps were built first: `pnpm install` → `pnpm --filter @arcaai/room --filter @arcaai/noise-filter --filter @arcaai/vad --filter @arcaai/stt --filter @arcaai/med-ner build` → (for the compat-playground gate) `pnpm --filter @arcaai/ui build`.

### `pnpm --filter @arcaai/vox build`

```
CJS dist/index.js     849.20 KB
ESM dist/index.mjs     837.85 KB
...
> tsc -p tsconfig.json --emitDeclarationOnly --declaration
(clean — exit 0)
```

### `pnpm --filter @arcaai/vox test`

```
 Test Files  263 passed (263)
      Tests  4173 passed (4173)
```

**Baseline comparison**: **255 files / 4,131 tests** → **263 / 4,173** (+8 files, +42 tests, all new — 8 new test files, plus 2 tests fixed/rewritten in place in `AgenticProvider.task297.test.ts` with no net file-count change there).

### `pnpm --filter @arcaai/vox lint`

```
/…/hooks/useArcaConfig.ts
  269:0  warning  Unexpected unlimited 'eslint-disable-next-line' comment...
/…/providers/AgenticProvider.tsx
  733:0  warning  Unexpected unlimited 'eslint-disable-next-line' comment...
  950:0  warning  Unexpected unlimited 'eslint-disable-next-line' comment...

✖ 3 problems (0 errors, 3 warnings)
```

All 3 warnings are PRE-EXISTING (`useArcaConfig.ts` untouched by this ticket; `AgenticProvider.tsx`'s two disable comments predate this ticket — they moved line numbers because of the code inserted around them, but the comments themselves are unmodified). Zero new warnings, zero errors.

### `pnpm --filter @arcaai/vox typecheck`

```
> tsc --noEmit
(clean — exit 0)
```

### `apps/compat-playground` build (AC-9 / the ticket's named verification step)

```
$ pnpm --filter @arcaai/ui build      # dependency — compat-playground resolves @arcaai/ui's package entry
(clean — exit 0)

$ pnpm --filter compat-playground build
✓ built in 15.53s
(exit 0; only Rollup's informational >500kB chunk-size notices, no errors)
```

### `apps/compat-playground` test (not a required gate, run anyway as a regression check)

```
 Test Files  21 passed (21)
      Tests  223 passed (223)
```

Matches the stated baseline (223 compat-playground tests) exactly — zero change, confirming the additive-only changes to the six shared modules broke nothing compat depends on.

### AC → test map

| AC | Test | File |
|---|---|---|
| AC-1 (mount fetch, cached, awaited before `configReady`) | "fetches the schema once at mount and resolves it BEFORE configReady flips" | `AgenticProvider.consultationSchema.task665.test.ts` |
| AC-2 (replicated on tenant switch) | "is REPLICATED on a same-tab tenant switch — cleared synchronously, then re-fetched for the incoming tenant" | `AgenticProvider.consultationSchema.task665.test.ts` |
| AC-3 (pinned version; header on writes) | "sends X-Context-Schema-Version when the session has a pinned schema" + "with no pinned schema, behaves exactly as before" | `useArcaSession.contextSchema.task665.test.ts` |
| AC-3 (session keeps pin, doesn't silently upgrade) | "the session keeps its pinned version when the tenant 'publishes a new one' mid-session (no re-fetch without a switch)" | `AgenticProvider.consultationSchema.task665.test.ts` |
| AC-4 (`mediaId`/`kindKey`/`payload`, `SIGNED_NOTE`) | type-level — enforced by `pnpm typecheck`; behaviourally exercised by the addContext/addAttachment tests below | `src/types/context.ts` (no dedicated test file — types-only change) |
| AC-5 (`addAttachment` forwards `mediaId`) | "forwards mediaId on the POST body when supplied" + "omits mediaId... when the caller does not supply one" | `useArcaContext.addAttachment.task665.test.ts` |
| AC-6 (loop event stream hook) | 8 cases (idle/connect/append/heartbeat-filter/malformed/error/stop/teardown-before-restart) | `useConsultationEvents.test.ts` |
| AC-8 (additive-only) | `postWithHeaders` is new-surface-only | `AgenticClient.postWithHeaders.test.ts` |
| AC-9 (compat-playground builds) | `pnpm --filter compat-playground build` exit 0 | — (build gate, §5 above) |
| AC-10 (valibot, no Ajv/Zod) | envelope parsing via `v.object`/`v.safeParse` | `ConsultationSchemaClient.test.ts` (`package.json` unchanged — no new dependency added, verified via `git diff package.json`) |
| TDD-1 (unknown kind ignored) | "is valid (nothing to check) when the kindKey is not declared..." + "TDD: an unknown kindKey is ignored gracefully..." | `contextPayloadValidation.test.ts`, `useArcaSession.contextSchema.task665.test.ts` |
| TDD-2 (payload validated before send) | "validates a payload client-side and rejects before the request is sent" | `useArcaSession.contextSchema.task665.test.ts` |

`git diff --stat packages/agentic-sdk-v2/package.json` — empty (no dependency added).

---

## 6. Incomplete / explicitly out of scope

- **Department-scoped discovery preference** at mount is not wired (D-2) — the fetch resolves the tenant-scoped default only. `fetchConsultationSchema`'s `{ departmentId? }` option exists for a follow-up.
- **No response-level `versionSkew` surface for the SDK to render** — TASK-661 explicitly deferred that server-side (its §6 "Incomplete"); nothing exists yet for this ticket to consume. The session's pin is still correctly sent and never silently swapped (§4.2), which is the safety property that actually matters.
- **No admin-console consumer of `useConsultationEvents`** — that is TASK-666/667's surface (context schema editor / agent configuration form), unaffected here.
- **`useArca()`'s aggregate `context` object does not expose `addAttachment` at all** (pre-existing gap, `useArca.ts`'s `UseArcaContext` interface lacks it even though the focused `useArcaContext()` hook has it) — noticed while implementing AC-5, NOT fixed here: out of scope for this ticket (not named in the spec, and fixing it would touch `useArca.ts`'s aggregate wiring beyond "thread `mediaId` through `addAttachment`").

---

## Change History

- 2026-08-12 — Ticket opened from the TASK-654 execution-plan spec. Worktree reset from a stale local branch to `dev-2.1` @ `5a675d3d5`. Read TASK-658/660/661's READMEs and code before writing any test — confirmed the discovery bundle shape, the `X-Context-Schema-Version` header contract, the loop-stream route/scope, and that `SSEClient` has no resume mechanism.
- 2026-08-12 — Implemented in stages: types + core validator/client + `AgenticClient.postWithHeaders` → store slice + `AgenticProvider` mount/tenant-switch wiring → hooks (`useConsultationSchema`, `useConsultationEvents`, `addContext`/`addAttachment` changes) + barrels → 8 new test files + 1 pre-existing test fixed (URL-substring collision, §4.6). All gates green; `apps/compat-playground` build + test both green. Status **Review**. Not merged, not pushed.
