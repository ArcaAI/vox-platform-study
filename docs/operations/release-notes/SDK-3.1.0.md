# Release note — `SDK-3.1.0`

| | | | |
|---|---|---|---|
| **Train** | `SDK-3.1.0` (the `@arcaai/*` npm family only — NOT a platform train) | **Date** | drafted 2026-09-08 |
| **Status** | **Versioned, not yet published** — nine packages sit at 3.1.0 on `dev-2.2` (`a58b42361`); the `changeset publish` and the tag are still ahead | **Registry** | GitHub Packages (`npm.pkg.github.com`) |
| **Tickets** | TASK-931 (the packages) · TASK-930 (the gateway surface they consume) | **Previous** | 3.0.1 (2026-09-07) |

> **How to use this file.** The `ALL-*` notes in this folder are the PLATFORM train — service
> images, promoted by digest. This one is different: the SDK family is versioned by npm SemVer and
> published from a `SDK-<ver>` tag, which the workflow-level tag rule accepts and `publish-sdk`
> keys on ([`versioning.md`](../versioning.md), `.gitlab/ci/publish.yml`). No image is built or
> promoted by this tag. The per-package detail is
> [`packages/agentic-sdk-v2/CHANGELOG.md`](../../../packages/agentic-sdk-v2/CHANGELOG.md),
> [`packages/vox-node/CHANGELOG.md`](../../../packages/vox-node/CHANGELOG.md) and
> [`packages/vox-codegen/CHANGELOG.md`](../../../packages/vox-codegen/CHANGELOG.md); this file is the
> plain-language layer over them, written for the person telling integrators what changed.

**Nothing breaks.** 3.1.0 is a MINOR release and every change is additive: a new task value, new
credential classes ACCEPTED, a new transport OPTION, new codegen flags. No export was removed and
no default changed. The R4 removals (`pipelineId` / `sttPipelineId`, the client-AI packages,
`useSttProviderToggle`, …) are **untouched** and stay for TASK-901 — deliberately, because ALaaS and
three first-party demo apps still sit on them, and a breaking release would have blocked their own
upgrade.

**One prerequisite.** Three of the four features below are halves of a gateway change (TASK-930).
Against a gateway that predates it, a NER agent cannot exist, the stream-ticket route is a 404, and
a service-account client is refused by the gateway rather than by the SDK. Upgrade the SDK when the
gateway carrying TASK-930 is deployed, not before.

---

## 1. Named entity recognition is an agent task

`AgentTask` gains `'NAMED_ENTITY_RECOGNITION'` in both SDKs, so a tenant's NER agent is listed,
typed and invoked exactly like a text-generation one:

```ts
// server — @arcaai/vox-node
const { output } = await hope.agents.invoke(slug, { text: note });
// browser — @arcaai/vox
const { output } = await invoke<NamedEntityRecognitionOutput>(slug, { text: note });
// output.entities → [{ text, label, start, end, score? }, …]
```

`NamedEntityRecognitionInput` / `NamedEntityRecognitionOutput` / `RecognizedEntity` describe the
task's DEFAULT shape. They are convenience types, **not** a constraint on `invoke`: the answer is
the agent's own `outputSchema`, and a tenant may author another.

**It is a ONE-SHOT task.** `?mode=stream` on a NER agent is a gateway **400 `MODE_UNSUPPORTED`** —
so use `invoke`, never `stream` / `invokeAndStream`. It fails rather than answering slowly, on
purpose.

The point for a tenant admin, not just an integrator: NER now names its **provider and model on the
agent row**, like every other agent. It used to be a bare `modelSlug` on a classify node, or a
platform-only routing policy the tenant could not see.

## 2. A service account can run agents and workflows

`hope.agents.*` and `hope.workflows.*` were API-key-only, and the SDK refused a service-account
client LOCALLY, before any request — because the gateway declared no service-account scope on those
routes and a 403 with no grantable scope behind it is worse than an explanation. The gateway now
declares five (`svc:agent:definition:read`, `svc:agent:invocation:write`,
`svc:workflow:definition:read`, `svc:workflow:run:read`, `svc:workflow:run:write`), so the refusal
is gone and **one client can both administer and invoke**.

Two rules are unchanged and still enforced:

- **A service-account client never sends `X-Tenant-Id`** — `workingTenantId` binds at token
  EXCHANGE. This is the one place API-key intuition misleads.
- **An API key can never reach `/admin/*`**, under any scope. That is platform policy, enforced by a
  boot audit, not an SDK convention.

The consultation-bound plane (`hope.consultations.workflows`) gained no scopes and keeps the strict
check: running a workflow that writes into a clinical record is not a machine-identity power.
`CredentialClassError` and `assertApiKeyPlane` remain exported for it.

## 3. A workflow run can stream over a WebSocket

`transport: 'sse' | 'socket'` on `streamRun` / `waitForRun` / `runAndStream` (server) and
`useWorkflowRun({ transport: 'socket' })` (browser). Same events, same terminal detection, same
return value — a one-word change at the call site.

Under it: the SDK mints a **run-scoped, single-use ticket**
(`POST /workflows/{slug}/runs/{runId}/stream-ticket` → `{ ticket, expiresAt, scope, url }`) and opens
the `url` that response returns, resolved against the client's `baseUrl` (`http(s)` → `ws(s)`). A
JWT never travels in a query string, and the ticket's scope is derived from the path rather than
taken from the caller.

