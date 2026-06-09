# Clinical Workspace — Heavy OCR + Manual Doctor Highlighting

| | |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ticket**    | TASK-344 |
| **Name**      | Clinical Workspace — Heavy OCR for uploaded lab/exam files + Manual doctor highlighting (the two open-ended follow-ups explicitly deferred from TASK-342) |
| **Created**   | 2026-06-09 |
| **Updated**   | 2026-06-09 |
| **Status**    | **Completed (code + migration FILE done & gates green; `Highlight` migration generated but NOT yet applied to the DB — see Implementation Summary)** |
| **Cross-ref** | [TASK-342](../TASK-342-Clinical-Workspace-Durable-Context-Integration/README.md) (parent — built the extraction/highlight **seams**, deferred these two items), [TASK-330](../TASK-330-Clinical-Documentation-Harness/README.md) (Harness — `assemble`/draft/NER persistence), [TASK-339](../TASK-339-Clinical-Workflow-Playground/README.md) (cockpit + `LiveDocumentationService`), [TASK-340](../TASK-340-Live-SOAP-Hardening/README.md) (realtime engine hardening), [TASK-341](../TASK-341-Clinical-Workspace-Realtime-Admin-Live/README.md) (UI consolidation) |
| **Migration** | **Workstream A (OCR): NONE.** Reuses the existing `metaData.extractedText` / `content` seam on `ContextItem` (`packages/database/src/prisma/db_main/consultation.prisma:72,91,96`) — no new column/model/enum. **Workstream B (Manual highlighting): REQUIRED for the recommended durable option** — a new `Highlight` model (one additive table; no change to existing tables). The ephemeral-only fallback needs **no** migration. |

> Two items were deferred from TASK-342 because they need architecture/UX decisions rather than a surgical fix. **(A) Heavy OCR** — TASK-342 shipped a dependency-free CLIENT extractor for *text* uploads (`txt/csv/tsv/md/json/log`) that threads `metadata.extractedText` end-to-end into the live summary **and** the authoritative SOAP; binary/scanned uploads (PDF scans, images, Office docs) still fall back to just the filename label. This ticket extends extraction to those binary/scanned files so their **contents** reach both surfaces. **(B) Manual highlighting** — today only AI/NLP highlights exist (rendered as `<mark>` entity spans over the AI live summary); the doctor cannot select-and-highlight text on the transcript or notes. This ticket adds doctor-driven highlighting and decides whether highlights are ephemeral UI or a durable, persisted artifact that can feed the note/SOAP. **Both workstreams plug into seams TASK-342 already built** — they are additive, not rewrites.

This is a **scoping proposal**. Each workstream below presents the problem, the verified current-state evidence, and **2–3 concrete options with a clear recommendation**. Nothing here is implemented; §"Implementation Summary" is a placeholder to be filled once a workstream is approved and built.

---

## Workstream A — Heavy OCR for uploaded lab/exam files (GAP #5 heavy OCR)

### A.1 Requirement Analysis

**Problem.** A doctor uploads a lab/exam result mid-visit (cockpit "Lab / exam" tab). TASK-342 made *text* uploads thread their contents into the live summary and the harness-assembled SOAP, but **binary/scanned** uploads (the common case for real labs: scanned PDFs, photos of a result, faxed PDFs, Office docs) yield no text — only the `Lab/exam result: <name>` filename label reaches the AI. The clinical contents of those files never inform the summary or the authoritative note. Per the 2026 PDF-extraction landscape, **38% of business PDFs contain ≥1 scanned page; in healthcare that exceeds 65%**, so this is the majority of real lab uploads, not an edge case.

**Business context.** The promise of the workspace is "I attach a lab, and the system's note reflects it." For scanned/photographed labs that promise is currently unmet. Closing it materially improves SOAP completeness and reduces manual re-keying of results.

**Acceptance criteria (concrete + verifiable).**
1. A digitally-generated (text-layer) PDF lab upload has its text extracted and threaded via the existing `metadata.extractedText` seam, so the **contents** (not the filename label) reach (a) the live summary (`ContextService.addContext` `contentPreview`) and (b) the harness `assemble` attachment block.
2. A scanned/image lab upload (image-only PDF, JPG/PNG photo) has its text extracted via OCR and threaded through the **same** seam.
3. When extraction yields nothing (unsupported/corrupt), behavior degrades gracefully to today's filename-label fallback — never an error, never a blocked upload.
4. PHI in file bytes does not leave the tenancy boundary by default (see §C Tenancy/PHI). Any third-party OCR egress is opt-in per-tenant config, off by default.
5. Extracted text is capped (reuse `MAX_EXTRACTED_CHARS = 20_000`, `lib/extract-text.ts:13`) to bound token cost.

