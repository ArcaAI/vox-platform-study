# TASK-1035 — LLM egress safety, one prompt composer, schema-aware studio

**Status:** Review — P0, P1 and P2 merged on dev-2.2 2026-10-02; one gate pass green (two pre-existing failures); live preview verified; cluster rollout + live CLOUD proof pending
**Type:** feature + bugfix (safety) + refactor
**Branch:** dev-2.2
**Raised:** 2026-10-02

## 1. Requirement Analysis

Owner asks, 2026-10-02:

| # | Requirement |
|---|---|
| R1 | Simplify context schemas, Agent studio and Workflow studio configuration. |
| R2 | Context-schema fields are offered as **intelligent suggestions** while configuring agents and workflows (prompts, variable bindings, conditions). |
| R3 | Every LLM request is composed **one correct way**: selected instruction / prompt template + injected context + rules + redaction. |
| R4 | Guardrails always check the **request and the response** for safety. |
| R5 | PII/PHI is detected with **GLiNER2**. |
| R6 | Local / built-in providers (LM Studio, vLLM, …): **detect but do not redact** (owner answer 2). |
| R7 | Cloud providers: **always** redact PII/PHI and other sensitive information. |

Owner decisions already taken (2026-10-02):

| Id | Decision |
|---|---|
| OD-1 | **Remove guardrail opt-outs** — tenant / agent / workflow / node (TASK-890 OD-R is reversed). |
| OD-2 | Local providers: PII detection still runs (audit + `pii_leak` evidence), no redaction. |
| OD-3 | **Keep the medical-relevance LLM judge** — the platform is for medical use only. |

## 2. Current State Evaluation (code-verified 2026-10-02)

### 2.1 Guardrails (R4–R7)

| Requirement | Status | Evidence |
|---|---|---|
| R4 request check | PARTIAL | `apps/text` input gate = medical-relevance judge only (`generate.py:171-251` → guardrail `/api/medical/validate` → granite-guardian 8B via text `/generate/internal/judge`, p99 ≈ 50 s, `runtime_defaults.py:201-203`). Skipped when `require_medical=false` (`external_guardrail.py`). `/api/v1/guardrail/screen/inbound` has **zero callers** outside `apps/guardrail`. |
| R4 response check | EFFECTIVELY OFF | Output gate calls `/screen/outbound` (`output_gate.py:173`), but the platform seed disables every outbound check: `response_safety`, `response_toxicity`, `response_refusal`, `pii_leak` (`seed/18-guardrail-availability.ts:53-59`). `containment_echo` is skipped because text sends no nonce (`output_gate.py:197`). Streaming is screened only after the client already has the tokens (`routing/streaming.py:414`). |
| R4 bypasses | PRESENT | Per-call opt-out (`core/guardrail_posture.py`, `workflow-contract/src/guardrail-optout.ts`, `harness/.../guardrail_optout.py`, agent `parameters-form.tsx`); `/translate` ungated; platform kill switch `text.externalGuardrail.enabled` (code floor `False`, seeded `true`). |
| R5 GLiNER2 | PARTIAL | GLiNER2 serves guardrail `/redact` + `pii_leak` via `apps/nlp/.../gliner2_guard.py:102`; models `fastino/gliner2-privacy-filter-PII-multi`, `GLiNER2-Guardrails-PII-Multi`, `gliguard-LLMGuardrails-300M` (`seed/ai-models/nlp.ts`). **LLM egress redaction uses Presidio + spaCy instead** (`harness/guards/phi/redactor.py:44,127`). The 42-label taxonomy has no MRN / patient-id / encounter-id / staff-id label. |
| R6 local | PARTIAL | Locality known only to harness, via env allowlist `HARNESS_PHI_LOCAL_PROVIDERS` (`harness/core/config.py`), against the no-config-in-env rule. Data already exists for a proper decision: `AiModel.deploymentKind` (`SELF_HOSTED / CLOUD / BYOK`, `enums.prisma:622`) and `ENGINE_SERVED_PROVIDERS` (`ai-provider-connection/constants.ts:222`). |
| R7 cloud | MISSING on most paths | `apps/text` contains **no redaction code** (verified: no `redact`/`pseudonym` in `apps/text/src/text`). Agent invocation, live realtime, summary/finalize assembly and the text proxy all post unredacted to text → provider. Only harness activities call `ensure_egress_safe`, and `phi_fail_closed=false` degrades open. **No re-identification** anywhere — a cloud-written note can persist `<PERSON>` tokens. |

### 2.2 Prompt composition (R3)

Four TS/Python composers plus a palette lane, which disagree with one another:

| Composer | Body placement | Missing variable | Output-language step | Cloud redaction |
|---|---|---|---|---|
| A/B agent invoke + bench (`agent-invocation.service.ts:292-348`, `agent.service.ts:706-828`) | system | 400 | no | no |
| C live realtime (`live-documentation.service.ts:6763-6858`) | system | node degraded | yes (user msg) | no |
| D durable `core.agent` (`core.py:794-857,1306-1561`) | system | step degraded | yes (system msg) | Presidio |
| E `PromptAssemblyService.assemble` (`prompt-assembly.service.ts:534-763`) | **user**; system = constant | **renders empty + warn** (`:792-837`) | **no** | harness only |
| F text proxy `/generate` (`text-proxy.controller.ts:1458`) | system, **raw unrendered `template.content`** | literal `{{x}}` sent | no | no |
| G palette `text_generate.py` | ignores the assembled `systemPrompt` (`consultation_compose.py:155-170` vs `text_generate.py:119`) | — | — | Presidio |

