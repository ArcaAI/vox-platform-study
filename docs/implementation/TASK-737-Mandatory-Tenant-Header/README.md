# TASK-737 — `X-Tenant-Id` mandatory on internal service calls

| Field | Value |
|---|---|
| Status | Pending (audit complete — plan drafted, awaiting implementation) |
| Type | refactor + infrastructure |
| Owner decision date | 2026-08-16 |
| Origin | TASK-735 gap **G-07** |
| Affects | `apps/api`, `apps/text`, `apps/nlp`, `apps/guardrail`, `apps/harness`, `apps/stt`, `apps/tts` |

---

## 1. Requirement Analysis

Owner directive, 2026-08-16: *"we need to track the guardrails, so `x-tenant-id` must be mandatory
for all internal requests; review the current implementation, ensure correct logic implemented in
other services to include the tenant information."*

- **R1** — Every internal service-to-service request carrying tenant-scoped work MUST send
  `X-Tenant-Id`. An absent header is a defect in the **caller**.
- **R2** — Receivers stop compensating for a missing header with a default. A callee that silently
  substitutes a tenant makes the defect invisible and mis-attributes the work.
- **R3** — Genuinely tenant-less internal work must **declare itself** rather than arriving with an
  absent header that is indistinguishable from one dropped in transit.

## 2. Why this exists — the failure mode it closes

`apps/guardrail` resolved a request with no `X-Tenant-Id` by falling back to a **customer tenant**
(`50000000-…`), meaning a dropped header silently served one customer's safety configuration to
everyone (fixed under TASK-735 G-00). The interim posture — resolve SYSTEM when the header is
absent — removes the cross-tenant leak but leaves a subtler problem:

**D2 makes tenants tighten-only, so SYSTEM is by definition the LOOSEST admissible configuration.**
A lost header therefore silently downgrades a tenant that chose a stricter posture to the platform
floor, with no error raised anywhere. The resolver cannot distinguish that case from the callers
that legitimately have no tenant — the job processor passes `tenant_id=None` **by construction**
("jobs carry no tenant"), as does the harness by-slug weight lookup. Failing those closed would
break the job queue; failing nothing closed keeps the silent downgrade.

The distinction is not recoverable at the resolver. It has to be made where the call originates,
which is what R1–R3 encode.

## 3. Current State — Propagation Audit (completed 2026-08-16)

Methodology: six parallel sweeps (one per surface — `apps/api`, `apps/text`, `apps/guardrail`,
`apps/nlp`, `apps/harness`, `apps/stt`+`apps/tts`), each reading the actual call sites rather than
inferring from naming conventions, cross-checked for contradictions. `apps/text` and `apps/harness`
were being edited concurrently by other agents during this audit — every citation below was read
fresh at audit time; **line numbers in those two trees may have shifted since** and should be
re-verified before any fix lands.

### 3.0 Read this before the table — the wire format is not one thing

The ticket title assumes a single header, `X-Tenant-Id`. The codebase actually has **three
different tenant-propagation channels**, and conflating them will produce a wrong fix:

1. **`X-Tenant-Id` header** — used between `apps/api` ↔ `apps/text`/`apps/guardrail`/`apps/nlp`.
   This is the channel R1–R3 are written against.
2. **`X-Internal-Tenant-Id` header** — used exclusively between `apps/stt`'s worker/session-manager
   and `apps/api`'s `SttInternalController`. This is **deliberate, not an oversight**: the STT
   worker is a single platform-wide process authenticating with one service credential, so its
   CLS context carries a `userId` but not the caller's tenant; if it sent literal `X-Tenant-Id`,
   apps/api's global `ContextInterceptor` would 400 it as diverging from the authenticated
   principal's own tenant (`apps/stt/src/stt/core/api_client/gateway.py:100-119`, comment
   "BUG-013"). **A blanket "require `X-Tenant-Id`" enforcement at the gateway would break STT's
   callback path** unless the receiver special-cases this header name too.
3. **Body/query `tenantId` field** — used exclusively by `apps/harness` in both directions
   (`apps/harness/src/harness/services/api_client.py`, `apps/api/src/modules/consultation/
   harness-internal.controller.ts`) and by two `apps/stt` routes (`create_audio_recording`,
   `create_media`) plus the `provider-overrides` query param. Harness never uses either header
   name — tenant rides in the Temporal workflow input (`tenant_id: str`, required, `extra="forbid"`
   on every workflow input model) and in the HTTP body/query string to `apps/api`. This channel is
   internally consistent and enforced (apps/api 400s a missing `tenantId` query/body param on the
   harness-internal surface) — it is a **parallel, equally load-bearing contract**, not a gap.

**Implication for §4**: "make `X-Tenant-Id` mandatory" has to mean "make the *declared tenant
channel for that edge* mandatory," naming the channel per edge, not literally grepping for one
header name everywhere.

### 3.1 Contradiction with §2's framing

