# BUG-369: Live Transcription Stoppage After ~4 Minutes And "Unknown" Content On Low Mic Gain

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix (realtime ASR reliability) + product guidance (input level) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/369 (ArcaAI/ALaaSv3.0) |
| **Severity** | High (intermittent loss of most of a consultation's transcript) |
| **Classification** | Two defects. (A) stoppage: transport/engine fault, largely addressed after the issue date (TASK-1003); (B) "Unknown" on low gain: input-level limitation, partly mitigated, no user-facing guard |
| **Still applicable on dev-2.2?** | (A) probably fixed; needs a >20 min live soak on the current stack. (B) partly: a gain ceiling exists but nothing warns the clinician or the integrator. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Pilot (Gastroenterology). Two symptoms on the v1-era client SDK (console lines show `[TRANSCRIPT_EVENT] ... Guest-1`, `Metadata: {device_id, role, other: 'mic16_chunkNN_...'}`, `[SEND_AUDIO] ... chunkId=...`):

1. **Unknown content:** when mic gain is decreased (tested from ~75 down to 20) the transcript turns into `Unknown:` finals with empty text (one event: `Unknown:  Final: true`). When gain is raised the transcript is correct. Silence at start/middle/end did not block transcription. Hypothesis in the issue: low gain => "unknown".
2. **Stoppage:** in a 21.15 min conversation the Live Transcript panel stopped receiving text after about 4 minutes although audio chunks kept being sent (up to chunk 36 shown). A summary was still produced from the first 4 minutes. Intermittent: reproduced twice, a later attempt produced a full transcript.

Requirement: the transcript must keep flowing for the whole consultation, and insufficient input level must not silently produce "Unknown"/empty content.

## 2. Current State Evaluation

**Architecture change since filing.** The `Guest-1` / `chunkId` / `device_id` client protocol is the retired v1 SDK path (compat plane removed by TASK-1004/TASK-1006). The current path is the streaming socket: Redis-streamed PCM -> `apps/stt` -> `transcript` frames with `seq`, `utteranceIndex`, `speakerLabel`, `metadata` (`packages/vox-node/src/types/stt.ts:253-300`). There is no per-chunk transcript concept to stall on.

**(A) Stoppage.** Candidate mechanisms and their status:
- Reconnect storms / parallel STT sessions after a tunnel drop splitting a transcript across sessions (TASK-1003 F-1/F-2, README lines 86-90), tail frames dropped when stop is signalled out of band (F-9, line 123). Fixed and deployed 2026-09-24.
- Engine returns empty segments persistently because the whisper.cpp context is poisoned: not silence, an engine fault. `session_manager.py:130-149` counts consecutive empty decodes whose input carried speech (RMS >= 0.01 against a pre-normalisation figure) and arms the fallback engine. Without a declared fallback the stoppage would persist.
- Stale Redis session bundles poisoning restarts (memory note TASK-935) and the whisper.cpp prompt-hotword regression (TASK-946) were fixed earlier.
- Intermittency matches a transport/engine race rather than a deterministic rule.
No HOPE code was found that stops emitting transcript after a fixed time (no 4-minute timer; ticket TTL logic only applies to the single-use handshake ticket).

**(B) Low gain.**
- Preprocessor peak-normalises each utterance with a bounded 3 s causal window and a gain ceiling of 20x (`apps/stt/src/stt/streaming/preprocessor.py:95-103`, `_NORMALIZER_MIN_PEAK = 0.05`). A mic whose raw peak is below 0.05/20 of full scale is therefore still too quiet after normalisation, and the VAD / ASR see mostly noise. That is consistent with "works at gain 75, fails at gain 20".
- The pre-VAD noise-floor veto is off by default (`preprocessor.py:104-110`, TASK-985).
- `Unknown` with empty text is a speaker label on an empty final. Current speaker labelling is `speakerLabel` from diarization or the declared `metadata`; an empty-text final should not be emitted to consumers (not verified; see plan step 3).
- The SDK exposes audio-level types (`packages/agentic-sdk-v2/src/types/audio.ts`) but no documented "input too quiet" signal; the server emits none. Integrators cannot warn the clinician.

## 3. Root Cause

(A) Most probably the same family as TASK-1003 (transport + session race, possibly a poisoned engine context with no fallback): resolved or mitigated since the issue date, unproven on a long soak. (B) Physical input level below what normalisation can recover; HOPE does not detect or report it.

## 4. Implementation Plan

Verification, then one small feature.

1. **Soak (no code):** a >=25 min live session via the broker with a quiet segment mid-way; watch `session_manager` logs for empty-decode streaks, `frame_dropped_after_finalizing`, resume events. Pass: transcript continues past 4 and 21 minutes. (Owner approval required for any model load; use the resident agent.)
2. **Test first (B):** in `apps/stt/tests/` a unit test feeding synthetic speech at -50 dBFS, -40, -30 through the preprocessor and asserting (i) the utterance is either transcribed or flagged `low_input_level`, never emitted as an empty final. RED expected for the flag.
3. **Implementation (small):** emit one rate-limited `status` frame / warning `low_input_level` when a session's pre-normalisation RMS stays below a floor for N seconds while the VAD never opens (threshold from the agent's `audioFrontEnd` settings, not a literal; configuration rule: no hardcoded thresholds). Drop empty-text finals before they reach the socket if they are not already dropped (verify at the emission point near `session_manager.py:4279-4334`).
4. Surface the status in `RealtimeSttSocket` (`status` event) and `useArcaAudio`; document in the integration guide.
5. Verification: STT unit file(s) only, then the owner-run e2e.

## 5. Risks and Open Questions

- OQ-1 (owner): is a server-side "input too quiet" status wanted, or is this an onboarding/operational issue (mic gain setup per room)? 
- OQ-2: the 2025-12 build differs from today's; the soak is the only honest proof for (A).
- Risk: a low-level status must not fire during genuine silence (patient not speaking); gate on "audio present but below floor", not on silence.
- Risk: threshold is configuration (agent `audioFrontEnd`), needs the config-tier decision per the HOPE configuration principles.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0 #369 (read-and-document lane); no code changed. |
