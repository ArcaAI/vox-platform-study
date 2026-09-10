# TASK-944 — Cold-start timeouts and secret hot-reload

**Status:** Review (A, C, B1 merged; B2 implemented on `task-944-lane-b2`, UNMERGED, cluster verification pending)
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

## Reopened 2026-09-10 — Lane B follow-ons (B1, B2)

Lane B's ABI/import fix landed and is confirmed. It moved the failure one step
later rather than clearing it, so speaker embedding / diarization / voice
profiles are STILL disabled and the cold start is still ~17 s. Two defects, both
pinned against the running cluster in the Post-deploy Verification section above.
Neither is a regression from lane B.

### B1 — `asyncio.run()` inside a running event loop

`apps/stt/src/stt/diarization/embedding_service.py:52`

```python
token = asyncio.run(_resolve(None))     # called from async request context
```

`asyncio.run()` raises when a loop is already running. The coroutine is then
never awaited (Python emits `RuntimeWarning: coroutine 'resolve_hf_token' was
never awaited`), and the bare `except Exception` downgrades it to
`"Could not resolve the platform HuggingFace token; continuing unauthenticated"`.

So the platform HF token is **never** resolved on this path, whatever it is set
to — `HF_TOKEN` is present in the pod env and still unused. Any gated repo would
fail with a confusing 401 rather than the real cause.

Fix the call so it works from async context. Do NOT simply widen or silence the
`except` — the swallow is half the defect: a control-plane fault and a
programming error currently produce the same log line.

### B2 — the model identifier does not match the published repo

The mount and offline mode are wired CORRECTLY (verified in-pod):
`HF_HOME=/mnt/models-bucket/hf`, `HF_HUB_CACHE=/mnt/models-bucket/hf/hub`,
`HF_HUB_OFFLINE=1`, and the weights ARE published at
`/mnt/models-bucket/hf/hub/models--pyannote--wespeaker-voxceleb-resnet34-LM`.

The `AiModel` row, however, is:

```
slug        wespeaker-voxceleb-resnet34
provider    built-in
format      PYTORCH
_metadata   {"embedding": {"dimension": 256}}      <-- no HF repo id
```

so the loader asks the hub for the bare slug `wespeaker-voxceleb-resnet34`, which
matches neither the Hub nor the cached directory
(`pyannote/wespeaker-voxceleb-resnet34-LM`), and fails after ~16.6 s.

**The decision this lane must make and document:** is the repo id DATA (a field on
the `AiModel` row / its `_metadata`, seeded) or is it RESOLUTION (a loader mapping
from a built-in slug to its canonical hub id)? Pick one and say why.

**Constraint that shapes it:** the dev cluster DB is already seeded and the
migrate Job runs with `RUN_SEED=none`, so editing the seed alone does NOT fix the
deployed row. If the answer is data, the lane must also supply the mechanism that
reaches an existing database (a migration or a documented backfill) — do not
assume a re-seed. Applying anything to the live cluster is the orchestrator's
surface, not the lane's.

### Verification criteria (B1, B2)

- A test proves the token resolver returns the configured token when called from
  async context, and that a genuine control-plane fault is still tolerated but is
  distinguishable in the logs from a programming error.
- A test pins the resolved hub identifier for the built-in embedding model to the
  repo that is actually published.
- Both are hermetic — no network, no GPU, no live cluster.

## Implementation Summary — B1 and B2 (2026-09-10)

**Both implemented, TDD, RED observed for each. Branch `task-944-lane-b1-b2`, UNMERGED**
(worktree `.claude/worktrees/agent-a6b07f1e6f4b6fe67`). Lanes A and C are untouched.

### B1 — one resolver, two thread contexts; two failure kinds, two log lines