Further defects:

- E takes only the first unconditional fragment (`prompt-resolution.service.ts:812`), so TASK-947 conditional fragments never apply on finalize.
- The fallback chain sends the PRIMARY agent's output schema to every candidate (`core.py:1545-1547`).
- No provider prompt caching (`cache_control` absent); `tokenBudget.perRun = 0` means unbounded; context is re-sent on every live flush.
- No dry-run of the composed prompt for a real consultation, and no prompt record for incident reconstruction.

### 2.3 Studio UX (R1, R2)

- One agent + workflow bound to a schema takes about 6 screens and 15+ steps. The context schema is picked in 3 places: `Agent.contextSchemaId`, the workflow trigger node, and implicitly by name in template text.
- The agent wizard step named "Schemas" (`create-agent-wizard.tsx:416-431`) is the input/output JSON schema. The context schema is buried in step 3 (`instruction-binding-form.tsx:209-253`).
- No inline completion anywhere. Prompt, instruction and CEL editors are plain `<Textarea>`. `@arcaai/ui` `CodeEditor` is a JSON-only textarea overlay.
- Only schema-aware aid: click-insert chips on `core.agent` prompt variables (`prompt-variables-field.tsx`), fed by a CLIENT mirror `lib/trigger-variable-paths.ts`.
- Agent context-path binding is free text with a hardcoded `context.patientAge` placeholder (`variable-bindings-fieldset.tsx:83`). The agent form never fetches the schema definition (`useContextSchemaOptions` returns id/label only).
- `PROMPT_VARIABLE_UNDECLARED` is a WARNING (`publish-findings.ts:97`), shown only in the agent Overview tab, never at the field.
- `context.*` (agent) vs `trigger.*` (workflow) resolve differently (`agent.service.ts:2060-2070`).
- Unused asset: schema kinds already carry a **PHI class** (`kind-form.tsx`), which nothing on the egress path reads.

## 3. Target Design

### 3.1 One egress pipeline, enforced at the chokepoint (`apps/text /generate`)

Every LLM call already goes through `apps/text`. That is where the rules become non-bypassable:

```
gateway/harness ── compose (one composer, §3.3) ── stamps: model locality + schema PHI field map
   │
apps/text /generate
   1. classify locality      SELF_HOSTED / engine-served  → LOCAL ; CLOUD / BYOK / unknown → CLOUD (fail closed)
   2. detect   (always)      ONE GLiNER2 pass: PII spans + prompt safety + jailbreak   [guardrail /screen/inbound]
      ∥ medical judge (OD-3) — runs CONCURRENTLY with step 2, still blocking
   3. [CLOUD] pseudonymize   schema-PHI fields deterministically + GLiNER2 spans in free text
                             consistent per-request tokens [PATIENT_1] [MRN_1]; vault = request-scoped memory only
   4. provider call
   5. output screen          response_safety + response_toxicity (+ pii_leak, see below)
                             streaming: sliding sentence window screened BEFORE release
   6. [CLOUD] re-identify    restore tokens (stream-safe: buffer across a split token)
   7. return / persist       audit: locality, detected label counts, redaction count, verdicts — never values
```

- **Locality is derived from data, not env.** The gateway stamps `locality` per `provider_overrides` entry, from `AiModel.deploymentKind` + `ENGINE_SERVED_PROVIDERS`. `apps/text` treats an absent or unknown value as CLOUD. Delete `HARNESS_PHI_LOCAL_PROVIDERS`.
- **`pii_leak` semantics per locality.**
  - CLOUD: after the provider returns and before re-identification, any real PII in the output was hallucinated or leaked, so the response is blocked.
  - LOCAL: detect-only and audited (OD-2). A clinical note legitimately names the patient.
- **Medical judge (OD-3)** stays blocking but runs in parallel with the GLiNER2 detect pass, so it adds max(judge, detect) instead of their sum. On CLOUD the judge must see redacted text or run on a local model — today it is granite-guardian (SELF_HOSTED); enforce that by seed + publish check.
- **One engine.** Presidio + spaCy are retired from the harness egress path. `ensure_egress_safe` becomes a thin call to the text pipeline (or is deleted where the call already goes through `/generate`).
- **Labels.** Add MRN, patient id, encounter id, staff id, facility, and dates of birth / service to the PII taxonomy (`AiModel._metadata.labelTaxonomy`, GLiNER2 is zero-shot so labels are config, not training). Clinical entities stay unmasked (existing `redact.py:17-33` rule).
- **Opt-outs removed (OD-1).** Remove `guardrail_posture` opt-out, `guardrail-optout.ts`, harness `guardrail_optout.py`, the agent/node/workflow fields and the console toggle. The platform kill switch goes too — see OD-4.
- **`/translate` gated**, like `/generate`.

### 3.2 Performance budget

| Step | Target |
|---|---|
| GLiNER2 joint detect (300M, GPU, batched, ≤4k-char chunks in parallel, not sequential) | p95 ≤ 60 ms per 4k chars |
| Pseudonymize + re-identify | in-process, ≤ 5 ms |
| Output screen | p95 ≤ 60 ms (one GLiNER2 classify call) |
| Medical judge | unchanged, concurrent with detect; verdict cache by `sha256(normalized system+user)` per tenant, TTL-bounded — live flushes repeat the same prefix |

