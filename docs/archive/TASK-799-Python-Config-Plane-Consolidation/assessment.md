# TASK-799 — Assessment: Python services configuration surface

Status: complete. Method: five parallel read-only review lanes (four subagents +
one inline), every claim carrying `path:line`, load-bearing claims re-verified by
the orchestrator against the code. Date: 2026-08-23. Branch: `dev-2.2`.

## 1. The numbers

| Measure | Count |
|---|---:|
| Env-reachable settings fields across the six Python services | **~579** |
| … documented in the services' `.env.sample` files | 306 |
| … declared in `turbo.json#globalEnv` or the settings registry | **40** |
| … confirmed DEAD (no reader anywhere) | **~95** |
| Keys the DB→Python pull channel can actually carry today | **22** |

Per service (env-reachable fields vs. what its `.env.sample` documents):

| Service | Reachable | Documented | Dead | Target |
|---|---:|---:|---:|---:|
| harness | 148 | 88 | ~17 | ~15 |
| text | ~123 | 84 | 14 | ~12 |
| stt | ~115 | 41 | 7 | ~35 |
| nlp | ~101 | 31 | 28 | ~18 |
| tts | ~49 | 23 | 9 | ~25 |
| guardrail | 39 (+14 phantom) | 38 | 12 | ~13 |

**The `.env.sample` files understate the real surface by roughly 2×.** They cannot
be used to audit completeness, and three of them actively mislead (see §3 F-03).

## 2. Root causes

**RC-1 — The config plane was built gateway-first, and the six Python services were
placed outside it by an explicit, documented decision.**
`scripts/env-sync.mts:45-53` calls the boundary "DELIBERATELY *NOT* SCHEMA-VALIDATED
(declared boundary, not an oversight)". `:461-468` inlines each service's
`.env.sample` verbatim. The decisive line is `:639`: `scanTypeScriptReads()` globs
`*.ts,*.tsx,*.mts,*.cts,*.mjs,*.js` — **no `*.py`**. Consequence: 243 of 297 distinct
Python env vars are invisible to every gate. Nothing enumerates the undeclared set,
so "the migration is done" is unfalsifiable.

**RC-2 — The DB→Python channel is numeric-only, SYSTEM-only, and hand-wired per key.**
`effective-config.service.ts:219` coerces any non-number to the code default; `:31`
and `effective-config.controller.ts:57-60` pin the tenant to SYSTEM; `:79-122` is a
hardcoded `switch`. Adding one key requires four coordinated edits (switch case,
response DTO, `SERVICE_RUNTIME_DEFAULTS`, Python client). **This — not the switch
statement — is the binding ceiling**: strings, enums, URLs, booleans, thresholds and
label taxonomies cannot traverse this path at all, and no per-tenant value can.

**RC-3 — Migrations were executed per-item by hand, so coverage equals the set that
existed on the day someone ran the sweep.**
TASK-602 removed `api_key` *fields* from three text adapters and locked them with a
test that enumerates those three by name. Adapters added later, or authenticating by
other means, were never in scope — hence F-01. The same shape produced F-02 (three of
four services bypass a token helper that exists) and the ~95 dead fields (writing
"this is dead" in a comment was treated as sufficient; deleting it was not).

**RC-4 — Registration and consumption are disconnected steps.**
A descriptor can be correct, governed and complete while the Python reader bypasses it
entirely. `azure.foundryApiKey` is a registered vault-kv platform secret
(`platform-secrets.descriptors.ts:251`); `apps/stt` reads the bare env var instead
(`azure_foundry_loader.py:63`). Conversely `guardrail.policy.*` has 13 descriptors, a
resolver and a floor guard with **no table, no repository and no consumer**. Both
halves can exist independently, and nothing checks they agree.

**RC-5 — The tier that a Python knob should move to has no complete loop except
`global-kv`.**
`settings-registry-write.service.ts:139` refuses every tier but `global-kv` (94 of 210
descriptors). `effective-settings.service.ts:114` throws for anything that is not
`pipeline.*` / `models.*` / `global-kv`. Guardrail's own source states the blocker:
"blocked on the missing tenant-cascade read surface for `db-config` keys"
(`guardrail/core/config.py:26-30`). So policy values were either attached to an
`AiModel._metadata` blob as a workaround, or left in env.