| File | Change |
|---|---|
| `apps/stt/src/stt/diarization/embedding_service.py` | NEW `_run_resolver_blocking(make_coro)`: `asyncio.run` when the calling thread owns no loop (unchanged path), otherwise a one-shot `ThreadPoolExecutor` that gives the resolution a thread — and a loop — of its own. `_resolve_hf_token` now splits its `except`: `CredentialUnavailable` → WARNING (tolerated, and it now names the cause), anything else → `logger.exception` at ERROR, explicitly labelled a defect on the STT side. `CredentialUnavailable` is imported EAGERLY at module level — an `except` clause cannot name a class a failed import left unbound. |
| `apps/stt/tests/unit/test_task944_hf_token_async_context.py` | NEW — 5 hermetic cases (no network, no GPU, no gateway; the resolver and `huggingface_hub` are both stubbed). |

**Which caller was actually on the loop — the ticket said "async request context", and it is
`SileroVADService.initialize`.** `apps/stt/src/stt/vad/silero_service.py:73` calls
`self._resolve_model_path()` DIRECTLY from a coroutine, and that reaches `_resolve_hf_token`
(line 277). The three diarization callers
(`pyannote_embedding` / `speechbrain_embedding` / `segmentation_service`) all run under
`asyncio.to_thread`, where `asyncio.run` was already correct — which is why the module's old
docstring ("there is no loop to await on") was true of the callers it was written for and false
of the one added later. The fix covers both rather than moving the problem to the next caller.

RED reproduced the live symptom exactly, including its line number:

```
tests/unit/test_task944_hf_token_async_context.py::test_token_resolves_when_called_from_a_running_event_loop
  apps/stt/src/stt/diarization/embedding_service.py:57: RuntimeWarning:
  coroutine '_resolves_to' was never awaited
FAILED ... ::test_token_resolves_when_called_from_a_running_event_loop
FAILED ... ::test_a_programming_error_is_distinguishable_from_a_control_plane_fault
```

**What "distinguishable" means concretely.** A control-plane fault is the module's own declared
signal — `CredentialUnavailable`, raised by `raise_if_unusable` for `DENIED`/`UNAVAILABLE` — and
keeps the WARNING and the "continuing unauthenticated" wording an operator already greps for.
Everything else (a `RuntimeError` from a bad dispatch, a `TypeError` from a changed signature, a
missing gateway key) is ERROR + traceback, and says in the message that it is a defect on the STT
side and not a control-plane fault. Both are still TOLERATED — the posture is unchanged, only the
diagnosis is — because a public pyannote repo loads anonymously and a gated one fails later with
the hub's own explicit 401.

### B2 — DECISION: the hub repo id is DATA, on `AiModel.sourceUri`

**Not resolution.** Three reasons, in order of weight:

1. `09-infrastructure-devops.md` §"No hardcoded configuration" — a model id is configuration and
   never a literal in application code. A `built-in` slug → repo table inside `apps/stt` is the
   textbook "constant with a real default wearing a config costume".
2. **The column already exists and is already plumbed end to end, with no code default anywhere
   on the path**: `AiModel.sourceUri` → `ResolvedAgentModel.sourceUri`
   (`agent-resolver.service.ts:243`) → `AsrSpecModel.sourceUri`
   (`build-resolved-asr-spec.ts:140`) → `AiModelConfig.source_uri` (`pipeline/spec.py:493`) →
   `resolve_weights_or_hf_id` (`models/source_resolver.py:188`). Nothing is missing; one row holds
   a wrong value. A loader map would add a SECOND statement of the same fact, and the two would
   drift silently — which is the failure the rule exists to prevent.
3. `provider = 'built-in'` is a catalogue LABEL, not a resolution tier. Every other HuggingFace row
   in the catalogue resolves through `sourceUri`; a map for built-in rows alone would make this one
   row resolve unlike its ~30 siblings.