### A.2 Current State Evaluation (file:line evidence)

- **The seam is already built and proven for text files** — extend it, don't rebuild it:
  - Client extractor: `apps/ui-playground/src/features/clinical-workspace/lib/extract-text.ts` — `extractTextFromFile` handles only `txt/text/csv/tsv/md/markdown/json/log` by extension or `text/*` / `application/json` / `application/csv` MIME (`:15-30`), via the browser `File.text()` API (`:39`), trims + caps at 20k (`:13,42`); **binary/scanned → `null`** (`:37`).
  - Upload threads it: `components/context-panel.tsx:75-100` `addLabResult` uploads to object storage (`storage.uploadFile(STORAGE_BUCKET, labFile)` → `{ key }`, `:79`), extracts text (`:84`), and posts `metadata: { subType, fileName, ...(extractedText ? { extractedText } : {}) }` (`:89`).
  - Live-summary seam: `packages/applications/src/services/consultation/context/context.service.ts:144-145` — `addContext` prefers `metadata.extractedText` over `content` for the `ContextAdded` `contentPreview` (`:154`) that feeds `LiveDocumentationService.handleContextAdded`.
  - Authoritative-SOAP seam: `packages/applications/src/services/consultation/harness/harness-internal.service.ts:139-148` — `assemble` prefers `metaData.extractedText`, else the `content` label, for the attachment block.
- **Storage already supports server-side byte access** (needed for any server-side extraction): `IBlobStorageService.getObject(params): Promise<Buffer>` and `getObjectStream(...)` (`packages/applications/src/services/baseServices/storage/IBlobStorageService.ts:25-26`). The uploaded file is addressable by bucket + key; the key is stored as `ContextItem.mediaId` (`consultation.prisma:96`); the `Media` row carries `mimeType`/`size`/`uri` (`packages/database/src/prisma/db_main/media.prisma:11-16`).
- **No document/OCR parser exists anywhere to reuse.** Verified all five Python services' `pyproject.toml`:
  - `apps/nlp` — `spacy`, `transformers`, `torch`, plus `python-multipart` + `aiofiles` (file-upload plumbing) (`apps/nlp/pyproject.toml:34-41`). Has the ML runtime but **no** OCR/PDF lib.
  - `apps/guardrail` — `onnxruntime>=1.18` + `gliner2-onnx` (`apps/guardrail/pyproject.toml:39-41`). **ONNX Runtime is already in the stack** (relevant: RapidOCR is ONNX-based).
  - `apps/harness` — `presidio-analyzer`/`presidio-anonymizer` PHI redaction in an opt-in `guardrails` extra (`apps/harness/pyproject.toml:97-101`); no OCR.
  - `apps/smr` — text-gen only (`openai`, `boto3`); `apps/stt-v2` — audio only.
  - Net: **reuse is limited to ONNX Runtime (guardrail) and the NLP ML/upload plumbing**; any OCR engine or PDF text-layer parser is a **new dependency**.

### A.3 Implementation Proposal

> 2026 best practice (multiple benchmarks) is **route, don't OCR everything**: extract the text layer cheaply where it exists, and run OCR only on pages that genuinely lack one. OCR-ing digital PDFs is slow (Tesseract 0.5–3s/page vs PyMuPDF ~0.01s/page) and pointless. CPU-only OCR winner is **RapidOCR (PaddleOCR models on ONNX Runtime, ~80MB, ~3.0% CER, ~0.9s/page)**, beating Tesseract on both speed and accuracy without a GPU.

| | **Option A1 — Client-side text-layer extraction (PDF.js + DOCX)** | **Option A2 — Server-side OCR endpoint (RapidOCR/ONNX in NLP)** | **Option A3 — Managed cloud OCR (Textract / Azure DI / Mistral OCR)** |
| --- | --- | --- | --- |
| What it covers | Digital/searchable PDFs (text layer) + optionally DOCX; **NOT** scanned/image-only | Everything: scanned PDFs, photos (JPG/PNG), image-only PDFs (+ digital via PyMuPDF) | Everything, highest accuracy on messy scans/tables |
| Where | Browser, extends `extract-text.ts`; bytes never leave the client | New endpoint on `apps/nlp`; reads bytes via `IBlobStorageService.getObject` server-side | Third-party API call from `apps/nlp` (or api) |
| New dependency | Frontend `pdfjs-dist` (+ `mammoth` for DOCX) | Python `rapidocr-onnxruntime` + `pymupdf` (PyMuPDF) added to `apps/nlp` | SDK (`boto3` already in smr; or `azure-ai-documentintelligence`) |
| New Prisma migration | No (reuses `metadata.extractedText`) | No | No |
| New Python service | No | **No** — extend existing `apps/nlp` | No |
| PHI posture | **Best** — bytes stay in-browser, no egress | **Good** — bytes stay in-cluster (tenant bucket → NLP) | **Weakest** — PHI leaves to a third party; requires BAA + per-tenant opt-in |
| Cost / latency | ~free, ~100ms | CPU, ~0.9s/scanned page, in-cluster | ~$0.002–0.015/page + network |
| Effort | **S–M** | **M–L** | **M** |

