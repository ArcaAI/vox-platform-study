# TASK-971 — Integration examples for a published agent or workflow

| Field | Value |
|---|---|
| Status | **Review** — all six lanes merged on `dev-2.2` and gated; the §3.2 runtime pass is the one outstanding criterion (it needs an authenticated console session) |
| Type | `feature` (+ one `bugfix` lane, A) |
| Branch | `dev-2.2` |
| Depends on | TASK-965 WS-1 (`shared/versioning/IntegrationPanel`, commit `fb0971e9e`) |
| Collides with | **TASK-965 WS-3** ("shared `shared/versioning/` kit") — same directory. Serialize; never run both in parallel worktrees. |

---

## 1. Requirement Analysis

> "when publishing an agent or a workflow, it should show several examples: using Vox-node SDK,
> using Vox SDK, calling APIs directly with step-by-step/detailed instruction setup, with postman
> examples. lets review and update the admin-console."

Four integration lanes on the surface a tenant admin reaches at publish time, and a step-by-step
setup deep enough that a developer who has never seen HOPE can make a first successful call.

### Owner decisions (2026-09-13)

| # | Decision |
|---|---|
| OD-1 | **New ticket**, not a TASK-965 workstream. The `shared/versioning/` overlap with 965's WS-3 is recorded in both READMEs and the two are serialized. |
| OD-2 | **The gateway OpenAPI defects are IN SCOPE** (lane F). Without them the API reference contradicts the panel two clicks away. |
| OD-3 | **Browser lane defaults to a session JWT**, with the API-key variant shown below it and its exposure tradeoff stated. The SDK documents API-key-only browser use for this exact route; the console will not lead with it. |
| OD-4 | **Postman: generated collection in the panel AND a walkthrough on the developer portal.** |

### Non-goals

- No "Try it" / live-fire button. Owner decision D-3 of the API-reference ticket turned Scalar's
  HTTP client off precisely so the console never sends real requests as the signed-in operator
  against real tenant data. A generated Postman collection is the sanctioned alternative: it moves
  execution into the developer's own tool, under their own key.
- No new invoke routes, no SDK API changes. Lane A fixes a snippet that names a method which does
  not exist; it does not add one.

---

## 2. Current State Evaluation

### 2.1 What the console shows today

`IntegrationPanel` (`apps/admin-console/src/shared/versioning/integration-panel.tsx`, 258 lines)
is rendered in exactly four places:

| Surface | Line |
|---|---|
| Agent publish dialog | `features/agents/components/agent-publish-dialog.tsx:52` |
| Agent drawer → Integration tab | `features/agents/components/agent-detail.tsx:688` |
| Workflow publish dialog | `features/workflow-studio/components/publish-dialog.tsx:52` |
| Studio header → Integration dialog | `features/workflow-studio/components/workflow-studio-editor.tsx:1385` |

It offers **one lane**: an endpoint line, a `@arcaai/vox-node` snippet, an `/api-keys` link.

### 2.2 Lane coverage vs. what actually exists

| Lane | Agent TEXT_GEN / NER | Agent SPEECH_TO_TEXT | Agent TEXT_TO_SPEECH | Workflow |
|---|---|---|---|---|
| `@arcaai/vox-node` | present, correct | present, correct | present, correct | **present, BROKEN (F-A1)** |
| `@arcaai/vox` (browser) | missing | **no path by slug** | **no path by slug** | missing |
| Direct HTTP | missing | missing | missing | missing |
| Postman | missing | missing | missing | missing |

Two cells are genuine absences in the browser SDK and must be rendered as such, never invented:

- `AGENT_ENDPOINTS.SPEECH(slug)` (`packages/agentic-sdk-v2/src/core/constants.ts:799`) and
  `AGENT_ENDPOINTS.TRANSCRIBE(slug)` (`:801`) have **zero browser callers**.
- TTS in the browser goes through `useTtsPlayback` / `useTtsStream`, which select by `voice` id
  against the legacy `SPEECH_ENDPOINTS.SYNTHESIZE = '/speech/synthesize'` (`constants.ts:154`).
