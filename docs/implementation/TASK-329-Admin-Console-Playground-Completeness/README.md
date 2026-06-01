# TASK-329 — Phase 3: Developer-Playground Completeness

| | |
|---|---|
| Ticket Number | TASK-329 |
| Short name | Admin-Console-Playground-Completeness |
| Parent | **TASK-325** (Admin Console Transformation — umbrella) |
| Created | 2026-06-02 |
| Updated | 2026-06-02 |
| Status | `Pending` |
| Type | feature |
| Scope | `apps/ui-playground/`, `@arcaai/vox`, `packages/{stt,vad,noise-filter}`, `apps/api/`, `packages/database/` |
| Depends on | **TASK-326** (security) + **TASK-327** (scope shell + impersonation gate) |

> Completes playground spec items **P2–P6**, fixes **X3/X8/X10**, and adds the **realtime code-sample panel** (`LiveCodePanel`) required across all playgrounds. Per **Q3**, all data flows through `@arcaai/vox` hooks.

---

## 1. Requirement Analysis

### 1.1 Acceptance criteria
- [ ] **P2 Consultation** — in-flow mic recording using the impersonated user's pipeline prefs (realtime transcript); batch-transcription + SSE wired into the audio case-note tab (`useFileTranscription`); summary via preferred dept prompt **with fallback**; chain-of-consultation reference UI (`GET /:id/chain`); **RAW + PROCESSED** dual capture — add `rawMediaId`/`processedMediaId` to `AudioRecording` and save both streams (**X8**).
- [ ] **P3 Audio** — local-model **task** selection (transcribe/translate); per-user prefs persisted via `PATCH /user/me/settings`; fix `localAsrModels`/`availableModels` mismatch.
- [ ] **P4 Voice** — **local** in-browser enrollment (new local embedding provider + `POST /voice-profile/enroll-embedding`); **quick test** (mic/upload match + `POST /voice-profile/test`); diarization seeding feedback (`voiceProfileSeeded`); fix the always-"Active" badge.
- [ ] **P5 DNA** — generate from **selected historical data** (context-item picker); **set-default** (`POST /:reportId/set-default`); two-version **diff** (`version-diff-panel`); wrap page in `ImpersonationGuard`; fix the empty Edit dialog.
- [ ] **P6 Summarization** — backend summary **list + version browser**; `cacheHit`/`qualityScore` fields + endpoints; version **diff**; **tagging** (`Tag`); **edit→new version**; fix the raw-DNA ownership bypass via `/text/generate/assembled` (**X3**); namespace `localStorage` history by tenant/user (**X10**).
- [ ] **`LiveCodePanel`** — reactive Shiki snippet (`kibo-ui/code-block`) bound to each playground's store / impersonated prefs.
- [ ] Skeleton/empty/toast per rules `10`/`11`; gates green (§4).

### 1.2 Non-goals
- Administration features (TASK-328). Security scoping (TASK-326).

---

## 2. Current State Evaluation
TASK-325 §2.4 (P1–P6 committed vs gaps, file-cited), §2.5 (no realtime code-sample today), §2.6 (X3/X8/X10), §2.7 (reuse: `kibo-ui/code-block`, `version-diff-panel`, `useVoiceEmbedding`, `useFileTranscription`).

---

## 3. Implementation Plan (TDD)
Sequence: **P2 consultation** (highest clinical value) → **P6 summarization** → **P4 voice** → **P5 DNA** → **P3 audio** → **`LiveCodePanel`** (shared, last). For each behavioral change: extend the SDK hook/contract first (Q3), RED test the hook/endpoint, then wire UI. The X8 dual-capture and P6 `cacheHit`/`qualityScore` are **additive** DB migrations (no destructive ops). Local voice enrollment lands as a new browser provider in `packages/stt` (or a new package) — confirm model/runtime before starting.

---

## 4. Verification Gates
```
pnpm db:migrate && pnpm db:generate            # additive (X8, P6 fields)
pnpm build:sdk && pnpm --filter @arcaai/vox test
pnpm build:api && pnpm test:e2e
pnpm --filter @arcaai/ui-playground type-check && pnpm --filter @arcaai/ui-playground test
# manual smoke: record→transcript; attachment→summary; SSE streaming intact
# ReadLints on every edited file → clean
```

---

## 5. Implementation Summary
> Not started.

---

## 6. Change History
| Date | Change | Files |
|---|---|---|
| 2026-06-02 | Sub-ticket created from TASK-325 §3.7 (Phase 3). Scope = P2–P6 + LiveCodePanel; fixes X3/X8/X10; Q3 SDK-first. Status `Pending`. | this README |
