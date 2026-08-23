# TASK-799 — Python Services Config-Plane Consolidation

| Field | Value |
|---|---|
| Status | In Progress — Phases 0, 1, 1.5 and Round 2 complete |
| Type | refactor / infrastructure |
| Branch | `dev-2.2` |
| Scope | `apps/{stt,text,guardrail,nlp,harness,tts}`, `packages/applications/src/services/{settings-registry,effective-config,ai-provider-connection,ai-task-default}`, `apps/api/src/modules/internal`, `apps/admin-console` |
| Opened | 2026-08-23 |

## Requirement Analysis

Owner directive: super admins configure platform settings and integrations; tenant
admins configure their own settings and bring their own keys/services. All of it
stored in and loaded from the DATABASE. Environment variables are to be eliminated
wherever possible, and the TOTAL number of configuration knobs must go DOWN — not
merely relocate from env to a table.

Trigger: eight `HARNESS_*` variables (claim-check store/min-bytes/bucket/endpoint,
judge provider/model/base-url/json-response-format) were found still living in
`.env`, contrary to the configuration principles in `.claude/rules/00-project-context.md`
and the tier table in `.claude/rules/09-infrastructure-devops.md`.

Baseline measured 2026-08-23 (`grep -cE '^[A-Z][A-Z0-9_]*=' apps/<svc>/.env.sample`):

| Service | Vars in its `.env.sample` |
|---|---:|
| harness | 88 |
| text | 85 |
| stt | 41 |
| guardrail | 38 |
| nlp | 31 |
| tts | 23 |
| **Total** | **306** |

For contrast, `env-surface.generated.md` declares **163 keys for the entire platform**,
of which **11** carry a `HARNESS_` prefix.

## Current State Evaluation

Full findings, root causes and per-service inventories: [assessment.md](./assessment.md).

Headline: the six services expose **~579 env-reachable settings fields**, of which 306
are documented in `.env.sample` and **40** are declared to any governance gate. ~95 are
dead. The DB→Python channel can carry **22 keys, all numeric, all SYSTEM-scope**.

Five BLOCKERs: BYOK bypassed via ambient SDK credential chains (F-01); a full guardian
engine plane in harness env (F-02); a fictional guardrail `.env.prod` (F-03); two
hardcoded nlp model ids live at runtime (F-04); guardrail resolving `AiRuntimeProfile`
SYSTEM-only (F-05).

Baseline correction: the `.env.sample` files understate the true surface by ~2x, so the
306 figure below is a floor, not the total.

## Implementation Plan

See [plan.md](./plan.md). Four phases plus a Phase 0 of independent correctness fixes.
Three open questions require an owner decision before Phase 1 starts.

## Implementation Summary

### Phase 0 — complete (merged to `dev-2.2`, 2026-08-23)

Four parallel worktree lanes, each TDD, each verified by the orchestrator against
the merged tree rather than on the agents' reports.

