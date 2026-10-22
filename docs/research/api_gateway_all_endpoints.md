# HOPE API Gateway — Complete Endpoints Catalog

- **Total Distinct Routes**: 529
- **Total Endpoints (Operations)**: 676
- **Total Functional Groups**: 92

---

## Table of Contents

- [Prometheus](#prometheus) (1 endpoints)
- [admin-agent-assignments](#admin-agent-assignments) (5 endpoints)
- [admin-agent-promotions](#admin-agent-promotions) (3 endpoints)
- [admin-agent-trajectory](#admin-agent-trajectory) (3 endpoints)
- [admin-agentic](#admin-agentic) (1 endpoints)
- [admin-agents](#admin-agents) (19 endpoints)
- [admin-ai-models](#admin-ai-models) (15 endpoints)
- [admin-ai-routing-policies](#admin-ai-routing-policies) (11 endpoints)
- [admin-ai-services](#admin-ai-services) (9 endpoints)
- [admin-allowed-origins](#admin-allowed-origins) (6 endpoints)
- [admin-api-keys](#admin-api-keys) (9 endpoints)
- [admin-audio-pipelines](#admin-audio-pipelines) (14 endpoints)
- [admin-audit-logs](#admin-audit-logs) (6 endpoints)
- [admin-billing-invoices](#admin-billing-invoices) (7 endpoints)
- [admin-billing-rate-card](#admin-billing-rate-card) (3 endpoints)
- [admin-changelog](#admin-changelog) (4 endpoints)
- [admin-consent-grants](#admin-consent-grants) (3 endpoints)
- [admin-consultation-context-schemas](#admin-consultation-context-schemas) (9 endpoints)
- [admin-consultations](#admin-consultations) (3 endpoints)
- [admin-departments](#admin-departments) (10 endpoints)
- [admin-dna-writing-styles](#admin-dna-writing-styles) (9 endpoints)
- [admin-document-templates](#admin-document-templates) (8 endpoints)
- [admin-entitlements](#admin-entitlements) (11 endpoints)
- [admin-frontend-pipeline-config](#admin-frontend-pipeline-config) (2 endpoints)
- [admin-global-settings](#admin-global-settings) (8 endpoints)
- [admin-guardrail-availability](#admin-guardrail-availability) (4 endpoints)
- [admin-harness](#admin-harness) (29 endpoints)
- [admin-inference-engines](#admin-inference-engines) (3 endpoints)
- [admin-knowledge](#admin-knowledge) (5 endpoints)
- [admin-mcp-servers](#admin-mcp-servers) (5 endpoints)
- [admin-nlp-task-instructions](#admin-nlp-task-instructions) (2 endpoints)
- [admin-notifications](#admin-notifications) (4 endpoints)
- [admin-platform-metrics](#admin-platform-metrics) (3 endpoints)
- [admin-prompt-templates](#admin-prompt-templates) (16 endpoints)
- [admin-provider-connections](#admin-provider-connections) (8 endpoints)
- [admin-pstudio](#admin-pstudio) (1 endpoints)
- [admin-queues](#admin-queues) (12 endpoints)
- [admin-rate-limit](#admin-rate-limit) (13 endpoints)
- [admin-rbac-policies](#admin-rbac-policies) (7 endpoints)
- [admin-rbac-roles](#admin-rbac-roles) (10 endpoints)
- [admin-resource-subscriptions](#admin-resource-subscriptions) (6 endpoints)
- [admin-schedulers](#admin-schedulers) (5 endpoints)
- [admin-security-policy](#admin-security-policy) (2 endpoints)
- [admin-service-accounts](#admin-service-accounts) (7 endpoints)
- [admin-service-releases](#admin-service-releases) (3 endpoints)
- [admin-settings-catalog](#admin-settings-catalog) (2 endpoints)
- [admin-settings-features](#admin-settings-features) (3 endpoints)
- [admin-settings-registry](#admin-settings-registry) (3 endpoints)
- [admin-storage-config](#admin-storage-config) (6 endpoints)
- [admin-stt](#admin-stt) (4 endpoints)
- [admin-tenant-idp-config](#admin-tenant-idp-config) (8 endpoints)
- [admin-tenants](#admin-tenants) (18 endpoints)
- [admin-transcription-jobs](#admin-transcription-jobs) (3 endpoints)
- [admin-usage](#admin-usage) (4 endpoints)
- [admin-user-departments](#admin-user-departments) (4 endpoints)
- [admin-users](#admin-users) (22 endpoints)
- [admin-webhooks](#admin-webhooks) (7 endpoints)
- [admin-workflow-assignments](#admin-workflow-assignments) (5 endpoints)
- [admin-workflow-definitions](#admin-workflow-definitions) (20 endpoints)
- [admin-workflow-invariant-rules](#admin-workflow-invariant-rules) (5 endpoints)
- [admin-workflow-nodes](#admin-workflow-nodes) (1 endpoints)
- [admin-workflow-runs](#admin-workflow-runs) (5 endpoints)
- [admin-workflow-sandbox-runs](#admin-workflow-sandbox-runs) (4 endpoints)
- [admin-workflow-test-fixtures](#admin-workflow-test-fixtures) (5 endpoints)
- [agents](#agents) (5 endpoints)
- [ai-inference](#ai-inference) (5 endpoints)
- [audio-pipelines](#audio-pipelines) (3 endpoints)
- [auth](#auth) (16 endpoints)
- [billing](#billing) (3 endpoints)
- [changelog](#changelog) (3 endpoints)
- [consultation-jobs](#consultation-jobs) (3 endpoints)
- [consultations](#consultations) (58 endpoints)
- [dna-writing-styles](#dna-writing-styles) (16 endpoints)
- [entitlements](#entitlements) (1 endpoints)
- [health](#health) (6 endpoints)
- [monitoring](#monitoring) (4 endpoints)
- [prompt-templates](#prompt-templates) (5 endpoints)
- [rbac-permission-check](#rbac-permission-check) (3 endpoints)
- [service-account-auth](#service-account-auth) (1 endpoints)
- [speech](#speech) (2 endpoints)
- [storage](#storage) (10 endpoints)
- [stt-compat](#stt-compat) (3 endpoints)
- [tenant](#tenant) (5 endpoints)
- [tenant-storage](#tenant-storage) (13 endpoints)
- [tenant-storage-keys](#tenant-storage-keys) (3 endpoints)
- [text](#text) (6 endpoints)
- [text-compat](#text-compat) (2 endpoints)
- [transcription-jobs](#transcription-jobs) (20 endpoints)
- [usage](#usage) (2 endpoints)
- [user](#user) (6 endpoints)
- [voice-profile](#voice-profile) (6 endpoints)
- [workflows](#workflows) (13 endpoints)

---

## Prometheus

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/metrics` | PrometheusController_index |

## admin-agent-assignments

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/agent-assignments` | List the caller tenant’s agent assignments (plus SYSTEM’s platform defaults), optionally by task |
| `PATCH` | `/api/v1/admin/agent-assignments` | Re-assign one tier (If-Match OCC) |
| `POST` | `/api/v1/admin/agent-assignments` | Create the assignment for one (scope, scopeId, task) tier |
| `DELETE` | `/api/v1/admin/agent-assignments/{id}` | Remove one assignment — the tier reverts to inheriting (WORM change row appended) |
| `GET` | `/api/v1/admin/agent-assignments/{id}` | Get one agent assignment |

## admin-agent-promotions

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/agent-promotions` | List promotions INTO the working tenant |
| `POST` | `/api/v1/admin/agent-promotions` | Promote a workflow definition version from one tenant to another |
| `GET` | `/api/v1/admin/agent-promotions/{id}` | Get one promotion record |

## admin-agent-trajectory

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/agent-trajectory/metrics/generation` | Aggregate GenerationStats across LLM_CALL trajectory steps (TTFT median/p95, tok/s avg, stop-reason histogram). Bounded window ... |
| `GET` | `/api/v1/admin/agent-trajectory/sessions` | List distinct agentic working sessions (grouped by kind + sessionId + runId) with step counts + first/last timestamps |
| `GET` | `/api/v1/admin/agent-trajectory/sessions/{sessionId}/steps` | List the ordered steps for a session (seq asc), keyset-paginated. Cross-tenant / nonexistent → 404 (never 403). |

## admin-agentic

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/agentic/instructions` | The effective agentic instruction set for a tenant (prompt tier, judge pin, thresholds, safety criteria) |

## admin-agents

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/agents` | List the caller tenant’s agent versions |
| `POST` | `/api/v1/admin/agents` | Create a new DRAFT agent version for the caller tenant |
| `POST` | `/api/v1/admin/agents/import` | Import an exported agent bundle as a DRAFT in the caller tenant |
| `GET` | `/api/v1/admin/agents/lineages` | List the caller tenant’s agent LINEAGES (one row per slug) |
| `POST` | `/api/v1/admin/agents/promote-to-system` | Promote an agent from the Global build tenant into the SYSTEM reference set |
| `DELETE` | `/api/v1/admin/agents/{id}` | Soft-delete an agent version (refused for the ACTIVE published version — deprecate it first) |
| `GET` | `/api/v1/admin/agents/{id}` | Get one agent version (own or SYSTEM template) |
| `PATCH` | `/api/v1/admin/agents/{id}` | Update a DRAFT/VALIDATED agent version (If-Match OCC) |
| `POST` | `/api/v1/admin/agents/{id}/activate` | Make an already-PUBLISHED version the ACTIVE one for its slug (rollback) |
| `POST` | `/api/v1/admin/agents/{id}/deprecate` | Deprecate a PUBLISHED version: it stops being served (isActive false) and stays immutable |
| `POST` | `/api/v1/admin/agents/{id}/publish` | Publish an agent version (fails closed) |
| `POST` | `/api/v1/admin/agents/{id}/test` | Assemble (and optionally run) a DRAFT agent without publishing it |
| `POST` | `/api/v1/admin/agents/{id}/test/finalize` | Read a finished draft-test generation back from TEXT and record its usage |
| `POST` | `/api/v1/admin/agents/{id}/validate` | Run every publish-time check; stores the report and advances to VALIDATED when nothing blocks |
| `GET` | `/api/v1/admin/agents/{id}/versions` | Every version of this agent’s lineage, newest first |
| `POST` | `/api/v1/admin/agents/{id}/versions` | Branch a new DRAFT version from ANY version (own lineage), or a new tenant lineage from a SYSTEM template |
| `POST` | `/api/v1/admin/agents/{slug}/clone` | Clone a SYSTEM template or any visible agent into a NEW lineage |
| `GET` | `/api/v1/admin/agents/{slug}/export` | Export one agent version as a portable JSON bundle |
| `POST` | `/api/v1/admin/agents/{slug}/sync` | Push one of the caller’s own agents into other tenants the caller manages |

## admin-ai-models

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/ai-models` | Retrieving multiple ModelResponses |
| `POST` | `/api/v1/admin/ai-models` | Creating a ModelResponse |
| `GET` | `/api/v1/admin/ai-models/catalogue` | The model catalogue this tenant may bind, in picker order |
| `GET` | `/api/v1/admin/ai-models/discovery` | Merge the AI model registry with the live engine listings |
| `POST` | `/api/v1/admin/ai-models/discovery/register` | DEPRECATED (TASK-860, removed in R3) — register a discovered model |
| `GET` | `/api/v1/admin/ai-models/inventory` | Read the last model-bucket inventory report |
| `POST` | `/api/v1/admin/ai-models/inventory` | Run the model-bucket inventory |
| `GET` | `/api/v1/admin/ai-models/list` | List the SYSTEM model registry as one paginated page. The whole query object is bound (`search`, `searchFields`, `filters`, `so... |
| `GET` | `/api/v1/admin/ai-models/slug/{slug}` | Retrieving a single ModelResponse by slug |
| `DELETE` | `/api/v1/admin/ai-models/{id}` | Deleting a ModelResponse by id |
| `GET` | `/api/v1/admin/ai-models/{id}` | Retrieving a single ModelResponse by id |
| `PATCH` | `/api/v1/admin/ai-models/{id}` | Updating a ModelResponse by id |
| `GET` | `/api/v1/admin/ai-models/{id}/download` | Poll the status of the most recent download job for this model. |
| `POST` | `/api/v1/admin/ai-models/{id}/download` | Publish this model's weights into the hope-models bucket (async). |
| `PATCH` | `/api/v1/admin/ai-models/{id}/platform-default` | Elect this row as the platform default for one or more tasks |

## admin-ai-routing-policies

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/routing-policies` | List every routing-policy revision owned by one tenant |
| `POST` | `/api/v1/admin/routing-policies` | Author a new routing-policy revision (DRAFT) |
| `GET` | `/api/v1/admin/routing-policies/effective` | Resolve what actually serves a (tenant, task) right now |
| `GET` | `/api/v1/admin/routing-policies/export` | Export provider configurations as portable JSON |
| `POST` | `/api/v1/admin/routing-policies/import` | Import provider configurations from an exported artifact |
| `DELETE` | `/api/v1/admin/routing-policies/{id}` | Soft-delete a routing-policy revision |
| `GET` | `/api/v1/admin/routing-policies/{id}` | Get one routing-policy revision |
| `PATCH` | `/api/v1/admin/routing-policies/{id}` | Update a routing-policy revision under optimistic concurrency |
| `POST` | `/api/v1/admin/routing-policies/{id}/activate` | Promote a DRAFT revision to ACTIVE |
| `POST` | `/api/v1/admin/routing-policies/{id}/default` | Elect this configuration as the default for its task |
| `POST` | `/api/v1/admin/routing-policies/{id}/promote` | Copy a configuration to another tenant |

## admin-ai-services

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/ai-services/guardrail/config` | Guardrail read-only configuration: medical-validation engine settings + supported analysis types. |
| `GET` | `/api/v1/admin/ai-services/guardrail/status` | Guardrail service health (proxied /api/health): LLM engine, GLiNER, and Redis component checks. |
| `GET` | `/api/v1/admin/ai-services/mlflow/experiments` | Search MLflow experiments |
| `GET` | `/api/v1/admin/ai-services/mlflow/model-versions` | Search MLflow model versions |
| `GET` | `/api/v1/admin/ai-services/mlflow/registered-models` | Search the MLflow model registry |
| `GET` | `/api/v1/admin/ai-services/mlflow/status` | MLflow tracking-server reachability, version and framing posture |
| `GET` | `/api/v1/admin/ai-services/nlp/status` | NLP service health (proxied /api/v1/health): per-model component checks with load status. |
| `GET` | `/api/v1/admin/ai-services/readiness` | Inference readiness — the platform’s last observation of every engine, service and model |
| `POST` | `/api/v1/admin/ai-services/readiness/refresh` | Take one readiness observation now |

## admin-allowed-origins

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/allowed-origins` | List the caller tenant's allowed-origin rows |
| `POST` | `/api/v1/admin/allowed-origins` | Register a new allowed origin |
| `GET` | `/api/v1/admin/allowed-origins/posture` | Report whether origin enforcement is currently ON, platform-wide (FR-4). |
| `DELETE` | `/api/v1/admin/allowed-origins/{id}` | Soft-delete an allowed-origin row |
| `GET` | `/api/v1/admin/allowed-origins/{id}` | Get one allowed-origin row by id |
| `PATCH` | `/api/v1/admin/allowed-origins/{id}` | Update an allowed-origin row under optimistic concurrency |

## admin-api-keys

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/api-keys` | Retrieving multiple ApiKeyResponses |
| `POST` | `/api/v1/admin/api-keys` | AUTH-NOTE: `@CanCreate('ApiKey')` UNDERSTATES the real gate. `ApiKeyService` additionally enforces a privilege CEILING on the r... |
| `GET` | `/api/v1/admin/api-keys/scopes` | List available API key scopes |
| `DELETE` | `/api/v1/admin/api-keys/{id}` | Deleting a ApiKeyResponse by id |
| `GET` | `/api/v1/admin/api-keys/{id}` | Retrieving a single ApiKeyResponse by id |
| `PATCH` | `/api/v1/admin/api-keys/{id}` | AUTH-NOTE: `@CanUpdate('ApiKey')` UNDERSTATES the real gate — the same scope ceiling as `create` above, applied to the WIDENING... |
| `POST` | `/api/v1/admin/api-keys/{id}/revoke` | Creating a ApiKeyResponse by id |
| `POST` | `/api/v1/admin/api-keys/{id}/rotate` | Creating a ApiKeyResponse by id |
| `GET` | `/api/v1/admin/api-keys/{id}/usage` | Retrieving a single ApiKeyResponse by id |

## admin-audio-pipelines

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/audio/pipelines` | Retrieving multiple PipelineResponses |
| `POST` | `/api/v1/admin/audio/pipelines` | Creating a PipelineResponse |
| `GET` | `/api/v1/admin/audio/pipelines/list` | Retrieving a single PaginatedPipelineResponse |
| `GET` | `/api/v1/admin/audio/pipelines/slug/{slug}` | Retrieving a single PipelineResponse by slug |
| `POST` | `/api/v1/admin/audio/pipelines/validate` | Creating a PipelineResponse |
| `DELETE` | `/api/v1/admin/audio/pipelines/{id}` | Deleting a PipelineResponse by id |
| `GET` | `/api/v1/admin/audio/pipelines/{id}` | Retrieving a single PipelineResponse by id |
| `PATCH` | `/api/v1/admin/audio/pipelines/{id}` | Updating a PipelineResponse by id |
| `POST` | `/api/v1/admin/audio/pipelines/{id}/assign-tenant` | Assign an ASR pipeline within its tenant |
| `POST` | `/api/v1/admin/audio/pipelines/{id}/clone` | Clone a pipeline into a new editable copy |
| `POST` | `/api/v1/admin/audio/pipelines/{id}/set-default` | Set a pipeline as the tenant default |
| `PATCH` | `/api/v1/admin/audio/pipelines/{id}/toggle` | Enable/disable a pipeline |
| `GET` | `/api/v1/admin/audio/pipelines/{id}/versions` | List config-version snapshots for a pipeline |
| `GET` | `/api/v1/admin/audio/pipelines/{id}/versions/{versionNumber}` | Get one config-version snapshot by version number |

## admin-audit-logs

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/audit-logs` | Fetch all audit logs |
| `GET` | `/api/v1/admin/audit-logs/cursor` | Fetch audit logs (cursor pagination) |
| `GET` | `/api/v1/admin/audit-logs/export` | Export audit logs (csv &#124; xlsx &#124; pdf) |
| `GET` | `/api/v1/admin/audit-logs/resource/{resourceType}/{resourceId}` | Fetch audit logs by resource |
| `GET` | `/api/v1/admin/audit-logs/user/{userId}` | Fetch audit logs by user |
| `GET` | `/api/v1/admin/audit-logs/{id}` | Fetch audit log by ID |

## admin-billing-invoices

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/billing/invoices` | One tenant's invoices, newest period first. |
| `POST` | `/api/v1/admin/billing/invoices/compute-draft` | Compute — or idempotently recompute — the DRAFT invoice for one tenant-month. SUPER_ADMIN only. |
| `GET` | `/api/v1/admin/billing/invoices/spend-status` | Month-to-date SELL-rated overage spend vs the tenant's spend limit (D12). |
| `GET` | `/api/v1/admin/billing/invoices/{id}` | Invoice read model: lines, memos against it, BYOK notional spend. Cross-tenant id → 404. |
| `POST` | `/api/v1/admin/billing/invoices/{id}/adjustments` | Issue a credit/debit memo against a FINALIZED invoice — the only correction path for a closed period. SUPER_ADMIN only. |
| `POST` | `/api/v1/admin/billing/invoices/{id}/finalize` | DRAFT → FINALIZED under If-Match OCC. Immutable after; only once the period has ended. SUPER_ADMIN only. |
| `POST` | `/api/v1/admin/billing/invoices/{id}/void` | DRAFT → VOID under If-Match OCC (one-way; a voided period stays void). SUPER_ADMIN only. |

## admin-billing-rate-card

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/billing/rate-card` | List SELL-plane rate rows (platform card by default; ?tenantId= for a negotiated tenant card). Includes superseded history rows. |
| `POST` | `/api/v1/admin/billing/rate-card` | Create a new open-ended SELL rate row (overage rate or PLAN_FEE). SUPER_ADMIN only. |
| `POST` | `/api/v1/admin/billing/rate-card/{id}/supersede` | Supersede a rate row: close it at the successor's effectiveFrom and insert the successor — atomic, If-Match OCC on the close. S... |

## admin-changelog

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/v1/admin/changelog` | Create a release note (always DRAFT) |
| `GET` | `/api/v1/admin/changelog/{id}` | Read a release note for editing (DRAFT included) |
| `PATCH` | `/api/v1/admin/changelog/{id}` | Edit a release note (If-Match OCC) |
| `POST` | `/api/v1/admin/changelog/{id}/publish` | Publish a release note |

## admin-consent-grants

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/consent-grants` | List consent grants for the caller tenant |
| `POST` | `/api/v1/admin/consent-grants` | Record a consent grant for the caller tenant (clinician/tenant-admin recorded — Q1) |
| `PATCH` | `/api/v1/admin/consent-grants/{id}/revoke` | Revoke a consent grant (If-Match OCC) |

## admin-consultation-context-schemas

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/consultation-context-schemas` | List the caller tenant's consultation context schemas |
| `POST` | `/api/v1/admin/consultation-context-schemas` | Create a DRAFT context schema |
| `DELETE` | `/api/v1/admin/consultation-context-schemas/{id}` | Soft-delete a context schema |
| `GET` | `/api/v1/admin/consultation-context-schemas/{id}` | Get one context schema by id |
| `PATCH` | `/api/v1/admin/consultation-context-schemas/{id}` | Update schema metadata under optimistic concurrency |
| `POST` | `/api/v1/admin/consultation-context-schemas/{id}/pin` | Move the pin to an already-published version |
| `POST` | `/api/v1/admin/consultation-context-schemas/{id}/publish` | Validate a definition, publish it as a new immutable version, and pin it |
| `GET` | `/api/v1/admin/consultation-context-schemas/{id}/usages` | List the workflows and agents bound to a context schema, with a verdict per consumer |
| `GET` | `/api/v1/admin/consultation-context-schemas/{id}/versions` | List the immutable published versions of a context schema, newest first |

## admin-consultations

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/consultations` | Retrieving multiple ConsultationResponses |
| `GET` | `/api/v1/admin/consultations/aggregate` | Server-side, zero-filled new/revisit aggregation over a date range. Scope follows the same model as `list`: a SUPER_ADMIN with ... |
| `GET` | `/api/v1/admin/consultations/{id}` | Retrieving a single ConsultationResponse by id |

## admin-departments

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/departments` | Retrieving multiple DepartmentResponses |
| `POST` | `/api/v1/admin/departments` | Creating a DepartmentResponse |
| `GET` | `/api/v1/admin/departments/code/{code}` | Retrieving a single DepartmentResponse by code |
| `GET` | `/api/v1/admin/departments/roots` | Retrieving multiple DepartmentResponses |
| `DELETE` | `/api/v1/admin/departments/{id}` | Deleting a DepartmentResponse by id |
| `GET` | `/api/v1/admin/departments/{id}` | Retrieving a single DepartmentResponse by id |
| `PATCH` | `/api/v1/admin/departments/{id}` | Updating a DepartmentResponse by id |
| `GET` | `/api/v1/admin/departments/{id}/children` | Retrieving multiple DepartmentResponses by id |
| `PATCH` | `/api/v1/admin/departments/{id}/prompt-config` | Updating a DepartmentResponse by id (prompt config) |
| `GET` | `/api/v1/admin/departments/{id}/users` | List a department's members (users) |

## admin-dna-writing-styles

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/dna-writing-styles` | Retrieving multiple DnaReportResponses |
| `GET` | `/api/v1/admin/dna-writing-styles/dashboard` | DNA aggregate dashboard (users with a style, avg versions, recent usage activity) |
| `DELETE` | `/api/v1/admin/dna-writing-styles/doctor/{doctorId}` | Erase a doctor's entire learned DNA writing-style profile (admin) |
| `GET` | `/api/v1/admin/dna-writing-styles/doctor/{doctorId}` | Latest DNA writing-style report for a doctor (admin cross-user, tenant-scoped PHI-gated) |
| `POST` | `/api/v1/admin/dna-writing-styles/generate/{doctorId}` | Creating a DnaJobResponseDto by doctorId |
| `GET` | `/api/v1/admin/dna-writing-styles/jobs/{jobId}` | Get DNA generation job status |
| `GET` | `/api/v1/admin/dna-writing-styles/jobs/{jobId}/stream` | Stream DNA generation job status via SSE |
| `PATCH` | `/api/v1/admin/dna-writing-styles/{reportId}` | Updating a DnaReportResponse by reportId |
| `GET` | `/api/v1/admin/dna-writing-styles/{reportId}/versions` | Retrieving multiple DnaVersionResponses by reportId |

## admin-document-templates

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/document-templates` | List the caller tenant's document templates |
| `POST` | `/api/v1/admin/document-templates` | Create a DRAFT document template |
| `DELETE` | `/api/v1/admin/document-templates/{id}` | Soft-delete a document template |
| `GET` | `/api/v1/admin/document-templates/{id}` | Get one document template by id |
| `PATCH` | `/api/v1/admin/document-templates/{id}` | Update template metadata under optimistic concurrency |
| `POST` | `/api/v1/admin/document-templates/{id}/pin` | Move the pin to an already-published version |
| `POST` | `/api/v1/admin/document-templates/{id}/publish` | Validate a shape, compile it, publish both as a new immutable version, and pin it |
| `GET` | `/api/v1/admin/document-templates/{id}/versions` | List the immutable published versions of a template, newest first |

## admin-entitlements

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/entitlements/enabled` | Read the global entitlements enforcement kill-switch (Q9). |
| `PUT` | `/api/v1/admin/entitlements/enabled` | Flip the global entitlements enforcement kill-switch (Q9). |
| `GET` | `/api/v1/admin/entitlements/plans` | List the per-plan default entitlement matrix. |
| `GET` | `/api/v1/admin/entitlements/plans/{plan}` | Get a single plan default row. |
| `PATCH` | `/api/v1/admin/entitlements/plans/{plan}` | Edit a plan default row. |
| `GET` | `/api/v1/admin/entitlements/tenants/{tenantId}` | Capability/usage snapshot for ANY tenant (super-admin view). |
| `POST` | `/api/v1/admin/entitlements/tenants/{tenantId}/downgrade` | Downgrade a tenant plan (Q10). Plan change always applies; newest-first soft-disable of overflow rows runs only when enforcemen... |
| `DELETE` | `/api/v1/admin/entitlements/tenants/{tenantId}/override` | Clear a tenant override back to plan inheritance (nulls the row; reversible — never deleted). |
| `GET` | `/api/v1/admin/entitlements/tenants/{tenantId}/override` | Get a tenant's entitlement override (null = inherits the plan default). |
| `PUT` | `/api/v1/admin/entitlements/tenants/{tenantId}/override` | Create-or-update a tenant override ("increase on demand", Q7). |
| `POST` | `/api/v1/admin/entitlements/trial-expiry/run` | Manually run the trial-expiry sweep (Q4): downgrade every expired TRIAL tenant to STARTER, plan-only. |

## admin-frontend-pipeline-config

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/tenant-frontend-config` | Get the tenant's frontend pipeline config (null when not yet configured) |
| `PUT` | `/api/v1/admin/tenant-frontend-config` | Create or update the tenant frontend pipeline config |

## admin-global-settings

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/settings` | Retrieving multiple GlobalSettingResponses |
| `POST` | `/api/v1/admin/settings` | Creating a GlobalSettingResponse |
| `GET` | `/api/v1/admin/settings/tenant/{tenantId}` | List global settings for a specific tenant |
| `DELETE` | `/api/v1/admin/settings/{id}` | Deleting a GlobalSettingResponse by id |
| `GET` | `/api/v1/admin/settings/{id}` | Retrieving a single GlobalSettingResponse by id |
| `PATCH` | `/api/v1/admin/settings/{id}` | Updating a GlobalSettingResponse by id |
| `POST` | `/api/v1/admin/settings/{id}/reveal` | Reveal a secret setting (super-admin, step-up re-auth, audited) |
| `POST` | `/api/v1/admin/settings/{id}/rotate` | Rotate a secret setting (super-admin, step-up re-auth, OCC, audited) |

## admin-guardrail-availability

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/guardrail/availability` | List every tenant guardrail-availability row — SUPER_ADMIN only |
| `GET` | `/api/v1/admin/guardrail/availability/catalogue` | List the selectable guardrail policies — SUPER_ADMIN only |
| `GET` | `/api/v1/admin/guardrail/availability/{tenantId}` | Read one tenant's guardrail availability — SUPER_ADMIN only |
| `PUT` | `/api/v1/admin/guardrail/availability/{tenantId}` | Replace one tenant's guardrail availability under optimistic concurrency — SUPER_ADMIN only |

## admin-harness

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/harness/audit` | List the WORM audit trail (newest-first) + the chain-integrity verdict |
| `GET` | `/api/v1/admin/harness/edit-burden` | Derived clinician edit-burden telemetry for one consultation (edit distance, deferral rate, time-to-sign) |
| `GET` | `/api/v1/admin/harness/eval-runs` | List eval runs (newest-first) |
| `GET` | `/api/v1/admin/harness/eval-runs/{id}` | Get one eval run with its per-case scores |
| `GET` | `/api/v1/admin/harness/gate-edit-exemplars` | Export gate-edit exemplar candidates for eval regression-corpus review |
| `GET` | `/api/v1/admin/harness/gate-edit-exemplars/fine-tuning-export` | Export the curator-APPROVED gate-edit corpus as a JSONL fine-tuning dataset |
| `PATCH` | `/api/v1/admin/harness/gate-edit-exemplars/{id}/curation` | Record the human curation verdict on one mined gate-edit exemplar |
| `POST` | `/api/v1/admin/harness/gate-edit-exemplars/{id}/promote-to-golden-set` | Promote a curator-APPROVED gate-edit exemplar into a golden case |
| `GET` | `/api/v1/admin/harness/gate-queue` | List consultations awaiting clinician review with SLA/escalation from the effective policy |
| `GET` | `/api/v1/admin/harness/golden-sets` | List golden sets (newest-first) |
| `POST` | `/api/v1/admin/harness/golden-sets` | Create a golden set for the caller tenant |
| `GET` | `/api/v1/admin/harness/golden-sets/{id}` | Get one golden set |
| `GET` | `/api/v1/admin/harness/golden-sets/{id}/cases` | List a golden set's cases — PHI-safe metadata only |
| `POST` | `/api/v1/admin/harness/golden-sets/{id}/cases` | Add a case to a golden set (PHI encrypted at rest, write-only) |
| `POST` | `/api/v1/admin/harness/golden-sets/{id}/run` | Run an eval over a golden set now (synchronous) |
| `GET` | `/api/v1/admin/harness/live/capabilities` | Read which realtime consultation capabilities are live for a tenant (lane source, definition, per-node state) |
| `GET` | `/api/v1/admin/harness/live/config` | Read the live-documentation engine kill-switch (super-admin / global scope) |
| `PATCH` | `/api/v1/admin/harness/live/config` | Toggle the live-documentation engine kill-switch (super-admin / global scope) |
| `GET` | `/api/v1/admin/harness/live/sessions` | List the active live-documentation sessions (PHI-safe stats) for the caller tenant |
| `GET` | `/api/v1/admin/harness/live/sessions/{id}` | Get one live-documentation session's latest PHI-safe stats |
| `GET` | `/api/v1/admin/harness/policy` | Get the caller tenant's effective harness policy (tenant row over global default over code default) |
| `PATCH` | `/api/v1/admin/harness/policy` | Update the caller tenant's harness policy (created on first edit) |
| `GET` | `/api/v1/admin/harness/policy/global` | Get the platform GLOBAL-DEFAULT harness policy (super-admin only) |
| `PATCH` | `/api/v1/admin/harness/policy/global` | Update the platform GLOBAL-DEFAULT harness policy (super-admin only) |
| `GET` | `/api/v1/admin/harness/workflows` | List harness Temporal document workflows (tenant-filtered) |
| `GET` | `/api/v1/admin/harness/workflows/{id}` | Describe one harness workflow (add ?phase=true for the loop phase) |
| `POST` | `/api/v1/admin/harness/workflows/{id}/cancel` | Cancel a harness workflow (graceful). Tenant admins limited to their own tenant. |
| `POST` | `/api/v1/admin/harness/workflows/{id}/signal` | Send a signal to a harness workflow. Tenant admins limited to their own tenant. |
| `POST` | `/api/v1/admin/harness/workflows/{id}/terminate` | Terminate a harness workflow (forceful). Tenant admins limited to their own tenant. |

## admin-inference-engines

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/v1/admin/inference-engines/lm-studio/models/{identifier}/unload` | Evict one loaded instance (ADVISORY — JIT reloads it) |
| `POST` | `/api/v1/admin/inference-engines/lm-studio/models/{modelKey}/load` | Resolve a serving profile for one model and load it |
| `GET` | `/api/v1/admin/inference-engines/lm-studio/runtime` | Read what the LM Studio engine is currently serving, and on what VRAM |

## admin-knowledge

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/knowledge/documents` | Paginated list of the caller tenant's institutional-knowledge documents |
| `DELETE` | `/api/v1/admin/knowledge/documents/{id}` | Soft-delete a document and remove its vectors from Qdrant |
| `GET` | `/api/v1/admin/knowledge/documents/{id}` | Get one knowledge document by id |
| `POST` | `/api/v1/admin/knowledge/documents/{id}/archive` | Archive a document (status -> ARCHIVED) |
| `GET` | `/api/v1/admin/knowledge/documents/{id}/chunks` | Paginated, decrypted chunk content for one document, ordered by chunkIndex |

## admin-mcp-servers

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/mcp-servers` | List registered MCP external-tools servers (registry read — backs the console "Tools & MCP" screen) |
| `POST` | `/api/v1/admin/mcp-servers` | Register a new MCP server (own tenant; the SYSTEM registry is GLOBAL-ADMIN only) |
| `DELETE` | `/api/v1/admin/mcp-servers/{id}` | Soft-delete a registered MCP server under optimistic concurrency (own tenant; SYSTEM rows GLOBAL-ADMIN only) |
| `GET` | `/api/v1/admin/mcp-servers/{id}` | Get one registered MCP server (registry read) |
| `PATCH` | `/api/v1/admin/mcp-servers/{id}` | Update a registered MCP server under optimistic concurrency (own tenant; SYSTEM rows GLOBAL-ADMIN only) |

## admin-nlp-task-instructions

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/nlp-task-instructions/row` | Get the raw, editable TenantNlpTaskInstructions row for a (tenant, taskKey) |
| `PUT` | `/api/v1/admin/nlp-task-instructions/row` | Create or update the (tenant, taskKey) instructions row under optimistic concurrency |

## admin-notifications

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/notifications` | List notifications (tenant-scoped; SUPER_ADMIN sees all, or targets one via ?tenantId=) |
| `DELETE` | `/api/v1/admin/notifications/{id}` | Soft-delete a notification |
| `GET` | `/api/v1/admin/notifications/{id}` | Get one notification |
| `PATCH` | `/api/v1/admin/notifications/{id}` | Update a notification (sparse patch, e.g. mark read) |

## admin-platform-metrics

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/platform/consumption` | Consumption / usage roll-up (transcription minutes, summaries-24h, storage, consultations) |
| `GET` | `/api/v1/admin/platform/metrics` | Platform runtime metrics (requests/min, error rate, P95, sockets, models, series) |
| `GET` | `/api/v1/admin/platform/sockets` | Open WebSocket count (live, multi-instance aggregate) |

## admin-prompt-templates

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/prompt-templates` | Retrieving multiple PromptTemplateResponses |
| `POST` | `/api/v1/admin/prompt-templates` | Creating a PromptTemplateResponse |
| `GET` | `/api/v1/admin/prompt-templates/analytics/usage` | Usage analytics grouped by department / doctor / day |
| `POST` | `/api/v1/admin/prompt-templates/assign-department` | Assign prompt templates to a department |
| `GET` | `/api/v1/admin/prompt-templates/usage-records` | Paginated prompt run history (PromptUsageRecord rows), newest first |
| `DELETE` | `/api/v1/admin/prompt-templates/{id}` | Deleting a PromptTemplateResponse by id |
| `GET` | `/api/v1/admin/prompt-templates/{id}` | Retrieving a single PromptTemplateResponse by id |
| `PATCH` | `/api/v1/admin/prompt-templates/{id}` | Updating a PromptTemplateResponse by id |
| `POST` | `/api/v1/admin/prompt-templates/{id}/approve` | Approve a prompt template for clinical use |
| `POST` | `/api/v1/admin/prompt-templates/{id}/test` | Creating a PromptTestAckResponse by id |
| `POST` | `/api/v1/admin/prompt-templates/{id}/test/finalize` | Creating a PromptTestResultResponse by id |
| `GET` | `/api/v1/admin/prompt-templates/{id}/usage` | Get usage statistics for a prompt template |
| `GET` | `/api/v1/admin/prompt-templates/{id}/versions` | Retrieving multiple PromptVersionResponses by id |
| `GET` | `/api/v1/admin/prompt-templates/{id}/versions/{from}/diff/{to}` | Diff two versions of a prompt template (server-side) |
| `GET` | `/api/v1/admin/prompt-templates/{id}/versions/{versionNumber}` | Retrieving a single PromptVersionResponse by id and versionNumber |
| `POST` | `/api/v1/admin/prompt-templates/{id}/versions/{versionNumber}/activate` | Creating a PromptTemplateResponse by id and versionNumber |

## admin-provider-connections

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/providers/{service}` | List provider connections for one service and the scoped tenant (keys never returned). |
| `GET` | `/api/v1/admin/providers/{service}/platform-defaults` | The platform defaults this tenant inherits for one service — read-only, masked. |
| `DELETE` | `/api/v1/admin/providers/{service}/{slug}` | Soft-delete one provider connection. |
| `GET` | `/api/v1/admin/providers/{service}/{slug}` | Read one provider connection (key never returned; placeholder when absent). |
| `PUT` | `/api/v1/admin/providers/{service}/{slug}` | Create or update one provider connection. |
| `PUT` | `/api/v1/admin/providers/{service}/{slug}/models` | Declare the models this tenant's connection serves. |
| `POST` | `/api/v1/admin/providers/{service}/{slug}/reset` | Reset one built-in provider connection to its platform default (super admin only). |
| `POST` | `/api/v1/admin/providers/{service}/{slug}/test` | Test a provider connection against the live vendor (ephemeral — never persisted). |

## admin-pstudio

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/pstudio/status` | Report whether the Prisma Studio shell is enabled in this environment. |

## admin-queues

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/queues` | List every registered queue with its stats (counts, paused flag, worker count). |
| `GET` | `/api/v1/admin/queues/health/redis` | Redis connection health for the queue infrastructure (PING latency + INFO stats). Never errors. |
| `GET` | `/api/v1/admin/queues/{queueName}` | Get stats for a single queue. |
| `POST` | `/api/v1/admin/queues/{queueName}/clean` | Clean finished (completed/failed) jobs older than a grace period. |
| `GET` | `/api/v1/admin/queues/{queueName}/jobs` | List jobs in a queue (paginated, optionally status/name filtered). |
| `POST` | `/api/v1/admin/queues/{queueName}/jobs/bulk` | Apply a bulk retry/remove action to a set of job ids. |
| `DELETE` | `/api/v1/admin/queues/{queueName}/jobs/{jobId}` | Remove a job from the queue. |
| `GET` | `/api/v1/admin/queues/{queueName}/jobs/{jobId}` | Get a single job with PII-redacted data, options, stacktrace. |
| `POST` | `/api/v1/admin/queues/{queueName}/jobs/{jobId}/promote` | Promote a delayed job so it runs immediately. |
| `POST` | `/api/v1/admin/queues/{queueName}/jobs/{jobId}/retry` | Retry a failed job (re-uses the original payload). |
| `POST` | `/api/v1/admin/queues/{queueName}/pause` | Pause a queue (stops processing new jobs). |
| `POST` | `/api/v1/admin/queues/{queueName}/resume` | Resume a paused queue. |

## admin-rate-limit

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/rate-limit` | Get the effective rate-limit policy (global flag, tier baselines, known-route overrides). |
| `PUT` | `/api/v1/admin/rate-limit/enabled` | Flip the global rate-limit kill-switch. |
| `GET` | `/api/v1/admin/rate-limit/explain` | Explain how a rate limit resolves for one tenant + route. |
| `GET` | `/api/v1/admin/rate-limit/plans` | List each subscription plan’s rate limit. |
| `PATCH` | `/api/v1/admin/rate-limit/plans/{plan}` | Set a subscription plan’s rate limit. |
| `GET` | `/api/v1/admin/rate-limit/routes` | List every gateway route, for picking a rule target. |
| `PUT` | `/api/v1/admin/rate-limit/routes/{routeId}` | Update a per-endpoint override for a known throttled route (e.g. auth.login). |
| `GET` | `/api/v1/admin/rate-limit/rules` | List rate-limit rules. |
| `POST` | `/api/v1/admin/rate-limit/rules` | Create a rate-limit rule. |
| `DELETE` | `/api/v1/admin/rate-limit/rules/{id}` | Delete a rate-limit rule. |
| `GET` | `/api/v1/admin/rate-limit/rules/{id}` | Get one rate-limit rule. |
| `PATCH` | `/api/v1/admin/rate-limit/rules/{id}` | Update a rate-limit rule. |
| `PUT` | `/api/v1/admin/rate-limit/tiers/{tier}` | Update a tier baseline (default &#124; strict &#124; heavy &#124; relaxed). |

## admin-rbac-policies

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/rbac/policies` | List all policies |
| `POST` | `/api/v1/admin/rbac/policies` | Create a new policy |
| `POST` | `/api/v1/admin/rbac/policies/validate` | Validate policy rules |
| `DELETE` | `/api/v1/admin/rbac/policies/{id}` | Delete a policy (requires break-glass confirmation) |
| `GET` | `/api/v1/admin/rbac/policies/{id}` | Get policy by ID |
| `PATCH` | `/api/v1/admin/rbac/policies/{id}` | Partially update a policy |
| `PUT` | `/api/v1/admin/rbac/policies/{id}` | Update a policy |

## admin-rbac-roles

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/rbac/roles` | List all roles |
| `POST` | `/api/v1/admin/rbac/roles` | Create a new role |
| `DELETE` | `/api/v1/admin/rbac/roles/{id}` | Delete a role (requires break-glass confirmation) |
| `GET` | `/api/v1/admin/rbac/roles/{id}` | Get role by ID |
| `PATCH` | `/api/v1/admin/rbac/roles/{id}` | Partially update a role |
| `PUT` | `/api/v1/admin/rbac/roles/{id}` | Update a role |
| `POST` | `/api/v1/admin/rbac/roles/{id}/clone` | Clone a role (SYSTEM or CUSTOM) into a new CUSTOM role, copying its policies |
| `GET` | `/api/v1/admin/rbac/roles/{id}/members` | List users assigned this role (paginated, tenant-scoped) |
| `DELETE` | `/api/v1/admin/rbac/roles/{roleId}/policies/{policyId}` | Remove a policy from a role (requires break-glass confirmation) |
| `POST` | `/api/v1/admin/rbac/roles/{roleId}/policies/{policyId}` | Assign a policy to a role |

## admin-resource-subscriptions

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/resource-subscriptions` | List resource subscriptions (tenant-scoped) |
| `POST` | `/api/v1/admin/resource-subscriptions` | Create a resource subscription |
| `DELETE` | `/api/v1/admin/resource-subscriptions/{id}` | Soft-delete a resource subscription |
| `GET` | `/api/v1/admin/resource-subscriptions/{id}` | Get one resource subscription |
| `PATCH` | `/api/v1/admin/resource-subscriptions/{id}` | Update a resource subscription (sparse patch) |
| `POST` | `/api/v1/admin/resource-subscriptions/{id}/toggle` | Toggle a subscription ENABLED↔DISABLED |

## admin-schedulers

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/schedulers` | List all schedulers (static @Cron + dynamic) with cron/interval/run metadata. |
| `PATCH` | `/api/v1/admin/schedulers/{name}/cron` | Update a dynamic scheduler cron expression (static schedulers are rejected). |
| `POST` | `/api/v1/admin/schedulers/{name}/pause` | Pause (stop) a running cron scheduler. |
| `POST` | `/api/v1/admin/schedulers/{name}/resume` | Resume (start) a paused cron scheduler. |
| `PATCH` | `/api/v1/admin/schedulers/{name}/toggle` | Enable/disable a dynamic scheduler (static schedulers are rejected). |

## admin-security-policy

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/security/policy` | Read the platform credential policy. |
| `PUT` | `/api/v1/admin/security/policy` | Update the platform credential policy (partial). |

## admin-service-accounts

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/service-accounts` | List service accounts in scope |
| `POST` | `/api/v1/admin/service-accounts` | Issue a service account (SUPER_ADMIN only) |
| `GET` | `/api/v1/admin/service-accounts/scopes` | List available svc:* service-account scopes |
| `DELETE` | `/api/v1/admin/service-accounts/{id}` | Revoke a service account (SUPER_ADMIN only) |
| `GET` | `/api/v1/admin/service-accounts/{id}` | Read one service account. Never returns credential material. |
| `PATCH` | `/api/v1/admin/service-accounts/{id}` | Update a service account (SUPER_ADMIN only) |
| `POST` | `/api/v1/admin/service-accounts/{id}/rotate` | Rotate the client secret (SUPER_ADMIN only) |

## admin-service-releases

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/service-releases` | Release history across all services, newest build first |
| `GET` | `/api/v1/admin/service-releases/current` | What is running right now, one row per service |
| `GET` | `/api/v1/admin/service-releases/{serviceName}/history` | Release timeline for one service, newest first |

## admin-settings-catalog

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/settings/catalog` | List the capability/settings catalog (RBAC-filtered metadata). |
| `GET` | `/api/v1/admin/settings/effective` | Resolve the effective value of one non-secret setting for a context (with cascade trace). |

## admin-settings-features

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/settings/features/effective` | Resolve every feature-availability gate for the calling context. |
| `GET` | `/api/v1/admin/settings/features/matrix` | The cross-tenant feature matrix: the platform default beside every tenant’s override. |
| `PUT` | `/api/v1/admin/settings/features/matrix` | Apply a batch of feature-matrix edits. |

## admin-settings-registry

| Method | Path | Summary / Description |
|:---|:---|:---|
| `DELETE` | `/api/v1/admin/settings/registry/{key}` | Reset one TENANT override so the key resumes inheriting the platform default. |
| `GET` | `/api/v1/admin/settings/registry/{key}` | Read one registry setting: its descriptor metadata plus the effective value and cascade trace. |
| `PUT` | `/api/v1/admin/settings/registry/{key}` | Write one registry setting through the single descriptor-driven enforcement point. |

## admin-storage-config

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/tenants/storage/config` | List storage configs for the current tenant (default + per-bucket overrides) |
| `PUT` | `/api/v1/admin/tenants/storage/config` | Create or update a storage config (keyed by bucketId; omit for the tenant default) |
| `GET` | `/api/v1/admin/tenants/storage/config/effective` | Resolve the effective config for a bucket (per-bucket override → tenant default → SYSTEM default) |
| `GET` | `/api/v1/admin/tenants/storage/config/platform` | Read the platform-default storage config (SYSTEM row) — SUPER_ADMIN only |
| `PUT` | `/api/v1/admin/tenants/storage/config/platform` | Create or update the platform-default storage config under optimistic concurrency — SUPER_ADMIN only |
| `DELETE` | `/api/v1/admin/tenants/storage/config/{id}` | Delete a storage config (reverts that scope to the next-broader config / global) |

## admin-stt

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/stt-config` | Resolve the effective STT fallback spec for a tenant (tenant row over the SYSTEM default) |
| `GET` | `/api/v1/admin/stt-config/fallback-candidates` | List the enabled, cloud-engine-backed pipelines a tenant may set as its fallback |
| `GET` | `/api/v1/admin/stt-config/row` | Get the raw, editable STT config row for a tenant |
| `PUT` | `/api/v1/admin/stt-config/row` | Create or update the tenant STT fallback row under optimistic concurrency |

## admin-tenant-idp-config

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/tenant-idp-config` | List a tenant's configured external identity providers |
| `POST` | `/api/v1/admin/tenant-idp-config` | Configure a new external OIDC identity provider (starts DRAFT — D7, no self-lockout) |
| `DELETE` | `/api/v1/admin/tenant-idp-config/{id}` | Remove an identity provider config |
| `GET` | `/api/v1/admin/tenant-idp-config/{id}` | Get one identity provider config |
| `PUT` | `/api/v1/admin/tenant-idp-config/{id}` | Update an identity provider config under optimistic concurrency |
| `PUT` | `/api/v1/admin/tenant-idp-config/{id}/directory-credentials` | Seal a directory-API credential bundle for admin-triggered sync (P3) |
| `POST` | `/api/v1/admin/tenant-idp-config/{id}/sync` | Bulk-pull the provider's directory (MS Graph / Google) and pre-provision users (P3) |
| `POST` | `/api/v1/admin/tenant-idp-config/{id}/test` | Test connection — OIDC discovery + client construction (D7) |

## admin-tenants

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/tenants` | Retrieving multiple TenantResponses |
| `POST` | `/api/v1/admin/tenants` | Creating a TenantResponse |
| `GET` | `/api/v1/admin/tenants/code-name/{codeName}` | Retrieving a single TenantResponse by code-name |
| `GET` | `/api/v1/admin/tenants/configs/{identifier}` | Retrieving multiple PaginatedTenantConfigResponses by identifier |
| `PATCH` | `/api/v1/admin/tenants/configs/{identifier}` | Updating a PaginatedTenantConfigResponse by identifier |
| `POST` | `/api/v1/admin/tenants/provision` | Creating a TenantProvisionResponse |
| `GET` | `/api/v1/admin/tenants/user/{userId}` | Retrieving multiple TenantResponses by createdByUserId |
| `DELETE` | `/api/v1/admin/tenants/{id}` | Deleting a TenantResponse by id |
| `GET` | `/api/v1/admin/tenants/{id}` | Retrieving a single TenantResponse by id |
| `PATCH` | `/api/v1/admin/tenants/{id}` | Updating a TenantResponse by id |
| `POST` | `/api/v1/admin/tenants/{id}/archive` | Archive a tenant (recoverable cold state) |
| `POST` | `/api/v1/admin/tenants/{id}/pipelines/resync` | Resync a tenant's ASR pipeline catalog against the SYSTEM templates |
| `POST` | `/api/v1/admin/tenants/{id}/reference-set/sync` | Re-provision a tenant from the platform's SYSTEM reference set |
| `POST` | `/api/v1/admin/tenants/{id}/restore` | Restore a suspended/archived tenant to ENABLED |
| `POST` | `/api/v1/admin/tenants/{id}/suspend` | Suspend a tenant (reversible operator hold) |
| `GET` | `/api/v1/admin/tenants/{id}/tags` | Read a tenant's tags |
| `PUT` | `/api/v1/admin/tenants/{id}/tags` | Replace a tenant's full tag set (idempotent set-semantics) |
| `GET` | `/api/v1/admin/tenants/{id}/usage` | Get tenant usage statistics |

## admin-transcription-jobs

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/audio/transcription-jobs` | List ALL transcription jobs in the tenant (paginated) |
| `GET` | `/api/v1/admin/audio/transcription-jobs/stats` | Get tenant-wide transcription job status counts |
| `GET` | `/api/v1/admin/audio/transcription-jobs/status/{status}` | Get tenant-wide transcription jobs by status |

## admin-usage

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/usage/cost-per-encounter` | p50/p90/p99 + count of the Σ INTERNAL-basis cost per consultation over a billing period. |
| `GET` | `/api/v1/admin/usage/summary` | Units + rated cost per capability x provider x model for a billing period. BYOK notional split out. |
| `GET` | `/api/v1/admin/usage/timeseries` | Bounded-range rollup timeseries for one capability x unit (max 92 days daily / 72h hourly). |
| `GET` | `/api/v1/admin/usage/top-tenants` | SUPER_ADMIN-only cross-tenant top-N by rollup cost. Every other route on this controller is tenant-scoped; this one is not. |

## admin-user-departments

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/users/{id}/departments` | List a user's department assignments (tenant-scoped) |
| `POST` | `/api/v1/admin/users/{id}/departments` | Assign a user to a department |
| `DELETE` | `/api/v1/admin/users/{id}/departments/{assignmentId}` | Unassign a user from a department (soft delete) |
| `PATCH` | `/api/v1/admin/users/{id}/departments/{assignmentId}` | Update a user-department assignment (e.g. toggle primary) |

## admin-users

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/users` | Retrieving multiple UserResponses |
| `POST` | `/api/v1/admin/users` | Creating a UserResponse |
| `DELETE` | `/api/v1/admin/users/bulk` | Delete many users in one call (partial-failure envelope) |
| `POST` | `/api/v1/admin/users/bulk-actions` | Apply a bulk action (enable/disable/delete/assign-departments/assign-role) to many users |
| `GET` | `/api/v1/admin/users/export` | Export users (csv &#124; xlsx &#124; pdf) |
| `GET` | `/api/v1/admin/users/tenant/{tenantId}` | Retrieving multiple UserResponses by tenantId |
| `DELETE` | `/api/v1/admin/users/{id}` | Deleting a UserResponse by id |
| `GET` | `/api/v1/admin/users/{id}` | Retrieving a single UserResponse by id |
| `PATCH` | `/api/v1/admin/users/{id}` | Updating a UserResponse by id |
| `GET` | `/api/v1/admin/users/{id}/api-keys` | Retrieving multiple PaginatedApiKeyResponses by userId |
| `PATCH` | `/api/v1/admin/users/{id}/departments` | Set a user's department memberships (bulk reconcile) |
| `POST` | `/api/v1/admin/users/{id}/impersonate` | Impersonate a user (super-admin only, time-boxed, audited) |
| `GET` | `/api/v1/admin/users/{id}/profile` | Get a user's profile (admin) |
| `PATCH` | `/api/v1/admin/users/{id}/profile` | Create or update a user's profile, incl. preferred prompt template (admin) |
| `POST` | `/api/v1/admin/users/{id}/reset-password` | Reset a user password (admin): set a temporary password OR mint an emailed reset link |
| `GET` | `/api/v1/admin/users/{id}/roles` | Retrieving multiple UserRoleAssignmentResponses by userId |
| `POST` | `/api/v1/admin/users/{id}/roles` | Assign a role to a user |
| `DELETE` | `/api/v1/admin/users/{id}/roles/{assignmentId}` | Remove a role assignment from a user |
| `GET` | `/api/v1/admin/users/{id}/settings` | Get all settings for a specific user (admin) |
| `PATCH` | `/api/v1/admin/users/{id}/settings/{namespace}/{key}` | Upsert a setting for a specific user (admin) |
| `PATCH` | `/api/v1/admin/users/{id}/status` | Updating a UserResponse by id (enable/disable) |
| `GET` | `/api/v1/admin/users/{id}/voice-profiles` | List a user's enrolled voice profiles (admin, read-only) |

## admin-webhooks

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/webhooks` | List webhooks (tenant-scoped; SUPER_ADMIN sees all, or targets one via ?tenantId=) |
| `POST` | `/api/v1/admin/webhooks` | Create a webhook for the caller tenant. The signing secret is server-generated and returned only once. |
| `DELETE` | `/api/v1/admin/webhooks/{id}` | Soft-delete a webhook |
| `GET` | `/api/v1/admin/webhooks/{id}` | Get one webhook |
| `PATCH` | `/api/v1/admin/webhooks/{id}` | Update a webhook (If-Match OCC) |
| `GET` | `/api/v1/admin/webhooks/{id}/deliveries` | List a webhook's delivery log (newest-first) |
| `POST` | `/api/v1/admin/webhooks/{id}/rotate-secret` | Rotate a webhook signing secret (If-Match OCC) |

## admin-workflow-assignments

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/workflow-assignments` | List the caller tenant’s workflow assignments for one palette |
| `PATCH` | `/api/v1/admin/workflow-assignments` | Re-assign one tier |
| `POST` | `/api/v1/admin/workflow-assignments` | Create the assignment for one (scope, scopeId, palette) tier |
| `DELETE` | `/api/v1/admin/workflow-assignments/{id}` | Remove one assignment — the tier reverts to inheriting |
| `GET` | `/api/v1/admin/workflow-assignments/{id}` | Get one workflow assignment |

## admin-workflow-definitions

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/workflow-definitions` | List the caller tenant’s workflow definition versions |
| `POST` | `/api/v1/admin/workflow-definitions` | Create a new DRAFT workflow definition version for the caller tenant |
| `POST` | `/api/v1/admin/workflow-definitions/import` | Import a workflow bundle as a new DRAFT workflow |
| `GET` | `/api/v1/admin/workflow-definitions/lineages` | List the caller tenant’s workflow LINEAGES (one row per slug) |
| `POST` | `/api/v1/admin/workflow-definitions/promote-to-system` | Promote a workflow from the Global build tenant into the SYSTEM template library |
| `POST` | `/api/v1/admin/workflow-definitions/slug/{slug}/sync` | Sync one workflow version into other tenants you manage |
| `POST` | `/api/v1/admin/workflow-definitions/slug/{slug}/webhook-secret` | Issue or rotate the inbound webhook secret for a workflow lineage (returned exactly once) |
| `GET` | `/api/v1/admin/workflow-definitions/templates` | List the platform workflow template library a tenant can clone from |
| `DELETE` | `/api/v1/admin/workflow-definitions/{id}` | Soft-delete a workflow definition version (refused for the ACTIVE published version — deprecate it first) |
| `GET` | `/api/v1/admin/workflow-definitions/{id}` | Get one workflow definition version |
| `PATCH` | `/api/v1/admin/workflow-definitions/{id}` | Update a DRAFT workflow definition version (If-Match OCC) |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/activate` | Make an already-PUBLISHED version the ACTIVE one for its slug (rollback) |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/clone` | Clone an existing workflow (or a platform template) into a NEW draft workflow |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/deprecate` | Deprecate a PUBLISHED version: it stops being served (isActive false) and stays immutable |
| `GET` | `/api/v1/admin/workflow-definitions/{id}/export` | Export one workflow version as a portable JSON bundle |
| `PUT` | `/api/v1/admin/workflow-definitions/{id}/nodes/{nodeId}/prompt` | Edit a node’s prompt from within the node: mint a new version if the content changed, and move this node’s pin |
| `GET` | `/api/v1/admin/workflow-definitions/{id}/prompt-bindings` | Which prompt version each node is pinned to, and whether a newer one exists |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/publish` | Compile the graph and publish this version |
| `POST` | `/api/v1/admin/workflow-definitions/{id}/validate` | Re-run shape + engine + DRAFT rule-catalogue validation and persist the report |
| `GET` | `/api/v1/admin/workflow-definitions/{id}/versions` | List every version row in this definition’s (tenantId, slug) lineage, most recent first |

## admin-workflow-invariant-rules

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/workflow-invariant-rules` | List the caller tenant's own rules UNION the SYSTEM platform register |
| `POST` | `/api/v1/admin/workflow-invariant-rules` | Author a workflow invariant rule for the caller tenant |
| `DELETE` | `/api/v1/admin/workflow-invariant-rules/{id}` | Soft-delete a rule |
| `GET` | `/api/v1/admin/workflow-invariant-rules/{id}` | Get one rule — the caller tenant’s own, or a SYSTEM register row |
| `PATCH` | `/api/v1/admin/workflow-invariant-rules/{id}` | Update a rule (If-Match OCC) |

## admin-workflow-nodes

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/workflow-nodes` | List the code-owned workflow node-type registry (the Studio’s node palette source) |

## admin-workflow-runs

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/workflow-runs` | Tenant-scoped, keyset-paginated, filterable list of workflow-substrate runs. Sandbox runs excluded by default. |
| `GET` | `/api/v1/admin/workflow-runs/{runId}` | A single run, with the worker CPU it consumed. Cross-tenant / nonexistent id → 404 (never 403). |
| `GET` | `/api/v1/admin/workflow-runs/{runId}/gate` | Live state of the run's human-approval gate, read from the gate child workflow. Cross-tenant / nonexistent id → 404. |
| `POST` | `/api/v1/admin/workflow-runs/{runId}/gate/approve` | Release the run's human-approval gate with a clinician decision. |
| `GET` | `/api/v1/admin/workflow-runs/{runId}/trace` | The CQRS-lite read shape: the run row plus its per-node rollup, assembled from ONE bounded trajectory read. Cross-tenant / none... |

## admin-workflow-sandbox-runs

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs` | Start a sandbox run of the CURRENT graph of :definitionId — DRAFT or published, never writes external artifacts. |
| `GET` | `/api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}` | Live run status + stages (queried from the interpreter dispatcher). |
| `POST` | `/api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}/cancel` | Cancel a sandbox run — the interpreter's allow-listed cancel signal, never a caller-supplied signal name. |
| `GET` | `/api/v1/admin/workflow-definitions/{definitionId}/sandbox-runs/{runId}/stream` | SSE progress + result. Accepts `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` (scope `workflow_run:<runId>`). |

## admin-workflow-test-fixtures

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/workflow-test-fixtures` | List the caller tenant’s saved fixtures |
| `POST` | `/api/v1/admin/workflow-test-fixtures` | Create a synthetic Workbench test fixture for the caller tenant |
| `DELETE` | `/api/v1/admin/workflow-test-fixtures/{id}` | Soft-delete a fixture |
| `GET` | `/api/v1/admin/workflow-test-fixtures/{id}` | Get one fixture |
| `PATCH` | `/api/v1/admin/workflow-test-fixtures/{id}` | Update a fixture (If-Match OCC) |

## agents

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/agents` | List the published agents visible to the tenant (own agents shadow the platform defaults) |
| `GET` | `/api/v1/agents/{slug}` | Describe one published agent: its task, version and I/O schemas |
| `POST` | `/api/v1/agents/{slug}/invocations` | Invoke a TEXT_GENERATION agent (blocking JSON, or SSE with ?mode=stream) |
| `POST` | `/api/v1/agents/{slug}/speech` | Synthesize speech with a TEXT_TO_SPEECH agent (streamed audio, the existing speech proxy contract) |
| `POST` | `/api/v1/agents/{slug}/transcriptions` | Start a batch transcription with a SPEECH_TO_TEXT agent (returns a TranscriptionJob) |

## ai-inference

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/v1/safety-checks` | Run a content-safety / PII / prompt-injection check on the supplied text (proxied to the Guardrail service). |
| `POST` | `/api/v1/text-analyses/diagnosis` | Derive diagnosis suggestions from the supplied clinical text (proxied to the NLP diagnosis endpoint). |
| `POST` | `/api/v1/text-analyses/entities` | Extract medical entities (NER) from the supplied text (proxied to the NLP token-classification endpoint). |
| `POST` | `/api/v1/text-analyses/intent` | Classify text into one of the caller tenant configured intents (open-taxonomy, delegated by NLP to text). |
| `POST` | `/api/v1/text-analyses/topic` | Classify text into one of the caller tenant configured topics (open-taxonomy, delegated by NLP to text). |

## audio-pipelines

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/audio/pipelines` | Retrieving multiple PipelineResponses |
| `GET` | `/api/v1/audio/pipelines/slug/{slug}` | Non-admin read-by-slug (tenant-scoped via `getBySlug`). |
| `GET` | `/api/v1/audio/pipelines/{id}` | Non-admin read-by-id (tenant-scoped via `getById`).  Cross-tenant lookups return 404 (not 403) to avoid existence leaks. |

## auth

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/v1/auth/forgot-password` | Request a self-service password reset link (always 202) |
| `POST` | `/api/v1/auth/impersonate` | Impersonate another user (admin only) |
| `POST` | `/api/v1/auth/login` | User login |
| `POST` | `/api/v1/auth/logout` | User logout |
| `GET` | `/api/v1/auth/me` | Get current user information |
| `POST` | `/api/v1/auth/refresh` | Refresh access token |
| `POST` | `/api/v1/auth/register` | Self-service registration — creates an unverified account and emails a verification link |
| `POST` | `/api/v1/auth/register/verify` | Consume an email-verification token — activates the account and provisions its tenant |
| `POST` | `/api/v1/auth/revoke-impersonation` | Revoke the current impersonation token |
| `GET` | `/api/v1/auth/sso/callback` | Complete the IdP's OIDC callback and mint a HOPE session |
| `POST` | `/api/v1/auth/sso/saml/{tenantKey}/acs` | Complete the SAML ACS POST (assertion validation, D4) and mint a HOPE session |
| `GET` | `/api/v1/auth/sso/saml/{tenantKey}/metadata` | This SP's SAML metadata for the tenant's configured IdP — register with the IdP out-of-band |
| `POST` | `/api/v1/auth/sso/saml/{tenantKey}/start` | Begin a tenant-scoped SAML login (SP-initiated AuthnRequest redirect) |
| `POST` | `/api/v1/auth/sso/start` | Begin a tenant-scoped OIDC login (HRD by email, or explicit tenantKey) |
| `POST` | `/api/v1/auth/stream-ticket` | Issue a single-use, 30-second ticket for authenticating SSE streams |
| `POST` | `/api/v1/users/password-reset/complete` | Complete a password reset using a single-use token |

## billing

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/tenants/me/invoices` | The caller's own tenant's invoices, newest period first. |
| `GET` | `/api/v1/tenants/me/invoices/{id}` | One of my invoices (lines, memos, BYOK notional spend). A foreign id → 404. |
| `GET` | `/api/v1/tenants/me/spend` | Month-to-date usage-and-spend snapshot vs my spend limit. Defaults to the current period. |

## changelog

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/changelog` | List the release notes visible to the caller |
| `POST` | `/api/v1/changelog/acknowledge` | Mark entries as seen for the current user |
| `GET` | `/api/v1/changelog/unseen` | Entries driving the one-time What's New dialog |

## consultation-jobs

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/consultations/jobs/{jobId}` | Get the current status of an async consultation job |
| `PATCH` | `/api/v1/consultations/jobs/{jobId}/cancel` | Cancel a pending or running async consultation job |
| `GET` | `/api/v1/consultations/jobs/{jobId}/stream` | Stream real-time status updates for an async consultation job via SSE |

## consultations

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/consultations` | Retrieving multiple ConsultationResponses |
| `POST` | `/api/v1/consultations/open` | Creating a ConsultationResponse |
| `GET` | `/api/v1/consultations/patient/{patientId}/date/{date}` | Retrieving multiple ConsultationResponses by patientId and date |
| `GET` | `/api/v1/consultations/patient/{patientId}/history` | Retrieving multiple ConsultationResponses by patientId |
| `GET` | `/api/v1/consultations/workflows` | The workflows this caller may select when opening a consultation. |
| `GET` | `/api/v1/consultations/{id}` | Retrieving a single ConsultationResponse by id |
| `PATCH` | `/api/v1/consultations/{id}` | Updating a ConsultationResponse by id |
| `GET` | `/api/v1/consultations/{id}/chain` | Retrieving multiple ConsultationResponses by id |
| `POST` | `/api/v1/consultations/{id}/close` | Creating a ConsultationResponse by id |
| `GET` | `/api/v1/consultations/{id}/context` | Retrieving multiple ContextItemResponses by id |
| `POST` | `/api/v1/consultations/{id}/context` | Creating a ContextItemResponse by id |
| `GET` | `/api/v1/consultations/{id}/context/case-notes` | Retrieving multiple ContextItemResponses by id |
| `GET` | `/api/v1/consultations/{id}/context/shared` | Retrieving multiple ContextItemResponses by id |
| `GET` | `/api/v1/consultations/{id}/context/transcriptions` | Retrieving multiple ContextItemResponses by id |
| `DELETE` | `/api/v1/consultations/{id}/context/{contextId}` | Deleting a OkResponseDto by id and contextId |
| `PATCH` | `/api/v1/consultations/{id}/context/{contextId}` | Updating a ContextItemResponse by id and contextId |
| `GET` | `/api/v1/consultations/{id}/context/{contextId}/versions` | Retrieving multiple ContextItemVersionResponses by id and contextId |
| `GET` | `/api/v1/consultations/{id}/context/{contextId}/versions/{versionNumber}` | Retrieving a single ContextItemVersionResponse by id and contextId and versionNumber |
| `GET` | `/api/v1/consultations/{id}/documents/sections` | Retrieving multiple DocumentSectionResponses by id |
| `GET` | `/api/v1/consultations/{id}/documents/{documentKey}/sections` | Retrieving multiple DocumentSectionResponses by id and documentKey |
| `GET` | `/api/v1/consultations/{id}/documents/{documentKey}/sections/{sectionKey}` | Retrieving a single DocumentSectionResponse by id and documentKey and sectionKey |
| `PATCH` | `/api/v1/consultations/{id}/documents/{documentKey}/sections/{sectionKey}` | Updating a DocumentSectionResponse by id and documentKey and sectionKey |
| `GET` | `/api/v1/consultations/{id}/harness-assurance/stream` | Stream live harness assurance (per-claim verdicts) for a consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/harness-progress/stream` | Stream live harness draft-generation progress for a consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/highlights` | Retrieving multiple HighlightResponses by id |
| `POST` | `/api/v1/consultations/{id}/highlights` | Creating a HighlightResponse by id |
| `DELETE` | `/api/v1/consultations/{id}/highlights/{highlightId}` | Deleting a OkResponseDto by id and highlightId |
| `GET` | `/api/v1/consultations/{id}/live-assist/stream` | Stream interpreter suggestions and proposed corrections for a consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/live-summary/stream` | Stream the running live summary for an in-progress consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/loop/stream` | Stream consultation-loop workflow events for a consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/named-entities` | Retrieving a single AggregateNerResponse by id |
| `POST` | `/api/v1/consultations/{id}/prime` | Creating a ConsultationResponse by id |
| `POST` | `/api/v1/consultations/{id}/recording/start` | Creating a RecordingStateResponse by id |
| `POST` | `/api/v1/consultations/{id}/recording/stop` | Creating a RecordingStateResponse by id |
| `GET` | `/api/v1/consultations/{id}/recordings` | Retrieving multiple AudioRecordingResponses by id |
| `POST` | `/api/v1/consultations/{id}/recordings` | Creating a ContextItemResponse by id |
| `POST` | `/api/v1/consultations/{id}/reopen` | Creating a ConsultationResponse by id |
| `GET` | `/api/v1/consultations/{id}/summary` | Retrieving multiple SummaryResponses by id |
| `POST` | `/api/v1/consultations/{id}/summary` | Creating a SummaryResponse by id |
| `POST` | `/api/v1/consultations/{id}/summary/async` | Creating a AsyncJobResponseDto by id |
| `POST` | `/api/v1/consultations/{id}/summary/comprehensive` | Creating a ComprehensiveSummaryResponse by id |
| `POST` | `/api/v1/consultations/{id}/summary/comprehensive/async` | Creating a ComprehensiveSummaryResponse by id |
| `GET` | `/api/v1/consultations/{id}/summary/latest` | Retrieving a single SummaryResponse by id |
| `POST` | `/api/v1/consultations/{id}/summary/pre-summary` | Creating a SummaryResponse by id |
| `POST` | `/api/v1/consultations/{id}/summary/pre-summary/async` | Creating a AsyncJobResponseDto by id |
| `GET` | `/api/v1/consultations/{id}/summary/pre-summary/latest` | Retrieving a single SummaryResponse by id |
| `POST` | `/api/v1/consultations/{id}/summary/{contextItemId}/approve` | Creating a SummaryApprovalResponseDto by id and contextItemId |
| `GET` | `/api/v1/consultations/{id}/summary/{contextItemId}/diff` | Retrieving a single VersionDiffResponse by id and contextItemId |
| `POST` | `/api/v1/consultations/{id}/summary/{contextItemId}/extract-entities` | Creating a OkResponseDto by id and contextItemId |
| `GET` | `/api/v1/consultations/{id}/summary/{contextItemId}/provenance` | Retrieving a single SummaryProvenanceResponse by id and contextItemId |
| `GET` | `/api/v1/consultations/{id}/summary/{contextItemId}/tags` | Retrieving multiple TagResponses by id and contextItemId |
| `POST` | `/api/v1/consultations/{id}/summary/{contextItemId}/tags` | Creating a TagResponse by id and contextItemId |
| `DELETE` | `/api/v1/consultations/{id}/summary/{contextItemId}/tags/{tagId}` | Deleting a OkResponseDto by id and contextItemId and tagId |
| `GET` | `/api/v1/consultations/{id}/summary/{contextItemId}/versions` | Retrieving multiple ContextItemVersionResponses by id and contextItemId |
| `PATCH` | `/api/v1/consultations/{id}/summary/{summaryId}` | Updating a SummaryResponse by id and summaryId |
| `GET` | `/api/v1/consultations/{id}/timeline` | Retrieving a single ConsultationTimelineResponse by id |
| `GET` | `/api/v1/consultations/{id}/trajectory/stream` | Stream the ordered agentic-session trajectory for a consultation via SSE |
| `GET` | `/api/v1/consultations/{id}/workflow` | Which engine governs this consultation, and the identity of the tenant-authored workflow when one does. |

## dna-writing-styles

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/dna-writing-styles/doctor/{doctorId}` | Retrieving a single DnaReportResponse by doctorId |
| `POST` | `/api/v1/dna-writing-styles/generate` | Creating a DnaJobResponseDto |
| `POST` | `/api/v1/dna-writing-styles/ingest` | Ingest a time series of writing samples for a clinician and queue their DNA writing-style analysis |
| `GET` | `/api/v1/dna-writing-styles/ingest/jobs/{jobId}` | Status of an ingest job |
| `GET` | `/api/v1/dna-writing-styles/jobs/{jobId}` | Get current user DNA generation job status |
| `GET` | `/api/v1/dna-writing-styles/jobs/{jobId}/stream` | Stream current user DNA generation job status via SSE |
| `GET` | `/api/v1/dna-writing-styles/mine` | Retrieving multiple DnaReportResponses |
| `DELETE` | `/api/v1/dna-writing-styles/my-style` | Erase the caller doctor's entire learned DNA writing-style profile |
| `GET` | `/api/v1/dna-writing-styles/my-style` | Retrieving a single DnaReportResponse |
| `GET` | `/api/v1/dna-writing-styles/my-style/redaction-rules` | Get the caller doctor's DNA redaction/rewrite rule set |
| `GET` | `/api/v1/dna-writing-styles/settings` | Get the caller doctor's DNA writing-style on/off settings |
| `PUT` | `/api/v1/dna-writing-styles/settings` | Set the caller doctor's DNA writing-style on/off toggle |
| `DELETE` | `/api/v1/dna-writing-styles/{reportId}` | Erase one of the caller doctor's DNA writing-style reports |
| `PATCH` | `/api/v1/dna-writing-styles/{reportId}` | Updating a DnaReportResponse by reportId |
| `PATCH` | `/api/v1/dna-writing-styles/{reportId}/default` | Updating a DnaReportResponse by reportId |
| `GET` | `/api/v1/dna-writing-styles/{reportId}/versions` | Retrieving multiple DnaVersionResponses by reportId |

## entitlements

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/tenants/me/entitlements` | Capability/usage snapshot for the caller's own tenant (limits, usage, meters, features, trial clock). |

## health

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/health/services` | Consolidated health check for all downstream microservices (admin only) |
| `GET` | `/api/v1/admin/health/services/{serviceKey}` | Health check for a single downstream microservice (admin only) |
| `GET` | `/api/v1/health` | Detailed health check |
| `GET` | `/api/v1/health/live` | Liveness probe - is the process running? |
| `GET` | `/api/v1/health/ready` | Readiness probe - is the service ready for traffic? |
| `GET` | `/api/v1/health/startup` | Startup probe - has the service finished initialization? |

## monitoring

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/monitoring/heartbeats/{service}` | Get heartbeat history for a service |
| `GET` | `/api/v1/admin/monitoring/sessions` | Get active session counts per service |
| `GET` | `/api/v1/admin/monitoring/uptime` | Get uptime data for all services |
| `GET` | `/api/v1/admin/monitoring/uptime/{service}` | Get uptime data for a specific service |

## prompt-templates

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/v1/prompt-templates` | Create a personal prompt template owned by the calling clinician |
| `GET` | `/api/v1/prompt-templates/available` | List the prompt templates the calling clinician may use |
| `PUT` | `/api/v1/prompt-templates/preferred` | Set or clear the calling clinician's preferred prompt template |
| `DELETE` | `/api/v1/prompt-templates/{id}` | Soft-delete a personal prompt template the caller owns |
| `PATCH` | `/api/v1/prompt-templates/{id}` | Update a personal prompt template the caller owns |

## rbac-permission-check

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/v1/users/me/permission-checks` | Get current user's effective permissions |
| `POST` | `/api/v1/users/{id}/permission-checks` | Check if a user has a specific permission |
| `POST` | `/api/v1/users/{id}/permission-checks/bulk` | Check multiple permissions at once |

## service-account-auth

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/v1/auth/service-token` | Exchange a service-account client secret for a short-lived access token |

## speech

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/v1/speech/synthesize` | Synthesize speech via TTS (batch audio, streamed audio, or SSE) |
| `GET` | `/api/v1/speech/voices` | List available TTS voices (stable internal ids + providers) |

## storage

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/storage/buckets` | List all storage buckets |
| `POST` | `/api/v1/storage/buckets` | Create a new storage bucket |
| `DELETE` | `/api/v1/storage/buckets/{name}` | Delete a storage bucket |
| `GET` | `/api/v1/storage/buckets/{name}` | Get bucket info |
| `PATCH` | `/api/v1/storage/buckets/{name}` | Update bucket metadata |
| `GET` | `/api/v1/storage/buckets/{name}/files` | List files in bucket |
| `POST` | `/api/v1/storage/buckets/{name}/files` | Upload file to bucket |
| `DELETE` | `/api/v1/storage/buckets/{name}/files/{key}` | Delete file from bucket |
| `GET` | `/api/v1/storage/buckets/{name}/files/{key}` | Get file info with presigned download URL |
| `GET` | `/api/v1/storage/health` | Check storage service health (detailed) |

## stt-compat

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/stt/start_session` | v1-compatible STT session start |
| `POST` | `/api/stt/stop_session` | v1-compatible STT session stop |
| `POST` | `/api/stt/switch` | v1-compatible STT mid-session engine switch |

## tenant

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/tenants/me` | Get current tenant information |
| `GET` | `/api/v1/tenants/me/config` | Get current tenant configuration |
| `PATCH` | `/api/v1/tenants/me/config` | Update current tenant configuration |
| `GET` | `/api/v1/tenants/me/context-schema` | Discover the caller tenant's pinned consultation context schema |
| `GET` | `/api/v1/tenants/me/document-template` | Discover the caller tenant's pinned document template |

## tenant-storage

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/tenants/storage/buckets` | List all storage buckets for current tenant |
| `POST` | `/api/v1/admin/tenants/storage/buckets` | Create a custom storage bucket |
| `GET` | `/api/v1/admin/tenants/storage/buckets/defaults` | Get the default bucket for each purpose (audio / attachments / misc) |
| `PUT` | `/api/v1/admin/tenants/storage/buckets/defaults` | Configure the default bucket for audio / attachments / misc |
| `POST` | `/api/v1/admin/tenants/storage/buckets/provision/{tenantId}` | Provision system buckets for a tenant (admin only) |
| `POST` | `/api/v1/admin/tenants/storage/buckets/register` | Adopt an existing physical bucket into a tenant |
| `DELETE` | `/api/v1/admin/tenants/storage/buckets/{id}` | Delete a custom storage bucket (system buckets cannot be deleted) |
| `GET` | `/api/v1/admin/tenants/storage/buckets/{id}` | Get bucket by ID |
| `DELETE` | `/api/v1/admin/tenants/storage/buckets/{id}/objects` | Delete a single object from a tenant bucket (storage-provider operation) |
| `GET` | `/api/v1/admin/tenants/storage/buckets/{id}/objects` | List objects in a tenant bucket (storage-provider operation) |
| `POST` | `/api/v1/admin/tenants/storage/buckets/{id}/objects` | Upload a single object into a tenant bucket (storage-provider operation) |
| `GET` | `/api/v1/admin/tenants/storage/buckets/{id}/presigned-url` | Get presigned download URL for a file in a tenant bucket |
| `GET` | `/api/v1/admin/tenants/storage/buckets/{id}/tree` | Get bucket folder/file tree for UI tree view |

## tenant-storage-keys

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/admin/tenants/storage/keys` | List all storage access keys for current tenant |
| `POST` | `/api/v1/admin/tenants/storage/keys` | Generate a new storage access key |
| `DELETE` | `/api/v1/admin/tenants/storage/keys/{id}` | Revoke a storage access key |

## text

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/v1/text-generations/generate/assembled` | Generate text with server-side prompt assembly (debug mode) |
| `GET` | `/api/v1/text-generations/guardrail-providers` | List Guardrail LLM providers/models from the AiModel registry (ENABLED GUARDRAIL rows), the effective guardrail.validate defaul... |
| `GET` | `/api/v1/text-generations/providers` | List LLM providers/models from the AiModel registry (ENABLED TEXT_GENERATION/SUMMARIZATION rows), with a live TEXT probe fallba... |
| `GET` | `/api/v1/text-generations/tasks/{taskId}` | Get task status from TEXT |
| `POST` | `/api/v1/text-generations/tasks/{taskId}/cancel` | Cancel a running TEXT task |
| `GET` | `/api/v1/text-generations/tasks/{taskId}/stream` | Stream task chunks via SSE from TEXT |

## text-compat

| Method | Path | Summary / Description |
|:---|:---|:---|
| `POST` | `/api/smr/api/v1/presummary` | v1-compatible department-aware pre-summary (stateless shim over TEXT /generate) |
| `POST` | `/api/smr/api/v1/summary/sync` | v1-compatible synchronous medical summary (stateless shim over TEXT /generate) |

## transcription-jobs

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/audio/transcription-jobs` | List transcription jobs (paginated, caller-owned jobs) |
| `POST` | `/api/v1/audio/transcription-jobs` | Create a transcription job |
| `POST` | `/api/v1/audio/transcription-jobs/batch` | Create a batch transcription job |
| `GET` | `/api/v1/audio/transcription-jobs/consultation/{consultationId}` | Get transcription jobs by consultation (caller-owned jobs) |
| `GET` | `/api/v1/audio/transcription-jobs/fallback` | The fallback engine of the tenant’s assigned (or the named) ASR agent, for the live provider toggle |
| `GET` | `/api/v1/audio/transcription-jobs/language-modes` | List selectable STT language modes + per-mode supported engines |
| `GET` | `/api/v1/audio/transcription-jobs/limits` | Batch upload ceilings (recordings per batch, minutes per recording, size, in-flight jobs) |
| `GET` | `/api/v1/audio/transcription-jobs/stats` | Get transcription job status counts (caller-owned jobs) |
| `GET` | `/api/v1/audio/transcription-jobs/status/{status}` | Get transcription jobs by status (caller-owned jobs) |
| `POST` | `/api/v1/audio/transcription-jobs/stream/session` | Create a WebSocket streaming session |
| `DELETE` | `/api/v1/audio/transcription-jobs/stream/session/{sessionId}` | Close a WebSocket streaming session |
| `POST` | `/api/v1/audio/transcription-jobs/stream/session/{sessionId}/refresh-ticket` | Refresh the stream ticket for a live streaming session |
| `POST` | `/api/v1/audio/transcription-jobs/stream/session/{sessionId}/switch-to-fallback` | Switch a live streaming session to the tenant fallback pipeline |
| `POST` | `/api/v1/audio/transcription-jobs/stream/session/{sessionId}/switch-to-primary` | Switch a live streaming session back to its primary pipeline |
| `POST` | `/api/v1/audio/transcription-jobs/streaming` | Create a streaming transcription job |
| `POST` | `/api/v1/audio/transcription-jobs/transcribe` | Upload audio file for batch transcription via worker |
| `GET` | `/api/v1/audio/transcription-jobs/{id}` | Get transcription job by ID |
| `POST` | `/api/v1/audio/transcription-jobs/{id}/cancel` | Cancel a transcription job |
| `POST` | `/api/v1/audio/transcription-jobs/{id}/retry` | Retry a failed transcription job |
| `GET` | `/api/v1/audio/transcription-jobs/{id}/stream` | Stream transcription job events via SSE |

## usage

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/tenants/me/usage-burndown` | Allowances vs month-to-date usage vs days elapsed, with a linear exceed projection. Defaults to the current UTC month. |
| `GET` | `/api/v1/tenants/me/usage-summary` | The caller's own tenant's usage summary for a billing period. Defaults to the current UTC month. |

## user

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/users/me/departments` | List the caller's own department assignments (tenant-scoped) |
| `GET` | `/api/v1/users/me/preferences` | Get current user preferences |
| `PATCH` | `/api/v1/users/me/preferences` | Update current user preferences (partial) |
| `GET` | `/api/v1/users/me/settings` | Get all settings for current user |
| `PATCH` | `/api/v1/users/me/settings/{namespace}/{key}` | Update a specific setting by namespace and key |
| `GET` | `/api/v1/users/{id}/roles` | List roles assigned to the current user (self-only) |

## voice-profile

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/voice-profiles` | List voice profiles for current user |
| `POST` | `/api/v1/voice-profiles/enroll` | Enroll a voice profile from audio samples |
| `GET` | `/api/v1/voice-profiles/enrollment-target` | The embedding model a new enrollment would use |
| `DELETE` | `/api/v1/voice-profiles/{id}` | Delete a voice profile |
| `PATCH` | `/api/v1/voice-profiles/{id}/activate` | Activate a voice profile |
| `PATCH` | `/api/v1/voice-profiles/{id}/deactivate` | Deactivate a voice profile |

## workflows

| Method | Path | Summary / Description |
|:---|:---|:---|
| `GET` | `/api/v1/consultations/{consultationId}/workflows` | The published workflows runnable AGAINST a consultation. |
| `POST` | `/api/v1/consultations/{consultationId}/workflows/{slug}/runs` | Run a published workflow against THIS consultation. |
| `POST` | `/api/v1/hooks/workflows/{hookId}` | Start a run from an external system (inbound webhook trigger). Body = the trigger payload; authenticated by HMAC over the raw b... |
| `GET` | `/api/v1/workflows` | The tenant's published + active, invokable workflows (slug + identity — no per-definition input schema exists yet). |
| `POST` | `/api/v1/workflows/{slug}/invoke` | DEPRECATED alias of POST :slug/runs. Start a run of the tenant's active published version of :slug. |
| `POST` | `/api/v1/workflows/{slug}/runs` | Start a run of the tenant's active published version of :slug. The canonical invocation entry point. |
| `GET` | `/api/v1/workflows/{slug}/runs/{runId}` | Live run status + result (queried from the interpreter dispatcher). |
| `POST` | `/api/v1/workflows/{slug}/runs/{runId}/cancel` | Cancel a run — sends the interpreter's allow-listed cancel signal, never a caller-supplied signal name. |
| `GET` | `/api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}` | The live state of one Human-review node of a run: whether it is waiting, how many times it has escalated, and the decision if o... |
| `POST` | `/api/v1/workflows/{slug}/runs/{runId}/reviews/{nodeId}/decide` | Release a Human-review node with a decision — the graph resumes down the `approved` or `rejected` handle. |
| `GET` | `/api/v1/workflows/{slug}/runs/{runId}/stream` | SSE progress + result. Accepts `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` (scope `workflow_run:<runId>`). |
| `POST` | `/api/v1/workflows/{slug}/runs/{runId}/stream-ticket` | Mint a single-use, 30-second ticket for this run’s WebSocket stream. |
| `GET` | `/api/v1/workflows/{slug}/schema` | The published definition`s generated contract: input/output component schemas, trigger kinds, protocols, admitted modes, and an... |