### 3.3 One prompt composer (R3)

- **Single contract** in `@arcaai/workflow-contract` (`composeMessages`), with a Python mirror and a cross-language golden fixture of FINAL messages (not just the grammar):
  - **system** = platform rules → agent instruction (composed fragments) → output-language step → output contract. These layers are stable, so they hit the vLLM prefix cache, and `cache_control` is set on cloud providers that support it.
  - **user** = wrapped data blocks (spotlighting, EXTERNAL_DATA), in fixed order, each with a char/token budget.
- **Missing variable fails by name in every lane.** E's render-empty and F's raw `{{x}}` both go.
- **Lane E** moves onto `composeMessages` and honours conditional fragments; `primaryTemplateId` stops being a composition shortcut.
- **Lane F** (`text-proxy.controller.ts` raw `template.content`) is deleted. Its callers are routed through the agent/assembly path.
- **Lane G** consumes the assembled `systemPrompt`.
- The fallback chain uses each candidate's own output schema.
- **Prompt Inspector.** A dry-run on a real consultation id returns composed messages, the redaction diff (labels and counts; values only to an authorized viewer), guardrail verdicts and the token estimate. Composed prompts are stored encrypted (Vault Transit) under a retention setting, for incident reconstruction.

### 3.4 Schema-aware, simpler studio (R1, R2)

- **Shared path source.** `schemaVariablePaths(definition, root)` in `@arcaai/workflow-contract` is used by the server publish checks AND the console. It replaces `trigger-variable-paths.ts` and the agent sole-kind special case. Each entry carries `{ path, type, required, phiClass, description }`.
- **New `TemplateEditor` in `@arcaai/ui`.**
  - Typing `{{` (and `context.` / `trigger.` inside CEL) opens a completion list showing type, required and PHI badges.
  - A debounced `templateReferenceProblems` lints inline with squiggles at the field.
  - It is used for template content, inline instructions, fragments, `when` conditions, node prompts and variable bindings, replacing the free-text inputs.
- **`PROMPT_VARIABLE_UNDECLARED` → ERROR** (blocks publish) on agents and workflows. Findings render at the offending field, not only in Overview.
- **One schema choice.** The workflow trigger owns the context schema, and an agent used by that workflow inherits it. A standalone agent picks it once, in the wizard's first step. The wizard step "Schemas" is renamed **"Input / Output contract"**.
- **One root name.** OD-6 decides whether `trigger` becomes an alias of `context` or the reverse.
- **Quick start.** One page — schema preset → agent (template + model) → workflow → assignment. The existing screens stay for advanced editing.

## 4. Remaining Owner Decisions

| Id | Question | Recommendation |
|---|---|---|
| OD-4 | Platform kill switch `text.externalGuardrail.enabled` — remove with the opt-outs, or keep as super-admin break-glass? | Remove it as a setting; break-glass is a redeploy. "Always check" then holds by construction. |
| OD-5 | `require_medical` is a per-tenant push today (a tenant may turn the judge off). Under OD-3, force it on for every business-plane call? Internal service calls (nlp topic/intent, the judge itself) declare `exempt: internal` explicitly. | Yes — force on; the internal exemption is named, never a missing flag. |
| OD-6 | One prompt root: keep `context` (agent) or `trigger` (workflow)? | `context` everywhere, with `trigger` accepted as a deprecated alias for one release. |
| OD-7 | Streaming output: screen a sliding sentence window before release (adds about one sentence of latency), or hold the whole response for clinical notes? | Sliding window for live/streamed lanes; whole-response for finalize (already non-streamed). |
| OD-8 | `TemplateEditor` engine: extend the dependency-free overlay approach of `CodeEditor`, or adopt CodeMirror 6 (new dependency, real completion/lint APIs)? | CodeMirror 6 — completion, lint gutters and a11y come built in. |
| OD-9 | Store composed prompts (encrypted) for audit? Retention? | Yes, Transit-encrypted, 30 days, SUPER_ADMIN + tenant-admin read with audit. |

**All six accepted by the owner, 2026-10-02**: OD-4 kill switch removed · OD-5 `require_medical` forced on (internal exemption named) · OD-6 `context` root, `trigger` alias for one release · OD-7 sliding sentence window for streams, whole response for finalize · OD-8 CodeMirror 6 · OD-9 store composed prompts, Transit-encrypted, 30 days.

## 5. Implementation Plan

### 5.0 P0 wire contract (frozen before the lanes start)

**Gateway / harness → `apps/text` `POST /generate`** — new fields on `GenerateRequest`:

| Field | Type | Meaning |
|---|---|---|
| `provider_locality` | `dict[str, "local" \| "cloud"] \| None` | Keyed by provider name, covering `provider` AND `fallback_provider`. Stamped by the caller from `AiModel.deploymentKind` (`SELF_HOSTED` ⇒ local; `CLOUD`/`BYOK` ⇒ cloud) and `ENGINE_SERVED_PROVIDERS` (⇒ local). |
| `known_phi` | `list[{label: str, value: str}]` (value ≥ 2 chars, ≤ 200 items) | Values of schema-PHI-class context fields plus the patient/clinician identity the caller already holds. They are replaced deterministically on cloud, in addition to GLiNER2 spans. Never logged. |
| `medical_exempt` | `"internal" \| None` | Replaces the tenant-pushable `require_medical=false`. Only internal service callers (nlp topic/intent) set it. The medical judge otherwise ALWAYS runs (OD-3/OD-5). |