§2 frames the problem as: guardrail's *receiver-side* fallback (customer tenant → SYSTEM) hiding a
dropped header. That receiver-side risk is real and confirmed (§3.5). But the audit's headline
finding is **upstream of it and larger**: the single busiest, most tenant-sensitive path in the
platform — `apps/api` → `apps/text` for clinical summary generation (BullMQ finalize jobs, the live
SOAP-note loop, the v1-compat summary shim) — **never even attempts to construct the header**, in
9 separate call sites, several of which have a live `tenantId`/`this.tenantId` local variable in
scope one or two lines above the HTTP call. This is not "conditional and sometimes empty" (the
shape §2 and the owner directive's item 1 anticipate) — it is unconditional omission. See §3.2.

### 3.2 `apps/api` → `apps/text` (SMR) — the largest concentration of Class-B defects

Every one of these resolves `x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id")`
to `None` on the `apps/text` side (`apps/text/src/text/api/endpoints/generate.py:242`), which then
propagates into `apps/text`'s own `ExternalGuardrailClient.validate()` call as `tenant_id=None`
(§3.4, §3.5) — i.e. every one of these gaps independently reproduces the exact SYSTEM-tenant-downgrade
failure mode §2 describes, one hop upstream of guardrail.

| Caller → Callee | Transport | Sends `X-Tenant-Id`? | Tenant source | Behaviour if absent | Class | file:line |
|---|---|---|---|---|---|---|
| `SmrProxyController` (`/text/generate`, `/tasks/*`, `/providers`) → Text | HTTP | **No** — `getForwardHeaders()` sets only `Content-Type` + `X-Service-Token` | n/a | Text falls back to platform default; per-tenant BYOK/provider config never applied | B | `apps/api/src/modules/streaming/text-proxy.controller.ts:298-310` (verified) |
| `SmrCompatController` (v1 `/summary/sync`, `/presummary`, `/translate`, stream) → Text | HTTP | **No** | n/a | same | B | `apps/api/src/modules/text-compat/text-compat.controller.ts:864-872` |
| `SummaryProcessor` (BullMQ finalize) → Text `/generate` | HTTP | **No** — `tenantId` is used one line above (`resolveSmrSelection(tenantId, 'finalize')`) then never forwarded as a header | n/a | same | B | `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts:518-533` (verified) |
| `PreSummaryProcessor` (BullMQ) → Text `/generate` | HTTP | **No** | n/a | same | B | `.../processors/pre-summary.processor.ts:293-300` |
| `ComprehensiveSummaryProcessor` (BullMQ) → Text `/generate` | HTTP | **No** | n/a | same | B | `.../processors/comprehensive-summary.processor.ts:406-413` |
| `ChainSummaryService` → Text `/generate` | HTTP | **No** — `this.tenantId` is null-checked immediately above the call, then dropped | n/a | same | B | `packages/applications/src/services/consultation/summary/chain-summary.service.ts:628-648` |
| `SummaryService.executeSmrGenerate` (finalize) → Text `/generate` | HTTP | **No** | n/a | same | B | `packages/applications/src/services/consultation/summary/summary.service.ts:1493-1502` |
| `LiveDocumentationService` (live SOAP-note flush loop) → Text `/generate` | HTTP | **No** — highest call volume of any edge in this table (every live-doc flush) | n/a | same | B | `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:2059-2072` |
| `DnaWritingStyleProcessor.callSmr` → Text `/generate` | HTTP | **No** | n/a | same | B | `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts:415-439` |
| `PromptManagementService.smrHeaders` (prompt-template test bench) → Text `/generate`, `/tasks/:id` | HTTP | **Conditional** — `if (tenantId) headers['X-Tenant-Id'] = tenantId` | `this.tenantId` (CLS via `BaseService`) | Header omitted when no CLS tenant (e.g. global admin with no working tenant) | B (narrower — legitimate no-CLS case exists, but still worth an explicit declare) | `packages/applications/src/services/prompt-management/prompt-management.service.ts:1359-1365` |

### 3.3 `apps/api` → `apps/guardrail` / `apps/nlp`

| Caller → Callee | Transport | Sends? | Source | Behaviour if absent | Class | file:line |
|---|---|---|---|---|---|---|
| `AiInferenceClient` (`/ai/guardrail/analyze`, `/ai/nlp/*` playground proxy) → Guardrail/NLP | HTTP | **Conditional** — `if (tenantId) headers['X-Tenant-Id'] = tenantId` | `this.cls?.get('tenantId')` | Omitted when no CLS tenant | B (narrow) | `apps/api/src/modules/ai-inference/ai-inference.client.ts:103-118` |
| `GuardrailPhiRedactor.redact` → Guardrail `/api/guardrail/redact` | HTTP | **No** — `tenantId` isn't even a parameter of `redact(text, mode)` | n/a | same downgrade as §3.2 | B | `packages/applications/src/services/phi-redaction/guardrail-phi-redactor.service.ts:60-73` |
| `GuardrailGroundednessTool.execute` (live-doc groundedness gate) → Guardrail `/api/guardrail/ground` | HTTP | **No** — `GroundednessToolDeps` has no tenant field | n/a | same | B | `packages/applications/src/services/consultation/live-documentation/live-tool-registry.ts:262-285` |
| `NlpExtractionTool.execute` (live-doc NER) → NLP `/api/v1/classify/tokens` | HTTP | **No** — `deps.cls` is in scope (used for model selection) but never read for this | n/a | NLP has no inbound tenant handling at all (§3.4), so currently a no-op gap, but becomes live once NLP delegates to Text with a tenant (§3.4) | B | `.../live-tool-registry.ts:176-193` |
| `SummaryService.callNlpService` (sync clinical NER, finalize) → NLP `/api/v1/classify/tokens` | HTTP | **No** — call sends no headers object at all (also missing `X-Service-Token`) | n/a | same | B | `packages/applications/src/services/consultation/summary/summary.service.ts:1692-1712` |

**Unreachable code, not a live edge**: `BaseProxyController` (`apps/api/src/shared/base-proxy.controller.ts`) would forward inbound headers verbatim (including a browser-supplied `X-Tenant-Id`) via `http-proxy-middleware`, but has zero controller subclasses in the current tree — only its own unit test references it.

### 3.4 `apps/text` → `apps/guardrail`, and the (unbuilt) `apps/guardrail` → `apps/text` judge edge

| Caller → Callee | Transport | Sends? | Source | Behaviour if absent | Class | file:line |
|---|---|---|---|---|---|---|
| Text `/generate` → Guardrail `/api/medical/validate` (`ExternalGuardrailClient.validate`) | httpx | **Conditional** — `if tenant_id: headers["X-Tenant-Id"] = tenant_id` | `tenant_id` param, sourced from `x_tenant_id: Header(default=None)` on `/generate` — i.e. whatever `apps/api` forwarded (§3.2: usually nothing) | Header omitted; Guardrail resolves SYSTEM tenant (§3.5) — correctly guarded at this layer, but the input is poisoned by §3.2 | B (the guard is correct; the defect is upstream) | `apps/text/src/text/services/external_guardrail.py:46,63-64` (verified); call site `apps/text/src/text/api/endpoints/generate.py:242,305-309` |
| Retry attempts of the above | httpx (same client) | Same as first attempt — headers dict built once before the retry loop, reused verbatim | n/a | Retries do **not** independently drop the header; not a distinct risk here | — | `apps/text/src/text/services/external_guardrail.py:76-116` |
| `POST /generate/internal/judge` (`apps/text/src/text/api/endpoints/judge.py`) — landed today, **no caller exists yet anywhere in the repo** | inbound | Accepts `X-Tenant-Id` (`Header(default=None, alias="X-Tenant-Id")`, `judge.py:188`) | Future caller: `apps/guardrail`'s `ExternalTextClient` (TASK-735 Phase 2b, **not yet written**) | Used **only** for `judge.completed` log correlation (`judge.py:204,304-313`) — does not select provider/model (caller-resolved, required fields) and does not appear in `UsageDetail`/`cost_basis` (`build_usage_detail`, `models/usage.py:268-300`, has no tenant parameter) | C-adjacent today (unreachable); becomes B the moment Phase 2b ships unless that new client inherits guardrail's own resolved tenant | `apps/text/src/text/api/endpoints/judge.py:173,188,204,288-313` |
| **README wording correction**: §3's "known edges" list described this as "`apps/text` → itself." It is not a self-call — grepping both `apps/text/src` and `apps/guardrail/src` for `internal/judge` finds only the route's own definition. The real (future) edge is `apps/guardrail → apps/text`, forming `text → guardrail → text`, and should be tracked as a guardrail-outbound edge once Phase 2b lands, not folded into apps/text's own edges. |||||||
| Text → Guardrail's **would-be caller when Phase 2b lands**: if guardrail delegates a judge call while resolving a request that itself arrived with no tenant (§3.5 SYSTEM-fallback path, or the async `job_processor` with `tenant_id=None`, §3.6), the new client **has no tenant to send** — confirming owner-directive item 3's concern is real once Phase 2b is built. | — | — | — | — | C (job_processor path) / B (SYSTEM-fallback-but-should-have-had-one path) | n/a — design note for Phase 2b, cross-refs §3.5–§3.6 |

### 3.5 `apps/guardrail` — receiver behaviour (the §2 mechanism, confirmed live)

| Surface | Behaviour when `X-Tenant-Id` absent/blank | file:line |
|---|---|---|
| All four resolution paths (`/medical/validate`, `/guardrail/analyze[/batch]`, `/guardrail/redact`, `/guardrail/ground`) funnel through `TenantConfigResolver.resolve()` | `requested = (tenant_id or "").strip() or None; primary_tenant = requested or SYSTEM_TENANT_ID` — **confirmed**: a missing header resolves to SYSTEM (`00000000-…`), never a customer tenant. The retired `GUARDRAIL_DEFAULT_TENANT_ID` (which defaulted to the `50000000-…` customer tenant — the TASK-735 G-00 leak) no longer exists in `core/config.py` | `apps/guardrail/src/guardrail/core/tenant_config.py:351-352` (verified) |
| Header read call sites (all pass straight into the resolver above, no other fallback exists) | — | `core/dependencies.py:90,370,410`; `api/endpoints/guardrails.py:77,123`; `api/endpoints/redact.py:286` |
| `core/tenant_config.py` — sanctioned exception per `06-python-services.md` | Cache key IS tenant-keyed: `cache_key = f"{task_key}::{tenant_id}"` (confirmed, mandatory per project rules); three-state veto semantics (absent row = defer to SYSTEM, ENABLED = tenant wins, DISABLED = fail-closed 503, never folds through to SYSTEM); negative-caches a DB error for one TTL window | `apps/guardrail/src/guardrail/core/tenant_config.py:437` (cache key, verified), `:30-37,148-163,531-537` (veto), `:455-465` (negative cache) |
| Provider/model SELECTION | Fail-closed (503) on a missing SYSTEM `AiTaskDefault` row — never substitutes an env default for identity. Only tuning fields (temperature/max_tokens/timeout) fail safe to env | matches `failMode` policy in `09-infrastructure-devops.md` |

### 3.6 `apps/guardrail` `job_processor` — Class C, confirmed structural

| Finding | Detail | file:line |
|---|---|---|
| Job queue schema has **no `tenant_id` field at all** | `job_data = {job_id, text, guardrail_type, request_id, priority, priority_score, created_at, updated_at, created_at_ms, status}` — `submit_job()`'s own signature doesn't accept one | `apps/guardrail/src/guardrail/services/job_processor.py:68-93` (verified) |
| `POST /guardrail/analyze/async` never captures the caller's `X-Tenant-Id` into the job at all | The async submission endpoint only forwards `text/guardrail_type/request_id/priority` | `apps/guardrail/src/guardrail/api/endpoints/guardrails.py:179-203` |
| Job processing resolves `tenant_id=None` explicitly | `# Jobs carry no tenant; SYSTEM selection resolves regardless of tenant.` — deliberate, commented | `apps/guardrail/src/guardrail/main.py:136-143` |
| No outbound HTTP calls from `job_processor` at all | Only talks to its own Redis instance and, in-process, to the resolved GLiNER provider — no header propagation possible because there's no outbound call | confirmed by sweep of `job_processor.py` |

Constructional reason for Class C: the async guardrail-analyze job queue was designed as a
platform-wide utility queue (batch PII/safety scans) with no per-tenant column in its Redis hash
schema — adding one would require a schema migration of the job envelope, not a client fix.

### 3.7 `apps/nlp` → `apps/text`

| Caller → Callee | Transport | Sends? | Source | Behaviour if absent | Class | file:line |
|---|---|---|---|---|---|---|
| `/classify/topic` → Text `/generate` (`ExternalTextClient.generate_label`) | HTTP | **Conditional** — `if tenant_id: headers["X-Tenant-Id"] = tenant_id` | `TopicClassificationRequest.tenant_id: str \| None = None` — an optional, gateway-injected body field with no validation that it's actually populated | Silently omitted for `None`/`""`; call proceeds to Text with no header, no error, no log | B | `apps/nlp/src/nlp/services/external_text_client.py:57-68` (verified); `apps/nlp/src/nlp/schemas/classification.py:116-118`; call site `apps/nlp/src/nlp/api/v1/rest/classify.py:157` |
| `/classify/intent` → Text `/generate` | HTTP | Same conditional pattern | `IntentClassificationRequest.tenant_id`, same shape | Same | B | `apps/nlp/src/nlp/api/v1/rest/classify.py:191`; `schemas/classification.py:135-137` |
| Retry attempts of either | HTTP (same client) | Headers dict built once, reused unchanged across retries | n/a | Not a distinct risk | — | `apps/nlp/src/nlp/services/external_text_client.py:63-113` |
| Inbound: any caller → `apps/nlp` REST/WS routes | — | N/A (receiver) | `apps/nlp` has **no inbound `X-Tenant-Id` reader anywhere** — only `X-Service-Token` is enforced (`api/middleware/auth.py:40-63,66-92`); tenant exists solely as the optional body field above | Accepted and processed with no tenant context; benign for pure local-inference routes, but is exactly why the two rows above can go silently tenant-less | B (structural gap enabling the two rows above) | `apps/nlp/src/nlp/api/middleware/auth.py` |

`apps/nlp` has no Dramatiq/queue/background-job infrastructure at all (confirmed by filesystem
sweep) — every entry point is a synchronous REST/WS route, so there is no Class-C analogue to
guardrail's `job_processor` here.

### 3.8 `apps/harness` → `apps/text` (SMR) — one client, five call sites, one fix

| Finding | Detail | file:line |
|---|---|---|
| `SmrClient.generate()` has **no `tenant_id` parameter at all**, and (separately) no `X-Service-Token` either | Confirmed by reading the full method signature and the httpx call — only an optional `Idempotency-Key` header is ever set | `apps/harness/src/harness/services/smr_client.py:104-147` (verified) |
| 5 call sites, all downstream of the same client — **one structural gap, not five** | `activities.generate` (`GenerateInput` — no `tenant_id` field on the model at all), `activities.apply_redaction` (`ApplyRedactionInput` — same, no field), `activities.plan_reasoning` (`PlanLoopInput.tenant_id` **is present on the input** but dropped before the call), `activities.run_specialist` (`SpecialistAnalysisInput.tenant_id` present, dropped), `activities.vision_extract_text` (`DeriveContextInput.tenant_id` present, dropped) | `apps/harness/src/harness/temporal/activities.py:1142,1841,2470,2546,2652` |
| Retry policy does not compound the problem | Temporal re-executes a retried activity with the exact serialized input recorded at schedule time — it can't lose a field a retry didn't already lack | `apps/harness/src/harness/temporal/workflows.py:171,1783,1790` (`RetryPolicy`s) |
| Downstream effect | `apps/text`'s `/generate` endpoint takes `x_tenant_id` and forwards it into its own guardrail-validation call (§3.4) — every harness-originated `/generate` call therefore also validates with `tenant_id=None` at guardrail, independent of §3.2's apps/api gap | — |

Class: **B**. This is the single highest-leverage fix in the whole audit for `apps/harness` —
adding `tenant_id: str` to `SmrClient.generate()`'s signature (threading it onto `GenerateInput`
and `ApplyRedactionInput`, and actually forwarding the field that `PlanLoopInput`/
`SpecialistAnalysisInput`/`DeriveContextInput` already carry) closes all 5 call sites at once.
Every workflow input model that reaches these activities has `tenant_id: str` **required, with
`extra="forbid"`** (`temporal/models.py:77` etc.) — Temporal rejects a workflow start missing it —
so the value is always available; it's only lost at the `SmrClient` boundary.