**The seed was already right.** `seed/ai-models/audio.ts:595` has declared
`sourceUri: 'pyannote/wespeaker-voxceleb-resnet34-LM'` since TASK-860, and `seedAiModels` re-syncs
that column on every re-seed. That is itself the strongest evidence the intended design is data:
the defect is a STALE ROW in a database that is never re-seeded, not a missing mapping.

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/migrations/20260910190000_task_944_wespeaker_embedding_source_uri/migration.sql` | NEW — pure DATA migration, modelled on `20260902090000_task_855_ai_model_source_uri_fix`. One guarded `UPDATE`. |
| `packages/database/src/__tests__/task944-embedding-model-source-uri.test.ts` | NEW — 5 text-level pins (no DB, no Prisma client), in the idiom of `global-setting-tenant-key-migration.test.ts`. |

**The mechanism that reaches an already-seeded database: a migration.** The deployed DB is seeded
and the k3s `hope-db-migrate` Job runs `RUN_SEED=none`, so a seed correction never lands there;
`prisma migrate deploy` — which that same PreSync Job already runs — is the only path that does.
The statement is therefore the re-seed of exactly one column of exactly one row, and can clobber
nothing a re-seed would have preserved. It matches by `slug` and does NOT filter `tenantId` (older
seeds cloned SYSTEM catalogue rows into customer tenants with a fresh id and the same slug — the
sweep pattern `retireLegacyAiModels` and task_855 both use), and it is guarded with
`IS DISTINCT FROM` so re-running it — or applying it to a freshly seeded database — touches no row.

**What the tests pin.** The seeded `sourceUri`; that its derived HuggingFace cache directory is
exactly `models--pyannote--wespeaker-voxceleb-resnet34-LM`, the directory verified present on the
mount (the pin that would actually have caught this, rather than one that merely looks plausible);
that the migration writes exactly the literal the seed declares, so the one fact now stated twice
cannot drift; that the migration is data-only and guarded; and a CLASS invariant — no
HuggingFace-source row in the catalogue may locate itself by its own bare slug, or by anything that
is not an `<org>/<repo>` hub id. That last one holds across the whole catalogue today, which is
further evidence the deployed row diverged from the seed rather than the seed being wrong.

### Adjacent finding — NOT fixed, deliberately out of B1/B2 scope

`HuggingFaceLoader.load` passes `cache_dir=settings.huggingface_cache_dir` to `from_pretrained`,
and that setting defaults to **`HF_HOME`** (`apps/stt/src/stt/core/config/settings.py:285-290`,
and the same in its `_resolve_huggingface_cache_dir` validator) — the PARENT of the hub cache, not
the hub cache. In the pod that is `/mnt/models-bucket/hf`, while the snapshot lives at
`/mnt/models-bucket/hf/hub/models--pyannote--wespeaker-voxceleb-resnet34-LM`. With
`HF_HUB_OFFLINE=1`, an explicit wrong `cache_dir` produces the SAME
"couldn't find them in the cached files" message as a wrong repo id, so the observed error does not
discriminate between the two. Note the field's own inconsistency: the env branch yields `HF_HOME`
while the literal fallback yields `~/.cache/huggingface/hub` — one is a hub cache, the other its
parent. `HUGGINGFACE_CACHE_DIR` is a declared var (`turbo.json#globalEnv`,
`apps/stt/.env.sample:80`) whose documented shape is a `.../hub` path, and it appears unset in the
pod. Two candidate remedies, both outside this lane: set
`HUGGINGFACE_CACHE_DIR=/mnt/models-bucket/hf/hub` in the deployment repo's STT config, or make the
default derive `$HF_HOME/hub`. **Read the deployed row's `sourceUri` before assuming which cause is
live** — the in-pod evidence in this ticket listed `slug`, `provider`, `format` and `_metadata`, but
not `sourceUri`, which is the column that actually carries the repo id.

### Gate results (B1/B2 branch)

