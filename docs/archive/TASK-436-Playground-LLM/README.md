# TASK-436 — Playground: LLM Playground (frame 54)

- **Status**: Review
- **Type**: feature — screen `/playground/llm` in `apps/admin-console`
- **Created**: 2026-07-06
- **Parent**: TASK-420 row 38 (matrix + approved frame `54 - LLM Playground`); foundation TASK-431

## Requirement Analysis

Summarization/LLM demo over the `text/*` SMR proxy (responses are the Python SMR Pydantic shapes passed through verbatim):

- **Prompt editor**: prompt + system prompt, provider+model picker (`GET /text/providers` → `{ name, models[{name,size}], is_available, is_default?, default_model? }[]`; guardrail list `GET /text/guardrail-providers`), temperature/max-tokens controls, stream-vs-sync switch.
- **Generate**: `POST /text/generate` (`{ prompt, system_prompt?, provider?, model?, temperature?, max_tokens?, stream?, response_format?, context? }`). Sync → `GenerateResponse` (`content`, `usage`, `latency_ms`, `finish_reason`). Stream → `{ task_id, stream_url }` then SSE `GET /text/tasks/:taskId/stream` (frames `chunk/meta/done/error/usage`), streaming output pane with caret + TASK RUNNING chip, cancel (`POST /text/tasks/:taskId/cancel`), task status read (`GET /text/tasks/:taskId`).
- **Assembled mode panel**: `POST /text/generate/assembled` (`{ type: 'pre-summary'|'summary', visit_type?, context_item_ids?|message?, prompt_template_id?, dna_writing_style_id?, …, debug? }`); `debug: true` requires GLOBAL_ADMIN/TENANT_ADMIN → admin-only debug chip + `_debug` assembly-meta display.
- **Designed error states**: model omitted → tenant HarnessPolicy cascade, else SMR fail-closed **422**; `?tenantKey=__GLOBAL__` catalog only for GLOBAL_ADMIN (403 otherwise; note on the providers pane).
- Working tenant drives catalog + fallback (`<WorkingTenantGate>` for elevated admins). State variants: loading/empty/error/NoTenant; light + dark.

## SSE transport decision (verified 2026-07-06)

The earlier assumption ("SSE via `useEventStream` — plain authorize pass-through") is **wrong** and is corrected here:

- `GET text/tasks/:taskId/stream` (`apps/api/src/modules/streaming/smr-proxy.controller.ts` — `streamTaskEvents`) carries `@Authorize()` only, **no `@StreamScope`**.
- `JwtAuthGuard.handleTicketAuth` (`apps/api/src/guards/jwtauth.guard.ts`) consumes the single-use ticket, then reads the route's `STREAM_SCOPE_METADATA`; when absent it throws `UnauthorizedException('Ticket authentication not allowed on this route')`. The `@StreamScope` decorator doc states the same: "Routes WITHOUT `@StreamScope` cannot be opened via `?ticket=`".
- The shared `useEventStream` hook always mints a scoped ticket and connects to `publicEnv.apiHost` with `?ticket=` — it can therefore **never** authenticate against this route.
- **Chosen transport**: same-origin `EventSource('/api/hope/text/tasks/<taskId>/stream')` through the BFF catch-all proxy with cookie auth. `src/server/hope-proxy.ts` attaches the bearer token server-side and returns `new Response(gatewayResponse.body, …)` — the SSE body streams through, with `content-type: text/event-stream` on the forwarded-headers allowlist.
- **Replay caveat**: the proxy's request-header allowlist does not forward `Last-Event-ID` (and SMR's `stream.py` reads `last_event_id` from the query string anyway), so every (re)connect replays the task's chunk log from `0-0`. The feature hook (`use-task-stream.ts`) resets accumulated content on `open`, suppresses native auto-retry, and exposes an explicit `reopen()` — matching the frame's designed "SSE drop → reattach stream" state.
- **`error` event collision**: SMR names its failure frame `error`, which lands on the same event type as the transport's error. Frames carry a `data` string; connection errors do not — the hook disambiguates on that.

## Implementation Plan

