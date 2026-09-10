# TASK-944 — Cold-start timeouts and secret hot-reload

**Status:** Review
**Type:** bugfix
**Opened:** 2026-09-10
**Found by:** live verification of the `hope-v2-dev` k3s deployment (pipeline #862, rev `50b2db5`)

## Requirement Analysis

Three defects measured on the live dev cluster. All three share one shape: a value
that must change or be waited on at RUNTIME is fixed at BUILD or BOOT time.

### Lane A — the STT streaming-session timeout is hardcoded, and too short

`packages/applications/src/services/stt/streaming/streamingSession.service.ts:240`
carries a literal `timeout: 15000` on the gateway → STT `POST /internal/streaming/sessions`
call.

Measured 2026-09-10 09:37Z, first session after an STT pod restart:

```
stt.access   POST /internal/streaming/sessions  status_code 201  duration_ms 16870.07
api          StreamingSessionService  "Failed to create streaming session"
             error: "timeout of 15000ms exceeded"   (ECONNABORTED)
api          POST /api/v1/audio/transcription-jobs/stream/session -> 503 in 15027ms
```

STT answered **201** — 1,870 ms after the gateway had already given up. A warm session
is 0.1–0.5 s, so this fails ONLY on the first request after any STT restart, i.e. after
every single deploy. It is also a hardcoded configuration literal, which
`.claude/rules/09-infrastructure-devops.md` §"No hardcoded configuration" forbids
outright.

**Do NOT just raise the number.** It must become a governed value (a
`SettingDescriptor`, `failMode: 'open-to-default'`) or, at minimum, a declared env var
in `turbo.json#globalEnv` plus the relevant `.env.sample`. A bare literal bumped to
30000 re-creates the same defect one restart later.

### Lane B — ~9.3 s of that cold start is a broken optional import

From the same session, `apps/stt`:

```
stt.streaming.session_manager  level=warning
  "Failed to warm embedding model for streaming pipeline"
  error: "Missing required package for HuggingFace loader: Could not import module
          'AutoProcessor'. Are this object's requirements defined correctly?"
```

`wespeaker-voxceleb-resnet34` starts loading at 09:37:15.700 and the warm fails at
09:37:25.033 — **9.33 s burned before the pipeline even reaches whisper**. Fixing this
very likely brings cold start under any sane Lane-A timeout on its own, and it silently
disables the speaker-embedding stage (diarization/voice-profile) as a side effect, which
is a correctness bug in its own right.

Root cause is a dependency shape in the `stt-ml-runtime` image (transformers /
`AutoProcessor` availability), not the model file. Fix the dependency; do not paper over
it by deleting the warm step.

### Lane C — a changed JWT secret cannot be picked up at runtime, and sign/verify diverge

Discovered while closing a Vault↔k8s `JWT_SECRET_KEY` drift on the same cluster. After
writing the new value to Vault:

- the SIGN path picked up the new value within the SecretsService re-warm (~150 s)
- the VERIFY path kept the BOOT-time value indefinitely

Result: `POST /auth/login` issued tokens that every authenticated route then rejected
with 401. Every request 401'd until `hope-api` was restarted. Proven by HMAC-ing a
freshly issued token against both candidate secrets inside the pod: the new value
signed it, and the guard still refused it.

This is a live-rotation trap, and the platform owner is planning a Vault credential
rotation. A JWT-secret rotation today is an auth OUTAGE, not a rolling change.

Decide and document the intended contract, then make the code match it:
either (a) verification resolves the secret per-request through `SecretsService` so a
rotation converges without a restart, honouring a previous-key grace window, or
(b) it is explicitly boot-only, and rotation is documented as requiring a restart —
in which case sign and verify MUST be pinned to the same source so they can never
diverge mid-flight.

Related: `arca:secrets:invalidate` is published by `SettingsRegistryWriteService` but
measured **0 subscribers** on this deployment — nothing attaches the SecretsService
invalidation subscriber, so the documented propagation path is inert and only the TTL
re-warm works. Worth confirming whether that is a wiring bug.

## Implementation Plan

**Status of this plan:** written 2026-09-10 by the implementing agent, from the evidence in
the sections above plus a static audit of the committed tree. TDD per
`.claude/rules/01-development-workflow.md` — a failing test first for every lane.

### Lane A — govern the session-create timeout

Exemplar followed: `consultation.realtime.textTimeoutMs` (TASK-891 B1 / TASK-940). It is the
same SHAPE of defect — a gateway→service hop budget frozen as a literal, set *below* the
measured tail of the thing it budgets — and it was fixed by making it a `global-kv`
`open-to-default` descriptor with a 60 s default. The read side follows
`phiRedaction.requestTimeoutMs` (`GuardrailPhiRedactor`), which is the existing precedent for a
platform-only, sync `IAppSettingsService.getValueWithDefault` read on an outbound hop.

1. RED — `packages/applications/src/services/stt/streaming/__tests__/streamingSession.service.test.ts`
   gains a case asserting the POST timeout comes from the settings service, and one asserting the
   code default when no settings service is wired.
2. RED — a descriptor test asserting the key is registered with the governed shape.
3. GREEN — new `descriptors/stt-gateway.descriptors.ts` (key `sttStreaming.sessionCreateTimeoutMs`,
   `global-kv` / `system` / `globalOnly` / `open-to-default`, default 60000), registered in
   `registry.ts`; `StreamingSessionService` takes an OPTIONAL + TRAILING `IAppSettingsService`
   (so every positional fixture keeps its arity) and reads the key.
4. The existing `timeout: 15000` assertions move to the new default — deliberately, and recorded
   here: 15 000 ms sat below the measured 16 870 ms cold start, so it is not a number to preserve.

### Lane B — the `[ml]` / `[nemo]` extras are installed into one venv

Root cause, established from committed files alone (no cluster, no image build):

- The repo root `pyproject.toml` `[tool.uv].conflicts` **declares `stt[ml]` ⇄ `stt[nemo]` and
  `stt[ml-gpu]` ⇄ `stt[nemo]` as conflicting extras.**
- `uv.lock` agrees: under `[package.optional-dependencies]` for `stt`, `ml`/`ml-gpu` resolve
  **torch 2.8.0** + **transformers 5.16.1** + torchvision; `nemo` resolves **torch 2.12.1** and
  declares no torchvision.
- `apps/stt/docker/Dockerfile` (`ml-builder`) nevertheless installs BOTH into the SAME
  `/opt/venv`, one after the other — `./apps/stt[ml-gpu]`, then `./apps/stt[nemo]` — and the
  second step additionally overrides `transformers==5.5.4`, below `[ml]`'s own declared
  `transformers>=5.13.0,<6` floor.

Consequence chain that produces the observed line: the `[nemo]` step upgrades torch out from
under the `torchvision` wheel `[ml]` pinned for torch 2.8; an ABI-mismatched torchvision raises
`RuntimeError` on import; transformers reaches torchvision from
`video_processing_utils` → `processing_auto`, and `_LazyModule.__getattr__` catches exactly
`(ModuleNotFoundError, RuntimeError)` and re-raises
`ModuleNotFoundError: Could not import module 'AutoProcessor'. Are this object's requirements
defined correctly?` — the exact string in the log. `HuggingFaceLoader.load` catches `ImportError`
(its parent) and raises `ModelLoadError`, after the torch + transformers cold import has already
been paid.

1. RED — `apps/stt/tests/unit/test_task944_ml_runtime_extra_conflicts.py`, modelled on the
   existing `test_dockerfile_pywhispercpp_build.py`: parse the declared conflicts and the
   Dockerfile, fail when one build stage installs two conflicting extras, and fail on a
   `transformers==` pin that contradicts the `[ml]` floor.
2. GREEN — drop the `[nemo]` install (and its transformers override) from `ml-builder`. Both
   nemo consumers (`models/nemo_loader.py`, `diarization/streaming_sortformer.py`) already
   lazy-import and fail CLOSED with a named error, so the engines degrade honestly instead of
   running on a venv whose torch has been swapped under pyannote.
3. The warm step is NOT removed. No `apps/stt/pyproject.toml` dependency edit is required —
   the pyproject and the lock are already correct and already say these extras conflict — so
   there is nothing for `uv lock` to re-resolve. Recorded here because the ticket anticipated a
   pyproject edit.

### Lane C — one secret source for sign and verify

**Contract chosen: (a), without a previous-key grace window.**

`JwtStrategy` captures `secretOrKey` ONCE in its constructor, so verification is pinned to the
boot-time value forever while every mint path re-resolves through `SecretsService`. Passport
supports `secretOrKeyProvider`, so per-request resolution is available with no new machinery,
and it converges a rotation within the SecretsService cache TTL on both sides at once.

A previous-key grace window is deliberately NOT added: it needs a second Vault key, a second
descriptor, and an operator procedure for retiring it, and without it a rotation costs each live
session one 401 and a re-login — a degradation that self-heals, against today's permanent outage
until a restart. That trade is recorded here so the next reader knows it was decided, not missed.

1. RED — `packages/applications/src/services/auth/__tests__/jwt-secret.task944.test.ts`:
   verification must observe a secret CHANGED after construction; sign and verify must call the
   same exported resolver; the OIDC mint path must never substitute a literal.
2. RED — a test that the production module graph actually attaches the
   `arca:secrets:invalidate` subscriber.
3. GREEN — one shared `resolveJwtSecret()` in `services/auth/jwt-secret.ts`, used by
   `JwtStrategy` (`secretOrKeyProvider`), `OidcStrategy` (dropping its
   `?? 'default-secret-key'` fallback, which could mint a token no verifier accepts),
   `FederatedAuthService`, and the three `apps/api` mint sites.
4. GREEN — wire the secrets invalidation subscriber. Measured on the live cluster as 0
   subscribers; confirmed statically — `SecretsService.attachRedisSubscriber` has **no
   production caller** anywhere in the tree, only unit tests and one test helper stub.
5. DOCS — `docs/operations/jwt-secret-rotation.md`, and correct the claim in
   `docs/operations/vault/README.md` §"Rotating a platform secret end to end" that the
   invalidation channel is the fast path (it was inert).

### Out of scope, deliberately

- Raising Lane A's number without governing it (an explicit non-solution in the ticket).
- Any cluster, Docker, `pnpm install`, `db:*` or deployment-repo action — the orchestrator owns
  those surfaces.

## Verification Criteria

- Lane A: a test pins that the timeout comes from configuration, not a literal; the
  cold-start path no longer 503s when STT answers within the configured budget.
- Lane B: `apps/stt` warms the embedding model without the import warning;
  the pre-whisper warm cost is measured before/after and recorded here.
- Lane C: a test proves sign and verify resolve the SAME secret source; the chosen
  rotation contract is documented in `docs/operations/`.
- Gates: `pnpm --filter @arcaai/applications test build`, `pnpm test:unit`,
  `pnpm stt:test`, `pnpm stt:lint`, `pnpm stt:typecheck`, `pnpm lint`.

## Implementation Summary

**All three lanes implemented, TDD, RED observed for each. Branch
`task-944-cold-start-timeouts`, UNMERGED.**

### Lane A — `sttStreaming.sessionCreateTimeoutMs`

| File | Change |
|---|---|
| `packages/applications/src/services/settings-registry/descriptors/stt-gateway.descriptors.ts` | NEW. One key: `global-kv` / `maxScope: system` / `globalOnly` / `failMode: open-to-default`, default **60000**. Carries the measured evidence and the reason a bigger literal is not the fix. |
| `.../settings-registry/registry.ts` | Registers it, with a note on why it is NOT part of the `consumedBy: ['stt']` family beside it. |
| `.../stt/streaming/streamingSession.service.ts` | `timeout: 15000` → `this.sessionCreateTimeoutMs()`; optional + trailing `IAppSettingsService`. Resolved PER CALL, so an operator's write governs the next session open. |
| `.../stt/streaming/__tests__/streamingSession.timeout.task944.test.ts` | NEW — 4 cases: the value comes from the control plane, is re-read per call, degrades to the descriptor default when unwired, and is not the old literal. |
| `.../settings-registry/__tests__/stt-gateway.descriptors.test.ts` | NEW — the descriptor's governed shape, including that the default sits above the measured 16 870 ms. |
| `.../stt/streaming/__tests__/streamingSession.service.test.ts` | The 9 existing `timeout: 15000` assertions now name the descriptor default. |

**Decision the ticket left open — the default is 60000 ms.** The precedent is
`consultation.realtime.textTimeoutMs` (TASK-891 B1), which fixed the identical shape of
defect and reasoned the same way: a budget must sit ABOVE the tail it protects against,
or it converts a slow call into no call at all. A warm session is 0.1–0.5 s and never
reaches this budget; it binds only on the first session after an STT restart. No env var
was added, so `turbo.json#globalEnv` and the `.env.sample`s are untouched — the
descriptor is the stronger of the two options the ticket allowed.

### Lane B — the ML image was violating a DECLARED extra conflict

| File | Change |
|---|---|
| `apps/stt/docker/Dockerfile` | The `./apps/stt[nemo]` install and its `transformers==5.5.4` override are removed from `ml-builder`; two stale header comments corrected. |
| `apps/stt/tests/unit/test_task944_ml_runtime_extra_conflicts.py` | NEW — 3 cases, hermetic (no Docker, no network, no GPU). |

**Root cause, established from committed files alone.** The root `pyproject.toml`
`[tool.uv].conflicts` declares `stt[ml]` ⇄ `stt[nemo]` and `stt[ml-gpu]` ⇄ `stt[nemo]`
as conflicting, and `uv.lock` resolves them apart — `ml`/`ml-gpu` on **torch 2.8.0**
with torchvision, `nemo` on **torch 2.12.1** with none. The Dockerfile installed both
into one `/opt/venv` anyway, so the nemo step upgraded torch out from under the
torchvision wheel `[ml]` had pinned FOR torch 2.8. An ABI-mismatched torchvision raises
`RuntimeError` on import; transformers reaches it through `video_processing_utils` →
`models.auto.processing_auto`, and `_LazyModule.__getattr__` catches exactly
`(ModuleNotFoundError, RuntimeError)` and re-raises the observed
`Could not import module 'AutoProcessor'`. `[ml]`'s own comment ("Do NOT upgrade torch
past 2.8.x until pyannote releases a compatible version") was correct; the build was
quietly violating it.

**Decision the ticket left open — which side wins.** `[ml]` does. The deployed pipeline
runs whisper.cpp + pyannote/wespeaker, pyannote hard-pins torch 2.8, and it was the
pyannote path that broke. `nemo` stays declared in `pyproject.toml`; both of its
consumers (`models/nemo_loader.py`, `diarization/streaming_sortformer.py`) already
lazy-import and fail CLOSED with a named error, so the `nemo` engine and Sortformer
diarization now degrade honestly instead of appearing installed on a venv whose torch
had been swapped under pyannote. A nemo-capable image is a separate build target on its
own venv — which is exactly what the declared conflict means.

**No `uv lock` was run, deliberately.** The ticket anticipated an
`apps/stt/pyproject.toml` dependency edit. There is none to make: the pyproject and the
lock are already correct and already say these extras conflict. The Dockerfile was the
only thing disagreeing with them, so a re-resolve would have changed nothing.

### Lane C — one secret source, and a channel that actually has a listener

| File | Change |
|---|---|
| `packages/applications/src/services/auth/jwt-secret.ts` | NEW. `resolveJwtSecret()` — the ONE resolver, plus `JWT_SECRET_KEY_NAME` / `JWT_SECRET_PLACEHOLDER`. |
| `.../auth/jwt.strategy.ts` | `secretOrKey: <string captured at construction>` → `secretOrKeyProvider`, resolving per verification. The boot placeholder assertion is unchanged. |
| `.../auth/oidc.strategy.ts` | Uses the resolver; its hard-coded development-string fallback is gone (it could mint tokens no verifier would accept). |
| `.../federated-auth/federated-auth.service.ts`, `apps/api/.../auth.controller.ts`, `.../auth-sso.controller.ts`, `.../admin-impersonation.controller.ts` | All four open-coded resolvers now delegate to the shared one. |
| `.../_meta/secrets/secrets-invalidation.subscriber.ts` | NEW — the production listener for `arca:secrets:invalidate`. |
| `.../_meta/secrets/secrets.module.ts` | Registers it, plus a dedicated `RedisSubscriberService`. |
| `.../_meta/secrets/SecretsService.ts` | `handleInvalidationMessage()` extracted so the ioredis path and the Nest path share one parser. |
| `.../_meta/config/config.service.ts` | Deep-imports `SecretsService` instead of the `../secrets` barrel — see the cycle below. |
| `docs/operations/jwt-secret-rotation.md` | NEW — the contract, the procedure, and the check that proves sign and verify agree. |
| `docs/operations/vault/README.md` | The claim that the invalidation channel was the fast path is corrected; it was inert. |

**Contract chosen: (a), and deliberately WITHOUT a previous-key grace window.**
Verification resolves per request through the same function the mint paths use, so a
rotation is a rolling change needing no restart. A grace window needs a second Vault
key, a second descriptor, a multi-candidate verify path and a retirement procedure —
weighed against a cost of one 401 and a re-login per live session, which self-heals, it
was not taken. Documented as a decision, with the trigger that would reopen it.

**The `arca:secrets:invalidate` question is answered: it IS a wiring bug.**
`SecretsService.attachRedisSubscriber` had no production caller anywhere in the tree —
only its own four unit tests and one stub in `apps/api/tests/helpers`. That is why the
live cluster measured 0 subscribers, and why the documented propagation path was inert
while only the TTL backstop was real.

**A real circular import surfaced while wiring it, and is fixed.** `config.service.ts`
imported the `../secrets` barrel, which re-exports `secrets.module.ts`. The moment
`SecretsModule` gained a provider that reaches config, the cycle closed:
`config.service → secrets/index → secrets.module → subscriber → redisSubscriber →
config`. It does not fail loudly — the in-flight module hands back a partial namespace,
the class reference reads `undefined`, and `@Inject(undefined)` on an `@Optional()`
dependency then resolves to `undefined` at runtime with no error anywhere. The
subscriber constructed fine and simply never received its Redis source. Deep-importing
the one class it needs removes the edge. (The subscriber also declares its DI tokens
explicitly: this package's `vitest.config.ts` sets `emitDecoratorMetadata: false`, so
implicit type-based injection silently yields `undefined` under test.)

**One adjacent reader was left alone, on purpose.**
`apps/api/src/modules/throttle/tiered-throttler.guard.ts` also verifies a JWT signature
off `getSecretSync`, to pick a rate-limit bucket. It is pre-auth, cannot await cheaply,
and degrades safely (`return null` → the anonymous bucket, never a 401), so a stale read
there costs a mis-bucketed rate limit for at most one cache TTL. Noted rather than
changed.

### Gate results

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/applications build` | PASS |
| `pnpm --filter @arcaai/applications test` | 12 712 passed; 1 file failed — `agentPromotion/.../membership-bounded-sync.integration.test.ts`, PRE-EXISTING (it needs the live test DB on :5433, which is down; it fails identically on base `5b91aab0c`) |
| `pnpm test:unit` | **PASS** — 1527 files, 24 584 tests, exit 0 |
| `pnpm stt:test` | 3 328 passed. 2 failed + 202 errors, ALL PRE-EXISTING: the 202 are `apps/stt/tests/e2e/**` fixtures dying on `module 'stt.core.database.connection' has no attribute '_engines'`; `test_streaming_quality_scorecard` needs models/GPU; `test_task799_env_surface::test_minio_credentials_default_to_empty` reads `MINIO_ACCESS_KEY` out of the local `.env.test`. `git diff 5b91aab0c -- apps/stt` touches only `docker/Dockerfile` and the new test file, so no `apps/stt/src` behaviour changed. The 3 new cases pass. |
| `pnpm stt:lint` | PASS — "All checks passed!" |
| `pnpm stt:typecheck` | PASS — "Success: no issues found in 141 source files" |
| `pnpm lint` | PASS — exit 0, 39/39 tasks, 0 errors. Every warning in a touched file is a pre-existing `eslint-comments/require-description` on an untouched `eslint-disable` line. |

**Not measured: Lane B's before/after warm cost.** It needs a GPU build of
`stt-ml-runtime` and a cold pod — both cluster/Docker surfaces this lane was not
permitted to touch. Note also that the 9.33 s in the evidence above is mostly the
torch + transformers COLD IMPORT, which is paid whether or not the import succeeds. The
honest expectation is therefore that the fix makes those seconds PRODUCTIVE (an
embedding model that actually loads; diarization and voice profiles restored) rather
than eliminating them. Lane A is what makes the cold start survivable — do not assume
Lane B alone brings it under any particular budget.

## Post-deploy verification (2026-09-10, pipeline #1169 -> Argo `a752c9b2`)

Measured on `hope-v2-dev` after the merge shipped. Gateway `0.0.0-dev-2-2.db85eff1`.

**Lane A — CONFIRMED FIXED, with a live before/after.**

| | cold streaming-session create |
|---|---|
| before (hardcoded 15 000 ms) | STT answered `201` at **16 870 ms**; gateway aborted at 15 000 ms -> `503` |
| after (`sttStreaming.sessionCreateTimeoutMs`, 60 000) | **`201` in 17 340 ms** through the public gateway |

The first request after an STT restart now succeeds. This is the whole point of
the lane: the same request, the same latency, a survivable budget.

**Lane C — CONFIRMED FIXED.** Login + an authenticated call both `200` against
the freshly restarted gateway, i.e. sign and verify agree through
`resolveJwtSecret()` in production.

**Lane B — PARTIALLY fixed. The import bug is gone; diarization is still off.**

The `AutoProcessor` error no longer appears, and `build-stt` passed on the real
runner (439 s), so the `[ml]`/`[nemo]` ABI conflict is genuinely resolved. The
warm now gets FURTHER — far enough to attempt the actual model load — and fails
there instead:

```
stt.diarization.embedding_service  "Could not resolve the platform HuggingFace token; continuing unauthenticated"
embedding_service.py:57  RuntimeWarning: coroutine 'resolve_hf_token' was never awaited
stt.streaming.session_manager  "Failed to warm embedding model for streaming pipeline"
  Failed to load HuggingFace model wespeaker-voxceleb-resnet34: We couldn't connect
  to 'https://huggingface.co' ... couldn't find them in the cached files.
```

Two distinct follow-on defects, both pinned:

1. **`asyncio.run()` inside a running event loop.**
   `apps/stt/src/stt/diarization/embedding_service.py:52` calls
   `asyncio.run(_resolve(None))` from async request context. It raises, the
   coroutine is never awaited (hence the `RuntimeWarning`), and the bare `except`
   swallows it into "continuing unauthenticated" — so the platform HF token is
   NEVER resolved, whatever it is set to. `HF_TOKEN` is present in the pod env.

2. **The model identifier does not match the cached repo.**
   The mount is wired correctly — `HF_HOME=/mnt/models-bucket/hf`,
   `HF_HUB_CACHE=/mnt/models-bucket/hf/hub`, `HF_HUB_OFFLINE=1` — and the weights
   ARE published:
   `/mnt/models-bucket/hf/hub/models--pyannote--wespeaker-voxceleb-resnet34-LM`.
   But the `AiModel` row is `slug = wespeaker-voxceleb-resnet34`,
   `provider = built-in`, and its `_metadata` is only
   `{"embedding": {"dimension": 256}}` — it carries NO HuggingFace repo id. The
   loader therefore asks for the bare slug, which matches neither the Hub nor the
   cached directory (`pyannote/wespeaker-voxceleb-resnet34-LM`).

Consequence: ~16.6 s of the 17.3 s cold start is now this failed load, and speaker
embedding / diarization / voice profiles remain disabled. **Cold start did not
shrink** — the implementing agent predicted the seconds would become productive
rather than disappear; they are not yet productive either. Lane A is what carries
the cold start today.

Neither defect is a regression from this ticket: (2) predates it, and (1) was
previously masked because the import died before the token was ever needed.

## Change History

| Date | Change |
|---|---|
| 2026-09-10 | Ticket opened from live-cluster verification evidence (three lanes). |
| 2026-09-10 | Lanes A/B/C implemented; merged to `dev-2.2` as `9135b324f`. |
| 2026-09-10 | Post-deploy verification on `hope-v2-dev`: A and C confirmed fixed with live measurements; B partially fixed — import bug resolved, two follow-on defects pinned above. |
| 2026-09-10 | Implementation plan written into this file before any code (branch `task-944-cold-start-timeouts`). |
| 2026-09-10 | Lane A: `sttStreaming.sessionCreateTimeoutMs` descriptor (`global-kv`, system scope, `open-to-default`, default 60000); `StreamingSessionService` resolves it per call. Lane B: root cause identified as the ML image installing `stt[ml-gpu]` and `stt[nemo]` — extras the root pyproject DECLARES as conflicting — into one venv; the nemo install and its `transformers==5.5.4` override removed, guarded by a hermetic Dockerfile/pyproject contract test. Commit `2eeae45cd`. |
| 2026-09-10 | Lane C: `resolveJwtSecret()` becomes the one source for sign and verify (`JwtStrategy` moves to `secretOrKeyProvider`); OIDC's hard-coded fallback removed; `SecretsInvalidationSubscriber` wired, which answers the ticket's open question — `arca:secrets:invalidate` had NO production subscriber at all. A latent circular import (`config.service` → the `../secrets` barrel) surfaced and was fixed. Rotation contract documented in `docs/operations/jwt-secret-rotation.md`; the Vault runbook's inaccurate claim corrected. Commit `34603b4a8`. |
| 2026-09-10 | Gates run and recorded above: `pnpm test:unit`, `stt:lint`, `stt:typecheck` and `pnpm lint` green; the residual `applications` and `stt` failures proven pre-existing. Status → Review. Worktree left UNMERGED pending the orchestrator's target-branch call. |
