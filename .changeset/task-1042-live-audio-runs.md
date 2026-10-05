---
'@arcaai/vox-node': minor
'@arcaai/vox': minor
---

TASK-1042 — live audio into a standalone workflow run.

- `@arcaai/vox-node`: `hope.workflows.runWithAudio(...)` opens a workflow-bound STT session (`CreateStreamSessionRequest.workflowSlug`), starts the run with `input.<audioField>.sttSessionId`, streams the audio, and finalizes the session (an already-ended session's 404 is tolerated). Ending the audio never cancels the run.
- `@arcaai/vox`: `useRunAudio({ workflow, audioField? })` runs standalone when no consultation is open; `audio.start({ workflowSlug })` passes the workflow to the STT session create; `RunAudioFieldError` is exported from `@arcaai/vox/plugins`.
