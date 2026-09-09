# TASK-938 — ASR decode config revert, and the language declaration that never reached the decoder

| | |
|---|---|
| **Status** | `Review` — R-1 and R-3 done and proven live; R-2 applied to code + dev DB, but its VERDICT needs the owner's microphone A/B (this ticket changes decode quality; nothing here measures real speech) |
| **Branch** | `dev-2.2` |
| **Classification** | `bugfix` (the language clobber) + `infrastructure` (decode-config revert / live A/B) |
| **Owner request** | 2026-09-09: *"lets update to: \<table\> … then, fix the language clobber and retest with English pinned, i want to know why selecting language on the admin console doesnt take effect"* — after live consultation- and live-transcription-playground sessions produced Malayalam with English selected. |
| **Related** | TASK-934 (per-model ASR profile, the `{7,15}` geometry), TASK-935 (lexicon stage, hotword removal from the prompt), TASK-891 (language declaration, priming-prompt kill-switches, word-split guard), TASK-930 (agent primary → q8_0), TASK-937 R-4 (per-model `hotwordsInPrompt`, still open) |

---

## 1. Requirement Analysis

| Id | Requirement | Kind |
|---|---|---|
| R-1 | An explicitly declared `language` must reach the decoder on the AGENT path. Today it cannot: `create_session` backfills `language_mode` from the agent's own spec whenever the caller omits one, so `_session_language_modes` is never empty and `_load_asr_pipeline` resolves that mode over the declaration | bugfix |
| R-2 | Move the decode configuration to the owner's table (below): f16 weights, `partialWindowSec` 6, `wordTimestamps` true, hotwords in the whisper prompt, both priming-prompt switches on | infrastructure |
| R-3 | Prove R-1 on the live stack — a declared `en` session logs `language=en`, an undeclared one still logs `language=None` | verification |
| R-4 | The consultation playground must offer ONE auto option, not two that read alike and behave differently | bugfix (console) |

## 2. Current State Evaluation (measured 2026-09-09, before any change)

Both of the owner's sessions were still in Redis and both decoded **unpinned**:

| Session | Screen | Persisted `language_mode` | Logged decoder language |
|---|---|---|---|
| `01a08698…` (198 s) | Consultation playground | `auto` | `null` |
| `01a0869d…` (37 s) | Live Transcription | `ml-en` | `null` |

```
{"model_slug":"arcaai-whisper-large-ml-en-gguf-q8_0","language":null,
 "event":"ASR pipeline loaded for streaming session"}
```

Resolved against the live build (`resolve_mode_for_engine`, `WHISPER_CPP`):

```
en     -> language='en'    ml-en  -> language=None
ml     -> language='ml'    auto   -> language=None
pair prompt enabled: False   single prompt enabled: False
```

So a code-switch pair pins nothing **and** (both switches off) carried no prompt either — the
decoder had no language signal at all and re-ran its own LID on every decode window. That is the
Malayalam. The module's own comment names the symptom: *"the measured 'half Malayalam, half
English inside one sentence'"*.

### Why the console's Language picker was inert

The Live Transcription screen's picker (added the same day, TASK-932 `6d10facf0`) sends
`language: "en"`. `create_session` applies it to `pipeline_config.inference.language`, and
`_load_asr_pipeline` then overwrites it:

```python
mode_id = self._session_language_modes.get(session_id)   # always set
if mode_id:
    inference_config.language = resolve_mode_for_engine(mode_id, fmt).language   # -> None
```

`languageMode` is documented as taking precedence over `language`, and that is right — but the
backfill made a mode the SPEC supplied indistinguishable from one the CALLER declared, so
`language` could never win on any agent-path session. **Pre-existing since TASK-861**; it only
became visible when TASK-932 shipped a control that uses the `language` half.

The consultation playground sends the correct field (`languageMode`) and does work — the owner's
run sent `auto`, which resolves to the same unpinned decode. Note its picker offers **two** auto
entries: `ScribeFooter` prepends its own `__auto__` ("Auto (code-switch)", sends nothing) while
the backend catalogue already contains `auto` ("Auto-detect"). Not fixed here; see §6.

## 3. Decisions taken (owner may override)

