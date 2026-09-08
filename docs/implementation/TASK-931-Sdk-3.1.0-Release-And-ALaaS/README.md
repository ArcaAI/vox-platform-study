# TASK-931 — SDK 3.1.0 release (`@arcaai/vox`, `@arcaai/vox-node`, `@arcaai/vox-codegen`) and the ALaaSv3.0 consumer update

| Field | Value |
|---|---|
| **Status** | `In Progress` |
| **Type** | `feature` (SDK surface) + `infrastructure` (release mechanics) + `docs` |
| **Branch** | `dev-2.2` (lane K worktree `../hope-v2-t931-k`, branch `task-931-sdk`) |
| **Raised** | 2026-09-08 |
| **Memory snapshot** | [`MEMORY.md`](./MEMORY.md) — verbatim copies of the orchestrator memory files governing this ticket (decisions, hazards, working rules) |
| **Related** | TASK-930 (the gateway changes the SDK consumes — INTERFACES §2–§5), TASK-890 J6 (black-box developer journey), TASK-898 / TASK-914 (socket lane, closed by this release), TASK-928 (49-vs-52 doc drift, closed here) |
| **Lane contract** | [`../TASK-930-Agent-Workflow-Platform-Commitments/INTERFACES.md`](../TASK-930-Agent-Workflow-Platform-Commitments/INTERFACES.md) §9 |

## 1. Requirement Analysis

Owner brief (2026-09-08): explore and discover the SDKs, make them production-ready, bump the
version and release; there are two codegen packages "for generating context schema defined by
tenant admin to be used in any workflows and agents"; then review and update the SDK usage in
`/Users/taphuynh/Desktop/igglo/ARCAAI/ALaaSv3.0/apps/`.

## 2. Current State Evaluation (2026-09-08, discovery lane on `dev-2.2 @ 4e0c9362e`)

| # | Finding | Evidence |
|---|---|---|
| S-1 | All four packages are `3.0.1`; `@arcaai/vox` 3694 tests green, `vox-codegen` 43, `vox-node-codegen` 36; **`vox-node` has one red test**: `SDK_VERSION` is the literal `'3.0.0'`. | `vox-node/src/core/transport.ts:27`; `sdk-version.test.ts:40` |
| S-2 | Every `publishConfig.registry` is GitHub Packages, and this machine's `~/.npmrc` carries a GitHub Packages token — that is where the 2.0.x/3.0.x releases went and where ALaaS pulls from. The `publish-sdk` CI job writes an `.npmrc` for the **GitLab** registry, so it can never have published successfully. | `vox-node/package.json:77-80`; `.gitlab/ci/publish.yml:107-113` |
| S-3 | `vox-codegen` is publishable by manifest (README says `npx @arcaai/vox-codegen`) but is absent from the CI build list and sits in the Changesets `ignore` list; `vox-node-codegen` is `private: true` (correct — it generates `hope.admin.*` from the route manifest and has nothing to do with tenant schemas). Only `vox-codegen` types tenant-authored schemas, and only the consultation context schema — no agent/workflow input/output types. | `.changeset/config.json:16-21`; `vox-codegen/src/cli.ts` |
| S-4 | Both CHANGELOGs are headed `[Unreleased]` with no `3.0.1` section and a stale unconsumed changeset (`olive-moons-shake.md`) would double-bump on the next `changeset version`. | `.changeset/`, `packages/*/CHANGELOG.md` |
| S-5 | Socket transport is a `TODO(TASK-864)` in both SDKs; the gateway ticket route forbids API keys (TASK-930 C-3). | `vox-node/src/resources/workflows.ts:134-135` |
| S-6 | Docs drift: "52 admin areas" in three places vs 49 generated; rule 08 lists 4 entry points (there are 5, `/compat` exists) and "currently 3.0.0"; `vox-node-gateway-gaps.md` G3 says webhooks never fire (TASK-890 shipped delivery); examples cover only summarization/jobs. | `vox-node/src/index.ts:88`, `README.md:206`; `.claude/rules/08-vox-sdk.md:55` |
| S-7 | Five first-party demo call sites still pass `sttPipelineId` (deprecated, R4). | `apps/example/src/compat-main.tsx:27`, `apps/compat-playground/src/{App.tsx:25,context/playground-session.tsx:575}`, `apps/quick-compat-app/src/{App.tsx:48,components/LiveTranscription.tsx:24}` |
| A-1 | **ALaaSv3.0** (branch `codeSwitchImplementation`, dirty: the two `package.json` files already bumped to `3.0.1` but both `pnpm-lock.yaml` still pin `2.0.4` / `2.0.7` — a Docker build fails `ERR_PNPM_OUTDATED_LOCKFILE`). `audio-stream-svc` uses `hope.summarization.preSummary/summary` (current). `web_ui` imports **`useSMR` from `@arcaai/vox/compat`, which no longer exists** (renamed `useText`), and selects STT via `sttPipelineId` everywhere. `openai-service`, `azure-transcription-service`, `translation-service` have no HOPE integration and are commented out of compose; `mmr_agent` is a local capture agent. | discovery lane 2026-09-08 |
| A-2 | **Security:** `apps/web_ui/.npmrc` and `apps/audio-stream-svc/.npmrc` commit a live GitHub PAT; `web_ui/Dockerfile.ui` bakes `ARG GITHUB_TOKEN` into a layer. | same |