| Gate | Result |
|---|---|
| `pnpm stt:test:unit` | **1 failed, 3290 passed** — the single failure is `test_task799_env_surface.py::TestNoCredentialHasARealCodeDefault::test_minio_credentials_default_to_empty`, the documented pre-existing one (the local `.env.test` sets `MINIO_ACCESS_KEY`). All 5 new cases pass. |
| `pnpm stt:lint` | PASS — "All checks passed!" |
| `pnpm stt:typecheck` | PASS — "Success: no issues found in 141 source files" |
| `pnpm --filter @arcaai/applications build` | PASS |
| `pnpm --filter @arcaai/applications test` | **12 775 passed, 6 skipped; 1 FILE failed** — `agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts`, PRE-EXISTING: it needs the live test DB on :5433, which is down. Zero test-level failures. |
| `pnpm --filter @arcaai/database` (the two model-catalogue suites) | PASS — 2 files, 29 tests |
| `pnpm lint` | PASS — 39/39 tasks, 0 errors. The 65 warnings are pre-existing `eslint-comments/require-description` in untouched `apps/api` files. |

`pnpm stt:test` (the full suite) was deliberately NOT run: it rewrites the tracked
`stt-loss-report.json` / `stt-quality-scorecard.json` with garbage on a machine with no models.

**Not verified here, and it cannot be:** that the deployed row is repaired, that the embedding
model then loads, and what the cold start costs afterwards. All three need the cluster.

## B2 RE-SCOPED 2026-09-10 — the loader, not the data

**The B2 premise in this ticket was wrong, and so was its first fix.** Recorded in
full because the wrong diagnosis is instructive.

The ticket asserted the `AiModel` row carried no HuggingFace repo id. It does —
in `sourceUri`, a column the original in-pod inspection never selected (it read
`slug`, `provider`, `format`, `_metadata`). Verified on the live cluster:

```
slug                        | sourceUri
wespeaker-voxceleb-resnet34 | pyannote/wespeaker-voxceleb-resnet34-LM
seed/ai-models/audio.ts:595   sourceUri: 'pyannote/wespeaker-voxceleb-resnet34-LM'   (since TASK-860)
```

Seed and live row have always agreed. The repair migration authored against that
premise was a guarded no-op; it has been **dropped** rather than added to the
ledger for a defect that does not exist.

A second hypothesis — that `huggingface_cache_dir` defaults to `HF_HOME` instead
of the hub directory — is also false HERE: `HUGGINGFACE_CACHE_DIR` IS set in the
pod, to `/mnt/models-bucket/hf/hub`. (The default-factory inconsistency at
`apps/stt/src/stt/core/config/settings.py:285-290` is real but latent, and only
bites an environment that leaves the var unset. Worth a separate cleanup.)

### The actual defect: a pyannote checkpoint loaded through the transformers loader

The published snapshot, read in-pod:

```
/mnt/models-bucket/hf/hub/models--pyannote--wespeaker-voxceleb-resnet34-LM/
  refs/main
  snapshots/837717ddb9ff5507820346191109dc79c958d614/
    config.yaml        _target_: pyannote.audio.models.embedding.WeSpeakerResNet34
    pytorch_model.bin
                       <- there is NO config.json
```

`HuggingFaceLoader` (`apps/stt/src/stt/models/huggingface_loader.py`) drives
`transformers` — `AutoProcessor`, `AutoModelForSpeechSeq2Seq`, `AutoModelForCTC`.
`transformers.from_pretrained` requires `config.json`. Absent it, and with
`HF_HUB_OFFLINE=1`, transformers reports *"We couldn't connect to
'https://huggingface.co' ... and couldn't find them in the cached files"* — a
message indistinguishable from a missing model or a wrong repo id, which is why
two independent diagnoses landed on the data instead of the loader.

`pyannote.audio` 4.x is ALREADY installed (it is why `[ml]` pins torch 2.8), so
the checkpoint has a correct loader available; it is simply not being used for
`SPEAKER_EMBEDDING`.

This also explains the ORIGINAL `AutoProcessor` symptom: that path was always
transformers. Lane B fixed the import, so it now fails one step deeper.

## B2 Implementation — loader selection moves onto `AiModel.libraryName`

**Status of B2: implemented on `task-944-lane-b2`. Not merged; cluster verification pending.**

### The decision, and why the alternatives were rejected

**Selection now keys on the row's DECLARED serving library, `AiModel.libraryName`.**
That is not a new invention for this ticket — it is the field TASK-860 already made
authoritative, and the Prisma schema says so in as many words
(`packages/database/src/prisma/db_main/ai-model.prisma`):

