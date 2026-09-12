# TASK-961 — a Kokoro row with unpublished weights fails with an ACTIONABLE error

| Field | Value |
|---|---|
| Status | **Completed** |
| Type | bugfix |
| Branch | `dev-2.2` |
| Related | TASK-860 (published Kokoro paths), TASK-879 (`from_spec` supplies `localPath`), TASK-960 (the misleading-error class of defect) |

---

## 1. Requirement Analysis

Harden Kokoro's "`local_path` set but the weights are not there" case.

**What the investigation changed about the ask.** The case was first described (by me, loosely) as
"kokoro passes a bad path straight to the engine instead of warning and falling through". That is
**false**. `resolve_kokoro_paths` already fails CLOSED, and doing so is deliberate and correct —
its own comment rejects the alternative:

> silently falling back to a Hub download would hide a registry row whose weights were never
> published (`availability: MISSING`).

Making it fall through would therefore be a REGRESSION, not a hardening, and would break
`test_model_path_without_the_files_fails_closed`. That behaviour is unchanged by this ticket and
is now pinned by a second, explicitly-named regression guard.

**The real defect is what the failure SAYS.** The message read:

```
TTS_KOKORO_MODEL_PATH='…' does not contain config.json and a .pth checkpoint — …
```

`KokoroConfig.model_path` is declared `validation_alias=moved_to_row_alias("TTS_KOKORO_MODEL_PATH")`,
and `moved_to_row_alias` returns a **dead** alias (`core/control_plane.py:100`): *"What dies is the
environment path, so the only way to populate it is the spec."* So the message named a knob the
operator **cannot set and cannot fix** — the same class of defect as advising a HuggingFace token
for a repo that does not exist on the Hub (TASK-960 D1). It also omitted the model slug, so an
operator running several kokoro rows could not tell which row was unpublished.

## 2. Current State Evaluation

The supply chain is complete and was never broken:

`AgentResolverService` (`derivedLocalPath`) → `ResolvedAgentModel.localPath` → `tts-spec.ts`
`toSpecModel` (forwarded verbatim) → `tts/spec.py` `TtsSpecModel.local_path` → `kokoro.from_spec`
→ `KokoroConfig.model_path` → `resolve_kokoro_paths`.

## 3. Implementation

TDD, RED first (`4 failed, 4 passed` — the 4 passing were the deliberate regression guards).

- `resolve_kokoro_paths(config, *, slug: str | None = None)` — message rewritten to name the
  registry row, the derived `bucketPrefix` origin, and the two real remedies (publish the row, or
  re-run the inventory); states explicitly that the value is not settable from the environment.
  `slug` is optional so the hermetic suites that build a config directly keep working.
- `KokoroProvider.__init__(..., slug=None)` forwards it; `from_spec` supplies
  `candidate.model.slug`.
- `test_kokoro_paths_task860.py::test_model_path_without_the_files_fails_closed` re-anchored from
  `match="TTS_KOKORO_MODEL_PATH"` to `match="bucketPrefix"`. The behaviour under test is unchanged;
  the old regex pinned the very misdirection being removed, and the new anchor names the real
  supplier rather than an env-var spelling that can go stale again.

## 4. Evidence

| Gate | Result |
|---|---|
| `pytest apps/tts/src/tts/tests/` | **448 passed, 3 skipped** |
| `ruff check apps/tts/src/` | All checks passed! |
| `mypy --config-file apps/tts/pyproject.toml apps/tts/src/` | Success: no issues found in 42 source files |
| `black --check` | ⚠️ **pre-existing** failure, untouched — see below |

`black` reports one reformat in `providers/kokoro.py`: a missing blank line before the
`_STREAM_END` comment block in `resolve_kokoro_voice`, which is **not** code this ticket touched.
Verified byte-identical against `HEAD` before the change (`git show HEAD:… | black --diff` produces
the same hunk), so `tts:format:check` was already red on `dev-2.2`. Deliberately NOT fixed here —
reformatting adjacent code is out of scope for a bugfix, and it deserves its own trivial commit.

## 5. Out of Scope — flagged, not fixed

- `indic_f5.py:96` and `indic_parler.py:128` use the identical
  `candidate.model.local_path or ""` pattern. They do **not** share Kokoro's misleading message
  (they have no equivalent failure text), so nothing here is wrong for them today — but if either
  grows a "weights not present" error, it should name the row, not an env var.
- The pre-existing `black` hunk above.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-12 | Opened and completed. Established that fail-closed is correct and must stay; fixed the message to name the registry row + slug instead of the retired `TTS_KOKORO_MODEL_PATH` alias; added `test_kokoro_missing_weights_task961.py` (8 tests, including two regression guards on the fail-closed contract). |
