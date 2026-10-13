# TASK-1066 — E2E: ALaaS web_ui ↔ audio-stream-svc ↔ HOPE cluster, multi-encounter lifecycle, tenant-admin console audit

**Status:** Review — fixes merged and verified on the cluster (2026-10-13)
**Date:** 2026-10-12 · **Type:** verification · **Branch:** dev-2.2 · **Target:** cluster `hope-v2-dev` (`api.taphuynh.dev`, `admin.taphuynh.dev`)

## Requirement Analysis
Verify, end-to-end through the real ALaaS web_ui driven in a browser: latest SDK lifecycle, the web_ui ↔ audio-stream-svc ↔ HOPE path, multi-encounter consultations (start/pause/stop, open/draining/reopen/close-complete/close-incomplete), realtime transcript + NER, pre-summary, recap, final summary, durable workflows; then audit the tenant-admin console (`/consultations`, `/consultations/[id]`) for blank/missing fields. Run up to 3 concurrent sessions to check cluster performance. Report metrics, defects, recommendations — no bug fixing.

## Current State Evaluation (test setup)
| Lane | Scope | Result |
|---|---|---|
| A | ALaaS → local HOPE | **Cancelled by owner** ("do NOT run local hope"). Side effects before stop: LM Studio loaded `gemma-4-e2b-it-qat` (left loaded, TTL 3600 s); `pnpm db:push` added nullable `GateEditExemplar.structureAfter` to local dev DB; local infra restarted (dev Vault now empty → existing local PHI likely undecryptable). Worktree `../ALaaSv3.0-e2e-1066a` left. |
| B | ALaaS web_ui (browser) → broker :4200 → cluster; console audit | Done. Runs A1/A2 headless (before the browser directive), UI-E3 via browser clicks. |
| C | 1 baseline + 3 concurrent browser tabs (broker :4300, web_ui :5301-5303) → cluster | Done; baseline headless + UI, 3× encounter 1 and encounter 2 via UI. |

**Deviation — tenant:** the only ALaaS service account is bound to **ArcaAI** (`50000000-…-0001`); it gets 403 on Global. All realtime consultations were created in ArcaAI; the Global audit used the 9 seeded Global consultations as `tenant_admin`.