```
format AiModelFormat   // Artifact format — descriptive only since TASK-860.
                       // Loader selection is `libraryName`
libraryName String     // the Hub's second facet — the serving LIBRARY a loader is
                       // selected BY … Replaces the overloaded `format` + `provider`
                       // pair for loader selection.
```

`apps/stt` never received the field, so `ModelCache` kept the pre-TASK-860 `format`
key. **B2 is the unfinished half of TASK-860, not a new design.** The candidates in the
brief were weighed against that:

| Candidate | Verdict |
|---|---|
| **Key on `libraryName`** (chosen) | The catalogue already declares it, NOT NULL, on every row, validated against `AI_MODEL_LIBRARIES`; the schema names it as the selection field. One key, one vocabulary, no new concept. |
| Key on `(format, taskType)` | **Insufficient, not merely inelegant.** `SPEAKER_EMBEDDING` + `PYTORCH` covers `ecapa-tdnn-voxceleb` (speechbrain) AND `wespeaker-voxceleb-resnet34` (pyannote) — two different runtimes. `AUDIO_TO_AUDIO` + `PYTORCH` likewise covers `rnnoise` and `deepfilternet3`. The pair cannot separate either. |
| A new `AiModelFormat` value | A Prisma enum change + `ALTER TYPE ADD VALUE` + seed edits + a data migration for a DEPLOYED, never-re-seeded database — all to re-derive a fact the row already states. It would also entrench `format` as the selection key that TASK-860 explicitly retired. |
| Sniff the snapshot (`config.json` present?) | The "constant wearing a config costume" failure mode: an artifact probe standing in for a declared value, and it needs the weights on disk before it can answer. Rejected for SELECTION. It IS used, deliberately, for the failure MESSAGE — see Diagnosability. |

Selection FAILS CLOSED (`.claude/rules/09-infrastructure-devops.md` — provider/model
selection is `failMode: closed`): a declared library with no loader raises and names
both tables; no engine is guessed. The `format` map survives as the fallback for the
paths that cannot declare a library — inline model definitions, the deprecated DB
reader, and a spec built by a gateway that predates the wire field — so behaviour on
those is byte-identical to before.

### The second half of the decision: four rows do not belong in this cache at all

The correct loaders for the mis-routed rows **already exist and are already used.**
`SessionManager` builds `PyannoteEmbeddingService` / `SpeechBrainEmbeddingService`
itself (`_get_pipeline_embedding_service`, per model id, cached on the manager) and the
denoisers likewise, from the SAME `ResolvedAsrSpec` rows. The `ModelCache` warm was a
SECOND, doomed load of the same weights through `transformers`.

So the answer to "route it to a loader that can read `config.yaml`" is not a new
loader — writing one would duplicate an existing load and double the resident memory.
It is `RUNTIME_OWNED_LIBRARIES`: a declared table naming, per library, the runtime that
owns those weights instead. `loader_for` raises `ModelNotCacheServedError` and the warm
path treats it as an expected INFO-level skip.

**A correction to this ticket's own Lane B text:** the warm failure did NOT "silently
disable the speaker-embedding stage". `pipeline_embedding_service` comes from
`_get_pipeline_embedding_service`, never from the cache — the cache warm only lost the
pin. What it cost was time (~9.3 s on the measured cold session) and a WARNING that
read like a broken model.

### Blast radius — established from the catalogue, not assumed

Enumerated from `packages/database/src/prisma/db_main/seed/ai-models/*.ts`. Every
`format = PYTORCH` row is `servedBy: 'stt'` except `kokoro` (TTS, never in this cache):

