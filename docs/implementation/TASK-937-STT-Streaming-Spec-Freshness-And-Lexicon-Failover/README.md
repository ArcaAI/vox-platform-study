# TASK-937 — STT streaming: per-session spec freshness, lexicon on the failover chain, and the LocalAgreement settled-prefix collapse

| | |
|---|---|
| **Status** | `Pending` — plan and decisions ready; no code. Follow-up to TASK-935, carrying the three residuals its close-out recorded. Number assigned by the highest-existing rule (TASK-936 is the concurrent security/dependency ticket; this is the next free). |
| **Branch** | `dev-2.2` |
| **Classification** | `bugfix` (spec freshness, failover lexicon) + `feature` (streaming commit continuity on real audio) |
| **Owner request** | Derived from TASK-935: the lane-V live root-cause pass (a focused debugger) and lane C's OD-12 pin surfaced three genuine, separately-testable defects, deliberately left out of TASK-935 to keep that change surgical. |
| **Related** | TASK-935 (clinical lexicon + OD-12 commit continuity), TASK-934 (per-model ASR profile), TASK-861 (`ResolvedAsrSpec`), TASK-891 (LocalAgreement-2) |

---

## 1. Requirement Analysis

| Id | Requirement | Kind |
|---|---|---|
| R-1 | A streaming session must build its ASR pipeline from **its own** resolved spec, never a sibling session's stale bundle that happens to share the agent-version runtime key | bugfix (correctness/PHI: a session could decode with another resolve's config) |
| R-2 | The lexicon terms (and every decode-config knob) must reach the **fallback** engine chain too, so a session that fails over from the primary keeps correcting clinical vocabulary (OD-5: one hotwords list, all chains) | bugfix |
| R-3 | The streaming **settled (committed) prefix** must stay stable through a long utterance on real (jittery) audio, not only on the deterministic oracle — the caption is whole-utterance since TASK-935 lane C, but `stable_chars` still largely collapses at the first window slide on real speech | feature (streaming UX) |

## 2. Current State (verified 2026-09-09 on `dev-2.2`, from the TASK-935 debugger + lane C)

### 2.1 R-1 — `_load_pipeline_config` returns the first bundle matching the runtime key, not the session's own
`apps/stt/src/stt/streaming/session_manager.py:1767`:
```python
for bundle in _spec_bundles_of(self).values():
    spec = bundle.pipeline_specs.get(pipeline_id)
    if spec is not None:
        return copy.deepcopy(spec)
```
Runtime keys are agent **version** ids, so two sessions on the same agent share a key. The method assumes "same key ⇒ same spec" (its own docstring says so), but that breaks when the model row's `_metadata.asr` changes between two resolves (e.g. an admin adds `decoding.hotwords`, or any profile edit): an earlier session's bundle, registered under a different `session_id` but carrying the OLD spec, is found first and deep-copied for the new session. Bundles are keyed by `session_id` in `_spec_bundles_of(self)` (`:1746`) and the helper `_spec_bundles_of(manager).get(session_id)` (`:195`) already exists — the fix is to look up the requesting session's own bundle first. This is the exact symptom class behind the TASK-935 live lexicon miss (a pre-hotword bundle served to a later session); TASK-935 worked around it operationally (an STT restart clears the registry) but the latent bug remains.

### 2.2 R-2 — the resolver folds hotwords only into the primary chain's instruction
`packages/applications/src/services/stt/agent-resolver/build-resolved-asr-spec.ts` `instruction()` folds the model profile's `decoding.hotwords` into `instruction.hotwords` for the PRIMARY model. The fallback spec (`spec.fallback.spec`) is built from the fallback model, whose row (`arcaai-whisper-large-ml-en-gguf`, and the CT2/int8 rows) carries no `decoding.hotwords`, and the agent's `instruction.hotwords` is empty — so `spec.fallback.spec.instruction.hotwords == []` and the fallback chain's lexicon is inactive. Runtime-inert today (the streaming worker keeps the primary corrector across an engine switch), but it violates OD-5 for any session that fails over, and the moment a code path rebuilds the corrector from the fallback spec it silently stops correcting.