- Batch STT goes through `FileTranscriptionService.uploadAndTranscribe`, which posts `pipelineId`
  to `/audio/transcription-jobs/transcribe` (`constants.ts:344`, `FileTranscriptionService.ts:86-89`).
- Realtime STT is `audio.start({ agentSlug })` — a capture session, not an invocation.

### 2.3 Findings

| # | Sev | Finding | Evidence |
|---|---|---|---|
| **F-A1** | **P1** | The workflow snippet shown after publishing **cannot run**. `hope.workflows.runs.create(...)` — `WorkflowsResource` has no `runs` sub-resource; its methods are `run` / `runAndWait` / `runAndStream` / `getRun` / `cancelRun` / `streamRun` / `waitForRun`. | `sdk-snippets.ts:47-57` vs `packages/vox-node/src/resources/workflows.ts:583-691` (verified: `grep "readonly runs"` → 0 matches) |
| **F-A2** | **P1** | The same snippet's client **throws at construction**: `CLIENT_KEY_ONLY` omits `baseUrl`, which `HopeClient` requires. | `sdk-snippets.ts:30` vs `packages/vox-node/src/client.ts:161-163` |
| **F-B1** | P1 | The real input shape is fetched and discarded. `GET workflows/{slug}/schema` returns `components["Workflow_<slug>_Input"]`, `triggerKinds`, `protocols`, `asyncapi`; the panel reads `modes` only. | `integration-panel.tsx:150-152` vs `workflow-schema-description.ts:38-51` |
| **F-B2** | P1 | `agent.inputSchema` / `outputSchema` are already on the console type and unused by the panel. | `features/agents/api/types.ts:155-156` |
| **F-C1** | P1 | **Flat vs enveloped body is undocumented anywhere a developer will look.** `POST /agents/{slug}/invocations` takes `{ text, variables?, context? }` **flat**; `POST /workflows/{slug}/runs` takes `{ input: {...} }`. Getting it backwards was a 400 on *every* call. | `packages/vox-node/src/resources/agents.ts:127-133`; `invoke-workflow.request.ts` |
| **F-C2** | P2 | NER shares the invocations route but is one-shot: `?mode=stream` is **400 `MODE_UNSUPPORTED`**. The panel already suppresses the stream note; no lane may offer a NER stream example. | `apps/api/src/modules/agent/agent.controller.ts:434-438` |
| **F-C3** | P2 | Agent routes are bare `@Authorize()` (no CASL ability); workflow routes require one (`@CanCreate('WorkflowRun')`). A tenant JWT user can invoke an agent and still get **403** starting a workflow. The panel's single copy line cannot express this. | `agent.controller.ts:247` vs `workflows.controller.ts:110` |
| **F-C4** | P2 | The browser never starts a workflow with `?mode=` — it starts async and watches. An example that copies the server lane would be wrong. | `packages/agentic-sdk-v2/src/hooks/useWorkflowRun.ts:377-397` |
| **F-F1** | **P1** | **No `@ApiBody` on any agent invoke route**, so `openapi.json` carries **no request body** for the three routes the panel points at. Cause: the bodies are deliberately plain interfaces, not class-validator DTOs, so the Swagger plugin emits nothing. | `grep -c ApiBody agent.controller.ts` → **0**; `AgentInvocationBody` at `agent.controller.ts:76-86` |
| **F-F2** | **P1** | Per-operation `security` is `[{bearer},{bearer}]` on 179 business operations; `api-key` and `service-account` are registered as schemes but referenced by **zero** operations — although all three classes may call all six invoke routes. Cause: `@Authorize()` applies `ApiBearerAuth()` **and** 117 controllers carry a class-level `@ApiBearerAuth()`. | `swagger.config.ts:115-117`; `packages/applications/src/authorization/decorators.ts:67,92`; audited `openapi.business.json` |
| **F-E1** | P2 | The `@arcaai/vox` card on the SDK screen has an install line and a warning — **no example at all**. | `features/developer-docs/components/sdk-screen.tsx:85-101` |
| **F-E2** | P3 | No Postman artifact exists anywhere in the repo (searched case-insensitively; only three incidental prose mentions). Authored from scratch. | — |

