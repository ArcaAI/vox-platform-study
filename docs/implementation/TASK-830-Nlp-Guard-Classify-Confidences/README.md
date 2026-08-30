# TASK-830 — Per-label confidences on `apps/nlp`'s guard-classify route

| Field | Value |
|---|---|
| Status | Review |
| Type | bugfix |
| Branch | `lane-nlp-confidences` (worktree; unmerged) |
| Unblocks | TASK-829 Phase 4 (per-tenant θ/Θ calibration) |
| Ticket number | **Assigned by this lane, not by the owner** — `TASK-829` was the highest under `docs/implementation/`. Renumber if the orchestrator has another slot. |

## Requirement Analysis

TASK-829's decision plane shipped with a recorded limit: its session aggregate is a **flag
rate**, not the graded mean §5.1's formula describes, so `scoreCalibration: "categorical"` rides
on every verdict and Phase 4 cannot be completed. §2.1's measured phenomenon — detector
confidence collapsing 0.99 → 0.03 as malicious density per window falls — is only *observable*
if a score exists at all; under a flag rate every one of those sub-threshold windows contributes
exactly 0.0 and the aggregate is blind to the dispersal that is the attack.

## Current State Evaluation

### Where the confidences were lost — three layers, one route

The brief's citation (`apps/nlp/src/nlp/api/v1/rest/guard.py:318-326`) is **exactly right**, and
it is the last of three layers:

| Layer | Before |
|---|---|
| `services/gliner2_guard.py` `_sync_classify` / `_sync_batch_classify` | called the runtime **without** `include_confidence=True` — while the *entity* path in the same class has always passed it |
| `schemas/guard.py` `GuardClassifyResponse` | `results: dict[str, str \| list[str]]` — no field a score could occupy |
| `api/v1/rest/guard.py` guard_classify | reduced each verdict to `str` / `list[str]` |

### Computed and discarded, not missing

`gliner2`'s `_extract_classification_result` (`inference/engine.py:339-377`) softmaxes or
sigmoids the classifier logits and stores `(label, confidence)` tuples. `_format_results`
(`engine.py:805-817`) then **throws the confidence away** unless `include_confidence=True`:

```python
formatted[key] = {"label": label, "confidence": conf} if include_confidence else label
```

So the numbers were always computed and always paid for. `apps/nlp` simply did not ask on this
one path.

### `/guard/classify` was the ONLY hole

Contrary to the brief's framing ("text classification, token classification, or both?"), the
general classification routes have always been graded:

| Route | Confidence today |
|---|---|
| `POST /classify/text` | `confidence` + full `probabilities` |
| `POST /classify/text/multi-label` | per-label `scores` |
| `POST /classify/tokens` | `Entity.confidence` per span |
| `POST /guard/pii` | `GuardEntity.score` per span |
| `POST /guard/entailment` | raw `scores` per pair |
| **`POST /guard/classify`** | **labels only — the defect** |

### A latent fail-open that had to be closed in the same commit

The old reduction accepted only `str` and `list`/`tuple`. A `Mapping` fell through **both**
branches and the task was **omitted** — and `include_confidence=True` is precisely what turns
those values into mappings. Flipping the flag alone would have made every moderation task vanish
from `results`; downstream, an absent task reads as "this check did not run", so
`analyze_content` would have reported `safe: true` while the model was flagging. Both halves are
therefore in one change, and `test_a_confidence_shaped_verdict_still_yields_its_LABEL` pins it.

### Consumers

`/guard/classify` is **not proxied by the gateway** (`ai-inference.client.ts` fronts
`/classify/tokens`, `/classify/topic`, `/classify/intent`, `/diagnosis/suggestions` — not the
guard plane), so no OpenAPI / route-manifest / portal / `vox-node` regeneration applies.

| Consumer | Parses | Action |
|---|---|---|
| `guardrail/services/external_nlp_client.py` `classify()` | `payload["results"]` as a raw dict | Unchanged shape; new `classify_scored()` beside it |
| `guardrail/services/safety_analyzer.py` `analyze_content()` | `str \| list[str]` | Untouched |
| `guardrail/services/screening.py` `_classify()` | `str \| list[str]` | Untouched |
| `guardrail/realtime/service.py` (via `classify_tasks`) | `str \| list[str]` | Moved to the scored seam |
| `apps/harness` | comments only; reaches the plane through `POST /guardrail/screen/outbound` | None |

