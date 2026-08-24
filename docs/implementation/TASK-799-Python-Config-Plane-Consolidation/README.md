# TASK-799 — Python Services Config-Plane Consolidation

| Field | Value |
|---|---|
| Status | Review — all phases implemented and verified; three items need an owner decision (see §Open) |
| Type | refactor / infrastructure |
| Branch | `dev-2.2` |
| Scope | `apps/{stt,text,guardrail,nlp,harness,tts}`, `packages/applications/src/services/{settings-registry,effective-config,ai-provider-connection,ai-task-default}`, `apps/api/src/modules/internal`, `apps/admin-console` |
| Opened | 2026-08-23 |
| Last verified | 2026-08-24 — full `verify` suite green (see §Final verification) |

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
Final numbers and gate evidence are in [§Final verification](#final-verification-2026-08-24-dev-22-primary-checkout);
the three items still needing an owner decision are in [§Open](#open--needs-an-owner-decision).

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

### Round 4 — `db-config` resolver + SYSTEM connection rows (merged 2026-08-24)

**The `db-config` tier is open on the READ path only, and the asymmetry is deliberate.**
`EffectiveSettingsService` now dispatches `storage.platformDefault.*` to the SYSTEM
`TenantStorageConfig` row through the SAME pure cascade the upload path uses — a
dispatch adapter, not a second cascade and not a new table. Writing stays refused,
because writing a `db-config` key means CAS-updating a row in a dedicated table whose
service carries semantics the registry lane cannot express (super-admin assertion,
version-0-means-create, per-field merge, phantom-write suppression, RFC 7232 ordering,
provider-factory invalidation). Reading has no such content — it is "which tier answered
and what did it say". This mirrors `models.*`, which already reads through the facade and
writes through its own service.

Two details that are load-bearing:
- The resolver reads via `findAllTenantDefaults(SYSTEM)`, NOT `findSystemDefault` — the
  latter swallows lookup errors and returns `null`, which is right for an upload and
  catastrophic for a config read (an unreachable DB would become "no opinion" → the
  descriptor default). Pinned by a test.
- Harness's claim-check `secure` flag is DERIVED from the served endpoint's scheme rather
  than kept as a second setting. Two settings that can disagree about one fact is how a
  store gets told to speak plaintext to an `https://` host.

**The systemic fix: `consumed-by-resolvability.governance.test.ts`** fails CI if any
`consumedBy` descriptor maps to no resolver lane. Runtime cannot distinguish
"permanently unresolvable" from "transient outage" — both degrade to `null` — which is
precisely how this shipped three times.

**The SYSTEM connection rows already existed; they were KEYLESS.** That was the real
cause of text's post-migration 503s, not missing rows.
`ai-provider-connection.service.ts:312` skips keyless rows on BOTH tiers, so every
self-hosted engine was simultaneously resolvable (`resolveConnection`) and undeliverable
(the override fold) — and `apps/text` reads only the fold. The four self-host rows now
carry an encrypted `not-needed` placeholder; `llm:built-in` stays keyless because it is
in-process with no endpoint to authenticate to.

`rerank:tei` and `vector:qdrant` were deliberately NOT seeded: **no delivery path exists
for them.** Harness holds no DB handle, its retriever runs inside a Temporal activity
with no gateway request to inject into, and `EffectiveConfigResponse` has no
`connections` block. Seeding them would have produced a row that looks correct and
silently does nothing.

**Verified end to end on local infra**, not just by unit test: the four rows read back
`keyed=YES / keyVersion=1`, the stored value is real Vault Transit ciphertext
(`vault:v1:…`), and it decrypts to `not-needed` under `hope-globalsetting` — the key
`VAULT_TRANSIT_KEY` names and the runtime resolver uses.

**Operational notes for any non-local environment:**
1. `SECRETS_PROVIDER=vault` must be set at seed time or rows are created keyless again
   and text still 503s. The seed warns rather than letting that surface as a 503.
2. **The seed is CREATE-ONLY** — confirmed empirically: re-running it skipped all
   sixteen existing rows and left them keyless. An environment with existing rows needs
   the four self-host rows keyed through the admin route, or deleted first.
3. `pnpm db:all` cannot be run by an agent — Prisma refuses destructive commands when it
   detects Claude Code. A human must run it.

Still open: `apps/text` registers provider ALIASES `openai_compat` and `azure-openai`
with no matching row (the `llm` rows must equal `AI_MODEL_PROVIDERS` exactly, enforced by
a test), so a caller selecting an alias name gets no override → 503. A gateway/text
naming concern, not a seed one.

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

### Phase 2 lane B — `apps/text` (complete, worktree `worktree-agent-a98ce73d9cf651e2b`)

**121 env-reachable pydantic fields → 9.** Plus three names read outside pydantic by
`packages/py-env` (`CI`, `HOPE_SECRETS_DIR`, `HOSTNAME`) = **12 variables**, the plan's target.

The nine survivors are the bootstrap floor and nothing else: `TEXT_PORT`, `TEXT_LOG_LEVEL`,
`TEXT_GATEWAY_URL`, `TEXT_REDIS_URL`, `TEXT_OTEL_EXPORTER_ENDPOINT`,
`TEXT_EXTERNAL_GUARDRAIL_BASE_URL`, `INTERNAL_ACCESS_TOKEN`, `NODE_ENV`,
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`.

| Sub-config group | Before | After | Where it went |
|---|---:|---:|---|
| Per-provider blocks — endpoint / credential / model / capacity / vendor extras (ollama 5, azure 11, bedrock 11, openai 8, anthropic 7, vertex 8, openai_compat 6, vllm 8, llama_cpp 4, sarvam 2, tei_embed 5) | 75 | 0 | `AiProviderConnection` + `AiTaskDefault` + `AiRuntimeProfile`, injected per request |
| `CircuitBreakerConfig` 5 + `QueueConfig` 2 + `JudgeConfig` 5 | 12 | 0 | one `AiRuntimeProfile` keyed `(provider, lane ∈ {user, judge})` |
| `ExternalGuardrailConfig` | 8 | 1 (`base_url`) | posture split by cardinality — platform half `global-kv`/PULL, tenant half PUSHED |
| Root `Settings` (host/debug/cors ×2/httpx ×2/otel ×7/metrics/probe/retention/service_token) | 20 | 4 (`port`, `log_level`, `gateway_url`, `otel_exporter_endpoint`) | derived from what the process already knows, or deleted with no reader |
| `RedisConfig` (`task_ttl_seconds`, `stream_max_len`) | 3 | 1 (`redis_url`, promoted to root) | in-code storage-hygiene bounds |
| `InternalAccessConfig` | 1 | 1 | unchanged — the one shared internal credential |
| `TelemetryPhiGuardConfig` | 2 | 2 | unchanged — the PHI boot guard |
| **Total** | **121** | **9** | |

Separately, the 20-name `TEXT_V2_*` alias window is closed — those were `AliasChoices` on the
root fields above rather than fields of their own, and nothing in the repo read the other side.

#### What changed in kind, not just in count

**Provider availability stopped being an env var.** `_register_provider_factories` registered a
provider only when its `base_url` happened to be non-empty, so a pure-BYO tenant got a 404
saying the provider did not exist when what was actually missing was the PLATFORM's connection —
which that tenant was never going to use. Registration is unconditional now and resolution
decides at call time, so the same request gets a typed 503 naming the `AiProviderConnection` row
an admin has to create.

**Fail-closed went from 3 adapters to 11.** `TEXT_<PROVIDER>_BASE_URL` was the same defect as
`TEXT_<PROVIDER>_API_KEY` one field over — a process-wide value no tenant could override — so the
self-hosted engines fail closed on a missing connection exactly as the BYOK ones do. There is no
longer any code path that builds an SDK client without an explicit, tenant-attributable
credential. `test_task602_byok_credentials.py` iterates the registry and now covers all eleven.

**`TEXT_SARVAM_MODEL` was the one `*_MODEL` that reached the wire** (`sarvam.py` → the request's
`model` field), so it was a process-wide model SELECTION for every tenant. It resolves from
`AiTaskDefault` and RAISES when unresolved — omitting the field would hand the choice of
translation model to the vendor's own default. The other ten `*_DEFAULT_MODEL` fields only fed
`get_info()`; the catalogue is `AiModel` on the gateway.

**Three booleans that could contradict their own source are gone.** `otel_enabled` follows the
presence of a collector address, `otel_insecure` follows its scheme, and the deployment
environment follows `NODE_ENV`. The endpoint default is EMPTY — a default address would turn
export on everywhere.

**What is left in code is a FLOOR, not a default** (`core/runtime_defaults.py`): the ceiling that
keeps one wedged upstream from exhausting the process until the control plane answers. Never the
intended operating value, uniform across providers, and deliberately not settable.

#### Behaviour changes an operator must know about

1. **A deployment that sets only `TEXT_SERVICE_TOKEN` and not `INTERNAL_ACCESS_TOKEN` will 401 on
   every gateway→text hop.** The legacy per-pair token is no longer ACCEPTED inbound (owner
   decision D-D says one shared token; a second accepted credential is a second thing to rotate).
   The gateway already prefers `INTERNAL_ACCESS_TOKEN` and only falls back, so a deployment that
   sets the shared token is unaffected.
2. **Every provider — including the self-hosted engines — needs a resolving `AiProviderConnection`
   row.** A KEYLESS row injects on neither tier by design, so a SYSTEM row for LM Studio / Ollama /
   vLLM / llama.cpp / TEI must carry the keyless-local placeholder its engine expects
   (`not-needed`) rather than be left blank.
3. **`TEXT_BEDROCK_GUARDRAIL_ID` / `_VERSION` moved onto the connection.** A Bedrock Guardrail
   belongs to the AWS account the request authenticates against, so a process-wide id would have
   applied one tenant's guardrail — from an account where it does not exist — to everyone.
4. **`TEXT_AZURE_CONTENT_FILTER_SEVERITY` is deleted, not migrated.** Nothing read it, and it could
   not have worked: Azure's content filter is configured on the Azure RESOURCE, not per request.
5. **`/providers` and `/health` report differently.** A BYOK adapter has no process-level connection
   to probe, so `health_check()` returns True — "no negative evidence", because `PoolHealthTracker`
   acts only on a POSITIVELY known-unhealthy result. Self-hosted adapters probe the last endpoint
   they served.
6. **The batch-embedding worker fails closed** when its queue envelope carries no connection. The
   capability was net-new and unused; the worker has no gateway to ask and must not invent an
   endpoint (D-1 rule 2).

#### Left for the orchestrator — outside lane B's file boundary

**`effective-config.service.ts` needs an `externalGuardrail` view.** The response groups there are
hand-shaped views (`retentionView` / `concurrencyView`), not a generic dotted-key fold, so
`consumedBy` alone does not put a key on the wire. `apps/text` already consumes the group
(`core/effective_config.py::external_guardrail` → `{ enabled, timeoutS, maxRetries,
retryBackoffMs, requireMedical, includeReasoning }`) and keeps its in-code floors until it lands —
and those floors ARE the retired env defaults, so nothing changes behaviour in the meantime. The
same is true of the `generation` group backing `core/defaults.py`.

**The gateway must PUSH the tenant guardrail policy.** `GenerateRequest.guardrail_policy` is the
receiving half of the D-1 push contract; `TextRequestEnrichmentService` does not populate it yet.
Absent, the platform default stands, which is today's behaviour.

### Phase 3 lane F — the declared-but-never-read gate (worktree `worktree-agent-a185bbf3740fcaecc`)

Phases 0-2 deleted ~95 dead settings fields, **every one found by hand** — which is the whole of
assessment RC-3 ("coverage equals the set that existed on the day someone ran the sweep"). Nothing
stopped the next ~95. Plan items 3.2 and 3.3.

**The check** — `pnpm env:python-dead`, a new `--dead` mode on `scripts/python-env-surface.py`
(the existing machinery, extended; no second tool). A settings field `F` on class `C` in service
`S` counts as READ when the non-test Python under `apps/S/` contains either:

| | Rule | Why it is written that way |
|---|---|---|
| R1 | an attribute LOAD `<expr>.F` that is **not the callee of a call** | `stt` had a live `resolve_worker_concurrency()` function AND a live `worker_concurrency()` snapshot METHOD while the FIELD of that name was dead. A substring grep credits the field for both; this credits neither. A Store context (`settings.F = v`) is a WRITE — which is what the control-plane overlay does, and a value written but never read is the defect being hunted. |
| R2 | a string literal exactly `"F"`, **outside the body of class `C`** | Indirect reads are spelled `getattr(settings, "streaming_max_concurrent", 0)`, the `(metric, attr)` table in `harness/eval/ci.py`, and the overlay table in `stt/core/control_plane.py`. The "outside class `C`" qualifier is what makes it sharp: `@field_validator("rrf_k")` and `validation_alias=moved_alias("storage_provider")` NAME a field without consuming it — without that qualifier every validated field is credited by its own declaration and the check finds nothing. |

Two limitations are documented in the source and both UNDER-report, because a gate that cries
wolf gets disabled: matching is by name within a service (not by resolved receiver type), and a
field listed by bare name in an indirection table is credited even if nothing later `getattr`s it.

**Why it is a stdlib AST pass and not introspection.** The manifest half needs pydantic because an
env NAME is not textually present; this half needs only the FIELD name and the read, both of which
are. So it runs on a bare `python:3.11-slim` with zero installs (importing all six services is not
affordable in a validate-stage job), it cannot go stale behind an un-regenerated manifest, and it
runs from any worktree with no conda env. Verified against system Python 3.9 with no pydantic
installed.

**Two self-defences, because a gate that is green by accident is worse than no gate.**
`INTENTIONALLY_UNREAD` is SELF-CLEANING — an entry naming a field that no longer exists, or one
that something now reads, fails the check, so it cannot rot into permanent amnesty. And
`_assert_rule_is_live()` runs a synthetic fixture through the rule on every invocation and refuses
to report at all if the discrimination has stopped working. (That canary earned its place
immediately: its first version passed while R1 was deliberately broken, because the fixture had no
method INVOCATION in it.)

**What it found, on a tree where Phases 0-2 had already swept by hand:** 5 fields out of 400.

| Field | Disposition |
|---|---|
| `harness:RetrievalConfig.rrf_k` | **DELETED.** Undeliverable, not merely unused: the installed `qdrant-client` `FusionQuery` accepts only `fusion` (verified — `model_fields` is exactly `{'fusion'}`), so there is no API to pass `k` to. `qdrant_store.py` said so in a NOTE and kept the knob "for forward-compat"; an operator setting `HARNESS_RETRIEVAL_RRF_K=42` changed nothing. |
| `harness:RetrievalConfig.qdrant_api_key` | **WIRED, not deleted.** A declared credential that reached no client: `KnowledgeQdrantStore.__init__` takes `api_key`, and BOTH construction sites (`temporal/activities.py::_hybrid_retriever`, `api/endpoints/knowledge.py::_qdrant_store`) omitted it. `HARNESS_QDRANT_API_KEY` was parsed, validated by a bespoke empty-string validator, logged as configured, and dropped — so a secured in-cluster Qdrant would have been unreachable while the config claimed otherwise. Deleting it would remove the only way to authenticate; it is now passed at both sites. |
| `tts:AzureSpeechConfig.max_concurrent`, `tts:SarvamConfig.max_concurrent`, `tts:SarvamConfig.use_streaming` | **REPORTED + allow-listed as a HANDOFF.** `apps/tts` belongs to a sibling lane. All three are written by `tts/core/control_plane.py` from the registry and read by nothing, so a descriptor, a registry key and an overlay entry all exist to move a value that lands nowhere. The allow-list entries name the finding and the fix; the staleness rule forces their removal when the tts lane acts. |

Nothing dead in `apps/text`, `apps/stt`, `apps/guardrail`, or `packages/**` — the latter declares
no `BaseSettings` classes at all (`packages/py-env` only supplies source plumbing).

**Existing tests did not catch the `qdrant_api_key` defect and could not have.**
`test_qdrant_api_key.py` already proved each half in isolation — the config CAN hold a key, the
store CAN present one — and nothing asserted they were connected. That is RC-3's shape exactly. A
`TestFactoriesPassApiKey` class now covers both construction sites (seen RED first: `assert None ==
's3cret-key'` at each).

**CI.** New `python-dead-settings` job in `.gitlab/ci/validate.yml`, next to `env-drift-check`, on
`.rules-any-python`. The pair is deliberately symmetric and they fail for opposite reasons:

| Gate | Fails when |
|---|---|
| `env-drift-check` | an env var is READ but not DECLARED — a generated artifact disagrees with the source that reads it |
| `python-dead-settings` | an env var is DECLARED but never READ — an operator can set it and nothing happens |

**Found and NOT fixed (outside this lane's boundary), reported for an owner:**

1. **`apps/nlp` makes the generated env surface non-reproducible.**
   `nlp/core/config.py:587` declares `dictionary_path: str = Field(default=str(get_project_root() /
   "data" / "dictionaries"))` — an ABSOLUTE PATH derived from the checkout location. `pnpm env:sync`
   therefore emits a different `.env.sample` on every machine, so `pnpm env:sync --check` can only
   pass on the machine that last ran `env:sync`, and in CI it must fail on that line regardless of
   what changed. It is also a hardcoded-config smell in its own right (rule 00 §Configuration
   Principles). This is the ONLY residual hunk in this lane's `env:sync --check` output.
2. **`pnpm env:python-surface --check` is in no CI job**, though the script's header claimed it runs
   in `lint-python`. It cannot: `lint-python` is `python:3.11-slim` + ruff, and that check needs all
   six services to import. The header now says so rather than asserting a gate that does not exist.
   The new dead-field gate is unaffected — it deliberately does not depend on the manifest.

## Final verification (2026-08-24, `dev-2.2`, primary checkout)

Full `verify` suite — lint, typecheck and test across both languages. **~34,000
tests, zero failures.**

| Stage | Result |
|---|---|
| `pnpm lint` (TS) | 40 / 40 |
| ruff (Python) | clean — 6 services + `py-env`, `py-otel` |
| `pnpm typecheck` (TS) | **45 / 45** |
| mypy (Python) | clean — **475 source files** across 6 services |
| TS unit (1221 files) | **20,444 passed** |
| vox · admin-console | 4,214 · 2,017 |
| stt · harness · text | 2,996 · 1,595 · 1,366 |
| nlp · tts · guardrail | 508 · 399 · 298 |
| py-env + py-otel | 109 |
| `env:sync --check` | OK — 138 TS keys + 359 Python fields · 538 globalEnv |
| `env:python-dead` | OK — 395 fields, every one read (3 allow-listed) |

Two suites are excluded, both pre-existing and reproduced identically on the
pre-ticket base: `test_streaming_quality_scorecard` (a latency baseline calibrated
on faster hardware than this machine) and `apps/stt/tests/e2e` (needs live infra).

### What the ticket moved

| Measure | Before | After |
|---|---|---|
| Env-reachable settings fields | ~579 | governed and declared |
| Declared to ANY governance gate | **40** | **~500** |
| DB→Python channel capacity | 22 keys, numeric, SYSTEM-only | any dataType, registry-driven |
| Drift gates | 1 (TS-only) | 2, opposite directions, both Python-aware |
| BLOCKERs | 5 | **0** |

Per-service env-reachable fields: text 121 → 12, stt 110 → 34, tts 53 → 22,
nlp 67 → 41, guardrail 27 → 21, harness 145 → 130.

**On the harness number, stated plainly:** the ~15 target in `plan.md` was wrong,
and the correction matters more than the miss. Under the Phase 1 contract a
MIGRATED tuning knob keeps its env field as the bootstrap fallback — governance is
achieved, the count is not reduced. Only deletion reduces it, and deletion requires
fail-closed control-plane resolution. Where a lane could close the env path
outright it did (stt/tts used a dead `validation_alias` with `populate_by_name`
off, generalising the TTS BYOK guard from credentials to tuning knobs); where the
value must survive a cold start with no control plane, the env field correctly
remains.

### Infrastructure fixed along the way

- **`scripts/python-env-surface.py` could not run at all** — its `git ls-files`
  subprocess dies with SIGABRT under a sandboxed interpreter, in worktrees AND in
  the primary checkout. Now falls back to a filesystem walk. Deliberately not a
  silent equivalent: an untracked scratch file is picked up where git would omit
  it, which is the safe direction for a DRIFT gate.
- **Generated env artifacts were machine-dependent.** Two defaults resolve at
  import time from the generating checkout (`SPELLING_CORRECTOR_DICTIONARY_PATH`
  from the repo root, `HUGGINGFACE_CACHE_DIR` from `Path.home()`), so committed
  samples leaked a developer's home directory and `env:sync --check` could only
  ever pass on one machine — it could never have passed in CI. Recorded defaults
  now normalise to `<repo>`/`<home>` tokens; runtime values untouched.
- **`pnpm typecheck` was ~1-in-3 flaky, and it was masking five real errors.**
  `typecheck`/`build` declared `dependsOn: ["^build", "^db:generate"]`; the `^`
  means UPSTREAM packages only, so `@arcaai/database:typecheck` never waited for
  its OWN `db:generate` and tsc read a half-written Prisma client (TS6053). Adding
  the unprefixed `db:generate` closed it — 6 consecutive `--force` runs green,
  where the race previously reproduced within 3. **This was not a `tsBuildInfoFile`
  collision** — those files were already per-package; the first hypothesis was
  wrong and reproducing the failure is what found the real cause.
- **Five pre-existing `apps/api` typecheck errors**, invisible behind that race:
  three constructor-arity drifts (two using bare `{} as any` placeholders, so the
  mocks landed correctly by luck and only `tsc` noticed), a required-but-nullable
  `resultRef`, and `import.meta` under `module: commonjs`.
- **Repo-wide black pass** (180 files) plus a root `[tool.black]`. black resolves
  config from the COMMON BASE of its arguments, so a single invocation spanning
  two apps found no config and fell back to line length 88 — it would have
  rewritten ~600 correctly-formatted files to the wrong width while looking like a
  cleanup. The root block also exposed the mirror bug: `py-env` and `py-otel`
  declare no `[tool.black]`, so even per-path runs had been formatting them at 88.

## Open — needs an owner decision

1. **The PHI boundary moved in harness.** `ensure_inferential_egress_safe` now
   receives `safety_provider=None`: harness no longer egresses to a provider for
   safety screening, it posts to `apps/guardrail`, a first-party peer, like the
   text/nlp hops this guard never gated. Guardrail owns the PHI posture of whatever
   engine IT selects. Net effect: if guardrail selects a cloud engine, the note
   reaches it under guardrail's posture rather than harness's redaction. Recorded
   by test rather than left implicit.
2. **Phase 4 has no authenticated visual pass.** Both console screens build, lint
   clean, pass 2017 tests and scan axe-clean, but rendering them needs a sign-in —
   entering a password is outside what an agent may do. Both-themes verification
   and a real-gateway data pass remain outstanding, so Phase 4 is NOT closed.
3. **Closing the TTS env reads needs a manifest change** in `arca/hope-v2-deployment`
   (remove `TTS_KOKORO_ENABLED` from the `hope-tts` ConfigMap). Note `migrate.sh`
   defaults `RUN_SEED=none` and `hope-v2-dev` pins it — **the seeded row will not
   exist unless seeding is explicitly run**, so this step must not be inferred from
   a green build.

Also outstanding, lower risk: `guardrail.validate` selects an LLM on `apps/text`,
so D-4 was NOT read as reversing TASK-735 Phase 0's tenant-admin posture for it —
flagged, not assumed.

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
| 2026-08-23 | Phase 2 lane B (`apps/text`) complete: 121 env-reachable pydantic fields → 9 (12 variables with the three `hope_env` reads). The eight per-provider blocks, the three-way `TEXT_CB_*`/`TEXT_QUEUE_*`/`TEXT_JUDGE_*` duplication and the 20-name `TEXT_V2_*` window are gone; every adapter resolves its connection per request and fails closed, so fail-closed coverage went from 3 adapters to 11. Two wirings remain outside the lane's boundary — an `externalGuardrail` view in `effective-config.service.ts`, and gateway PUSH of `guardrail_policy`. |
| 2026-08-24 | Phase 3 lane F: `pnpm env:python-dead` added as a stdlib-only AST gate (`python-dead-settings` in CI, the mirror of `env-drift-check`), with a self-cleaning allow-list and a rule canary. Found 5 dead fields on an already-hand-swept tree: `harness` `rrf_k` DELETED (undeliverable — `FusionQuery` has no `k`), `harness` `qdrant_api_key` WIRED (a declared credential both construction sites dropped), three `apps/tts` fields reported and handed off. Two out-of-lane defects reported: `apps/nlp`'s checkout-dependent `dictionary_path` default makes `env:sync --check` non-reproducible, and `env:python-surface --check` is in no CI job. |
| 2026-08-24 | Full `verify` suite green: lint 40/40, typecheck 45/45, mypy 475 files, ~34,000 tests, both drift gates OK. Status → Review. |
| 2026-08-24 | Infrastructure repairs: the Python env-surface generator made runnable (SIGABRT fallback), generated artifacts made machine-portable (`<repo>`/`<home>` tokens), repo-wide black pass + root `[tool.black]`, five pre-existing `apps/api` typecheck errors fixed, and the `pnpm typecheck` race closed by ordering `typecheck`/`build` after their OWN package's `db:generate`. |
| 2026-08-24 | Orchestrator wired guardrail's `external_nlp_client` to forward `calibration` (lane G's out-of-boundary item), closing the `/guard/entailment` degrade-to-`unverified` gap. Test observed RED without the send. |
| 2026-08-24 | **Phase 2 follow-up lane G (`apps/nlp` clinical taxonomies) complete — both sides.** The ontology vocabulary (40 UMLS/SNOMED/RxNorm/ICD-10/LOINC rows), the vitals plausibility bands, the ConText/NegEx trigger lexicon and the five `TOKEN_CLASSIFIER_*` / `NLP_LINKER_*` env fields moved onto `AiModel._metadata.clinicalTaxonomy` of the row `nlp.ner` selects; the gateway (`resolveNerModelInjection`, `AiInferenceController`) resolves and injects them verbatim, and `AiTaskModelSummary` gained the `metadata`/`localPath` fields callers were casting for. `apps/nlp` keeps NO fallback copy — an absent section disables the pass it governs rather than substituting a literal. Entailment split by judgment: the MiniCheck label-token ids and prompt template stay in code (they are the adapter, not a knob), while the calibration bounds and reference pair moved to `_metadata.entailment` and the loader now REFUSES a row declaring no calibration, a different adapter, or mismatched label tokens — closing the "non-MiniCheck model scored on MiniCheck's calibration" hole on a clinical gate. Remaining: guardrail's `external_nlp_client` (lane F's file) must forward `calibration`; until then `/guard/entailment` fails closed to `unverified`. |
