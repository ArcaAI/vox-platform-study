# Lane I — Safety & Compliance Posture (Wave 2)

Repo: `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2` · branch `feat/loop` · HEAD `56137b9a6`
Excluded from all searches: `.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`, `packages/database/src/generated/core-prisma-client/**`.

---

## Scope & limits

This is an **engineering** assessment: I read code and configuration and report whether a control exists, where it is enforced, and whether it can be bypassed. Every claim below is tied to a `file:line` I opened myself.

This is **not** legal, regulatory, or clinical advice, and it is **not** a compliance certification. Where a gap plausibly carries regulatory weight I state the engineering fact and stop there. A qualified assessor — not this document, and not the reader's reading of this document — must judge what any given law or accreditation standard requires of this deployment. I do not tell you what you are obligated to do.

Two further limits worth naming up front:

- **Static analysis only.** Nothing was executed. Claims about "default configuration" are read from code defaults, seed files, and `.env.sample`; the actual defaults of any live deployment may differ and were not observed.
- **"Bypassable?" means reachable in code**, not that anyone has done it. A control marked bypassable is an engineering weakness, not an allegation.

Where wave-1 reports and my own reading disagree, I say so in *Corrections* and my reading governs.

---

## The three non-negotiables

### 1. "Timeout is never clinical approval" — **UPHELD.** No counterexample found.

I traced every terminal path of the durable workflow and every status writer.

- The gate-wait loop exits without approval **only** through the terminal-abandon `break` (`apps/harness/src/harness/temporal/workflows.py:1554-1555`). That path returns `approved=False, clinician_id=None` (`workflows.py:1564-1574`) and **deliberately skips** `record_gate_decision` — the comment at `:1561-1563` states the draft stays `PENDING_REVIEW` for manual handling.
- `decision=approval.decision or "SIGNED"` (`workflows.py:1584`) looks alarming and is not. It is unreachable unless `approval is not None` (guarded at `:1564`), i.e. a real `ApprovalSignal` arrived. It defaults the *label on an audit row*, not a state transition.
- The retraction path returns `approved=False` (`workflows.py:1431`).
- The loop-idle timeout sets `_phase = "TIMED_OUT"` and breaks (`workflows.py:2089-2092`); it writes no status.
- SLA breach produces `GATE_ESCALATED` / `GATE_ABANDONED` audit rows only (`packages/applications/src/services/consultation/harness/harness-internal.service.ts:1281-1294`).

No cron, scheduler, or timer anywhere writes `ConsultationStatus.SIGNED`. Searched `Cron`, `@Interval`, `autoApprove`, `autoSign`, `skipReview`, `force.*[Ss]ign` across `packages/applications/src`, `apps/api/src`, `apps/harness/src` — the only cron services are agent-template resync and DNA regeneration.

### 2. "The system never signs on behalf of the clinician" — **UPHELD at the record-of-truth. One caveat.**

`SummaryService.approveSummary` is the **sole** production writer of `ConsultationStatus.SIGNED` (`packages/applications/src/services/consultation/summary/summary.service.ts:978`). I enumerated every `.status = ConsultationStatus.*` assignment in TS: the only other writers set `RECORDING`/`OPEN` (`consultation.service.ts:825`, private, called only with those two values from `startRecording`/`stopRecording` at `:795,:803`) and `DRAFT_PENDING_SENSORS`/`PENDING_REVIEW` (`harness-internal.service.ts:893,1035`).

`approveSummary` is hard-gated on an authenticated human: `const approvedBy = this.requestUserId; if (!approvedBy) throw new BadRequestException('User ID is required')` (`summary.service.ts:875-878`). There is no `force`, `auto`, or `skipReview` option — the only option is `overrideSafetyFlag`, which *tightens* the path (a safety FLAG hard-blocks without it, `:869-873`).

**Attempts to break it, and what I found:**

| Attack | Result |
|---|---|
| Internal harness service-token route signs | **No.** `recordGateDecision` appends a WORM row and returns; it never touches `Consultation.status` (`harness-internal.service.ts:1211-1247`). |
| Admin workflow-signal endpoint forges an approval | **Cannot sign, but see F-09.** `POST /admin/.../workflows/:id/signal` (`apps/api/src/modules/harness-admin/harness-admin.controller.ts:485-493`) forwards an arbitrary `signalName`+`payload` to Temporal (`apps/harness/src/harness/api/endpoints/admin.py:367`). Sending `approve` resolves the workflow's wait-condition and drives `record_gate_decision` — which writes a `GATE_DECISION` WORM row carrying caller-supplied `clinicianId` and `attestationHash`. It does **not** create a `SIGNED_NOTE` version, does **not** write `ATTEST`, and does **not** flip status. |
| Seed / migration writes SIGNED | **No.** Only enum DDL and a value-preserving `CASE` remap (`migrations/20260606154250_.../migration.sql:33`). No seed sets it. |
| Raw SQL / unscoped platform-admin client | **Yes — nothing at the DB layer stops it.** See F-06 caveat below. |

**Caveat (not a break, but load-bearing): the gate is application-layer only.** There is no DB trigger, constraint, or privilege revocation binding `Consultation.status = 'SIGNED'` to the existence of a `SIGNED_NOTE` version or an `ATTEST` row. The repo's own test proves it: `packages/database/src/__tests__/attestation-gate-persistence.postgres.test.ts:153-156` issues a bare `UPDATE core."Consultation" SET "status" = 'SIGNED'` and asserts `rowCount === 1`. Anyone with SQL access, the lint-restricted `getPlatformAdminPrismaClient_Unscoped`, or a future service that forgets the gate can reach `SIGNED` directly. Contrast `HarnessAuditEvent`, which *is* protected at the privilege layer (`REVOKE UPDATE, DELETE`, migration `20260606143138_...:209,212`). The asymmetry is the finding.