### 2.4 Verified contract facts the examples must encode

| Route | Body | Modes | Credentials |
|---|---|---|---|
| `POST api/v1/agents/{slug}/invocations` | flat `{ text?, variables?, context?, … }` | `blocking` (default), `stream`; **NER: blocking only** | JWT / `X-API-Key` / `X-Service-Account-Token`; scope `agent:invocation:write` |
| `POST api/v1/agents/{slug}/speech` | `{ text? \| ssml? }` | — (streams `audio/*`) | same |
| `POST api/v1/agents/{slug}/transcriptions` | `{ mediaId, consultationId?, language? }` | — (201 + `sseUrl`) | same |
| `POST api/v1/workflows/{slug}/runs` | `{ input: {…} }` | `async` (default, **202**), `blocking` (200, **504** at 60s), `stream` | same; scope `workflow:run:write` **+ CASL `create:WorkflowRun` on the JWT path** |
| `GET api/v1/workflows/{slug}/runs/{runId}` | — | — | scope `workflow:run:read` |
| `POST api/v1/workflows/{slug}/runs/{runId}/stream-ticket` | — | — | scope `workflow:run:read`; returns `{ ticket, expiresAt, scope, url }` |

- `input` must not contain `consultationId, externalPatientId, userId, jobId, sessionId`
  (`RESERVED_RUN_IDENTITY_KEYS`) → 400.
- `X-Tenant-Id` is **never** sent with an API key or a service-account token — the tenant binds to
  the credential.
- SSE framing is real `event:` / `data:` / `id:` lines; `:keepalive` every 15 s; the workflow
  stream's first frame is a snapshot with no `id:`.
- `socket` is a **lane**, not a `?mode=` value.

---

## 3. Implementation Plan

Six lanes. A is blocking and lands first; F is independent of B–E and may run beside them.

### Lane A — snippet correctness (bugfix, blocking)

| Step | Work |
|---|---|
| A1 | `workflowVoxNodeSnippet` → `hope.workflows.runAndWait(slug, { input })` for blocking, `hope.workflows.run(...)` for async. Delete `CLIENT_KEY_ONLY`; every snippet constructs with `baseUrl`. |
| A2 | **NEW** `shared/docs/__tests__/sdk-snippets.drift.test.ts` — for every emitted snippet, assert each `hope.<resource>.<method>` it names exists on the real `@arcaai/vox-node` resource prototype. This is the test that would have caught F-A1/F-A2. |

### Lane B — schema-derived example bodies

| Step | Work |
|---|---|
| B1 | **NEW** `shared/docs/example-body.ts` — `exampleBodyFromJsonSchema(schema)`: deterministic minimal example honouring `required`, `default`, `enum`, `type`; returns `null` for an unusable schema so callers can fall back rather than print `{}`. |
| B2 | `IntegrationPanel` gains `inputSchema` / `outputSchema` props; both agent call sites pass `agent.inputSchema`. |
| B3 | Workflow lane stops discarding the schema response: read `components["Workflow_<slug>_Input"]` for the body, `triggerKinds` / `protocols` for the copy. |

### Lane C — four lanes in the panel

| Step | Work |
|---|---|
| C1 | `shared/docs/sdk-snippets.ts` grows `agentVoxSnippet`, `workflowVoxSnippet` (browser, JWT default + API-key variant per OD-3), `agentCurlSnippet`, `workflowCurlSnippet` (incl. the async→poll→stream follow-ups). |
| C2 | Panel renders `Tabs` (`TabsList variant="line"`): **Node · Browser · HTTP · Postman**. Each lane renders an example **or** explains its absence (browser lane for STT/TTS names the real path instead). |
| C3 | A callout carrying F-C1 (flat vs enveloped) and F-C3 (the workflow JWT ability) wherever it applies. |
| C4 | Hosting dialogs resize to rule 11 §3's "Large dialog (multi-tab)" row — `sm:max-w-[70vw]`, `h-[70vh]`, `flex flex-col`, scrolling body. The confirm step stays small; only the published step grows. |

