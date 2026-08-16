# STT palette — node registry contract (TASK-724 Task 1-3)

Cross-references `docs/implementation/TASK-720-Palette-Summarization/contracts/palette.md` (the
sibling contract this ticket's mechanism follows verbatim — nothing here is STT-specific in the
*mechanism*, only in the node set, per TASK-720 README §6 cross-ticket contract) and
`packages/workflow-contract/src/node-registry.ts` (the code-owned registry both this table and the
Studio/harness read from).

## Node table

| # | Node type key | Safety class | `critical` | `external_write` | `implemented` | Activity (Temporal-registered name) | Config schema |
|---|---|---|---|---|---|---|---|
| N-1 | `stt.audioInput` | `mandatory` | `true` | `false` | `true` | `interpreter.stt_audio_input` | `nodes/stt.audioInput.schema.json` |
| N-2 | `stt.vad` | `optional` | `false` | `false` | `true` | `interpreter.stt_vad` | `nodes/stt.vad.schema.json` |
| N-3 | `stt.noiseFilter` | `optional` | `false` | `false` | `true` | `interpreter.stt_noise_filter` | `nodes/stt.noiseFilter.schema.json` |
| N-4 | `stt.diarization` | `optional` | `false` | `false` | `true` | `interpreter.stt_diarization` | `nodes/stt.diarization.schema.json` |
| N-5 | `stt.languageDetection` | `optional` | `false` | `false` | `true` | `interpreter.stt_language_detection` | `nodes/stt.languageDetection.schema.json` |
| N-6 | `stt.asrEngine` | `mandatory` | `true` | `false` | `true` | `interpreter.stt_asr_engine` | `nodes/stt.asrEngine.schema.json` |
| N-7 | `stt.transcriptOutput` | `mandatory` | `true` | **`true`** | `true` | `interpreter.stt_transcript_output` | `nodes/stt.transcriptOutput.schema.json` |
| N-8 | `stt.phiHop` | `optional` (guardrail redaction, PLACEHOLDER) | `false` | `false` | **`false`** | `interpreter.stt_phi_hop` | `nodes/stt.phiHop.schema.json` |

Mirrors the seven-taxonomy stages named in README §1 (audio input → VAD → noise filter →
diarization → language detection → ASR engine selection → optional PHI hop → transcript output),
each mapped directly onto `apps/stt/src/stt/pipeline/dto.py`'s existing `ModelTaskType`
(`VOICE_ACTIVITY_DETECTION`, `AUDIO_DENOISING`/`AUDIO_TO_AUDIO`, `SPEAKER_DIARIZATION`
[+`SPEAKER_EMBEDDING`], `AUTOMATIC_SPEECH_RECOGNITION`) — the platform's own pre-existing pipeline
stage vocabulary, not invented here (README §2.2).

## `implemented: false` on `stt.phiHop` — the load-bearing decision, not an oversight

Every other TASK-720 node type shipped `implemented: true`. `stt.phiHop` is deliberately the
opposite, and the reason is mechanical, not just documentary: `compile()`
(`packages/workflow-contract/src/compiler.ts`) calls `ctx.nodeInfo(type)` for every node **present
in the authored graph**, and `nodeInfo()` (`node-registry.ts`) returns `undefined` for an
`implemented: false` entry — which `compile()` treats identically to an unregistered type
(`WF-C-002`, "not a registered node type"), refusing to compile the **entire graph**. Concretely:

- A graph that never includes `stt.phiHop` compiles and publishes normally — `implemented: false`
  is completely inert for it (`compile()` only inspects node types actually present).
- A graph that DOES include `stt.phiHop` **cannot be validated or published at all** until TASK-710
  ships a real activity and this entry flips to `implemented: true`.

This is a stronger, earlier gate than "let it publish and fail at runtime" — a tenant literally
cannot ship a workflow claiming a PHI hop that does not exist. It is also the literal reading of
README §1's own out-of-scope note: *"the compiler must allow a workflow to validate and publish
**without** this node present"* — without, not with.