Harness has **no HTTP client to `apps/guardrail` at all** — its "GUARDRAIL" trajectory step and PHI
redaction run in-process via Presidio (`apps/harness/src/harness/guards/phi/redactor.py`) and an
in-process Granite-based screen that calls an OpenAI-compatible endpoint directly, not the
guardrail service (`apps/harness/src/harness/sensors/inferential/granite_client.py`).
`GUARDRAIL_URL` does not appear anywhere in `apps/harness/src/harness/core/config.py`.

### 3.9 `apps/harness` by-slug weight lookup — Class C, confirmed

```
# apps/harness/src/harness/models/source_resolver.py:426-428
ATOMIC_FACT_MODEL_SLUG = "minicheck-flan-t5-large"
```

`resolve_atomic_fact_model_path()` resolves the MiniCheck GGUF weight path through
`EffectiveConfigClient.get().model_weights[ATOMIC_FACT_MODEL_SLUG]` — a SYSTEM-tenant,
service-level control-plane pull (§3.11), not a per-tenant `AiTaskDefault` lookup. Constructional
reasons, verified:
- MiniCheck's atomic-fact entailer is not one of the nine `AiTaskDefault` task keys, so there is no
  tenant-overridable row to look up.
- The GGUF file is a **worker-process-resident** artifact loaded once per Temporal worker process
  (`core/effective_config.py:7-11` docstring), not per-request — a tenant dimension would be
  meaningless (which file a worker process loads is an ops decision, not a per-tenant one).