### 3. "The drafted note is not the final record until a clinician explicitly approves it" — **BREACHED in presentation. Intact in the stored record.**

This is the one I could break, and it is my own finding (F-06 below, not carried from wave 1).

`ConsultationDtoMapper.toResponse` resolves the status a client sees as:

```ts
// packages/applications/src/services/consultation/consultation/consultation.dto.mapper.ts:23-26
const columnStatus = entity.status as string | undefined;
const metaStatus = metadata?.status as string | undefined;
const status =
  columnStatus && columnStatus !== CONSULTATION_STATUS.OPEN ? columnStatus : (metaStatus ?? columnStatus ?? CONSULTATION_STATUS.OPEN);
```

The typed column defaults to `OPEN` (`packages/database/src/prisma/db_main/consultation.prisma:36`), so for any consultation that has not yet transitioned, **`metadata.status` is what the API returns**.

`metadata` is caller-writable and unvalidated. `UpdateConsultationRequest` constrains the *typed* `status` field to `['OPEN','CLOSED']` via `@IsIn` (`dto/update-consultation.request.ts:11-18,46`) — but declares `metadata` as a bare `@IsObject() Record<string, unknown>` (`:49-52`). The global `forbidNonWhitelisted` pipe validates declared DTO properties, not nested keys. `updateConsultation` then shallow-merges it: `nextMeta = { ...nextMeta, ...request.metadata }` (`consultation.service.ts:757-758`).

So `PATCH /api/v1/consultations/:id` with body `{"metadata":{"status":"SIGNED"}}` makes every read path return `status: "SIGNED"` — `getById`, both list endpoints, the paginated grids, and the chain all route through this mapper (17 call sites, `consultation.service.ts:124…837`). The admin console renders that value directly (`apps/admin-console/src/features/consultations/api/types.ts:7` includes `'SIGNED'`).

**What is *not* forged:** no `SIGNED_NOTE` `ContextItemVersion`, no `ATTEST` WORM event, no `attestationHash`, no `attestedBy`, and the typed column stays `OPEN`. The legal record-of-truth is untouched and the forgery is detectable by auditing `HarnessAuditEvent`. But a clinician or auditor reading the UI or the API cannot distinguish it, and invariants INV-148 / INV-182 ("an unsigned draft must stay *visibly* unsigned") are not met.

**Who can do it:** `verifyConsultationOwnership` (`apps/api/src/modules/consultation/consultation.controller.ts:296-317`) admits the assigned doctor **or** any caller holding `manage:Consultation` — i.e. a tenant administrator, who need not be a clinician, can do this to any consultation in the tenant.

---

## Control inventory

| Control | Expected by reference | Exists? | Enforced where | Bypassable? | Evidence |
|---|---|---|---|---|---|
| Explicit clinician attestation before SIGNED | Yes (T21) | **Yes** | Application service | Not via API; yes via raw SQL / unscoped client | `summary.service.ts:875-978`; `attestation-gate-persistence.postgres.test.ts:153` |
| Timeout never approves | Yes (INV-001/113/130/147/161/181) | **Yes** | Temporal workflow | No path found | `workflows.py:1554-1574,1431,2089` |
| Unsigned draft stays *visibly* unsigned | Yes (INV-148/182) | **No** | — | Trivially — `metadata.status` | `consultation.dto.mapper.ts:23-26`; `update-consultation.request.ts:49-52` |
| Patient consent gate before capture/retrieval | Yes (INV-003/004/010/201) | **No** | Nowhere | n/a — absent | No `Consent` model in any of the 39 `.prisma` files; `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` declared at `harness.prisma:24-25`, never written |
| ABAC / purpose-of-use / minimum-necessary | Yes (INV-006/015/016/067) | **No** | — | n/a — absent | `unified-auth.guard.ts:287` checks `ability.can(action, 'SubjectString')` — type-level; conditions unevaluated |
| Per-patient access check | Yes (INV-191/199) | **Partial** | One controller, hand-rolled | Yes — `manage` ability covers all patients; API-key path skips it | `consultation.controller.ts:245-286,324-331` |
| Tool-call gate on consent/scope | Yes (INV-007/058/067/232) | **Partial** (flags + static allowlist only) | Temporal activity | No consent/user/patient input exists | `apps/harness/src/harness/temporal/activities.py:828-885` |
| PHI sanitizer before NLP/Reasoning consumption | Yes (INV-026/136) | **No** | — | n/a — absent on this hop | `summary.service.ts:1571`, `ner.processor.ts:219` post raw text |
| PHI redaction before cloud-LLM egress | Yes | **Partial — fails open for 3 providers** | Harness activity only | Yes (F-01, F-02) | `apps/harness/src/harness/guards/phi/redactor.py:185`; `apps/harness/src/harness/core/config.py:129` |
| Durable audit of PHI reads | Yes (INV-015 "audited") | **No** | — | n/a — dropped by default | `sysEvent.service.ts:246` |
| Append-only clinical audit ledger | Yes | **Split** | `HarnessAuditEvent` yes; `AuditLog` no | `AuditLog` yes | REVOKE at `migration.sql:209,212` (harness only); `audit-retention.service.ts:192` hard-deletes `AuditLog` |
| Tool calls + HITL decisions in the ledger | Yes | **HITL yes, tool calls no** | `HarnessAuditEvent` | Tool calls live in prunable telemetry | `harness-internal.service.ts:1231`; no `TOOL_CALL` action in `harness.prisma:20-36` |
| Per-artifact retention TTL | Yes (INV-171/177) | **No** on clinical tables | — | n/a — absent | No TTL/expiry column on `Consultation`, `ContextItem`, `AudioRecording`, `SummaryMeta`, `TranscriptSegment` |
| Consent-revocation cascade across tiers | Yes (INV-170) | **No** | — | n/a — absent | No patient-scoped delete anywhere; no `Patient` model (`patientId` is a bare String, `consultation.prisma:14`) |
| Patient facts excluded from style DNA | Yes (INV-017/080/096/165) | **No** | — | n/a — corpus is raw notes | `dna-writing-style.processor.ts:161-174` |
| Style learning opt-in + approved-only | Yes (INV-164/167/168) | **Yes on the automatic path**; bypassed on the admin path | Processor | Yes — `textSamples` argument | `dna-writing-style.processor.ts:105-124` |
| Exemplar bank PHI-redacted, fail-closed | Yes (INV-169) | **Yes by design, inert in practice** | Mining service | No — fails closed to *nothing mined* | `gate-edit-mining.service.ts:174-182,408-418`; `IPhiRedactor` has **no provider anywhere in the repo** |
| PHI encrypted at rest (DB) | Yes | **Yes** | Vault Transit `hope-phi` | Only when `SECRETS_PROVIDER=vault` | `packages/applications/src/common/phi-field-encryption.ts:32-33` |
| AI-vs-human attribution | Yes (INV-051/087/218) | **Version-level yes; per-clause no** | `ContextItemVersion` | — | `ContextItemSource` enum (`enums.prisma:290-297`); `ai_draft_v1` snapshot + `encryptedContentDiff` |
| Cross-doctor / cross-tenant style isolation | Yes | **Yes** | TEXT proxy | No | `apps/api/src/modules/streaming/text-proxy.controller.ts:969-984` |

