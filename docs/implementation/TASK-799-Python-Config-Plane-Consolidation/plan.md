# TASK-799 — Fix plan

Goal, restated from the owner directive: **super admins configure platform settings
and integrations; tenant admins configure their own settings and BYO keys/services;
all of it stored in and loaded from the database; environment variables eliminated
wherever possible; and the total knob count goes DOWN.**

Target: **~579 env-reachable fields → ~118**, of which ~40 are a genuine bootstrap
floor and the rest are deletions. Sequenced so that the phase which unblocks the most
variables comes first, and so nothing depends on a phase that has not landed.

## Phase 0 — Stop the bleeding (independent of the config-plane work)

These are correctness/security defects that do not need the new plane and should not
wait for it. All are small and independently verifiable.

| # | Fix | Files | Proves |
|---|---|---|---|
| 0.1 | Close the ambient cloud-credential chains (F-01). Pass explicit `credentials=` / a scoped botocore session and RAISE `ProviderCredentialsError` when unsupplied — mirror `azure_openai.py:71`. | `text/providers/{bedrock,vertex}.py`, `stt/models/azure_foundry_loader.py`, `text/core/config.py` (openai_compat/vllm `api_key`) | New test asserting 503 + `PROVIDER_CREDENTIALS_MISSING` for every adapter, **iterating the provider registry** instead of a literal list |
| 0.2 | Make Vertex fail CLOSED (F-07). Delete the `except → return self._client` fall-through. | `text/providers/vertex.py:108` | Test: broken tenant credential → 503, never platform spend |
| 0.3 | Route all 9 bypassed call sites through `peer_service_token()` (F-06). | `text/main.py:297,325`; `guardrail/main.py:171,250`; `nlp/lifespan.py:75,106`; `harness/main.py:71`, `harness/temporal/activities.py:348,362,2430` | Test per service: shared token set + legacy empty ⇒ outbound header carries the shared token |
| 0.4 | Distinguish "no tenant row" from "could not read tenant row" (F-08). Propagate the DB error; never negative-cache it as absence. | `guardrail/core/tenant_config.py:525` | Test: DB error ⇒ raise, not a silent SYSTEM widen |
| 0.5 | Resolve `AiRuntimeProfile` and the `AiModel` tie-break tenant-first (F-05). | `guardrail/core/tenant_config.py:683,719` | Test: tenant row wins; SYSTEM only on absence |
| 0.6 | Delete `.env.prod`'s phantom engine plane and the `GUARDRAIL_GLINER_*` block (F-03, F-14). | `guardrail/.env.prod`, `.env.sample`, `docker-compose.yml` | Grep: zero references to deleted prefixes |
| 0.7 | Remove the `kwargs.setdefault` block so `hope_env` precedence applies (F-09). | `nlp/core/config.py:304-326` | Test: host env and `secrets_dir` beat the code default |
| 0.8 | Enforce `X-Tenant-Id` in middleware, not per-route; cross-check nlp's body tenant against the header (F-10). | `text/api/middleware/auth.py`, `nlp/api/v1/rest/*` | Test: every tenant-scoped route 428s without the header |
| 0.9 | Fix nlp CORS: read the declared `allow_credentials`, refuse `["*"]`+credentials (F-12). | `nlp/app.py:43-44` | Test: wildcard + credentials refused at boot |

**Gate:** each service's `test`, `lint`, `typecheck` green, with pasted output.

## Phase 1 — Generalise the control plane (the leverage)

One change carries ~150+ variables. Nothing in Phase 2 is possible without it.

**1.1 — Make `/internal/effective-config` registry-driven, typed and tenant-aware.**
- Add a consuming-deployable field to `SettingDescriptor` (`registry.types.ts`).
- Replace the hardcoded `switch` (`effective-config.service.ts:79-122`) with a registry
  query on that field.
- Widen `ResolvedKey.value` from `number | null` to `unknown` and delete the numeric
  coercion at `:219` — **this is the change that admits strings, enums, URLs, booleans
  and taxonomies.**
- Accept a tenant on the route instead of pinning SYSTEM (`:31`,
  `effective-config.controller.ts:57`). Requires an owner decision — see Open Question 1.
- Populate the declared-but-empty `agenticContext`, and add the `modelWeights` block
  `apps/harness` already codes against (F-16).