| Finding | Fix | Where |
|---|---|---|
| F-01 BLOCKER | Ambient cloud-credential chains closed. Bedrock builds through a single `_bearer_client()` that always takes an explicit token; Vertex passes explicit `credentials=`; both raise `ProviderCredentialsError` (503) when unsupplied. `openai_compat`/`vllm` gained a BYO override path and lost their env credential. STT Azure Foundry now matches Azure Speech (override-only). | `apps/text/providers/{bedrock,vertex,openai_compat}.py`, `apps/stt/models/azure_foundry_loader.py` |
| F-01 durability | The lock test now ITERATES `ProviderRegistry` and the settings tree instead of naming three adapters. An adapter declaring no `CredentialPosture` FAILS — default-deny, so the guarantee survives the next provider. This, not the three missing fields, was the root cause. | `apps/text/.../test_task602_byok_credentials.py` |
| F-07 | Vertex no longer fails open onto the platform ADC client when a tenant credential cannot be built. The old fail-open test was INVERTED, not deleted. | `apps/text/providers/vertex.py:130` |
| F-05 | Guardrail resolves `AiRuntimeProfile` and the `AiModel` slug tie-break tenant-first, widening to SYSTEM only on absence. New `_model_rank` gives the outer-join miss (`None`) its own rank so it loses to any real row. | `apps/guardrail/core/tenant_config.py:799` |
| F-08 | A DB error now raises `TenantConfigUnavailableError` (503) instead of being negative-cached as "no tenant opinion", which had silently downgraded a stricter tenant to the platform safety floor. | `apps/guardrail/core/tenant_config.py:564` |
| F-06 | Nine token-bypass call sites routed through `peer_service_token()` — including a FIFTH harness site (`temporal/worker.py:314`) absent from the brief, found by an AST sweep rather than by working the list. | `apps/{text,guardrail,nlp,harness}` |
| F-09 | `kwargs.setdefault` block removed; all 11 fields carry explicit `validation_alias` so host env > `secrets_dir` > env file > default applies again. | `apps/nlp/core/config.py` |
| F-10 | Tenant enforcement moved into middleware (text) and header/body cross-check added (nlp, 400 on contradiction). | `apps/text/api/middleware/auth.py`, `apps/nlp/api/tenant.py` |
| F-12 | nlp CORS reads the declared `allow_credentials` and refuses wildcard-plus-credentials at validation, so the misconfiguration cannot boot. | `apps/nlp/app.py:44` |
| F-03/F-13/F-14 | `apps/guardrail/.env.prod` deleted (it described a plane that does not exist, via a variable with no reader); GLiNER/vLLM/llama.cpp blocks removed from `.env.sample` and compose; ~40 dead fields deleted across guardrail/nlp/stt. `pnpm env:sync` re-run; `env:sync --check` green. | multiple |

**Held for Phase 1 (owner decision):** C.2 — removing the hardcoded nlp model ids —
is committed at `4fa3d1f15` on `worktree-agent-a8e1c3f6a1cbc58ca` and deliberately NOT
merged. It makes `/diagnosis/suggestions` fail closed until the gateway resolves a
SECOND `AiTaskDefault` for the suggester's internal NER — a two-model route where only
one selection was ever injected, the second silently filled by a literal. The owner
chose not to dark a clinical route between phases. **The Phase 1 gateway brief must
carry this**, or the resequencing reason is lost.

### Phase 1 + 1.5 — complete (merged to `dev-2.2`, 2026-08-23)

Three parallel worktree lanes. Every load-bearing claim re-verified by the
orchestrator against the merged tree.

**P1-A — the control plane is now generic.** The binding constraint was never the
`switch`: `effective-config.service.ts:219` coerced any non-number to the code default,
so strings, enums, URLs, booleans and taxonomies could not traverse the pull path at
all. `ResolvedKey.value` is now `unknown`, validated against the descriptor's declared
`dataType`; a mismatch degrades to `null` rather than substituting a default, because
substitution serves a plausible value and hides the defect. The hardcoded per-service
`switch` is replaced by a registry query on a new `SettingDescriptor.consumedBy`, and a
test computes the expected key set FROM the registry so the switch cannot return.
`modelWeights` added (the consumer in `harness/models/source_resolver.py` was already
written and waiting); `agenticContext` deleted after verifying zero consumers.
`guardrail.policy.*` re-tiered to `global-kv` with both orphans deleted — the
tighten-only floor is now a declared `SettingDescriptor.floorDirection` enforced
generically instead of by naming one feature file.

**The new contract** — adding one config key end-to-end used to need four coordinated
edits plus a Python client change. It is now: one descriptor with `consumedBy`, register
it, read it at `snapshot.raw["settings"]["<dotted.key>"]`. For anything that could vary
per tenant: same descriptor, `maxScope: 'tenant'`, omit `consumedBy` so it travels PUSH.