---

## PHI flow map

Legend: **RAW** = plaintext, no redaction · **ENC** = encrypted at rest · **RED** = redacted · **†** = leaves the trust boundary.

| # | Hop | Data | State | Evidence |
|---|---|---|---|---|
| 1 | Mic → browser SDK → STT WebSocket | audio | RAW (TLS in transit) | `apps/api/src/modules/streaming/stt-ws.gateway.ts:425+` — ticket + origin + tenant-binding checks; no consent, no user-permission check |
| 2 | STT → Redis Streams → gateway | partial + final transcript | RAW | Redis persistence **off** by default (`infrastructure/docker/docker-compose.yml:185-186`: `--appendonly no`, `--save ""`) |
| 3 | Transcript → `ContextItem` | full transcript | **ENC** (`encryptedContent`, plaintext column dropped) | `consultation.prisma:97-98`; `phi-field-encryption.ts:32-33` |
| 4 | Audio → MinIO/S3 `recordings` bucket | raw audio | **RAW at rest** — MinIO SSE is commented out in the shipped compose | `docker-compose.yml:103-108` |
| 5 | `ContextItem` → **NLP** `/classify/tokens` | decrypted transcript | **RAW** — no sanitizer on this hop | `summary.service.ts:1571`; `ner.processor.ts:219`; `live-tool-registry.ts:190` |
| 6a | **Default path** `ContextItem` → TEXT `/api/v1/generate` | full transcript + assembled prompt | **RAW** — no redaction exists on this path | `summary.service.ts:1358`; `harnessEnabled` codeDefault **false** at `config-resolver.service.ts:80` |
| 6b | **Harness path** → `ensure_egress_safe` → TEXT | prompt | **RED for `azure`/`bedrock` only**; RAW for every other provider | `redactor.py:185` — `if provider not in phi.cloud_egress_providers: return text` |
| 7 | TEXT → provider adapter → model | prompt | RAW inside TEXT (zero redaction code in `apps/text/src/text/providers/*`) | `providers/azure_openai.py:167`; `providers/bedrock.py:185` |
| 7a | → **local** LM Studio / Ollama / vLLM | prompt | RAW, stays on-host | default provider `lm-studio` (`seed/13-harness-policy.ts:31-34`; `requests.py:114`) |
| 7b | → **cloud** azure / bedrock **†** | prompt | RED *only if* harness path enabled; otherwise RAW | F-02 |
| 7c | → **cloud** openai / anthropic / vertex **†** | prompt | **RAW always** — not in `cloud_egress_providers` | F-01: `config.py:129` vs `apps/text/src/text/main.py:83-93` (registered unconditionally) |
| 8 | TEXT → guardrail `/api/medical/validate` | prompt + system prompt | RAW; **off by default** (`TEXT_EXTERNAL_GUARDRAIL_ENABLED=False`, `text/core/config.py:329`) | `generate.py:281-287` |
| 9 | TEXT idempotency cache → Redis | **full generated summary** | RAW, in-memory, TTL 3600 s | `generate.py:255-267` |
| 10 | Draft → `ContextItemVersion` (`ai_draft_v1`) | AI draft | **ENC** | `harness-internal.service.ts:1507` |
| 11 | Signed note → `ContextItemVersion` (`SIGNED_NOTE`) | attested note | **ENC** + `attestationHash` | `summary.service.ts:891-918` |
| 12 | **Style-DNA corpus** → TEXT **†** | **verbatim approved clinical notes** | **RAW — no redaction** | `dna-writing-style.processor.ts:174` → `:189` → `:332-340`. See F-07 |
| 13 | DNA `styleText` → stored profile | model-derived text + `sourceContextItemIds` back-pointers | ENC at rest, content unverified | `dna-writing-style.prisma:22-31`; `processor.ts:205-210` |
| 14 | DNA `styleText` → **every later generation for that doctor** | appended to system prompt | RAW into the prompt | `text-proxy.controller.ts:985-986` |
| 15 | Exemplar bank `GateEditExemplar` | redacted snippets + `consultationId` | RED, fail-closed — **but inert**: `IPhiRedactor` is never provided | `gate-edit-mining.service.ts:409` |
| 16 | Qdrant vector store | institutional knowledge chunks | tenant-filtered; **no delete API implemented** | `apps/harness/src/harness/guides/retrieval/qdrant_store.py` — only `upsert_chunks`, `hybrid_query` |
| 17 | Logs (`@arcaai/applications` logger) | structured fields | RED by key-name allowlist | `baseServices/logging/redactor.ts:52-87`, applied at `logging.service.ts:303` |
| 18 | Logs (`@arcaai/logger`) | structured fields | **RAW — no redaction in this logger** | `packages/logger/src/index.ts` |
| 19 | OTel spans | GenAI message content | pinned off, boot-enforced in production | `text/core/config.py:346-395`; `apps/api/src/bootstrap/genai-content-capture-audit.ts:33-45` |