### Lane D — Postman

| Step | Work |
|---|---|
| D1 | **NEW** `shared/docs/postman-collection.ts` — a pure builder → Collection v2.1: `baseUrl` + `apiKey` collection variables, collection-level `X-API-Key` auth, the invoke request with the derived body, and for workflows the status + stream-ticket follow-ups with a test script capturing `runId`. |
| D2 | Postman tab: download (Blob) + copy-JSON. **No credential is ever embedded** — `apiKey` ships as an empty collection variable. |

### Lane E — developer portal

| Step | Work |
|---|---|
| E1 | **NEW** route `/developer/invoke` — "Call a published agent or workflow": numbered setup (mint key → base URL → route → body → send → read errors), the per-route-family credential matrix (F-C3), the flat-vs-enveloped callout, the SSE framing, and the Postman import walkthrough (OD-4). Segment `loading.tsx` with skeletons. |
| E2 | Fill the empty `@arcaai/vox` card (F-E1) with a real `AgenticProvider` + `useAgentInvocation` example. |
| E3 | Nav entry in `shared/navigation/nav-config.ts` + its pinned-order test row. |

### Lane F — gateway spec truth (`apps/api`)

| Step | Work |
|---|---|
| F1 | `@ApiBody({ schema })` on `invocations` / `speech` / `transcriptions`. **Keep the plain interfaces** — converting to DTOs would break the deliberate pass-through that lets the agent's own `inputSchema` validate (TIER 3). |
| F2 | `@RequiredScopes(...)` also applies `ApiSecurity('api-key')`; `@RequiredSvcScopes(...)` applies `ApiSecurity('service-account')`; `@ForbidApiKey()` suppresses the former. Dedupe the `bearer` entry at emit time. |
| F3 | Regenerate **all five** artifacts: `api:build` → `api:route-manifest` → `api:openapi` → `api:portal` → `vox-node gen:admin`. |

### 3.1 TDD test list (RED first)

| # | Test | Asserts |
|---|---|---|
| T1 | `sdk-snippets.drift.test.ts` | every snippet's method exists on the real SDK resource — **fails today** (F-A1) |
| T2 | `sdk-snippets.drift.test.ts` | every snippet constructs `HopeClient` with `baseUrl` — **fails today** (F-A2) |
| T3 | `example-body.test.ts` | required/enum/default honoured; unusable schema → `null` |
| T4 | `integration-panel.test.tsx` | four tabs; agent body is **flat**, workflow body is **enveloped** |
| T5 | `integration-panel.test.tsx` | STT and TTS browser lanes state the absence and name the real path; no invented snippet |
| T6 | `integration-panel.test.tsx` | NER offers no stream example in any lane |
| T7 | `integration-panel.test.tsx` | workflow browser lane shows async-then-watch, never `?mode=` |
| T8 | `integration-panel.test.tsx` | derived bodies come from `inputSchema` / `components`, not a placeholder |
| T9 | `postman-collection.test.ts` | valid v2.1; vars present; **no credential embedded**; `runId` captured |
| T10 | existing axe assertions extended to the tabbed panel and the new portal page |
| T11 | `apps/api` — the three agent routes carry a `requestBody` in the emitted document |
| T12 | `apps/api` — `security` lists exactly the accepted classes, `bearer` once |

### 3.2 Verification criteria

- `pnpm --filter @arcaai/admin-console build lint test` green.
- `pnpm --filter @arcaai/api test` + `pnpm api:openapi:check`, `api:portal:check`,
  `--filter @arcaai/vox-node gen:admin:check` green.
- Runtime pass in a running console (`next-dev-loop`): publish an agent and a workflow as the
  seeded tenant admin, walk all four tabs, import the generated collection into Postman and make
  one successful call.
- Both themes; axe 0 violations on the panel and the new page.
- `packages/ui` untouched → no `pnpm --filter @arcaai/ui build` needed (unlike TASK-965 WS-1).

### 3.3 Risks