**Removed fields:** the guardrail opt-out (`guardrail_policy.enabled=false` / `opted_out` and the posture opt-out push) and the `text.externalGuardrail.enabled` kill switch (OD-1, OD-4). `guardrail_policy.require_medical` is removed. `include_reasoning` stays.

**Locality resolution inside `apps/text`**, per provider actually called, including the fallback:

1. The stamp is `local` AND the provider is not in `KNOWN_CLOUD_PROVIDERS` (`azure`, `azure-openai`, `bedrock`, `openai`, `anthropic`, `vertex`, `google`, `gemini`, `mistral`, `cohere`, `groq`, `together`, `openrouter`) ⇒ **local**.
2. No stamp AND the provider is in `ENGINE_SERVED_PROVIDERS ∪ {built-in}` ⇒ **local**.
3. Everything else ⇒ **cloud** (fail closed). A stamp can never downgrade a known cloud provider.

**Cloud + image `content_parts`** are ALLOWED (owner, 2026-10-02). Images pass through unchanged, because they cannot be pseudonymized. Every text part is still pseudonymized. The `egress` object carries `images_unredacted: int` for audit.

**Response** (non-stream body, and the terminal SSE event) — new `egress` object:
`{ locality: "local"|"cloud", detected: {label: count}, redacted: int, restored: int, images_unredacted: int, pii_leak_blocked: bool }`. It carries counts only, never values.

**Pseudonym token grammar:** `[<LABEL>_<n>]`, where LABEL is the uppercase snake form of the taxonomy label and n is per-request, per-label, stable per distinct value (case-insensitive, whitespace-normalised). The provider-facing system prompt gets one platform sentence appended on cloud: tokens are placeholders and must be copied verbatim.

**Guardrail (internal to the text lane):** `/api/v1/guardrail/screen/inbound` gains `include_pii_spans: bool`. When true, it runs nlp `/guard/pii` (routing `guardrail.pii.spans`) CONCURRENTLY with classification and returns `pii_spans: [{label,start,end,text,score}]`. Text calls `/screen/inbound` and `/api/medical/validate` concurrently on every call. The internal judge lane (`/generate/internal/judge`) refuses a provider resolving to cloud with 503 `JUDGE_PROVIDER_NOT_LOCAL`. It stays outside the guardrail to avoid the call cycle, and so it is only ever allowed on a local model.

**Seed defaults (`18-guardrail-availability.ts`):** `jailbreak_detection`, `prompt_safety`, `prompt_toxicity`, `response_safety`, `response_toxicity`, `pii_leak`, `containment_echo` = enabled. `response_refusal` stays off, because a refusal is not unsafe.

Lanes are partitioned by package, so each worktree has one writer (rule 14). The orchestrator owns `db:*`, `pnpm install` and merges. Per the owner rule, lanes run only their own RED → GREEN tests, and one gate pass follows after the full merge on dev-2.2.

| Lane | Owns | Depends on |
|---|---|---|
| L1 contract | `packages/workflow-contract` (+ Python mirrors in `apps/harness/.../interpreter`), `packages/types` | — |
| L2 egress | `apps/text` (pipeline, locality, pseudonymize/re-identify, stream buffer), `apps/guardrail` (inbound joint call, outbound per locality) | L1 (locality type) |
| L3 nlp | `apps/nlp` GLiNER2 joint detect + parallel chunking; label taxonomy seed | — |
| L4 gateway | `packages/applications` (locality stamping, PHI field map, lane E onto composer, lane F removal, opt-out removal, `require_medical`), `apps/api`, seeds `18-guardrail-availability`, `16-ai-routing-policy` | L1 |
| L5 harness | `apps/harness` (retire Presidio egress, use text pipeline, lane G fix, fallback schema fix, opt-out removal) | L1, L2 |
| L6 console | `packages/ui` `TemplateEditor`, `apps/admin-console` (agents, workflow-studio, prompt-templates, context-schemas, quick start, inspector) | L1 |

### 5.0b P1/P2 contract (frozen 2026-10-02, before wave A)

**Waves.** A = CONTRACT, alone. B = GATEWAY-COMPOSER ∥ HARNESS-COMPOSER ∥ CONSOLE, all branched AFTER wave A is merged. Every B lane consumes the A exports below and never re-defines them.

**A — `@arcaai/workflow-contract` exports. Python mirror under `apps/harness/src/harness/temporal/interpreter/`, pinned by a golden fixture in `tests/contracts/`:**