**Third-party LLM egress verdict.** In the strict shipped default, **no** — every seeded provider is local (`lm-studio`), so nothing leaves the host. But the protection is **destination-based, not redaction-based**. The moment a tenant configures a cloud provider through the supported BYOK path (no code change, no redeploy): `openai`/`anthropic`/`vertex` receive PHI **unredacted unconditionally** (F-01), and `azure`/`bedrock` receive it unredacted whenever `harnessEnabled` is false — which is the code default (F-02).

---

## Findings — ranked by severity

### F-01 — CRITICAL · PHI egresses unredacted to `openai` / `anthropic` / `vertex` even with the PHI guard fully enabled

**Mechanism.** The cloud guard is an allowlist of provider names, and it **returns the text untouched** when the provider is not on it:

```python
# apps/harness/src/harness/guards/phi/redactor.py:185-186
if provider not in phi.cloud_egress_providers:
    return text
```

`cloud_egress_providers` defaults to `["azure", "bedrock"]` (`apps/harness/src/harness/core/config.py:129`). TEXT registers `openai`, `anthropic`, `vertex`, and `azure` **unconditionally** as BYO cloud providers (`apps/text/src/text/main.py:83-93`, with an explicit comment that they must be available without platform credentials).

The failure is **silent and fail-open**: `phi_enabled=True` and `fail_closed=True` are both honored and both irrelevant, because the guard returns before the try/except that would raise `PhiEgressBlocked`.

**Exposure scenario.** A tenant configures an `AiProviderConnection` for Anthropic or OpenAI — a first-class supported flow. Every consultation prompt (full transcript + prior context) is POSTed to that provider verbatim. Operators inspecting config see PHI redaction "enabled" and fail-closed "on".

**Default configuration?** The guard gap is present by default; it is only *reachable* once a tenant BYOKs one of those three providers. No code change is needed to reach it.

**Minimal fix.** Invert the allowlist to a deny-by-default classification: treat any provider not positively known to be local (`lm-studio`, `ollama`, `vllm`, `llama_cpp`) as cloud. Derive the local set from one shared constant consumed by both `text/main.py` and `harness/core/config.py` so registering a new provider cannot silently widen egress.

---

### F-02 — CRITICAL · The default consultation pipeline has no PHI redaction on any hop

**Mechanism.** All five redaction call sites live inside harness Temporal activities (`activities.py:864,1090,1099,1628,1829`). The harness is opt-in: `harnessEnabled: { codeDefault: false, maxScope: DEPARTMENT }` (`packages/applications/src/services/config-resolver/config-resolver.service.ts:80`). With it off, generation runs `summary.service.ts:1341-1365` → TEXT directly, and there is no redaction anywhere on that path — nor on the sibling processors (`summary.processor.ts:316`, `pre-summary.processor.ts:277`, `comprehensive-summary.processor.ts:390`, `chain-summary.service.ts:621`, `live-documentation.service.ts:2067`).

**Exposure scenario.** A tenant enables an Azure OpenAI connection but never enables the harness — the redaction control that exists is simply not on the code path.

**Default configuration?** Yes, the pipeline is the default. PHI does not leave the host only because the seeded provider is local.

**Minimal fix.** Move the egress guard from the harness activity to the TEXT client boundary in `apps/api` (or into TEXT itself, before `registry.get(...)`), so every generation path inherits it regardless of `harnessEnabled`.

---

### F-03 — HIGH · Consent and ABAC do not exist; everything the reference gates on them is ungated

**Mechanism.** No `Consent` model exists in any of the 39 schema files; there is no `Patient` model at all (`Consultation.patientId` is a bare `String` with no FK, `consultation.prisma:14`). The only consent artifacts are two enum members, `CONSENT_GIVEN` / `CONSENT_WITHDRAWN` (`harness.prisma:24-25`), which I confirmed are never written by any code — the sole non-declaration references are the generated TS enum and an admin-console **filter dropdown** (`apps/admin-console/src/features/harness-ops/api/types.ts:16-17`) offering a filter for rows that cannot exist.

ABAC is likewise absent. The authorization layer is CASL RBAC, and the guard evaluates a **type name**, not an instance:

```ts
// packages/applications/src/authorization/unified-auth.guard.ts:287
allowed: ability.can(permission.action, permission.subject),
```