| Id | Decision |
|---|---|
| D-1 | **Promote, don't special-case.** A bare `language` that names a catalog mode (`en`/`ml`/`vi`/`auto` — exactly the vocabulary the field is documented with) becomes that `language_mode`. One concept downstream: it persists on `SessionMetadata`, survives recovery (TASK-891 A2), is checked against the engine capability matrix (422), and picks up the mode's priming prompt. A non-catalog language (e.g. `de`) sets no mode, which is what stops the resolution overwriting the raw pin. |
| D-2 | **Declared mode still outranks declared language.** Unchanged, and now true for the right reason. |
| D-3 | **The platform-default election follows the agent's primary** — TASK-934 OD-2's own rule. The agent moves back to f16, so the election moves with it. The geometry test was rewritten to assert that INVARIANT rather than a slug. |
| D-4 | `maxDecodeWindowSec` stays **7**. Only `partialWindowSec` reverts to 6 — the 7 s window was measured on CER directly (0.381 @ 7 s vs 0.645 @ 30 s) and is not in dispute. |
| D-5 | The console is NOT changed. `language` and `languageMode` are deliberately two axes (TASK-932 §3.7 / TASK-891 OD-1); the defect was in STT honouring only one of them. |

## 4. Implementation Summary

### The fix (R-1)

- `apps/stt/src/stt/streaming/session_manager.py` — new module-level
  `_language_mode_for_declared_language()`, and the backfill now reads:
  promote a declared catalog language → else, only if nothing was declared at all, take the
  agent's mode. `create_session`'s docstring corrected: the precedence is about what the CALLER
  declared.
- `apps/stt/tests/unit/streaming/test_task938_language_declaration_precedence.py` — 7 tests,
  driving the REAL `create_session`. The TASK-891 tests seed `_session_language_modes` by hand,
  which is exactly why the defect lived underneath them.
  **RED confirmed** by reverting the three-line branch: `test_declared_language_is_not_overwritten_by_the_agents_pair`
  and `test_a_non_catalog_language_reaches_the_decoder_as_a_raw_pin` fail; the other five pass.

### The config (R-2)

| Parameter | Before (HEAD `27e895f47`) | Now | File |
|---|---|---|---|
| Served weights | `…-gguf-q8_0` | `…-gguf` (f16) | `seed/25-agents.ts` |
| Platform default election | q8_0 | f16 (follows the primary, D-3) | `seed/ai-models/audio.ts` |
| `partialWindowSec` | 15 | **6** (all 4 whisper.cpp rows) | `seed/ai-models/audio.ts` |
| `maxDecodeWindowSec` | 7 | 7 (unchanged) | — |
| `wordTimestamps` | false | **true** | `seed/25-agents.ts` |
| Hotwords → whisper prompt | not applied | **appended after the agent prompt** | `streaming/whisper_cpp_asr.py` |
| Priming prompt switches | both off | **both on** | `pipeline/language_modes.py` |
| VAD `minSpeechMs` | 100 | 100 (already the target) | — |
| Word-split guard, lexicon stage, commit policy, empty-span retry, six decode knobs | — | unchanged | — |

`wordTimestamps: true` is no longer the script-corrupting setting TASK-891 A4 turned off: the
adapter now REFUSES the `max_len=1, split_on_word=True` decode unless the language is pinned to a
space-delimited one, so an unpinned or Malayalam session keeps the clean sentence-level decode and
only a declared `en`/`vi` session pays for word splitting.

### The duplicate auto option (R-4)

`ScribeFooter` prepended its own `__auto__` sentinel while `useArcaSttLanguageModes()` already
returned the catalogue's `auto`, so the picker rendered two auto rows. They are not equivalent,
which is why this is a defect and not a tidy-up:

| Row | Sends | What the decoder gets |
|---|---|---|
| `__auto__` "Auto (code-switch)" | nothing | the agent's own `ml-en` pair — unpinned, **with** the bilingual priming prompt |
| `auto` "Auto-detect" (catalogue) | `languageMode: "auto"` | auto-detect, replacing the agent's mode — unpinned, **no prompt** |

The sentinel is the row that survives: it is the TASK-891 OD-1 default ("undeclared", never
English) and the only value able to express "no declaration", since `''` cannot be a Radix item
value. `withoutCatalogueAuto()` drops every auto mode the catalogue offers — matched on `kind`
AND on `id`, because `kind` is optional on `SttLanguageModeOption`. The catalogue itself is
untouched: `deriveSummaryLanguages` reads the same list for the SUMMARY-language axis.