**RECOMMENDATION: a tiered pipeline — Option A1 now, Option A2 as the heavy-OCR follow-up; A3 only as an opt-in per-tenant override.**
- *One-line justification:* A1 captures the digital-PDF majority with zero backend and zero PHI egress by extending the seam that already works; A2 (CPU-only RapidOCR/ONNX, reusing infra already present in guardrail) covers true scans/photos in-cluster without a new service or any third-party PHI exposure; A3 is rejected as a default purely on PHI-egress grounds but kept as an opt-in tenant config for tenants who sign a BAA and want best-in-class table accuracy.
- The router is trivial: the client tries A1; if it yields no text (scanned/image), the upload still stores `mediaId`, and a server-side job runs A2 OCR, then **writes the result back through the same `metaData.extractedText` field** (so both live and harness seams light up unchanged).

**Affected files / layers (recommended path).**
- *Frontend (A1):* `lib/extract-text.ts` (add PDF.js text-layer + optional DOCX branch; keep `null` fallback), `components/context-panel.tsx` (no shape change — already threads `extractedText`), `vite`/deps for `pdfjs-dist` worker.
- *Services/API (A2):* `apps/nlp` new `POST /api/v1/extract` (multipart **or** `{ bucket, key }`) returning `{ text, pageCount, ocrUsed }`; an apps/api orchestration seam (a small processor or an `addContext` post-step) that, when `extractedText` is absent on an `ATTACHMENT`, fetches bytes via `IBlobStorageService.getObject` and calls NLP, then persists `extractedText` onto `ContextItem.metaData` (reuse `updateContext`/repo) and re-emits the live `ContextAdded` preview. No change to `harness-internal.service.ts` (it already reads `metaData.extractedText`).
- *Config:* `NLP_URL` already wired (`ner.processor.ts:30`). Add an off-by-default `OCR_ENABLED` flag + optional per-tenant `OCR_PROVIDER` for A3.

**New dependency? Migration? Python service?** New **frontend** dep (`pdfjs-dist`, +`mammoth` if DOCX) for A1; new **Python** dep (`rapidocr-onnxruntime` + `pymupdf`) for A2. **No Prisma migration. No new Python service** (extend `apps/nlp`).

**Rough effort:** A1 = **S–M**; A2 = **M–L**; combined recommended scope ≈ **L**.

**TDD test list (RED → GREEN).**
- *Frontend (A1, Vitest, script `test`):* extend `lib/__tests__/extract-text.test.ts` — a digital PDF fixture yields its text; an image-only PDF / PNG yields `null` (falls back to label); corrupt input never throws; cap at 20k respected.
- *Python (A2, pytest, conda `arcaenv`):* new `apps/nlp/tests/.../test_extract.py` — digital PDF → text via PyMuPDF, no OCR (`ocrUsed=false`); scanned-page fixture → OCR path (`ocrUsed=true`); unsupported MIME → empty text, 200 (graceful); never 5xx on a parseable-but-empty file.
- *Services (A2 orchestration, Vitest):* `context.service.test.ts` / new processor test — when an `ATTACHMENT` has `mediaId` but no `extractedText`, the orchestration fetches bytes (`IBlobStorageService.getObject` mocked) + calls NLP (mocked) + persists `metaData.extractedText` + re-emits the live preview; harness `assemble` then surfaces the OCR text over the label (extend `harness-internal.service.test.ts`).

---

## Workstream B — Manual doctor highlighting

### B.1 Requirement Analysis

**Problem.** The TASK-342 audit (§2 feature 3) found the doctor **cannot manually select-and-highlight** information on the transcript or notes. The only highlights that exist are **AI/NLP** entity spans, rendered as `<mark>` over the AI live summary. Doctors want to flag salient text themselves (e.g. mark a symptom in the transcript, a value in a note) and — the open design question — possibly have those marks **persist** and **feed the note/SOAP**.

**Core decision to make (the deferred architecture/UX question).** Are manual highlights **ephemeral UI** (lost on reload, never leave the browser) or a **durable, persisted artifact** that survives reload, is auditable, and can be threaded into the authoritative SOAP?