**P1-C — tenant secrets have a home.** `ProviderService` widened to
`llm|stt|tts|embeddings|rerank|vector`, reusing the existing seven-hop BYO contract
rather than building a sibling store (D-2: never a third home). **No migration was
needed and none was written**: `service` is `TEXT NOT NULL DEFAULT 'llm'` with zero
CHECK constraints (verified at `20260817000000_init/migration.sql:237`), so widening the
vocabulary requires no DDL. The forwarding allow-list became a validated passthrough
(`provider-extras.ts`) that checks SHAPE, not an enumerated key list, and reserves
`api_key`/`funding`/`base_url`/`region`/`api_version`/`deployment_name` so a row can
never restate the credential or stamp its own funding label.

The one behavioural change, reviewed and approved: **the SYSTEM tier of the override
fold is no longer filtered by `isCloudByoProvider`.** That filter conflated two rules —
"a TENANT may not own this" is not "the PLATFORM may not serve it" — and the conflation
is why a super-admin-configured self-hosted engine could never be delivered. The guards
that matter are intact and were read in order: a keyless row injects on NEITHER tier
(so a `base_url` still cannot become a credential); the tenant tier still refuses
non-cloud rows; cloud SYSTEM rows (platform SPEND) stay entitlement-gated while
self-host rows (platform INFRASTRUCTURE) do not; and every `continue` precedes
`toOverrideEntry`, so a suppressed row is never decrypted.

**P1-B — the drift gate now sees Python.** `scripts/python-env-surface.py` introspects
every `BaseSettings` subclass using pydantic's OWN field extraction (a regex does not
know a class's fields; pydantic does), harvests each field's comment block as its
description, and AST-scans bare `os.environ` reads including one-line helper
indirection. `env-sync.mts` consumes that manifest, GENERATES all six `.env.sample`
files instead of inlining them verbatim, and folds every Python name into
`turbo.json#globalEnv` (179 → 705 entries). Two gates with different failure modes:
`env:python-surface --check` catches a stale manifest, `env:sync --check` catches a
stale artifact.

**Declared surface: 40 → 652** (147 TS keys + 505 Python fields). Verified by
demonstration, not assertion: planting an undeclared `os.environ` read in
`apps/tts/core/config.py` made `env:sync --check` FAIL and name the exact variable;
restoring it returned the gate to green. That demonstration is the point — a gate that
is green because Python is excluded proves nothing.

### Round 2 — complete (merged to `dev-2.2`, 2026-08-23)

**C.2 has LANDED.** `4fa3d1f15` is now an ancestor of `dev-2.2`: zero hardcoded model
ids remain in `apps/nlp/src`, and `/diagnosis/suggestions` works again on a
gateway-resolved selection.

**R2-B corrected the brief's premise, and was right to.** The brief said to add a new
NER task key. `nlp.ner` ALREADY exists, and its SYSTEM seed row carries
`sourceUri: 'blaze999/Medical-NER'` (`seed/ai-models/nlp.ts:21`) — the exact literal C.2
removed from `TokenClassificationConfig`. Reusing it is behaviour-preserving and puts
every medical-NER surface behind one key; a dedicated `nlp.diagnosis.ner` would have
re-created the split it was meant to close.

**R2-A repaired the dead listener and made recurrence impossible.** One generalised
channel `arca:config:invalidate` replaces the never-published
`arca:guardrail-config:invalidate`; guardrail was re-pointed rather than aliased, because
keeping the old subscription would preserve the appearance of a channel nothing writes to
— which IS the defect. A Python test now reads the channel literal out of the TypeScript
source and asserts the constant matches, so the two halves cannot drift apart again.
Publish happens AFTER `refreshCache()`: publishing earlier races the subscriber's refetch
against the stale snapshot and re-caches the OLD value for a full TTL.

Scope, stated honestly: **wired and live for guardrail, text, stt only.** `nlp`, `harness`
and `tts` hold no Redis client at all, so nothing can deliver to them; giving them one is
a new dependency plus a bootstrap env var for two deliberately stateless services — an
owner decision, not a lane's. No live-Redis round trip is proven anywhere; the publish
half is tested against a mocked cache service and the subscribe half against an
in-process fake.