**RC-6 — Propagation to Python is TTL-only, and the one push path is dead.**
`arca:guardrail-config:invalidate` appears exactly once repo-wide — the subscriber at
`apps/guardrail/src/guardrail/main.py:88`. **Zero publishers.** Every Python service
converges by 60s poll. This removes the property that justifies moving a value out of
env in the first place.

**RC-7 — Deployment artifacts are hand-maintained with no drift gate**, so the code
moved and `.env.sample` / `.env.prod` / `docker-compose.yml` / `turbo.json` did not.

## 3. Findings (severity-ordered, cross-service)

### BLOCKER

**F-01 — The BYOK guarantee covers 3 of ~13 cloud adapters; the rest read platform
credentials from ambient environment.**
- `apps/text/providers/bedrock.py:82` — `boto3.client(...)` with no credentials →
  `AWS_ACCESS_KEY_ID`/`AWS_PROFILE`/instance metadata.
- `apps/text/providers/vertex.py:72` — `genai.Client(vertexai=True, ...)` with no
  `credentials=` → Google ADC (`GOOGLE_APPLICATION_CREDENTIALS`).
- `apps/stt/models/azure_foundry_loader.py:63` — explicit
  `override or settings.azure_foundry_api_key` env fallback, 20 lines from
  `azure_speech_loader.py:118` which correctly has none.
- `apps/text/core/config.py:145` — `TEXT_OPENAI_COMPAT_API_KEY` (and the inherited
  `TEXT_VLLM_API_KEY`) is a live env credential; neither adapter reads
  `provider_overrides` at all, so a tenant can never BYO for them.
None of the ambient chains appear in `turbo.json`, any `.env.sample`, or the registry.
Violates `00-project-context.md` §Configuration Principles and
`09-infrastructure-devops.md` §"No hardcoded configuration".
**Note the mechanism gap:** an SDK's ambient credential chain cannot be closed by
deleting a pydantic field. It needs an explicit `credentials=` that raises when unset.

**F-02 — `apps/harness` runs a complete guardian-engine plane from environment —
the exact plane TASK-735/736 deleted from `apps/guardrail`.**
`SafetyGuardConfig` (`harness/core/config.py:82-102`) declares `provider`
(`lm-studio|ollama|azure|bedrock`), `base_url`, `model = "granite-guardian-4.1-8b"`,
`timeout_s`, and `harm_criteria` — a **7-item clinical risk taxonomy** whose own
comment reads "env: JSON array". All reach the wire at
`sensors/inferential/granite_client.py:107-109`. `06-python-services.md` states the
engine prefixes are "GONE … do not reintroduce one" — true of guardrail, false of
harness, which screens every generated clinical note through this classifier.
A single class violates five of the eight categories rule 00 names: engine, model id,
endpoint, threshold, taxonomy. No tenant can express any of it.

**F-03 — `apps/guardrail/.env.prod`, the only production reference for the service,
is fiction.**
`:16` instructs operators to "select via `GUARDRAIL_V2_PROVIDER=vllm|llama-cpp`" and
`:18-25` sets six engine vars with hardcoded `granite-guardian-4.1-8b`. Verified:
`GUARDRAIL_V2_PROVIDER` occurs twice repo-wide, **both in comments claiming it
exists**; there is no field and no reader. The flag it is gated on
(`GUARDRAIL_DB_CONFIG_ENABLED=false`) now 503s every route rather than falling back
(`guardrail/core/dependencies.py:114-121`). Parallel: `.env.sample:44-52` and
`docker-compose.yml:26-31` still set 7 `GUARDRAIL_GLINER_*` vars with a hardcoded
model id and two thresholds.

**F-04 — `apps/nlp` runs two hardcoded model ids at runtime.**
`core/config.py:386` (`blaze999/Medical-NER`) and `:439`
(`shanover/symps_disease_bert_v3_c41`) are pydantic defaults, reached because
`core/dependencies.py:74` and `:86` construct the classifiers **with no config at
all**. The env-source filter blocks env from *changing* them, which produced the
appearance of compliance while leaving the violation live. Reachable from the
WebSocket classify routes, which take neither `model_name` nor a tenant.