## `critical` rationale (mirrors TASK-720 palette.md's own reasoning, applied to this node set)

- **N-1 (`stt.audioInput`) and N-7 (`stt.transcriptOutput`) are critical.** No audio in means
  nothing downstream has anything to process; no output means the run produced nothing usable —
  same "total-failure, not partial-success" reasoning TASK-720 applied to its N-1/N-5.
- **N-6 (`stt.asrEngine`) is critical.** No engine selection means no transcript — nothing
  downstream (diarization merge, output) has anything to act on, mirroring TASK-720's N-3
  (`generate.text`) rationale verbatim.
- **N-2/N-3/N-4/N-5 (`vad`/`noiseFilter`/`diarization`/`languageDetection`) are NOT critical.**
  Each is an `optional` enhancement stage — the pipeline degrades gracefully to the engine's own
  defaults in their absence (README §1's "audio input → VAD → noise filter → diarization →
  language detection → ASR engine" ordering names them as pipeline STAGES, not gates; only the
  engine and its endpoints are load-bearing).
- **N-8 (`stt.phiHop`) is NOT critical** and, per the `implemented: false` decision above, cannot
  appear in a compiled/published graph at all yet — `critical` is recorded for when TASK-710 lands,
  matching the safety-class table (`optional`).

## Mandatory-subgraph rule set (Task 3 — `packages/workflow-contract/src/rule-catalogue.ts`)

