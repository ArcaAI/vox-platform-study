---
'@arcaai/vox-node': major
'@arcaai/vox': major
---

TASK-1039 — one run handle, one protocol (run protocol v2, TASK-1038).

**`@arcaai/vox-node`**

- **Breaking:** `hope.workflows.run(slug, input, options?)` and `hope.agents.run(slug, input, options?)` now start a run and return a `RunHandle<TOutput>`. `input` is the workflow's input object itself (an agent's flat `{ text, context?, variables? }`), no longer wrapped in `{ input }`. The pre-5.0 `run()` (the bare 202 body) is now `start()`.
- `RunHandle`: `runId`, `kind`, `slug`, `joined`, `text({ field?, nodeId? })`, `events({ after?, autoResume? })` (typed protocol-v2 events, resume by `seq`, honours `run.resync`, never infers loss from a `seq` gap), `result()` (inline or a signed ref whose sha256 is checked; `null` when nothing was delivered; `RunFailedError` when the run did not complete), `wait({ poll?, intervalMs? })` → `RunOutcome`, idempotent `cancel()`, `status`, `lastSeq`, `outcome`. Breaking out of a loop, aborting or losing the connection never cancels a run.
- `hope.workflows.attach(slug, runId)` / `hope.agents.attach(slug, runId)` pick a run up by id without a request.
- Every start sends an `Idempotency-Key` (`options.idempotencyKey`, else a fresh UUIDv7); the same key joins the run in flight (`joined === true`).
- A normaliser maps the legacy workflow frame shapes onto protocol-v2 events for one release.
- `start()`, `runAndWait()`, `runAndStream()`, `streamRun()` and `waitForRun()` stay in 5.x, marked `@deprecated` where `RunHandle` supersedes them.

**`@arcaai/vox`**

- `useRun({ workflow | agent })` → `{ start, text, events, result, status, runId, lastSeq, cancel, error }`: Idempotency-Key on every start, protocol v2 over a run-scoped ticket (workflow) or a header-authenticated fetch stream (agent), resume on drop and on mount, `run.resync`, result via the result route. Exported from `@arcaai/vox/core`.
- `useRunAudio` (from `@arcaai/vox/plugins`) composes `useArcaAudio` + `useRun`: microphone and STT session first, run second.
- `useConsultationJob` mints the `consultation_job:<jobId>` ticket scope and reads the full-status named frames.
- `useWorkflowRun` is `@deprecated` for single runs. `AgenticClient.requestRaw` returns an unparsed `Response`. `AgentCompiledConfig.resolvedPrompt` carries prompt `variables` declarations.
