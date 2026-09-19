# TASK-948 — SDK 3.2.0 release, and the ALaaS uptake

| | |
|---|---|
| **Status** | In Progress — versioned and gated on `dev-2.2`, ALaaS migrated and green against the built 3.2.0; awaiting the `SDK-3.2.0` tag, then the ALaaS dep bump + lockfile |
| **Type** | infrastructure (release) |
| **Branch** | `dev-2.2` |
| **Consumers touched** | `arca/ALaaSv3.0` → `apps/audio-stream-svc` |

---

## 1. Requirement Analysis

Cut the release that carries the SDK work accumulated since `SDK-3.1.0`, then move
`ALaaSv3.0`'s `audio-stream-svc` onto it.

`3.2.0` is not a choice made here. `.claude/rules/08-vox-sdk.md` already names it:

> The manifests still read **3.1.0**. Versioning the nine SDK packages in lockstep is a RELEASE
> decision, deliberately not taken inside this ticket; `3.2.0` names the release this lands in.

## 2. Current State Evaluation

### 2.1 The change is a MINOR, not a patch

Only two `patch` changesets existed (`finalize()` rename, sync-generation timeout). Three
packages had shipped **new public API with no changeset at all** — as-is they would have been
released silently unversioned.

| Package | Unreleased since `025823396` | Bump |
|---|---|---|
| `@arcaai/vox-node` | The realtime consultation plane (TASK-933): `consultations.open/get`, `.recording.*`, `.streams.*`, `hope.stt.*`, `RealtimeSttSocket` — +3093 lines | minor |
| `@arcaai/vox` | `OpenSessionInput.language` / `Consultation.language` (TASK-932); `useArcaLiveSummary` snapshot retention | minor |
| `@arcaai/vox-codegen` | Service-account mode for `--tenant` (TASK-933) | minor |

### 2.2 `@arcaai/vox-codegen` was not in the lockstep group

`08-vox-sdk.md` calls the family "nine linked packages" and the CI `publish-sdk` job builds
vox-codegen with the rest, but `.changeset/config.json#fixed` listed only **eight**. vox-codegen
reached 3.1.0 solely because TASK-931 hand-wrote it a changeset — it would silently drift the
first time someone forgot. Added to `fixed`; the config is now what the rule already documented.

### 2.3 The TS 6 build does NOT break TS 5 consumers (verified, not assumed)

3.1.0 was the last release built with TypeScript 5; TASK-936 moved the workspace to **TS 6.0.3**
after it, so **3.2.0 is the first release emitted by TS 6**. `audio-stream-svc` is on
**TypeScript 5.1.3 / @types/node 20.3.1**, which raised a real major-vs-minor question.

Tested rather than reasoned about: the emitted `packages/vox-node/dist/index.d.ts` was
typechecked under exactly TS 5.1.6 + `@types/node@20.3.1`, against the **installed 3.1.0
declarations as a control**.

```
3.2.0  → 7 errors: Headers ×3, fetch ×2, Response, ReadableStream
3.1.0  → 7 errors: Headers ×3, fetch ×2, Response, ReadableStream   (identical)
```

Both sets are WinterTC runtime globals the consumer's own `lib`/`types` supply — **no TS 6-only
syntax reaches the published declarations**, and the counts are byte-identical between versions.
`audio-stream-svc` additionally runs `skipLibCheck: true`, so it never checks these internals.
`minor` is correct.

## 3. Implementation Plan

1. Add `@arcaai/vox-codegen` to `.changeset/config.json#fixed`.
2. Write the three missing `minor` changesets.
3. `pnpm changeset:version` on-branch (the TASK-931 precedent — CI's own `changeset version`
   then no-ops, and its push to `release-sdk` is skipped because nothing is left staged).
4. Run the SDK gates.
5. Commit. **The `SDK-3.2.0` tag is pushed by the owner** — publishing nine packages to GitHub
   Packages is irreversible, and no working registry credential exists on this machine
   (`~/.npmrc`'s token fails auth; ALaaS's `.npmrc` interpolates an unset `${GITHUB_TOKEN}`).
6. After publish: bump ALaaS, install, run its gates.

## 4. Implementation Summary

### 4.1 Versioned — all nine in lockstep at 3.2.0

`@arcaai/vox` · `vox-node` · `vox-codegen` · `room` · `stt` · `vad` · `noise-filter` ·
`med-ner` · `pipeline` — 3.1.0 → **3.2.0**, with CHANGELOGs written from the five changesets.

### 4.2 Gates (actual output)

| Gate | Result |
|---|---|
| `pnpm sdk:build` | `Tasks: 7 successful, 7 total` |
| `pnpm sdk-node:build` | `Tasks: 2 successful, 2 total` |
| `pnpm sdk-codegen:build` | `Tasks: 1 successful, 1 total` |
| `pnpm sdk:test` | `Tasks: 8 successful, 8 total` |
| `pnpm sdk-node:test` | `Tasks: 3 successful, 3 total` |
| `pnpm sdk-node:typecheck` | `Tasks: 2 successful, 2 total` |
| `pnpm sdk-node:check:exports` | publint `All good!`; are-the-types-wrong bundler 🟢 |
| `pnpm sdk-codegen:test` | `Tasks: 2 successful, 2 total` |