**F-05 — Guardrail resolves `AiRuntimeProfile` SYSTEM-only, unconditionally.**
`guardrail/core/tenant_config.py:719` — `AiRuntimeProfileRead.tenant_id ==
SYSTEM_TENANT_ID`, no tenant read, no widening-on-absence. A tenant with its own LLM
connection still runs on the platform's `temperature`/`maxTokens`/`timeoutS`.
`:683` applies the same SYSTEM-first preference to the `AiModel` slug tie-break, so a
tenant's own catalog row loses to the platform's. Rule 09 names this shape exactly.
Scope note: tenant-first IS correct for `AiTaskDefault` selection, the cache IS
tenant-keyed, and `50000000-…` is genuinely unreachable — the TASK-735 closure claim
is mostly true, with these two specific holes.

### MAJOR

**F-06 — Three of four services bypass the shared-internal-token helper at their
gateway-facing call sites, contradicting owner decision D-D.**
`peer_service_token()` exists in each service to prefer `INTERNAL_ACCESS_TOKEN` with a
legacy fallback. Bypassed at: `text/main.py:297,325`; `guardrail/main.py:171,250`;
`nlp/lifespan.py:75,106`; `harness/main.py:71` and `harness/temporal/activities.py:348,362,2430`.
Configure the platform the way D-D specifies — shared token set, legacy empty — and
the effective-config pull and service self-registration send an **empty token and
401**. The failure is negative-cached, so each service silently degrades to its env
values with one warning per minute. This is also why the legacy `*_SERVICE_TOKEN`
vars cannot simply be deleted today.

**F-07 — Vertex's tenant-credential path fails OPEN onto the platform credential.**
`text/providers/vertex.py:88-115` — its own docstring says "Fail-OPEN": any exception
building a tenant's client returns `self._client`, the ADC-authenticated **platform**
client, while funding is still read as `tenant`. A tenant with a revoked key silently
runs on the platform's Google account, billed as BYOK. Un-invoiced COGS plus a
cross-tier credential substitution. `azure_openai.py:71` raises in the same situation.

**F-08 — A transient DB error downgrades a tenant to the platform safety floor.**
`guardrail/core/tenant_config.py:525-536` maps any DB exception to `{}` and negative-
caches it; `resolve()` at `:424` reads that as "no tenant opinion" and widens to
SYSTEM. Because a tenant may only *tighten* relative to SYSTEM, a tenant that chose a
stricter safety posture is silently downgraded for a full TTL window with no error.
The team solved this exact ambiguity for the missing-header case (`TENANTLESS_PREFIX`,
`:130-150`) and did not apply it to the error path.

**F-09 — `apps/nlp` defeats the `hope_env` precedence chain for 11 fields.**
`core/config.py:304-326` calls `kwargs.setdefault(...)` from bare `os.getenv` before
`super().__init__()`. `init_settings` is the highest-precedence source in
pydantic-settings, so these values **outrank host env, the Vault `secrets_dir` tier,
and the env file**. `NLP_HOST`/`NLP_PORT`/`NLP_WORKERS` are unreachable, and a
Vault-Agent-rendered secret would be silently ignored. This is the module-scope
env-read pattern TASK-558 removed, reintroduced through a different door.

**F-10 — `X-Tenant-Id` enforcement is per-endpoint, so it covers the endpoint someone
was fixing.**
`apps/text`: `_require_inbound_tenant` is called at 2 of 8 route handlers
(`generate.py:366,868`). `/judge` and `/embeddings` declare the header Optional and
never validate; `/translate` declares none at all — and `/translate` carries a
tenant's Sarvam credential. `apps/nlp` reads tenant from the request BODY
(`rest/guard.py:69`) and never cross-checks it against the header guardrail sends,
so header `A` + body `B` is accepted and attributed to `B`.