`permission.subject` is a string from the decorator, so CASL conditions on seeded rules never evaluate. `getAccessibleBy` — the mechanism that would filter queries by those conditions — is defined at `policy.engine.ts:203-205` and has **zero call sites** outside its own file. Row scoping is `tenantId` injection alone.

**Blast radius — what is consequently ungated:** session open, ambient capture start, prior-history retrieval, every context read, every SSE stream, and every downstream tool call. Concretely, `POST /consultations/open` carries only `@Authorize(['create','Consultation'])` (`consultation.controller.ts:340`) and performs **no** patient-relationship check, so any holder of that ability can open a session against an arbitrary `patientId` string.

**What exists that could carry a consent check.** Three seams, in order of leverage: (1) the global `UnifiedAuthGuard` pipeline, which already resolves tenant and user; (2) `ConsultationController`'s hand-rolled `verifyPatientAccess` / `doctorHasPatientRelationship` (`consultation.controller.ts:324-331`, impl `consultation.service.ts:631`) — the only treating-relationship logic in the repo, currently applied to 2 of ~20 routes; (3) `call_mcp_tool` (`activities.py:828-885`), which already has a deny-path and audit hook and takes `tenant_id`.

**Minimal fix.** Not minimal — this is a design gap, not a bug. The smallest *honest* step is to stop advertising the capability: remove the dead `CONSENT_*` enum members and the admin filter that implies a consent trail exists.

---

### F-04 — HIGH · Clinical PHI reads leave no durable audit trail

**Mechanism.** `ResourceViewed` is dropped from the ledger unless explicitly forced:

```ts
// packages/applications/src/services/sysEvent/sysEvent.service.ts:246
if (!event.disableAuditLog && event.forceAuditLog) {
  this.queueAuditLogJob(jobs, event, AuditAction.READ, JobType.ResourceViewed);
}
```

`forceAuditLog` defaults to `false` (`packages/domains/src/common/events/arcaai.event.ts:68`). I enumerated every non-test site that sets it true — there are six, all non-clinical: `role.service.ts:491`, `globalSetting.service.ts:374,473`, `policy.service.ts:511`, `auth.controller.ts:1088`, `admin-impersonation.controller.ts:272`.

Every clinical read omits it: consultation get/list/chain (`consultation.service.ts:119,236,269,292,310,348,379,410,456,482,545`), context items and version history (`context.service.ts:1046,1076,1119,1147,1308,1343,1502`), timeline (`timeline.service.ts:138`), transcription jobs (`transcriptionJob.service.ts:134,148`). There is no HTTP-layer audit interceptor covering reads — the only global one fires solely under impersonation (`apps/api/src/interceptors/impersonation-audit.interceptor.ts`).

**Exposure scenario.** A user with `read:Consultation` enumerates every chart in the tenant. No durable record of which records were viewed is produced.

**Default configuration?** Yes.

**Minimal fix.** Set `forceAuditLog: true` on the consultation/context/summary read broadcasts, and pair it with sampling or rollup if volume is the concern — the flag exists precisely for this.

---

### F-05 — HIGH · `AuditLog` is mutable and hard-deletable through a live, DB-backed switch

**Mechanism.** Three properties compound:

1. **No privilege enforcement.** The `REVOKE UPDATE, DELETE` migrations cover `HarnessAuditEvent`, `HarnessPolicyChange`, and `PipelinePolicyChange` — **not** `AuditLog` (`migrations/20260606143138_...:209,212`; `20260607120000_...:78,81`; `20260615120000_...:76,79`).
2. **No tamper-evidence.** `audit.prisma` has no `hash`/`prevHash`/signature column. It has envelope encryption (confidentiality) only. Contrast `HarnessAuditEvent`, which has a real SHA-256 chain (`packages/domains/src/utils/harnessAuditHash.ts:6-7`).
3. **A sanctioned hard-delete path.** `audit-retention.service.ts:192` calls `auditLog.deleteMany(...)` on a cron, through the unscoped base client. It is governed by the `audit-retention.*` GlobalSettings — DB-backed, refreshed roughly every 45 s. `AuditLog` is also absent from `MODELS_WITHOUT_SOFT_DELETE` (verified against `packages/database/src/client.ts`), so the generic soft-delete and hard-`delete()` repository methods remain structurally available against it.

**Exposure scenario.** A super admin sets `audit-retention.enabled=true` and `retention-days=1`; the next cron tick permanently deletes everything older than 24 h. The only guard is `retentionDays < 1` (`audit-retention.service.ts:167-173`). No redeploy, no code change, and the deletion is not itself chained or tamper-evident.

**Default configuration?** Retention is **off** by default, so no deletion occurs out of the box. The mutability and absence of tamper-evidence are default-state.

**Minimal fix.** Apply the same `REVOKE UPDATE, DELETE` treatment `HarnessAuditEvent` already has, and route retention through a partition-drop or an explicitly privileged migration role rather than the application's own client.

---

### F-06 — HIGH · Signed status is forgeable in the API and UI via unvalidated `metadata`

Full mechanism in *Non-negotiable 3* above. Summary: `PATCH /consultations/:id` with `{"metadata":{"status":"SIGNED"}}` bypasses the `@IsIn(['OPEN','CLOSED'])` guard (which protects only the typed `status` field, `update-consultation.request.ts:46`) because `metadata` is an unconstrained `@IsObject()` shallow-merged at `consultation.service.ts:757-758`, and the mapper prefers `metadata.status` whenever the typed column is `OPEN` (`consultation.dto.mapper.ts:23-26`).