**The `modelWeights` loop is closed.** Root cause was `getattr(snapshot, "model_weights",
None)` against a snapshot type with no such member — it yielded `{}` and every deployment
silently took the env branch. It stayed invisible because the only test exercising that
branch used a stub that DID expose the attribute. The accessor now exists and is called
directly, so an `AttributeError` degrades loudly.

**R2-C closed the last BYO delivery gap** and caught a trap in doing so: removing the
`isCloudByoProvider` short-circuit made `assertProviderAvailable` run for self-host
providers, which would have returned 403 to an unentitled tenant on an unconfigured
self-hosted engine. Both suppression reasons concern platform SPEND on a vendor account;
self-hosted infrastructure is not spend, so the assertion is now cloud-scoped. Found by a
pre-written test that passed BEFORE the fix and would have failed after it.

**Two environment findings that explain earlier mysteries** (both pre-existing, both
confirmed on the untouched primary checkout):
- The harness suite needs `CI=true`. The `.env.dev` that worktree agents are told to copy
  in leaks `HARNESS_CLAIM_CHECK_STORE=s3` into a hermetic suite. **This is the real cause
  of the "15 harness failures" a Phase 0 lane reported and could not explain.**
- The TTS suite HANGS under captured output; it passes in ~8s with `--capture=no`.

### Post-merge gate evidence (`dev-2.2`, primary checkout)

| Service | Result |
|---|---|
| text | 1287 passed |
| guardrail | 268 passed |
| nlp | 401 passed (C.2 held; 471 after R2-B landed it) |
| harness | 1549 passed |
| stt | 2844 passed, 1 failed |

The single stt failure is `test_streaming_quality_scorecard` — a latency baseline
calibrated on faster hardware. Proven pre-existing: it fails identically on
`006d883ac`, the pre-Phase-0 base, and the stt diff touches only config, the Foundry
loader and tests — nothing on the streaming path.

Two agent claims that did NOT survive verification, recorded so they are not repeated:
a lane's "15 harness failures are pre-existing" (the base and the merged tree are both
fully green — they were worktree artifacts), and a lane's initial dead-field scan that
produced false positives on `internal_access_token` and `qdrant_api_key`.

### Round 2 lane R2-B — the second diagnosis model, and C.2 landed

**C.2 is no longer held.** `4fa3d1f15` is merged; `/diagnosis/suggestions` works again,
with a gateway-resolved NER selection rather than a literal.

The blocking gap was one injection, not one key. `/text-analyses/diagnosis`
(`apps/api/src/modules/ai-inference/ai-inference.controller.ts:184`) resolved only
`nlp.diagnosis`; the suggester's internal symptom-extraction NER was filled by the
hardcoded `blaze999/Medical-NER`, so half a clinical route was un-configurable. It now
resolves `nlp.ner` alongside it and injects `ner_model_name` / `ner_model_path`.

**No key was added to `AI_TASK_KEYS`.** The brief anticipated one, but `nlp.ner` already
exists and is already the medical token-classification task the playground NER tab and
the clinical NER callers resolve — and its SYSTEM row (`medical-ner`) carries exactly the
`sourceUri` the removed literal named (`seed/ai-models/nlp.ts:21`). Reusing it makes the
change behaviour-preserving AND puts every medical-NER surface behind one key, so a
re-point moves them together instead of leaving the diagnosis route behind. A dedicated
`nlp.diagnosis.ner` would have re-created the split it was meant to close.