- Precedence is fixed: control-plane `modelWeights[<slug>].localPath` → resolvable `sourceUri` →
  `HARNESS_ATOMIC_FACT_MODEL_PATH` env — none of it tenant-parameterized.

### 3.10 `apps/harness` ↔ `apps/api` — body/query `tenantId`, not a header (its own consistent contract)

| Edge | Behaviour | file:line |
|---|---|---|
| Temporal workflow starts (`HarnessDocWorkflow`, `ConsultationLoopWorkflow`, `SpecialistWorkflow`, `WorkflowInterpreter`) | `tenant_id: str` required, no default, `extra="forbid"` on every workflow input model — pydantic rejects a start payload missing it before `client.start_workflow()` runs. **Never started without a tenant** — verified at both the model layer and the HTTP boundary (`harness-internal.controller.ts` 400s a missing `tenantId`) | `apps/harness/src/harness/temporal/models.py:71-78`; `apps/api/src/modules/consultation/harness-internal.controller.ts:225-227`; `apps/harness/src/harness/api/endpoints/internal.py:236-238` |
| `harness → apps/api` internal endpoints (policy, entities, loop-config, progress, document-extract) via `services/api_client.py` | `tenant_id` threaded as an explicit function parameter on every method, serialized as `"tenantId"` in query/body — never a header | `apps/harness/src/harness/services/api_client.py` (13+ call sites) |
| `apps/api`'s `HarnessInternalController` | Requires `tenantId` query/body param, 400s if missing; manually does `cls.set('tenantId', tenantId)` since the request carries a service token, not a user JWT | `apps/api/src/modules/consultation/harness-internal.controller.ts:226-227,289-290` |

