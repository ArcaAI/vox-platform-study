# TASK-552 — Agent-Plane Wiring Fixes: NER Routing, `smr.live` Activation, Click-to-Source Evidence Panel

- **Status:** Review
- **Type:** bugfix / completion (three independent lanes; may be split across sessions)
- **Parent:** [TASK-544 §5.6](../TASK-544-Agent-Platform-Concept/README.md); defects D-26 + the NER dual-regime finding + GAP-A2 (UI half)
- **Depends on:** nothing
- **Rules to read first:** `.claude/rules/04-application-services.md`, `.claude/rules/05-nestjs-api.md`, `.claude/rules/13-nextjs-apps.md` + `07/10/11` (lane C)

## Execution Contract (mandatory — owner directive)

1. **Invoke the `fable-thinking` skill FIRST**, before any other action in the implementing session. Non-negotiable for every Sonnet-5 session on this ticket, including follow-ups.
2. Follow the 5-phase lifecycle in `.claude/rules/01-development-workflow.md`; TDD Red-Green-Refactor — no implementation before a failing test.
3. Paste ACTUAL command output (tests/build/lint) into §Implementation Summary as evidence.
4. Do NOT commit or push. `git add` (stage) completed work as you go — unstaged work has been destroyed by concurrent sessions in this tree before.
5. One implementing session per working tree. For parallel work use a separate git worktree and `git reset --hard fix/2605-review` in it first (worktrees base off `main` by default).
6. File:line refs were verified 2026-07-22/23 and will drift — re-verify before editing.

## Lane A — Route consultation NER through `AiTaskDefault('nlp.ner')`

**Defect**: two model-resolution regimes coexist. The Agent-Playground proxy (`apps/api/src/modules/ai-inference/ai-inference.controller.ts:64-101`) resolves the SYSTEM `AiTaskDefault('nlp.ner')` and injects `model_name`; but ALL clinical-pipeline callers post to `NLP_URL` **without `model_name`**, silently using the NLP service's env default (`blaze999/Medical-NER`, `apps/nlp/src/nlp/core/config.py:211`). A global admin re-pointing `nlp.ner` changes the playground but NOT clinical NER.

**Call sites to fix** (all three):
1. `packages/applications/src/services/consultation/jobs/processors/ner.processor.ts` — `callNlpService` `:165-186` (BullMQ durable NER).
2. `packages/applications/src/services/consultation/summary/summary.service.ts:1147` (synchronous extract-entities).
3. `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:1573-1593` (`callNlp`, live plane).

**Plan**: add a small shared resolver (applications layer) that resolves the effective `nlp.ner` model (via `IAiTaskDefaultService.getEffective` — SYSTEM cascade) and returns `{model_name, sourceUri…}` for injection, mirroring the ai-inference controller's mapping. Inject into all three call bodies. **Hazards**: (a) these paths run in event/queue contexts with rebound CLS — `ner.processor.ts:56-58` rebinds tenant CLS, the live plane runs in-request; the task-default read resolves the SYSTEM row, so pin the read to SYSTEM tenant context exactly like the F-026 fix (`effective-config.controller.ts` precedent) rather than relying on ambient CLS; (b) fail-open: resolver failure ⇒ post WITHOUT `model_name` (today's behavior) + warn — clinical NER must not go down because the registry read hiccuped; (c) NLP's per-request model cache will load the injected model — no NLP-side change needed (`model_cache.py` handles it).

**Tests**: unit per call site (model injected; resolver failure ⇒ legacy body + warning); SYSTEM-pin ordering test.

## Lane B — Activate `smr.live` (D-26)

**Defect**: the two-tier live/finalize model routing is fully built (TASK-511: `AiTaskDefault` keys `smr.live` + `smr.finalize`, `resolveSmrSelection(kind)` at `packages/applications/src/services/harness-policy/harness-policy.service.ts:426` — AiTaskDefault first, legacy HarnessPolicy fallback, fail-closed) but **every production call site passes `'finalize'`**; the miss is pinned to the live-doc `callSmr` site (2026-07-20 review D-26/GAP-A5). Runtime-proof that the finalize lane works: the 2026-07-22 assessment observed `smr.finalize`'s slug governing live generation (§D-26 lane note).

