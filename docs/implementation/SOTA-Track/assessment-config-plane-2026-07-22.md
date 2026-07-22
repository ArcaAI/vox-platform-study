# Assessment — Config Plane Runtime (TASK-524/525/526) — 2026-07-22

| | |
|---|---|
| **Program** | TASK-539 Continuous Quality Re-Assessment, cycle 1 item 2 |
| **Subsystem** | Config plane: provider connections + Vault-Transit secret fields (524), internal effective-config read side (525), tenant BYO → SMR override lane (526) |
| **Findings re-verified** | F-004 (never runtime-verified), F-023 (`If-Match: "0"` create lane) |
| **Method** | Live dev stack (dev DB 5432 read-only + normal API writes, dev Vault 8200, dev API 8868 started/stopped by this assessment, real SMR 8862 + an HTTP capture sink), plus TDD-fixed defects where the proof was blocked by a live break |
| **Doctrine** | "Review" status = statically green, runtime-unproven. This was the FIRST runtime exercise of this surface — and it found three P0-class runtime breaks that ~16.8k green unit tests never touched. |

## Verdict (one paragraph)

F-004 was **correct and understated**. The first live run of the config plane hit: (1) a create-path serializer defect that made storing ANY BYO provider key over HTTP impossible (`Bytes` ciphertext destructured to a plain object → Prisma 400) — fixed in-session; (2) a 500 on the internal effective-config read for exactly the two services that matter most (smr, nlp) — the S-3 "tenant context required" class recurring on a service-to-service route — fixed in-session; (3) the discovery that **SMR never consumes `provider_overrides` at all** (zero occurrences in `apps/smr`), so the TASK-526 BYO lane is gateway-half only — open, M-sized. After the two fixes, the full Vault-Transit round-trip, the 6-service effective-config matrix, and the gateway-side override injection are now **runtime-proven** (evidence below). The Vault crypto posture itself held up very well: write-only keys, `vault:v1:` ciphertext at rest, Transit-bound decryption, fail-closed token guard with per-service isolation.

## Rubric scores

| Dimension | Score | Justification (evidence pointers) |
|---|---|---|
| **Correctness** | **at-risk** | Two P0 runtime defects existed at HEAD and were only found by running the surface (Runtime Evidence §A, §C). Both fixed + gate-verified in-session; the OCC contract (200-create / 412-stale / 428-missing) and the tombstone-exclusion invariant then proved out cleanly. Remaining: soft-deleted rows are unrecoverable over HTTP (Finding 4). |
| **Completeness** | **at-risk** | The BYO lane's consumer half does not exist: `grep -rn provider_overrides apps/smr` → 0 hits; live SMR failed with boto3's *no*-credential error ("Unable to locate credentials"), not an invalid-key error, while the injected fake key sat in its request body (§D). Also missing: any restore/re-create path after DELETE; a registry DELETE lane (an operator cannot retire an override back to code-default over HTTP). |
| **Performance** | **adequate** (thin evidence) | Not a perf-focused lane. Observed: effective-config reads 0–13 ms in API logs; settings write→read flip visible at t+0 same-instance (§E); SMR generate retry/backoff (3 attempts, exp backoff) behaved as designed against a dead provider. No load testing performed. |
| **Security & PHI** | **adequate** | Core posture strong and now proven: apiKey write-only (never in any response; grep of response bodies = 0), `vault:v1:` ciphertext at rest (psql), decrypts only under the configured `transit/hope-globalsetting` key (§B); token guard fail-closed on missing/unknown secrets, per-service isolation holds (harness token cannot read nlp/guardrail/tts-v2), unknown-service is authenticated before the 400 (§C). Deductions: 5 of 7 service-token secrets absent from dev Vault KV → the real SMR got 401 polling its own config (Finding 5); non-production error bodies carry full stack traces with absolute paths (Finding 6). |
| **Test posture** | **at-risk** | The defining result: unit suites were fully green (domains 1373, api 2391 pre-fix) while the create lane and the smr/nlp read lane were broken for every runtime caller — both defects live below the mocked-repository boundary. The e2e halves that would have caught them are env-gated and had never run (`E2E_SMR_V2_SERVICE_TOKEN` unset). Warm-up: the shared-singleton OCC race in `model-retention-settings.spec.ts` was real under `fullyParallel: true`; serialized and proven green twice (§F). |
| **SOTA delta** | recorded | Envelope encryption via Vault Transit with write-only fields and no reveal route matches good practice. Best-in-class additions this assessment motivates: (1) mapper/serializer **contract tests against a real Prisma client** (testcontainers-style) so `Bytes`/`Date`/`Decimal` round-trips are locked per model; (2) **consumer-driven contract tests** for the gateway→SMR body (the injected `provider_overrides` shape had no consumer to verify against — pact-style tests would have flagged the missing consumer immediately); (3) a **boot-time provisioning check** for peer-secret pairs (gateway-side `SMR_V2_SERVICE_TOKEN` vs SMR-side `service_token`) instead of discovering the 401 in production telemetry; (4) restore-or-upsert semantics for unique-keyed soft-deleted rows (a known soft-delete pitfall). |

