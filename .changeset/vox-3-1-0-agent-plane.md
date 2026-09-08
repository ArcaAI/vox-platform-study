---
'@arcaai/vox': minor
---

**The browser SDK follows the platform onto the agent/workflow plane (3.1.0).**

**Named entity recognition is a first-class agent task.** `AgentTask` gains
`'NAMED_ENTITY_RECOGNITION'`, `AGENT_ENDPOINTS.LIST` accepts it, and
`useAgentInvocation().invoke(slug, { text })` calls a NER agent the same way it calls a
text-generation one — the shape of the answer is the agent's own `outputSchema`
(`{ entities: [{ text, label, start, end, score? }] }` by default), not a second method.
`NamedEntityRecognitionInput` / `NamedEntityRecognitionOutput` / `RecognizedEntity` are
exported for the default shape; an agent whose tenant authored a different schema is still
yours to type. NER is a ONE-SHOT task: `?mode=stream` on a NER agent is a 400
(`MODE_UNSUPPORTED`) at the gateway, so use `invoke`, never `stream`.

**`useWorkflowRun({ transport: 'socket' })`.** The run stream can now be read over a
WebSocket instead of SSE. The hook mints a run-scoped, single-use ticket
(`POST /workflows/:slug/runs/:runId/stream-ticket`) and opens the `url` the response returns
— never a JWT in a query string. Event shape, resume cursor, terminal detection and
`stopWatching()` are identical to the SSE lane, so this is a one-word change at the call
site. SSE stays the default: it resumes with `Last-Event-ID`, which a socket lane cannot.
Pick `socket` when a proxy in front of you buffers `text/event-stream` (the failure mode is
a run that looks stalled and then completes all at once) or when you already hold a socket
budget per tab. `SocketUnavailableError` names the missing global rather than silently
falling back — a silent fallback would hide the proxy problem you switched transports to
solve.

**First-party demo apps move `sttPipelineId` → `sttAgentSlug`.** The compat adapter already
preferred the agent slug; the five remaining call sites in `apps/example`,
`apps/compat-playground` and `apps/quick-compat-app` no longer pass the deprecated key.
`sttPipelineId` itself is unchanged and still accepted (removed in R4).