**Acceptance criteria (concrete + verifiable).**
1. The doctor can select text on a supported surface (persisted transcript, case/work note, and/or AI summary) and apply a highlight; it renders as a visually distinct `<mark>` (distinguishable from AI-entity marks).
2. The doctor can remove a highlight.
3. **Decision criterion:** the chosen persistence model is implemented and tested — either (a) explicitly ephemeral (documented; cleared on reload) **or** (b) durable (survives reload; per-tenant scoped; soft-deletable; optionally threaded into `assemble`).
4. If durable, highlights anchor robustly to their source text and survive minor text re-flow (per the W3C anchoring approach in B.3); a highlight that can no longer be anchored is reported as "orphaned", not silently mis-placed.
5. Manual highlights never pollute the **AI NER** aggregation (`getAggregateNamedEntities`) — they are a separate concern from `NamedEntity`.

### B.2 Current State Evaluation (file:line evidence)

- **Highlights today are AI-only and read-only:**
  - Render: `apps/ui-playground/src/features/clinical-workspace/components/live-summary-panel.tsx:124-141` maps section segments to `<mark>` with `data-entity-type/start/end` + a confidence tooltip; the panel is **prop-driven/presentational** (`:9-11,22-27`) — no selection affordance.
  - Anchoring math: `lib/live-summary.ts` `buildEntityHighlights` (`:40-66`) slices text by entity `start`/`end`; `buildSoapSectionViews` (`:81-109`) re-bases offsets per SOAP section. These are reusable pure helpers for rendering *manual* spans too.
  - Source of AI highlights: NLP `POST /api/v1/classify/tokens` (`packages/applications/src/services/consultation/jobs/processors/ner.processor.ts:166`) → `NamedEntity` rows (text/className/confidence/startOffset/endOffset) (`ner.processor.ts:85-105`); live entities arrive on the SSE payload `LiveSummaryEntity { text,type,confidence,start,end }` (`features/clinical-workspace/types.ts:59-65`).
- **The `NamedEntity` model is semantically AI-specific** — `aiModelId`/`aiModelVersion`/`confidence`/`className`/`processingTimeMs` (`consultation.prisma:283-317`), and it feeds `getAggregateNamedEntities` (`context.service.ts:504-642`). Overloading it for manual marks would pollute NER analytics → **avoid**.
- **No annotation/highlight model or type exists.** `enum ContextItemType` (`packages/database/src/prisma/db_main/enums.prisma:205-218`) has no `HIGHLIGHT`/`ANNOTATION`; `enum ContextItemSource` is `USER/AI/SYSTEM/TRANSCRIPTION` (`enums.prisma:235-242`). (The `HIGHLIGHT_*` matches in `logging.service.ts` are the unrelated Highlight.io log transport.)
- **Anchoring-surface nuance (important for the design):** the **live** transcript is **client-only/ephemeral** — `realtime.transcripts` rendered in `components/capture-panel.tsx:166-188`, never persisted. A durable highlight has **no stable anchor during the live phase**. After **Stop**, TASK-342 GAP #1 persists a `TRANSCRIPT` `ContextItem`, and case/work notes + the AI draft are already persisted `ContextItem`s. ⇒ **Durable highlights should anchor to persisted `ContextItem`s (post-stop transcript, notes, summary); live-caption highlighting is inherently ephemeral until Stop.**
- **CRUD/soft-delete conventions to reuse if durable:** `assertParentInScope` tenant guard + `broadcastSysEvent` + base `Repository.softDelete` (the exact pattern `ContextService.deleteContext` uses, `context.service.ts:232-248`); context routes live on `consultation.controller.ts:524-676` (a sibling `:id/highlights` group fits cleanly).

### B.3 Implementation Proposal

> 2026 best practice for durable text highlights is the **W3C Web Annotation Data Model** with **dual selectors**: a `TextQuoteSelector` (`exact` + ~32-char `prefix`/`suffix`, robust to structural change) **plus** a `TextPositionSelector` (`start`/`end` offsets, precise but brittle to edits). Hypothesis's "fuzzy anchoring" re-attaches by trying position first, verifying against the quote, then fuzzy-matching the quote — storing **both** is the robustness key.