Covered by `scribe-footer-language.test.tsx` (4 tests, rendering the real picker).
**RED confirmed** by reverting the filter: the two "drops the catalogue auto" tests fail.

### Live dev DB

Applied by `psql` on `DIRECT_URL` (one transaction; the seed above is the durable place):
`_metadata.asr.partialWindowSec` 15→6 ×4, the election moved to f16, and all three
`realtime-transcription` copies (System/Global/ArcaAI) repointed to f16 with q8_0 first in the
fallback chain and `wordTimestamps: true` in both `parameters` and `compiledConfig`.
`compiledConfigChecksum` is stamped only at publish and never re-verified on the resolve path, so
it is left as-is on the dev row.

## 5. Verification

| Gate | Result |
|---|---|
| `packages/database` seed tests | 50 files / **677 passed** |
| `apps/admin-console` suite | 304 files / **2776 passed**; eslint + `tsc --noEmit` clean |
| `apps/stt` unit suite | **3258 passed**, 1 failed — `test_task799_env_surface.py::test_minio_credentials_default_to_empty`, the pre-existing env failure TASK-891's own gate line records |
| `ruff check apps/stt` | All checks passed |
| `mypy apps/stt/src` | Success, 141 source files |
| `tsc --noEmit` (`packages/database`) | clean |
| Live runtime proof | below |

### Runtime proof (live stack, 2026-09-09 22:15)

Three sessions created through the real gateway, one per declaration shape, read back from
`stt.log`:

| Case | Request body (the screen it mimics) | Decoder language | Verdict |
|---|---|---|---|
| A | `{"sampleRate":16000,"language":"en"}` — Live Transcription | **`'en'`** | **fixed** (was `None`) |
| B | `{"sampleRate":16000,"languageMode":"en"}` — Consultation playground | `'en'` | unchanged, still correct |
| C | `{"sampleRate":16000}` — nothing declared | `None` | unchanged — TASK-891 OD-1 preserved |

All three loaded `arcaai-whisper-large-ml-en-gguf` (f16) at
`partial_window_s=6.0, max_decode_window_sec=7.0`, with the lexicon stage active
(`enabled/term_count 20/active`).

The `wordTimestamps: true` re-enablement is proven safe by the same run: the adapter's
word-split refusal fired **once**, for case C alone —

```
Word timestamps requested but refused … language=None model=arcaai-whisper-large-ml-en-gguf
```

— so the lossy `max_len=1` decode is taken only by the pinned-`en` sessions it is safe for, and an
unpinned or Malayalam session still gets the clean sentence-level decode.

## 6. Not in this ticket

- A **browser pass over the collapsed picker**. Reaching the playground needs a password typed
  into the login form, which this session does not do. The evidence is the DOM test above, which
  renders the real `ScribeFooter` + `SttLanguageModePicker` tree and asserts the rendered option
  list; the stack is up if the owner wants to look.
- **TASK-937 R-4** — hotwords-in-prompt as a per-model `decoding.hotwordsInPrompt` switch. This
  ticket restores it globally, which is what the owner asked for; R-4 is where it stops being
  global.
- The `mlen_scorecard_baseline.json` entries were captured with both prompt switches OFF **and no
  agent `initialPrompt` applied**. They no longer describe what production runs and need a new
  entry (window_s alone does not distinguish prompt state — the file's own `_note` says so).
- A non-catalog `language` (e.g. `de`) is still not persisted, so a worker restart re-applies the
  agent's mode to that session. Pre-existing; out of scope.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-09 | Root-cause analysis against the two live sessions; ticket opened. Language clobber fixed (RED confirmed), decode config moved to the owner's table, gates green, live dev DB updated. |
| 2026-09-09 | R-4: collapsed the duplicate auto option in the consultation playground (RED confirmed); admin-console suite green. |
| 2026-09-09 | The dev stack had gone down mid-work (22:00, nothing on 8868/8861) and two orphan `apps/api` processes were left holding no port; cleared them and restarted `pnpm stack:dev`. Runtime proof captured (§5). |