### 4.3 ALaaS — `apps/audio-stream-svc` (commit `7191c05`, branch `codeSwitchImplementation`)

The service anticipated this release: `hope-realtime.port.ts` + `hope-realtime.vox-node.adapter.ts`
declare the H2 surface and cast the client to it, so the adapter compiles against an SDK that
could not yet serve it. **That declaration was verified method-by-method against the shipped
3.2.0 source** — `recording.start/stop`, `streams.liveSummary`, `stt.createStreamSession /
refreshTicket / closeStreamSession / socket`, `workflows.reviews`, and the socket's
`connect / sendPcm16 / close / resume / on` all match. The file's own promise ("when the SDK
lands, this file does not change") held, apart from the rename below.

| Change | Why |
|---|---|
| `socket.stop()` → `socket.finalize()` | The SDK renamed it; `stop()` is now a deprecated alias |
| Fake socket in the adapter spec: `stop()`/`stopped` → `finalize()`/`finalized` | This is the name-pinning mechanism working as designed — it fails here instead of in a live consultation |
| Corrected the "half-close" doc in **three** places (adapter declaration, `HopeSttSocketHandle`, the broker call site) | ALaaS carried the *exact* wrong belief the SDK renamed the method to kill: that the session survives. It does not — `status finalizing` → `status closed` |

**ALaaS was never harmed by that bug.** `consultation-broker.service.ts` calls it inside its own
`stop()`, at end-of-consultation, which is the one correct place. Only the wording was wrong.

**Verified against the REAL 3.2.0, not just the declaration.** `node_modules/@arcaai/vox-node` in
that service is a symlink to `hope-v2/packages/vox-node` (the dev arrangement left by the TASK-933
live proof), and that package now reads `3.2.0` with `finalize()` in its built `dist`. So these
gates ran against the shipped surface:

| Gate | Result |
|---|---|
| `nest build` (tsc) | exit 0 |
| `eslint` (the four changed files) | exit 0 |
| `jest src/consultation` | `7 passed, 7 total` suites · `136 passed, 136 total` tests |

**The dependency bump is deliberately NOT in that commit.** `apps/audio-stream-svc/pnpm-lock.yaml`
is tracked and pins `@arcaai/vox-node@3.1.0` to a registry tarball + integrity hash; moving
`package.json` to `3.2.0` alone would fail `pnpm install --frozen-lockfile` in Docker and CI. The
manifest and the lockfile must move in one commit, and the lockfile cannot resolve 3.2.0 until it
is published. (`@arcaai/vox-codegen` is absent from that lockfile and from `node_modules`
entirely — declared as a devDependency but never installed. Pre-existing, untouched here.)

### 4.4 The timeout finding — latent, documented, no behaviour changed

`SYNC_GENERATION_TIMEOUT_MS` (180 s) applies only when **neither the call nor the client** names
a timeout: `options.timeoutMs ?? transport.defaultTimeoutMs ?? SYNC_GENERATION_TIMEOUT_MS`, and
`defaultTimeoutMs` is *the integrator's explicit client value*. An explicit client timeout
therefore **suppresses the new floor**. Two ALaaS clients set one:

| Client | Timeout | Exposure today |
|---|---|---|
| `HopeRealtimeVoxNodeAdapter` | `HOPE_TIMEOUT_MS` ?? 60 s | **None** — touches no generation route (`summaries.latest` only). 60 s is right for its reads and writes |
| `HopeService` | `AGENTIC_SDK_TIMEOUT_MS` ?? 120 s | **None** — its department pre-summary goes through the v1-compat `hope.summarization.preSummary`, which carries no floor at all; 120 s clears the 46–68 s measured in TASK-946 |

So nothing is broken and no value was changed. The trap is that it is invisible: adopting
`consultations.summaries.generate*` from either client would silently inherit 60 s / 120 s
instead of 180 s. A comment at the adapter's `timeout:` records it. Note also that
`SummarizationRequestOptions` exposes only `signal` — the v1-compat plane has **no** per-call
timeout override, so its ceiling is the client value or nothing.

## 5. Remaining Work

1. **Owner pushes the `SDK-3.2.0` tag** → CI `publish-sdk` versions (a no-op; already applied
   here), builds, and publishes the nine packages to GitHub Packages.
2. In ALaaS, as ONE commit: set `@arcaai/vox-node` and `@arcaai/vox-codegen` to `3.2.0` in
   `apps/audio-stream-svc/package.json`, export a `GITHUB_TOKEN` with `read:packages`, run
   `pnpm install` to refresh `pnpm-lock.yaml`, then re-run `nest build` / `eslint` / `jest`.
   That install also replaces the local symlink with the registry copy — which is the one thing
   these gates have NOT exercised.

Neither repository has been pushed.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-10 | Ticket opened. vox-codegen added to the changesets `fixed` group; three missing minor changesets written; nine packages versioned to 3.2.0 (`cc8d3e79a`); all SDK gates green; TS 6 → TS 5.1 declaration compatibility proven against a 3.1.0 control. ALaaS migrated to `finalize()` with the half-close doc corrected in three places (`7191c05`), green against the built 3.2.0; dep bump held back to stay atomic with the lockfile. |