| | **Option B1 — Ephemeral UI-only** | **Option B2 — Durable `Highlight` model (W3C dual-selector anchoring)** | **Option B3 — Durable on `ContextItem.metaData` JSON** |
| --- | --- | --- | --- |
| Persists across reload | No | Yes | Yes |
| Can feed the SOAP/note | No | Yes (thread highlighted spans into `assemble`, like GAP #2 `clinicianNotes`) | Possible but awkward |
| Storage | Client state only (Zustand/local) | New `Highlight` table (additive) | JSON array on the parent `ContextItem._metadata` |
| Anchors to live transcript | N/A (ephemeral) | Anchors to **persisted** items (post-stop); live marks stay ephemeral | Live transcript has **no** parent row → can't store there |
| Queryable / auditable / soft-delete | No | Yes (own indexes, `resourceStatus`, `SysEvent`) | Weak (read-modify-write whole array; no per-mark audit; concurrency risk) |
| Pollutes AI NER | No | No (separate model) | No |
| Migration | No | **Yes** (1 additive table) | No |
| Effort | **S** | **L** | **M** |

**RECOMMENDATION: Option B2 (durable `Highlight` model), delivered in two phases — Phase 1 ships the ephemeral selection+render UX (a slice of B1) to validate interaction; Phase 2 adds persistence + anchoring + optional SOAP feed.**
- *One-line justification:* the stated goal — highlights that persist and can feed the note/SOAP — is unattainable with B1 alone, and B3's JSON-array approach can't anchor the (unpersisted) live transcript and is awkward to query/audit/soft-delete; a dedicated, W3C-anchored `Highlight` model is the queryable, auditable, DDD-consistent home, and phasing de-risks the UX before the schema lands.

**Proposed `Highlight` shape (Phase 2; follows the standard HOPE model template — see `02-database-prisma.mdc`).**
- `tenantId`, `consultationId` (FK), `sourceContextItemId String?` (the persisted transcript/note/summary it anchors to; nullable for a possible future "live ephemeral promoted on stop"), `targetKind` (`TRANSCRIPT|CASE_NOTE|WORKNOTE|SUMMARY`), anchoring: `exact`, `prefix`, `suffix`, `startOffset`, `endOffset` (dual selectors), presentation: `color`/`label`/optional `note`, plus standard `resourceStatus`/audit fields. Reuse base `Repository.softDelete`.

**Affected files / layers (recommended path).**
- *Phase 1 (Frontend only):* new `lib/highlight-anchoring.ts` (compute `TextQuoteSelector`+`TextPositionSelector` from a DOM `Selection`; re-attach by position→quote→fuzzy), reuse `buildEntityHighlights` to render manual marks (distinct tone from AI), a select-to-highlight affordance + remove control on the transcript/note/summary surfaces (`review-panel.tsx`, `context-panel.tsx`/transcript view). Ephemeral client state.
- *Phase 2 (Durable):* Database (`consultation.prisma` new `Highlight` model + migration) → Domain (entity/factory/mapper/repository in `packages/domains`, per `03-domain-layer.mdc`) → Services (`HighlightService` in `packages/applications`, CRUD + `broadcastSysEvent` + tenant guard) → API (`:id/highlights` routes on `consultation.controller.ts`) → Frontend (swap ephemeral store for React Query against the new endpoints; render persisted marks on load). *Optional SOAP feed:* thread approved highlight `exact` spans into `harness-internal.service.ts` `assemble` alongside GAP #2 `clinicianNotes` (a labeled `[highlight]` block) — reuses the existing prompt-assembly seam.

**New dependency? Migration? Python service?** **No new runtime dependency** (TS/Prisma/React only; anchoring is hand-rolled per the W3C spec or a tiny utility). **No new Python service.** **Prisma migration: YES** for the recommended durable B2 (one additive `Highlight` table); the Phase-1 ephemeral slice needs **no** migration.

**Rough effort:** B1/Phase 1 = **S**; full B2 (Phase 1 + Phase 2) = **L** (DB→Domain→Service→API→Frontend); B3 = **M**.

**TDD test list (RED → GREEN).**
- *Anchoring (Vitest, pure):* `lib/__tests__/highlight-anchoring.test.ts` — round-trips a selection to dual selectors and back; re-attaches after a prefix-insert (position shifts, quote still matches); reports "orphaned" when the quote is gone; never throws on empty/zero-length selection.
- *Render (Vitest):* `review-panel.test.tsx` / transcript-view test — selecting text adds a manual `<mark>` distinct (`data-testid`/tone) from AI-entity marks; remove control deletes it; (Phase 2) persisted highlights render on load.
- *Services (Phase 2, Vitest):* `highlight.service.test.ts` — create asserts `assertParentInScope` + `broadcastSysEvent(ResourceCreated)`; delete uses `softDelete` + `ResourceDeleted`; cross-tenant/missing → `NotFound`.
- *API (Phase 2, Vitest):* `consultation.controller.test.ts` — `POST`/`GET`/`DELETE :id/highlights*` verify ownership then delegate.
- *Optional SOAP feed (Vitest):* `harness-internal.service.test.ts` / `prompt-assembly.service.test.ts` — approved highlights render into the prompt block; none ⇒ prompt unchanged.

---

## C. Cross-cutting — Tenancy / PHI & storage constraints

- **PHI never leaves the tenancy boundary by default.** Workstream A's recommendation keeps bytes in-browser (A1) or in-cluster (A2, tenant bucket → NLP via `IBlobStorageService`); the only PHI-egress path (A3 managed cloud OCR) is **off by default**, opt-in per tenant, and should be gated behind a signed BAA. This mirrors the harness's fail-closed PHI posture (`apps/harness` Presidio redaction).
- **Tenant scoping is automatic but must be honored on new writes.** All new `ContextItem`/`Highlight` reads/writes must flow through repositories (the `tenantScope` Prisma extension) and use `assertParentInScope` for parent ownership (as `ContextService` does throughout, e.g. `context.service.ts:90,176,238`). Extracted text and highlights are PHI — same scoping/soft-delete/audit rules as any `ContextItem`.
- **Bounded payloads.** Reuse `MAX_EXTRACTED_CHARS` for OCR output; cap highlight `exact`/`prefix`/`suffix` lengths to keep rows small and prompts bounded.
- **Graceful degradation everywhere.** OCR failure → filename-label fallback (never block the upload); un-anchorable highlight → "orphaned" state (never silently mis-place). Both mirror TASK-342's "never throws / degrades to label" rule.

---

## Implementation Summary

Both workstreams were implemented and integrated in a shared working tree; all authoritative gates are green. The `Highlight` Prisma **migration file is generated but NOT yet applied to any database** (see "Migration status" below).

### Workstream A — Heavy OCR for uploaded lab/exam files (tiered extraction)

Chosen path: the recommended **tiered pipeline** — Option **A1** (client text-layer) + Option **A2** (server-side OCR); **A3** (managed cloud OCR) left as a config hook only (out of scope).

- **A1 — In-browser PDF text-layer extraction.** `apps/ui-playground/src/features/clinical-workspace/lib/extract-text.ts` extracts digital/searchable PDFs via `pdfjs-dist@^6.0.227` (Vite `?url` worker → same-origin, no CDN/eval). 20k-char cap (`MAX_EXTRACTED_CHARS`); image-only / no-text-layer PDFs → `null` (fall through to A2); DOCX/mammoth intentionally skipped. Unchanged `null` fallback for images/binaries.
- **A2 — Server-side OCR endpoint in `apps/nlp`.** New `POST /api/v1/extract` (multipart `file`) → `{ text, pageCount, ocrUsed }`. PyMuPDF text-layer first; RapidOCR (`rapidocr-onnxruntime`, ONNX/CPU, lazily loaded) only for pages lacking a text layer; graceful 200-on-failure (never 5xx). Deps added to `apps/nlp/pyproject.toml`: `pymupdf>=1.24.0`, `rapidocr-onnxruntime>=1.3.0` (installed in `arcaenv`).
- **A2 orchestration — event-driven, no new API route.** New `OcrEnrichmentProcessor` (`packages/applications/src/services/consultation/ocr/ocr-enrichment.processor.ts`) handles `@OnEvent(ConsultationPipelineEvent.ContextAdded)`: for an `ATTACHMENT` with a `mediaId` but no `metaData.extractedText`, it fetches bytes via `IBlobStorageService.getObject`, calls NLP `/extract`, persists `metaData.extractedText`, and re-emits the live `ContextAdded` preview (so `LiveDocumentationService` folds OCR text into the running summary; the harness `assemble` already reads `metaData.extractedText`). Loop-guarded (acts only when `extractedText` is absent). Gated by `OCR_ENABLED` (**default ENABLED** — in-cluster RapidOCR has no PHI egress); bucket via `OCR_STORAGE_BUCKET` (default `attachments`). Registered in `LiveDocumentationServiceModule`. CLS is re-bound with a new `ocr-enrichment` worker-session kind.
- **Files.** Frontend: `lib/extract-text.ts` (+ test), `package.json` (`pdfjs-dist`). NLP: `schemas/extraction.py`, `services/document_extractor.py`, `api/v1/rest/extract.py`, `dependencies.py`, `api/v1/__init__.py`, `pyproject.toml`, `tests/test_extract.py`. Applications: `services/consultation/ocr/ocr-enrichment.processor.ts` (+ test), `live-documentation/live-documentation.service.module.ts`, `common/worker-session.ts` (new `ocr-enrichment` kind — added during the integration pass).
- **Known follow-up (harmless).** `LiveDocumentationService.handleContextAdded` *appends* (not upserts), so the OCR re-emit adds a second running-summary note for the same attachment. Harmless; upsert-by-`contextItemId` is a later optimization.

### Workstream B — Manual doctor highlighting (Option B2, durable model)

Chosen path: the recommended **Option B2** (durable `Highlight` model with W3C dual-selector anchoring), delivered in two phases.

- **Phase 1 — Selection + render (frontend).** New `lib/highlight-anchoring.ts` — W3C dual selectors (`exact` + ~32-char `prefix`/`suffix` + `startOffset`/`endOffset`); re-attach strategy position → quote → fuzzy → orphaned; never throws. New `HighlightableSurface` component renders manual marks (sky / dotted-underline tone, visually distinct from the AI amber entity marks); select-to-highlight + remove.
- **Phase 2 — Durable persistence.** New `Highlight` model + migration `20260609203500_task_344_add_highlight` (additive: `core.HighlightTargetKind` enum + `core.Highlight` table — `tenantId`, `consultationId` FK, `sourceContextItemId?`, `targetKind {TRANSCRIPT|CASE_NOTE|WORKNOTE|SUMMARY}`, `exact`/`prefix`/`suffix`/`startOffset`/`endOffset`, `color`/`label`/`note?`, `resourceStatus` + audit; 4 indexes, 1 FK to Consultation). Full DDD: entity/factory/mapper/repository (`packages/domains/src/**/generated/core/Highlight*`) + new `ResourceType.Highlight` + `CoreDatabaseModule` registration.
- **Service + API.** `HighlightService` (CRUD; `assertParentInScope`; `broadcastSysEvent(ResourceCreated/ResourceDeleted)`; `softDelete`; `NotFound` on cross-tenant/missing) in `packages/applications/src/services/consultation/highlight/`. API routes `POST/GET/DELETE /consultations/:id/highlights[/:highlightId]` on `consultation.controller.ts` (ownership-guarded writes, access-guarded read).
- **Frontend wiring.** `ManualHighlightSurface` talks to the endpoints via React Query, wired into case/work notes in `context-panel.tsx`. Manual highlights are a separate concern from `NamedEntity` (no NER-aggregation pollution).
- **SOAP feed (done).** Doctor highlight `exact` spans thread into the harness `assemble` as a `[highlight]` block via a new `{doctor_highlights}` prompt var; `HighlightRepository` is injected `@Optional()` into `HarnessInternalService`.
- **Deviations.** Migration generated, **not applied**. Persisted UX wired to case/work notes only — transcript-pane + review-SOAP-body are drop-in follow-ups via the reusable surface. Custom `color` is stored but not yet rendered. The DOM-bound `computeAnchorFromSelection` is not unit-tested (the pure anchoring core is fully covered).

### Integration pass (2026-06-09)

- **Cross-workstream fix #1 — DOMMatrix/pdfjs.** Workstream A's top-level `import 'pdfjs-dist'` in `extract-text.ts` crashed `context-panel.test.tsx` at import time (`ReferenceError: DOMMatrix is not defined` — jsdom lacks `DOMMatrix`). Fixed by making the `pdfjs-dist` + worker `?url` imports **lazy** (`await import(...)` inside `extractPdfText`). The existing `extract-text.test.ts` mock works unchanged (`vi.mock` intercepts dynamic imports). Bonus: pdfjs is now a separate `pdf-*.js` bundle chunk rather than living in the main entry.
- **Cross-workstream fix #2 — worker-session kind.** A's `OcrEnrichmentProcessor` used `kind: 'ocr-enrichment'`, which broke `pnpm build --filter @arcaai/applications` (`ocr-enrichment.processor.ts(88,84): error TS2322: '"ocr-enrichment"' is not assignable to type 'WorkerSessionKind'`). Added `'ocr-enrichment'` to the closed `WorkerSessionKind` union in `packages/applications/src/common/worker-session.ts` (the file's own contract requires every new `@OnEvent`/worker CLS rebind to register its label).

**Authoritative gate results (real captured output).**

| Gate | Result |
| --- | --- |
| `pnpm build --filter @arcaai/applications` | **PASS** — `Tasks: 7 successful, 7 total` (after fix #2; the first run failed on the `WorkerSessionKind` type error) |
| `pnpm build:api` | **PASS** — `Tasks: 8 successful, 8 total` |
| `pnpm --filter @arcaai/ui-playground build` | **PASS** — `✓ built in 49.88s` (pdfjs split into its own `pdf-*.js` chunk) |
| `pnpm --filter @arcaai/applications test:unit` | **PASS** — `Test Files 211 passed \| 1 skipped (212)`, `Tests 4972 passed \| 4 skipped (4976)` |
| `pnpm --filter @arcaai/ui-playground test` | **PASS** — `Test Files 145 passed (145)`, `Tests 1219 passed (1219)` |
| `pnpm py:nlp:test` (conda `arcaenv`) | **PASS** — `38 passed, 38 warnings in 63.32s` |
| `pnpm py:nlp:lint` | **PASS** — `All checks passed!` |
| `pnpm py:nlp:typecheck` | **PASS** — `Success: no issues found in 36 source files` |

`ReadLints` on every changed source file (both workstreams + the two integration fixes): **no linter errors**.

**Migration status (assessed, NOT applied).**

- `pnpm db:migrate:status` → `17 migrations found`; **all 17 reported "have not yet been applied"**, including `20260609203500_task_344_add_highlight`. (Exit code 1 is expected — Prisma returns non-zero whenever the DB is not up to date.)
- The generated `migration.sql` is **confirmed purely additive**: `CREATE TYPE "core"."HighlightTargetKind"` + `CREATE TABLE "core"."Highlight"` + 4× `CREATE INDEX` + 1× `ALTER TABLE "core"."Highlight" ADD CONSTRAINT … FOREIGN KEY ("consultationId") REFERENCES "core"."Consultation"("id")`. The lone `ALTER TABLE` adds an FK **on the brand-new `Highlight` table** — there is **no** `DROP` / `DELETE` / `TRUNCATE` / column-removal / `ALTER … DROP` on any existing object.
- **Risk read:** the migration *file* is safe and additive, but applying it in the current local state is **risky / not a clean single-migration apply** — 16 other migrations sit pending ahead of it and the local DB was provisioned via `db push` (empty migration history), so `prisma migrate dev` would detect drift and want to **reset** the database. A non-destructive apply would require baselining the 16 priors (`prisma migrate resolve --applied …`) then `prisma migrate deploy`. **Left to the user/parent to decide** under the DB-safety rules — no DB write / migrate / reset was performed.

---

## Change History

| Date | Description | Files |
| ---------- | ------------------------------------------------------------------------------------------- | --------- |
| 2026-06-09 | Plan drafted (scoping/Plan Mode) for the two TASK-342 deferrals — Workstream A (heavy OCR) + Workstream B (manual highlighting). Each with current-state evidence, 2–3 options + recommendation, effort, and a TDD test list. Status **Pending** (awaiting USER approval; no code written). | this file |
| 2026-06-09 | **Workstream A (Heavy OCR) implemented** — tiered extraction: A1 in-browser `pdfjs-dist` PDF text-layer + A2 `apps/nlp` `POST /api/v1/extract` (PyMuPDF + RapidOCR/ONNX, graceful 200) + event-driven `OcrEnrichmentProcessor` (`@OnEvent ContextAdded`, `OCR_ENABLED` default-on) re-emitting the live preview via the existing `metaData.extractedText` seam. | `lib/extract-text.ts`(+test), `apps/nlp/{schemas/extraction.py,services/document_extractor.py,api/v1/rest/extract.py,dependencies.py,api/v1/__init__.py,pyproject.toml,tests/test_extract.py}`, `ocr-enrichment.processor.ts`(+test), `live-documentation.service.module.ts` |
| 2026-06-09 | **Workstream B (Manual highlighting) implemented** — Option B2: W3C dual-selector anchoring (`highlight-anchoring.ts`) + `HighlightableSurface`; durable `Highlight` model + **additive** migration `20260609203500_task_344_add_highlight` (**NOT applied**) + full DDD + `HighlightService` CRUD + `:id/highlights` API + React Query wiring; doctor highlight spans threaded into harness `assemble` via `{doctor_highlights}`. | `highlight-anchoring.ts`, `highlightable-surface.tsx`, `context-panel.tsx`, `consultation.{controller,module}.ts`, `consultation/highlight/*`, `domains/**/Highlight*`, `ResourceType`, `consultation.prisma`, `enums.prisma`, `migration.sql`, `harness-internal.service.ts`, `prompt-assembly.service.ts` |
| 2026-06-09 | **Integration + finalization pass** — fixed the DOMMatrix/pdfjs import-time crash (lazy `await import('pdfjs-dist')` in `extract-text.ts`) and a `WorkerSessionKind` type error (added `'ocr-enrichment'` kind); ran the full authoritative gates **all green** (TS builds 7/7 + 8/8; applications 4972 + ui-playground 1219 unit tests; py:nlp 38 test / lint / typecheck), lints clean; assessed the `Highlight` migration (additive-only confirmed; `db:migrate:status` read-only — **NOT applied**). | `lib/extract-text.ts`, `common/worker-session.ts`, this file |