## Findings (ranked)

### 1. `convertEntityValue` destructures Buffer/Uint8Array → every `Bytes`-column create 400s — **P0, FIXED in-session**
- **Failure scenario:** Global/tenant admin PUTs `admin/ai-providers/azure` with an `apiKey` → Vault Transit encryption succeeds, but the ciphertext `Buffer` passes through `entity.toObject()` → `convertEntityValue`'s generic-object branch → `{ "0": 118, "1": 97, … }` → Prisma rejects (`Expected Bytes or Null, provided Object`) → **400 on every create carrying a key, in every environment**. No BYO credential could ever be stored over HTTP.
- **Root cause:** the exact bug the Data Encryption Initiative fixed in `removeNullValues` had a second, unfixed copy in `packages/domains/src/utils/convertEntityValue.ts` (used by `toObject`/`toRawObject` → `AutoEntityMapper` → every `toPersistence`). The update lane was immune (`AutoEntityChangeMapper` reads raw `entity.changes`), which is why key-rotation-style unit flows never tripped it.
- **Blast radius:** every entity persisting a `Bytes` column through the standard mapper chain — proven for `AiProviderConnection`; `TenantTtsProviderCredential` shares the chain (create lane should be re-proven live — S follow-up).
- **Fix (this assessment):** leaf-value branch for `Buffer.isBuffer || ArrayBuffer.isView` in `convertEntityValue.ts` (mirrors the `removeNullValues` rule), 3 new unit tests (RED observed → GREEN), full domains suite 1376 green, dist rebuilt, runtime re-proven end-to-end (§A/§B). Remediation: **S (done)** + S follow-up above.

### 2. Internal effective-config 500 for `smr`/`nlp` — tenant-scope throw on a service-to-service route — **P0, FIXED in-session**
- **Failure scenario:** SMR or NLP polls `GET /api/v1/internal/effective-config?service=smr|nlp` (service-token authenticated, so CLS is empty) → `listProfiles()` → `AiRuntimeProfile` findMany under the tenant-scope Prisma extension with no tenant context → `TenantScope: tenant context required` → **500 for every caller in every environment**. Runtime profiles were undeliverable to the two services that consume them.
- **Root cause:** recurrence of the S-3 class ("a model read without tenant context cannot be tenant-scoped") on the internal read path; `crossTenantLane()` requires a super-admin *user*, which a service-token caller never has. The harness-internal controller already documents the sanctioned pattern (re-establish CLS via `cls.run`/`cls.set`) — the effective-config controller skipped it.
- **Fix (this assessment):** `EffectiveConfigController` now runs the read inside a CLS context pinned to `SYSTEM_TENANT_ID` (all subsets resolve platform-level state), unit test locks the ordering (set-before-read), api suite 2398 green, all six services return 200 live (§C). Remediation: **S (done)**. **Class action (M, open):** audit every `@Public()` + service-token route whose subtree touches `TENANT_SCOPED_MODELS` — this is the third instance of the class (throttler, ApiKey/S-3, now effective-config).

### 3. SMR never consumes `provider_overrides` — the TASK-526 BYO lane is half-built — **P0 (completeness), OPEN**
- **Failure scenario:** a tenant configures a BYO azure/bedrock key and generates text. The gateway decrypts and injects the key correctly (wire-captured, §D) — and SMR **silently ignores it**, generating on platform/env credentials. The tenant believes their key, their quota, and their data-governance terms are in effect; none are. Silent, per-request, invisible in any response.
- **Evidence:** `grep -rn "provider_overrides" apps/smr --include='*.py'` → **zero matches** (the gateway comment even admits "Until SMR consumes it, the field is inert"). Adversarial live proof: with the fake override present in the body, SMR's bedrock call failed `"Unable to locate credentials"` — boto3's *no-credentials* error. Had it consumed the override it would have failed with an invalid-credential error naming the fake key.
- **Remediation:** **M** — extend SMR's generate request model + provider clients (azure/bedrock) to apply per-request credential overrides, with tests asserting override-wins-over-env and no override logging; then an e2e that drives the full tenant-key→generation path.

