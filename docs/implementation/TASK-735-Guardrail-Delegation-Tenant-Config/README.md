# TASK-735 — Guardrail: delegate judgement to `text`/`nlp`, resolve config tenant-first

| Field | Value |
|---|---|
| Status | In Progress (Phases 0, 1, 2a, 2b, 3, 4-TS, 6 landed; Phase 5 landed for the LLM plane; Phase 4's Python half remains, blocked on G-01) |
| Type | refactor + infrastructure |
| Owner decision date | 2026-08-16 |
| Affects | `apps/guardrail`, `apps/text`, `apps/nlp`, `packages/applications`, `apps/admin-console`, `turbo.json` |

---

## 1. Requirement Analysis

Two standing owner rules, now written into `.claude/rules/00-project-context.md`
§Configuration Principles and `.claude/rules/09-infrastructure-devops.md`:

- **R1 — No hardcoded configuration; env vars minimised.** An engine, model id, endpoint,
  credential, threshold, prompt/criteria string or label taxonomy is config, not a literal.
  Env is the bootstrap floor only.
- **R2 — Tenant config → platform default.** The tenant's own row wins; the SYSTEM-tenant row
  is the fallback for tenants with no opinion. Tenants BYO-key wherever the platform can
  express it.

Applied to `apps/guardrail`, these produce three concrete requirements:

- **G1** — Guardrail resolves provider/model/tuning **tenant-first**, widening to SYSTEM only on
  absence.
- **G2** — Guardrail performs **no inference of its own**. LLM judgement goes to `apps/text`;
  token/text classification goes to `apps/nlp`. Guardrail owns policy, thresholds, verdict shape
  and fail-closed posture — not engines.
- **G3** — Guardrail carries **no hardcoded engine, model, endpoint, credential, criteria string
  or label taxonomy**.

## 2. Current State Evaluation (verified 2026-08-16)

### 2.1 Guardrail is a second, parallel inference stack

`apps/guardrail/src/guardrail/core/config.py` declares six LLM engine sub-configs —
`OpenAICompatConfig` (LM Studio), `OllamaConfig`, `VLLMConfig`, `LlamaCppConfig`,
`AzureOpenAIConfig`, `BedrockConfig` — plus `GlinerConfig` (ONNX NER) and `GroundednessConfig`
(llama.cpp GGUF). It ships its own HTTP adapters (`providers/openai_compat.py`, `ollama.py`,
`guardian.py`, `gliner.py`) and its own model cache.

`apps/text` already owns eleven provider adapters (`text/providers/*`), the BYOK
`provider_overrides` plane, circuit breakers, provider queues and worker pools. `apps/nlp`
already owns model-agnostic token/text classification driven by `AiTaskDefault`
(`nlp/api/v1/rest/classify.py`). Guardrail duplicates both, worse.

### 2.2 Hardcoded configuration (R1 / G3 violations)

| Location | Hardcoded value | Class |
|---|---|---|
| `core/config.py:73-80` | `granite-guardian-4.1-8b` as the default for six task-model fields | model identity |
| `core/config.py:29-36` | `gemma3:latest` ×6 (Ollama engine) | model identity |
| `core/config.py:163` | `hivetrace/gliner-guard-uniencoder-onnx` | model identity |
| `core/config.py:196-197` | `nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF` + `.gguf` filename | model identity |
| `core/config.py:69,139,151` + `:26` | `http://localhost:1234/v1`, `:8000/v1`, `:8080/v1`, `:11434` | endpoint |
| `core/config.py:70` | `api_key: SecretStr("lm-studio")` | **credential literal** |
| `core/config.py:287` | `postgresql+asyncpg://postgres:postgres@localhost:5432/hope` | **credential literal** |
| `core/config.py:292` | default tenant UUID `50000000-…` | tenancy identity |
| `providers/_granite.py:19-32` | three BYOC criteria strings (the actual safety policy) | prompt/policy |
| `providers/_granite.py:35-43` | the `<guardian>` template | prompt/policy |
| `providers/gliner.py:22-70` | `SAFETY_LABELS`, `PII_LABELS`, `ADVERSARIAL_LABELS`, `HARMFUL_LABELS` | taxonomy/policy |
| `core/config.py:44-50,88-94,168-170,224` | `temperature`, `max_tokens`, `guardian_min_confidence 0.75`, `classification_threshold 0.4`, `pii_threshold 0.5`, `entailment_threshold 0.5` | policy thresholds |

Undeclared env surface: `turbo.json#globalEnv` carries only `GUARDRAIL_PORT`,
`GUARDRAIL_SERVICE_TOKEN`, `GUARDRAIL_URL`, `GUARDRAIL_V2_GROUNDEDNESS_ENABLED`,
`GUARDRAIL_VLLM_API_KEY`. Every other `GUARDRAIL_*` field above is an ungoverned config surface.
`GUARDRAIL_VLLM_API_KEY` is additionally a credential in env, which `apps/text` has already
banned for itself (`test_task602_byok_credentials.py`).

### 2.3 Tenant config is read but then discarded (R2 / G1 violation)

`core/tenant_config.py:451` pins the selection row to the SYSTEM tenant:

```python
AiTaskDefaultRead.tenant_id == SYSTEM_TENANT_ID,
```

The tenant-level fallback in `resolve()` only decides which tenant's **`AiModel`** row is
preferred once SYSTEM has already chosen the slug. So a tenant's own `guardrail.validate`
selection can never take effect. This is deliberate today and backed on the TS side by
`GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['guardrail.', 'nlp.', 'harness.']`
(`packages/applications/src/services/ai-task-default/constants.ts:102`, owner directive
2026-07-17) plus `globalOnly` on the three `models.guardrail.*` descriptors. **The new owner rule
reverses that directive for `guardrail.*`** — see §5 Open Decisions.

### 2.4 BYO key is structurally impossible for the safety plane

`resolve_guardian_engine` states it plainly (`tenant_config.py:595`): *"base_url / api_key still
come from env"*. The unified connection plane is keyed by
`ProviderService = 'llm' | 'stt' | 'tts'` (`ai-provider-connection/constants.ts:14`) — guardrail
is not a service in it, so no tenant can attach a credential to it under any tier.

### 2.5 The call-cycle constraint (must be designed around, not discovered later)

`apps/text` gates **every** `/generate` on guardrail
(`text/api/endpoints/generate.py:302-331`, fail-closed). If guardrail then calls
`text/generate`, the cycle `text → guardrail → text → guardrail → …` is unbounded, and under
saturation the safety plane deadlocks behind the user-facing pool it is protecting. This is the
same concern `tenant_config.py`'s module docstring raised about the gateway, and it is the single
biggest design risk in this ticket.

### 2.6 What is already right (do not regress)

- Fail-closed selection: missing DB selection ⇒ 503, never an env fallback
  (`core/dependencies.py:94-99`, `_resolve_aux_model_id`).
- Tenant-keyed cache: `f"{task_key}::{tenant_id}"` (`tenant_config.py:392`).
- Groundedness degrades to `unverified`, never to `grounded`.
- Aux models are lazily loaded behind an idle-TTL cache whose retention comes from the control
  plane, not env.
- The peer-client shape to copy already exists twice: `nlp/services/external_text_client.py`
  and `text/services/external_guardrail.py`.

## 3. Target Architecture

```
                    ┌──────────── apps/guardrail (policy only) ────────────┐
 caller ──X-Tenant-Id──▶│ resolve policy: tenant row → SYSTEM row            │
 (+provider_overrides)  │ thresholds · criteria (PromptTemplate) · taxonomy  │
                        │ verdict shape · fail-closed posture · jobs/queue   │
                        └───┬────────────────────────────────┬──────────────┘
                            │ LLM judgement                  │ classification / spans
                            ▼                                ▼
        apps/text  POST /generate/internal/judge      apps/nlp  POST /classify/{tokens,text}
        (outside the moderation gate, own pool)       (AiTaskDefault-driven, model-agnostic)
```

Guardrail keeps **zero** provider adapters, **zero** resident model weights (after Phase 6),
**zero** engine env vars.

Credential flow (BYOK end-to-end, decrypt stays gateway-side): the party that already holds
gateway-injected `provider_overrides` forwards them to guardrail; guardrail passes them through
verbatim on the delegated `text` call. Guardrail never decrypts, never stores, never logs them.
Model *selection* stays independent of credentials: it comes from `AiTaskDefault`
(`guardrail.validate`), tenant row first.

## 4. Implementation Plan

TDD throughout (`.claude/rules/01-development-workflow.md` Phase 4). Each phase is independently
shippable and leaves the fail-closed posture intact.

### Phase 0 — Governance flip (TS)

1. Remove `'guardrail.'` from `GLOBAL_ADMIN_ONLY_TASK_PREFIXES`; keep `'nlp.'`, `'harness.'`.
2. Drop `globalOnly` from the three `models.guardrail.*` descriptors
   (`model-defaults.descriptors.ts`), retarget `editableBy` at the tenant-editable
   `AiTaskDefault` resource, rewrite the "(global admins only)" copy.
3. Add a **platform ceiling** so a tenant cannot select an unvetted safety model: the bound is
   an entitlement (`featureGuardrailModelSelection`) plus the existing
   `AI_TASK_MODEL_TASK_TYPES` task-type check; an unapproved slug is a 403 privilege boundary,
   not a 404.
4. Tests: tenant write to `guardrail.validate` succeeds under the entitlement and 403s without
   it; `getEffective` returns the tenant row when present, SYSTEM when absent;
   `nlp.*`/`harness.*` behaviour unchanged.

### Phase 1 — Tenant-first resolution (Python)

1. `tenant_config.py::_load_from_db` — read `AiTaskDefault` for `tenant_id IN (request, SYSTEM)`
   and rank tenant-owned above SYSTEM (the existing `_row_rank` helper is already written for
   this and currently unused on the task-default side).
2. A **DISABLED** tenant row is a veto (503), not a silent fall-through to SYSTEM — matching
   `AiProviderConnection`'s three-state semantics.
3. Selection stays fail-closed; tuning (`AiRuntimeProfile`) keeps failing safe.
4. Tests: tenant row wins · absent tenant row ⇒ SYSTEM · disabled tenant row ⇒ 503 · cache is
   tenant-keyed (no cross-tenant bleed) · negative caching unchanged.

### Phase 2 — Delegate LLM judgement to `text`

1. New `apps/text` route `POST /generate/internal/judge` — structurally **outside** the
   `ExternalGuardrailClient` gate (no bypass flag on the public contract), `X-Service-Token`
   required, its own provider queue/semaphore + circuit breaker so it cannot starve behind the
   user-facing pool. A recursion guard asserts the judge route never invokes the guardrail gate.
2. New `apps/guardrail/services/external_text_client.py`, modelled on
   `nlp/services/external_text_client.py`: `X-Service-Token` + `X-Tenant-Id`, bounded retry,
   forwards `provider_overrides` verbatim, and a **declared fail posture** — exhausted budget ⇒
   `allowed: False` (a moderation verdict has a safe default; the judge must never fabricate one).
3. Repoint `medical/validate`, `medical/validate/batch` and the LLM path of
   `guardrail/analyze` at the client. The verdict shape and status codes on the wire are
   unchanged (`text`'s 422-vs-503 mapping depends on them).
4. **Delete** `providers/openai_compat.py`, `providers/ollama.py`, `providers/guardian.py`,
   `providers/_granite.py` (criteria move to Phase 4), `resolve_guardian_engine`,
   `build_guardian_provider`, and the six engine sub-configs in `config.py`.
5. Metering: the judge call's tokens are guardrail spend, not tenant spend. Attribute with
   `costBasis: INTERNAL` and derive `funding` from the connection tier that supplied the key
   (never stamp it) — the existing `guardrail_usage_from_verdict` ride-back
   (`text/models/usage.py:304`) is repointed, not duplicated.
6. Tests: judge route never calls the guardrail gate (cycle guard) · saturated user pool does not
   block a judge call · `text` outage ⇒ guardrail returns not-allowed, never allowed · BYOK
   override reaches the provider adapter · no `provider_overrides` value is ever logged.

### Phase 3 — Delegate classification to `nlp`

1. Guardrail's `/guardrail/redact` and the content-safety/PII/adversarial paths call
   `nlp` `/classify/tokens` (spans) and `/classify/text` (labels), passing the resolved label
   taxonomy per request.
2. Add the `AiTaskDefault` keys `nlp` needs for the guardrail taxonomies, or reuse
   `guardrail.safety` resolved on the `nlp` side — decide with §5 D3.
3. **Delete** `providers/gliner.py`, `GlinerConfig`, and the GLiNER branch of the aux model cache.
4. Tests: span offsets survive the round trip byte-exactly (redaction correctness) ·
   chunking (`guardrail.redact.chunkChars`) still honoured · `nlp` outage ⇒ redact fails closed.

### Phase 4 — Policy becomes configuration

1. Granite BYOC criteria + the `<guardian>` template move to the **PromptTemplate** plane
   (already tenant-scoped with SYSTEM/tenant governance and an approval gate) — versioned,
   auditable, tenant-overridable. Guardrail resolves them tenant-first.
2. Label taxonomies and thresholds (`classification_threshold`, `pii_threshold`,
   `guardian_min_confidence`, `entailment_threshold`, judge `temperature`/`max_tokens`) become
   `SettingDescriptor`s (`db-config`, tenant → SYSTEM cascade), consumed through
   `core/effective_config.py`. `failMode: closed` for anything that decides a verdict;
   `open-to-default` for pure tuning.
3. A tenant may only **tighten** a safety threshold relative to the platform floor — the floor is
   an entitlement bound, enforced once, server-side (see §5 D2).
4. **Delete** the corresponding `pydantic-settings` fields. What remains in `config.py`:
   host/port/log level, `GUARDRAIL_URL`-class transport addresses, `DATABASE_URL`,
   `GUARDRAIL_SERVICE_TOKEN`, Redis URL, OTEL — i.e. the bootstrap floor, nothing else.
5. Reconcile `turbo.json#globalEnv` + `.env.sample` with what actually survives; delete
   `GUARDRAIL_VLLM_API_KEY` from globalEnv and Vault policy.

### Phase 5 — BYOK end-to-end

1. `provider_overrides` pass-through on every guardrail entry point (peer calls from `text`, and
   the gateway's `ai-inference.client.ts` / `ai-service-proxy.client.ts` paths).
2. Guardrail sources **no** credential from env. Add a
   `test_guardrail_byok_credentials.py` shaped exactly like
   `apps/text/.../test_task602_byok_credentials.py` — a `GUARDRAIL_*_API_KEY` env var must not
   populate anything.
3. Decide whether a tenant may attach a *guardrail-specific* connection or must reuse its `llm`
   connection (§5 D1).

### Phase 6 — Groundedness moves to `nlp` (in scope, owner decision D4)

1. Move MiniCheck hosting to `apps/nlp`, which already owns `core/model_source.py` and
   `services/model_cache.py`, behind an entailment/NLI endpoint. Guardrail then holds **zero**
   model weights and its aux `ModelCache` is deleted outright.
2. Weight staging (`localPath` / `file://` / `s3://` resolution, `allow_network=False`) moves
   with it unchanged — the clinical-gate posture must not soften: an unstaged model still
   degrades to `unverified`, never to `grounded`.
3. Guardrail keeps the groundedness **policy** (`entailment_threshold`, `max_segments`,
   `batch_size` as a governed setting, verdict shape, fail-closed degradation) and calls `nlp`
   per segment batch.
4. **Delete** `services/groundedness_scorer_minicheck.py`, `services/model_cache.py`,
   `core/model_source.py` and `GroundednessConfig`'s weight/runtime fields from guardrail; keep
   `services/groundedness_nli.py` as the policy wrapper.
5. Tests: an `nlp` outage yields `unverified` (never `grounded`) · threshold changes still bite ·
   segment cap still degrades rather than silently skipping · `llama.cpp` runtime knobs no longer
   exist in guardrail's settings.

### Verification criteria

- `pnpm guardrail:test`, `text:test`, `nlp:test`, `pnpm --filter @arcaai/applications test`,
  `pnpm test:unit` green with output pasted into §Implementation Summary.
- A repo grep proves the absence claim: no model id, engine name, endpoint or key literal left in
  `apps/guardrail/src` outside the bootstrap floor.
- Cross-tenant e2e: tenant A's guardrail selection never serves tenant B.
- Cycle test: a `text/generate` under a saturated pool still gets a judge verdict.

## 5. Decisions (owner-resolved 2026-08-16)

| # | Decision | Resolution |
|---|---|---|
| **D1** | Where does the tenant's credential for the judge call come from? | **Reuse the `llm` `AiProviderConnection`.** Guardrail delegates to `text`, so the tenant's existing LLM vendor account serves the safety plane too. No new `ProviderService`, no second key for tenants to manage. Model choice stays independent via the `guardrail.validate` task key. |
| **D2** | May a tenant weaken its own safety posture? | **No — tighten-only.** A tenant selects a judge model from the platform-approved list, BYO-keys it, and may RAISE thresholds. A platform floor (approved-model list + minimum thresholds) is an **entitlement ceiling enforced server-side**, in one place. Attempting to go below the floor is a 403 privilege boundary, not a 404, and not a silent clamp. |
| **D3** | Who owns the task keys for delegated classification? | **Guardrail keeps `guardrail.*` keys**; `nlp` is the executor and receives the resolved model id on the request, mirroring how `text` receives a caller-supplied model. Guardrail owns policy, `nlp` owns inference. |
| **D4** | Ticket scope | **All six phases**, including moving MiniCheck groundedness hosting into `apps/nlp`. Guardrail ends with zero provider adapters, zero resident weights, zero engine env vars. |
| **D5** | Where do the Granite BYOC criteria live? | **The PromptTemplate plane** — already tenant-scoped, versioned, auditable, and approval-gated. Criteria that decide a clinical verdict get change control; plain thresholds do not need it and stay `SettingDescriptor`s. |

## 6. Risks

- **Latency**: guardrail gains a network hop on the `text` critical path. Mitigation: the judge
  route is in-cluster, keep-alive pooled, and guardrail's existing verdict cache still applies.
- **Availability coupling**: guardrail now depends on `text`/`nlp`. Both fail closed, which is
  correct for a safety gate, but it converts a `text` outage into a *generation* outage rather
  than an unmoderated generation — the intended trade.
- **Governance reversal**: Phase 0 undoes the 2026-07-17 directive. Recorded here deliberately so
  the change is traceable rather than looking like drift.
- **Blast radius**: Phases 2-4 delete a large amount of live code. Each phase must land with its
  tests green before the next starts; do not batch the deletions.

## 6b. Known gaps discovered during implementation

**G-00 — the cascade has exactly two tiers, and guardrail had a third that leaked a customer's
config.** Owner clarification 2026-08-16: SYSTEM (`00000000-…`) is a config TIER holding platform
defaults; `50000000-…` ("Global", `SEED_TENANT_ID`) is a **customer tenant** used as a
platform-admin playground before config is promoted into SYSTEM. It is not a tier and must never
appear in a runtime cascade.

`core/tenant_config.py:338-344` fell back to `self._default_tenant_id`, whose value comes from
`DatabaseConfig.default_tenant_id` — hardcoded to `50000000-…` at `core/config.py:292`. Two
consequences, both live before the fix: a tenant with no guardrail rows resolved **the Global
customer tenant's** safety configuration, and a request with no `X-Tenant-Id` silently acted as
that customer. The fix deletes the knob outright rather than repointing it at SYSTEM — SYSTEM is
already the declared widening target inside `_load_from_db`, and a second knob naming it is exactly
the ungoverned surface R1 bans. This also closes the `config.py:292` "needs decision" item raised
by the inventory. **G-01's resolver must implement the same two-tier shape.**

**G-07 — a lost `X-Tenant-Id` silently downgrades a tenant to the platform floor (posture decision).**
G-00's fix makes a tenant-less request resolve SYSTEM only, which is correct for the callers that
legitimately have no tenant: the job processor passes `tenant_id=None` **by construction** ("jobs
carry no tenant"), as does the harness by-slug weight lookup — failing those closed would break the
job queue. But the resolver cannot distinguish those from an HTTP `/medical/validate` whose header
was simply dropped in transit. And because D2 makes tenants **tighten-only**, SYSTEM is by
definition the LOOSEST admissible posture — so a dropped header silently serves the platform floor
to a tenant that had chosen something stricter, with no error anywhere.

**Owner decision 2026-08-16 — neither option; fix it at the source.** Guardrail decisions must be
attributable, so **`X-Tenant-Id` is MANDATORY on every internal request** carrying tenant-scoped
work. An absent header is a defect in the CALLER, not a case for the callee to paper over with a
default. Genuinely tenant-less internal work (queue jobs, by-slug weight lookups) must declare
itself as such rather than arriving with an absent header indistinguishable from one dropped in
transit. Scoped as **TASK-737** — a propagation audit across every peer client and gateway proxy,
then the mandatory-header enforcement. The SYSTEM-only resolver behaviour stays as the interim
until that lands.

**G-08 — a tenant's broken selection quietly becomes SYSTEM's answer (pre-existing, measured).**
A tenant whose ENABLED `AiTaskDefault` points at an ABSENT or DISABLED `AiModel` resolves
**SYSTEM's** selection instead of failing. Confirmed empirically during the G-00 fix: the resolver
returns `provider=lm-studio, model=system-guardian, source=00000000-…`. This predates TASK-735 and
was not introduced by it.

It sits badly beside the veto rule established in Phase 1: a DISABLED task-default row is a VETO
(503), but a task-default pointing at an unusable model degrades silently to the platform default.
Both express a tenant intent that cannot be honoured; only one of them fails loudly. It is the same
"one party's broken intent becomes another tier's answer" shape as G-00, one level down.

**Owner decision 2026-08-16 — keep degrading, but log it.** Behaviour is unchanged (fall through to
SYSTEM), so no tenant currently relying on it breaks; what changes is that it stops being silent.
Emit a WARNING carrying `tenant_id`, `task_key`, the unusable `modelSlug`, and why it was rejected
(absent vs DISABLED). Note the deliberate asymmetry this leaves in place: a DISABLED task-default
row is a hard veto while a task-default pointing at an unusable model is a logged degradation. That
is intentional, not an oversight — record it in the resolver docstring so it is not "fixed" later
by someone reading only the veto rule.

**G-01 — there is no tenant-cascade read surface for `db-config` keys (blocks Phase 4's Python half).**
Phase 4's descriptors are authored and registered (`guardrail-policy.descriptors.ts`), but
`EffectiveSettingsService.resolveEffective` currently throws *"no effective resolver"* for
`db-config` keys outside `pipeline.*` / `models.*`. The existing guardrail pulls
(`guardrail.modelCache.*`, `guardrail.redact.chunkChars`) go through a **platform-only** lane, not a
tenant → SYSTEM cascade. So nothing can yet READ the new `guardrail.policy.*` keys tenant-first
from either language. Phase 4 must add that generic resolver (calling `resolveGuardrailPolicyValue`
/ `assertGuardrailPolicyFloor`) before the Python side can consume the keys — this is net-new work
the original plan did not account for.

**G-02 — the tighten-only floor direction is per-key, not global.** Two of the four thresholds are
*lower-is-stricter* (`classificationThreshold`, `piiThreshold` — GLiNER flags at score ≥ threshold,
so a lower value catches more) and two are *higher-is-stricter* (`guardianMinConfidence`,
`entailmentThreshold` — both gate a POSITIVE claim, so a higher value is harder to earn). Taxonomies
are *superset-is-stricter*. A single "tenant value must be ≥ floor" rule would have inverted the
guarantee on half the keys.

**G-03 — the entitlement ceiling above the SYSTEM floor is not built.** The existing
`TENANT_OVERRIDE_CLAMPS` / `clampTenantSetting` infrastructure expresses a MAXIMUM by construction
and only composes with *lower-is-stricter* keys. Extending it to the *higher-is-stricter* half
requires changing shared clamp infrastructure. Until then, decision D2's floor is enforced by
`assertGuardrailPolicyFloor` against the SYSTEM row only.

**G-04 — `clampTenantSetting` is the wrong primitive for D2.** It silently substitutes a clamped
value; D2 requires a 403 rejection. Phase 4 therefore introduced a separate assert-and-throw
function rather than reusing the clamp. Do not "simplify" these back together.

**G-05 — the D2 entitlement ceiling is not buildable within a narrow TS file scope; it needs a
`packages/database` migration.** Phase 0's required change #3 asks for a
`entitlements.featureGuardrailModelSelection` entitlement gating whether a tenant may bind
`guardrail.*` (`AiTaskDefault.modelSlug`) to its own selection at all (distinct from G-03's
`assertGuardrailPolicyFloor`, which gates POLICY thresholds/taxonomies, not model selection). A
boolean plan/tenant entitlement is not descriptor-metadata alone: `IEntitlementsService.isFeatureEnabled`
reads a real field on `ResolvedFeatures` (`resolve-entitlements.ts`), backed by a
`PlanEntitlement`/`TenantEntitlement` column, and `plan-matrix-parity.test.ts` enforces that the
seed (`packages/database/.../seed/15-entitlements.ts`) and `entitlements.constants.ts` carry the
SAME field set — so adding the field to one without the other, and without the Prisma migration,
fails that governance test. Landed instead: the `entitlements.descriptors.ts` catalog entry
(metadata only, explicitly marked NOT YET ENFORCED in its description) plus the half of D2 that
*is* self-contained in `AiTaskDefaultService` — a `guardrail.*` binding for a non-SYSTEM tenant
must resolve `modelSlug` to an ENABLED SYSTEM-tenant `AiModel` row (the platform-approved list),
403 otherwise, regardless of caller role. **Residual gap**: until the entitlement is wired, ANY
tenant admin may select ANY platform-approved-catalog guardrail model with no additional grant —
the approved-LIST floor holds, but the per-tenant GRANT half of D2 does not yet. Wiring it needs:
a `packages/database` migration (`entitlement.prisma` + `seed/15-entitlements.ts`),
`resolve-entitlements.ts` (`ResolvedFeatures`/Input types + merge logic),
`entitlements.constants.ts` (`PLAN_ENTITLEMENT_DEFAULTS`), and
`entitlements/__tests__/plan-matrix-parity.test.ts` — all outside this sub-agent's file scope.

**G-06 — Phase 2a introduced five NEW env vars, which cuts against R1.** `JudgeConfig` adds
`TEXT_JUDGE_MAX_CONCURRENT`, `TEXT_JUDGE_ACQUIRE_TIMEOUT_S`, `TEXT_JUDGE_TIMEOUT_S`,
`TEXT_JUDGE_FAILURE_THRESHOLD`, `TEXT_JUDGE_RECOVERY_TIMEOUT_S`. They are pool/breaker **tuning**,
which the tier table puts in `global-kv` / `db-config`, not `env` — and this ticket exists partly
to stop services growing env surfaces exactly like this one. The defaults work with zero env, so
nothing is broken today.

**Do NOT resolve this by adding them to `turbo.json#globalEnv`** (the sub-agent's own suggested
follow-up). Correct resolution: register them as `SettingDescriptor`s alongside the existing
`guardrail.modelCache.*` / `guardrail.redact.chunkChars` service-runtime keys and read them through
the control plane, then delete the env fields. Blocked on G-01 (there is still no tenant-cascade
read surface for `db-config`), so the interim state — pydantic defaults, no env declared — is
acceptable and is the least-bad option meanwhile. Fold into Phase 4.

**G-09 — the engine stack this ticket is deleting was ALSO failing open (fixed separately,
2026-08-17).** Every engine path answered a failure with a permissive verdict: an LLM
timeout returned `{"safe": True, "issues": ["timeout"]}` (`openai_compat.py:150-156`, comment
*"Fail open for timeout"*), and the same shape appeared in nine more branches across
`openai_compat.py`, `gliner.py`, `guardrails.py` and `medical.py` — including
`/medical/validate`, which `apps/text` gates every `/generate` on. Contradicted the product
brief's *"Guardrails … fail-closed on generation"*.

Fixed in its own P0 ticket rather than inside a phase here, because it must not wait on the
delegation work: engines now raise `GuardrailUndeterminedError`
(`guardrail/core/errors.py`), single-item routes answer 503, batch routes mark the element.
**Two consequences for this ticket:**

1. **Phase 2b inherits a posture, it does not invent one.** The delegated client's declared
   fail posture (plan step 2b.2: exhausted budget ⇒ `allowed: False`) is now the SAME rule the
   in-process engines follow, so repointing `/medical/validate` at `text` is a transport
   change only — the wire contract, including the 503, is already what the client must produce.
2. **`X-Tenant-Id` enforcement (G-07's "interim until TASK-737 lands") is no longer interim.**
   It landed with the same fix: 428 on absence at all three dependency read sites, the
   `tenantless:<reason>` marker as the declared exception, and async jobs now stamping their
   submitting tenant instead of passing `tenant_id=None`. G-07's caveat can be treated as
   closed for `apps/guardrail`.

## 6c. Interaction with TASK-736 (Ollama removal)

TASK-736 removes Ollama platform-wide. Its Phase C is largely absorbed by this ticket's Phase 2
(which already deletes `providers/ollama.py`, `OllamaConfig` and the `_PROVIDER_TO_ATTR` dispatch
map). Two consequences here:

- Phase 2's deletion of the guardrail engine stack is now a **hard removal**, not a migration —
  there is no ollama engine to keep working.
- TASK-736 Phase B edits `apps/text` config/registry wiring, which collides with this ticket's
  Phase 2a judge route. Sequencing is recorded in TASK-736 §6; Phase 2a lands first.

## 7. Implementation Summary

### Phase 1 — tenant-first resolution (landed)

`TenantConfigResolver._load_from_db` now reads `AiTaskDefault` for
`tenant_id IN (SYSTEM, request-tenant)` with `resource_status IN (ENABLED, DISABLED)`, LEFT OUTER
joined to an ENABLED `AiModel` row, ranked tenant-row-first via the previously-dead `_row_rank`
helper. A DISABLED **tenant** row raises `TenantSelectionVetoedError` → 503 at both dependency call
sites; a DISABLED **SYSTEM** row remains "no opinion". Veto state is cached under the existing TTL
so it costs no extra round-trip, and a cached veto re-raises rather than reading back as absent.

Three deviations from the plan, all deliberate:
- `_row_rank`'s second tuple element, as originally written, preferred a tenant-owned `AiModel`
  copy over the SYSTEM catalog row — the opposite of the already-passing
  `test_db_prefers_system_model_row_over_tenant_copy`. Corrected to prefer SYSTEM, so tenant-first
  *selection* and SYSTEM-preferred *model rows* both hold.
- LEFT OUTER JOIN (not INNER) so a veto is still detected when the referenced model row is
  absent or disabled — an inner join would silently miss it.
- `test_db_system_task_default_drives_selection` asserted the behaviour this ticket reverses; it
  was rewritten as `test_db_tenant_task_default_wins_over_system_row`, plus a new
  `test_db_disabled_system_row_is_absent_not_a_veto`.

Evidence: `pnpm guardrail:test` — 228 passed. `guardrail:lint` (ruff) clean. `guardrail:typecheck`
(mypy) clean, 33 source files.

### Phase 4 (TypeScript half) — policy descriptors (landed)

`guardrail.policy.*` — four thresholds, four label taxonomies, five tuning knobs — registered as
`db-config`, `maxScope: 'tenant'`, NOT `globalOnly`. Thresholds and taxonomies are
`failMode: closed` (each is consulted directly by a safe/unsafe, PII or grounded/unverified
decision); the five tuning knobs are `open-to-default` (none individually decides a verdict —
notably `judgeTimeoutSeconds`, whose exhaustion already fails closed to `allowed: false`).
`assertGuardrailPolicyFloor` enforces D2 with a 403; `resolveGuardrailPolicyValue` implements the
tenant → SYSTEM → declared-fail-mode cascade. See §6b for the gaps this surfaced.

Evidence: `pnpm --filter @arcaai/applications test` — 9145 passed, 210/210 settings-registry tests
including 26 new ones; one unrelated failure in `consent-assert.test.ts` — see §7 "Suite-stability
finding" below for what that failure actually is. Lint clean.

### Phase 0 — governance flip (landed)

`GLOBAL_ADMIN_ONLY_TASK_PREFIXES` (`packages/applications/src/services/ai-task-default/constants.ts`)
is now `['nlp.', 'harness.']` — `guardrail.` removed by owner decision 2026-08-16. Because
`AiTaskDefaultService.getEffective`, `MODEL_DEFAULT_SETTINGS`
(`settings-registry/descriptors/model-defaults.descriptors.ts`) and the settings-registry
governance tests all DERIVE their guardrail-vs-tenant-editable behaviour from this one constant,
removing the prefix was sufficient to flip `getEffective`'s tenant-first cascade and the three
`models.guardrail.*` descriptors' `editableBy`/`globalOnly` to the same shape as `smr.*` — no
separate code change was needed in either place beyond the descriptor label/description copy.

Added, in `AiTaskDefaultService.upsertRow`, a guardrail-specific platform floor independent of the
blanket global-admin-only check: a `guardrail.*` write targeting a non-SYSTEM tenant must resolve
`modelSlug` to an ENABLED SYSTEM-tenant `AiModel` row (`assertGuardrailModelApproved`) —
`ForbiddenException` (403) otherwise, regardless of the caller's role, so a global admin editing a
tenant's row on their behalf is held to the same floor (only writing the SYSTEM row itself, i.e.
defining the approved list, is exempt). See §6b G-05 for the entitlement-ceiling half of D2 that
is NOT yet wired (needs a DB migration outside this sub-agent's file scope) and the resulting
residual gap (no per-tenant grant is enforced yet, only the approved-list restriction).

Also updated for accuracy (no functional change): `IAiTaskDefaultService.ts` doc comments;
`apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts` class/Swagger copy;
`apps/api/tests/e2e/ai-task-defaults-cross-tenant.spec.ts` (flips the guardrail-tenant-write
probe from 403→200, adds an approved-list-floor 403 probe); admin-console copy in
`ai-task-defaults-platform-screen.tsx`, `effective-models-table.tsx`,
`tenant-ai-configuration-screen.tsx` (no longer claims guardrail is exclusively global-admin-only;
no new tenant-facing edit control was built — that UI work is out of Phase 0's scope).

Evidence: `pnpm --filter @arcaai/applications test` — 9152 passed, 4 skipped, 1 failure in
`consent-assert.test.ts` (see §7 "Suite-stability finding"). `pnpm --filter @arcaai/applications lint`
clean (0 errors; pre-existing unrelated warnings elsewhere in the package untouched by this
change). `apps/admin-console` — `pnpm exec vitest run src/features/ai-task-defaults/` 39/39 passed;
targeted `eslint` on every touched file clean. The e2e spec was updated but NOT run (requires live
API + seeded DB, outside this verification's reach) — flagged for a follow-up live run.

### Phase 2a — `text` judge route (landed)

**Route contract — guardrail's Phase 2b client is written against this:**

`POST /api/v1/generate/internal/judge` — new module `api/endpoints/judge.py`. `X-Service-Token`
required (deliberately NOT in `EXEMPT_PATHS`); `X-Tenant-Id` accepted for log correlation only,
since guardrail has already resolved policy and model by then.

Request is its own `JudgeRequest` model, **not** a `GenerateRequest` subclass, so the public
contract can grow without leaking onto an internal safety wire: `prompt` (required),
`system_prompt`, `provider` + `model` (both required, non-blank — selection stays fail-closed),
`temperature` / `max_tokens` / `top_p`, `response_format`, `provider_overrides`. The response
returns raw model output (`content`, `reasoning`, `provider`, `model`, `latency_ms`,
`finish_reason`, `stats`, `usage_detail`) — *interpreting* it into a verdict stays guardrail's job.
Errors: 401 · 422 · 404 `PROVIDER_NOT_FOUND` · 503 `CONCURRENCY_LIMIT` / `CIRCUIT_OPEN` /
`PROVIDER_CREDENTIALS_MISSING` · 502 `PROVIDER_TIMEOUT`.

Deliberately absent: no streaming, no task manager, no idempotency cache, **no retry loop**
(guardrail's client owns the retry budget and the fail-closed verdict), and no shutdown rejection
(a judge call only ever serves an already-admitted public generation; refusing it during drain
would fail that in-flight request closed for nothing).

**Recursion guard — two layers.** Static: a test greps the judge module and asserts
`get_guardrail_client` is absent from the route's dependency set (with a non-vacuous check that it
*has* dependencies). Runtime: `services/judge_guard.py` sets a `ContextVar` scope around the judge
handler; the moderation gate — extracted verbatim from `generate()` into `_apply_guardrail_gate`,
so exactly one gate exists in the service — raises `GuardrailRecursionError` when entered inside
that scope. Both layers exist because each covers the other's blind spot. Separately verified that
`apps/api`'s `TextProxyController` declares explicit paths with no catch-all, so the judge route is
not reachable through the gateway.

**Pool isolation.** Separate keyspace (`app.state.judge_semaphores` / `judge_circuit_breakers`)
sized by a new `JudgeConfig`. The judge lane consults **no rate limiter and no request queue** — a
tenant that exhausted its generation rate limit must not be able to throttle the safety plane, and
queueing a call already on a user-facing critical path only converts a fast 503 into a slow one.
The dependency getters materialise the dicts onto `app.state` rather than returning throwaways; a
per-request dict would give every call its own semaphore, i.e. silently no bound at all — that
degradation has its own regression test.

**Metering.** `UsageDetail.cost_basis` is **derived inside `build_usage_detail` from `byok` and
exposed by no parameter** — a test asserts `cost_basis` is absent from the signature, so no call
site can stamp one. `guardrail_usage_from_verdict` now prefers `raw.usage_detail` and rebuilds it
through `build_usage_detail`, so a peer-claimed `cost_basis` is re-derived, never trusted.
*Phase 2b's side of the wire: put the judge's `usage_detail` under `raw.usage_detail` on the
`/api/medical/validate` payload and attribution rides back on the triggering `/generate`.*

Evidence: `CI=true pytest apps/text/src/text/tests` — 1224 passed / 32 deselected (baseline 1175).
`ruff` clean. `mypy` clean, 74 source files. (`CI=true` matters locally: without it `create_app()`
loads `.env.dev`'s `TEXT_SERVICE_TOKEN` into `os.environ` and pre-existing suites 401.)

### Suite-stability finding (all four lanes landed, combined run)

Each lane ran the `@arcaai/applications` suite **before the others finished**, so none of them
verified against the final tree. A combined run afterwards gives:

```
Test Files  2 failed | 490 passed | 1 skipped (493)
     Tests  2 failed | 9151 passed | 4 skipped (9157)
```

Failing: `consent/__tests__/consent-assert.test.ts` and
`consultation/prompt/__tests__/prompt-assembly.warm-start-policy.test.ts`. **Both pass in
isolation** (`vitest run <both files>` → 2 files, 16 tests, all passing, 573ms).

This corrects two explanations given earlier in this document's history, both of which were
inference rather than measurement:

- *"pre-existing failure from the uncommitted TASK-712 consent work"* — **wrong**. Consent files
  are indeed modified in the working tree, but the test passes in isolation, so those edits are not
  what fails it. Modified-nearby is not causation.
- *"a resource-contention flake (30s timeout under full-suite load)"* — **unverified**. Plausible
  for a 493-file suite whose combined run takes ~8 minutes, but neither failure was actually
  diagnosed, and load-only failure is equally consistent with cross-file test pollution or an
  order dependency.

What IS established: neither failure is caused by a TASK-735 change (both files are untouched by
all four lanes, and both pass when run alone). What is NOT established: why they fail under load.
**Do not close this ticket on the assumption that it is flake** — run the full suite with
`--sequence.shuffle` and `--no-file-parallelism` to distinguish contention from pollution, and if
it is pollution, the leak predates this ticket and needs its own issue.

### Phase 2b — guardrail delegates the guardian to `text` (landed 2026-08-19)

Guardrail now hosts **no LLM**. `providers/openai_compat.py` (555 lines) and
`providers/_granite.py` are DELETED, together with all five engine sub-configs
(`OpenAICompatConfig` + `Azure`/`Bedrock`/`VLLM`/`LlamaCpp`), `Settings.provider`,
`Settings.engine`/`engine_for`, `_PROVIDER_TO_ATTR`, `resolve_guardian_engine`,
`build_guardian_provider` and the process-wide `content_provider` / `guardian_provider`
lifespan wiring. Finding 1 held: the content-analysis half had zero production callers, so
it left with no replacement at all; only `validate_medical_context` needed one.

**New**: `services/external_text_client.py::TextJudgeClient` — posts one judgement to
`POST {TEXT_URL}/api/v1/generate/internal/judge` (the Phase 2a contract) with
`X-Service-Token` + a MANDATORY `X-Tenant-Id`, carrying the DB-resolved `provider`/`model`,
a pinned `json_object` response format, and `provider_overrides` forwarded VERBATIM. It
exposes the same three methods the deleted guardian did, so `/medical/validate`,
`/medical/validate/batch` and their wire contract (including the 503 that `text`'s gate maps
distinctly from a 422) did not move.

Deliberate deviations from the plan, all recorded rather than silent:

- **`build_judge_client` replaces `resolve_guardian_engine` + `build_guardian_provider`.**
  There is no engine sub-config left to map a selection ONTO; the provider name is now a
  pass-through token for `text`'s registry, not a key into a local adapter table. The Azure
  deployment-name precedence survives unchanged.
- **The `db_config_enabled=False` dev escape hatch now fails closed (503).** It used to
  return the env-configured engine. With the env engines gone, keeping it would mean naming
  a model in code — exactly the hardcoded selection this ticket removes.
- **A half-resolved selection is no selection.** The dependency requires BOTH `provider` and
  `model`; a NULL provider column used to fall back to the env engine and now 503s.
- **The medical criteria stayed in guardrail** (`MEDICAL_VALIDATION_CRITERIA`), in the
  service that owns the verdict, rather than following the adapters out. Phase 4/D5 moves it
  to the PromptTemplate plane; it must not drift into `apps/text` in the meantime.
- **`JudgePolicy` is a plain `BaseModel`, not `BaseSettings`** — the surviving policy and
  tuning knobs (min confidence, temperature, max tokens, timeout, retry budget, input cap)
  carry NO env surface at all, so this replaces ~30 env vars with zero. They become
  `guardrail.policy.*` descriptors in Phase 4 (blocked on G-01). This is also the answer to
  G-06's shape: a code default beats an env var, and both lose to a descriptor.
- **`settings.engine.max_concurrent` → `settings.queue.max_concurrent`**: the async-job
  bound was living on an engine sub-config, which made a queue limit look like an engine knob.

### Phase 5 — BYOK end-to-end, LLM plane (landed 2026-08-19)

Evidence for both phases: `pnpm guardrail:test` — **244 passed** (21 tests deleted with the
engines they covered, 14 added); `guardrail:lint` (ruff) clean; `guardrail:typecheck` (mypy)
clean, 31 source files; `packages/applications` settings-registry suite 212/212;
`ai-task-default` 50/50; `pnpm env:sync --check` OK (148 keys).

Guardrail sources **no** credential from env. `GUARDRAIL_VLLM_API_KEY` is gone from the
settings registry (`platform-secrets.descriptors.ts`), `turbo.json#globalEnv`, both
`.env.sample`s (regenerated with `env:sync`), the Vault dev seed, the `hope-guardrail` Vault
policy, the Vault-Agent reference deployment and the prod/env secret-generation scripts.
`test_text_judge_delegation.py` pins it the way `apps/text`'s `test_task602_byok_credentials.py`
does: five `GUARDRAIL_*_API_KEY` env vars must populate nothing, `Settings` must expose no
engine attribute, and `TextJudgeClient.__init__` must take no `api_key` parameter.

Per D1 the tenant's credential is its existing `llm` `AiProviderConnection`; guardrail only
passes an already-resolved `provider_overrides` blob through. **Residual**: nothing upstream
populates `request.state.provider_overrides` yet — the gateway/peer-caller side of the
pass-through (plan step 5.1) is NOT wired, so today every judgement is served by whichever
credential `text` resolves for the tenant itself. That is correct behaviour, not a leak, but
it is not yet BYOK *through guardrail*.

### Phases 3 & 6 — GLiNER and MiniCheck move to `apps/nlp` (landed 2026-08-19)

**Guardrail now holds ZERO resident model weights.** The three deletions the plan
called for all landed, plus their staging machinery:

| Deleted from `apps/guardrail` | Why |
|---|---|
| `providers/gliner.py` (269 lines, 4 hardcoded taxonomies) | NER/classification belongs to `apps/nlp` (rule 06) |
| `services/groundedness_scorer_minicheck.py` | `git mv`'d to `apps/nlp/src/nlp/services/entailment_scorer.py` |
| `services/model_cache.py`, `core/model_source.py` | nothing resident to cache; weight staging moved with the weights |
| `GlinerConfig` (whole class), `GroundednessConfig`'s `model_id`/`model_file`/`model_path`/`model_cache_dir`/`n_ctx`/`n_threads`/`n_gpu_layers` | model identity + runtime knobs are not guardrail's |
| `Settings.model_s3_*`, the `groundedness` extra, deps `gliner2-onnx` / `transformers` / `onnxruntime` / `minio` | guardrail is policy + HTTP now |

**What `apps/nlp` gained** — three executor routes under `/api/v1/guard`, plus their
services and cache slots:

| Route | Backing | Contract |
|---|---|---|
| `POST /guard/pii` | `services/gliner2_guard.py` (GLiNER2 `extract_entities`) | byte-exact document offsets back |
| `POST /guard/classify` | same runtime, `classify_text` with the caller's task schema | returns ONLY the tasks requested |
| `POST /guard/entailment` | `services/entailment_scorer.py` (MiniCheck GGUF, moved verbatim) | raw `P(entailed)` per pair |

Every route receives `model_name` (+ optional `model_path`) and its label taxonomy
FROM THE CALLER — the same shape `/classify/{text,tokens}` already used. `apps/nlp`
names no model and carries no label set. Fail posture: 428 with no tenant, 503 on an
unresolved selection or taxonomy, 503 on a runtime failure (never an empty result that
reads as "nothing found"). Both models load lazily through the existing per-slot
idle-TTL, pin-while-active cache — so `apps/nlp` also holds no weights until first use.

**What `apps/guardrail` kept** — POLICY, and only policy:

* `services/safety_analyzer.py` — which moderation tasks a `guardrail_type` runs, how
  per-task labels collapse into the `safe`/`issues`/`confidence` verdict, the
  fail-closed posture. This is what is left of `gliner.py` after the weights left.
* `services/groundedness_nli.py` — the entailment threshold, the segment cap, the
  verdict shape, the degrade-to-`unverified` contract. It no longer loads anything:
  `load_default_scorer` is gone and the verifier is HANDED a scorer.
* `services/external_nlp_client.py::NlpGuardClient` — the peer client. `X-Service-Token`
  + `X-Tenant-Id`, and the tenant is a **construction-time invariant**: the client
  refuses to exist without one, so an unattributable safety decision cannot be made.
  Bounded retry budget owned by guardrail (not the callee). No `api_key` parameter.
* `/guardrail/redact`'s chunking, offset re-basing and masking — unchanged. The
  span-offset contract survives the network hop and is pinned by a test on both sides.

**Owner-specified models, wired as CONFIG (the load-bearing part).**

| Task key | `AiModel` slug | `sourceUri` |
|---|---|---|
| `guardrail.safety` | `gliguard-llm-guardrails-300m` | `fastino/gliguard-LLMGuardrails-300M` |
| `guardrail.pii` (NEW) | `gliner2-privacy-filter-pii-multi` | `fastino/gliner2-privacy-filter-PII-multi` |

The safety plane is TWO selections now because the owner specified two different
models doing two different jobs. `guardrail.pii` is a new task key; `guardrail.safety`
is repointed off the retired `gliner-guard-uniencoder-onnx` row.

Both were RESEARCHED against their model cards before wiring, not assumed. Findings:

* Both are `gliner2` (PyTorch `GLiNER2.from_pretrained`), **not** `gliner2-onnx` — a
  different package from the one guardrail had installed. `apps/nlp` gains `gliner2`;
  guardrail loses `gliner2-onnx`. (`uv lock`: +`gliner2` 1.3.2, −`gliner2-onnx` 0.1.1.)
* PII: `extract_entities(text, labels, threshold, include_confidence=True,
  include_spans=True)`, **42** entity types, 7 languages. Per the owner directive the
  seed pins `metaData.languages = ['en']` — English only, though the model is multilingual.
* Safety: `classify_text(text, {task: {labels, multi_label, cls_threshold}},
  threshold=…)`. The card declares **exactly the six task names the directive names** —
  `prompt_safety`, `prompt_toxicity`, `jailbreak_detection`, `response_safety`,
  `response_toxicity`, `response_refusal`. No contradiction to report; all six are
  seeded with their verbatim label sets (15 toxicity categories, 12 jailbreak types,
  binary safety, refusal/compliance).
* The model card does not formally document `extract_entities`' return field names, so
  `_span_fields` accepts both the mapping and attribute shapes and **drops** any entity
  without usable integer offsets rather than guessing — redaction slices the original
  string with those numbers, so a wrong offset is worse than a visible miss.

**Proof the model ids and taxonomies are not hardcoded.** Three enforced claims:

1. `test_settings_name_no_model_and_no_label_taxonomy` — `Settings` exposes no `gliner`
   sub-config, `GroundednessConfig` has no `model_id`/`model_path`, and `config.py`
   contains none of `hivetrace/`, `fastino/`, `MiniCheck-Flan-T5`, `gliner-guard`,
   `jailbreak_detection`, `prompt_safety`.
2. `test_no_model_id_or_taxonomy_literal_anywhere_in_guardrail_source` — a repo-grep
   over every non-test `.py` in `apps/guardrail/src` for `hivetrace/`, `fastino/`,
   `nvhf/`, `granite-guardian`, `gemma3:`. Currently empty.
3. `build_safety_analyzer` raises `SelectionUnavailableError` (→ 503) when a registry
   row declares no `labelTaxonomy`. There is no built-in list to fall back to, so the
   only way the taxonomy can be wrong is for an admin to have made it wrong.

**How selection resolves.** Unchanged mechanism, extended payload:
`AiTaskDefault` ⋈ `AiModel`, **request tenant → SYSTEM, two tiers**, DISABLED tenant row
is a veto (503), missing selection is 503, `"Global"` (`50000000-…`) never appears. The
new part is that the label taxonomy rides on `AiModel._metadata.labelTaxonomy`
(`KEY_LABEL_TAXONOMY`, JSON-encoded into the existing tenant-keyed cache), so a taxonomy
is resolved by *the same cascade that chose the model it belongs to*. That is what makes
it configuration: a platform admin edits the SYSTEM row, a tenant may carry its own, and
`seedAiModels` re-syncs `metaData` on re-seed (the precedent is `tts` voice catalogs).
The `db_config_enabled=False` dev escape hatch fails CLOSED here too — with no DB there
is no model to name, and naming one in code is the thing this ticket removes.

**Deviations from the plan, recorded rather than silent:**

* **`guardrail.pii` is a new task key.** The plan assumed one GLiNER model served both
  PII and content safety. The owner-specified models split that in two, so the selection
  did too. `guardrail_type="pii_detection"` now consults only the PII model.
* **`GroundednessNliVerifier.verify` became `async`.** The scorer is a network call now,
  not in-process CPU work, so `/guardrail/ground`'s `asyncio.to_thread(verifier.verify, …)`
  was actively wrong. Both call sites tolerate a sync verifier so the in-process test
  seam still works.
* **The endpoint-level "model unavailable" test changed meaning.** "The local GGUF is
  unstaged" is not a state guardrail can be in any more. The 503 case is now a MISSING
  registry selection and the degrade case is a verifier with no usable scorer — split
  into two tests, both pinned.
* **`redact_text` takes the analyzer through `Depends`** instead of calling the resolver
  inline, so it is overridable in tests now that there is no local cache to seed.
* **`guardrail`'s aux-cache retention plumbing is deleted** (`apply_model_cache_retention`,
  `refresh_model_cache_retention`, `test_effective_config_retention.py`) — there are no
  caches left to retune. The TS `EffectiveConfigService` still SERVES a `retention` group
  for `guardrail`; it simply has no consumer now. Left alone deliberately (contract
  change, different lane) — noted here so it is not mistaken for an oversight.
* **Confidence is categorical, not fabricated.** The delegated surface returns labels,
  not calibrated per-label scores, so `analyze_content` reports 1.0 clean / 0.0 flagged
  rather than inventing a mean. The verdict is what callers gate on.

**Still open after this phase:** Phase 4's Python half (thresholds + judge tuning as
`guardrail.policy.*` reads) is still blocked on **G-01** — there is no tenant-cascade
read surface for `db-config` keys. The thresholds that ship here therefore travel in
`labelTaxonomy.threshold` / `.cls_threshold` alongside the labels they gate, which is
resolvable today through the same cascade; `SafetyPolicy`'s remaining code defaults are
the bootstrap floor for a row that declares no threshold. Phase 5's gateway-side
`provider_overrides` population is also still unwired (recorded under Phase 5).

**The seed was NOT run.** Only the seed SOURCE changed
(`ai-models/nlp.ts`, `16-ai-task-default.ts`). A `pnpm db:seed` (or a cold reseed) is
required before the new selections resolve in a live environment — `seedAiTaskDefault`
is CREATE-ONLY, so the repointed `guardrail.safety` row only takes effect on a cold seed
or an explicit admin edit; `guardrail.pii` is a new key and will be created.

**Evidence (this worktree, 2026-08-19):**

```
guardrail pytest ............ 196 passed
nlp       pytest ............ 232 passed   (8 new, apps/nlp/tests/test_guard_endpoints.py)
ruff check apps/{guardrail,nlp}/src ....... All checks passed!
mypy apps/guardrail ......... Success: no issues found in 29 source files
mypy apps/nlp ............... Success: no issues found in 50 source files
uv lock ..................... Resolved 488 packages; +gliner2 1.3.2, -gliner2-onnx 0.1.1
pnpm --filter @arcaai/database test ....... 1541 passed (1541)
pnpm --filter @arcaai/applications test ... 76 failed | 1800 passed | 4 skipped
```

The 76 `@arcaai/applications` failures are **PRE-EXISTING and unrelated**, proven by
measurement rather than inference: `git stash -u` + re-run on the untouched tree gives
the byte-identical `76 failed | 1800 passed | 4 skipped (1880)`. This is the same
suite-stability problem §7 "Suite-stability finding" already flags, now larger; it is
not caused by this change and is not fixed by it.

### Phases 3 and 6 — not started


Phase 3 (GLiNER → `nlp`, with the byte-exact span-offset contract) and Phase 6 (MiniCheck
groundedness → `nlp`, with the llama.cpp private-API binding and the `apps/harness` duplicate
NLI question) are untouched. `providers/gliner.py`, `services/groundedness_scorer_minicheck.py`,
`services/model_cache.py`, `core/model_source.py`, `GlinerConfig` and `GroundednessConfig` all
still stand, and with them the four hardcoded label taxonomies and the two aux model-id
defaults. Guardrail is therefore free of LLM engines but not yet free of resident weights.

### Delegation scope re-measured 2026-08-17 (from the fail-closed ticket)

Written by the agent that fixed the fail-open safety gate (§6b G-09 below). It touched
every engine path, so this is a MEASURED inventory of what Phases 2b/3/6 have to move —
not an estimate, and not a re-plan. Three of the findings change the plan's shape.

**Finding 1 — the five-vendor LLM content-analysis stack has ZERO production callers.**
`OpenAICompatProvider.analyze_content` (the Granite BYOC path, `_analyze_granite` /
`_analyze_generic` / `_analyze_comprehensive`, plus `_granite.py`'s criteria and
`<guardian>` template) is reachable from **no endpoint and no job**. A grep of
`apps/guardrail/src` for `.analyze_content(` outside tests returns only `gliner.py`'s
method and its GLiNER call sites; `get_content_provider` is consumed by exactly one
place — `api/endpoints/health.py:41`, which calls `health_check()`, not `analyze_content`.
`/guardrail/analyze`, `/guardrail/analyze/batch` and the async job all run **GLiNER**.

Consequence for Phase 2: what is actually LIVE on the LLM wire is only
`OpenAICompatGuardianProvider.validate_medical_context` behind `/medical/validate` +
`/medical/validate/batch`. So Phase 2b's delegation surface is **one method and two
routes**, and the rest of `openai_compat.py` (~330 of its 546 lines) plus `_granite.py`
is dead weight that can be DELETED without a replacement client at all. The plan's step
2b.3 ("repoint `medical/validate`, `medical/validate/batch` and the LLM path of
`guardrail/analyze`") over-scopes: there is no LLM path of `guardrail/analyze` to repoint.

**Finding 2 — three stacks, and only two of them need `text`/`nlp` at all.**

| Stack | Live surface | Where it must go | Real difficulty |
|---|---|---|---|
| LLM guardian (`openai_compat.py` `OpenAICompatGuardianProvider`, ~200 live lines) | `/medical/validate`, `/medical/validate/batch` | `text` `POST /generate/internal/judge` (Phase 2a, **already shipped**) | **Low.** The route exists, its contract is written down in §7 Phase 2a, and the peer-client shape exists twice in-tree. The verdict shape on guardrail's wire must not move — `text`'s gate maps 422-vs-503 off it. |
| GLiNER ONNX (`gliner.py`, 266 lines; 4 hardcoded taxonomies at `:22-70`) | `/guardrail/analyze`, `/analyze/batch`, `/guardrail/redact`, async jobs | `nlp` `/classify/{tokens,text}` | **High, and redaction is why.** `/guardrail/redact` needs byte-exact `start`/`end` offsets back (`_apply_mask` slices the original string) and re-chunks long text at `guardrail.redact.chunkChars`, remapping offsets per chunk. A span-offset contract across a network hop is the hard part; the label taxonomies are the easy part. |
| MiniCheck GGUF NLI (`groundedness_scorer_minicheck.py`, 233 lines, bound to llama.cpp **private** internals `._model`/`._ctx`/`llama_model_decoder_start_token` at `:142-207`) | `/guardrail/ground` | `nlp` (Phase 6) | **Highest.** The private-API binding moves verbatim or is rewritten; either way it lands in `nlp`, which does not host GGUF today. It is also duplicated work: `apps/harness` hosts its own MiniCheck-class NLI (`sensors/inferential/` + `minicheck_entailer.py`) and deliberately does NOT call this endpoint, so Phase 6 should decide whether ONE NLI host serves both rather than moving guardrail's copy next to a second one. |

**Finding 3 — engine sub-configs are down to five, and one inheritance bug is still live.**
`core/config.py` now declares `OpenAICompatConfig` and four subclasses
(`AzureOpenAIConfig`, `BedrockConfig`, `VLLMConfig`, `LlamaCppConfig`) — `OllamaConfig` is
already gone. All four subclasses **inherit the six `granite-guardian-4.1-8b` defaults**
while their own docstrings say Azure/Bedrock do not host Granite. Deleting the stack
(Phase 2) removes the bug; until then it stands.

**What did NOT need to change, and should not be re-litigated.** The tenant→SYSTEM
cascade, the tenant-keyed cache, the DISABLED-row veto and the fail-closed model
selection are all correct as landed in Phase 1, and the fail-closed work built on them
unchanged. Guardrail keeping POLICY (verdict shape, thresholds, taxonomies, fail posture)
while delegating INFERENCE remains the right split — it is what made the fail-closed fix
possible in one service.

**Sequencing note.** Do Phase 2b before Phase 3. Phase 2b is now small (Finding 1) and
deletes the largest file; Phase 3 carries the offset-contract risk and deserves the
uncluttered tree.

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-19 | **Phase 2b + Phase 5 (LLM plane) landed.** `providers/openai_compat.py` and `providers/_granite.py` deleted with all five engine sub-configs, `Settings.provider`/`engine`/`engine_for`, `_PROVIDER_TO_ATTR`, `resolve_guardian_engine`, `build_guardian_provider` and the lifespan provider wiring; new `services/external_text_client.py::TextJudgeClient` delegates `/medical/validate{,/batch}` to `text`'s judge lane, fail-closed. `GUARDRAIL_VLLM_API_KEY` removed from the registry, `turbo.json`, both `.env.sample`s, the Vault policy/dev-seed/agent reference and the secret scripts. Dev escape hatch (`db_config_enabled=False`) now fails closed. Docs/rules updated. Phases 3 and 6 remain not started. |
| 2026-08-16 | Ticket created. Current-state audit of `apps/guardrail` against the two new owner configuration rules; plan drafted; `.claude/rules/00`, `06`, `09` updated with the rules this ticket enforces. |
| 2026-08-16 | Owner resolved D1–D5: reuse the `llm` connection · tenant may tighten only (entitlement floor) · guardrail keeps its own task keys · all six phases in scope · criteria live in the PromptTemplate plane. Phase 6 rewritten from optional to in-scope. |
| 2026-08-16 | Phase 0 landed: `guardrail.` removed from `GLOBAL_ADMIN_ONLY_TASK_PREFIXES`; `models.guardrail.*` descriptors retarget to tenant-editable; `entitlements.featureGuardrailModelSelection` catalogued (not yet enforced — G-05); `AiTaskDefaultService.upsertRow` gains the platform-approved-list floor (`assertGuardrailModelApproved`, 403). Tests, API/e2e copy and admin-console copy updated to match. |
| 2026-08-19 | **Phases 3 and 6 landed.** GLiNER and MiniCheck moved OUT of `apps/guardrail` into `apps/nlp` behind three new `/api/v1/guard/{pii,classify,entailment}` executor routes; `providers/gliner.py`, `services/groundedness_scorer_minicheck.py`, `services/model_cache.py`, `core/model_source.py`, `GlinerConfig` and the groundedness weight/runtime fields are DELETED, together with the `gliner2-onnx`/`transformers`/`onnxruntime`/`minio` dependencies — guardrail now holds zero resident model weights. New `services/external_nlp_client.py::NlpGuardClient` (mandatory `X-Tenant-Id` as a construction invariant, bounded retry, declared fail-closed posture) and `services/safety_analyzer.py` (the policy half of the old provider). Owner-specified models seeded as SYSTEM `AiModel` rows with their verbatim label taxonomies in `metaData.labelTaxonomy`: `fastino/gliguard-LLMGuardrails-300M` (`guardrail.safety`, six tasks) and `fastino/gliner2-privacy-filter-PII-multi` (`guardrail.pii`, NEW key, English only). Model ids and taxonomies are resolved tenant → SYSTEM and fail closed; three tests enforce their absence from code. `GroundednessNliVerifier.verify` is now async. Phase 4's Python half stays blocked on G-01. |
| 2026-08-17 | Assessment only, no code in this ticket: §7 gains "Delegation scope re-measured 2026-08-17" (the LLM content-analysis stack has zero production callers, so Phase 2b is one method + two routes; GLiNER's span-offset contract is the hard part of Phase 3; MiniCheck's llama.cpp private-API binding plus harness's duplicate NLI host is the hard part of Phase 6) and §6b gains **G-09** (the engine stack was also failing OPEN; fixed in its own P0 ticket, which also closed G-07's `X-Tenant-Id` interim). |
| 2026-08-20 | Follow-up from TASK-776: the Phase 3/6 seed rows broke the `@arcaai/database` BUILD. `nlp.ts` assigns `metaData.languages` and `metaData.labelTaxonomy` (and, after the TASK-778 merge, `metaData.capabilities`), but `AiModelSeed['metaData']` in `seed/ai-models/shared.ts` declared only the TTS-shaped keys — so `tsc` failed with three `TS2353`s and root `pnpm api:build` could not complete, which would also have failed CI. Fixed in TASK-776 (`c13ddd967`): the type gains `languages?: string[]`, a real `LabelTaxonomy` union (the PII-detector and safety-moderator rows have genuinely different shapes — `labels` vs `benignLabels`+`tasks`), and `capabilities?: NlpModelCapability[]` (`'extract_entities' \| 'classify_text'`, the closed set the seed comments treat as load-bearing: a row with no classification head must not claim `classify_text`). `@arcaai/database` builds clean; 1541 tests pass. |