Six new `structural`, `paletteKey: 'stt'` rule instances (`WF-STT-001..006`), additive
(`DRAFT_STT_RULE_SET`, its own export — never merged into `DRAFT_SUMMARIZATION_RULE_SET`).
Registered in `packages/workflow-contract/src/validate.ts`'s default rule set alongside
`DRAFT_SUMMARIZATION_RULE_SET` (both are `null`- or palette-scoped, so `validate()`'s existing
per-rule `paletteKey` filter — unchanged — already routes each graph to only the rules that apply
to its own `paletteKey`; this is the one place this ticket touches a file the README's own §1 does
NOT list as off-limits (`validate.ts` is the *validator*, not the interpreter/compiler/
`WorkflowDefinition` model those out-of-scope notes name), and the change is additive-only — a
summarization graph's evaluated rule set is byte-identical to before).

| Rule ID | Predicate | What it enforces | Failing fixture |
|---|---|---|---|
| `WF-STT-001` | `SINGLE_ENTRY` (`entryType: stt.audioInput`) | Exactly one `stt.audioInput` node (N-1, mandatory) | two `stt.audioInput` nodes |
| `WF-STT-002` | `SINGLE_ENTRY` (`entryType: stt.transcriptOutput`) | Exactly one `stt.transcriptOutput` node (N-7, mandatory) | two `stt.transcriptOutput` nodes |
| `WF-STT-003` | `REQUIRED_NODE_TYPE` (`nodeType: stt.asrEngine`, `minCount: 1`) | An ASR engine node is present (N-6, mandatory) | graph with no `stt.asrEngine` node |
| `WF-STT-004` | `ORDERED_BEFORE` (`beforeType: stt.audioInput`, `afterType: stt.asrEngine`) | Audio input is never downstream of the ASR engine — order not inverted | `stt.audioInput` wired downstream of `stt.asrEngine` |
| `WF-STT-005` | `ORDERED_BEFORE` (`beforeType: stt.asrEngine`, `afterType: stt.transcriptOutput`) | The ASR engine is never downstream of the transcript output — transcription happens before delivery | `stt.asrEngine` wired downstream of `stt.transcriptOutput` |
| `WF-STT-006` | `REQUIRED_PATH_THROUGH` (`fromType: stt.audioInput`, `toType: stt.transcriptOutput`, `throughType: stt.asrEngine`) | Nothing routes audio to the output without passing through the ASR engine — the mandatory-subgraph core rule | `stt.transcriptOutput` fed directly from `stt.audioInput`, bypassing `stt.asrEngine` |

`SINGLE_ENTRY`/`REQUIRED_NODE_TYPE`/`ORDERED_BEFORE`/`REQUIRED_PATH_THROUGH` are the SAME four
predicate kinds TASK-720's `WF-SUMM-*` rules use (`packages/workflow-contract/src/predicates/`) —
no new predicate kind was needed for this palette, confirming D4's "generic engine, domain
palettes onboard without engine changes" for the validator layer specifically.

**Deliberately NOT built here (gated, honestly, same reasoning as TASK-720 palette.md):** a
`schema`-class rule resolving `stt.asrEngine.modelSlug`/`stt.vad.modelSlug`/etc. against the
tenant's actual `AiModel` catalog (existence + correct `taskType`), and a rule calling
`language_modes.py`'s `engine_supports_mode` cross-language compatibility check between an
upstream `stt.languageDetection` node and `stt.asrEngine`. Both need repository I/O
(`WorkflowValidatorService`, TASK-716 Task 8) or a cross-language contract test neither of which
exists in this session — tracked as an explicit gap, not silently dropped (README §6).

## Entitlement gate (Task 7)

Per `node-registry.ts`'s own R-7 precedent (TASK-720 declined a registry `entitlementKey` for the
same reason): **`entitlementKey: null` on every entry above.** `PlanEntitlement`/`TenantEntitlement`
are column-per-key Prisma models — adding a real, per-tenant-overridable `featurePaletteStt` column
needs a schema migration, which this ticket does not add (consistent with TASK-720 R-7's "gating a
palette needs a migration, not a config row; do not add a column here"). Instead, `featurePaletteStt`
is wired as a CODE-DEFAULTED entitlement key: `ResolvedFeatures.paletteStt` /
`PlanEntitlementValues.featurePaletteStt` resolve from the seeded per-plan matrix
(`entitlements.constants.ts`) exactly like every other boolean feature, but the `PlanEntitlementInput`/
`TenantEntitlementOverrideInput` DB-row shapes simply do not carry the field yet (TypeScript's
structural optionality makes this a safe, additive no-op: `pick(undefined, seeded.value)` always
resolves to the seeded default until a follow-up ticket adds the column + admin API). Decided
`true` on every plan (STARTER/TRIAL/PRO/ENTERPRISE) — STT pipeline authoring is treated as a core
platform capability (every plan already gets `maxAsrPipelines > 0`), not a premium add-on like
`featureDnaReports`/`featureVoiceEnrollment`; a reviewer who disagrees can flip the matrix without
touching the wiring. Enforced at `WorkflowDefinitionService.publish()` via
`IEntitlementsService.isFeatureEnabled(tenantId, 'paletteStt')`, imitating
`assertProviderAvailable`'s `QuotaExceededException({ capability: 'featurePaletteStt', limit: 0,
used: 0, requested: 1 })` call site (the "first ENFORCED boolean entitlement" precedent named in
this ticket's README §4 Task 7) — kill-switch-gated exactly like every other entitlement check
(`isFeatureEnabled` returns `true` unconditionally while enforcement is OFF).

## Compiler interoperability (Task 4 — the central design decision)

Per README §1, publishing an `stt`-palette `WorkflowDefinition` does **not** produce a
generically-executed `compiledConfig` the way the summarization palette does. `compile()` still
runs (the engine gate: a cycle or unregistered node type is rejected exactly as for any other
palette), and its `compiledConfig.stages[].nodes[].config` — the raw authored config for each
node, verbatim (`compiler.ts#compileNode`) — is exactly what `stt-pipeline.compiler.ts` (Task 4)
walks to emit `AsrPipeline.configYaml`'s `models.asr`/`models.vad`/`models.denoise` keys. The
`compiledConfig` JSON blob itself is still stamped onto the `WorkflowDefinition` row (uniform
publish semantics across every palette — README's own "reusing the model verbatim" framing extends
here: `compiledConfig` is not re-purposed, it is simply not the artifact `apps/stt` reads at
runtime; `AsrPipeline.configYaml` is).