1. Failing tests first (RED): `api/__tests__/playground-llm-api.test.ts` (client paths/keys), `api/__tests__/use-task-stream.test.tsx` (FakeEventSource: proxy URL + no ticket mint, chunk fold, done/error frames, transport drop + reopen replay), `components/__tests__/playground-llm-screen.test.tsx` (providers picker availability/default, sync render content+usage, stream flow + cancel, 422 fail-closed panel, assembled debug gating, NoTenant gate).
2. Feature `src/features/playground-llm/`: `api/{types,keys,client,hooks,use-task-stream,index}.ts` (snake_case SMR DTOs verbatim) + `components/{playground-llm-screen,prompt-editor-card,assembled-panel,output-pane,providers-card}.tsx` over `WorkingTenantGate` + `ScreenTemplate`/`PageHeader`/`StatusFooter`.
3. Routes `src/app/(console)/(playground)/playground/llm/{page,loading}.tsx` (thin server page + skeletons).
4. Verify: `pnpm --filter @arcaai/admin-console test -- src/features/playground-llm` green; scoped eslint `--max-warnings 0`; `check-types`.

## Implementation Summary

TDD (RED → GREEN): the three test files were written first and failed with unresolved-module errors (`Test Files 3 failed (3) / Tests no tests` — `../client`, `../use-task-stream`, `../playground-llm-screen` did not exist), then the implementation brought them green without touching the tests.

### Files created

| File | Purpose |
|---|---|
| `src/features/playground-llm/api/types.ts` | SMR wire DTOs **verbatim snake_case** (`SmrProvider`, `GenerateTextRequest/Response`, `StreamingGenerateAck` + `isStreamingAck` guard, `AssembledGenerateRequest/Response` + `_debug` meta, `SmrTask`, `SmrStreamFrame`) |
| `src/features/playground-llm/api/keys.ts` | Query keys: providers/guardrail catalogs keyed by `tenantKey` (`__GLOBAL__` vs tenant), per-task post-mortem key |
| `src/features/playground-llm/api/client.ts` | `listProviders`, `listGuardrailProviders`, `generateText`, `generateAssembled`, `getTask`, `cancelTask` via `getJson`/`postJson`; `taskStreamProxyUrl()` builds the **same-origin BFF SSE URL** (transport decision above) |
| `src/features/playground-llm/api/hooks.ts` | `useSmrProviders`, `useSmrGuardrailProviders`, `useSmrTask` (post-mortem finalizer: gated by `enabled`, polls every 2s while the dropped task is non-terminal, stops on `completed/failed/cancelled`), `useGenerateText`, `useGenerateAssembled`, `useCancelTask` |
| `src/features/playground-llm/api/use-task-stream.ts` | Cookie-auth `EventSource` over the BFF proxy: folds `chunk`/`usage`/`done` frames, disambiguates upstream `error` frames (data string) from transport drops (bare Event), suppresses native auto-retry, `reopen()` reattaches (0-0 replay seeds a fresh accumulation), `close()` is the local cancel stop. State is connection-keyed and only written from EventSource callbacks/user actions (satisfies `react-hooks/set-state-in-effect`) |
| `src/features/playground-llm/api/index.ts` | Barrel |
| `src/features/playground-llm/components/playground-llm-screen.tsx` | `'use client'` screen: `WorkingTenantGate` → `ScreenTemplate` + `PageHeader` (h1, Generate action) + **request-summary strip** in the `statusBanner` slot (effective provider/model or the cascade-omitted note, temp, max-tokens, stream-vs-sync, live task id) + `StatusFooter` (aria-live status line). Owns form state, provider/model cascade (`is_default` → `default_model`, derived — no effects), run state (`idle/sync/stream/fail-closed`), 422 fail-closed routing (panel, **no toast**), generic `GatewayError` → sonner toast, cancel → `POST :taskId/cancel` then local stream close, retry re-fires the last request |
| `src/features/playground-llm/components/prompt-editor-card.tsx` | Prompt/system textareas, provider+model `NativeSelect`s (unavailable options disabled, explicit **"Omit — tenant default (cascade)"** model option that drops `model` from the body), empty-catalog fallback note (no picker → provider/model omitted), temperature **native range input** + max-tokens input, streaming/assembled switches, assembled panel (type/visit_type selects, message OR context-item-IDs with exactly-one hint, template/DNA IDs, admin-only `Debug assembly` switch) |
| `src/features/playground-llm/components/output-pane.tsx` | Streaming pane (live append + caret, `Task running`/`Done`/`Failed`/`Dropped`/`Cancelled` chips, token-count chip, Cancel), sync result (content, usage, `latency_ms`, `finish_reason`, provider·model), `Debug` chip + collapsible assembly-meta panel, designed 422 fail-closed panel with Retry, transport-drop panel with post-mortem task read + `Reattach stream`; when the dropped task **completed upstream** the post-mortem read finalizes the pane instead (full recovered content, Done chip, usage, "recovered via GET /text/tasks/:taskId" note — no reattach) |
| `src/features/playground-llm/components/providers-card.tsx` | Provider + guardrail catalogs (availability/default badges, model lists), refresh action, elevated-only `__GLOBAL__` switch with 403 gate note, HarnessPolicy-cascade footnote |
| `src/features/playground-llm/api/__tests__/playground-llm-api.test.ts` | Client paths/methods/bodies, keys, `isStreamingAck`, proxy URL encoding (8 tests) |
| `src/features/playground-llm/api/__tests__/use-task-stream.test.tsx` | FakeEventSource: BFF URL + **no ticket mint/fetch**, chunk/usage/done folding, upstream-error vs transport-drop mapping, reopen 0-0 replay reset, close(), idle/teardown (5 tests) |
| `src/features/playground-llm/components/__tests__/playground-llm-screen.test.tsx` | NoTenant gate (no `text/*` calls), session-loading skeleton, providers picker (default preselect, disabled unavailable), sync generate (exact body + content/usage/latency/finish render), stream flow (SSE chunks append, usage/done finalize, no stream-ticket), cancel, 422 panel + retry, transport drop + post-mortem + reattach, empty-catalog cascade fallback (no picker, provider/model omitted from body), model omit option (drops `model` from body), request-summary strip (settings + live task id), dropped-stream finalization from a completed post-mortem read, assembled debug gating (hidden for DOCTOR; `debug: true` + chip + meta for admins), `__GLOBAL__` switch (elevated-only, refetch with `tenantKey`) (16 tests) |
| `src/app/(console)/(playground)/playground/llm/page.tsx` | Thin Server Component (metadata + screen) |
| `src/app/(console)/(playground)/playground/llm/loading.tsx` | Route skeleton mirroring the three-pane layout |