### 4. Soft-deleted provider connection can never be re-created over HTTP — **P1, OPEN**
- **Failure scenario:** admin DELETEs the tenant's azure connection (soft delete), later re-adds it. GET shows the version-0 placeholder ("no row"), inviting `If-Match: "0"` → **409 unique-constraint** (the DELETED row still occupies `(tenantId, provider)`). Retrying with the tombstone's true `_version` ("4") → **412** (the scoped read can't see DELETED rows). There is **no HTTP path out**; recovery requires DB surgery. Live-proven both ways (§B tail).
- **Remediation:** **S/M** — `upsertRow` should detect a DELETED underlying row on create-intent and restore-with-overwrite (repository `restore()` + change-tracked update, key required), plus an e2e locking delete→re-create. Audit the same pattern on other unique-keyed soft-deleted admin resources.

### 5. Dev Vault KV lacks 5 of 7 internal service-token secrets; the real SMR 401s on its own config poll — **P1 (env/ops), OPEN**
- **Failure scenario:** `SECRETS_PROVIDER=vault` has no env fallback (verified in `vault-secrets.provider.ts`). KV `secret/hope/` holds only `HARNESS_SERVICE_TOKEN` + `SMR_SERVICE_TOKEN`; the guard needs `SMR_V2_SERVICE_TOKEN`, `NLP_SERVICE_TOKEN`, `GUARDRAIL_SERVICE_TOKEN`, `TTS_SERVICE_TOKEN`, `API_GATEWAY_KEY`. Result: every service except harness gets 401 on the TASK-525 read — observed live from the REAL SMR during generation (`401 Unauthorized` in its log, §D) — and each service silently stays on env-fallback config forever.
- **Note the naming trap:** `SMR_SERVICE_TOKEN` (gateway→SMR outbound) vs `SMR_V2_SERVICE_TOKEN` (SMR→gateway inbound) are distinct names that must hold the same value by convention — drift is invisible until a 401.
- **Remediation:** **S** — add the five keys to the dev Vault bootstrap (`scripts/` Vault seed path), document the name pairing, and consider a gateway boot-time warning when a known service's token secret is unresolvable.

### 6. Non-production error bodies carry full stack traces with absolute paths — **P3, OPEN**
- `packages/exceptions/src/common/base.exception.ts:51` includes `this.stack` whenever `NODE_ENV !== 'production'` — observed on the internal 400 (unknown service), leaking `/Users/…` paths and call chains. Production is excluded, but staging/test bodies leak, and internal service-to-service responses don't need stacks at all. Remediation: **S** (allow-list environments, or strip on the internal controller).

### Re-verifications and observations
- **F-023 re-verified live (dev API):** `If-Match: "0"` create → 200; stale `"0"` vs existing row → 412; missing If-Match → 428. The relaxed decorator behaves exactly as the owner decision specified.
- **F-004:** claim CONFIRMED (surface had never run; first run found findings 1–3). Now **partially closed**: Vault-Transit round-trip, effective-config matrix, and gateway-side injection are runtime-proven; still open under F-004's umbrella → the SMR consumer half (Finding 3) and a live TenantTtsProviderCredential create re-proof.
- **F-007 nuance:** same-instance settings write→effective read is **immediate** (t+0 flip to `777/db`, §E). The 45s staleness concern applies to cross-instance convergence only — unproven here (single instance); the quick-win subscriber remains worthwhile.
- **Positive:** `VaultRotationWorkerService` detected the externally-written KV keys via the audit-log watcher and published cache invalidations on `arca:secrets:invalidate` within seconds — the rotation plumbing works.
- **Environment hazard (owner):** five orphaned `nest start --debug --watch` processes from earlier sessions (PIDs 7482, 8579, 10310, 71486, 73583; PPID 1; started Jul 21 01:56–09:50) are alive in this tree. They are the known dist-clobber hazard for any future API run on this host. Not killed (not started by this assessment).

## Runtime Evidence

### A. The create-lane defect, as first hit (dev API at HEAD, before the fix)

```
PUT /api/v1/admin/ai-providers/azure?tenantId=50000000-…  If-Match: "0"  {…, "apiKey":"fake-key-…"}
HTTP/1.1 400 Bad Request
API log → Prisma validation error:
  encryptedApiKey: { 0: 118, 1: 97, 2: 117, 3: 108, 4: 116, 5: 58, … }   ← "v a u l t :" — Transit
  Argument `encryptedApiKey`: Invalid value provided. Expected Bytes or Null, provided Object.
```
(The byte values spell `vault:v1:…` — encryption succeeded; serialization destroyed the Buffer.)

TDD fix proof:
```
RED  : Tests  3 failed | 1373 passed   (new Buffer/Uint8Array leaf-value tests)
GREEN: Tests  1376 passed | 2 skipped | 9 todo   (full @arcaai/domains suite)
```

### B. Vault-Transit round-trip + OCC contract (dev API, after the fix)

```
PUT  …/azure  If-Match: "0"  → HTTP/1.1 200 OK   ETag: "1"
     {"hasKey":true,"keyVersion":1,"enabled":true,"version":1}   (apiKey absent from body)
GET  …/azure                → 200, hasKey:true — grep for the raw key in the body: 0 occurrences
psql (READ-ONLY, dev DB):
     azure|50000000-…|109|vault:v1:6XTr2ADpE/PF27lqe4gdZIv1CIN+nxVCaxGnMl0mf2pNIvTjbxajiUcDeT7xwnODPWlS1QNEB7XTVBx7mmSnPoxJJYT8Z5VU6Prb|1|1
     grep plaintext in row: 0 — no plaintext at rest
Vault Transit decrypt (transit/hope-globalsetting):
     DECRYPTED: fake-key-for-transit-roundtrip-proof-2026-07-22    ← exact plaintext round-trip
OCC: stale If-Match "0" → 412 · missing If-Match → 428 · update w/o apiKey → 200 hasKey:true v2
     rotate key (If-Match "2") → 200, DB shows fresh vault:v1: at _version 3
DELETE → 200 · GET → version-0 placeholder · DB row: DELETED|4 (soft delete)
Tombstone probes: re-create If-Match "0" → 409 unique-constraint · If-Match "4" → 412  (Finding 4)
```

### C. Effective-config matrix (dev API; temp KV tokens created for the probe, then destroyed)

Before the CLS fix:
```
service=smr  → 500  {"statusCode":500}   log: TenantScope: tenant context required for model AiRuntimeProfile operation findMany
service=nlp  → 500  (same)
guardrail / tts-v2 / stt-v2 / harness → 200 (no profile subtree)
```
After the CLS fix (controller pins CLS to SYSTEM tenant; unit RED→GREEN; api suite 2398 green):
```
smr      → 200 {"runtimeProfiles":[],"retention":{"ttlSeconds":600,…,"source":"env-fallback"}}
nlp      → 200 {…,"concurrency":{"maxConcurrent":4,…,"source":"env-fallback"}}
guardrail→ 200 · tts-v2 → 200 · harness → 200 (real KV token)
stt-v2   → 200 via X-Internal-Service-Key {…,"concurrency":{"workerConcurrency":4,"streamingMaxConcurrent":0,…}}
```
Auth matrix: no token → 401 · wrong-service token (harness→nlp/guardrail/tts-v2) → 401 · smr with the
OUTBOUND `SMR_SERVICE_TOKEN` value → 401 (guard wants `SMR_V2_SERVICE_TOKEN`; Finding 5) · unknown
service WITH a valid token → 400 `"Unknown service 'bogus'. Expected one of: smr, nlp, stt-v2, guardrail,
harness, tts-v2."` (body carried a stack trace — Finding 6).

### D. BYO → SMR lane (tenant admin, bedrock)

Wire capture (HTTP sink standing in on the SMR port; gateway forwarded body, verbatim):
```json
{"method":"POST","path":"/api/v1/generate","x_service_token_present":true,
 "body":{"prompt":"say hi","provider":"bedrock","model":"anthropic.claude-3-haiku","max_tokens":10,
   "provider_overrides":{"bedrock":{"api_key":"byo-lane-fake-bedrock-key-2026-07-22","region":"us-east-1"}}}}
```
→ Gateway-side decryption + injection **proven** (exact stored plaintext at the SMR boundary); minimal-exposure invariant held (only the resolved provider's entry; the DELETED azure row was not resolved).

Real SMR (`pnpm dev:smr-v2`, healthy-degraded, same request through the gateway):
```
SMR log: POST /api/v1/generate → generation.retry ×3 → generation.failed
         {"provider":"bedrock","error":"Unable to locate credentials"}          ← boto3 NO-credential error
         (an invalid-credential error would have named the fake key → override NOT consumed; Finding 3)
SMR log: GET http://localhost:8868/api/v1/internal/effective-config?service=smr "HTTP/1.1 401 Unauthorized"  ← Finding 5, observed live
Gateway → 502 {"detail":"SMR service unavailable"}
```

### E. Settings write → effective read (db-source flip)

```
GET registry smr.modelCache.ttlSeconds?tenantId=SYSTEM → {"value":600,"sourceScope":"code-default","version":0}
PUT value 777 (If-Match "0") → 200
GET internal/effective-config?service=smr at t+0        → {"ttlSeconds":777,"source":"db"}     ← immediate, same instance
restore 600 → row now {"sourceScope":"global-kv","version":2}; effective read {"ttlSeconds":600,"source":"db"}
```

### F. Warm-up: shared-singleton OCC race fix (test API, test DB)

`model-retention-settings.spec.ts` — added `test.describe.configure({ mode: 'serial' })` to the
shared-singleton describe (root config runs `fullyParallel: true`; siblings read-modify-write the same
SYSTEM row → same-`_version` race → spurious 412).
```
Run 1: 4 passed, 2 skipped (11.4s)     Run 2: 4 passed, 2 skipped (10.9s)
```
The 2 skips are the env-gated internal-read half (`E2E_SMR_V2_SERVICE_TOKEN` unset in `.env.test` —
by design; see Finding 5 for why populating it matters). Test API killed after; 8868 verified free.

### G. Gates on code changed by this assessment

```
@arcaai/domains  test  → 1376 passed | 2 skipped | 9 todo     build → tsc clean, dist carries the fix
@arcaai/api      test  → 2398 passed | 4 skipped (152 files)  build → turbo 8/8 successful
eslint (4 touched files) → 0 errors
```

## Deltas vs. the ideal proof (stated per doctrine)

1. **BYO end-to-end** could not be proven because the consumer half does not exist (Finding 3) — the wire capture at the SMR boundary plus the adversarial no-credential error is the closest real thing.
2. **Test-DB migration application** (part of F-004's wording) was only indirectly evidenced: the settings-registry write lane worked against the test DB in the warm-up run. `AiProviderConnection` on the TEST DB was not exercised (dev DB was, directly).
3. **Cross-instance settings convergence** (F-007) unproven — single API instance here.
4. **TenantTtsProviderCredential create** after the Finding-1 fix was not re-proven live (same code path, inferred fixed).
5. Effective-config positive matrix for smr/nlp/guardrail/tts-v2/stt-v2 required **temporary Vault KV tokens** (the guard's secrets don't exist in this env — Finding 5). Created with random values, used, then destroyed (metadata delete); KV list verified byte-identical to its prior state.

## Residual environment state (disclosed)

- Dev DB: two soft-deleted `AiProviderConnection` tombstones for tenant `50000000-…0000` (azure `_version 4`, bedrock `_version 2`) — created and deleted via the API per the assessment contract; also live evidence for Finding 4.
- Dev DB: a `Setting` row for `smr.modelCache.ttlSeconds` now exists holding the code-default value 600 (`sourceScope: global-kv` instead of the pristine `code-default`; no DELETE lane exists — see Completeness). Effective value unchanged.
- Vault: unchanged (temp KV keys fully destroyed; verified). Transit: two encrypt + one decrypt operations (stateless).
- Processes: all processes started by this assessment killed; 8868 and 8862 verified free. The five pre-existing orphaned `nest --watch` processes were left untouched (not mine to kill) — flagged above.

## Files changed by this assessment

- `apps/api/tests/e2e/model-retention-settings.spec.ts` — serial-mode fix (warm-up)
- `packages/domains/src/utils/convertEntityValue.ts` — Buffer/TypedArray leaf-value fix (Finding 1)
- `packages/domains/src/utils/convertEntityValue.test.ts` — 3 new tests (Finding 1)
- `apps/api/src/modules/internal/effective-config.controller.ts` — SYSTEM-tenant CLS re-establishment (Finding 2)
- `apps/api/src/modules/internal/__tests__/effective-config.controller.test.ts` — CLS-context test (Finding 2)