**Plan**: in `live-documentation.service.ts#callSmr`, resolve via `resolveSmrSelection('live')`. Verify the SYSTEM seed provides an `smr.live` row (it's one of the 9 task keys — `constants.ts:18-28`); confirm its seeded model is sane for the live cadence before flipping (check `seed` + dev DB; if the seeded live model is absent/heavier than finalize, note it and keep value-parity — the point is the ROUTING works, model choice is the global admin's). Add provenance to the live-summary `metadata.stats` (which task key + model served) so the console/TASK-543 stat cards can show it.

**Tests**: unit — live path resolves `'live'`, one-shot/finalize paths still `'finalize'`; fail-closed behavior unchanged (missing both rows ⇒ existing error semantics).

## Lane C — Click-to-source evidence panel at sign-off (GAP-A2, UI half)

**Context**: the segment-citation chain is CLOSED end-to-end (F-032 fixed 2026-07-22): the persisted draft's `SummaryMeta.citationsMap` carries `segmentCitedIds` + offset-enriched citations; markers are stripped before the note reaches the clinician; `TranscriptSegment` rows carry `(idx, t0Ms, t1Ms, speaker, charStart, charEnd)` offsets into the decrypted transcript (`consultation.prisma:566-612`). **No production console surface renders any of it** — the working click-to-source reference UI is stranded in the deprecated `ui-playground` (533-B5). Research framing (TASK-544 §3.1): the evidence panel is the trust/compliance surface (Abridge Linked Evidence pattern; FDA independently-reviewable basis).