### Design/plan deviations

- The planned separate `assembled-panel.tsx` is folded into `prompt-editor-card.tsx` (it is a conditional section of the same form, not an independent component).
- Temperature uses a **native `<input type="range">`** instead of the shadcn `Slider`: the Radix single-thumb slider exposes no accessible name on the thumb, the native control does (WCAG), matching the `NativeSelect` precedent.
- No shared-file changes were needed (no "Needs" items); everything stayed inside the TASK-436 ownership boundary.

### Evidence (2026-07-06, after the frame-54 QA pass)

`pnpm exec vitest run src/features/playground-llm` (feature-scoped; the bare `test --` form runs the whole app suite):

```text
 Test Files  3 passed (3)
      Tests  29 passed (29)
   Duration  4.73s
```

`pnpm --filter @arcaai/admin-console lint` (`eslint src --max-warnings 0`) → **clean** (exit 0).

`pnpm --filter @arcaai/admin-console check-types` (`tsc --noEmit`) → **clean** (exit 0; the earlier TASK-432 `@arcaai/vox` error is resolved in the tree).

Playwright E2E + axe + design QA against the running app are deferred to the TASK-420 integration pass.

## Change History

| Date | Change |
|---|---|
| 2026-07-06 | Ticket created from TASK-420 (frames approved 2026-07-06). |
| 2026-07-06 | Verified SSE transport against gateway guard code; corrected plan from `useEventStream` (ticket) to same-origin BFF cookie-auth `EventSource` (see decision section). |
| 2026-07-06 | Implemented feature (api layer + stream hook + 3 components + routes) TDD RED→GREEN: 25/25 tests, scoped eslint clean, check-types clean for owned files. Status → Review. |
| 2026-07-06 | Frame-54 QA pass (TDD, +4 tests → 29): empty-catalog cascade fallback (picker hidden, provider/model omitted from body), explicit model-omit option, request-summary strip in the `statusBanner` slot (settings + live task id), dropped-stream finalizer (`useSmrTask` polls non-terminal tasks every 2s; a completed post-mortem read renders the recovered content/usage with a Done chip and retires the reattach affordance). Full-package lint + check-types now clean. |
| 2026-07-08 | Design-alignment pass against the approved template (`templates/pg-llm/PgLlm.dc.html`): shared `PlaygroundBanner` stacked above the request-summary strip in the `statusBanner` slot; header subtitle aligned to "Compose → run → stream · runs under your own account"; header primary action renamed **Run** (IconPlayerPlay kept); pane titles aligned to **Prompt** / **Response**; empty-output copy updated to reference Run. Kept deviations (not drift): the 3-pane layout (prompt / response / providers card) and the assembled-mode panel are intentionally richer than the template's 2-pane sketch (backend-required); the template's "guardrail: pass" chip is not implemented — generate responses carry no guardrail verdict. Feature tests 29/29 green, scoped eslint clean. |
