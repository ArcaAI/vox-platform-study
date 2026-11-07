# API Gateway B06b — Inference, Prompts & Knowledge

Companion explainer for `api-gateway-b06b-inference-prompts-knowledge.html`.

## Scope
`B06b` completes `B06-ai-platform`: `ai-inference` (5/2), `inference-engines` (3/1), `prompt-management` (22/2), `prompt-inspector` (3/2), `nlp-task-instructions` (2/1), `knowledge` (5/1) — **40 routes / 9 controllers**. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Modules/routes | Controllers | Key services | Downstream |
|---|---|---|---|---|
| AI inference & engines | `/text-analyses`, `/safety-checks`, `/admin/inference-engines/lm-studio` (8) | `AiInferenceController` (`ai-inference.controller.ts:103`), `SafetyCheckController` (`safety-check.controller.ts:21`), `InferenceEnginesController` (`inference-engines.controller.ts:31`) | `LmStudioServingService` (`inference-engine/lmstudio-serving.service.ts:69`); ai-inference/safety service wiring verify | Inference/safety backends, LM Studio/engines |
| Prompt management/inspector | admin/runtime prompt templates, composed prompts, preview (25) | `PromptManagementController` (`prompt-management.controller.ts:60`), `PromptTemplateController` (`prompt-template.controller.ts:37`), `PromptPreviewController` (`prompt-inspector/prompt-preview.controller.ts:18`), `ComposedPromptAdminController` (`composed-prompt-admin.controller.ts:17`) | `PromptManagementService` (`prompt-management.service.ts:233`), `ComposedPromptService` (`composed-prompt.service.ts:37`) | Prompt/template/composed-prompt data |
| NLP task instructions | `/admin/nlp-task-instructions` (2) | `NlpTaskInstructionsAdminController` (`nlp-task-instructions-admin.controller.ts:39`) | Service wiring verify | Config/instruction data |
| Knowledge documents | `/admin/knowledge/documents` (5) | `KnowledgeController` (`knowledge.controller.ts:33`) | `KnowledgeDocumentService` (`knowledge-document.service.ts:54`) | Knowledge docs; retrieval/embedding runtime (verify) |

## Example input/output (representative)
- **Text analysis/safety check:** inference payloads -> analysis/safety results (verify model selection, moderation/safety semantics, PII handling).
- **Inference engines:** LM Studio admin/serving requests -> engine status/config/serving responses.
- **Prompt management/inspector:** template CRUD/render/preview requests -> prompt template/composed prompt/preview results.
- **Knowledge/NLP instructions:** admin document/instruction CRUD -> records; knowledge may involve indexing/embeddings/retrieval runtime.

## Validation / limitations
- Archify finalize **PASS** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Limitations: grouped endpoint nodes (40 routes/9 controllers); AiInference/SafetyCheck and NLP task instructions service implementation paths not separately verified in this pass; reconcile route/DTO contracts, safety semantics, and retrieval/embedding runtime with OpenAPI/implementation.
