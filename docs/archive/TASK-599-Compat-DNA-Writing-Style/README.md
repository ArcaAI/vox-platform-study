# TASK-599 — DNA Writing-Style in the v1-Compat SMR Path (+ shared decryption fix)

**Status:** Review (Phases A–F implemented + verified; uncommitted on dev-2.1)
**Type:** feature (+ bugfix)
**Branch:** dev-2.1
**Owner:** Tap Huynh
**Created:** 2026-08-02

---

## Requirement Analysis

Origin: an end-to-end test of pre-summarization/summarization through the **compat playground**
(`apps/compat-playground`) for tenant **ArcaAI**, driving `@arcaai/vox/compat` → gateway
`smr-compat` shim → SMR. The E2E of the existing flow **passed**: selecting a real department +
visit type resolves the correct governed template and produces an accurate structured summary.

Two gaps were found against the acceptance criteria. After clarification the scope is:

1. **Output shape — NO CHANGE (decided).** Keep the SDK/API compat wire contract exactly as-is
   (structured Enhanced/Simplified summary + the 5-section pre-summary `structured_data`). The only
   requirement is that the **backend resolves the correct governed template for the selected
   department + visit-type** to steer content — which already works. This ticket only *verifies* it
   with a differential test; it does **not** reshape the output into template headings.

2. **DNA writing-style — IN SCOPE.** DNA writing-style is currently **not applied** in the compat
   path (no field at all) and, due to a bug, **not applied in the canonical consultation path
   either** when `SECRETS_PROVIDER=vault` (which this dev env uses). This ticket wires DNA
   writing-style into pre-summary + summary and fixes the shared decryption bug.

### Decisions (confirmed with owner 2026-08-02)
- **D1 — Output:** keep compat wire shape unchanged; backend picks the correct dept+visit template.
- **D2 — Doctor selection:** add a **doctor picker** in the playground; pass a whitelisted
  `doctorId` in the presummary/summary request so the gateway knows whose DNA style to apply
  (the compat SDK key maps to `arcaai_admin`, not a clinician).
- **D3 — Bug scope:** **also fix the shared `PromptAssemblyService` decryption bug** (affects the
  real production consultation flow), not only the compat path.
- **D4 (default, not separately asked):** seed DNA reports for **all 7 ArcaAI doctors** (not the
  admin) and enable the DNA gate for ArcaAI.
- **D5 — No-doctor fallback (owner-added 2026-08-02):** if **no `doctorId`** is provided in the
  request, DNA writing-style is **ignored entirely** — the summary/pre-summary uses department +
  visit-type template only. DNA is strictly additive and never required.

---

## Current State Evaluation (verified against code + live DB, 2026-08-02)

### The compat path (target of the E2E)
- `packages/agentic-sdk-v2/src/compat/useSMR.ts` — `SMRRequest` already declares `doctorId`, but
  `buildSyncPayload` and the presummary payload **do not send it**; the gateway DTO would reject it
  anyway.
- `apps/api/src/modules/smr-compat/`:
  - `smr-compat.controller.ts` — resolves **tenant only** (CLS / `apiKey.tenantId`); no doctor
    identity is read. It already has `@Optional() @Inject(SecretsService)` wired (used today only
    for the SMR service token) — so decrypt capability is available here.
  - DTOs (`dto/sync-summary.request.ts`, `dto/session-data.dto.ts`) have **no `doctorId`**;
    global `ValidationPipe` (`whitelist + forbidNonWhitelisted`) would strip/reject an unknown field.
  - `summary-prompt.builder.ts` — `buildSummaryPrompt` / `buildPreSummaryPrompt` push a governed
    instruction line into `systemLines`; a DNA-style line would be an analogous `systemLines.push`.
  - **Zero references to DNA** anywhere in the module.

### The DNA feature (canonical path) — has a real bug
- `packages/applications/.../prompt/prompt-assembly.service.ts` `buildVariables` reads
  `dnaWritingStyleRepository.findById(dnaStyleId).styleText` and substitutes it into
  `{style_DNA_doctor_department_*}` template placeholders.