Both resolutions run before the upstream call and both fail closed through the existing
`resolveDefaultModelSelection` (503; never a literal, never a neighbouring tenant's row).

**The `config.py` merge.** Phase 1.5 and C.2 edit disjoint regions of the file, so it
auto-merged — which is not evidence, so both halves were verified explicitly on the
merged tree: C.2's required selections at `core/config.py:411,414` (Token) and `455,457`
(MedicalSuggester) with zero `blaze999`/`symps_disease_bert` literals anywhere under
`apps/nlp/src`, and the three per-model configs gone from the `Settings` container; Phase
1.5's 16 `validation_alias` declarations and `populate_by_name=True` (`:352`) intact, with
the `kwargs.setdefault` block still absent.

**Finding, NOT fixed here — `resolveNerModelInjection` fail-open is now dead code paying
no rent.** `packages/applications/src/services/consultation/shared/resolveNerModelSelection.ts`
returns `{}` on an unresolved selection, justified by "the NLP service falls back to its
own env default". It does not: `/api/v1/classify/tokens` already requires `model_name` and
answers 503 without it (`apps/nlp/src/nlp/api/v1/rest/classify.py:162`), independently of
C.2. So the branch produces the same failure one hop later, attributed to the NLP service
rather than the unresolved key, under a log line naming an impossible fallback. Behaviour
is identical either way; only diagnostics differ. Inverting it fails 49 tests across 7
consultation suites whose fixtures omit the optional `IAiTaskDefaultService` — a bounded
but separate change. The stale justification is corrected in the file's doc comment; the
inversion needs its own ticket.

**Open governance question for the owner — `nlp.*` is SUPER_ADMIN-only.**
`SUPER_ADMIN_ONLY_TASK_PREFIXES` (`ai-task-default/constants.ts:119`) makes
`getEffective` short-circuit the tenant read to `null` for every `nlp.*` key
(`ai-task-default.service.ts:72`), so a tenant row is writable but can never win. Both
keys this route now resolves are `nlp.*`, so the diagnosis route is SYSTEM-pinned end to
end. That sits against the standing directive that services work from the configuration
of *tenant or platform*, and `09-infrastructure-devops.md` requires super-admin-only to be
a documented per-key exception rather than a blanket prefix. Not changed here (the lane
implemented the new usage consistently with existing `nlp.*` policy). Recommendation:
split the prefix — keep engine-level/safety-critical keys SYSTEM-pinned, and let
`nlp.ner` / `nlp.diagnosis` follow the `text.*` / `guardrail.*` tenant → SYSTEM cascade,
which is the same class of choice (which fine-tuned checkpoint serves this tenant) that
is already tenant-configurable everywhere else. `guardrail.` left this same list by owner
decision in TASK-735 Phase 0 and is the precedent.

## Change History

| Date | Change |
|---|---|
| 2026-08-23 | Ticket opened. Five-lane read-only assessment commissioned across the six Python services plus the TypeScript config control plane. |
| 2026-08-23 | Assessment complete (`assessment.md`) and plan drafted (`plan.md`). Awaiting owner decisions on the three open questions before implementation. |
| 2026-08-23 | Owner decisions D-1 (pull route splits by cardinality: platform=PULL, tenant=PUSH), D-2 (`global-kv` default, `db-config` reserved for values with their own table), D-3 (Phase 0 first) recorded in `plan.md`. |
| 2026-08-23 | Phase 0 implemented across four worktree lanes and merged to `dev-2.2`. Gates re-run post-merge. C.2 held at `4fa3d1f15` for Phase 1 per owner decision. |
| 2026-08-23 | Phases 1 and 1.5 implemented across three worktree lanes and merged to `dev-2.2`. Control plane generalised (non-numeric values, registry-driven payload), tenant-secret plane widened, env drift gate extended to Python (declared surface 40 → 652). |
| 2026-08-23 | Round 2 merged: invalidation push (3 of 6 services wired), `modelWeights` loop closed, text-path BYO delivery gap closed, seed vocabulary widened, and **C.2 landed** — no hardcoded nlp model ids remain. |
| 2026-08-23 | Round 2 lane R2-B: gateway resolves the second (`nlp.ner`) selection for `/diagnosis/suggestions` and injects both; C.2 (`4fa3d1f15`) merged, so the route works again with no literal. `nlp.*` SUPER_ADMIN-only tension recorded for owner decision. |
