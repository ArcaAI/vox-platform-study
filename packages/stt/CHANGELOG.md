# @arcaai/stt

## 3.6.0

### Patch Changes

- @arcaai/room@3.6.0

## 3.5.0

### Patch Changes

- @arcaai/room@3.5.0

## 3.3.0

### Minor Changes

- TASK-951 — the ArcaAI realtime contract on the SDKs.

  - `hope.stt.createStreamSession({ context })` (vox-node) / the stream-session request (vox): a client-declared session context (≤ 4 KB), validated against the ASR agent's frozen context schema and echoed VERBATIM on every transcript of that session together with `sessionEpochMs`.
  - `RealtimeSttSocket.setMetadata(value)` (vox-node) and `SttWebSocketClient.setMetadata(value)` (vox): declare the metadata in force from the current point of the audio onward — one microphone at a time, sticky until the next declaration, no timestamp. Every transcript then carries `metadata` (the flat object in force over its audio, e.g. `{ mic_id: '2' }`) and `metadataSpans` (`SttMetadataSpan[]` / `WsMetadataSpan[]`, the exact bounds clipped to the segment). Refusals arrive on the error channel — `METADATA_TOO_LARGE`, `METADATA_INVALID`, `METADATA_SCHEMA_VIOLATION` with `problems` — and never end the session.
  - `@arcaai/vox-codegen`: the context-schema marker roles (`userIdentity`, `department`, `visitType`, `externalRef`, `materializeAs`, `streamContext`) are emitted as documentation tags on the generated kind types.

### Patch Changes

- Updated dependencies
  - @arcaai/room@3.3.0

## 3.2.0

### Patch Changes

- @arcaai/room@3.2.0

## 3.1.0

### Patch Changes

- @arcaai/room@3.1.0