Consultations: `01a1305e-8265-7a76-818f-bcf55e6f9431` (headless), `01a13067-8072-7661-9b2e-411f0e63204b` (UI-E3), `01a13064-5db9-7386-a165-f6beff335008` (UI-E1/E2 + Lane C's encounter 3 — see B-2), Lane C rows `E2E1066C-*`. Evidence: `.e2e-tools/t1066/lane{A,B,C}/` (gitignored).

## Results — functional cases
| Case | Result | Evidence |
|---|---|---|
| E1 open with context | PASS | governing run `arcaai-bren-consultation`; 3 structured items (identity, vitals), 10 case notes |
| E2 start→pause→resume→stop | PASS | UI state chain observed; pause 0.30–0.45 s, resume 0.30 s, start→streaming 0.9–8.5 s |
| E3 realtime transcript | PASS | first partial 0.7–0.8 s (headless), on-screen ≤ 7 s (UI); final ≈ 240 ms after utterance end |
| E3 NER highlights | **FAIL** | 0 `entities` frames in every run though the graph has `n_ner` (B-1) |
| E4 pre-summary | PASS (slow) | 13–55 s after open; UI showed "Waiting for the first section" until after pause |
| E5 second encounter + recap | PARTIAL | same-eventId revisit → no encounter 2 (B-4); patient-keyed reattach appends encounters; `ENCOUNTER_RECAP`/`FACT_LEDGER` stored but recap not visible in web_ui |
| E6 final note + harness | PASS (slow) | stop→note 82–215 s single, up to 313 s at 3×; all ended `AWAITING_REVIEW / NOTE_COVERAGE_GAPS`; trace `ead451ab53a26598d64dc0de7f02d5f5` |
| E7 approve / close / reopen / abandon | **BLOCKED** | "EMR Copy: Failed" — standalone web_ui has no EMR opener; abandoned rows show `autoCloseAt = lastActivity + 12 h` (not observed elapsing) |
| E8 attachment | **BLOCKED** | web_ui has no document upload; `GET …/attachments` → `[]` |

## Results — performance (Lane C, 2026-10-12 UTC)
| Step | Headless baseline | UI baseline | UI 3× enc 1 | UI 3× enc 2 |
|---|---|---|---|---|
| Open | 2.7 s | — | — | — |
| Start→streaming | 8.5 s | ≤ 8 s | ≤ 8 s | ≤ 8 s |
| First partial / final | 0.8 / 2.7 s | ≤ 7 s on screen | ≤ 7 s | — |
| Stop→note ready | 102 s | ~178 s | 210 / 278 / 313 s | 332 s, **2 of 3 FAILED** (+347 s, +392 s) |

Resources (peak, 14:03–14:12): lmstudio 1.28 c / 14.85 GiB; nlp 0.38 c / 5.57 GiB (limit 8); stt 0.56 c / 976 MiB; api 0.15 c / 637 MiB; postgres 27 conns / 1.8 GiB; all others < 0.05 c. **GPU0 100 % util, 11.1/16 GiB; GPU1 81 %, 8.3/16 GiB.** Single LLM calls up to 157 s (`finish_reason=length`, 5,632 tokens). No OOM, no unplanned restart (nlp restarted once at 13:59:18Z exit 0 — before the 3× window).

**Bottleneck:** LM Studio on GPU0 — note latency scales with concurrency; CPU, memory, Postgres, Temporal idle. Same conclusion as TASK-1058: limits are software/serving config, not hardware.

## Defect Register
| Id | Sev | Defect | Root cause / evidence |
|---|---|---|---|
| B-1 | H | NER entities never reach the web_ui | `n_ner` runs in graph, zero `entities` frames emitted (cf. TASK-1058 grounding drop `groundEntitiesToNote`) — needs RCA |
| B-2 | H | Another session/event for the same patient same day is appended as an encounter of an existing consultation (cross-session bleed) | visit identity keyed on patient, not event/externalRef |
| C-2 | H | At 3 concurrent, 2/3 second-encounter notes FAIL after ~6 min | harness `interpreter.core_agent` attempt fails at ~345 s queued behind LM Studio → "workflow run ended without a clinical result"; hypothesis activity timeout vs LM Studio slots |
| C-1 | H | Guardrail evaluation outbox never drains | API `PayloadTooLargeError` on 100-row batch, surfaced as 500, retried every 30 s |
| B-3 | H | `processing=IDLE` for ~3.5 min while note is written; web_ui shows "final note did not arrive in time" + "agent/model unavailable" | SUMMARIZING not set on stop-triggered governed finalize; UI labels wrong |
| B-5 | M | Console list: encounters `[]`, approval/autoCloseAt `null`, `isNew=false` | **verified**: list paths call `ConsultationDtoMapper.toResponse(c)` without a view — `consultation.service.ts:1696,1714,1752,1784,1815,1861,1887,1959`; contract documented `consultation.dto.mapper.ts:21-26` |
| B-6 | M | Detail header shows only id + status (no patient, doctor, department, visit type, approval, closed reason) | `consultation-activity-screen.tsx:271-292` |
| B-7 | M | Guardrail notices tab 403 for tenant admin while header counts "1 open notice" | `guardrail-notice.controller.ts:57` business-plane gate; console calls it at `api/guardrail.ts:101` |
| B-8 | M | Stale state: governingRun stays RUNNING after `note.final`; rows stuck OPEN/SUMMARIZING and STOPPED/SUMMARIZING for hours | run / processing not finalised |
| B-4 | M | Same-eventId revisit creates no encounter 2 | `encounterCount` stays 1 |
| C-3 | M | "The case note could not be written" transient in 2/3 tabs under load, then recovers | not root-caused |
| B-x | M | NOTE / PRE_SUMMARY / CASE_NOTE / FULL_TRANSCRIPT / STRUCTURED items have `encounterSeq: null`; context re-stored on every encounter (3 × 13.7 kB) | history stamping + broker re-sends context on reopen |
| B-9 | L | Legacy JSON note rendered raw; seeded Global rows have no encounters/media, out-of-order timestamps | console `activity-item-row.tsx` ItemBody; seed gaps |
| B-10 | L | web_ui sends empty visit type | broker warn "Visit type '' is not a spelling HOPE knows" |
| C-4 | L | Temporal search attribute `HarnessTenantId` unregistered → warning per signal, log flood | Temporal namespace config |
| B-11/C-5 | L | ALaaS hardcodes mic agent `:5001` and CORS 5173/5174 | `MultiMicAudioPlayer.jsx:505`, `AudioStreamPlayer.jsx:52`, `audio-stream-svc/src/main.ts:137` |
| C-7 | L | Broker `GET /emr/provider-type` 401 "API key is required" every page load | ALaaS broker key not forwarded on that route |
| — | L | Doctor shown as `auto_…` username; working-tenant banner shows UUID after tenant switch | unmapped ALaaS consultant → auto-provisioned; `tenant-scope-banner.tsx:18` fallback |
| — | info | `hope-text get_info.failed` for vllm/llama-cpp/ollama each minute | noise from unconfigured providers |
| ENV | — | No Global service account for ALaaS; EMR sign-off untestable in standalone web_ui; ALaaS mock patient shared across lanes | test-rig gaps |

Note quality (observed): UI-E3 final note drew mostly on prior-visit content; transcript medications (metformin, amlodipine) absent; all speech attributed to Doctor (single mic).

## Recommendations (no actions taken)
1. **Console blanks (B-5/B-6):** batch-load `ConsultationLifecycleView` (or include `Encounters` + approval) in list queries — one query per page, not per row; render a detail header from the detail response (patient, doctor display name, department, visit type, approval, closedReason, autoCloseAt).
2. **Visit identity (B-2/B-4):** key reattach on `externalRef`/eventId first, patient-day only as an explicit fallback; add a contract test with two events for one patient.
3. **LLM capacity (C-2/B-3/E6):** cap note `max_tokens` well under 5.6 k or fix the prompt causing `finish_reason=length`; align `core.agent` activity timeout with queue reality (heartbeat + schedule-to-start budget) and fail visibly with retry rather than terminal FAILED; add admission control / per-tenant concurrency on LM Studio; set `processing=SUMMARIZING` at stop.
4. **NER (B-1):** trace `n_ner` output to the stream emitter; add an e2e assertion that ≥ 1 `entities` frame is emitted on a medication-bearing script.
5. **Guardrail outbox (C-1):** smaller batches or raise the internal route's body limit; map 413 to 413 (not 500) and back off.
6. **State hygiene (B-8):** finalise `governingRun` and clear `processing` on `note.final`; add a sweeper alert for rows in SUMMARIZING > 15 min.
7. **Authz (B-7):** either grant tenant admins the guardrail-notice read on the admin plane or hide the count when the tab is not readable.
8. **Observability:** register `HarnessTenantId`; stop polling unconfigured text providers; add Grafana panels for stop→note-ready p50/p95, LM Studio queue depth, outbox backlog.
9. **Test rig:** provision a Global-bound ALaaS service account; make ALaaS mic-agent URL and CORS env-driven; per-lane mock patients; a stub EMR opener to exercise approve/close.

## Root Causes (RCA, 2026-10-12)
| Id | Root cause | Kind |
|---|---|---|
| B-3/C-3 | governed encounter-1 SUMMARIZING guard required IDLE but stop held FINALIZING_TRANSCRIPT (`encounter-refinalize.service.ts`), then stop wrote IDLE unconditionally (`consultation-lifecycle.service.ts`); ALaaS broker gave up at 180 s because HOPE reported no work | bug |
| B-8 stuck | refinalize set SUMMARIZING before a supersede that answered `duplicate`, never cleared | bug |
| B-8 RUNNING | run parked at the review gate; ALaaS auto-approve off in the rig (OD-14) | by design |
| C-2 | `n_finalize` 300 s == per-call 300 s → Temporal cancelled the repair call; `ActivityBudget` assumed 120 s/call and ignored slot wait; harness LLM concurrency 1; truncation retry doubled `max_tokens`; `n_output` ran on an empty result | bug + config |
| B-1 | NER ran in the gateway realtime lane but entities rode only on a finished LLM flush (56–65 s) and stop cancelled the flush with no NER (TASK-1063 1a) | design gap |
| C-1 | Express 100 kB body default on the internal evaluation route; 413 mapped to 500; outbox retried the same batch | bug |
| C-4 | `HarnessTenantId` search attribute never registered | config |
| B-5 | list paths mapped without the lifecycle view | bug |
| B-6/B-7/B-9/banner/doctor | console header built from the activity feed; notices called the clinician route; legacy JSON not unwrapped; tenant name only stored when sent; no display-name fallback | bug |
| encounterSeq / context | `addContext` never stamped; `appendEncounter` re-stored open context | bug |
| B-2/B-4 | TASK-1045 D-3 visit keying (owner kept it); ALaaS fake adapter + comment stale | by design |
| B-10/B-11/C-7 | ALaaS: visitType read from EMR rows that never carry it; hardcoded mic URL/CORS; empty API key | bug / rig |

Owner decisions (2026-10-12): keep D-3; stamp NOTE/PRE_SUMMARY with the encounter; NER early snapshot (A) + NER at stop (B, amends TASK-1063 1a for NER only); raise ArcaAI `maxWorkflowDefinitions` to 40.

## Implementation Summary
| Lane | Model | Branch → merge | Change |
|---|---|---|---|
| L1 | opus | task-1066-l1 | SUMMARIZING guard accepts FINALIZING_TRANSCRIPT; conditional stop restore (`setProcessing onlyIfProcessing`); SUMMARIZING only after a real supersede |
| L2 | opus | task-1066-l2 | batch lifecycle views for lists (`findByConsultations`, `findLatestByConsultations`, `lifecycleViews`); encounterSeq on STRUCTURED/CASE_NOTE/WORKNOTE/PRE_SUMMARY/NOTE writers; skip unchanged open context on append |
| L3 | opus | task-1066-l3 | durable `core.agent` timeout 600 s (seed + regen); `ActivityBudget` costs calls at the governor timeout from attempt start; bounded truncation retry; `core.output` skipped after a failed producer (`upstream-failed-output` patch + replay fixtures) |
| L4 | opus | task-1066-l4 | early NER entity snapshot with ordering guard; 3 s tail NER at stop |
| L5 | sonnet | task-1066-l5 + deployment `task-1066` | 2 MB limit on the internal evaluation route, 413 preserved, outbox batch halving; `GET admin/consultations/:id/guardrail-notices`; provider probe skip; search-attribute warn-once; deployment: `HARNESS_LLM_MAX_CONCURRENCY=4`, out-of-band `temporal-search-attributes.yaml` |
| L6 | sonnet | task-1066-l6 | console header meta, admin notices route, legacy note unwrap, working-tenant name hook, doctor display name |
| L7 | sonnet | ALaaS `task-1066` → `refactor-hope-integaration` | env-driven mic URL + CORS, EMR provider-type skip without key, label fix, fake adapter follows D-3, visit type from patient context |
| orchestrator | — | `0af2dbf62` | wire `remaining_seconds` at both `execute_plan` sites; register replay fixtures; regenerate route-manifest/openapi/portal/vox-node admin; admin-notices test stubs |

Post-merge gates (2026-10-12): builds + api typecheck + artifact checks + `pnpm lint` green; domains 2120, applications 19133, database 2441, test:unit 34025 passed (1 flaky — random UUID contains "54"); console 5059 passed (2 pre-existing failures also red on base: `app-sidebar`, `findings-list.asr-warnings`); harness 3843, guardrail 1116, text 2294 passed; ALaaS web_ui 820 passed, audio-stream-svc 1368/1371 (logger spec order-dependent, red on base too).

Cluster rollout (2026-10-13): pipeline #1464 → promote `dev-0af2dbf6`; job `hope-temporal-search-attributes-2` registered `HarnessTenantId` (first attempt blocked by `allow-intra-platform` — out-of-band job lacked `environment: dev`, fixed in deployment `71396b6`); 15 workflow definitions republished with 600 s (Global 2, ArcaAI 13); ArcaAI entitlement override `maxWorkflowDefinitions: 40` (row `01a132be-3019-…`, undo = DELETE override).

## Verification (browser-driven ALaaS web_ui → broker → cluster, 2026-10-13)
Evidence: `.e2e-tools/t1066/verify/{V1,V2,V3}/` (screenshots, polls, broker/web_ui logs).

| Defect | Verdict | Before → after |
|---|---|---|
| B-3/C-3 | FIXED | IDLE ~3.5 min + "did not arrive in time" → SUMMARIZING within 1–6 s of every stop, no timeout/unavailable labels (V1, V2 all 9 notes) |
| C-2 | FIXED | enc-2 at 3×: 2/3 FAILED at ~345 s → 6/6 follow-up notes completed (enc 2: 202/225/284 s; enc 3: 209/212/219 s) |
| E6 latency | improved | enc 1 at 3×: 210/278/313 s → 140/194/217 s; single: 82–215 s → 57–65 s |
| B-8 | FIXED | no stuck SUMMARIZING; ends AWAITING_REVIEW (run RUNNING at review gate = by design) |
| B-1 | FIXED | 0 highlights → 7 findings ~30 s into recording; short encounter 5 → 14 at stop |
| encounters / context | FIXED (partial, see V-2) | context 3 × 13.7 kB per encounter → 1 new identity item; recap + "Return visit" shown |
| C-1 | FIXED | 500 every 30 s → 107 × 200, no 413/500 |
| C-4 | FIXED | warning flood → 0 in 6 h |
| B-5 | FIXED (API) | list rows carry encounters/approval/autoCloseAt (51/51); grid has no columns for them — shown in detail header |
| B-6, B-7, B-9, banner, doctor name | FIXED | header full; notices 200 + counts match; legacy JSON rendered; tenant name (brief "selected tenant" flash on cold load); "Auto-provisioned clinician" |
| B-10, C-7, B-11/C-5 | FIXED | no visit-type warning; provider-type 200; non-default ports via env only |
| get_info noise | **STILL FAILING** | vllm/llama-cpp/ollama `get_info.failed` every minute — the probe-skip condition does not match the cluster's provider state |
| E7 Copy to EMR | BLOCKED (rig) | standalone web_ui has no EMR opener; now fails silently (V-5) |
| a11y | PASS | axe 0 violations (dark); light inconclusive |

### New defects from verification (not fixed)
| Id | Sev | Defect |
|---|---|---|
| V-1 | **H** | note safety: final note says "Allergic to allopurinol" (transcript: penicillin ×4); exam uses mock vitals 110/60 not spoken 152/94; "97.8 °C" |
| V-2 | M | encounter-2 note stored as version 2 of the encounter-1 NOTE item → keeps `encounterSeq: 1`, no NOTE@2 |
| V2-1 | M | `hope-nlp` restarted (exit Completed, no OOM, 5.4/8 GiB) 30 s into the 3× encounter-3 round |
| Q-1 | M | entitlement `maxWorkflowDefinitions` counts every version, so routine republishing exhausts the plan |
| V-6 | M | status AWAITING_REVIEW while governingRun reads RUNNING (gate) — console shows them side by side without explanation |
| V-3 | L | encounter 2 stamped `visit_type: new-visit` though it is a return visit |
| V-4 | L | opening an encounter does not bump `lastActivityAt` → autoCloseAt counts from the previous encounter |
| V-5 | L | Copy to EMR without an opener: no request, no feedback |
| V2-2 | L | live draft "The last update did not arrive" for ~20–30 s twice under 3× load, self-recovers |
| V2-3 | L | harness `live_handoff_unavailable` (empty error) ×6, `compute_metering.sample_dropped_no_tenant` ×5 |
| V-7 | L | one PRE_SUMMARY, FULL_TRANSCRIPT, ATTACHMENT unscoped; seeded Global rows lack approval/encounters; guardrail pager "1–8 of many" |

## Change History
- 2026-10-12 — run executed (lanes B, C on cluster; lane A cancelled), report written.
- 2026-10-12 — RCA (3 lanes), owner decisions, 7 fix lanes merged into dev-2.2 / ALaaS / deployment; post-merge gates.
- 2026-10-13 — deployed (pipeline #1464), Temporal attribute registered, workflows republished (600 s), ArcaAI limit raised; browser e2e V1/V2/V3 verified.