**Exposure scenario.** A timed-out or abandoned draft — exactly the state INV-182 requires to stay visibly unsigned — is made to display `SIGNED` in the consultations grid and every API read. Reachable by the assigned doctor or any tenant admin holding `manage:Consultation`.

**Default configuration?** Yes.

**Minimal fix.** Two lines. Strip reserved keys from `request.metadata` before the merge in `updateConsultation`, and make the mapper's fallback accept only `OPEN`/`CLOSED` from `metadata.status`, never a lifecycle value the attestation gate owns.

---

### F-07 — HIGH · Style-DNA learns from raw clinical notes and re-injects the result into other patients' generations

**Mechanism.** Three steps, none redacted:

1. The corpus is **verbatim approved clinical notes**. `buildCorpus` emits `approved` — the full signed note text — optionally paired with the AI draft (`dna-writing-style.processor.ts:305-313`, called at `:174`).
2. That string is POSTed to TEXT as the prompt (`:189` → `callText` → `:332-340`), with the tenant's resolved provider. There is no redaction between `:174` and `:189` — only a `substring` truncation at `:177-179`. Per F-01/F-02, that provider may be cloud.
3. The resulting `styleText` is stored (`:222`) and then **appended to the system prompt of every subsequent generation for that doctor**: `systemPrompt += "\n\nApply the following writing style:\n" + dnaStyle.styleText` (`apps/api/src/modules/streaming/text-proxy.controller.ts:985-986`).

Nothing constrains the model's style report to exclude content. `sourceContextItemIds` is additionally persisted inside `reportData` (`processor.ts:205-210`), a durable pointer from the doctor's style profile back to specific patients' notes.

**Exposure scenario.** Patient A's medications or presentation are echoed into the style profile, then injected into the prompt that drafts Patient B's note. This directly contradicts INV-017 / INV-080 / INV-096 / INV-165 ("patient facts must never enter the style profile"). Note the isolation that *does* hold: cross-doctor and cross-tenant style reuse is correctly blocked (`text-proxy.controller.ts:969-984`), so the contamination is intra-doctor, cross-patient — which is precisely the axis the doctor-scoped design cannot defend.

**Secondary defect, same file.** The opt-in gate and the approved-only filter are both skipped when `textSamples` is supplied by an admin/migration caller (`processor.ts:105-111`, with the bypass stated in the comment at `:116`). That path can learn from unapproved drafts belonging to a doctor who opted out — INV-167 / INV-168.

**Default configuration?** DNA style is gated by `dnaStyleEnabled` (tenant AND doctor). When on, all of the above applies with no further opt-in.

**Minimal fix.** Run the corpus through the same fail-closed `IPhiRedactor` port that `gate-edit-mining` already uses before `callText`, and drop the `textSamples` bypass of the opt-in check.

---

### F-08 — HIGH · API-key authentication never builds a CASL ability, silently voiding `@Authorize`

**Mechanism.** `handleApiKeyAuth` validates the key, enforces scopes, sets `cls.user` and `cls.tenantId`, and `return true` — without calling `buildAbility` (`packages/applications/src/authorization/unified-auth.guard.ts:163-213`). `request.ability` and `cls.userAbility` are never populated on that path.

Consequence: for an API-key caller, `@Authorize(['read','Consultation'])` is inert, and `ConsultationController.getUserAbility()` returns `undefined`, so the CASL layer of `verifyConsultationAccess` (`consultation.controller.ts:261-265`) is skipped. Access degrades to ownership-or-shared-patient against the key's `userId`, governed only by `@RequiredScopes`.

**Default configuration?** Yes, on any API-key-authenticated route.

**Minimal fix.** Build and attach the ability on the API-key path too, so scope checks are additive to CASL rather than a replacement for it.

---

### F-09 — MEDIUM · Admin workflow-signal endpoint can write attributed audit rows for a clinician action that never happened

**Mechanism.** `POST /admin/.../workflows/:id/signal` forwards a caller-chosen `signalName` and `payload` verbatim (`harness-admin.controller.ts:485-493` → `apps/harness/src/harness/api/endpoints/admin.py:367`). Signaling `approve` with a crafted `ApprovalSignal` satisfies the workflow's wait-condition (`workflows.py:1531-1534`) and drives `record_gate_decision`, which appends a `GATE_DECISION` WORM row carrying **caller-supplied** `clinicianId` and `attestationHash` (`harness-internal.service.ts:1228-1241`).

It cannot sign (no `SIGNED_NOTE`, no `ATTEST`, no status flip — verified). But it writes an immutable, hash-chained row attributing a gate decision to a named clinician who took no action. The row is unforgeable *after* the fact and unverifiable *at* the fact.

**Default configuration?** Requires `manage:HarnessWorkflow`, tenant-scoped (`assertOwnershipForAction`).

**Minimal fix.** Reject `approve` (and any clinician-attributed signal) on the generic admin signal route; require it to arrive through `SummaryService.approveSummary`, which is already the sole attested path.

---

### F-10 — MEDIUM · No retention or erasure exists for clinical data; consent revocation has nothing to cascade through

No TTL, expiry, or purge column exists on `Consultation`, `ContextItem`, `ContextItemVersion`, `AudioRecording`, `SummaryMeta`, `NamedEntity`, `TranscriptSegment`, `DnaWritingStyleReport`, or `GateEditExemplar`. Three retention jobs exist (`AuditLog`, `AgentTrajectoryStep`, `AiUsageOutbox`) and all default **off**; none touches clinical data.

