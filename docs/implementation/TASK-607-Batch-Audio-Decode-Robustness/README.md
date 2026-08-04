# TASK-607 — Robust Audio Decoding for Batch Transcription

| Field | Value |
|---|---|
| **Status** | Completed |
| **Type** | bugfix |
| **Created** | 2026-08-04 |
| **Owner** | Tap Huynh |
| **Branch** | `dev-2.1` |
| **Related** | TASK-603 (compat batch upload), TASK-604 (vox batch queue) |

## Requirement Analysis

A batch MP3 upload failed with an opaque error and burned four worker attempts:

```json
{"type":"error","data":{"jobId":"019fcb2d-…","errorCode":"TRANSCRIPTION_ERROR",
 "message":"Transcription failed: Unspecified internal error."}}
```

Requirement: uploaded audio for batch transcription must be handled properly —
decode what is decodable, fail clearly and once when it is not.

## Current State Evaluation

### Root cause

`SDK_ORTHO.mp3` is an OPPO/ColorOS phone recording. The recorder appends a
proprietary trailer **after** the last MPEG frame:

| Region | Bytes | Content |
|---|---|---|
| Audio | 0 – 10,666,126 | Valid MPEG frames — 266.7 s, 48 kHz stereo, 320 kbps |
| Trailer | 10,666,127 – 10,680,565 | `oppoMark//oppoMark`, ~14.3 KB ASCII waveform peaks (`0,0,0,0,533,910,…`), then binary `mark` blocks |

libsndfile 1.2.2's mpg123 backend parses the trailer as audio, fails to resync
(`Giving up resync after 1024 bytes`), and raises
`LibsndfileError: Unspecified internal error`. **The audio itself was intact.**

### Three defects, verified against the real file

1. **`preprocessing._load_audio` had no working fallback** — it caught only
   `ImportError`, so the librosa branch was dead code for decode errors. librosa
   would not have helped anyway: it goes through soundfile and fails identically.
2. **The failure was classified as retryable** — `batch_service.transcribe`
   wrapped every exception in `TranscriptionError`, which is absent from
   `NON_RETRYABLE_EXCEPTIONS`, so dramatiq retried a file that can never decode
   (`"will_retry": true`, 3 retries).
3. **Decoder jargon reached the user** — "Unspecified internal error" is
   meaningless to whoever uploaded the file.

`voice_profile/api/routes.py` carried the same bare `sf.read` and the same
exposure.

### Decoder comparison (measured on the real 10.7 MB file)

| Decoder | Result |
|---|---|
| `sf.read` (the code path that failed) | ❌ `LibsndfileError` |
| `librosa.load` (intended fallback) | ❌ same error |
| `sf.SoundFile` block read | ⚠️ 262.1 s — silently drops the last 4.5 s |
| PyAV | ⚠️ 266.66 s then raises at the trailer |
| **ffmpeg → WAV pipe** | ✅ **266.66 s, exit 0, 0.5 s** |

ffmpeg was chosen: it recovers the full stream, is already provisioned in both
environments (`scripts/setup-python-env.sh:419` conda `ffmpeg>=6.1,<7`;
`apps/stt/docker/Dockerfile:303,334` `apt-get install … ffmpeg`), and adds
m4a/aac/opus coverage that libsndfile lacks — relevant for phone uploads.
PyAV was rejected: it is only a transitive lock entry, and it drops the tail.

## Implementation Plan

1. New `stt/transcription/audio_decode.py` — two-stage `decode_audio()`:
   libsndfile first (fast, exact), ffmpeg second (error-resilient), then
   `AudioCorruptedError`.
2. `preprocessing._load_audio` delegates to it.
3. `batch_service` stops re-wrapping non-retryable exceptions.
4. `transcribe_file` gains an `AudioProcessingError` clause carrying the
   exception's own `error_code`.
5. `voice_profile` route uses the same decoder.

## Implementation Summary

### Files changed

| File | Change |
|---|---|
| `apps/stt/src/stt/transcription/audio_decode.py` | **NEW** — `decode_audio()`: libsndfile → ffmpeg → `AudioCorruptedError`. WAV output preserves native rate/layout; 300 s subprocess timeout; recovered-from-damage decodes log a warning |
| `apps/stt/src/stt/transcription/preprocessing.py` | `_load_audio` delegates to `decode_audio`; dead librosa/ImportError branch removed |
| `apps/stt/src/stt/transcription/batch_service.py` | Re-raise `NON_RETRYABLE_EXCEPTIONS` instead of wrapping them in `TranscriptionError` |
| `apps/stt/src/stt/transcription/workers/transcribe_file.py` | New `except AudioProcessingError` → fails the job with `AUDIO_CORRUPTED` / `AUDIO_FORMAT_ERROR`, no retry |
| `apps/stt/src/stt/voice_profile/api/routes.py` | Uses `decode_audio`; orphaned `io`/`soundfile` imports removed |
| `apps/stt/tests/unit/test_audio_decode.py` | **NEW** — 9 tests |
| `apps/stt/tests/unit/test_transcribe_file_audio_errors.py` | **NEW** — 2 tests |
| `apps/stt/tests/unit/test_batch_service.py` | +1 retry-classification test |

### Behavior change

| | Before | After |
|---|---|---|
| Vendor-trailer MP3 | job fails | transcribes (full 266.7 s) |
| Undecodable file | 4 attempts, `TRANSCRIPTION_ERROR` | 1 attempt, `AUDIO_CORRUPTED` |
| Client message | "Unspecified internal error." | "Audio file could not be decoded. The format is unsupported or the file is damaged." |
| m4a / aac / opus uploads | rejected | decode via ffmpeg |

Decoder wording is kept in `AudioCorruptedError.details` for operators.
No gateway change was needed — `errorCode` on the internal `/fail` DTO
(`internal.request.ts:193`) is a free-form validated string.

### Regression fixture — PHI-safe

`test_audio_decode.py` synthesizes a tone, encodes it to MP3 with ffmpeg, and
appends a byte-shaped replica of the OPPO trailer. The failure is covered
without committing a clinical recording. ffmpeg-dependent tests self-skip when
ffmpeg is absent.

## Verification

```
pytest tests/unit                                   2685 passed in 27.33s
pytest tests/unit/test_audio_decode.py                 9 passed
pytest tests/unit/test_transcribe_file_audio_errors.py 2 passed
pytest tests/unit/test_batch_service.py              129 passed
ruff check src/stt tests/unit/test_audio_decode.py …  All checks passed!
mypy audio_decode.py preprocessing.py routes.py       Success: no issues
```

Live check against the original failing object
(`s3://hope-recordings-arcaai/2026/08/jobs/019fcb2d-…/raw/SDK_ORTHO.mp3`):

```
INFO  libsndfile could not decode the upload (LibsndfileError: Unspecified
      internal error.) — retrying with ffmpeg
WARN  Audio decoded by ffmpeg after libsndfile failed; input reported errors
      (266.7s recovered): [mp3float] Header missing
>>> decode_audio: shape=(12799872, 2) sr=48000 dur=266.66s in 0.66s
>>> preprocess:   sr=16000 dur=266.66s samples=4266624 in 1.99s
```

Each RED phase was observed before its fix: `ModuleNotFoundError` for the new
module, `TranscriptionError` raised where `AudioCorruptedError` was expected,
and `INTERNAL_ERROR` where `AUDIO_CORRUPTED` was expected.

## Change History

| Date | Change |
|---|---|
| 2026-08-04 | Root cause identified (OPPO trailer + `ImportError`-only fallback); decoder comparison run; fix implemented TDD across 5 source files; all gates green |