All three label consumers do `[value] if isinstance(value, str) else [str(v) for v in value]`.
Reshaping `results` would have them comparing `"{'label': 'unsafe', …}"` against their
benign-label set — so the change is **additive**, in a sibling field, by necessity rather than
by preference.

## Implementation Summary

### `apps/nlp` — return what was already computed

- `services/gliner2_guard.py` — `include_confidence=True` on `classify_text` and
  `batch_classify_text`, matching the entity path.
- `schemas/guard.py` — `GuardClassifyResponse.scores: dict[str, dict[str, float]]`,
  defaulting to `{}`. **Not** a distribution over the taxonomy: gliner2 returns the argmax label
  for a single-label task and only the labels at/above `cls_threshold` for a multi-label one, so
  what is scored is exactly what was returned.
- `api/v1/rest/guard.py` — `_label_and_score` / `_split_verdict` normalise both the scored and
  the legacy shape. An unparseable confidence is **dropped**, never coerced; a task the model did
  not answer stays absent from both maps.

### `apps/guardrail` — consume them, and say which statistic the aggregate is

- `external_nlp_client.py` — `ClassifiedTasks(labels, scores)` + `classify_scored()`.
  `classify()` delegates and returns `.labels`, so it is one peer call either way — the
  confidences ride with the labels rather than costing a second inference pass. `_parse_scores`
  drops non-numeric values (a fabricated `0.0` reads as "certainly clean", `1.0` as "certainly
  harmful"; both are wrong claims about what the model said).
- `safety_analyzer.py` — `classify_tasks_scored()` beside `classify_tasks()`; same fail-closed
  posture.
- `realtime/session_state.py` — `observe(score, graded=False)` and a `graded_windows` counter
  that survives the Redis snapshot/restore round trip. `graded` defaults to **False** so a caller
  that has not thought about calibration cannot accidentally claim a confidence mean.
- `realtime/service.py` — `_classify` prefers the scored seam when the analyzer offers it;
  `_graded_risk` derives the window score; `scoreCalibration` is computed per aggregate.

### The risk derivation, and its honest limit

Per label: a **non-benign** label contributes its own confidence; a **benign** one contributes
`1 - confidence` — the mass the model did *not* put on "clean". The window takes the max across
the gating tasks.

`1 - P(benign)` is **exact** for a single-label softmax task (the shape `prompt_safety` /
`jailbreak_detection` use): with one benign label it is the total probability on the harmful
ones. For a **multi-label sigmoid** task it is an estimate rather than a bound, because the
executor returns the labels it selected and not a distribution over the whole taxonomy. It is
monotone in detector confidence either way, which is the property §5.1's aggregate needs. It
lives in guardrail, not `apps/nlp`: `benign_labels` is guardrail's policy, and the executor must
keep returning raw numbers it does not interpret (rule 06 / decision D3).

A window is graded only when **every task that answered** was scored — a max over a subset
silently understates the window. An aggregate is `graded` only when **every window** folded into
it was graded; a mix is neither statistic and is reported `categorical`, with `gradedWindows`
alongside `windows` so the mix is auditable rather than merely conservative.

## Verification

| Gate | Result |
|---|---|
| `pnpm nlp:test` | 531 passed, 2 failed — the two pre-existing `test_metrics_endpoint_task636.py` failures, unchanged (525 → 531 passed; 6 new tests) |
| `pnpm nlp:lint` | All checks passed |
| `pnpm nlp:typecheck` | Success: no issues found in 56 source files |
| `pnpm guardrail:test` | 411 passed (405 → 411; 11 new tests, 5 in the client file) |
| `pnpm guardrail:lint` | All checks passed |
| `pnpm guardrail:typecheck` | Success: no issues found in 44 source files |
| `pnpm harness:test` | 1728 passed |
| `pnpm lint:py` | All checks passed (all six services) |
| `pnpm lint` | **Not run** — this worktree has no `node_modules` (`turbo: command not found`); `pnpm install` is orchestrator-owned |

No dependency changed, so `uv lock` was not re-run.

## Change History

| Date | Change |
|---|---|
| 2026-08-30 | Route, schema and runtime call fixed in `apps/nlp`; `ClassifiedTasks` seam and graded session aggregate in `apps/guardrail`. TASK-829's §12A honest-limit section updated to record that the block is lifted. |
