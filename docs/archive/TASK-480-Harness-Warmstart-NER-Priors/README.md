# TASK-480 — Harness Warm-start from Live Note + Reuse `NamedEntity` as NER Priors (Theme E1 · SOTA S3-F5)

- **Status**: Review
- **Type**: refactor / feature (harness lineage unification — kills the cold-regen redundancy of the dual path)
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **E1** (harness warm-start + NER priors)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track (post-Wave-3)
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §SOTA **S3** verdict (b) — "the dual-path architecture is SOTA-aligned but partly redundant … the harness should warm-start from the live-doc's last incremental note (two-stage scratchpad→final) and reuse `NamedEntity` rows as NER priors instead of regenerating cold" (**S3-F5**) + the seam through-line ("the live draft is discarded and the harness regenerates cold")
- **Builds on (matures, not from-zero)**: [TASK-355 Phase C (R-6)](../../archive/TASK-355-Harness-Latency-Optimization/README.md) — the **existing** warm-start scaffolding (`HARNESS_WARM_START_ENABLED`, default **OFF**; see the framing correction below) · [TASK-476](../TASK-476-Clinical-Encoder-Ontology-Linker/README.md) (C1 — the **coded** `NamedEntity` rows the priors reuse) · [TASK-463](../TASK-463-NamedEntity-Persistence-Contract/README.md) (the shared NLP→`NamedEntity` mapper)
- **Theme**: E1 · **Size**: L · **Value**: High (kills cold-regen redundancy) · **Risk**: Med (touches the durable Temporal workflow — must stay replay-safe)
- **Depends on**: [TASK-476](../TASK-476-Clinical-Encoder-Ontology-Linker/README.md) (**the persisted `NamedEntity` codes must be populated** — NER priors are only worth reusing once the codes actually exist; they are `null` today) → **E1 lands after C**. TASK-476 itself gates on [TASK-470](../TASK-470-Streaming-Quality-Eval-Harness/README.md) (measure-first), so E1's gating chain is **E1 → TASK-476 → TASK-470**.
- **Suggested agent**: general-purpose (spans `apps/harness` Temporal Python + `packages/applications` TS prompt-assembly/harness-internal — a lineage-unification lens; run the Python and TS gates separately, and the harness replay-compat suite).
- **Hard guardrail (track-level)**: the **durable HARNESS stays the clinical authority.** Warm-start **refines** the live draft — the **transcript remains the single source of truth** (the model follows the transcript over the prior draft on conflict, exactly as the existing R-6 instruction already states). **Self-hosted only** — no cloud PHI.

## File-ownership manifest (best-effort exclusive — binding)

E1 has **two halves**: (A) mature + enable the **already-scaffolded** warm-start lineage, and (B) add the **missing** NER-priors reuse. Grouped by gate (Python harness · TS applications · infra).

| File | Change | Half |
|---|---|---|
| `apps/harness/src/harness/temporal/workflows.py` | The cold transcript-NER extraction (`extract_entities` over `inp.transcript_text`, `:322-333`): add a **priors-reuse path** — when persisted **coded** `NamedEntity` rows exist (TASK-476), reuse them as the transcript entities and **skip/seed** the cold `extract_entities` call; keep the cold extraction as the fallback when priors are absent/degraded. Data-only input change (replay-safe). | B |
| `apps/harness/src/harness/temporal/activities.py` | A `load_entity_priors` activity (read the persisted coded `NamedEntity` rows via apps/api) **or** extend `extract_entities`'s input to accept priors. Deterministic; the prior payload is a dataclass carried into the workflow. | B |
| `apps/harness/src/harness/services/api_client.py` | A read path for persisted coded `NamedEntity` priors (mirrors the existing `_entity_payload` write path from TASK-476; read = new). | B |
| `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts` | Mature the warm-start refinement (`:250-270`) from the current **single-append** "refine the prior draft" fallback into the validated **two-stage scratchpad→final** the S3-F5 verdict names (documented + tested). NOT a rewrite of the append fallback — an explicit staging of live-note (scratchpad) → harness (final). | A |
| `packages/applications/src/services/consultation/harness/harness-internal.service.ts` | The warm-start snapshot loader (`loadLiveSoapSnapshot`, `:256`/`:362`) + provenance write (`:356-362`): validate + enable; ensure the consumed `LIVE_SOAP_SNAPSHOT` row is threaded/provenanced deterministically. No premise change to the loader. | A |
| apps/api internal endpoint (read coded priors) | The read counterpart the harness `api_client` calls (the write path is TASK-476/TASK-463). | B |
| `turbo.json` · `apps/harness/.env.example` · `.env.example` | **Register `HARNESS_WARM_START_ENABLED` in `turbo.json#globalEnv`** (today it is documented only in `apps/harness/.env.example:132` and is **NOT** in `globalEnv`); add any new NER-priors toggle. | A/B |
| `apps/harness/**/tests/**` · `packages/applications/**/__tests__/**` | RED-first: (a) the harness reuses persisted coded priors instead of re-extracting (RED proves cold re-extraction today); (b) the two-stage warm-start lineage refines the prior draft with the transcript authoritative; (c) **replay-compat** (priors are data-only → old histories replay unchanged). | A/B |
| `uv.lock` (root) | Only if a dependency is added (unlikely — reuse existing NLP/DTO plumbing); `uv lock` at root per `06-python-services.md`. | infra |

