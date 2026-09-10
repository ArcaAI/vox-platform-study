# TASK-944 — Cold-start timeouts and secret hot-reload

**Status:** Pending
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

_pending_

## Change History

| Date | Change |
|---|---|
| 2026-09-10 | Ticket opened from live-cluster verification evidence (three lanes). |