Class: **A** (compliant with its own declared channel — see §3.0). Not a defect against
`X-Tenant-Id` because this edge never claimed to use that header.

### 3.11 Cross-cutting: every `core/effective_config.py` control-plane pull — Class C

Every Python service pulls SYSTEM-tenant, service-level runtime knobs from `apps/api`'s
`/api/v1/internal/effective-config?service=<svc>` using `X-Service-Token` only, never
`X-Tenant-Id`. Confirmed this is deliberate, not omitted, on the receiving end:

> *"Service-to-service requests carry NO user and NO tenant, so the CLS store is empty...
> Re-establish CLS here, pinned to the SYSTEM tenant."*
> — `apps/api/src/modules/internal/effective-config.controller.ts:43-61`

| Caller | file:line |
|---|---|
| `apps/text` | `apps/text/src/text/core/effective_config.py:196-209`, wired `main.py:284-288` |
| `apps/guardrail` | `apps/guardrail/src/guardrail/core/effective_config.py:160-171` |
| `apps/nlp` | `apps/nlp/src/nlp/core/effective_config.py:157-165` |
| `apps/harness` | `apps/harness/src/harness/core/effective_config.py:149-169` |
| `apps/stt` | `apps/stt/src/stt/core/effective_config.py:220-252` (fails open to `{}` on error — never blocks the worker) |
| `apps/tts` | `apps/tts/src/tts/core/effective_config.py:150-182` (same fail-open) |

Class C for all six: the payload shape (provider concurrency limits, timeouts, retention TTL,
model-weight paths) has no tenant dimension. Also Class C, same reasoning: every service's
fire-and-forget self-registration/heartbeat call to `apps/api` (`hope_env.service_registration`;
e.g. `apps/guardrail/src/guardrail/main.py:159-166`, `apps/nlp/src/nlp/lifespan.py:52-67`,
`apps/stt/src/stt/main.py:176-195`).

Separately, `apps/stt`'s `GET /internal/stt/provider-overrides?tenantId=` pulls **tenant-scoped**
BYOK credential overrides using a **query param**, not a header — fails open (`{}` → env creds) on
any error or missing tenant, by design, so a missing tenant never blocks transcription
(`apps/stt/src/stt/core/effective_config.py:140-187`). This one is tenant-scoped but uses the §3.0
third channel; flag for §4 as needing the same "declare, don't silently default" treatment even
though its channel is a query param, not a header.

### 3.12 `apps/stt` ↔ `apps/api` — `X-Internal-Tenant-Id`, plus two silent outliers

Full detail on the channel choice is in §3.0. On top of that:

| Edge | Sends tenant? | Behaviour if absent | Class | file:line |
|---|---|---|---|---|
| Dramatiq `transcribe_file` actor → `/internal/stt/jobs/{id}/start\|progress\|complete\|fail` | `X-Internal-Tenant-Id`, conditional on truthy `tenant_id` — but `tenant_id` is a **required** positional param of the actor, so effectively always present | n/a in practice | A | `apps/stt/src/stt/transcription/workers/transcribe_file.py:41-44,183,244,396`; `apps/stt/src/stt/core/api_client/gateway.py:99-119,138-230,253-275` |
| `POST /internal/stt/transcripts` | Same conditional `X-Internal-Tenant-Id` | Header omitted if `tenant_id` falsy; `tenantId` still lands in the JSON body separately | A/B (body is the real fallback) | `apps/stt/src/stt/core/api_client/gateway.py:335-411` |
| **`POST /internal/stt/audio-records`** | **No header of either name** — `_request` called with no `headers` kwarg at all | `tenant_id` only in JSON body; the receiving controller method takes no header param either, so this is a body-only channel by mutual, if implicit, agreement | B (inconsistent with every other row in this table — worth normalizing even though currently harmless) | `apps/stt/src/stt/core/api_client/gateway.py:417-475`; `apps/api/src/modules/internal/stt-internal.controller.ts:174-179` |
| **`POST /internal/stt/media`** | **No header of either name**, same as above | Same | B (same normalization note) | `apps/stt/src/stt/core/api_client/gateway.py:481-510`; `apps/api/src/modules/internal/stt-internal.controller.ts:181-186` |
| `X-Internal-Tenant-Id` on receipt (`SttInternalController`) | Declared `@Headers('x-internal-tenant-id') tenantId?: string` — **optional** on every one of the 6 routes that read it, kept for backward compatibility with un-upgraded workers | Falls through to unscoped behavior, silently | B (the header exists but enforcement is opt-in, not mandatory — this is exactly the R2 gap: a receiver still compensating for absence) | `apps/api/src/modules/internal/stt-internal.controller.ts:82-216` |
| STT session-lifecycle reads (`getSessionStatus`, `switchProvider`, `removeSession`, `checkAvailability`, `getLanguageModes`) | No tenant identification at all | Genuinely tenant-less (session-id-keyed ops, or platform capacity/catalog reads with no per-tenant dimension) | C | `apps/stt/src/stt/streaming/session_manager.py` call sites into `gateway.py:203-295` |
| `VoiceProfileService.extractEmbeddings` → STT, `PipelineService.validateYamlRemotely` → STT | No tenant | Pure acoustic-embedding / YAML-syntax ops, tenant applied only when the *result* is persisted, one layer up, in `apps/api` | C | `packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts:150-168`; `packages/applications/src/services/stt/pipeline/pipeline.service.ts:661-690` |
| `update_job_status` (legacy `_request` wrapper, no headers) | Dead code — defined but never called anywhere in `apps/stt/src` | n/a | n/a (flag for deletion, out of TASK-737 scope) | `apps/stt/src/stt/core/api_client/gateway.py:298-329` |
| Redis Streams envelopes (`stt:audio:*`, `stt:result:*`, `stt:control:*`) | No tenant field in the envelope | Not a defect — intra-process transport, keyed by `session_id`; downstream HTTP calls correctly pull `session.tenant_id` from in-memory state, not the stream payload | C | `apps/stt/src/stt/streaming/redis_streams.py`; `apps/stt/src/stt/streaming/schemas.py:324` |