## 3. Plan

Lane K (INTERFACES §9) delivers the package changes; the orchestrator publishes and tags; the
ALaaS update follows the publish. Version: **3.1.0** — every change is additive (new task value,
new scopes accepted, new transport option, new codegen flags); the R4 removals stay for TASK-901.

Release runbook (orchestrator, after merge and gates):

```bash
pnpm changeset version            # consumes the K changesets → 3.1.0 across the fixed group
pnpm sdk:build && pnpm sdk-node:build && pnpm --filter @arcaai/vox-codegen build
pnpm changeset publish            # → npm.pkg.github.com (this machine's ~/.npmrc)
git tag SDK-3.1.0 && git push origin dev-2.2 SDK-3.1.0
```

ALaaS (after 3.1.0 is on the registry; edits land uncommitted on the owner's dirty branch, reported
file by file): bump both apps to `3.1.0`, regenerate both `pnpm-lock.yaml`, `useSMR` → `useText`,
`sttPipelineId` / `batchSttPipelineId` → `sttAgentSlug` (`VITE_SDK_STT_AGENT_SLUG`), `.npmrc` token
→ `${GITHUB_TOKEN}` interpolation, `Dockerfile.ui` → BuildKit secret like its sibling. The token
rotation is the owner's action (TASK-930 Q-3).

## 3.1 Lane log (live)

