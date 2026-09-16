# vox-node examples — runnable scripts against a live HOPE gateway

`packages/vox-node/examples`. Small, dependency-free scripts against the real `HopeClient` API.
Each file has a header comment explaining what it demonstrates and which env vars it needs. These
are illustrations, not a test suite — they call a real, running gateway and print to stdout. For
automated coverage see `packages/vox-node/src/**/__tests__/*.test.ts`
(`pnpm --filter @arcaai/vox-node test`).

## Layout

| File                            | Shows                                                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-summary.ts`                 | Stateless summary from a transcript — the 60-second quickstart                                                                                                                                                                            |
| `02-presummary-stream.ts`       | Streaming a pre-summary: iterating deltas, then `.result()`                                                                                                                                                                               |
| `03-consultation-async.ts`      | `generateAsync` + `jobs.waitFor` — the recommended pattern for long transcripts                                                                                                                                                           |
| `04-error-handling.ts`          | Catching the typed error hierarchy, including the 404-over-403 nuance                                                                                                                                                                     |
| `05-agents-and-workflows.ts`    | Invoking a published agent (including NER), streaming a workflow run over SSE and over a socket, and releasing a `core.humanReview` node                                                                                                  |
| `06-realtime-consultation.ts`   | The whole machine-driven consultation journey: open (with a typed `context`) -> record -> live summary -> stop -> release the governing workflow's review gate -> approve the summary -> close -> read the context items and the run back |
| `07-typed-open-and-refusals.ts` | Opening with a generated `OpenConsultationContext` type, and branching on every refusal `open()` can answer with                                                                                                                          |
| `08-stream-audio.ts`            | Pushing audio a server already has into a consultation over `RealtimeSttSocket`                                                                                                                                                           |
| `09-completion-signals.ts`      | The three ways to learn a run finished — hold the stream, poll, or receive the webhook — and how to verify a delivery                                                                                                                     |

## Commands

Each script reads its config from environment variables — no config file, no CLI flags.

| Command                                                                                | Effect                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------- |
| `HOPE_API_URL=http://localhost:8868 HOPE_API_KEY=<key> npx tsx examples/01-summary.ts` | Run an example directly, no build step |
| `pnpm dlx tsx examples/01-summary.ts`                                                  | Same, without a local `tsx` install    |

## How it works

`03-consultation-async.ts` additionally needs `HOPE_CONSULTATION_ID` — an existing consultation id
in your tenant, since this SDK does not create consultations on its own (see the package README's
"Two summarization families").

`05-agents-and-workflows.ts` reads two optional slugs (`HOPE_AGENT_SLUG`, `HOPE_WORKFLOW_SLUG`) and
falls back to the first published entry of each. Its human-review section runs only when you also
set `HOPE_REVIEW_NODE_ID` — a review is addressed by `(runId, nodeId)`, because one graph may carry
several. Its socket section needs Node 22 or newer: this SDK has zero runtime dependencies, so the
socket lane is `globalThis.WebSocket` and nothing else.

`06-realtime-consultation.ts` needs a SERVICE ACCOUNT (`HOPE_SVC_CLIENT_ID` / `HOPE_SVC_CLIENT_SECRET`,
not an API key — see the package README's "Two credential classes") plus `HOPE_PATIENT_ID` and
`HOPE_CLINICIAN_USER_ID`. It releases a review gate only when the governing workflow's
`reviewNodes` names one, and skips the approve/close finish gracefully when the consultation has
no summary yet.

`07-typed-open-and-refusals.ts` declares an `OpenConsultationContext` by hand so it compiles with no
generated file present; a real caller imports the one `vox-codegen --tenant` writes. It additionally
needs `HOPE_DOCTOR_STAFF_ID` and `HOPE_DEPARTMENT_CODE` — the values the tenant's schema marks as
its user-identity and department fields.

`08-stream-audio.ts` needs `HOPE_CONSULTATION_ID` (open one with `07` first) and
`HOPE_AUDIO_PCM16`, a raw PCM16 LE mono file. Like the socket half of `05`, it needs Node 22+.

`09-completion-signals.ts` runs on an API key and needs `HOPE_WORKFLOW_SLUG`; its
`handleDelivery` export is the receiver half, to be wired into your own HTTP framework with
`HOPE_WEBHOOK_SECRET`. Subscribing the webhook itself is an admin call and needs a service account —
the example's comments say which scope.

Every file here is type-checked by `pnpm --filter @arcaai/vox-node typecheck`
(`tsconfig.examples.json`), against the package SOURCE rather than a built `dist`.

### Getting an API key

- Local dev stack: keys are seeded by
  [`packages/database/src/prisma/db_main/seed/02-apikey.ts`](../../database/src/prisma/db_main/seed/02-apikey.ts).
  Read that file to find (or mint) a key for your local stack — do not paste a key value into this
  README, an example file, or any other tracked file.
- Any other environment: mint a key through the HOPE admin console's API key management screen, or
  ask your platform admin. Match the key's scopes to what you intend to call — see the package
  README's ["Required API-key scopes, per method"](../README.md#required-api-key-scopes-per-method)
  table.

## Related

- [`../README.md`](../README.md) — the `@arcaai/vox-node` package this exercises.
