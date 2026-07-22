# Assessment — Harness Agentic Loop Runtime (TASK-533 + stt-v2 producers) — 2026-07-22

| | |
|---|---|
| **Program** | TASK-539 Continuous Quality — cycle 1, queue item 3 |
| **Targets** | F-006 (D-22 segment→citation chain), F-007 (settings convergence), F-008 (dead knobs), F-010 (stt-v2 producers) |
| **Method** | Live dev stack driven end-to-end: real WS audio streaming through the gateway bridge, harness Temporal workflow on live LM Studio generation, dual-gateway convergence measurement, replay-compat regression run |
| **Doctrine** | "Review = statically green, runtime-unproven" — this is the runtime proof |

## Verdict (one paragraph)

The D-22 chain is **real end to end** — a live consultation streamed over `/ws/stt-v2/stream` produced exact-offset `TranscriptSegment` rows, `assemble` surfaced them as PHI-safe `segmentCitations`, the worker folded the StrictCitations block into the generate prompt, and the delivered clinical note came back **citing the actual persisted segment id** (`[[seg:019f8633-3eec…]]` ×5), encrypted at rest and decrypting cleanly on the doctor read. But the first live run found a **new P0 the entire ~16.8k-test static wall had concealed: `ContextItem.content` was silently unpersisted on every write lane except the one service that carries the cipher call** — the streamed transcript and the harness draft both landed as all-NULL ciphertext, the note was generated from a template with **no transcript in the prompt**, and nothing warned. Three sites on the assessed chain were TDD-fixed in-session (RED 3 → GREEN 144; applications suite 6,682 green) and the full chain re-proven live; ~9 sibling sites (all legacy summary processors, the clinician-edit write, OCR enrichment) remain open as a new finding. The toggle story splits cleanly in two: the **HarnessPolicy lane converges fleet-wide in milliseconds** (PATCH → both instances' `fetch_policy` view flipped in ~60 ms, no restart), while the **settings-registry lane converges on a once-a-minute cron** — measured 38.2 s to the second instance, and the cron is `45 * * * * *` (at second :45 each minute, worst case ~60 s), not "every 45 s" as the code comment and prior docs state. The `[[seg:]]` citation lane is **write-only**: markers reach the clinician-visible note text raw, `extract_cited_segment_ids` has zero production callers, and `citation_presence` gives no credit for them.

## Rubric scores

| Dimension | Score | Justification |
|---|---|---|
| Correctness | **at-risk** | Core chain proven live (post-fix), but the first run surfaced a silent clinical-content-loss P0 (H-1) that shipped through every static gate; marker lane half-built (H-2); claims-lane enrichment still live-unproven (NLP model unavailable on this host) |
| Completeness | **at-risk** | H-1 has ~9 unfixed sibling sites; `[[seg:]]` extraction/stripping never wired (H-2); `claimCheck.minBytes` still governs nothing (F-008 residue); mcpServers overlay returns `[]` (no registered rows) so D-24 is wire-proven but not end-to-end-with-a-real-MCP-server |
| Performance | **adequate** | Stream → segments persisted same second; draft ~54 s after transcript (35 s of that is local e2b generation); token accounting live (1,316 / 2,165 total_tokens on trajectory LLM_CALL steps); LM Studio `ttl` observed applied (3 m) with eviction-driven JIT-reload 500 bursts absorbed by activity retries |
| Security & PHI | **at-risk** | H-1 *is* a PHI-at-rest defect (loss, not leak — fail-closed by accident); post-fix `vault:v1:` ciphertext verified at rest and decrypt-on-read verified; segment rows carry offsets only (verified no text column); F-029 corroborated live (`API_GATEWAY_KEY is not configured — rejecting internal request for 'stt-v2'`) |
| Test posture | **at-risk** | The doctrine vindicated a second time: mocked-repository seams hid H-1 exactly as they hid F-025/F-026; seeds encrypt correctly, which *masked* the runtime writers that don't — dev data looked healthy while live writes lost content |
| SOTA delta | **adequate** | StrictCitations-style inline evidence is the right pattern (matches inline-citation grounding practice); the missing half is verification-side: extract → validate → strip → structured citations, which peers treat as one loop, not a prompt-only feature |

## Findings (ranked)

### H-1. `ContextItem.content` silently unpersisted on every writer except `context.service.ts` — clinical transcripts and notes lost at rest — **P0, 3 sites FIXED in-session, ~9 sites OPEN**

The PHI field-encryption migration dropped the plaintext `content` column; persistence now requires `contextItemRepository.encryptContentIntoEntity(...)` before `create/update` (the mapper writes only `encryptedContent`, silently discarding the transient `content`). Exactly **one** service calls it (`context.service.ts:125`). Every other writer persists rows whose content vanishes: `sttInternal.service.ts` (batch :175 + streaming :240 transcripts), `harness-internal.service.ts:499` (harness draft), `summary.processor.ts:177`, `pre-summary.processor.ts:154`, `comprehensive-summary.processor.ts:187`, `chain-summary.service.ts:165`, `summary.service.ts:199/:330/:490/:708` (:490 is the **clinician-edit MODIFIED_SUMMARY write**), `ocr-enrichment.processor.ts:117`. The siblings (SummaryMeta, ContextItemVersion, NamedEntity) were all wired with `encryptFieldsIntoEntity` — the primary artifact was missed.

- **Failure scenario (observed live, run 1):** streamed transcript row `encryptedContent = NULL`; harness draft `NULL`; the doctor's context read returns `content` length 0 for both; the assemble prompt contained **no transcript** (verified `'shortness of breath' not in userPrompt`), so the note was generated from the template alone — and still passed persist, gate, and delivery with no warning anywhere.
- **Why every environment is affected:** `encryptPhiFields` only changes *failure handling* by env (soft-log in dev, throw in prod). At these sites the cipher is **never invoked**, so production behaves identically — silent loss.
- **Why nobody noticed:** the seeds encrypt correctly (`seed/phi-encryption.ts`), so dev data looks healthy — 10/11 transcripts in the dev DB had ciphertext; the only NULL row was the only one ever written by the live runtime path.
- **Fixed in-session (TDD)** at the three sites on the assessed chain (both stt-internal transcript writers + harness draft persist), mirroring the `context.service.ts` house pattern. RED 3 failed → GREEN 144/144 → full applications suite **6,682 passed / 4 skipped**. Live re-proof in Runtime Evidence §C.
- **Remediation for the rest (M, new ticket):** wire the same call at the ~9 remaining sites (+ the `update` lanes), then add **defense-in-depth**: a write-side twin of `wrapDelegateWithPhiDecrypt` (the read-side decryptor already sees every delegate) that refuses — or encrypts — any registered-PHI-model write carrying a transient plaintext with no ciphertext. That makes the whole class structurally impossible instead of 13-times-hand-fixed.

### H-2. The `[[seg:]]` StrictCitations lane is write-only: markers reach the clinician raw, are extracted by nothing, and earn no sensor credit — **P1, OPEN**

Live-proven both halves: the model **did** comply (run 2's note carries 5 valid `[[seg:<real-persisted-id>]]` markers), and then nothing consumes them — `extract_cited_segment_ids` (`prompt_cache.py:104`) has **zero production callers** (definition + its unit tests only), no TS-side stripper exists (repo-wide grep), `SummaryMeta.citationsMap` stayed empty (65-byte ciphertext ≈ empty map), and `citation_presence` scored **0** against a note full of citations (it scores NER-claims evidence, a disjoint lane). Consequences: raw markers pollute the clinician-visible note text on every surface, and the consultation-review click-to-source screen (533-B5) has nothing to highlight even when the model cites perfectly.
**Remediation (M):** in the workflow after generate — `extract_cited_segment_ids(note, allowed_ids)` → strip markers from delivered content → thread cited ids into the draft payload → merge into `citationsMap` (and let `citation_presence` credit marker-evidenced statements when the claims lane is degraded).

### H-3. Settings-registry convergence is a once-a-minute cron, not "45 s", and the broadcast still has zero cache subscribers — **P1 (F-007 CONFIRMED + sharpened), OPEN**

Measured with two gateway instances on one DB (Runtime Evidence §D): write on A → **A converges in ~35 ms** (on-write refresh), **B stays stale until the next second-:45 boundary** — 38.2 s in this run; the cron is `'45 * * * * *'` (`appSettings.service.ts:41`), i.e. *at second 45 of every minute* — worst case ~**60 s**, mean ~30 s; the code comment ("Every 45 seconds") and every prior doc mis-state it. The `ResourceUpdated` broadcast on write still has exactly one subscriber — the sysEvent audit fan-out (`sysEvent.service.ts:256`); nothing invalidates the remote snapshot. Bonus artifact proving the split brain: during staleness, B's `GET registry/:key` returned **fresh `version: 1` (DB read) alongside stale `value: 12000` (snapshot)** in one response. The one-liner quick win (a sys-event subscriber calling `refreshCache()`) is **still missing**. Note the contrast with H-6: the HarnessPolicy lane needs none of this because it reads the DB per call.

### H-4. `GET admin/harness/live/config` reports the *last-flush* snapshot, not a fresh resolution — **P2, OPEN**

`getEngineConfig()` returns `this.lastAgenticContext` (`live-documentation.service.ts:1938-1945`), which only refreshes when a live-doc flush runs. On an idle instance the admin console reads boot defaults forever, regardless of registry writes — an operator diagnosing H-3 staleness through this screen sees a *third* value. Cheap fix (S): resolve on read (the resolver is already snapshot-backed, no extra I/O).

### H-5. stt-v2 dev cannot fetch its own effective config — F-029 corroborated live — **P1 (already registered), evidence added**

At boot: gateway `API_GATEWAY_KEY is not configured — rejecting internal request for 'stt-v2' (fail-closed)` + stt-v2 `stt_v2.effective_config.fetch_error … 401`. Dev Vault KV (`secret/hope/*`) holds only `HARNESS_SERVICE_TOKEN`/`SMR_SERVICE_TOKEN` (+ non-service keys); `.env.dev` has no `API_GATEWAY_KEY`. Same class as the SMR 401 in the config-plane assessment — F-029's seed-the-dev-Vault fix list is confirmed still outstanding.

### Re-verifications and observations

- **F-023 re-verified on a third route:** `If-Match: "0"` create-lane on `PUT admin/settings/registry/:key` → 200 (version 0→1); subsequent `If-Match: "1"` → 200 (v2). The ETag echo caveat: version 0 emits no strong ETag (interceptor skips non-positive), so a weak content-ETag appears instead — clients must use the body `version`, not the header, on first read.
- **H-6 (positive) — D-23/D-24 toggle-without-redeploy PROVEN:** `PATCH admin/harness/policy/global` (If-Match) flipping `warmStartEnabled` + `mcpToolsEnabled` → the worker-facing `GET internal/harness/policy` view reflected both on the **writing instance in ~60 ms and on the second instance immediately** (per-call DB read; no snapshot). Reverted to null cleanly. `mcpServers` overlay present (`[]` — no registered rows in dev; end-to-end MCP with a real server remains untested, flag default-OFF).
- **D-26 lane indirectly confirmed:** the harness draft's `modelName` was `gemma-4-e2b-it-qat` — the `AiTaskDefault` `smr.finalize` slug (`lms-gemma-4-e2b-it-qat`) won over the env default (`e4b`), i.e. task-key model routing governs live generation.
- **B4 token accounting live:** trajectory LLM_CALL steps carried `total_tokens` 1,316 / 2,165 with the full engine-native usage block; 7-step trajectory spine (fetch_policy → retrieve → assemble → generate → sensors → inferential → persist) persisted per run.
- **D-28 guard observed** at worker boot (dev-mode warning for the in-memory claim-check store, exactly as designed).
- **F-012 partial live evidence:** SMR's openai-compat provider injects `ttl` (`openai_compat.py:94`); `lms ps` showed the loaded model with `TTL 3m/3m`, and between runs the eviction actually happened — the next run's judge/safety calls hit JIT-reload 500 bursts that Temporal activity retries absorbed. Retention works; the reload storm is worth a backoff note in the retention ticket.
- **F-008 residue confirmed:** `transcript.mode` governs (`:680` windowed branch) and `tokenBudget.perRun` is resolved and served on the policy (`harness-policy.service.ts:342,360-378`); `claimCheck.minBytes` is still resolved (`:1462`) and reported (`:1942`) but governs **nothing** — 1 of 6 knobs remains a dead control.
- **Sensor behavior with real content:** run 2 (medication-review audio) flipped `schema_validity` 0→1 and engaged `numeric_dose` (0.19 → FLAG) — the computational sensors respond to actual content, not just fixtures.

## Runtime Evidence

Stack: dev containers (untouched) + gateway `node dist-assess/main.js` :8868/:8869 + `dev-service.sh` stt/harness/worker/smr (+ nlp for run 3) + LM Studio :1234 + Temporal :7233. Whisper-large-v3-turbo (1.5 GB) was absent from every local cache and downloaded from HF on first session-create (the mint 500'd on the gateway's 15 s axios timeout during the download — session create is synchronous with model load; retry after cache-warm succeeded).

### A. Live stream → segments (F-010/D-22 producer half)

```
{"ev":"final","seq":10,"text":"The patient presents with shortness of breath ... aspirin 81 mg daily.","t0":0.032,"t1":21.92}
{"ev":"status","msg":{"type":"status","status":"closed","message":"Transcription stream completed"}}

 idx | t0Ms | t1Ms  | speaker | charStart | charEnd     (run 1, 22 s cardiology fixture)
   0 |   32 | 21920 | unknown |         0 |     373

 idx | t0Ms  | t1Ms  | speaker | charStart | charEnd    (run 2, 26 s medication fixture — two finals)
   0 |    32 | 24992 | unknown |         0 |     348
   1 | 24576 | 25856 | unknown |       349 |     363
```
Offsets are exact by construction (349 = 348 + joiner), speaker `unknown` (single-speaker fixture, energy framing).

### B. Run 1 (pre-fix) — the content-loss P0 as first hit

```
ContextItem  TRANSCRIPT   enc_bytes NULL      RAW_SUMMARY  enc_bytes NULL
doctor GET :id/context →  TRANSCRIPT len 0    RAW_SUMMARY len 0
assemble.userPrompt  len 2343, transcript-present: False
SummaryMeta: modelName gemma-4-e2b-it-qat, gateDecision FLAG, citations_bytes 65
trajectory: generate {"total_tokens": 1316 ...}; sensors {"schema_validity": 0, "citation_presence": 0 ...}
```
Chain-of-custody for the diagnosis: `hope-phi` Transit key EXISTS in dev Vault (ruled out KMS); seeds encrypt (10/11 seeded transcripts have ciphertext — ruled out read-path); the runtime writers simply never call the cipher.

### C. Fix + run 2 (post-fix) — full D-22 chain closed

```
RED:   3 failed (2 stt paths + harness persistDraft)   GREEN: 144/144   full suite: 6682 passed | 4 skipped
ContextItem  TRANSCRIPT   enc 533  vault:v1:…  kv 1     RAW_SUMMARY  enc 1153  kv 1
assemble → segmentCitations: [{id: 019f8633-3eec…, idx:0, t0Ms:32, t1Ms:24992},{id: 019f8633-3ef1…, idx:1, ...}]
assemble.userPrompt len 2727, transcript-present: True
doctor GET :id/context → RAW_SUMMARY len 828, note text:
   "**Plan** Metformin 500 mg twice daily, ... [[seg:019f8633-3eec-75c5-a0b8-3793671bb001]] ..."
   HAS [[seg: markers: True   (5 markers, all citing the real persisted segment id)
sensors: schema_validity 1, numeric_dose 0.19 (engaged), citation_presence 0 (claims-lane only — H-2)
```

### D. F-007 convergence measurement (two instances, one DB)

```
[02:43:07.047] baseline A: 12000 code-default 0        [02:43:07.083] baseline B: 12000 code-default 0
[02:43:07.136] PUT on A (If-Match "0") -> 200 {"value":9000,"version":1}
[02:43:07.172] A after write:  9000 global-kv 1        (~35 ms — on-write refresh)
[02:43:07.197] B after write:  12000 code-default 1    (stale value, FRESH version — split read)
[02:43:45.310] B CONVERGED: 9000 global-kv 1           (38.2 s — exactly the :45-second cron tick)
```
Setting restored to 12000 afterwards (leaves a stored row, `sourceScope` now `stored` rather than `code-default` — disclosed below).

### E. Policy-lane toggle (D-23/D-24), for contrast

```
[02:46:47.343] PATCH admin/harness/policy/global {"warmStartEnabled":true,"mcpToolsEnabled":true} -> version 2
[02:46:47.401→.428] GET internal/harness/policy (instance A): {warmStartEnabled: True, mcpToolsEnabled: True}
                    GET internal/harness/policy (instance B): {warmStartEnabled: True, mcpToolsEnabled: True}
reverted to null (If-Match "2") → {warmStartEnabled: None, mcpToolsEnabled: None}
```

### F. Replay-compat regression

```
pytest apps/harness/src/harness/tests -k "replay" → 17 passed, 940 deselected in 5.42s
```

### G. Degradation behavior under missing backends (observed, not fabricated)

- NLP down (runs 1-2) / model-unavailable (run 3: `HTTP 503: Token classification model not available`): `extract_entities` failed both attempts → workflow degraded and still delivered a FLAG draft.
- LM Studio TTL eviction between runs → judge/safety `POST :1234/v1/chat/completions` 500 bursts → absorbed by activity retries; the run still completed.

## Deltas vs. the ideal proof (stated per doctrine)

1. **Claims-lane enrichment (`attachSegmentEvidence` → citationsMap with `segmentId`) is still live-unproven** — it needs NER claims, and the NLP token-classification model would not come up on this host (503). Unit-locked only. Carry into the next NLP-capable run.
2. **Diarized multi-speaker segments not exercised** — both fixtures are single-speaker; `speaker` stayed `unknown`. The batch producer path (typed `segments` field from `TranscriptionResult`) was not exercised at all — streaming only.
3. **MCP end-to-end** (a real registered MCP server + gateway token mint) untested — only the policy-payload wire was proven; the registry is empty in dev.
4. **Live-doc flush lane** (B1 knobs governing a running flush, B3 windowed mode on a live session) not exercised — no live-doc session was driven; the convergence proof used the registry/facade lane directly.
5. **Cross-instance measurement used two gateways on one host** — real multi-node behavior (clock skew, LB) untested, but the mechanism (per-instance in-memory snapshot + cron) is host-count-independent.
6. The `.env.dev` PORT override had to be worked around (see below) — instance B is a wrapper artifact, not a sanctioned deployment shape.

## Residual environment state (disclosed)

- Dev DB rows created via normal API writes: 3 consultations (`runtime-assessment-patient-01/02/03`), 3 transcripts + 2 drafts + segments/trajectory/audit rows. `agentic.context.liveDelta.maxChars` now a **stored** row (value 12000 = code-default value, version 2). HarnessPolicy global row at version 3 with the two toggles back to null.
- Whisper-large-v3-turbo (1.5 GB) now cached at `/Volumes/aillusion/huggingface/`.
- All processes started by this assessment were killed (gateways :8868/:8869, stt-v2, smr, harness api+worker, nlp); containers and Temporal untouched; `dist-assess/` + `tsconfig.assess.json` removed.
- **The five orphaned `nest --watch` processes (PIDs 7482/8579/10310/71486/73583) are still alive** — per the queue's re-scoring note they clobbered `apps/api/dist` DURING this assessment's `pnpm build:api` (missing decorator outputs at launch; root-caused to their stale pre-refactor compiler graphs). Worked around by compiling to an isolated `dist-assess`. `apps/api/dist` remains in the clobbered state — any `pnpm dev:api`/`build:api` rebuilds it. **Owner: kill those PIDs.**
- Environment sharp edge for future assessors: `packages/database/src/env.ts` loads `.env.dev` with `override: true` in development, so `PORT=8869 node dist/main.js` still binds 8868 (EADDRINUSE). Worked around by launching with cwd outside the monorepo (defeats `findMonorepoRoot`) after pre-loading the env file without override.

## Files changed by this assessment

- `packages/applications/src/services/stt/internal/sttInternal.service.ts` — encrypt-before-create on both transcript writers (H-1)
- `packages/applications/src/services/consultation/harness/harness-internal.service.ts` — encrypt-before-create on the draft persist (H-1)
- `packages/applications/src/services/stt/internal/__tests__/sttInternal.service.test.ts` — 3 new tests (both paths + no-secrets degrade)
- `packages/applications/src/services/consultation/harness/__tests__/harness-internal.service.test.ts` — 1 new test (persistDraft cipher order)
- This document; `findings-register.md` and `assessment-queue.md` rows updated.

Left unstaged alongside the prior session's unstaged config-plane fixes, per the working-tree discipline (no `git add` by assessors).