| slug | `taskType` | `libraryName` | Before | After |
|---|---|---|---|---|
| `wespeaker-voxceleb-resnet34` | SPEAKER_EMBEDDING | `pyannote-audio` | → `HuggingFaceLoader` (the measured failure) | skipped, `PyannoteEmbeddingService` named |
| `ecapa-tdnn-voxceleb` | SPEAKER_EMBEDDING | `speechbrain` | → `HuggingFaceLoader` (`hyperparams.yaml`, no `config.json`) | skipped, `SpeechBrainEmbeddingService` named |
| `rnnoise` | AUDIO_TO_AUDIO | `pyrnnoise` | → `HuggingFaceLoader` on `sourceUri: pypi:pyrnnoise` | skipped, wheel-resident weights named |
| `deepfilternet3` | AUDIO_TO_AUDIO | `deepfilternet` | → `HuggingFaceLoader` on `sourceUri: github:…` | skipped, wheel-resident weights named |

So it is **four rows, not one** — the ECAPA embedder is the SYSTEM platform-default
agent's embedding model in the contract fixture, so this was hitting the default
configuration too, not only the wespeaker tenant. Rows that legitimately use
`HuggingFaceLoader` (`libraryName: transformers` / `ctranslate2` — e.g.
`nemotron-3.5-asr-streaming-0.6b`, `arcaai-whisper-large-ml-en`) are unchanged, pinned
by `test_a_served_library_selects_the_loader_that_executes_it`.

`cadence-punctuation` is listed in `RUNTIME_OWNED_LIBRARIES` for completeness — it is
referenced by slug only and never enters the cache (`pipeline_spec_from_resolved`
excludes `punctuation`/`endpointing`), so a future routing mistake gets the accurate
answer rather than "unknown library".

### Diagnosability — the two causes now read differently

1. **A distinct type.** `ModelNotCacheServedError(ModelLoadError)` — every existing
   `except ModelLoadError` still catches it, but the wrong-loader case is now nameable.
   Its message states the declared library, names the owning runtime, and says in
   words: *"This is a LOADER-SELECTION outcome, not a missing or mislocated model: do
   not go looking for the weights."*
2. **A failure-path probe, in the message only.**
   `HuggingFaceLoader._not_a_transformers_checkpoint_hint` — when `from_pretrained`
   fails and a resolved local snapshot directory EXISTS and holds files but none is
   `config.json`, the raised message appends the directory, what it actually holds
   (`config.yaml, pytorch_model.bin`), and the row's declared `libraryName`. A
   genuinely absent snapshot adds nothing, so a real cache miss is never relabelled a
   loader mismatch — the inverse defect, pinned by
   `test_a_genuinely_absent_snapshot_adds_no_hint`.
3. **The load log now names the loader** it selected and the library it selected on.

### Files changed

| File | Change |
|---|---|
| `apps/stt/src/stt/models/cache.py` | `RUNTIME_OWNED_LIBRARIES` (module constant, exported); `_install_loaders` builds `_library_loaders` beside `_loaders` from ONE set of shared loader instances; new `loader_for(model_config)`; `_load_by_slug` routes through it and logs library + loader |
| `apps/stt/src/stt/core/exceptions.py` | NEW `ModelNotCacheServedError(ModelLoadError)` |
| `apps/stt/src/stt/models/huggingface_loader.py` | `_not_a_transformers_checkpoint_hint`, appended to the generic load failure |
| `apps/stt/src/stt/pipeline/dto.py` | `AiModelConfig.library_name: str \| None = None` |
| `apps/stt/src/stt/pipeline/spec.py` | `AsrSpecModel.library_name` (in `OPTIONAL_FIELDS`); `to_ai_model_config` forwards it |
| `apps/stt/src/stt/pipeline/config_reader.py`, `core/database/models.py` | the deprecated DB reader carries the same field (leaving one reader on the old key is how this half of TASK-860 went unfinished) |
| `apps/stt/src/stt/streaming/session_manager.py` | `_load_optional` catches `ModelNotCacheServedError` → INFO skip, before the generic WARNING |
| `packages/types/src/agent.ts`, `asr-spec.ts` | `libraryName?: string` on `ResolvedAgentModel` and `AsrSpecModel` |
| `packages/applications/…/agent/agent-resolver.service.ts` | `toResolvedModel` projects `libraryName` off the row |
| `packages/applications/…/stt/agent-resolver/build-resolved-asr-spec.ts` | `toSpecModel` forwards it, omit-when-absent |
| `tests/contracts/resolved-asr-spec.fixture.json` | `libraryName` on all 24 model objects (purely additive; the file round-trips byte-for-byte otherwise) |
| `tests/contracts/resolved-asr-spec-parity.contract.test.ts` | `libraryName` in `OPTIONAL_MODEL_FIELDS` + a case asserting every fixture model carries one AND that a library-less input yields no `libraryName` key |
| `apps/stt/tests/unit/test_task944_loader_selection.py` | NEW — 18 cases: the measured defect, the blast radius row by row, the served libraries, library-beats-format, the two fallbacks, and the registry invariants |
| `apps/stt/tests/unit/test_task944_loader_diagnosability.py` | NEW — 9 cases: the field travels end to end, omit-when-absent, the four hint cases, and the warm path (skip at INFO / genuine failure still WARNING) |
| `apps/stt/tests/unit/test_task799_byok_credentials.py` | the BYOK lock test now sweeps `_library_loaders` too — selection keys on it, so a loader reachable only from that map must still declare a `credential_posture` |