**1.2 — Open the write lane past `global-kv`** (`settings-registry-write.service.ts:139`),
or rule that Python knobs standardise on `global-kv`. See Open Question 2.

**1.3 — Give tenant secrets a home that is not shaped like a vendor LLM credential.**
`AiProviderConnection.service` is a closed `{llm,stt,tts}` set, so Qdrant, TEI, the
claim-check object store, and self-host OpenAI-compatible keys have nowhere to live.
Also replace the fixed forwarding allow-list (`ai-provider-connection.service.ts:491-507`)
with a validated passthrough — today `extraJson` accepts anything and silently drops
all but four fields, so per-endpoint quirks (`*_JSON_RESPONSE_FORMAT`,
`*_REASONING_MODE`, `*_NO_THINK`) cannot be expressed.

**1.4 — Publish invalidation to Python (RC-6).** Publish on the channel guardrail
already subscribes to, and generalise it so each service's pull client drops its entry
on write. Demotes the 60s TTL to a backstop. Cheapest item here; repairs a dead listener.

**Gate:** an integration test proving a super-admin write reaches a running Python
service without a restart.

## Phase 2 — Migrate the services (parallel, one worktree per service)

Only after Phase 1. Each lane is disjoint, so these run concurrently.

| Lane | Headline work | Fields |
|---|---|---:|
| **harness** | `HARNESS_SAFETY_*` engine plane → `AiProviderConnection` + `AiTaskDefault` + `harm_criteria` → `AiModel._metadata.labelTaxonomy` (F-02). Claim-check → the existing `storage.platformDefault.*` cascade. Retire the offline-eval judge selection. | 148 → ~15 |
| **text** | The 8 per-provider env blocks collapse into `AiProviderConnection` rows the gateway injects as a `funding:"platform"` override — text then holds **no** provider config. Provider availability stops being gated by "is `base_url` non-empty". | ~123 → ~12 |
| **nlp** | Two hardcoded model ids → `AiTaskDefault` fail-closed (F-04). Label taxonomies, ontology tables, vitals ranges, ConText triggers → `AiModel._metadata`. 10 queue/batch knobs → one control-plane group. | ~101 → ~18 |
| **stt** | ~75 tuning knobs onto the (already proven) `EffectiveConfigClient`. 3 model ids → `AiModel`. 4 credentials → Vault. Collapse the `STT_`/`STT_V2_` dual alias. | ~115 → ~35 |
| **tts** | 5 voice/model-id defaults → catalog-only. Retire the legacy token. 5 kill-switches → flags. | ~49 → ~25 |
| **guardrail** | `GROUNDEDNESS_*` → the registry policy blob. Judge-tuning triple deduplicated (3 sources → 1). | 39 → ~13 |

Per rule 14: one worktree per writer, orchestrator owns merges and DB resets, each
lane re-runs its gates after the merge.

## Phase 3 — Make it stick

**3.1 — Extend the drift gate to Python** (`scripts/env-sync.mts:639` globs no `*.py`).
Either scan Python reads, or have each service emit its pydantic field list as a build
artifact the generator consumes. Stop inlining the six `.env.sample` files verbatim.
Without this, "we finished" stays unfalsifiable — 243 vars are outside every gate today.

**3.2 — Add a declared-but-never-read check.** ~95 dead fields exist because nothing
catches them; every one would have been caught by a static check.

**3.3 — Delete the dead** (F-13, F-15) once 3.2 can prove the list.

## Phase 4 — Give the admins a button

210 descriptors, 94 currently writable, **one** console screen consuming the registry
lane. A generic registry-driven settings screen over the existing
`GET admin/settings/catalog` + `PUT admin/settings/registry/:key`, grouped by
`category`, honouring `globalOnly`/`maxScope`/`dataType`/`killSwitch` with the existing
ETag→If-Match round trip. Also missing: an `AiRuntimeProfile` editor (routes exist, no
screen) and writable guardrail policy (`/ai-services` is read-only today).

**Without Phase 4, Phases 1–2 give your admins an API and no button.**

## Owner decisions (2026-08-23) and the standards they set

### D-1 — Tenant-aware pull route: **hybrid, split by cardinality.** ACCEPTED

Do NOT make the pull route per-tenant. A pull that fans out over tenants turns one
cached snapshot per process into N, and the cache-stampede and memory cost scale with
customer count — the opposite of "easy to scale".

The standard is a **two-channel split**, chosen by how the value varies:

| Channel | Carries | Cardinality | Delivery |
|---|---|---|---|
| **PULL** (`/internal/effective-config?service=`) | PLATFORM-scope service knobs: capacity, geometry, retention, timeouts, thresholds with no tenant opinion | 1 per service | TTL cache + push invalidation (Phase 1.4) |
| **PUSH** (per-request injection) | Anything that varies BY TENANT: provider connections, BYO credentials, model selections, per-tenant policy | 1 per request | Gateway resolves and injects into the request body |

Rules that keep this maintainable:
1. **The gateway is the only tenant resolver.** A Python service never resolves a
   tenant's config itself. (`apps/guardrail` keeps its documented SQL exception because
   its callers are peers, not the gateway — but it resolves tenant-first, never SYSTEM-only.)
2. **A service that receives no injected tenant config FAILS CLOSED** for selection and
   credentials. It never falls back to a platform value it resolved locally.
3. **Cardinality decides the channel.** If a knob could ever differ per tenant, it is
   PUSH. Putting a tenant-varying value on the pull route is the bug this split prevents.
4. **One injection envelope, not per-call-site wiring.** Today `provider_overrides`,
   `model_name` and task instructions are injected by hand at different call sites with
   different fail postures. They collapse into ONE `tenantConfig` envelope built by one
   gateway service and validated by one Pydantic model per service.

This scales because the expensive tier (per-tenant) is request-scoped and stateless, and
the cached tier (platform) stays exactly one entry per process forever.

### D-2 — Tier for Python knobs: **`global-kv`, with `db-config` reserved.** ACCEPTED

`global-kv` is today the only tier with a complete read + write + cascade + invalidate
loop, and `TenantSettingsService` already resolves it tenant → SYSTEM. Building
`db-config`'s missing half first would block every service migration behind a
control-plane project.

The standard:
- **Default every migrated Python knob to `global-kv`.** One tier, one write lane, one
  cascade, one invalidation channel — that is what makes it maintainable.
- **`db-config` stays for values with their own table and their own semantics**:
  `AiProviderConnection`, `AiTaskDefault`, `AiModel`, `AiRuntimeProfile`,
  `TenantStorageConfig`. A knob joins those ONLY when it is a row on one of them.
- **Never invent a third home.** A new bespoke settings table for one service is the
  failure this decision exists to prevent.
- Consequence to accept: `guardrail.policy.*`'s 13 descriptors are re-tiered to
  `global-kv` and the orphaned `resolveGuardrailPolicyValue` / `assertGuardrailPolicyFloor`
  pair is either wired to that lane or deleted. No third path.

### D-3 — Phase 0 first. ACCEPTED. Implementation starts there.

## F-01 — BYO credential standard (the pattern every adapter must follow)

Requirement: a tenant admin configures a BYO key; it is stored in the database; every
request for that tenant uses it.

**The seven-hop contract** (already correct for 3 of ~13 adapters in `apps/text` —
this generalises it):

1. **Store** — `AiProviderConnection` row per `(tenantId, service, provider)`;
   key material is Vault-Transit ciphertext in `encryptedApiKey`, never plaintext, never
   in a read DTO.
2. **Cascade** — `cascadeRows`: read the caller's tenant FIRST and unconditionally,
   compute the veto set, apply the entitlement gate, and only then widen to SYSTEM.
   Only two tenant ids may ever appear: the caller's and SYSTEM.
3. **Three states, enforced** — no row = no opinion (platform default applies, subject to
   entitlement); enabled + keyed = tenant wins, SYSTEM not consulted; disabled = VETO in
   both tiers, checked BEFORE the entitlement grant.
4. **Derive funding, never stamp it** — `row.tenantId === SYSTEM_TENANT_ID ? 'platform' : 'tenant'`,
   computed at the single construction site. A call site that stamps it mis-bills silently.
5. **Inject** — only the entry for the SELECTED provider is folded into the request body
   (minimal exposure). A resolver ERROR fails open with a non-secret warning; a POLICY
   refusal (veto → 409, missing entitlement → 403) raises OUTSIDE that catch, so a policy
   decision is never disguised as a lookup failure.
6. **Transport** — `SecretStr` for the key so it survives no `repr()`/`model_dump()`/log
   line; `funding` deliberately NOT secret so attribution survives serialisation.