| Lane | Where | State (2026-09-08) |
|---|---|---|
| K | `../hope-v2-t931-k` · `task-931-sdk` (base `7793d09ca`) | first run killed by the account spend limit after `cf62eff3d` (S-1: `SDK_VERSION` derived from `package.json` at build time); resumed from brief step 2 with the amended stream-ticket shape `{ ticket, expiresAt, scope, url }` (TASK-930 §4.2 A-1) |
| A | ALaaSv3.0 working tree, branch `codeSwitchImplementation`, edits left UNCOMMITTED | first run killed during reading (repo untouched — only the owner's three pre-existing modified files); relaunched. Scope: `useSMR` → `useText`, `sttPipelineId` → `sttAgentSlug` (`VITE_SDK_STT_AGENT_SLUG`, default `realtime-transcription`), pins to `3.1.0` without lockfile regeneration, `.npmrc` token → `${GITHUB_TOKEN}`, `Dockerfile.ui` BuildKit secret; builds verified in throwaway copies against 3.0.1 |

## 4. Implementation Summary

**Where this stands: the packages are AT 3.1.0 and green; they are not yet PUBLISHED.** Lane K's
work merged at `069d8c548` (+ the punch-list commit `63c070bce`), and `a58b42361` applied the
changesets across the family. The publish and the `SDK-3.1.0` tag are the orchestrator's next
action, and the ALaaS consumer update (lane A) follows it — which is why this ticket stays
`In Progress`.

### 4.1 What shipped in the packages (lane K, `task-931-sdk`, 15 commits, entirely in-row)

| Surface | Change |
|---|---|
| **NER as a task** | `AgentTask` gains `'NAMED_ENTITY_RECOGNITION'` in **both** SDKs, with `NamedEntityRecognitionInput` / `NamedEntityRecognitionOutput` / `RecognizedEntity` for the DEFAULT shape (`{ entities: [{ text, label, start, end, score? }] }`). They are convenience types, not a constraint — the answer is the agent's own `outputSchema`. One-shot: `?mode=stream` on a NER agent is a gateway **400 `MODE_UNSUPPORTED`**, so `stream` / `invokeAndStream` fails rather than answering slowly |
| **Credential planes** | The hard-coded `assertApiKeyPlane` became an overridable **`assertCredentialClass()`**, so `hope.agents.*` and `hope.workflows.*` accept a service account now that TASK-930 declares the five `svc:*` scopes on those routes; the consultation-bound plane (`hope.consultations.workflows`) keeps the strict form and still exports `CredentialClassError`. The construction-time rule is unchanged: a service-account client never sends `X-Tenant-Id`, because `workingTenantId` binds at token EXCHANGE |
| **Socket transport** (closes S-5, TASK-914 / TASK-898) | `transport: 'sse' \| 'socket'` on `streamRun` / `waitForRun` / `runAndStream` (vox-node, zero-dep `core/socket.ts` over `globalThis.WebSocket` → **Node 22+**, `SocketUnavailableError` naming that floor rather than falling back silently) and `useWorkflowRun({ transport: 'socket' })` in the browser (`WorkflowRunSocketClient`). Both mint the run-scoped single-use ticket `POST /workflows/{slug}/runs/{runId}/stream-ticket` → `{ ticket, expiresAt, scope, url }` and open the `url` returned — never a JWT in a query string. Coded to contract amendment **A-1**, so `expiresAt` is epoch ms, not `expiresIn`. **SSE stays the default: it is the only lane that RESUMES** (`Last-Event-ID`) |
| **`@arcaai/vox-codegen` business plane** (closes S-3) | `--api-key <key> [--agents] [--workflows]` emits `Agent_<Slug>_Input/_Output` and `Workflow_<Slug>_Input/_Output` plus slug-keyed contract maps, through the same JSON-Schema-subset transpiler the context-schema mode uses. It never calls an admin route — an API key cannot. The two modes are mutually exclusive by refusal, not by guess. `HOPE_API_KEY` is the env fallback for `--api-key` (a key on argv is visible in `ps`) and is declared in `turbo.json#globalEnv` + the env samples (`63c070bce`, `0bb865d31`) |
| **A live bug found on the way** | `useAudioCapture` read `options.sttPipelineId` and nothing else, although `V1SdkConfig` had gained `sttAgentSlug` and `mapV1ConfigToV2` already preferred it. A compat app that had moved to the agent slug AND drove capture from this hook — which the playground does, because whichever hook calls `audio.start()` first wins the shared-audio race — started its session with **no selector at all** and silently ran the tenant default. It now forwards `sttAgentSlug` as `agentSlug`, at most one selector per session body |
| **Demo call sites** (closes S-7) | the five first-party sites in `apps/example`, `apps/compat-playground` and `apps/quick-compat-app` select an ASR **agent**; `sttPipelineId` itself is untouched and still honoured (removed in R4, TASK-901) |

### 4.2 Release mechanics (closes S-1, S-2, S-4)

- **`SDK_VERSION` is derived from `package.json` at build time** (`cf62eff3d`). It was a
  hand-maintained literal reading `3.0.0` while the package was `3.0.1`, so every request from the
  shipped SDK announced the wrong version in `User-Agent` — discoverable only mid-incident, while
  correlating SDK versions in gateway logs.
- **The CI `publish-sdk` job writes an `.npmrc` for GitHub Packages, not GitLab.** The old job could
  never have published: `changeset publish` honours each package's OWN `publishConfig.registry`, and
  every publishable manifest names `npm.pkg.github.com` — which is where the 2.0.x / 3.0.x releases
  actually went, by hand from an operator's machine.
- **`@arcaai/vox-codegen` left the Changesets `ignore` list** and joined the publish build list, so
  it is versioned and published with the family instead of by hand.
- **Versioned at `a58b42361`:** the eight-package `fixed` group (`@arcaai/vox`, `@arcaai/vox-node`,
  `@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/med-ner`,
  `@arcaai/pipeline`) plus `@arcaai/vox-codegen` — **nine packages at 3.1.0**, four changesets
  consumed. Minor and non-breaking by design (D-10): a new task value, new scopes ACCEPTED, a new
  transport OPTION, new codegen flags. Nothing was removed, and the R4 set stays for TASK-901,
  because ALaaS and three first-party demo apps still sit on `sttPipelineId` — a breaking release
  would have blocked ask #4's own consumer update.

### 4.3 Documentation drift closed (S-6, TASK-928)

`hope.admin.*` is **49** areas, not the 52 claimed in three places (`ai-task-defaults`,
`pipeline-policy` and `tenant-tts-config` left with the routes they wrapped). Rule
`.claude/rules/08-vox-sdk.md` now lists **five** entry points (`/compat` existed and was undocumented),
the credential planes, the socket lane, both codegen modes and the 3.1.0 surface.
`docs/architecture/vox-node-gateway-gaps.md` G3 ("webhooks never fire") is closed — delivery shipped
in TASK-890. New example `examples/05-agents-and-workflows.ts` runs an agent, streams a workflow and
releases a human-review node end to end.

### 4.4 Gates

Lane K, pasted in its report: `sdk:test` **3 704 passed / 244 files**, `sdk-node:test` **452 / 30
files**, `vox-codegen` **55**, `vox-node-codegen` **36**, `check:exports` clean, every build / lint /
typecheck 0. Re-run at the bumped version in `a58b42361`: `sdk:build`, `sdk-node:build`, `sdk:test`,
`sdk-node:test`, `sdk-codegen:test` and `check:exports` all exit 0. On the integrated tree
(`61e05e089`+): `pnpm typecheck:all` 0 errors, `pnpm lint:all` 0 errors, workspace `pnpm test:unit`
**23 803 passed / 0 failed**, and the vox-node admin generation check green at **49 areas / 417
routes / 413 schemas**.

`apps/quick-compat-app` typecheck **cannot** run until 3.1.0 is on the registry — it installs the
PUBLISHED package. Re-run it after the publish.

### 4.5 Publish evidence

<!-- PUBLISH-EVIDENCE -->
**Published 2026-09-08 (from the owner's machine, GitHub Packages, `changeset publish`).** The first
run aborted at 5/12 with `ENEEDAUTH … registry.npmjs.org`: three internal packages with no
`publishConfig` (`@arcaai/types`, `@arcaai/utils`, `@arcaai/json-schema-subset`) defaulted to npmjs
because the local `~/.npmrc` carried only the auth token, not the `@arcaai:registry=` scope line CI
writes. With the scope mapped (a gitignored root `.npmrc`) the second run published the rest:

| Package | Version on `npm.pkg.github.com` |
|---|---|
| `@arcaai/vox`, `@arcaai/vox-node`, `@arcaai/vox-codegen` | 3.1.0 |
| `@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/med-ner`, `@arcaai/pipeline` | 3.1.0 |
| `@arcaai/json-schema-subset`, `@arcaai/types`, `@arcaai/utils` | 0.1.0 |

**Defect found and closed by this publish:** `@arcaai/vox` depends on `@arcaai/json-schema-subset`
(`workspace:*` → `0.1.0`), and the registry's `vox@3.0.1` already declared that dependency — but
`json-schema-subset@0.1.0` had NEVER been published, so `vox@3.0.1` could not be installed from
GitHub Packages. It is on the registry now. `types` / `utils` rode along exactly as CI's scope mapping
would publish them; neither is a dependency of any SDK package.

Local git tags created by changeset at `bc8234fe0`: one `<name>@<version>` per published package
(twelve). Pushing tags to GitLab is the owner's step (the owner rewrote and force-pushed `dev-2.2`
on the same day; tag pushes follow the same decision).


_Not yet run. The runbook is §3; the orchestrator fills this section with the actual
`changeset publish` output, the nine published versions, the `SDK-3.1.0` tag, and the
`apps/quick-compat-app` typecheck re-run._

### 4.6 Still open

| # | Item | Owner |
|---|---|---|
| 1 | **The publish itself** (§4.5) and the `SDK-3.1.0` tag | orchestrator |
| 2 | **Lane A — the ALaaSv3.0 consumer update**, held until 3.1.0 is on the registry: pin both apps to `3.1.0` + regenerate both `pnpm-lock.yaml` (they still pin `2.0.4` / `2.0.7`, so a Docker build fails `ERR_PNPM_OUTDATED_LOCKFILE`), `useSMR` → `useText` (the import no longer exists), `sttPipelineId` / `batchSttPipelineId` → `sttAgentSlug` via `VITE_SDK_STT_AGENT_SLUG`, `.npmrc` token → `${GITHUB_TOKEN}` interpolation, `Dockerfile.ui` → a BuildKit secret like its sibling. Edits land uncommitted on the owner's dirty `codeSwitchImplementation` branch and are reported file by file | lane A |
| 3 | **Rotate the GitHub PAT committed in both ALaaS `.npmrc` files** (A-2 / TASK-930 Q-3). No agent can do this | **owner** |
| 4 | Cosmetic: both SDK CHANGELOGs now carry the generated `## 3.1.0` block ABOVE the file's own preamble, while their hand-written `[Unreleased]` section still holds the same 3.1.0 notes. Harmless duplication; fold `[Unreleased]` into `[3.1.0]` at the next release rather than mid-publish | next release |

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-08 (close) | §4 filled: lane K's delivered surface (NER task, `assertCredentialClass`, socket transport on the A-1 ticket shape, the codegen business plane, the `useAudioCapture` selector bug), the release mechanics that close S-1..S-4 and S-6..S-7, and the gates. Nine packages versioned to **3.1.0** at `a58b42361`; **not published** — §4.5 carries a `<!-- PUBLISH-EVIDENCE -->` placeholder for the orchestrator. Status stays `In Progress`: the publish, the `SDK-3.1.0` tag and lane A's ALaaS update are all still ahead, and the committed GitHub PAT is still the owner's to rotate. Rule 08 amended with a compact 3.1.0 block. |
| 2026-09-08 (later) | Lanes K and A killed by the account spend limit (HTTP 429) and relaunched; lane log §3.1; K carries the A-1 stream-ticket amendment. |
| 2026-09-08 | Created. Discovery findings S-1..S-7 and A-1..A-2; 3.1.0 decided (minor); lane K spawned. |