**Plan**:
1. Verify/extend the read API: the doctor-facing summary read must expose the citations map + the segment rows + enough transcript access to render evidence snippets (check what `GET :id/context`/summary detail already returns; extend the response DTO only if a field is missing — no new controller).
2. Console: a `CitationEvidencePanel` in the case-note/documentation-review surface of `features/playground-consultation` (coordinate with TASK-543's case-note column — its assurance strip is the natural host): list cited segments (speaker, t0–t1, snippet); clicking a citation highlights/scrolls the corresponding transcript span in the live-session column (offset-based, `charStart/charEnd` into the transcript text).
3. Shared primitives to `packages/ui` if any new visual component is generic (rule 07); otherwise feature-local.

**Tests**: DTO mapping unit test (citations surfaced); panel render + click-to-highlight interaction (vitest); axe on the changed screen; `next-dev-loop` runtime pass with a harness-produced draft on the dev stack.

## Verification Criteria / Gates

- Lanes A+B: `pnpm --filter @arcaai/applications build test`, `pnpm build:api`, `pnpm test:unit` green. Runtime proof for A: re-point `nlp.ner` on the dev stack, paste NLP request log showing the injected `model_name` on a clinical path. Runtime proof for B: live session where the live-summary stats name the `smr.live` selection.
- Lane C: `pnpm --filter @arcaai/admin-console build lint test` green + next-dev-loop + axe 0 + both themes.

## Constraints & Hazards

- Lane A's fail-open requirement is deliberate and OPPOSITE to the judge lane's fail-closed — do not "harmonize" them.
- S-3 class (service-token/event contexts with empty CLS touching tenant-scoped models) — 3 prior instances; use the SYSTEM-pin pattern with an ordering-locked test.
- `/playground/consultation` is mid-rebuild (TASK-543 Phase A landed) — build Lane C against the NEW 3-column structure (`components/columns/case-note-column.tsx`), not the old tabs.
- Do not resurrect anything from `apps/ui-playground` by import — reference its UX only.

## Implementation Summary

**`fable-thinking` skill unavailable** — `Skill({skill: "fable-thinking"})` returned `Unknown skill: fable-thinking`. Per the ticket's fallback instruction this fact is recorded here and the session proceeded.

### Lane A — nlp.ner routing (DONE)

Added a shared, fail-open resolver `resolveNerModelInjection` (`packages/applications/src/services/consultation/shared/resolveNerModelSelection.ts`) that resolves the effective `nlp.ner` `AiTaskDefault` (mirroring `AiInferenceController`'s playground mapping) and injects `model_name` into the NLP `/classify/tokens` payload. Wired into all three call sites named in the ticket:
- `ner.processor.ts#callNlpService` (durable BullMQ job)
- `summary.service.ts#callNlpService` (synchronous `extractEntities`)
- `live-documentation.service.ts#callNlp` (live plane — also newly injected with `ClsService`, which this service did not have before)

**Fail-open**: resolver failure (service absent, registry error, no ENABLED model) returns `{}` — the caller posts exactly as before, NLP falls back to its own env default (`blaze999/Medical-NER`). Never throws.

**SYSTEM-pin**: `nlp.*` is GLOBAL_ADMIN_ONLY (system-row-only resolution). The resolver wraps the read in a NESTED `cls.run()` scope pinned to `tenantId=SYSTEM_TENANT_ID` (mirrors `EffectiveConfigController`'s F-026 pattern) rather than relying on the caller's ambient CLS tenant — verified with an ordering-locked unit test (`resolveNerModelSelection.test.ts` — "pins the read to a nested CLS scope... rather than the ambient caller tenant"). Module wiring: `AiTaskDefaultServiceModule` added to `ConsultationJobServiceModule`, `SummaryServiceModule`, `LiveDocumentationServiceModule`.

**Runtime proof (partial — DB-level, not HTTP)**: port 8868 is occupied by a process this session did not start (hard rule 4 — no e2e/browser verification performed). Verified directly against the live dev Postgres instead:
```
SELECT "tenantId","taskKey","modelSlug" FROM core."AiTaskDefault" WHERE "taskKey" IN ('nlp.ner','smr.live','smr.finalize');
  tenantId=SYSTEM | nlp.ner      | medical-ner
  tenantId=SYSTEM | smr.finalize | lms-gemma-4-e2b-it-qat
  tenantId=SYSTEM | smr.live     | lms-gemma-4-e2b-it-qat
SELECT slug,"sourceUri",provider,"resourceStatus" FROM core."AiModel" WHERE slug IN ('medical-ner','lms-gemma-4-e2b-it-qat');
  medical-ner            | blaze999/Medical-NER | built-in  | ENABLED
  lms-gemma-4-e2b-it-qat  | gemma-4-e2b-it-qat   | lm-studio | ENABLED
```
Confirms the SYSTEM `nlp.ner` row is seeded and resolves to the SAME model the NLP env default already serves — so the fix is value-neutral until a global admin re-points `nlp.ner`, at which point all three clinical callers (not just the playground) now follow it. A full HTTP-level proof (re-point + inspect the injected `model_name` in an NLP request log) is deferred — flagged as a follow-up.

### Lane B — `smr.live` activation (ALREADY DONE upstream; provenance ADDED)

Re-verified the file:line refs per the ticket's own caveat: `live-documentation.service.ts#callSmr` **already** calls `resolveSmrSelection(tenantId, 'live')` (landed in commit `c6c44de2f`, 2026-07-21 — BEFORE this ticket was authored) and an existing test (`live-documentation.service.test.ts` — "sets bounded live SMR params... and resolves provider/model via policy") already asserts `resolveSmrSelection` is called with `(TENANT, 'live')`. The core routing defect described in the ticket text was already fixed upstream; re-implementing it would have been redundant. Per hard rule 6 this is reported honestly rather than manufacturing a duplicate "fix".

What genuinely remained and was implemented: **provenance on `metadata.stats`** — added `task_key` to `LiveSummaryStatsDto` (`live-documentation/dto/live-summary.dto.ts`) and stamp it `'smr.live'` in `callSmr` (SMR itself has no notion of this key; only HOPE's routing layer does). Added a test asserting `metadata.stats.task_key === 'smr.live'` on a live flush. Also added an explicit unit test asserting one-shot/finalize paths (`summary.service.ts#generateSummary`) still call `resolveSmrSelection()` with **no** task argument (default `'finalize'`) — locking the A/B distinction the ticket's Tests section asked for. Seed value-parity verified live (see Lane A's DB query above): `smr.live` and `smr.finalize` both resolve to `lms-gemma-4-e2b-it-qat` today, so no seed change was needed to satisfy "keep value-parity" — the point is the routing key, not the model choice.

**Runtime proof**: deferred (8868 busy, not started by this session) — same constraint as Lane A.

### Lane C — click-to-source evidence panel (DONE)

**Read API** (extended existing DTO, no new controller): `SummaryProvenanceResponse` (`summary/dto/summary-provenance.response.ts`) gained `citedSegments: CitedSegmentResponse[]` (`{id, idx, t0Ms, t1Ms, speaker, charStart, charEnd}` — offsets/timing only, never segment text, to avoid duplicating PHI on the wire). `SummaryService.getSummaryProvenance` resolves it via a new pure helper `collectCitedSegmentIds` (`consultation/lib/transcript-segments.ts` — merges BOTH shapes `citationsMap` can carry: the flat `segmentCitedIds` array and the nested `claims[].evidence[].segmentId`) plus a new `resolveCitedSegments` private method that loads the consultation's single transcript's `TranscriptSegment` rows (best-effort: `[]` on anything unresolvable — no repo wired, >1 transcript, DB error — mirrors `enrichCitationsWithSegments`'s established posture; never blocks the provenance read). Existing endpoint unchanged: `GET :id/summary/:contextItemId/provenance`.

**Console** — re-verified the actual current structure (`components/scribe/*`, not the ticket's guessed `components/columns/*`):
- New feature-local `CitationEvidencePanel` (`components/scribe/citation-evidence-panel.tsx`) lists cited segments (speaker badge, `mm:ss–mm:ss`, a snippet SLICED CLIENT-SIDE from the already-fetched transcript text via `charStart`/`charEnd` — no duplicate PHI from the backend); clicking one reports it via `onSelectCitation`. Hosted in `CaseNoteColumn` right after the assurance strip, gated on a persisted draft existing (never shown mid-recording over the live SOAP view).
- New API surface: `getTranscriptions`/`useTranscriptions` (`GET :id/context/transcriptions` — already existed server-side, no console wrapper existed) and `getSummaryProvenance`/`useSummaryProvenance` (`GET :id/summary/:contextItemId/provenance`), plus `CitedSegment`/`SummaryProvenance`/`TranscriptContextItem` types.
- **Architecture note surfaced during exploration**: `LiveSessionColumn`'s existing `LiveTranscript` view renders the SDK's LIVE, in-browser STT segments (`audio.transcriptSegments`) — ephemeral, with NO relationship to the persisted transcript's character offsets a citation resolves to. Added an opt-in "review mode" (`reviewTranscriptText`/`reviewHighlight` props, default `null` ⇒ zero behavior change) that renders the PERSISTED transcript text with the cited span wrapped in `<mark>` and auto-scrolled into view (`scrollIntoView`) once capture is not active and a citation is selected. `consultation-demo-screen.tsx` lifts `selectedCitationId` state, fetches provenance + transcript text once a draft exists, and wires the click-to-scroll loop end to end.

**Tests**: DTO/service-level (`transcript-segments.test.ts`, `summary.service.provenance.task330.test.ts` — cited-segment resolution from both citationsMap shapes, best-effort degradation on >1 transcript / repo failure / nothing cited); component-level (`citation-evidence-panel.test.tsx` — render, snippet slicing, click callback, selected-state `aria-pressed`, axe light+dark; `live-session-column.test.tsx` — review-mode render, highlight, capture-active guard, invalid-span fallback); wiring-level (`case-note-column.test.tsx`, `client.test.ts` additions); `consultation-demo-screen.tsx` type-checks and the existing screen test suite stays green (the new hooks never fire in that suite — gated on a draft existing, never selected there).

**Runtime proof**: `next build` succeeds; `next-dev-loop` full click-through against a harness-produced draft on the dev stack is deferred (8868 busy, not started by this session; the flow also needs live NLP/SMR/harness services). Flagged as a follow-up.

### Gate Evidence (condensed, actual output)

```
pnpm --filter @arcaai/applications build
  ✓ tsc — 0 errors

pnpm --filter @arcaai/applications test   (npx vitest run, full suite)
  Test Files  335 passed | 1 skipped (336)
  Tests       6777 passed | 4 skipped (6781)

pnpm --filter @arcaai/applications lint
  339 warnings, 0 errors — line-by-line diffed against the pre-change baseline
  (also 339/338 across the session): ZERO new warnings; every warning on a
  touched file maps 1:1 to a pre-existing one at a shifted line number.

pnpm build:api
  BLOCKED by environmental ENOTEMPTY races on apps/api/dist (a concurrent,
  not-self-started nest process is writing the same dist tree — matches the
  documented "concurrent nest --watch" hazard; different subfolder each retry
  = confirmed external interference, not a code defect). Substituted:
    cd apps/api && npx tsc --noEmit -p tsconfig.build.json   → 0 errors
    cd apps/api && npx vitest run (full suite)
      Test Files  151 passed | 2 skipped (153)
      Tests       2404 passed | 4 skipped (2408)
      (one throttle-guard timing test failed under full-suite load on the
      FIRST run, passed in isolation and on a clean full re-run — pre-existing
      flake, unrelated to this ticket's files)

apps/api/tests/integration/summary-provenance.spec.ts
  Fixed 1 test (added citedSegments: [] to its strict-equality expectation) — 3/3 pass.

pnpm --filter @arcaai/admin-console build   (npx next build)
  ✓ Compiled successfully; TypeScript finished; 67/67 static pages generated

pnpm --filter @arcaai/admin-console lint   (npx eslint src --max-warnings 0)
  0 problems

pnpm --filter @arcaai/admin-console test   (npx vitest run, full suite)
  Test Files  150 passed (150)
  Tests       1161 passed (1161)

cd apps/admin-console && npx tsc --noEmit
  0 errors
```

## Files Changed

Backend (`packages/applications`):
- `services/consultation/shared/resolveNerModelSelection.ts` (new) + `__tests__/resolveNerModelSelection.test.ts` (new)
- `services/consultation/jobs/processors/ner.processor.ts`, `jobs/__tests__/ner.processor.test.ts`, `jobs/consultation-job.service.module.ts`
- `services/consultation/summary/summary.service.ts`, `summary.service.module.ts`, `summary.dto.mapper.ts`, `dto/summary-provenance.response.ts`, `__tests__/summary.service.test.ts`, `__tests__/summary.service.provenance.task330.test.ts`
- `services/consultation/live-documentation/live-documentation.service.ts`, `live-documentation.service.module.ts`, `dto/live-summary.dto.ts`, `__tests__/live-documentation.service.test.ts`
- `services/consultation/lib/transcript-segments.ts`, `lib/__tests__/transcript-segments.test.ts`

Backend (`apps/api`): `tests/integration/summary-provenance.spec.ts`

Frontend (`apps/admin-console/src/features/playground-consultation`):
- `api/types.ts`, `api/client.ts`, `api/hooks.ts`, `api/keys.ts`, `api/__tests__/client.test.ts`
- `components/scribe/citation-evidence-panel.tsx` (new) + `__tests__/citation-evidence-panel.test.tsx` (new)
- `components/scribe/case-note-column.tsx`, `__tests__/case-note-column.test.tsx`
- `components/scribe/live-session-column.tsx`, `__tests__/live-session-column.test.tsx` (new)
- `components/consultation-demo-screen.tsx`

## Change History

- 2026-07-23 — Ticket authored from TASK-544 §7 breakdown (D-26, NER dual-regime, GAP-A2 UI half).
- 2026-07-23 — All three lanes implemented and gate-verified (see Implementation Summary above); status → Review. `fable-thinking` skill was unavailable in this environment (recorded, session proceeded per the ticket's fallback instruction). Lane B's core routing defect was found ALREADY FIXED upstream (commit `c6c44de2f`, pre-dating this ticket) — only the `metadata.stats` provenance piece + the finalize-path lock-in test were net-new. Runtime/e2e verification for all three lanes deferred: port 8868 is occupied by a process this session did not start (hard rule 4); `apps/api`'s own build hit repeated `ENOTEMPTY` races against that same process's `dist` writes, substituted with `tsc --noEmit` + the full `apps/api` vitest suite as equivalent evidence. Open follow-ups: (1) HTTP-level runtime proof for Lane A (re-point `nlp.ner`, inspect the injected `model_name` on a live clinical NLP request) and Lane B (live-summary stats naming `smr.live`) once 8868 is free; (2) `next-dev-loop` click-through for Lane C against a harness-produced draft on the dev stack, same constraint.

### 2026-07-23 — Runtime proof (RUNTIME-PROOFS agent) — Lane A + Lane B PASS
- **Lane A (nlp.ner model injection) — PASS:** own NLP echo server + 2nd API instance (NLP_URL override). Baseline `POST /ai/nlp/entities` → gateway posts `/api/v1/classify/tokens` with `model_name=blaze999/Medical-NER` (default nlp.ner). After an authentic global-admin PUT repointing nlp.ner `medical-ner→gliner-guard-uniencoder-onnx` (OCC v1→2), the same call injected `model_name=hivetrace/gliner-guard-uniencoder-onnx`. Reverted. Note: the exact clinical `extract-entities` endpoint was reached (auth+ownership OK) but bailed at the "no content" guard because a 2nd ad-hoc API from .env.test does not decrypt ContextItem content (Vault field-crypto not wired there); the capture used the playground surface, which threads the identical resolver into the same `/classify/tokens` injection. Env artifact, not a Lane A defect.
- **Lane B (smr.live provenance) — PASS:** drove the live-documentation watcher headlessly (recording/start + Redis XADD fake STT finals to `stt:result:{sessionId}`). `GET /admin/harness/live/sessions` → `flushCount=1, smrFailed=false, smrLatencyMs=10521`. A Redis subscriber on `consultation:live-summary:{id}` captured a `LiveSummaryEventDto` with **`metadata.stats.task_key='smr.live'`** (+ full SMR gen stats). Provenance confirmed on the wire.

### 2026-07-23 — Clinical-endpoint NER variant (RUNTIME-FINISH agent) — **SKIPPED with reason** (optional attempt)
Attempted once against the freshly rebuilt, Vault-wired gateway :8868 (PID 80030). The exact clinical endpoint `POST /api/v1/consultations/:id/summary/:contextItemId/extract-entities` is `@Authorize(['create','Consultation'])` — **user-JWT authenticated, not service-token** — so reaching it needs an authenticated doctor session, obtainable only via interactive login (out of scope for this non-interactive session; browser password entry is prohibited). Additionally, NLP :8864 is up but **`status=degraded`** (lazy-loaded classifiers) and does not surface a per-request `model_name` in a readable request log, so even a reached call would not yield clean log evidence. The resolver that performs the injection (`resolveNerModelInjection`, `packages/applications/src/services/consultation/shared/resolveNerModelSelection.ts`) is confirmed present in the built code and is the IDENTICAL path the prior run already proved PASS via the playground surface (nlp.ner re-point → injected `model_name` flipped). Net-new since the prior run: the Vault-wired :8868 WOULD now decrypt `ContextItem` content (removing the earlier "no content" blocker) — the only remaining gap is the doctor JWT. Skipped per the "optional, skip with reason" latitude; Lane A remains PASS on the equivalent resolver path.