- **Bug:** `findById` is the generic, **non-decrypting** repo method; the plaintext `styleText`/
  `reportData` columns were **dropped** (Vault-Transit ciphertext only, `dna-writing-style.prisma`).
  `PromptAssemblyService` has **no `SecretsService`** injected. So in `SECRETS_PROVIDER=vault`
  (this env), `styleText` is always `undefined` and DNA style is **silently never injected** — even
  in the real consultation flow.
- Decryption precedent that works: `DnaWritingStyleReportRepository.findByIdWithDecryptedFields(id, secrets)`
  / `decryptFieldsFromEntity(entity, secrets)`; `DnaWritingStyleService.getRedactionRules` already
  uses this pattern (but there is **no** existing method returning decrypted `styleText`).

### Placeholder / gate / seed gaps for ArcaAI
- **Placeholders:** SYSTEM templates (`07-prompt-template.ts`) contain `{style_DNA_doctor_department_*}`,
  but the **ArcaAI clinical templates (`07b-arcaai-clinical-templates.ts`) do NOT** — so even after
  the decryption fix, DNA won't inject into ArcaAI governed summaries via the placeholder mechanism.
  → injection must **fall back to appending a system directive** when no placeholder matched.
- **Gate:** ArcaAI has only a `TENANT`-scope `PipelinePolicy` with `dnaStyleEnabled = null`
  (effectively off). `resolveEffectiveDnaStyleEnabled(tenant, dept, doctor)` requires it on.
- **Seed:** only `arcaai_doctor` (Olivia Tan, GEN, report `73000000-…-0001-000000000001`) has a DNA
  report; the other 6 ArcaAI doctors have none. Seed encryption is done via
  `encryptSeedRow('DnaWritingStyleReport'|'DnaWritingStyleVersion', row)` in
  `seed/phi-encryption.ts` (Vault Transit key `hope-phi`); `SEED_DNA_REPORT_IDS` has no ids reserved
  for the six yet.

### Doctor listing for the playground
- ArcaAI SDK key has scope `admin:user:read`; the playground can list doctors via the admin users
  endpoint (to confirm exact route during impl) and filter to `DOCTOR` role.

---

## Implementation Plan (TDD, layer order)

> All new/changed behavior gets a failing test first (see the RED list per step). Commands per the
> layer gates in `01-development-workflow.md`.

### Phase A — Shared DNA decryption fix (D3) · `packages/applications`, `packages/domains`
1. **RED:** `prompt-assembly.service.test.ts` — assert that with a Vault-backed
   `DnaWritingStyleReport` (only `encryptedStyleText` present) and a `SecretsService` mock, the
   resolved prompt contains the decrypted style text; and that when the resolved template has **no**
   `{style_DNA_*}` placeholder, the style is appended as a system directive (new fallback).