**Read-only reference (do NOT modify)**: `apps/harness/src/harness/sensors/base.py` (`NEREntity`, `:55` — the entity shape codes flow on, owned by TASK-476), the coded-writer chain (`nlp_client._to_entity`, `api_client._entity_payload`, `harness-internal.persistEntities` — TASK-476 owns the **write**; E1 owns the **read/reuse**), `live-documentation.service.ts` (the live snapshot **producer** `persistDurableSnapshot` `:897-950` — E1 **consumes** the `LIVE_SOAP_SNAPSHOT`, it does not change how the live loop writes it).

**Manifest-growth guard (STOP-and-report)**: E1 **consumes** TASK-476's coded rows and **matures** TASK-355's warm-start — it does not build the coded writer (that is [TASK-476](../TASK-476-Clinical-Encoder-Ontology-Linker/README.md)), re-point the live NER (that is [TASK-477](../TASK-477-Live-NER-Transcript-Repoint-Grounding/README.md)), touch the optimistic-delivery / retraction contract (that is [TASK-481](../TASK-481-Atomic-Fact-Verifier-Retraction/README.md)), or add concept-F1 / edit-burden eval (that is [TASK-482](../SOTA-Track/README.md)). If enabling warm-start in production surfaces a provisioning need, that is an **ops rollout** step (mirror TASK-478/TASK-465 ops-rollout ordering) — record it, don't hard-wire. Anything outside the manifest → STOP.

## Requirement Analysis

Unify the note lineage so the harness stops **regenerating cold**: warm-start it from the live-doc's last incremental note (a two-stage scratchpad→final), and **reuse the persisted coded `NamedEntity` rows as NER priors** instead of re-extracting the transcript from scratch — killing the duplicated SMR + NLP compute that TASK-448's seam through-line flagged ("the harness and live-doc both call SMR + NLP over overlapping content … the live draft is discarded and the harness regenerates cold").

### Current-state framing correction (verified — the premise is refined by the code, TASK-478-style)

The SOTA one-liner is "the harness regenerates cold, discarding the live-doc's incremental note." The code is more nuanced, and E1 must target the **real** gaps:

1. **Warm-start from the live note ALREADY EXISTS — but is dormant.** [TASK-355 Phase C (R-6)](../../archive/TASK-355-Harness-Latency-Optimization/README.md) shipped a warm-start path gated behind `HARNESS_WARM_START_ENABLED` (**default OFF**, `prompt-assembly.service.ts:179-196`, `harness-internal.service.ts:127-130`). When **OFF** (the default deployment), the harness cold-generates — exactly the SOTA premise. When **ON**, `harness-internal.service.ts:256` loads the `LIVE_SOAP_SNAPSHOT` (`loadLiveSoapSnapshot`) → `preSummaryText` → `prompt-assembly.service.ts:258-270` appends the running note under a *"PRIOR DRAFT (running SOAP note from the live session) … Refine and correct … do not regenerate from scratch … the full transcript remains the single source of truth"* instruction, with provenance recorded (`:356-362`). So Half-A is **enable + mature + validate** the dormant scaffolding into the full two-stage scratchpad→final lineage the S3-F5 verdict describes — **not** build it from zero, and **not** flip a prod default as a side effect (an explicit, documented rollout).
2. **The NER-priors reuse does NOT exist.** The harness re-extracts transcript entities **cold every run** — `extract_entities` over `inp.transcript_text` (`workflows.py:322-333`) → `transcript_entities`, then persists them (`:337-344`). There is **no** path that reuses already-persisted coded `NamedEntity` rows as priors to skip/seed that extraction. (The apps/api `loadNerEntities`, `harness-internal.service.ts:879-880`, reads persisted `NamedEntity` for the **prompt** — but those are the harness's **own** just-extracted rows, not reused-as-priors to avoid the extraction.) This is Half-B, and it is the genuinely-absent piece.
3. **The codes are `null` today.** TASK-476 has not landed, so every persisted `NamedEntity` carries `null` ontology codes (verified in TASK-476's Current State). NER priors are worthless until the codes exist — which is exactly why **E1 depends on TASK-476** and lands after C.

So E1's real work: **(A)** register + enable + mature the warm-start lineage (two-stage scratchpad→final, provenance, `turbo.json` env), and **(B)** add the NER-priors reuse (skip/seed the cold transcript re-extraction with TASK-476's coded rows, cold fallback preserved).

### Acceptance criteria (gated on TASK-476; measure-first where applicable)

- [ ] **AC-1 (warm-start registered + validated — Half-A)** — `HARNESS_WARM_START_ENABLED` is registered in `turbo.json#globalEnv` + both `.env.example`s (today only documented in `apps/harness/.env.example`, absent from `globalEnv`); the two-stage scratchpad→final lineage is validated (the prior live draft is refined, **the transcript stays authoritative** — a transcript↔draft conflict follows the transcript). Enabling it in production is an explicit, documented rollout, not a silent default flip. RED-first where behavior changes.
- [ ] **AC-2 (NER-priors reuse — Half-B, RED→GREEN)** — with persisted **coded** `NamedEntity` rows present (TASK-476), the harness reuses them as the transcript entities and does **not** re-run the cold `extract_entities` over the transcript (or seeds/short-circuits it); RED proves today's unconditional cold re-extraction. When priors are absent/degraded, it **falls back** to the cold extraction (no regression).
- [ ] **AC-3 (gated on TASK-476 — codes required)** — an AC asserts the reused priors actually carry the ontology codes; if the codes are `null`/absent, the reuse **falls back to cold** (so E1 is a no-op until C lands). §Implementation Summary states E1 lands after TASK-476.
- [ ] **AC-4 (replay-safe)** — the priors are a **data-only** workflow input (no new `workflow.patched()` command unless a marker is genuinely needed); the harness **replay-compat** tests (`test_replay_compat`) pass — an old history replays unchanged. No wall-clock/RNG/IO added inside `@workflow.defn`.
- [ ] **AC-5 (measure-first — redundancy-kill; TASK-470 orthogonal, concept-F1 deferred)** — record the **redundancy-elimination** metric (the harness runs **one** transcript-NER pass reused as priors, not two overlapping cold passes; and/or the SMR warm-start refinement replaces a cold regen) with **no draft-quality regression**. TASK-470's ASR scorecard is orthogonal (E1 is a summarization-lineage change, not ASR). The real quality proxy — **MEDCON concept-F1 / clinician edit-burden** — is [TASK-482](../SOTA-Track/README.md) (E3, itself gated on TASK-476's codes); E1 does not re-implement it.
- [ ] **AC-6 (durable authority preserved)** — warm-start **refines**, the transcript is authoritative, the harness stays the system of record; the live loop's snapshot-write path is unchanged (E1 only reads the `LIVE_SOAP_SNAPSHOT`).
- [ ] **AC-gate** — `pnpm py:harness:test` (hermetic — Temporal/LLM/NLP stubbed) + `py:harness:lint` + `py:harness:typecheck` green; `pnpm --filter @arcaai/applications build test lint` green; `pnpm build:api` green (if the read endpoint/DTO lands); `uv lock` re-run if deps changed; harness replay-compat green; output pasted.

### Non-goals