**Why the wire field is OPTIONAL.** `_Wire` is `extra='forbid'` on both halves, and its
own docstring names omit-when-absent as the mechanism that makes the gateway and the
STT runtime independently deployable. `libraryName` follows `metadata` exactly. The
consequence is a DEPLOY ORDER note, not a defect: **STT deployed alone, against a
gateway that has not shipped this change, keeps the old `format` behaviour** — the
field arrives only once the gateway half is deployed.

**No migration, no schema change, no seed edit.** `AiModel.libraryName` is an existing
NOT NULL column, correctly populated on every seeded row. Nothing for the orchestrator
to apply to a database.

### Gate results (B2)

| Gate | Result |
|---|---|
| `pnpm stt:test:unit` | **1 failed, 3329 passed** (baseline was 3290 + the 39 added here). The single failure is `test_task799_env_surface.py::TestNoCredentialHasARealCodeDefault::test_minio_credentials_default_to_empty`, the documented pre-existing one (the local `.env.test` sets `MINIO_ACCESS_KEY`). |
| `pnpm stt:lint` | PASS — "All checks passed!" |
| `pnpm stt:typecheck` | PASS — "Success: no issues found in 141 source files" |
| `pnpm --filter @arcaai/database test` | PASS — 89 files, 1739 tests |
| `pnpm --filter @arcaai/applications test` | **12 852 passed, 6 skipped; 1 FILE failed** — `agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts`, PRE-EXISTING: its `afterAll` needs the live test DB on :5433, and `nc -z localhost 5433` confirms the port is CLOSED. ZERO test-level failures. |
| `npx vitest run tests/contracts/resolved-asr-spec-parity.contract.test.ts` | PASS — 18 tests, both halves of the contract green on the new field |
| `pnpm lint` | PASS — 39/39 tasks, 0 errors. The 65 warnings are pre-existing `eslint-comments/require-description` in untouched `apps/api` files (same count as the B1/B2 run above). |
| `npx turbo run build --filter=@arcaai/applications` | PASS — 10/10 tasks |

`pnpm stt:test` (the full suite) was deliberately NOT run: it rewrites the tracked
`stt-loss-report.json` / `stt-quality-scorecard.json` with garbage on a machine with no
models. Both files are confirmed unmodified.