| Risk | Mitigation |
|---|---|
| TASK-965 WS-3 touches `shared/versioning/` | Serialize. Recorded in both READMEs. |
| Lane F rewrites ~179 operations in a 1.9 MB committed document | Large but mechanical diff; three drift gates prove it. Land F as its own commit. |
| A generated example that drifts from the SDK | T1/T2 pin every snippet to the real prototypes. |
| Multi-tab content in a dialog | Rule 11 §3 explicitly sizes "Large dialog (multi-tab, editor)"; the confirm step stays short. |

---

## 4. Implementation Summary

Six lanes: A in the primary checkout, B–F in four parallel worktrees, merged by the orchestrator
in dependency order. All worktrees merged and removed; no branch left behind.

| Lane | Commits | Outcome |
|---|---|---|
| A — snippet correctness | `bdbc0ddd9` | F-A1 + F-A2 fixed; `sdk-snippets.drift.test.ts` pins every snippet to the real `@arcaai/vox-node` prototypes (`@arcaai/vox-node` added as an admin-console devDependency) |
| D — Postman | `d453c053f`, merge `fad99e9ae` | Per-task agent routes, workflow follow-ups, `runId` capture script, deterministic output, no credential embedded. 35 tests |
| B+C — panel | `7e1a536b8`, merge `163fba329` | `example-body.ts`; four tabs (Node · Browser · HTTP · Postman); schema-derived bodies; named absences for the two browser cells that do not exist; dialog sizing per rule 11 §3 |
| — cross-lane fix | `51900f666` | See below |
| F — spec truth | `ffdd0f34e`, `6c3b52f42`, merge `7fa20ad0b` | F-F1 + F-F2 fixed |
| E — portal | `dd861b913`, `104ada30c`, merge `0951c0f6f` | `/developer/invoke`; the `@arcaai/vox` card filled; nav entry |
| — unrelated, to unblock CI | `e490ab445` | See below |

### Three defects found during integration that no lane owned

1. **`51900f666` — a NER agent's Postman collection shipped a request the gateway refuses.** The
   panel folds NER onto `TEXT_GENERATION` before calling `buildPostmanCollection` (they share the
   route), so the builder could not distinguish them and emitted the `?mode=stream` request NER
   answers with a 400 `MODE_UNSUPPORTED`. Lane D had anticipated it and added
   `isNamedEntityRecognition`; the call site was never told to pass it. **The first version of that
   test asserted `not.toContain('mode=stream')` and failed against correct code** — the surviving
   blocking request explains the rule in prose. Assert on PARSED requests, never a substring.
2. **`104ada30c` — lane E broke `next build`, and reported it as a pre-existing `packages/ui`
   defect.** It is not: the same worktree with the same `packages/ui/dist` builds clean at the base
   commit. `ScreenTemplate` and `StatusFooter` import `cn` from the `@arcaai/ui` BARREL, and
   `invoke-guide-screen.tsx` was the one developer-docs screen without `'use client'`, so it pulled
   `dist/index.mjs` into the Server Component graph.
3. **`e490ab445` — not this ticket.** `pnpm --filter @arcaai/api lint` was already red on `dev-2.2`
   from `ff0c74291` (TASK-969 L3): three prettier errors in `text-proxy.controller.ts`. Verified
   pre-existing on a checkout lane F never touched. Formatting only.

### The latent `packages/ui` defect behind defect 2 — since FIXED (`79224fcf2`)

`packages/ui/tsup.config.ts` sets an esbuild `banner` of `"use client"` that never reached the
emitted `js`/`mjs`, so the `@arcaai/ui` barrel could not safely be imported from any Server
Component by anyone. That is what made defect 2 possible rather than merely wrong.