### 2.3 R-3 — LocalAgreement settled prefix collapses on real audio
TASK-935 lane C froze out-of-window text and re-anchored the two hypotheses on the same audio span; on the oracle test `stable_chars` is monotone and ≥ 80 % committed before the final. On real whisper.cpp partials (frame dumps), consecutive hypotheses jitter token-by-token, so the agreed prefix stays short and `stable_chars` collapses to a few characters at the first window slide and holds there (e.g. 221 → 4). The published caption is the whole utterance (correct), but the clinician sees almost none of it marked settled. `apps/stt/tests/unit/streaming/test_task935_commit_continuity.py` is the home for the RED. `committed_revision_rate` in `streaming_thresholds.json` currently carries this churn in its baseline.

## 3. Implementation Plan

| Lane | Scope | Tests first (RED) | Tier |
|---|---|---|---|
| **B — bundle freshness (R-1)** | `session_manager.py` `_load_pipeline_config` gains the requesting `session_id` (threaded from its three callers) and looks up `_spec_bundles_of(self).get(session_id)` first, falling back to the scan only when the session has no own bundle (recovery paths), then the deprecated reader; `apps/stt/tests/unit/streaming/**` | two sessions on one runtime key with DIFFERENT specs (one carrying hotwords, one not) each get their OWN spec — RED today (both get the first-registered) | `opus` (shared session-manager path, PHI-adjacent) |
| **F — failover lexicon (R-2)** | `build-resolved-asr-spec.ts` resolves the hotword/term list ONCE (agent → primary model profile) and applies it to the fallback chain's `instruction.hotwords` too; parity fixture + resolver tests | a fallback spec's `instruction.hotwords` equals the resolved terms — RED today (`[]`) | `sonnet` |
| **C2 — commit continuity on real audio (R-3)** | `commit_policy.py` commit rule: commit on N-of-M agreement across a sliding window (not strict 2-consecutive-prefix), so real jitter still settles a growing prefix; re-capture `committed_revision_rate` after | an oracle-with-injected-jitter utterance keeps `stable_chars` monotone and ≥ some floor committed before the final — RED today | `opus` |

Order: B and F in parallel (disjoint: STT session-manager vs the TS resolver), then C2; the orchestrator restarts the STT, re-runs the streaming scorecard N=3 (all three fixtures, key-term AND keyphrase ≥ 0.70), re-captures the thresholds, and confirms a failover session still corrects (force the primary to fail).

## 4. Decisions — answer before "go" (recommendation first)

| Id | Decision | Options | Recommendation |
|---|---|---|---|
| OD-1 | R-1 fallback when the session has no own bundle | (a) fall back to the scan then the deprecated reader (today's behaviour) — only recovery/crash-restart paths hit it; (b) hard-fail | **(a)** — a recovered session legitimately has no live bundle; the scan is safe there because a restart cleared stale entries |
| OD-2 | R-3 commit rule | (a) N-of-M agreement (e.g. a token committed once it survives 2 of the last 3 windows); (b) leave as-is, accept the 15 s window defers the collapse | **(a)** — the settled prefix is what a clinician reads as final; deferring is not fixing |
| OD-3 | Whether R-1/R-2/R-3 are one ticket or three | (a) one ticket, three lanes; (b) split | **(a)** — they share the streaming spec/worker surface and one re-capture of the thresholds |
| OD-4 | Ticket number | TASK-937 | confirm |

## 5. Verification
- STT unit + the three RED→GREEN pins; ruff/mypy; the applications resolver + parity vitest.
- Live: streaming scorecard N=3 green on all three fixtures for BOTH key-term and keyphrase recall at the unchanged 0.70 floor; a forced-failover session still corrects "septrioxone" → "ceftriaxone"; `committed_revision_rate` re-captured and monotone `stable_chars` on a real-audio frame dump.
- `lint:all`, `typecheck:all`, `env:sync:check`.

## 6. Implementation Summary
_Pending._

## 7. Change History
| Date | Change |
|---|---|
| 2026-09-09 | Opened as the TASK-935 follow-up. R-1 (cross-session bundle staleness, `session_manager.py:1767`) and R-2 (fallback chain lexicon, `build-resolved-asr-spec.ts`) were found by the TASK-935 lane-V live debugger; R-3 (LocalAgreement settled-prefix collapse on real audio) is lane C's recorded OD-12 residual. Anchors verified on `dev-2.2`. |