### 3.13 `apps/tts` — genuinely tenant-blind by design (Class C, confirmed)

`grep -rn tenant_id apps/tts/src` returns **zero matches** anywhere in the service. This matches
the documented gateway-resolved-injection pattern (`06-python-services.md`): `apps/api`'s
`SpeechProxyController`/`TtsWsGateway` resolve tenant config themselves and inject the *result*
(routing chain, decrypted BYOK provider overrides, voice bindings) into the request body / WS init
frame — never a header. TTS's own `core/effective_config.py` pull is covered by §3.11.

| Edge | file:line |
|---|---|
| `SpeechProxyController.synthesize` → TTS `/api/v1/audio/speech` — no header; tenant config pre-resolved into body | `apps/api/src/modules/speech/speech-proxy.controller.ts:102-150` |
| `TtsWsGateway.openBridge` → TTS `/ws/audio/stream` — no header; tenant config injected into the `init` frame | `apps/api/src/modules/speech/tts-ws.gateway.ts:208-244` |
| TTS inbound auth (`api/middleware/auth.py`) validates only `X-Service-Token`, no tenant check at all | `apps/tts/src/tts/api/middleware/auth.py:33-57` |

### 3.14 Ingress boundary — governs what tenant even exists to forward

- `ContextInterceptor` 400s an inbound `x-tenant-id` that diverges from the JWT-derived tenant, and
  elevates CLS `tenantId` when a global admin (empty JWT tenant) sends a valid `x-tenant-id`. This
  is the sole source of truth for "what tenant is active" on inbound browser→gateway traffic — it
  says nothing about whether the gateway then forwards that tenant on its OWN outbound calls, which
  (§3.2–§3.3) it mostly doesn't. `apps/api/src/interceptors/context.interceptor.ts:65-102`
