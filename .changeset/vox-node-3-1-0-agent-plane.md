---
'@arcaai/vox-node': minor
---

**A service account can now run agents and workflows, NER is a task, and a run stream can
be a socket (3.1.0).**

**The invocation plane accepts both credential classes.** `hope.agents.*` and
`hope.workflows.*` were API-key-only: every method called `assertApiKeyPlane`, so a client
constructed with a service account was refused locally. The gateway now declares
service-account scopes for those routes (`svc:agent:definition:read`,
`svc:agent:invocation:write`, `svc:workflow:definition:read`, `svc:workflow:run:read`,
`svc:workflow:run:write`), so the local refusal is gone and ONE client can both administer
and invoke. The rule that made the refusal necessary is unchanged and still enforced at
construction: a service-account client never sends `X-Tenant-Id`, because `workingTenantId`
binds at token EXCHANGE. The admin plane is still service-account only, and an API key still
cannot reach `/admin/*` under any scope.

**Named entity recognition.** `AgentTask` gains `'NAMED_ENTITY_RECOGNITION'`, so
`hope.agents.list({ task: 'NAMED_ENTITY_RECOGNITION' })` types, and `invoke` returns the
agent's entities. `NamedEntityRecognitionInput` / `NamedEntityRecognitionOutput` /
`RecognizedEntity` describe the default schema. It is a one-shot task — `invokeAndStream`
on a NER agent is a gateway 400, not a slower answer.

**`transport: 'socket'` on `streamRun` / `waitForRun` / `runAndStream`.** Mints a run-scoped
single-use ticket (`POST /workflows/{slug}/runs/{runId}/stream-ticket`) and reads the run's
events over `globalThis.WebSocket`, resolving the ticket's `url` against the client's
`baseUrl` (`http(s)` → `ws(s)`). Same events, same terminal detection, same
`waitForRun` return. **Still zero runtime dependencies**: the socket is the platform global,
which means Node **22 or newer**. On a runtime without it the SDK throws
`SocketUnavailableError` naming that floor instead of importing a polyfill you did not ask
for. SSE remains the default and the only lane that RESUMES — a dropped socket ends the
iteration, where SSE reconnects with `Last-Event-ID`.

**`SDK_VERSION` is derived from `package.json` at build time.** It was a hand-maintained
literal and had already drifted, so every request from the shipped SDK announced the wrong
version in `User-Agent` — discoverable only mid-incident, while correlating SDK versions in
gateway logs.

**Docs.** The generated `hope.admin.*` surface is **49 areas**, not the 52 the 3.0.1 notes
and the README claimed (three areas left with the routes they wrapped: `ai-task-defaults`,
`pipeline-policy`, `tenant-tts-config`). `docs/architecture/vox-node-gateway-gaps.md` G3
("webhooks never fire") is closed — delivery shipped in TASK-890. New example
`examples/05-agents-and-workflows.ts` runs an agent, streams a workflow and releases a
human-review node end to end.
