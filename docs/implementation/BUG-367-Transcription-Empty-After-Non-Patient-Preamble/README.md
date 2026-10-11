# BUG-367: Empty Transcript After A Long Non-Patient Preamble

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix (live capture reliability; possibly operational) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/367 (ArcaAI/ALaaSv3.0) |
| **Severity** | High (no note produced for a real consultation) |
| **Classification** | Probably superseded code defects in capture/transport (TASK-1003) + unproven hypothesis in the issue; no HOPE rule about "off-topic" audio exists |
| **Still applicable on dev-2.2?** | Unverified. The issue's own hypothesis (a 9 min 29 s third-party conversation "interferes" with the logic) has no counterpart in HOPE code; the empty-transcript symptom matches defects TASK-1003 / TASK-1048 fixed. Needs a replay of the two WAVs before closing. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Filed from CLINICAL HAEMATOLOGY (RACTHAM): a 25-minute consultation produced an EMPTY generated transcript. The recordings (doctor mic `..._BY-V_Doctor_...wav`, patient mic `..._Samson Meteorite Mic_Patient_...wav`, shared on a Drive folder named in the issue) start with about 9 min 29 s of the doctor talking to a third party before the patient is called. Audio is "clear". A manual re-upload of the same audio produced no summary, which the reporter reads as confirmation that the lack of transcript content prevents a summary.

Requirement as stated: the consultation transcript must capture the conversation; a long non-patient preamble must not make the transcript empty.

## 2. Current State Evaluation

- HOPE has no notion of a "preamble" or "non-patient speech". Live ASR (`apps/stt/src/stt/streaming/session_manager.py`) segments speech with VAD and decodes every utterance; the third-party talk would be transcribed like any other speech, not suppressed. Nothing in `packages/applications` or `apps/harness` drops early transcript on the grounds that it is off-topic. So the issue's causal hypothesis has no code path to match it.
- An EMPTY transcript has other documented causes, each already addressed after the issue date (2025-11, ALaaS pilot on the v1 client SDK):
  - Realtime transport faults: tunnel QUIC drops, two reconnect mechanisms racing and splitting a transcript across sessions, audio sent before the socket opens being dropped, and tail frames dropped at stop (TASK-1003 F-1..F-9, `docs/implementation/TASK-1003-Realtime-Consultation-Transport-And-Finalization-Reliability/README.md` lines 78-125, merged and deployed 2026-09-24).
  - A poisoned whisper.cpp context returning empty segments while the room is not silent: session-level empty-decode streak arms the fallback engine (`session_manager.py:140` `_EMPTY_DECODE_FAILURE_STREAK = 3`, `:149` `_EMPTY_DECODE_SPEECH_RMS_FLOOR = 0.01`).
  - Session refused at start (409) because an optional stage was misconfigured: fixed by TASK-1048 (optional ASR stages degrade, never refuse).
- The v1 "recordings via per-mic WAV" capture shape the issue describes (two files named by mic role) is the v1-era ALaaS client. The current ALaaS path is a broker on `@arcaai/vox-node` driving `hope.stt.*` / `RealtimeSttSocket` (`packages/vox-node/src/types/stt.ts:253`), so the reproduction environment no longer exists as filed.
- No requirement for "reprocessing returned no summary" is a defect: HOPE refuses a summary with nothing to summarise (consistent with the issue's own validation note).

## 3. Root Cause

Not established. Ranked candidates: (1) capture/transport loss on the broker or tunnel (fixed in TASK-1003), (2) low mic level on the doctor/patient channels (see BUG-369), (3) session never started/refused (TASK-1048). The issue's hypothesis (long off-topic intro "interfering with transcription/summary logic") is not supported by any HOPE logic and should be treated as unproven.

## 4. Implementation Plan

Verification first; code only if the replay reproduces.

1. Obtain the two WAVs from the issue's Drive folder (owner action; PHI, do not copy into the repo).
2. Replay both through the streaming path (realtime socket, agent chosen by the department) and through the batch route (`transcription-jobs`) on the dev cluster. Do NOT load or swap any model without owner approval (standing owner rule); use the already-resident ASR agent.
3. Decision tree:
   - transcript present on replay -> close as not reproducible on dev-2.2 / superseded by TASK-1003; record evidence.
   - transcript empty on batch too -> inspect the STT logs for VAD segmentation of the first 9.5 minutes (empty-decode streak, RMS floor), and the per-channel input level (BUG-369).
4. If a defect is found: TDD with an STT unit/integration test using a synthetic long non-speech/third-party lead-in followed by speech (`apps/stt/tests/`), run with `~/miniconda3/envs/arcaenv/bin/python -m pytest <file>` (sandbox note: `conda run` is broken).

## 5. Risks and Open Questions

- OQ-1: Which ALaaS build / SDK version produced the issue (date 2025-11)? If it predates the broker architecture, close as obsolete.
- OQ-2: Was the second (patient) mic channel silent or low level? The issue only says the audio is clear on playback.
- Risk: replaying PHI audio; keep it local and out of git.
- Owner decision needed only if the replay shows a real defect in VAD gating (e.g. a lead-in suppression rule).

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0 #367 (read-and-document lane); no code changed. |