7. **Consume, FAIL CLOSED** — every adapter builds a REQUEST-SCOPED client (never mutates
   a shared one, so concurrent tenants cannot race); no override AND no platform
   credential ⇒ raise `ProviderCredentialsError` → 503 `PROVIDER_CREDENTIALS_MISSING`.

**Two hard rules that close F-01 permanently:**
- **No ambient credential chains.** Every SDK client is constructed with an EXPLICIT
  credential. `boto3.client(...)` and `genai.Client(...)` without `credentials=` inherit
  the process environment and are therefore banned — this is why deleting a pydantic
  field did not close the hole.
- **The lock test iterates the provider registry**, never a hand-written list. That is
  what makes the guarantee survive the next adapter.

Reference implementation to copy: `apps/text/services/translation/sarvam.py` (key comes
only from the override; absence raises a typed error). Structural enforcement to copy:
`apps/tts/core/config.py:44-47` — a `validation_alias` naming a var nobody will ever set,
with `populate_by_name` off, so no env path to a cloud key exists at all.

## F-02 — harness must delegate, not host an engine

`06-python-services.md`: "Do not grow a second inference stack." Guardrail already
complies — it owns POLICY and delegates engines (`TextJudgeClient` → `apps/text`,
`NlpGuardClient` → `apps/nlp`). `apps/harness` does not: its Temporal safety sensor
builds a Granite client and talks to an engine directly.

**Target:** the harness safety sensor calls `apps/guardrail`'s existing
`POST /guardrail/screen/outbound`, which already owns tenant-aware safety policy,
the label taxonomy, and the delegation to text/nlp.

**Why this is contained, not a rewrite:** harness ALREADY has a guardrail client path —
`temporal/interpreter/nodes/guardrail_check.py:80` and `nodes/consultation.py:117` both
call guardrail via `settings.guardrail_base_url`. Only the Temporal ACTIVITY lane
(`temporal/activities.py:510` → `GraniteGuardianClient`) bypasses it. The work is to
route that lane through the same client the interpreter lane already uses.

Deletions that follow: `SafetyGuardConfig` in full (`provider`, `base_url`, `model`,
`no_think`, `timeout_s`, `harm_criteria`) and `sensors/inferential/granite_client.py`.
`harm_criteria` becomes guardrail's tenant-resolved taxonomy, not a harness env array.

**"Nothing broken" gates:** the safety sensor's degrade path must be preserved verbatim
(a backend outage degrades that sensor, it does not fail the workflow); Temporal
replay-compatibility tests must pass (`test_replay_compat`); and the
`guardrail_decisions` map shape that `activities.py:1645` produces must be unchanged.

## F-03 — env files cleaned, aligned, and set up by the setup scripts

Requirement: all `.env*` files cleaned up, aligned, and configured properly when running
the `setup` scripts.

Standard:
1. **Generated, not hand-maintained.** `.env.sample` (root and per-service) becomes
   generated output of `pnpm env:sync` for ALL SIX Python services, from their
   pydantic-settings field declarations — ending the verbatim inlining at
   `scripts/env-sync.mts:461-468`.
2. **One declared surface.** A variable that no service reads is deleted; a variable a
   service reads is declared. `pnpm env:sync --check` fails on either mismatch.
3. **`setup:dev` produces a working `.env.dev` with no hand-editing** — every variable
   the stack needs, correct values for local infra, and secrets minted (not `CHANGE_ME`).
4. **Delete `.env.prod` files that describe deleted planes** (F-03/guardrail). Production
   reads host env only; a committed prod file that lies is worse than none.
5. `turbo.json#globalEnv` is regenerated from the same source, so `GUARDRAIL_PORT` /
   `NLP_PORT`-style phantoms cannot survive.

## F-04 / F-05 — no hardcoded models, anywhere

Owner restatement: **services MUST work from the tenant's or the platform's
configuration.** Therefore:
- A `pydantic-settings` field whose default is a real model id, engine name, endpoint,
  threshold, prompt or label taxonomy is a defect, not a default. It is removed — not
  merely shadowed by an env filter, which is what created F-04's false compliance.
- Model SELECTION resolves `AiTaskDefault` tenant → SYSTEM and **fails closed** when
  unresolved (503). It never falls back to a literal.
- Zero-argument classifier constructors (`nlp/core/dependencies.py:74,86`) are removed;
  a resolved selection is a required argument.
- Label taxonomies and calibration constants ride `AiModel._metadata`, resolved by the
  same cascade that chose the model.