There is no patient-scoped deletion anywhere — no `Patient` model to hang it on, no cascade in the clinical graph, and the Qdrant client implements only `upsert_chunks` and `hybrid_query` with **no delete of any kind** (`apps/harness/src/harness/guides/retrieval/qdrant_store.py`). Context items are soft-deleted, so ciphertext is retained on disk after "deletion".

Specific to INV-170 (revocation must scrub the exemplar bank): `GateEditExemplar` retains `consultationId` and is in `MODELS_WITHOUT_SOFT_DELETE`, so a patient's contribution is individually identifiable and there is not even a soft-delete lever — though see *What is genuinely sound* for why the bank is empty today.

**Minimal fix.** Out of scope for a minimal patch. The prerequisite is a patient identity table so "everything belonging to patient X" is enumerable at all.

---

### F-11 — MEDIUM · Tool calls are not in the immutable ledger

`HarnessAuditAction` has no `TOOL_CALL` member (`harness.prisma:20-36`). Tool invocations and denials are recorded as `AgentTrajectoryStep` rows (`activities.py:779-956`) — explicitly operational telemetry, no hash chain, no soft delete, and a prune job that hard-deletes them (`agent-trajectory.service.ts:313-330`). INV-007 and INV-067 require denied out-of-scope tool calls to be *logged*; they are, but to a prunable store, not the WORM ledger.

---

### F-12 — MEDIUM · Redaction depends on an optional dependency, and object storage is unencrypted in the shipped compose

Two independent weaknesses in the same layer:

- **Presidio is an optional extra** (`apps/harness/pyproject.toml:137-141`), imported lazily. Absent, `ensure_safe_for_cloud` raises and fail-closed blocks egress — correct behavior, but a deployment can believe redaction is enabled while no analyzer is installed. Coverage is also thin: spaCy NER plus a **single regex MRN recognizer**, whose own docstring calls it "a deliberate stand-in" (`redactor.py:83-113`).
- **MinIO SSE is commented out** (`infrastructure/docker/docker-compose.yml:103-108`), so raw audio — the least-processed PHI in the system — has no object-store encryption in the shipped local stack, unlike the DB columns.

---

### F-13 — LOW · Two loggers, one redaction guarantee

`packages/applications/.../logging/redactor.ts` redacts via a key-name allowlist applied at a single chokepoint (`logging.service.ts:303`) — sound. But `packages/logger/src/index.ts` (`@arcaai/logger`) has no redaction at all. Additionally the allowlist (`redactor.ts:52-87`) omits `prompt`, `userPrompt`, `content`, and `text` — the exact key names an assembled prompt would be logged under.

---

## What is genuinely sound

These are controls I tried to break and could not, or that are notably better-built than the surrounding code.

1. **The attestation gate itself.** `approveSummary` is a single, well-ordered, fail-closed path: authenticated user required (`summary.service.ts:875-878`), tenant scope asserted before any mutation (`:835`), idempotent on re-approval (`:841-850`), safety FLAG hard-blocks without an explicit recorded override (`:869-873`), and the `ATTEST` WORM write is **awaited and fail-closed before** the status flip (`:940-954`, then `:975-981`). The ordering is correct — an audit failure aborts the sign-off rather than leaving a signed note with no trail.

2. **`HarnessAuditEvent` is a real WORM ledger.** Privilege-enforced (`REVOKE UPDATE, DELETE`, `migration.sql:209,212`), SHA-256 hash-chained with `prevHash` (`harnessAuditHash.ts`), `@@unique([hash])`, a chain verifier (`harness-audit.service.ts:128-139`), excluded from soft delete, encrypt-before-hash, and guarded by a live-Postgres regression test that asserts UPDATE and DELETE are rejected (`harness-audit-worm.postgres.test.ts:102-190`). This is the standard the rest of the audit story should be held to. (Documented caveat: `append` is an unlocked read-then-write, so concurrent appends can fork the chain; the `hash` unique constraint catches only exact duplicates.)

3. **PHI-at-rest encryption in the database is thorough and fail-closed.** Plaintext columns were dropped, not merely supplemented — ciphertext is the system of record across `ContextItem`, `ContextItemVersion`, `SummaryMeta`, `NamedEntity`, `Highlight`, `TranscriptionJob`, and the DNA tables. Under `SECRETS_PROVIDER=vault` (what `.env.sample:87` ships) the helper throws rather than persist plaintext (`phi-field-encryption.ts:32-33,61-67`).

4. **Gate-edit exemplar mining is a model of fail-closed design.** Redaction runs **before** any persistence; both snippets must survive or the candidate is dropped entirely (`gate-edit-mining.service.ts:172-182`); a no-op redactor is caught by a direct-identifier sniff (`:413`, `:447-449`); an absent redactor mines nothing (`:409`); export is capped at 500 rows explicitly to avoid an exfiltration primitive. The DI module documents the omission of `IPhiRedactor` as deliberate. The bank is empty in every configuration — worth knowing, but the failure mode is the safe one.

5. **AI-vs-human provenance is reconstructible**, contrary to a flat reading of "no attribution". The immutable `ai_draft_v1` snapshot (`harness-internal.service.ts:1507`), per-version `changeReason`/`changeSource`/`changedBy`, and the encrypted `contentDiff`/`fieldChanges` stamped onto the signed note (`summary.service.ts:908-913`) let you reconstruct exactly what the model wrote versus what the clinician changed. What is missing is *inline, per-clause* labeling — not provenance as such.

6. **Cross-doctor and cross-tenant style isolation is correctly enforced**, with a clear rationale in-code about imitation risk (`text-proxy.controller.ts:969-984`).