- **Building the coded `NamedEntity` writer / clinical encoder + linker** — that is [TASK-476](../TASK-476-Clinical-Encoder-Ontology-Linker/README.md) (C1); E1 **consumes** the codes.
- **Re-pointing / grounding the live NER** — that is [TASK-477](../TASK-477-Live-NER-Transcript-Repoint-Grounding/README.md) (C2).
- **The atomic-fact verifier + optimistic-delivery retraction contract** — that is [TASK-481](../TASK-481-Atomic-Fact-Verifier-Retraction/README.md) (E2).
- **MEDCON concept-F1 / harm-weighted error rate / edit-burden telemetry** — that is [TASK-482](../SOTA-Track/README.md) (E3); E1 records only the redundancy-kill metric.
- **Changing how the live loop writes the `LIVE_SOAP_SNAPSHOT`** — E1 reads it; the producer (`persistDurableSnapshot`) is untouched.
- **`continue_as_new` / claim-check payloads** — E4 ([TASK-483](../SOTA-Track/README.md)); unrelated.
- **A cloud model** — self-hosted only (track guardrail).

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ `87199e33`)

**Half-A — warm-start from the live note is scaffolded but DORMANT (default OFF):**
- Kill-switch: `prompt-assembly.service.ts:179-196` and `harness-internal.service.ts:127-130` both read `HARNESS_WARM_START_ENABLED` (parsed to a boolean, **default OFF**); `harness-internal.service.module.ts:21-22` supplies the `ConfigService` for it.
- When enabled: `harness-internal.service.ts:256` `const liveSnapshot = this.warmStartEnabled ? await this.loadLiveSoapSnapshot(consultationId) : null;` → passed as `preSummaryText` to `promptAssemblyService.assemble` (`:285`); `prompt-assembly.service.ts:258-270` appends the `--- PRIOR DRAFT (running SOAP note from the live session) ---` block + `INSTRUCTION: Refine and correct … do not regenerate from scratch … the full transcript remains the single source of truth`. Provenance: `harness-internal.service.ts:356-362` re-resolves the same frozen `LIVE_SOAP_SNAPSHOT` and records its id.
- **Config gap**: `HARNESS_WARM_START_ENABLED` is **absent from `turbo.json#globalEnv`** (grep shows only `HARNESS_URL:112`); it is documented only in `apps/harness/.env.example:132`.
- The snapshot source: the live loop upserts ONE `PRE_SUMMARY` row tagged `metaData.subType = 'LIVE_SOAP_SNAPSHOT'` (`live-documentation.service.ts:892-950`), resolved by `findLiveSnapshotRow` (`:960-966`) / the harness `loadLiveSoapSnapshot` (`harness-internal.service.ts:819-821`).

**Half-B — the harness re-extracts transcript entities COLD every run; no priors reuse:**
- `workflows.py:322-333` — `extract_entities` over `inp.transcript_text` → `transcript_entities` (the cold NER pass), unconditional (only degrades to human-review on NLP failure, `:334-335`).
- `:337-344` — `persist_entities` writes `transcript_entities` → `NamedEntity` rows; `:365` feeds retrieval context; `:470` / `:658` feed `run_sensors`.
- There is **no** reuse-as-priors path — nothing reads already-persisted coded `NamedEntity` rows to skip/seed the extraction. The apps/api `loadNerEntities` (`harness-internal.service.ts:879-880`, `namedEntityRepository.findByConsultation`) loads persisted rows **for the prompt**, but those are the harness's own just-written rows, not priors that avoid the extraction.

**The codes are `null` today** — TASK-476 has not landed, so the NLP producer emits entity types with no ontology codes and every `NamedEntity` writer persists `null` codes (see TASK-476 §Current State). The priors are therefore worthless until C lands — the reason **E1 depends on TASK-476**.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-355 README (the R-6 warm-start scaffolding this matures) · TASK-476 README (the coded rows this reuses — land E1 after it) · TASK-448 §SOTA S3 verdict (b) (two-stage scratchpad→final + reuse `NamedEntity` priors) · TASK-449 §Architecture preamble (harness authoritative; transcript is truth) · `.claude/rules/06-python-services.md` (harness — Temporal determinism, replay-compat, hermetic CI, `uv lock`) · `.claude/rules/04-application-services.md` (prompt-assembly, harness-internal, DTOs).

