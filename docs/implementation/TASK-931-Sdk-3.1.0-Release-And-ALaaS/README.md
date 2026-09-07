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

_Pending._

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-08 (later) | Lanes K and A killed by the account spend limit (HTTP 429) and relaunched; lane log §3.1; K carries the A-1 stream-ticket amendment. |
| 2026-09-08 | Created. Discovery findings S-1..S-7 and A-1..A-2; 3.1.0 decided (minor); lane K spawned. |