**SSE stays the default, because it is the only lane that RESUMES.** A dropped socket ends the
watch — the ticket is single-use and the gateway replays nothing — where SSE reconnects with
`Last-Event-ID` and loses no frames. Reach for `socket` when something between you and the gateway
buffers `text/event-stream` (the symptom is a run that looks stalled and then completes all at once),
or when a socket is the per-tab connection budget you already hold.

`@arcaai/vox-node` is **still zero-runtime-dependency**: the socket is `globalThis.WebSocket`, which
means **Node 22 or newer**. On an older runtime it throws `SocketUnavailableError` naming that floor
rather than importing a polyfill you did not ask for — and never falls back silently to the
transport you just ruled out.

## 4. `@arcaai/vox-codegen` types what a tenant PUBLISHES

A second, mutually exclusive mode alongside the existing consultation-context-schema one:

```
npx @arcaai/vox-codegen --api-key <key> --base-url <url> --agents --workflows --out ./generated
```

It reads `GET /agents`, `GET /agents/{slug}`, `GET /workflows` and `GET /workflows/{slug}/schema`
with `X-API-Key` and emits `Agent_<Slug>_Input` / `Agent_<Slug>_Output`,
`Workflow_<Slug>_Input` / `Workflow_<Slug>_Output` and slug-keyed contract maps, through the same
JSON-Schema-subset transpiler. **It never calls an admin route** — an API key cannot, and what a
tenant publishes is exactly what an integrator needs to type.

`HOPE_API_KEY` is read as the fallback for `--api-key`, because a key passed on argv is visible in
`ps`. The `--tenant <id> --token <jwt>` mode is unchanged, still the default and still the only mode
supporting `--watch`; mixing an API key with `--tenant` is a refusal, not a guess.

The package also **leaves the Changesets `ignore` list** and joins the publish build list, so it is
versioned and published with the family instead of by hand.

---

## 5. Fixes worth naming

| Fix | Why it mattered |
|---|---|
| **`useAudioCapture` reads `sttAgentSlug`** | `V1SdkConfig` gained `sttAgentSlug` when the ASR Agent replaced the pipeline, and `mapV1ConfigToV2` preferred it — but the compat capture hook read `sttPipelineId` and nothing else. A compat app that had moved to the agent slug AND drove capture from this hook started its session with **no selector at all** and silently ran the tenant default |
| **`SDK_VERSION` is derived from `package.json`** | It was a hand-maintained literal reading `3.0.0` while the package was `3.0.1`, so every request from the shipped SDK announced the wrong version in `User-Agent` — discoverable only mid-incident, while correlating SDK versions in gateway logs |
| **The CI publish job targets the right registry** | It wrote an `.npmrc` for the GitLab Package Registry, but `changeset publish` honours each package's own `publishConfig.registry`, which is GitHub Packages in every publishable manifest. The job could never have published |
| **The admin surface is 49 areas, not 52** | `ai-task-defaults`, `pipeline-policy` and `tenant-tts-config` left with the routes they wrapped. Corrected in the README, `src/index.ts` and the SDK rule |
| **`vox-node-gateway-gaps.md` G3 closed** | "Webhooks never fire" — delivery shipped in TASK-890 |

New example: `examples/05-agents-and-workflows.ts` runs an agent, streams a workflow and releases a
human-review node end to end.

## 6. Packages in this release

All nine move `3.0.1` → `3.1.0`. The eight-package `fixed` group moves in lockstep by
configuration; `@arcaai/vox-codegen` joins them for the first time.

| Package | Note |
|---|---|
| `@arcaai/vox` | browser SDK — NER task, socket transport, the compat capture fix |
| `@arcaai/vox-node` | server SDK — NER task, service-account invocation plane, socket transport, `SDK_VERSION` |
| `@arcaai/vox-codegen` | the business-plane mode; first release under the family's versioning |
| `@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/med-ner`, `@arcaai/pipeline` | linked-group bumps, no functional change (four of them are deprecated and removed in R4) |

`@arcaai/vox-node-codegen` stays `private: true` and is not published — it generates `hope.admin.*`
from the gateway route manifest and has nothing to do with tenant schemas.

## 7. Upgrading

1. Bump the dependency to `3.1.0` and **regenerate the lockfile** — a stale lockfile is the failure
   mode here (`ERR_PNPM_OUTDATED_LOCKFILE` in a Docker build, not at install time locally).
2. Nothing else is required. Adopt §1–§4 when you want them.
3. If you are still passing `sttPipelineId` / `batchSttPipelineId`, move to `sttAgentSlug` now. It
   still works, and it is removed in R4.
4. `@arcaai/vox` needs React `^18.3.0 || ^19.0.4`; `@arcaai/vox-node` needs **Node ≥ 22** for the
   socket transport (≥ 22 was already the floor).

## 8. Not in this release

- **The publish itself.** The nine packages are versioned and green; nothing is on the registry yet.
  `apps/quick-compat-app`'s typecheck cannot run until it is, because it installs the published
  package.
- **The ALaaSv3.0 consumer update** (TASK-931 lane A), which follows the publish.
- **The R4 removals**, which are TASK-901's.