- `POST /auth/stream-ticket` embeds `tenantId = CLS active tenant || user.tenantId || null` into the
  minted ticket. Both `SttWsGateway` and `TtsWsGateway` consume this at handshake for local
  bookkeeping/config resolution — never forwarded as an outbound header to the Python service (the
  Python side gets its tenant via §3.0's channel 2/3 instead). `apps/api/src/modules/auth/
  auth.controller.ts:906-936`

### 3.15 Metering impact (owner-directive item 5)

- The judge route's own `UsageDetail`/`cost_basis` (`apps/text/src/text/models/usage.py:268-300`)
  carries **no tenant field at all** — its spend rides back onto the *original* `/generate`
  response, whose tenant identity was already fixed by that request's own (separately audited)
  header. A missing tenant on the judge call itself is a **diagnostics/traceability** gap (bad
  `judge.completed` log correlation), not a billing-mis-attribution risk. Don't overstate this one
  in the risk table.
- The REAL metering risk is upstream, at §3.2/§3.8: when `apps/api`'s BullMQ processors or
  `apps/harness`'s `SmrClient` call `/generate` with no `X-Tenant-Id`, `apps/text` cannot resolve
  the tenant's configured provider/BYOK credential and falls back to the platform default. If the
  tenant's actual configured provider differs from the platform default in `funding`/`cost_basis`
  terms (TASK-735 Phase 2a made both *derived*, not stamped), the derivation runs against the
  **wrong resolved provider** — a silent misattribution that would not throw or log anywhere. This
  ties directly to the risk-table row "Silent mis-attribution persists in metering" (§5) — it is
  live today, not hypothetical, because §3.2's gaps are unconditional, not edge-case.

### 3.16 Summary by class

- **Class A (compliant with the edge's own declared channel)**: `apps/harness ↔ apps/api`
  body/query `tenantId` (§3.10); STT's `X-Internal-Tenant-Id` job-lifecycle calls where `tenant_id`
  is a required actor param (§3.12, row 1). No edge sends a literal `X-Tenant-Id` header
  unconditionally anywhere in the codebase — every real `X-Tenant-Id` send found is conditional on
  a CLS/optional field.
- **Class B (defect — highest-value output of this audit, cited in full above)**: the 9
  `apps/api → apps/text` call sites (§3.2), 4 `apps/api → apps/guardrail/nlp` call sites (§3.3), 2
  `apps/nlp → apps/text` call sites (§3.7), all 5 `apps/harness → apps/text` call sites collapsing
  to 1 client fix (§3.8), STT's 2 header-less body-only routes (§3.12), and the receiver-side gap
  of `X-Internal-Tenant-Id` being optional rather than enforced (§3.12).
- **Class C (genuinely tenant-less by construction — must declare, never be forced to invent a
  tenant)**: guardrail's `job_processor` (§3.6), harness's by-slug MiniCheck weight lookup (§3.9),
  every `core/effective_config.py` pull and service self-registration call (§3.11), all of
  `apps/tts` (§3.13), and STT's capacity/catalog/embedding-extraction reads (§3.12).

## 4. Implementation Plan

The audit (§3) found the ambiguity is not "is the header sometimes empty" — it's that most of the
highest-volume tenant-scoped traffic never attempts to send it at all, and three different wire
channels exist for the same concept. The plan below is ordered so the biggest, cheapest win (§3.2)
lands first, and enforcement never turns on before its callers are fixed.

### 4.1 Declare the tenant-less marker (do this before any caller fix)

A typed sentinel, distinct from a tenant id by construction so it can never be mistaken for one at
the resolver:

```
X-Tenant-Id: tenantless:job-queue      # guardrail async job_processor (§3.6)
X-Tenant-Id: tenantless:worker-weights # harness by-slug MiniCheck weight lookup (§3.9)
X-Tenant-Id: tenantless:control-plane  # every core/effective_config.py pull + self-registration (§3.11)
```

- Format: `tenantless:<reason-slug>` — never a UUID (rules out confusion with a real tenant id or
  `50000000-…`), and the reason slug is required (not just a bare `tenantless` marker) so a log
  line naming the marker is self-explanatory without cross-referencing this ticket.
- Receivers treat any `tenantless:*` value as "no tenant, and that's expected" — skip
  tenant-scoped resolution, go straight to the SYSTEM/platform path, and do NOT log it as an
  anomaly (unlike a genuinely absent header, which is now always a defect once §4.3 lands).
  `apps/guardrail`'s `TenantConfigResolver.resolve()` (§3.5) needs a one-line check added before
  its current `(tenant_id or "").strip() or None` fallback: recognize the `tenantless:` prefix and
  route it to the SYSTEM path explicitly, rather than relying on `None`-coercion to get there.
- Class-C edges that use a query param instead of a header (STT's `provider-overrides`, §3.11)
  carry the same sentinel value in the `tenantId` query param — one marker format, two transports.
- Do NOT invent a UUID-shaped sentinel (e.g. an all-zeros or all-F variant) — the whole point is
  that it must fail a `looksLikeUuid()`/`z.string().uuid()` check so a future bug that treats it as
  a real tenant id is caught by existing validation, not silently accepted.

### 4.2 Fix the callers (ordered by leverage, from §3)

1. **`apps/harness` → `SmrClient.generate()` (§3.8)** — highest leverage, one file. Add
   `tenant_id: str` to the method signature, thread it onto `GenerateInput` and
   `ApplyRedactionInput` (currently missing the field entirely), and actually forward the value
   `PlanLoopInput`/`SpecialistAnalysisInput`/`DeriveContextInput` already carry but currently drop.
   Fixes all 5 call sites in `activities.py` at once. Also add `X-Service-Token`, which this client
   was missing independent of this ticket.
2. **`apps/api` → `apps/text` (§3.2)** — the biggest concentration and the highest live traffic
   volume (every clinical summary, every live-doc flush). Two shapes:
   - `SmrProxyController.getForwardHeaders()` and `SmrCompatController`'s equivalent: these are
     the two chokepoints — fixing the shared header-building helper likely closes the two proxy
     controllers in one change. Source the tenant from CLS the same way `AiInferenceClient`
     already does correctly (§3.3), not by re-deriving it per call site.
   - The 6 application-service/processor call sites (`SummaryProcessor`, `PreSummaryProcessor`,
     `ComprehensiveSummaryProcessor`, `ChainSummaryService`, `SummaryService.executeSmrGenerate`,
     `LiveDocumentationService`, `DnaWritingStyleProcessor`) each already have `tenantId` in a
     local variable in scope — this is a header-assignment fix, not a plumbing fix. Consider
     extracting one shared "SMR call header" helper so a 7th caller can't reintroduce the gap.
3. **`apps/api` → `apps/guardrail`/`apps/nlp` (§3.3)** — `GuardrailPhiRedactor.redact`,
   `GuardrailGroundednessTool`, `NlpExtractionTool`, `SummaryService.callNlpService`. Same
   shared-helper approach; `callNlpService` also needs `X-Service-Token` added (currently sends no
   headers object at all).
4. **`apps/nlp` → `apps/text` (§3.7)** — tighten `TopicClassificationRequest.tenant_id` /
   `IntentClassificationRequest.tenant_id` from optional to required once the gateway-side callers
   (fixed in step 2/3) always populate it; `ExternalTextClient.generate_label` then no longer needs
   the `if tenant_id:` guard.
5. **`apps/stt`'s two header-less routes (§3.12)** — `create_audio_recording`/`create_media`:
   normalize to the same `X-Internal-Tenant-Id` pattern every other row in that client already
   uses, for consistency (currently body-only and harmless, but inconsistent).
6. **`apps/guardrail → apps/text` judge client, when TASK-735 Phase 2b is built (§3.4)** — the new
   `ExternalTextClient` in guardrail must forward whatever tenant guardrail itself resolved
   (including the `tenantless:*` marker when guardrail resolved via §3.6/§3.9's tenant-less paths)
   — never silently drop it the way every other client audited here originally did.

### 4.3 Enforce at the receivers (only after 4.2 ships, warn-only first)

- Add a middleware/dependency check on each tenant-scoped internal endpoint
  (`apps/text/generate`, `/embeddings`; `apps/guardrail/medical/validate`, `/guardrail/*`;
  `apps/nlp/classify/*`) that classifies the inbound `X-Tenant-Id` into exactly three states:
  present-and-valid, present-and-`tenantless:*` (§4.1 — accepted, routes to SYSTEM), or absent.
- **Warn-only window** (per risk row 1, §5): absent header logs a structured warning
  (`tenant_header.missing`, with caller identified via `X-Service-Token`'s owning service where
  possible) but still serves the request via today's SYSTEM-fallback behavior. Roll out
  per-endpoint, starting with `apps/text/generate` (§3.2's fix should make its warn rate ~0
  immediately) before touching `apps/guardrail`'s four surfaces.
- **Flip to enforcing** only once an endpoint's warn rate is zero for a full deploy cycle. Enforcing
  means a typed 4xx (`428 Precondition Required` — mirrors the existing `RequiresIfMatch`/ETag
  convention in `05-nestjs-api.md`, so a missing mandatory header is 428 the same way a missing
  `If-Match` is), never a silent resolve.
- `apps/harness` and `apps/stt`'s own declared channels (§3.0 channels 2/3) get the equivalent
  treatment on their own wire format — do not require literal `X-Tenant-Id` there; enforce
  "`tenant_id`/`X-Internal-Tenant-Id` present or explicitly `tenantless:*`" instead. Concretely:
  `SttInternalController`'s 6 `@Headers('x-internal-tenant-id') tenantId?: string` params (§3.12)
  move from optional to required-or-`tenantless:*`.

### 4.4 Contract-test the edges

- One test fixture per class-A/B edge in §3 asserting the header (or its declared-channel
  equivalent) is present on every outbound call — fails the build if a new peer client ships
  without it. Natural home: `tests/contracts/` per `01-development-workflow.md`'s test-placement
  table.
- A lint rule (`arcaai-internal`, mirroring the existing `no-direct-downstream-url-env` pattern in
  `05-nestjs-api.md`) that flags a new `axiosRef.post`/`httpService` call to a `*_URL` downstream
  service without an accompanying `X-Tenant-Id`/`X-Internal-Tenant-Id` header literal or the
  approved header-builder helper (§4.2 step 2) in the same call — this is what would have caught
  all 9 of §3.2's gaps at review time.

### 4.5 Revisit the SYSTEM-fallback resolver (last, not first)

Only after 4.3 is enforcing (not just warn-only) on `apps/guardrail`'s four surfaces: the
SYSTEM-on-absent-header behavior in `TenantConfigResolver.resolve()` (§3.5) can be tightened,
because "absent" no longer means "maybe dropped in transit, maybe legitimately tenant-less" — it
means a caller that skipped enforcement, which by then is a bug to fix, not a resolver decision. At
that point `tenant_id is None` in `resolve()` becomes an assertion failure, not a fallback branch;
only `tenantless:*` remains a legitimate SYSTEM-routing input.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Enforcing before every caller is fixed breaks live paths | Warn-only window first (§4.3); flip to enforcing per-endpoint, not globally — start with `apps/text/generate` only once §4.2 step 2 ships |
| The job queue and harness by-slug lookup legitimately have no tenant | R3 — declare tenant-less explicitly via the `tenantless:<reason>` marker (§4.1); never enforce a header they cannot supply |
| A sentinel value for "tenant-less" gets reused as a real tenant | Non-UUID `tenantless:<reason>` format (§4.1) fails any `looksLikeUuid()`/`z.string().uuid()` check by construction — and never `50000000-…` |
| Silent mis-attribution persists in metering | §3.15: confirmed live today at §3.2/§3.8 — a missing header makes `apps/text` fall back to the platform default provider, and TASK-735 Phase 2a's derived `funding`/`cost_basis` then runs against the wrong resolved provider with no error anywhere. Fixing §3.2/§3.8 (4.2 steps 1-2) closes this directly; the judge route itself (§3.4) is NOT a metering risk — it carries no tenant in its own `UsageDetail` |
| **New** — three incompatible wire channels for "tenant" exist (`X-Tenant-Id`, `X-Internal-Tenant-Id`, body/query `tenantId`) (§3.0) | A blanket "require `X-Tenant-Id`" rollout would 400 every STT worker→gateway call and every harness↔gateway call. §4.3 enforces per-edge against each edge's own declared channel, not one header name globally |
| **New** — `X-Internal-Tenant-Id` is currently *optional* on 6 of 8 `SttInternalController` routes, explicitly for backward compatibility with un-upgraded workers (§3.12) | This is itself an R2 violation (receiver compensating for absence) hiding in plain sight; §4.3 must include this controller in the enforcement rollout, not just the Python-service surfaces the ticket's origin list named |
| **New** — fixing §3.2/§3.3 via a shared header-builder helper could be skipped by a *new* caller added after this ticket closes if the helper isn't the only sanctioned way to call out | §4.4's lint rule is the backstop — don't rely on code review alone to catch the 10th call site the way review missed the first 9 |
| **New** — guardrail's `TenantConfigResolver.resolve()` needs a code change to recognize `tenantless:*` (§4.1) before enforcement can safely land on guardrail's four surfaces, or a legitimately tenant-less caller (job_processor's SYSTEM path, once it forwards the marker) gets treated as a defect by the new 428 | Sequence `tenantless:*` support (§4.1) strictly before §4.3's guardrail rollout; add a guardrail unit test asserting `tenantless:*` inputs route to SYSTEM without a warning |

## 6. Implementation Summary

_Audit and plan complete (§3–§5); no application code changed by this pass (read-only audit per
scope). Implementation (§4.2 onward) not started._

Headline findings for whoever picks up §4.2:
- The single biggest gap is `apps/api → apps/text` (§3.2): 9 call sites, several with `tenantId`
  already in scope one line above the HTTP call — a pure header-assignment fix, not a plumbing
  problem.
- The single highest-leverage fix is `apps/harness`'s `SmrClient.generate()` (§3.8): one method
  signature change closes 5 call sites.
- Three incompatible wire channels for "tenant" exist today (§3.0) — `X-Tenant-Id` (text/
  guardrail/nlp), `X-Internal-Tenant-Id` (stt↔api, deliberately different to dodge
  `ContextInterceptor`'s divergence 400), and body/query `tenantId` (harness both directions, two
  stt routes, the provider-overrides query param). §4's plan enforces per-edge against each edge's
  own channel — a blanket "require literal `X-Tenant-Id`" would break STT and harness.
- Class C (genuinely tenant-less, confirmed by construction, must never be forced to invent a
  tenant): guardrail's `job_processor` (§3.6, no `tenant_id` column in the job schema at all),
  harness's by-slug MiniCheck weight lookup (§3.9, worker-process-resident artifact, not
  per-tenant), and every `core/effective_config.py` control-plane pull across all six services
  (§3.11, SYSTEM-tenant by design, confirmed by `apps/api`'s own `effective-config.controller.ts`
  comment).

## 7. Change History

| Date | Change |
|---|---|
| 2026-08-16 | Ticket created from owner directive, promoted out of TASK-735 gap G-07. Propagation audit dispatched. |
| 2026-08-16 | Propagation audit completed (§3, 16 subsections) via six parallel read-only sweeps across `apps/api`, `apps/text`, `apps/guardrail`, `apps/nlp`, `apps/harness`, `apps/stt`/`apps/tts`; every citation spot-verified by direct file reads before being committed to this doc. §4 implementation plan and §5 risk table redrafted against the findings. No application code changed. `apps/text` and `apps/harness` were mid-edit by other agents during the audit — their line numbers may have shifted since and should be re-verified before implementation. |