**Not verified here, and it cannot be without the cluster:** that the embedding warm
now skips instead of failing in-pod, what the cold streaming-session create actually
costs afterwards, and whether the ~9.3 s is fully recovered (the doomed transformers
resolution is removed, but its share of that figure was never isolated from
`PyannoteEmbeddingService`'s own load in the captured logs). All three need a deploy of
BOTH halves — see the deploy-order note above.

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
| 2026-09-10 | **B1** — `_resolve_hf_token` now crosses the async boundary from EITHER side (`_run_resolver_blocking`); the caller that was on the loop is identified as `SileroVADService.initialize` → `_resolve_model_path`, not a diarization constructor. Its single `except` splits: `CredentialUnavailable` stays a tolerated WARNING, everything else is an ERROR + traceback labelled a defect on the STT side. RED reproduced the live `RuntimeWarning: coroutine ... was never awaited` at `embedding_service.py:57`. Branch `task-944-lane-b1-b2`. |
| 2026-09-10 | **B2** — decision recorded: the hub repo id is **DATA on `AiModel.sourceUri`**, not a loader-side slug→repo map (owner rule "no hardcoded configuration"; the column is already plumbed end to end with no code default; `provider = built-in` is a label, not a resolution tier). The seed has always been correct, so the mechanism supplied is the one that reaches an already-seeded database: a guarded data migration, `20260910190000_task_944_wespeaker_embedding_source_uri`, applied by the existing `hope-db-migrate` PreSync Job. Pinned by 5 text-level tests, including a class invariant that no HuggingFace row may locate itself by its own bare slug. |
| 2026-09-10 | Adjacent finding recorded and deliberately NOT fixed: `settings.huggingface_cache_dir` defaults to `HF_HOME`, the PARENT of the hub cache, so `HuggingFaceLoader` may miss an offline snapshot even with a correct `sourceUri`. Read the deployed row's `sourceUri` before assuming which cause is live. |
| 2026-09-10 | **B2 RE-SCOPED** — both prior diagnoses (a stale `sourceUri`, then a wrong `cache_dir`) proven false against the live cluster; the repair migration authored for the first was dropped as a guarded no-op. Real cause: a pyannote checkpoint routed to the transformers loader, because `ModelCache` keyed its registry on `format` alone and `PYTORCH` cannot separate a transformers checkpoint from a pyannote one. |
| 2026-09-10 | **B2 IMPLEMENTED** (branch `task-944-lane-b2`). Loader selection moves onto `AiModel.libraryName` — the field TASK-860 already declared as authoritative and `apps/stt` never received, making B2 the unfinished half of TASK-860 rather than a new design. `(format, taskType)` was rejected as INSUFFICIENT (it separates neither `speechbrain` from `pyannote-audio` nor `pyrnnoise` from `deepfilternet`); a new `AiModelFormat` value was rejected as an enum migration on a deployed, never-re-seeded DB to re-derive a fact the row already states; file sniffing was rejected for selection and used only in the failure MESSAGE. Blast radius is **four** rows, not one — `wespeaker-voxceleb-resnet34`, `ecapa-tdnn-voxceleb` (the SYSTEM default agent's embedder), `rnnoise`, `deepfilternet3`. All four are declared `RUNTIME_OWNED_LIBRARIES`: their correct loaders already exist and are already used by `SessionManager`, so the cache warm was a second, doomed load, and a new loader would have duplicated it. Diagnosability: `ModelNotCacheServedError` + a failure-path hint naming what the snapshot actually holds. NO schema change, NO migration, NO seed edit — the column exists and is correctly populated. |
| 2026-09-10 | B2 correction to this ticket's own Lane B text: the warm failure did NOT disable the speaker-embedding stage. `pipeline_embedding_service` is built by `_get_pipeline_embedding_service`, never by the cache; the warm only lost the pin. What it cost was ~9.3 s of cold start and a WARNING that read like a broken model. |
| 2026-09-10 | B2 gates recorded above: `stt:test:unit` 3329 passed / 1 pre-existing failure, `stt:lint`, `stt:typecheck`, `@arcaai/database` (1739), the cross-language ASR-spec contract (both halves), `pnpm lint` (0 errors) and the `@arcaai/applications` build all green; the one `applications` file failure proven pre-existing (test DB :5433 closed, 0 test-level failures). **Deploy-order note: the wire field is omit-when-absent, so STT deployed WITHOUT the gateway half keeps the old `format` behaviour.** Worktree left UNMERGED. |