1. **Register + enable warm-start (Half-A, RED where behavior changes)** — add `HARNESS_WARM_START_ENABLED` to `turbo.json#globalEnv` + both `.env.example`s; validate the two-stage scratchpad→final lineage (prior draft refined; transcript authoritative on conflict). Document the production rollout (not a silent default flip).
2. **NER-priors read path (Half-B, RED→GREEN)** — add `load_entity_priors` (activity + `api_client` read + apps/api endpoint); RED proves the cold re-extraction today; GREEN reuses the coded rows.
3. **Wire into the workflow (Half-B)** — seed/skip `extract_entities` with the priors when coded rows exist; **fall back to cold** when absent/degraded; keep it a **data-only** input (replay-safe).
4. **Replay-compat** — run `test_replay_compat`; assert an old history replays unchanged (no new command / patch unless genuinely required).
5. **Measure (redundancy-kill)** — record the one-pass-not-two reduction + no draft-quality regression; defer concept-F1/edit-burden to E3.

### Verification gate (paste output into §Implementation Summary)

```bash
# harness (workflow + priors; hermetic — Temporal/LLM/NLP stubbed)
pnpm py:harness:test && pnpm py:harness:lint && pnpm py:harness:typecheck
# TS prompt-assembly + harness-internal warm-start
pnpm --filter @arcaai/applications build test lint
pnpm build:api          # if the read endpoint / DTO lands
# harness replay-compat (Temporal determinism)
pnpm py:harness:test -k replay_compat
```

Adversarial review focus (reviewer agent): (a) does the harness genuinely **reuse** coded priors and **skip/seed** the cold `extract_entities` — proven by a RED that failed on today's unconditional cold pass? (b) does it **fall back to cold** when the codes are `null`/absent (so E1 is inert until TASK-476 lands)? (c) is the change **replay-safe** — data-only input, `test_replay_compat` green, no wall-clock/RNG/IO in `@workflow.defn`? (d) is `HARNESS_WARM_START_ENABLED` now in `turbo.json#globalEnv`, and is enabling it in prod an explicit rollout rather than a silent default flip? (e) does warm-start keep the **transcript authoritative** (refine, not replace)? (f) zero diff outside the manifest — no coded-writer (476), no live NER (477), no retraction (481), no snapshot-producer change.

## Implementation Summary

Implemented against `fix/2605-review` (base `a56d682ed`). TASK-476's coded-write path is already present in this base (`NEREntity` ontology codes + `nlp_client._to_entity` + `api_client._entity_payload`), so E1 consumes it. TDD, RED→GREEN, strictly replay-safe.

**Half-B — NER-priors reuse (Python harness + apps/api read):**
- `apps/harness/.../temporal/models.py` — `ExtractEntitiesInput` gains `reuse_priors`/`consultation_id`/`tenant_id`; `EntitiesResult` gains `reused` (additive-optional ⇒ replay-safe).
- `apps/harness/.../services/api_client.py` — new `load_entity_priors()` read + `_entity_from_payload()` (inverse of `_entity_payload`).
- `apps/harness/.../temporal/activities.py` — `extract_entities` reuses coded priors (skips the cold NLP `classify_tokens`) when `reuse_priors` + `HARNESS_NER_PRIORS_ENABLED` + at least one prior carries a code; else cold. `_load_coded_priors` degrades to cold on any apps/api error.
- `apps/harness/.../core/config.py` — `ner_priors_enabled` (`HARNESS_NER_PRIORS_ENABLED`, default OFF) ops kill-switch, read at runtime inside the activity (not the workflow) ⇒ no snapshot/patch.
- `apps/harness/.../temporal/workflows.py` — the transcript `extract_entities` call is seeded with `reuse_priors=True` + ids; `persist_entities` is skipped when `priors_reused` (rows already exist). **Data-only workflow input change: no new command, no `workflow.patched()`** — all 7 frozen replay fixtures pass unchanged (AC-4). The chosen "extend `extract_entities`" manifest option keeps the workflow command sequence byte-identical (the load/gate logic lives in the activity).
- apps/api read endpoint (Half-B): `HarnessInternalService.getEntities()` (CLS + 404-over-403 + `loadNerEntities` projection), `HarnessEntitiesResponse` DTO, and `GET /internal/harness/consultations/:id/entities` on `HarnessInternalController`.