7. **STT WebSocket transport hardening is genuinely careful**: CSWSH origin allowlist that fails closed when the registry is unavailable, single-use stream tickets (never JWTs in URLs), ticket-tenant to session-tenant binding verification, and per-tenant concurrency accounting (`stt-ws.gateway.ts:292-520`).

8. **GenAI telemetry content capture is pinned off and boot-enforced** in both runtimes (`text/core/config.py:346-395`; `genai-content-capture-audit.ts:33-45`), with the empty-string default deliberately distinguishable from "explicitly safe".

9. **Redis persistence is off by default** with the PHI rationale stated in the compose file (`docker-compose.yml:176-186`).

---

## Corrections to wave-1 claims

| Wave-1 claim | My finding |
|---|---|
| "`approveSummary` is the sole `SIGNED` write site; no path reaches a signed note without explicit human action." | **Confirmed for the stored record — but incomplete.** The *presented* status is separately forgeable via `metadata.status` (F-06), which no wave-1 lane reported. The invariant holds at the database column and WORM ledger; it does not hold at the API contract or the UI. |
| "No `force`/`auto`/`skipReview` flag exists." | **Confirmed.** Searched exhaustively; the only option on the sign path is `overrideSafetyFlag`, which tightens rather than loosens. |
| "The internal harness service-token route can record gate decisions but never sign." | **Confirmed** (`harness-internal.service.ts:1211-1247` writes a WORM row only). Wave 1 understated the corollary: that route accepts a caller-supplied `clinicianId` and `attestationHash`, and the admin signal endpoint can drive it (F-09). |
| Lane D: "No PHI sanitizer runs between the finalized transcript and NLP/TEXT consumption." | **Confirmed and broader than stated.** True for NLP (`summary.service.ts:1571`, `ner.processor.ts:219`) *and* for TEXT on the default path (F-02), *and* for the style-DNA corpus (F-07). |
| Lane D: "A real Presidio redactor exists but is scoped only to cloud-LLM egress." | **Confirmed, with a material correction.** It is scoped to cloud egress *and* only to two provider names. For `openai`/`anthropic`/`vertex` it is not merely out of scope — it silently returns the text unredacted while reporting itself enabled and fail-closed (F-01). "Scoped to cloud egress" overstates the coverage. |
| Lane C: "`ResourceViewed` is only durably persisted when `forceAuditLog: true`, which no clinical read path sets." | **Confirmed independently** (`sysEvent.service.ts:246`; six non-clinical `forceAuditLog: true` sites). One addition: summary and transcript *body* reads emit no `ResourceViewed` at all, so the gap is wider than "the flag is unset". |
| Lane C: "No consent-revocation cascade mechanism exists at all." | **Confirmed**, and the reason is more fundamental than a missing job: there is no `Patient` model, so the set of records belonging to a patient is not enumerable in the schema. |
| Three lanes: "Consent is absent; only dead never-written enum literals." | **Confirmed.** I verified `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` have zero writers. Refinement: `ContextItemType` has **no** `CONSENT` member (`enums.prisma:224-245`) — the dead literals live only on `HarnessAuditAction`. |
| Lanes: "Only whole-document status, no per-clause origin labeling." | **Partially corrected.** Per-clause labeling is indeed absent, but version-level provenance is real and reconstructible (`ai_draft_v1` + `contentDiff`/`fieldChanges`). "No attribution" would be too strong. |
| Implied by the exemplar-bank invariants (INV-169/170): the bank retains patient contributions. | **Corrected in the safe direction.** The bank is **empty in every configuration** — `IPhiRedactor` has no provider anywhere in the repo, and its absence fails closed to mining nothing (`gate-edit-mining.service.ts:409`). The scrubbing gap is real but currently has nothing to scrub. |

**Could not reproduce / found no evidence for:** any claim that a timeout, cron, or service-token path reaches `SIGNED`. I searched specifically for it and the negative result is solid.

---

## Open questions requiring runtime or human answers

1. **What database role does the application actually connect as?** The WORM guarantee on `HarnessAuditEvent` is `REVOKE UPDATE, DELETE` **from `hope_app` / `hope_app_template`**. A table owner or superuser is unaffected by those revokes. If any environment's `DATABASE_URL` connects as `postgres` or as the table owner, WORM is not enforced there. Requires inspecting live connection strings.

2. **Does the DNA `styleText` actually contain patient facts in practice?** F-07 establishes that raw notes go in and nothing prevents facts coming out. Whether a given model+prompt combination emits verbatim or paraphrased PHI into `styleText` is an empirical question — sample real `encryptedReportData` rows and inspect.

3. **Which tenants have cloud `AiProviderConnection` rows configured?** F-01 and F-02 are latent until one exists. A single query against `AiProviderConnection` answers whether unredacted egress is happening today.

4. **Is Presidio installed in the deployed harness image?** The `guardrails` extra is optional (`pyproject.toml:137-141`). Determine whether the built image includes it *and* the spaCy `en_core_web_lg` model.

5. **Is `SECRETS_PROVIDER=vault` set in every environment?** PHI-at-rest encryption is a soft no-op otherwise (`phi-field-encryption.ts:32-33`).

6. **Is `audit-retention.enabled` off everywhere?** It is a live, DB-backed switch on a hard delete of the audit ledger (F-05).

7. **Is MinIO/S3 server-side encryption enabled in non-local deployments?** The compose default is off; production may differ, and the answer determines whether raw audio is encrypted at rest.

8. **Product decision, not an engineering one:** should `metadata.status` continue to exist at all? It is a legacy JSON lifecycle field shadowing a typed column, and F-06 is a direct consequence of the two coexisting. Collapsing to the typed column would remove the class of bug rather than patch one instance.