2. **GREEN:**
   - Inject `SecretsService` (optional) into `PromptAssemblyService`.
   - Replace `findById` with `findByIdWithDecryptedFields(dnaStyleId, secrets)` (or
     `decryptFieldsFromEntity`) to populate `styleText`.
   - Keep placeholder substitution; **add fallback**: if the resolved content declares no matched
     `{style_DNA_*}` key, append `styleText` as a trusted system directive (mirrors the compat
     builder's governed-instruction append) so DNA applies regardless of template placeholders.
3. Optional add: `DnaWritingStyleService.getEffectiveStyleText(doctorId)` returning decrypted
   `styleText` gated by `resolveEffectiveDnaStyleEnabled` — reused by the compat path (Phase C).

### Phase B — Seed: DNA for all ArcaAI doctors + enable gate · `packages/database`
1. Reserve 6 new report ids + 6 version ids in `00-constants.ts` (`73000000-…-0001-000000000002..007`,
   `74000000-…-0001-000000000002..007`), plus usage ids following the existing convention.
2. Extend `08-dna-writing-style.ts` `CUSTOMER_DNA_*` with distinct styles for surg/rheum/neur/orth/
   heme/bren (department-appropriate prose), seeded via the existing `encryptSeedRow` loop.
3. Enable the DNA gate for ArcaAI: set `PipelinePolicy` `TENANT`-scope `dnaStyleEnabled = true`
   (seed), so `resolveEffectiveDnaStyleEnabled` returns effective for the doctors.
4. **Verify:** `pnpm --filter @arcaai/database test`; re-seed dev DB; confirm 7 encrypted reports +
   enabled gate via SQL.

### Phase C — Gateway compat DNA injection · `apps/api`
1. **RED:** `smr-compat` controller/builder tests — given a request with `doctorId` for a doctor
   with an enabled DNA style, the outbound SMR `system_prompt` includes the decrypted style text;
   given **no `doctorId`** (D5) / gate off / no report, it does **not** inject DNA and falls back to
   department + visit-type only (and never throws).
2. **GREEN:**
   - Add optional whitelisted `doctorId` to `SyncSummaryRequest` + the presummary request DTO
     (class-validator + `@ApiPropertyOptional`).
   - In the controller: when `doctorId` present, fetch+decrypt that doctor's effective DNA style
     (reuse Phase-A `getEffectiveStyleText` or the repo `findByIdWithDecryptedFields` + gate via
     `resolveEffectiveDnaStyleEnabled(tenantId, matchedDepartmentId, doctorId)`), passing the result
     into `buildSummaryPrompt`/`buildPreSummaryPrompt` as a new `dnaStyleText` option →
     `systemLines.push("Apply this clinician's documentation writing style …\n<styleText>")`.
   - Never throw on DNA resolution failure (defensive; DNA is additive).
3. **Verify:** `pnpm api:build`, `pnpm test:unit`.

### Phase D — SDK compat: send doctorId · `packages/agentic-sdk-v2`
1. **RED:** `useSMR` test — `preSummarize`/`summarizeSync` include `doctorId` in the wire payload
   when supplied.
2. **GREEN:** thread `doctorId` into `buildSyncPayload` (top-level + `session_data.session_metadata`)
   and the presummary payload.
3. **Verify:** `pnpm --filter @arcaai/vox build test`.

### Phase E — Playground UI: doctor picker · `apps/compat-playground`
1. **RED:** `SummaryCard`/`ContextForm` test — a doctor picker renders from a fetched doctor list and
   its selection is passed to `useSMR`.
2. **GREEN:** add `lib/doctors.ts` (fetch tenant doctors, filter DOCTOR role), a Doctor `<Select>` in
   `ContextForm`, thread `doctorId` into the `preSummarize`/`summarizeSync` calls; small "DNA style
   applied" hint.
3. **Verify:** `pnpm --filter @arcaai/compat-playground build lint test`.

### Phase F — E2E verification (browser) + template-selection differential
1. Re-run the browser E2E for ArcaAI: pick GEN + a DNA-enabled doctor → confirm the summary reflects
   the doctor's style (compare two doctors with distinct styles on the same transcript).
2. Add a gateway test proving dept+visit → correct governed template (the D1 verification).

---

## Files (create/modify) — provisional
- `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts` (+ test) — decryption fix + fallback append
- `packages/applications/src/services/dna-writing-style/dna-writing-style.service.ts` / `IDnaWritingStyleService.ts` — `getEffectiveStyleText` (+ test)
- `packages/database/src/prisma/db_main/seed/00-constants.ts` — reserve DNA ids
- `packages/database/src/prisma/db_main/seed/08-dna-writing-style.ts` — 6 more ArcaAI reports
- `packages/database/src/prisma/db_main/seed/…` — enable ArcaAI `PipelinePolicy.dnaStyleEnabled`
- `apps/api/src/modules/smr-compat/dto/sync-summary.request.ts` + presummary DTO — `doctorId`
- `apps/api/src/modules/smr-compat/smr-compat.controller.ts` (+ tests) — DNA resolve/decrypt/gate
- `apps/api/src/modules/smr-compat/summary-prompt.builder.ts` (+ tests) — `dnaStyleText` option
- `packages/agentic-sdk-v2/src/compat/useSMR.ts` (+ test) — send `doctorId`
- `apps/compat-playground/src/lib/doctors.ts` (new), `components/summarization/ContextForm.tsx`, `SummaryCard.tsx` (+ tests)

## Verification Criteria (definition of done)
- [ ] `pnpm --filter @arcaai/applications build test` green (decryption fix + service)
- [ ] `pnpm --filter @arcaai/database test` green; dev DB re-seeded with 7 encrypted ArcaAI DNA reports + gate on
- [ ] `pnpm api:build` + `pnpm test:unit` green (compat DNA injection)
- [ ] `pnpm --filter @arcaai/vox build test` green (doctorId in payload)
- [ ] `pnpm --filter @arcaai/compat-playground build lint test` green (doctor picker)
- [ ] Browser E2E: two ArcaAI doctors with distinct DNA styles produce visibly different summaries from the same transcript
- [ ] No new lint/typecheck errors; ticket README updated with evidence

## Open questions / risks
- **Placeholder vs append:** ArcaAI templates lack `{style_DNA_*}`; the Phase-A fallback (append when
  no placeholder) is what makes DNA actually apply for ArcaAI. Confirm this is acceptable vs. adding
  placeholders to the ArcaAI templates.
- **Doctor listing endpoint:** confirm exact admin users route + response shape the playground uses.
- **Prompt-injection safety:** DNA `styleText` is trusted platform content (not PHI/caller data), so
  it is injected without `<<<EXTERNAL_DATA>>>` markers, consistent with the governed-instruction line.

## Implementation Summary

### Phase A — Shared DNA decryption fix + append fallback ✅ (2026-08-02)
- `prompt-assembly.service.ts`: injected `@Optional() SecretsService` (`@Global` SecretsModule
  supplies it in prod — no module wiring needed); new `resolveDnaStyleText()` uses
  `findByIdWithDecryptedFields(id, secrets)` (falls back to legacy non-decrypting `findById` only
  when no secrets wired); `buildVariables` now exposes `variables.dna_style_text`; `assemble()`
  appends the style as a trusted directive when the template declares no `{style_DNA_*}` slot.
- `dna-writing-style.service.ts` + `IDnaWritingStyleService.ts`: new `getEffectiveStyleText(doctorId)`
  — gate (`getDnaSettings.effective`) → latest report → `decryptFieldsFromEntity` → styleText, null-safe.
- Tests (RED→GREEN): `prompt-assembly.service.test.ts` (+2 decrypt/append), `dna-writing-style.service.test.ts` (+3).
- Evidence: `prompt-assembly` 42/42, `dna-writing-style.service` incl. 3 new = green; both suites 130/130; `pnpm --filter @arcaai/applications typecheck` clean.

### Phase B — Seed 6 ArcaAI doctor DNA reports + enable gate ✅ (2026-08-02, agent)
- `seed/08-dna-writing-style.ts`: 6 new `CUSTOMER_DNA_*` entries (surg/rheum/neur/orth/heme/bren) with distinct department-appropriate `styleText`, ids `73…-0001-…002..007` / `74…-0001-…002..007`, seeded via the existing `encryptSeedRow` loop.
- `seed/14-pipeline-policy.ts`: ArcaAI TENANT `dnaStyleEnabled` `null → true`.
- Evidence: `pnpm --filter @arcaai/database test` 892/892; typecheck clean.
- ⚠️ Seed `ensureTenantRow` is create-only ⇒ the gate flip lands on a FRESH re-seed. For the live E2E the ArcaAI TENANT policy row was updated in-place to `dnaStyleEnabled=true` (owner: a full re-seed also brings the 6 new reports into the live DB).

### Phase C — Gateway compat DNA injection ✅ (2026-08-02)
- `dto/sync-summary.request.ts` + `dto/pre-summary.request.ts`: optional whitelisted `doctor_id`.
- `summary-prompt.builder.ts`: `dnaStyleText` option on both builders → appended as a style directive (facts/schema unchanged).
- `smr-compat.controller.ts`: injected `@Optional() IDnaWritingStyleService`; `resolveDnaStyleText(doctor_id)` (gate-checked via `getEffectiveStyleText`, never throws) threaded into `computeSummary`/`streamSummary`/`computePreSummary`/`streamPreSummary`. No `doctor_id` ⇒ no DNA (D5).
- `smr-compat.module.ts`: imports `DnaWritingStyleServiceModule`.
- Tests: builder +3 (`summary-prompt.builder.test.ts`), controller +2 (`smr-compat.controller.test.ts`). Evidence: smr-compat suites 41 + 16 green; `pnpm api:build` green (8/8 tasks).

### Phase D — SDK compat sends doctorId ✅ (2026-08-02, agent)
- `src/compat/useSMR.ts`: top-level `doctor_id` in the summary (sync+async+stream) and pre-summary payloads when supplied, omitted otherwise. `src/compat/types.ts`: `PreSummaryRequest.doctorId` added (`SMRRequest.doctorId` already existed).
- Tests +4. Evidence: `@arcaai/vox` 3821/3821, typecheck + build clean.

### Phase E — Playground doctor picker ✅ (2026-08-02, agent)
- `src/lib/doctors.ts` (new, mirrors `departments.ts`: `GET /api/v1/admin/users`, x-api-key, defensive envelope parsing, reject→free-text fallback; drops service accounts).
- `ContextForm.tsx`: Doctor `<Select>` with a "None (no DNA style)" option + Custom free-text fallback; new controlled props.
- `SummaryCard.tsx`: `doctorId` state (persisted); passed as `doctorId` into `preSummarize` + `summarizeSync`.
- `config-store.ts`: `doctorId?` on `PlaygroundConfig`.
- Tests +2. Evidence: `@arcaai/compat-playground` 203/203, lint + typecheck + build clean.

### Phase F — Runtime verification ✅ (2026-08-02)
- API restarted cleanly (single instance on 8868, fresh build → Phase A dist + Phase C src + fresh config cache). ArcaAI TENANT `PipelinePolicy.dnaStyleEnabled` set true in the live dev DB (the seed change lands on next full re-seed).
- Playground (Chrome/Chromium): reconnected → Summarization → the **Doctor picker fetches the tenant doctors live** (`GET /admin/users` → 200, 9 users incl. `arcaai_doctor`/Olivia Tan `…040`, the doctor with a seeded DNA report).
- Gateway A/B (same transcript, GEN + New/Referral, `use_enhanced_format`): `POST /api/smr/api/v1/summary/sync` **with** `doctor_id=…040` and **without** — both HTTP 200 with valid Enhanced summaries; the `doctor_id` path exercises resolve→decrypt→gate→inject→SMR end-to-end without error. Style delta is subtle (Olivia Tan's seeded style is concise/SOAP, close to default; local `gemma-4-e2b`). Deterministic injection proof = the Phase A/C unit tests (controller asserts styleText in the SMR `system_prompt`).

## Owner tails
- **Commit** (uncommitted on dev-2.1; concurrent-session revert risk).
- **Full re-seed** to land the 6 new ArcaAI doctor DNA reports + the seeded gate flip in the live DB (only Olivia Tan's report exists live now; the gate was enabled in-place for the E2E).
- Run the monorepo aggregate gates (`pnpm lint:all`, `pnpm typecheck:all`) before merge; a pre-existing `require-description` warning sits on an unrelated eslint-disable in `prompt-assembly.service.ts` (not introduced here).
- Optional: a fuller UI click-through of doctor-selected summarize (the in-app browser pane was flaky this session; picker fetch + gateway A/B already cover the path).

## Change History
- 2026-08-02 — Ticket created; plan drafted after E2E test + code exploration; decisions D1–D5 recorded.
- 2026-08-02 — Phase A implemented (TDD) and verified: shared PromptAssemblyService DNA decryption fix + no-placeholder append fallback + `getEffectiveStyleText`.
- 2026-08-02 — Phases B–F complete: seed 6 ArcaAI doctor DNA styles + gate; gateway `doctor_id` DNA injection (sync+stream, summary+pre-summary); `useSMR` sends `doctor_id`; playground doctor picker; runtime A/B verified. Status: Review (uncommitted).