**Half-A — warm-start maturation (TS):**
- `prompt-assembly.service.ts` — the single-append fallback is matured into the explicit **two-stage scratchpad→final** lineage (STAGE 1 SCRATCHPAD = live note; STAGE 2 FINAL = harness note; transcript authoritative on conflict). Surgical wording enrichment — existing `PRIOR DRAFT`/`Refine`/`single source of truth`/`follow the transcript` substrings preserved; the loader/provenance in `harness-internal.service.ts` are unchanged (validated by existing tests).
- Env registration: `HARNESS_WARM_START_ENABLED` + `HARNESS_NER_PRIORS_ENABLED` added to `turbo.json#globalEnv`, root `.env.example`, and `apps/harness/.env.example` (AC-1).

**Tests (RED→GREEN):** activity reuse/fallback (`test_activities.py`), api_client read (`test_api_client.py`), workflow persist-skip + reuse wiring (`test_doc_workflow.py` + `_harness_stubs.py`), service read (`harness-internal.service.test.ts`), controller route (`harness-internal.controller.test.ts`), prompt two-stage framing (`prompt-assembly.service.test.ts`).

**Gate evidence:**
- `pnpm py:harness:test` → **706 passed** (incl. `test_replay_compat` 7 fixtures GREEN — replay-safe); `py:harness:lint` (ruff) clean; `py:harness:typecheck` (mypy) clean (81 files).
- `pnpm --filter @arcaai/applications test` → **5972 passed / 4 skipped**; `build` clean; `lint` — 0 warnings on the 3 changed files (94 pre-existing prettier warnings elsewhere, untouched).
- `pnpm build:api` → 8 tasks successful; controller eslint clean (0 errors); `harness-internal.controller.test.ts` **18 passed**.

**No new deps** (`uv.lock` untouched). **No new model download** — reuse reads persisted rows; the existing `blaze999/Medical-NER` runs only in the cold fallback. E1 is inert until TASK-476's codes are populated (reuse gates on a present ontology code).

## Change History

| Date | Change |
|---|---|
| 2026-07-11 | **Implemented (Review).** Half-B NER-priors reuse (data-only, replay-safe: extended `extract_entities` + activity-side load/gate + apps/api `getEntities` read endpoint + `HARNESS_NER_PRIORS_ENABLED` kill-switch) and Half-A two-stage scratchpad→final warm-start maturation + env registration. RED→GREEN throughout; `test_replay_compat` green (no new `workflow.patched()` — an old history replays unchanged). Gates: `py:harness:test` 706 passed + ruff/mypy clean; `@arcaai/applications test` 5972 passed + build/lint clean on changed files; `build:api` green. See Implementation Summary. |
| 2026-07-10 | Detail-scaffolded from [SOTA-Track](../SOTA-Track/README.md) Theme **E1** into an execution-ready ticket. **Current-state framing corrected against the code (TASK-478-style):** the SOTA premise "the harness regenerates cold, discarding the live-doc's incremental note" is refined — **warm-start from the live note ALREADY EXISTS but is dormant** (TASK-355 Phase C R-6, `HARNESS_WARM_START_ENABLED` **default OFF**: `prompt-assembly.service.ts:179-196`/`:258-270` appends the `PRIOR DRAFT` refine-instruction; `harness-internal.service.ts:256`/`:356-362` loads the `LIVE_SOAP_SNAPSHOT` + records provenance; the var is **absent from `turbo.json#globalEnv`**, documented only in `apps/harness/.env.example:132`), so Half-A is enable+mature+register into the two-stage scratchpad→final lineage, not build-from-zero. **The NER-priors reuse genuinely does NOT exist** — `workflows.py:322-333` re-extracts transcript entities **cold every run** and persists them (`:337-344`); nothing reuses persisted coded `NamedEntity` rows as priors. Codes are `null` today (TASK-476 not landed) → E1 **depends on TASK-476** and lands after C (gating chain E1 → TASK-476 → TASK-470). Measure-first: redundancy-kill metric here; MEDCON concept-F1 / edit-burden deferred to TASK-482 (E3). No implementation; documentation only. |