**Cause — not what it looked like.** esbuild honours the banner; `treeshake: true` then discards
it. tsup's tree-shaking plugin runs every emitted chunk back through rollup, whose
`bundle.generate()` carries no banner, and rollup drops a top-level string-literal statement as
side-effect-free — announcing it in the build log ("Module level directives cause errors when
bundled, `use client` … was ignored"). Measured on tsup 8.5.1: treeshake on → 0 of the emitted
bundles kept the directive; treeshake off → `index.mjs` began with it. Neither an esbuild version
mismatch nor a `splitting` interaction, which were the two standing hypotheses.

**Fix.** tsup runs user `plugins` BEFORE its own tree-shaking plugin, so a plugin cannot restore
it. `packages/ui/scripts/ensure-use-client.mjs` runs after tsup in the `build` script, prepends the
directive to every bundle, and prepends a `;` to each sibling map's `mappings` so source maps stay
aligned. It exits non-zero if it finds no bundles — a silent no-op is how this would regress.

**Verified**: 24/24 bundles carry the directive; `grep -c "use client"` on `dist/index.mjs` and
`dist/index.js` returns 1 each; a Server Component importing the barrel now reaches
"✓ Compiled successfully" under `next build`, which it could not before; 756 `packages/ui` tests
pass.

With this fixed, the `'use client'` added to `invoke-guide-screen.tsx` in `104ada30c` is no longer
load-bearing — but it is kept, because every sibling developer-docs screen carries it and a screen
that renders `CodeBlock` (a client component) belongs on that side of the boundary anyway.

### Gates (post-merge, on `dev-2.2`)

| Gate | Result |
|---|---|
| `npx vitest run` (admin-console, full) | **337 files, 3201 tests passed** |
| `npx tsc --noEmit` (admin-console) | exit 0 |
| `npx eslint src --max-warnings 0` | exit 0 |
| `npx next build` (fully merged tree) | exit 0; `/developer/invoke` present (95 routes, was 94) |
| `pnpm --filter @arcaai/api test` | **4593 passed, 4 skipped** |
| `pnpm --filter @arcaai/api lint` | exit 0 (0 errors, 65 pre-existing warnings) |
| `pnpm api:portal:check` | no drift (admin 665 ops, business 200 ops) |
| `pnpm --filter @arcaai/vox-node gen:admin:check` | no drift (49 areas, 425 routes, 438 schemas) |
| `pnpm api:openapi:check` | OK |

Direct proof of lane F on the merged artifact:

```
POST /api/v1/agents/{slug}/invocations
  security    : [{"bearer"},{"api-key"},{"service-account"}]   (was [{bearer},{bearer}])
  requestBody : required, {context,text,variables}, additionalProperties: true  (was absent)
operations repeating a scheme: 0                               (was 179)
```

`route-manifest.json` and `packages/vox-node/src/resources/admin/**` regenerated
**byte-identical** — the proof that no authorization metadata and no SDK surface moved.

### Not done

- **The §3.2 runtime pass.** Publishing an agent and a workflow, walking all four tabs and
  importing a generated collection needs an authenticated tenant-admin session; the assistant does
  not enter passwords into login forms. The dev stack was up and healthy throughout (console 307 →
  login, gateway `/health` 200), so the merged code compiles and serves.
- **Two failures deliberately left alone**: `membership-bounded-sync.integration.test.ts` needs the
  live test DB the orchestrator owns; `parameters-form.test.tsx` was another session's uncommitted
  TASK-970 work mid-flight (it passes now that they committed, `05078144b`).

---

## 5. Change History

| Date | Entry |
|---|---|
| 2026-09-13 | Ticket opened. Two read-only explorations (public invoke contract; browser SDK surface) + direct verification of every P1. Owner decided OD-1…OD-4. Plan written; awaiting approval. |
| 2026-09-13 | Owner approved the plan. Lane A landed in the primary checkout; lanes B–F ran in four parallel worktrees (tiered opus/sonnet per rule 14 §1) and were merged in order postman → panel → openapi → portal, with gates re-run after each. Three integration defects found and fixed (§4). Status → Review; the runtime pass is the one criterion outstanding. |
| 2026-09-13 | Follow-up fixed in `79224fcf2`: the `@arcaai/ui` `"use client"` banner never reached `dist/` because `treeshake: true` sends every chunk back through rollup, which drops the directive. `scripts/ensure-use-client.mjs` restores it post-build (source maps realigned). 24/24 bundles verified; a Server Component importing the barrel now compiles. |