| Export | Signature / rule |
|---|---|
| `composeMessages(input)` → `{ system: string, user: string, selected, excluded, blocks: {key, chars, truncated}[] }` | `input = { platformRules: string; resolvedPrompt: ComposableResolvedPrompt; scope; outputLanguage?: {name: string} \| null; outputContract?: string \| null; dataBlocks?: {key: string; label: string; content: string \| null; maxChars?: number}[]; templateRef? }`. <ul><li>**system** = `platformRules` → composed instruction (`composePrompt`) → output-language step (one fixed sentence naming the language) → `outputContract`, each joined by `\n\n` and omitted when empty.</li><li>**user** = data blocks in the GIVEN order, each wrapped `<<EXTERNAL_DATA key="…" label="…">>\n…\n<<END_EXTERNAL_DATA>>`. Empty or null blocks are skipped. A block over `maxChars` is cut at the last newline before the cap, marked `truncated: true` and suffixed with `\n[…truncated]`.</li><li>Throws `PromptVariableUnresolvedError` listing EVERY missing path (no empty rendering, ever).</li></ul> |
| `PLATFORM_RULES_VERSION` + `platformRules()` | The one platform system text (moved from `PLATFORM_SYSTEM_PROMPT` in `prompt-assembly.service.ts`, content unchanged). |
| `buildPromptScope(parts)` | Canonical scope (moved from `applications/.../agent-prompt-scope.ts`, behaviour unchanged) PLUS OD-6: `trigger` is an alias of `context` (same object) whenever only one of them is supplied. When both are supplied they are kept as given (the workflow lane's payload). |
| `schemaVariablePaths(definition, root = 'context')` → `{ path, type, required, phiClass: string \| null, description: string \| null, deprecated: boolean }[]` | <ul><li>Derived from a `ConsultationContextSchemaVersion.definition`: kinds plus the declared fields of STRUCTURED kinds, applying the agent sole-kind collapse when `root === 'context'` and exactly one kind exists.</li><li>Replaces the console's `lib/trigger-variable-paths.ts` and the gateway's `soleContextKindSchema` derivation.</li><li>Paths are sorted and stable.</li></ul> |
| `PROMPT_VARIABLE_UNDECLARED` severity | `ERROR` (blocks publish) for agents AND workflows. `PROMPT_FRAGMENT_CONDITION_ROOT` stays WARNING. |

**B — GATEWAY-COMPOSER (`packages/{applications,database,domains}` + `apps/api`):**

- **Every gateway composer uses `composeMessages`.** That covers agent invoke and bench (A/B), live (C, with its stable-prefix ordering preserved as data-block order) and `PromptAssemblyService` (E, template body moves to SYSTEM, conditional fragments honoured, a missing variable is a 400 `PROMPT_VARIABLE_UNRESOLVED` naming the variables).
- **Lane F** (`text-proxy.controller.ts` raw `template.content`) renders through `composeMessages` with the template as an inline resolved prompt. It never sends unrendered `{{…}}`.
- **Prompt Inspector API:** `POST admin/consultations/:consultationId/prompt-preview` with body `{ phase: 'live' | 'pre-summary' | 'finalize', agentSlug?: string }`, answering 200 `{ system, user, locality, providerView: { system, user } | null, egressPreview: { detected: Record<string,number>, redacted: number }, tokenEstimate: { system: number, user: number }, resolvedFrom, selected, excluded, blocks }`.
  - `providerView` is the pseudonymized text a cloud provider would receive, and is null on local.
  - Gate: `@CanRead('Consultation')`, cross-tenant 404, audited with `forceAuditLog: true`. The detect call reuses the guardrail `/screen/inbound` `include_pii_spans`.
- **OD-9 storage:** Prisma model `ComposedPromptRecord` with fields `tenantId`, `consultationId?`, `agentSlug?`, `phase`, `provider`, `locality`, `systemCiphertext`, `userCiphertext`, `keyVersion`, `sha256`, `createdAt`, plus the standard template.
  - Encryption uses the existing Vault Transit service.
  - Written fire-and-forget by every gateway text call site and by `POST internal/composed-prompts` (service-token, for the harness).
  - Read via `GET admin/composed-prompts?consultationId=` (metadata) and `GET admin/composed-prompts/:id` (decrypted; `@CanRead('Consultation')`, audited).
  - Retention comes from the governed setting `composedPrompts.retentionDays` (default 30) with a daily purge (hard delete is sanctioned for an expired PHI audit copy; state it in the code).
  - The migration is authored OFFLINE with `prisma migrate diff --from-schema <old> --to-schema <new> --script`. The lane never touches a DB.
- **OD-6 / R1 on the backend:**
  - Agent publish validates prompt paths against its own schema, or, when it has none and is bound by a workflow node, against that workflow's trigger schema (inheritance).
  - The agent detail response exposes `effectiveContextSchema: { id, versionNumber, inheritedFrom: 'agent' | 'workflow' } | null`.

**B — HARNESS-COMPOSER (`apps/harness`):**
- **Durable `core.agent` (D)** and the palette lane switch to `compose_messages` (the Python mirror), with the output-language step moving into it.
- **`trigger`/`context` alias** in the Python scope (OD-6).
- **Recording:** after each text call it posts the composed messages to `POST /api/v1/internal/composed-prompts` (fire-and-forget, bounded timeout, never fails the step).

**B — CONSOLE (`packages/ui` + `apps/admin-console`):**
- **`TemplateEditor` in `@arcaai/ui`** (CodeMirror 6; deps already added):
  - Typing `{{` opens a completion list fed by a `paths: VariablePath[]` prop; each item shows a type, required and PHI badge.
  - A `lint(content) => {from,to,message,severity}[]` prop renders squiggles.
  - It also offers CEL mode (completion after `context.` / `trigger.` / `nodes.`).
  - It meets a11y requirements (labelled, keyboard completion) and supports both themes.
- **Admin-console screens:**
  - Every prompt, instruction, fragment, `when`, node-prompt and variable-binding field uses `TemplateEditor` with `schemaVariablePaths` and debounced `templateReferenceProblems`.
  - Findings render at the field.
  - The agent wizard step "Schemas" is renamed "Input / Output contract", and the context schema is chosen in step 1.
  - The agent detail shows an inherited schema read-only.
  - Add a Quick-start page (preset schema → agent → workflow → assignment) and a Prompt Inspector screen on the consultation detail, using the API above.

### 5.1 TDD test list (RED first)

**L1**
- `composeMessages` golden fixture: identical system/user output in TS and Python, for template, inline and composite instructions × language step × data blocks.
- Missing variable throws `PROMPT_VARIABLE_UNRESOLVED` naming every missing path.
- `schemaVariablePaths` covers kinds, structured fields, `phiClass`, and sole-kind collapse.
- `PROMPT_VARIABLE_UNDECLARED` severity is ERROR.

**L2**
- Unknown locality is treated as CLOUD and redacted.
- CLOUD: schema-PHI field values never appear in the provider payload (adapter spy).
- CLOUD: re-identify restores tokens, including a token split across two stream chunks.
- LOCAL: payload is unmodified, detection is audited with counts and no values.
- CLOUD `pii_leak`: a real name in the output before re-identification blocks the response.
- Opt-out field in the request is rejected / ignored, and both gates always run.
- The medical judge and the detect pass run concurrently (timing test with stubs).
- `/translate` is gated.
- Streaming: a blocked window is never emitted.

**L3**
- Joint detect returns spans and safety labels in one call.
- New labels (MRN, encounter id, staff id) are detected on fixtures.
- Chunked inputs are processed in parallel and spans are offset-correct.

**L4**
- Gateway stamps `locality` from `deploymentKind` / `ENGINE_SERVED_PROVIDERS`.
- Lane E: conditional fragments apply, the body is in the system message, and a missing variable is a 400.
- Lane F route removed (404) / redirected.
- Seed: outbound checks enabled.
- `require_medical` forced on for the business plane.

**L5**
- `core.agent` / `generate` / `text_generate` no longer import Presidio, and cloud redaction happens via text.
- Lane G uses the assembled `systemPrompt`.
- Fallback candidates use their own output schema.
- Replay-compat suite green (workflow code changes).

**L6**
- `TemplateEditor` opens completions on `{{`, shows the PHI badge, and squiggles an undeclared path.
- Agent wizard: renamed step; schema chosen once.
- Workflow-inherited schema shown read-only on the agent.
- axe 0 violations, both themes.

### 5.2 Order

1. **P0 safety:** L3 → L2 → L4 (locality, seeds, opt-outs) → L5. This closes R4–R7.
2. **P1 composition:** L1 → L4 (lane E/F) → L5 (lane G, fallback) → Prompt Inspector.
3. **P2 studio:** L6.

### 5.3 Migrations

- Only if OD-9 = yes: a `ComposedPromptRecord` table (tenant-scoped, Transit ciphertext, retention), plus a `ResourceType` addition.
- The opt-out fields live in JSONB (`parameters` / node config), so a data migration strips them; no column drop.

### 5.4 Verification criteria

- Live proof on the dev stack. The same consultation is finalized once on an LM Studio agent and once on a cloud BYOK agent.
  - Provider-payload capture shows the raw values on local and only tokens on cloud.
  - The persisted note contains real values in both cases.
  - The audit rows show the detected label counts.
- A seeded unsafe prompt is refused on the inbound check. A seeded unsafe response is refused on the outbound check, with no streamed bytes delivered.
- Latency is measured before and after for a live flush and a finalize; the §3.2 budget holds.
- Console: author an agent prompt entirely from completions with no typing of paths; an undeclared path blocks publish at the field.

## 6. Implementation Summary

### 6.1 P0 — egress safety (merged on dev-2.2 2026-10-02, `72026cbc3` + `c193c60ef` + `31307efa8`)

| Lane | Merge | What landed |
|---|---|---|
| GATEWAY | `1e618b6b5` | <ul><li>One helper (`text-request/provider-locality.ts`) stamps `provider_locality` from `deploymentKind` on every gateway → text call, via `applyTenantProviderOverrides` → `applyEgressSafety`.</li><li>`known_phi` from the effective context schema's PHI fields plus identity (`known-phi.service.ts`, 60 s per-tenant cache).</li><li>Opt-outs, the kill switch and `requireMedical` descriptors removed. Stored rows are stripped on read and write for one release.</li><li>Back-fill `packages/database/scripts/strip-retired-guardrail-optout.ts` (not run).</li><li>`deploymentKind` + per-candidate `outputSchema` on the resolve wire.</li><li>Seeds: §5.0 guardrail defaults; six clinical PII labels (48 total; snake_case: `medical_record_number`, `patient_id`, `encounter_id`, `staff_id`, `healthcare_facility`, `date_of_service`).</li><li>Console opt-out controls removed.</li></ul> |
| TEXT | `411ca8a9d` | <ul><li>`core/locality.py` (§5.0 rules).</li><li>`services/pseudonymizer.py`, `services/egress.py` (inbound screen ∥ medical judge, pseudonymize, re-identify, `egress` summary).</li><li>`services/egress_stream.py` (sentence windows, 2000-char forced cut, split-token hold-back).</li><li>`pii_leak` judged per locality (`PII_LEAK_BLOCKED` 422 / terminal frame); judge lane `JUDGE_PROVIDER_NOT_LOCAL` 503.</li><li>Medical-verdict cache `text:medjudge:<sha256>` 300 s; idempotency keys now tenant-scoped.</li><li>`/translate` gated.</li><li>Guardrail `/screen/inbound` `include_pii_spans` + parallel chunked PII extraction.</li><li>nlp sends `medical_exempt: "internal"`.</li></ul> |
| HARNESS | `72026cbc3` | <ul><li>`core/llm_egress.py` stamps locality / `known_phi` on every TextClient call.</li><li>Presidio LLM-egress path retired (`ensure_egress_safe` deleted). Presidio remains only for the inferential judge's direct hop and MCP tool args.</li><li>`HARNESS_PHI_*` env removed.</li><li>Opt-out removed.</li><li>Fallback candidates use their own output schema.</li><li>Palette `generate.text` binds the assembled `systemPrompt`.</li><li>Replay-compat 23 passed (workflow code unchanged).</li></ul> |

Post-merge integration (orchestrator):
- Regenerated `openapi.json` + portal docs, the Python env surface and `env-surface.generated.md`.
- Removed a seed test asserting the retired `guards` field.
- Stamped the mock provider local in the resume-stream tests (an unstamped unknown provider is cloud by design).
- Inverted the inspector "Guardrail" field assertion.
- `vox-node gen:admin` and `regen:registry-snapshot` produced no diff.

**Gate pass on dev-2.2 (one pass, after all merges):**

| Gate | Result |
|---|---|
| test / typecheck: types, workflow-contract, database, applications, admin-console | green (admin-console 3868/3868 after fix) |
| lint: workflow-contract, applications, admin-console, api | green (types/database have no lint script) |
| api unit, `tests/contracts`, `api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check`, `env:sync --check` | green |
| pytest guardrail, harness | green |
| pytest text (excl. live e2e) | 2043 passed, 4 skipped → the 4 resume-stream failures fixed (22/22) |
| pytest nlp | 766 passed, 2 failed — `test_metrics_endpoint_task636.py` **pre-existing**, file and nlp app untouched by this ticket |
| ruff | 1 finding, F841 in `apps/harness/scripts/task_330_phase3_retrieval_check.py` — **pre-existing**, untouched |

**Not done yet / follow-ups:**
- **Already-seeded databases keep the old guardrail availability row.** The seed creates it only if missing. Dev DB and cluster need the SYSTEM row updated to §5.0 defaults, plus deletion of the orphaned `text.externalGuardrail.{enabled,requireMedical}` / `text.guardrailPolicy.requireMedical` `GlobalSetting` rows.
- **Back-fill** `strip-retired-guardrail-optout.ts` is not run. PUBLISHED agent/workflow rows keep the field until republished, which is why strip-on-read must stay a release.
- **Deployment repo:** `scripts/env-consumer-inventory.generated.json` still lists `HARNESS_PHI_*`. No manifest sets them.
- **Live proof (§5.4)** pending a stack restart on the merged code.
- **Open question for the owner:** tenants can still DISABLE a mandatory workflow node (e.g. `consentGate`, publish warning `GUARDRAIL_OPTED_OUT`) and per-check rows in `TenantGuardrailPolicy`. The lanes read OD-1 as the LLM screening opt-out only.
- Naming leftover: `settings-registry-screen.tsx:144` uses `requireMedical` as an example pair (data-driven, no broken control).

### 6.2 P1 + P2 — one composer, inspector, schema-aware studio (merged on dev-2.2 2026-10-02)

| Wave / lane | Merge | What landed |
|---|---|---|
| A CONTRACT | `6e83492f9` | <ul><li>`composeMessages` (system = platform rules → instruction → language step → output contract; user = `<<<EXTERNAL_DATA section="…">>>` blocks with marker/key escaping and newline-aware truncation; every missing variable named).</li><li>`platformRules()` v1, `buildPromptScope` (OD-6 `trigger`↔`context` alias), `schemaVariablePaths`.</li><li>`PROMPT_VARIABLE_UNDECLARED` = ERROR.</li><li>Python mirror with byte-identical golden fixtures (21 compose + 7 scope + 10 path cases).</li></ul> |
| B GATEWAY | `d63e6213a` | <ul><li>Agent invoke/bench, live (C), `PromptAssemblyService` (E: body → system, conditional fragments honoured, missing variable = 400) and text-proxy (F: rendered, never raw `{{…}}`) all compose through `composeMessages`.</li><li>Schema inheritance from the governing workflow; `effectiveContextSchema` on agent detail.</li><li>Prompt Inspector `POST admin/consultations/:id/prompt-preview`.</li><li>`ComposedPromptRecord` (Transit-encrypted, migration `20261002090000_task_1035_composed_prompt_record`, `composedPrompts.retentionDays` = 30 + daily purge); admin reads + `POST internal/composed-prompts`.</li><li>Inspector and records are SUPER_ADMIN / TENANT_ADMIN only (`assertPromptInspectorAccess`, rule 05 row added); service accounts are admitted as the admin-plane machine identity.</li></ul> |
| B HARNESS | `82f6186cf` | `core.agent` and the palette lane compose through `compose_messages`; composed prompts recorded fire-and-forget (2 s cap, 32 in flight) at six call sites; replay-compat 23 passed. |
| B CONSOLE | `9ec191e51` | <ul><li>CodeMirror 6 `TemplateEditor` (`@arcaai/ui`) with `{{` completion (type / required / PHI badges) and inline lint, on 9 fields (agent inline prompt, fragments, `when`, bindings, template content, workflow CEL, node prompt variables, node prompt editor, quick start).</li><li>Findings shown at the field.</li><li>Wizard: context schema in step 1; "Input / Output contract" rename; inherited schema badge.</li><li>Quick-start page (`/quick-start`).</li><li>Prompt Inspector tab on the consultation drawer.</li></ul> |
| Follow-up | `d9347505e` | `PLATFORM_CONTEXT_VARIABLES` (11 gateway-derived `context.*` names with PHI class and file:line provenance) admitted at TEXT_GENERATION publish and offered as `platform` completions; the 3 `case-notes-pre-summary` agents publish clean again. No seeded variable is unsupplied. |

Orchestrator integration:
- Migration verified on a throwaway shadow DB (replay + `migrate diff` = empty) and the dev DB synced.
- `ComposedPromptRecord` is EXCLUDED from tenant checkpoints, so restoring an expired PHI audit copy is impossible (`b3457b71a`).
- Prettier fixed on the new controllers.
- The agent completion now offers only the canonical `context` root (85 → 48 suggestions; the `trigger` alias still lints valid) (`f61e2ad0d`).

**Gate pass (one, after all merges):**
- Green: test + typecheck for types, workflow-contract, database, domains, applications (16 538 tests after the checkpoint fix), admin-console; lint for workflow-contract, applications, admin-console, domains, api (0 errors); api unit and `tsc`; the ui template-editor file; `tests/contracts`; openapi / portal / vox-node `gen:admin` / env-sync checks; `gen:model`/`entity`/`factory` drift checks; pytest text, guardrail, harness.
- Still failing, and pre-existing: nlp `test_metrics_endpoint_task636.py` ×2 and ruff F841 in `apps/harness/scripts/task_330_phase3_retrieval_check.py`. Both are untouched by this ticket.

**Live verification on the dev stack (2026-10-02):** api + guardrail + nlp + admin-console.
- `prompt-preview` on Global consultation `…0001`, finalize: user = transcript / NER / clinician-notes `EXTERNAL_DATA` blocks; GLiNER2 detected `person` + `first_name` ("Alice"); locality `local` ⇒ `redacted: 0`, no provider view (OD-2).
- Console:
  - The wizard shows the schema in step 1.
  - `{{` opens schema + platform completions with PHI badges.
  - The Prompt Inspector tab (Live) shows the Local provider badge, `first_name 1` "detected and audited only", the selected fragments `clinical_note` + `output_language_policy`, and block budgets.
  - No console errors.
- NOT proven live: a CLOUD call. The dev DB holds no cloud provider key and LM Studio was down, so pseudonymize → provider → restore is proven by unit tests only (text adapter spy + split-token stream tests). Do this live once a BYOK key is configured.

**Open follow-ups:**
- **Cluster rollout:** push; the cluster needs the guardrail-availability SYSTEM row update and the two retired `GlobalSetting` rows soft-deleted (as on dev); the deployment repo `env-consumer-inventory.generated.json` still lists `HARNESS_PHI_*`.
- **Live CLOUD proof** with a BYOK key.
- **PHI class is per KIND**, so every field of the multi-kind `context` kind shows PHI. Finer field-level PHI would need a schema change.
- **Prompt shape changed for every `core.agent`, palette and assembler call:** platform rules first, data in blocks. Watch note quality on the first live consultations.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-02 | Ticket raised; current-state evaluation (§2) and plan (§3–5) written; OD-1..3 taken by owner. |
| 2026-10-02 | OD-4..9 accepted; P0 wire contract frozen (§5.0). P0 runs as three lanes: TEXT (`apps/text` + `apps/guardrail` + the nlp text client), GATEWAY (`packages/{applications,database,workflow-contract,types}` + `apps/api` + the console opt-out toggle), HARNESS (`apps/harness`). The NLP joint-detect endpoint is deferred: guardrail runs the existing `/guard/pii` and `/guard/classify` concurrently. |
| 2026-10-02 | Owner: images may go to cloud providers unredacted (text still pseudonymized, `egress.images_unredacted`). |
| 2026-10-02 | OD-1 clarified by owner: it removes the per-call LLM screening opt-out ONLY. Tenants KEEP (a) switching off a mandatory workflow node such as `consentGate` (publish warning `GUARDRAIL_OPTED_OUT`) and (b) turning individual checks off in their own `TenantGuardrailPolicy`. Dev DB: SYSTEM `TenantGuardrailPolicy` updated to §5.0 defaults (v1 → v2), retired `text.externalGuardrail.{enabled,requireMedical}` rows soft-deleted; back-fill dry-run found 0 writable rows (31 agents + 17 workflows PUBLISHED, kept). CodeMirror 6 (`@codemirror/{state,view,autocomplete,lint,commands,language}`) added to `@arcaai/ui` for OD-8. |
| 2026-10-02 | P0 merged on dev-2.2 (three lanes rebased onto the owner's filter-branch rewrite first), integration fixes, one gate pass — §6.1. |
| 2026-10-02 | P1 + P2 merged (wave A contract, wave B gateway / harness / console, platform-variables follow-up); migration applied to dev; gate pass + live verification — §6.2. Status → Review. |