**F-11 — Model ids, endpoints, thresholds and taxonomies as pydantic defaults,
service-wide.** Beyond F-02/F-04: `stt` `DIARIZATION_HF_MODEL_ID`
(`pyannote/wespeaker-…`), `PUNCTUATION_MODEL_NAME` (`Cadence`), `AZURE_FOUNDRY_MODEL`
(`mai-transcribe-1.5`); `harness` `ATOMIC_FACT_MODEL_ID`
(`nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF`), `RETRIEVAL_EMBEDDINGS_MODEL`
(`text-embedding-bge-m3`), `JUDGE_MODEL` (`gemma-4-e2b-it-qat`); `text`
`OPENAI_COMPAT_DEFAULT_MODEL` (`gemma-4-e2b-it-qat`), `TEI_DEFAULT_MODEL`
(`BAAI/bge-m3`), `SARVAM_MODEL` (`bulbul:v3`, and it reaches the wire); `tts`
`PARLER_HF_MODEL`, `INDICF5_HF_MODEL`, `SARVAM_MODEL`, plus 5 voice ids; `nlp`
`TOKEN_CLASSIFIER_IGNORE_LABELS` (a label set in an env var) and hardcoded
UMLS/SNOMED/RxNorm tables, vitals plausibility ranges and ConText trigger sets.

**F-12 — `apps/nlp` CORS defaults to `["*"]` with `allow_credentials` hardcoded
`True`.** `core/config.py:487` + `app.py:43-44`. The `cors_allow_credentials` knob
that would disable it is declared but never read.

### MINOR (representative; full lists in the lane reports)

**F-13 — ~95 dead settings fields.** Includes two entire never-instantiated classes in
`nlp` (`WebSocketConfig`, `WebSocketTokenClassificationConfig`), 12 in guardrail
(9 advertised in `.env.sample`), 7 in stt — one of which,
`WORKER_CONCURRENCY`, is *self-documented as dead in a code comment*
(`stt/core/runtime_limits.py:46`) and was still never deleted.

**F-14 — 14 phantom guardrail vars** exist only in operator-facing files (F-03).

**F-15 — `turbo.json#globalEnv` declares `GUARDRAIL_PORT` and `NLP_PORT`, neither of
which has a reader** (the readers are `GUARDRAIL_V2_PORT` and bare `PORT`), while
omitting 20+ live vars per service.

**F-16 — `EffectiveConfigResponse.agenticContext` is declared and never populated**
(`IEffectiveConfigService.ts:93`); `apps/harness` codes against a `modelWeights`
field (`models/source_resolver.py:440`) that **does not exist in the TS contract**.

## 4. What is already right (preserve these as templates)

- **TTS enforces BYOK structurally, not by convention.** `tts/core/config.py:44-47`
  sets `validation_alias="TTS_AZURE_API_KEY__ENV_REMOVED_TASK_602"` with
  `populate_by_name` off — no env path to a cloud key exists even if an operator tries.
  This is the pattern F-01 should be fixed *to*.
- **The `AiProviderConnection` cascade is correct and complete** — tenant read first,
  veto before entitlement, SYSTEM only on absence, only two tenant ids ever in play,
  and **funding derived from the row** (`ai-provider-connection.service.ts:522`), never
  stamped by the call site.
- **`apps/tts` is a genuine stateless, gateway-injected service** — no DB driver, no
  local tenant resolution, fails closed when no routing is injected. The pattern is
  proven and safe to copy. (It still carries the same env debt one layer down.)
- **The `guardrail → nlp` fail posture is the best-documented in the codebase**
  (`guardrail/services/external_nlp_client.py:19-29`): a moderation verdict may fail
  closed, but a *generated label* must raise, never be fabricated — "an empty span list
  would read as 'no PII found'".
- **The harness judge selection is already DB-driven and genuinely fail-closed**
  (`harness/temporal/activities.py:1873`), explicitly refusing the env fallback.
- **The `targetTier` mechanism works.** `platform-knobs.descriptors.ts:1-10` records ten
  keys migrated env→`global-kv` with `targetTier` then dropped, under an explicit
  "honesty rule" that `tier` states where a value lives today. 12 remain pending.
