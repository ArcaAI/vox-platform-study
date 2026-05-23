---

# @arcaai/vox SDK ↔ API Gateway Cross-Reference Report

**Date:** 2026-05-23  
**SDK path:** `packages/agentic-sdk-v2/src/`  
**API path:** `apps/api/src/`  
**Global API prefix:** `/api/v1` (set in `apps/api/src/main.ts:198`)

---

## 1. Endpoint Coverage Matrix

All SDK endpoint constants are declared in `packages/agentic-sdk-v2/src/core/constants.ts`. Actual API prefix `api/v1` is prepended by the server; the SDK stores only the suffix.

### 1.1 Auth (`AUTH_ENDPOINTS` / `useAuth`)

| API Endpoint | Method | API Controller | SDK Constant | SDK Hook |
|---|---|---|---|---|
| `POST /auth/login` | POST | `AuthController.login` (L49) | `AUTH_ENDPOINTS.LOGIN` (const:366) | `useAuth.login` (useAuth:53) |
| `POST /auth/logout` | POST | `AuthController.logout` (L188) | `AUTH_ENDPOINTS.LOGOUT` (const:367) | `useAuth.logout` (useAuth:79) |
| `GET /auth/me` | GET | `AuthController.me` (L228) | `AUTH_ENDPOINTS.ME` (const:368) | `useAuth.getMe` (useAuth:102) |
| `POST /auth/refresh` | POST | `AuthController.refresh` (L399) | `AUTH_ENDPOINTS.REFRESH` (const:369) | `useAuth.refreshToken` (useAuth:123) |
| `POST /auth/impersonate` | POST | `AuthController.impersonate` (L286) | `AUTH_ENDPOINTS.IMPERSONATE` (const:370) | `useAuth.impersonate` (useAuth:148) |
| `POST /auth/revoke-impersonation` | POST | `AuthController.revokeImpersonation` (L454) | `AUTH_ENDPOINTS.REVOKE_IMPERSONATION` (const:371) | `useAuth.endImpersonation` (useAuth:175) |

**Coverage: 6/6 — COMPLETE.**

### 1.2 Consultation (`CONSULTATION_ENDPOINTS` / `useArca.session`)

| API Endpoint | Method | API Controller | SDK Constant | SDK Hook |
|---|---|---|---|---|
| `POST /consultations/open` | POST | `ConsultationController.open` (L269) | `CONSULTATION_ENDPOINTS.OPEN` (const:21) | `useArca.openSession` → `sessionUtils.openSessionOperation` |
| `GET /consultations/:id` | GET | `ConsultationController.getById` (L279) | `CONSULTATION_ENDPOINTS.GET(id)` (const:23) | `useArca.loadConsultation` |
| `GET /consultations` | GET | `ConsultationController.list` (L293) | `CONSULTATION_ENDPOINTS.LIST` (const:32) | `useArca.listConsultations` (useArca:405) |
| `GET /consultations/patient/:patientId/history` | GET | `ConsultationController.getPatientHistory` (L309) | `CONSULTATION_ENDPOINTS.PATIENT_HISTORY(id)` (const:25) | `useArca.getPatientHistory` |
| `GET /consultations/patient/:patientId/date/:date` | GET | `ConsultationController.getByPatientAndDate` (L323) | `CONSULTATION_ENDPOINTS.PATIENT_DATE(pid,d)` (const:27) | `useArca.findByPatientDate` (useArca:333) |
| `GET /consultations/:id/chain` | GET | `ConsultationController.getChain` (L336) | `CONSULTATION_ENDPOINTS.CHAIN(id)` (const:31) | ❌ **Not surfaced** in any hook |
| `GET /consultations/:id/timeline` | GET | `ConsultationController.getTimeline` (L350) | `CONSULTATION_ENDPOINTS.TIMELINE(id)` (const:29) | `useArca.getTimeline` (useArca:368) |
| `PATCH /consultations/:id` | PATCH | ❌ **Not implemented in ConsultationController** | `CONSULTATION_ENDPOINTS.UPDATE(id)` (const:34) | **No hook calls it** |
| `POST /consultations/:id/close` | POST | ❌ **Not implemented in ConsultationController** | `CONSULTATION_ENDPOINTS.CLOSE(id)` (const:36) | **No hook calls it** |
| `POST /consultations/:id/reopen` | POST | ❌ **Not implemented in ConsultationController** | `CONSULTATION_ENDPOINTS.REOPEN(id)` (const:38) | **No hook calls it** |

### 1.3 Context (`CONTEXT_ENDPOINTS`)

| API Endpoint | Method | API Controller | SDK Constant | SDK Hook |
|---|---|---|---|---|
| `POST /consultations/:id/context` | POST | `ConsultationController.addContext` (L365) | `CONTEXT_ENDPOINTS.ADD(id)` (const:46) | `useArca.addCaseNote`, `addTranscription`, audio auto-post |
| `GET /consultations/:id/context` | GET | `ConsultationController.getContextItems` (L376) | `CONTEXT_ENDPOINTS.GET(id)` (const:47) | `useArca.getItems` (useArca:953) |
| `GET /consultations/:id/context/shared` | GET | `ConsultationController.getSharedContext` (L387) | `CONTEXT_ENDPOINTS.SHARED(id)` (const:50) | `useArca.loadSharedContext` (useArca:793) |
| `GET /consultations/:id/context/transcriptions` | GET | `ConsultationController.getTranscriptions` (L400) | `CONTEXT_ENDPOINTS.TRANSCRIPTIONS(id)` (const:61) | `useArca.fetchTranscriptions` (useArca:981) |
| `GET /consultations/:id/context/case-notes` | GET | `ConsultationController.getCaseNotes` (L412) | `CONTEXT_ENDPOINTS.CASE_NOTES(id)` (const:63) | `useArca.fetchCaseNotes` (useArca:1002) |
| `GET /consultations/:id/context/worknotes` | GET | ❌ **Not implemented in API** | `CONTEXT_ENDPOINTS.WORKNOTES(id)` (const:65) | **No hook calls it** |
| `GET /consultations/:id/context/attachments` | GET | ❌ **Not implemented in API** | `CONTEXT_ENDPOINTS.ATTACHMENTS(id)` (const:67) | **No hook calls it** |
| `PATCH /consultations/:id/context/:contextId` | PATCH | `ConsultationController.updateContext` (L428) | `CONTEXT_ENDPOINTS.UPDATE(id,cid)` (const:52-53) | `useArca.updateContextItem` (useArca:762) |
| `GET /consultations/:id/context/:contextId/versions` | GET | `ConsultationController.getContextVersions` (L441) | `CONTEXT_ENDPOINTS.VERSIONS(id,cid)` (const:55-57) | `useArca.getContextVersions` (useArca:877) |
| `GET /consultations/:id/context/:contextId/versions/:n` | GET | `ConsultationController.getContextVersion` (L454) | `CONTEXT_ENDPOINTS.VERSION(id,cid,n)` (const:58-60) | `useArca.compareSummaryVersions` (useArca:1389) |

### 1.4 Summary (`SUMMARY_ENDPOINTS`)

| API Endpoint | Method | API Controller | SDK Constant | SDK Hook |
|---|---|---|---|---|
| `POST /consultations/:id/summary` | POST | `ConsultationController.generateSummary` (L473) | `SUMMARY_ENDPOINTS.GENERATE(id)` (const:74) | `useArca.generateSummary` (useArca:1073) |
| `GET /consultations/:id/summary` | GET | `ConsultationController.getSummaries` (L485) | `SUMMARY_ENDPOINTS.LIST(id)` (const:80) | `useArca.loadSummaries` (useArca:1184) |
| `POST /consultations/:id/summary/pre-summary` | POST | `ConsultationController.generatePreSummary` (L497) | `SUMMARY_ENDPOINTS.PRE_SUMMARY(id)` (const:75) | `useArca.generatePreSummary` (useArca:1027) |
| `GET /consultations/:id/summary/latest` | GET | `ConsultationController.getLatestSummary` (L509) | `SUMMARY_ENDPOINTS.LATEST(id)` (const:76) | ❌ **No direct hook call** — SDK uses loadSummaries then finds first |
| `GET /consultations/:id/summary/pre-summary/latest` | GET | `ConsultationController.getLatestPreSummary` (L520) | `SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY(id)` (const:78) | `useArca.getLatestPreSummary` (useArca:1338) |
| `PATCH /consultations/:id/summary/:summaryId` | PATCH | `ConsultationController.updateSummary` (L531) | `SUMMARY_ENDPOINTS.UPDATE(id,sid)` (const:81-83) | `useArca.updateSummary` (useArca:1121) |
| `GET /consultations/:id/summary/:contextItemId/versions` | GET | `ConsultationController.getSummaryVersions` (L548) | `SUMMARY_ENDPOINTS.VERSIONS(id,cid)` (const:94-95) | `useArca.getSummaryHistory` (useArca:1362) |
| `POST /consultations/:id/summary/:contextItemId/extract-entities` | POST | `ConsultationController.extractEntities` (L561) | `SUMMARY_ENDPOINTS.EXTRACT_ENTITIES(id,cid)` (const:83-84) | `useArca.triggerEntityExtraction` (useArca:914) |
| `POST /consultations/:id/summary/async` | POST | `ConsultationController.generateSummaryAsync` (L583) | `SUMMARY_ENDPOINTS.GENERATE_ASYNC(id)` (const:88) | `useArca.generateSummaryAsync` (useArca:1225) |
| `POST /consultations/:id/summary/pre-summary/async` | POST | `ConsultationController.generatePreSummaryAsync` (L611) | `SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC(id)` (const:90) | `useArca.generatePreSummaryAsync` (useArca:1267) |
| `POST /consultations/:id/summary/comprehensive` | POST | `ConsultationController.generateComprehensiveSummary` (L637) | `SUMMARY_ENDPOINTS.COMPREHENSIVE(id)` (const:86) | `useArca.generateComprehensiveSummary` (useArca:1301) |
| `POST /consultations/:id/summary/comprehensive/async` | POST | `ConsultationController.generateComprehensiveSummaryAsync` (L670) | `SUMMARY_ENDPOINTS.COMPREHENSIVE_ASYNC(id)` (const:92) | ❌ **No hook calls this** |
| `POST /consultations/:id/summary/:contextItemId/approve` | POST | `ConsultationController.approveSummary` (L700) | `SUMMARY_ENDPOINTS.APPROVE(id,cid)` (const:97-98) | ❌ **No hook calls this** |

### 1.5 Consultation Jobs (`CONSULTATION_JOB_ENDPOINTS` / `useConsultationJob`)

| API Endpoint | Method | API Controller | SDK Constant | SDK Hook |
|---|---|---|---|---|
| `GET /consultations/jobs/:jobId` | GET | ❌ **NO CONTROLLER EXISTS** | `CONSULTATION_JOB_ENDPOINTS.GET(id)` (const:412) | `useConsultationJob.getJob` (useConsultationJob:65) |
| `PATCH /consultations/jobs/:jobId/cancel` | PATCH | ❌ **NO CONTROLLER EXISTS** | `CONSULTATION_JOB_ENDPOINTS.CANCEL(id)` (const:413) | `useConsultationJob.cancelJob` (useConsultationJob:85) |
| `GET /consultations/jobs/:jobId/stream` | SSE | ❌ **NO CONTROLLER EXISTS** | `CONSULTATION_JOB_ENDPOINTS.SSE(id)` (const:414) | `useConsultationJob.streamJob` (useConsultationJob:113) |

**Critical gap:** The `ConsultationJobService` exists in `@arcaai/applications` (service:48), and the `ConsultationController` uses it internally to CREATE jobs (L595, L623, L684). However, there is **no HTTP controller** exposing `GET /consultations/jobs/:jobId`, `PATCH /consultations/jobs/:jobId/cancel`, or `GET /consultations/jobs/:jobId/stream`. The SDK hooks for `getJob`, `cancelJob`, and `streamJob` will all return **404**.

### 1.6 NER / Entities (`ENTITY_ENDPOINTS`)

| API Endpoint | Method | API Controller | SDK Constant | SDK Hook |
|---|---|---|---|---|
| `GET /consultations/:id/named-entities` | GET | `ConsultationController.getNamedEntities` (L715) | `ENTITY_ENDPOINTS.GET_ALL(id)` (const:109) | `useArca.extractEntities` (useArca:831) |
| `GET /consultations/:id/context/:contextItemId/named-entities` | GET | ❌ **Not implemented in API** | `ENTITY_ENDPOINTS.GET_FOR_ITEM(id,cid)` (const:111-113) | `useArca.extractEntities` (useArca:831, conditional) |

### 1.7 Transcription Jobs (`STT_V2_ENDPOINTS` / `useArcaSession` / `TranscriptionJobService`)

| API Endpoint | Method | API Controller | SDK Constant | SDK Hook |
|---|---|---|---|---|
| `POST /audio/transcription-jobs/stream/session` | POST | `TranscriptionJobController.createStreamSession` (L244) | `STT_V2_ENDPOINTS.CREATE_SESSION` (const:251) | `StreamingSessionManager`, `SttV2WebSocketClient` |
| `DELETE /audio/transcription-jobs/stream/session/:sessionId` | DELETE | `TranscriptionJobController.closeStreamSession` (L289) | `STT_V2_ENDPOINTS.CLOSE_SESSION(sid)` (const:253) | `StreamingSessionManager` |
| `WS /ws/stt-v2/stream` | WS | `SttWsGateway` (path:'/ws/stt-v2/stream', L16) | `STT_V2_ENDPOINTS.WS_STREAM` (const:255) | `SttV2WebSocketClient` |
| `POST /audio/transcription-jobs` | POST | `TranscriptionJobController.create` (L87) | `STT_V2_ENDPOINTS.CREATE_JOB` (const:257) | `TranscriptionJobService` |
| `POST /audio/transcription-jobs/batch` | POST | `TranscriptionJobController.createBatch` (L95) | `STT_V2_ENDPOINTS.CREATE_BATCH_JOB` (const:259) | `TranscriptionJobService` |
| `POST /audio/transcription-jobs/streaming` | POST | `TranscriptionJobController.createStreaming` (L103) | `STT_V2_ENDPOINTS.CREATE_STREAMING_JOB` (const:261) | `TranscriptionJobService` |
| `POST /audio/transcription-jobs/transcribe` | POST | `TranscriptionJobController.transcribeFile` (L125) | `STT_V2_ENDPOINTS.TRANSCRIBE` (const:263) | `FileTranscriptionService` |
| `GET /audio/transcription-jobs/:id/stream` | SSE | `TranscriptionJobController.streamJob` (L308) | `STT_V2_ENDPOINTS.JOB_STREAM(id)` (const:265) | `SSEClient` via `TranscriptionJobService` |
| `GET /audio/transcription-jobs/:id` | GET | `TranscriptionJobController.getById` (L297) | `STT_V2_ENDPOINTS.GET_JOB(id)` (const:267) | `TranscriptionJobService` |
| `GET /audio/transcription-jobs` | GET | `TranscriptionJobController.list` (L333) | `STT_V2_ENDPOINTS.LIST_JOBS` (const:269) | `TranscriptionJobService` |
| `GET /audio/transcription-jobs/stats` | GET | `TranscriptionJobController.getStats` (L111) | `STT_V2_ENDPOINTS.JOB_STATS` (const:271) | ❌ **No hook calls this** |
| `GET /audio/transcription-jobs/consultation/:id` | GET | `TranscriptionJobController.getByConsultation` (L237) | `STT_V2_ENDPOINTS.JOBS_BY_CONSULTATION(id)` (const:273) | ❌ **No hook calls this** |
| `GET /audio/transcription-jobs/status/:status` | GET | `TranscriptionJobController.getByStatus` (L117) | `STT_V2_ENDPOINTS.JOBS_BY_STATUS(s)` (const:275) | ❌ **No hook calls this** |
| `POST /audio/transcription-jobs/:id/cancel` | POST | `TranscriptionJobController.cancel` (L319) | `STT_V2_ENDPOINTS.CANCEL_JOB(id)` (const:277) | `TranscriptionJobService` |
| `POST /audio/transcription-jobs/:id/retry` | POST | `TranscriptionJobController.retry` (L325) | `STT_V2_ENDPOINTS.RETRY_JOB(id)` (const:279) | `TranscriptionJobService` |

### 1.8 ASR Pipelines (`PIPELINE_ENDPOINTS` / `usePipelines`)

| API Endpoint | Method | API Controller | SDK Constant | SDK Hook |
|---|---|---|---|---|
| `GET /audio/pipelines` | GET | `AudioPipelinePublicController` (inferred) | `PIPELINE_ENDPOINTS.LIST` (const:294) | `usePipelines.list` (usePipelines:71) |
| `GET /audio/pipelines/:id` | GET | `AudioPipelinePublicController` | `PIPELINE_ENDPOINTS.GET(id)` (const:296) | `usePipelines.get` (usePipelines:79) |
| `GET /audio/pipelines/slug/:slug` | GET | `AudioPipelinePublicController` | `PIPELINE_ENDPOINTS.GET_BY_SLUG(slug)` (const:298) | `usePipelines.getBySlug` (usePipelines:82) |
| `POST /admin/audio/pipelines` | POST | `AudioPipelineController.create` (L22) | `PIPELINE_ENDPOINTS.CREATE` (const:300) | `usePipelines.createPipeline` (usePipelines:95) |
| `PATCH /admin/audio/pipelines/:id` | PATCH | `AudioPipelineController.update` (L76) | `PIPELINE_ENDPOINTS.UPDATE(id)` (const:302) | `usePipelines.updatePipeline` (usePipelines:106) |
| `DELETE /admin/audio/pipelines/:id` | DELETE | `AudioPipelineController.delete` (L83) | `PIPELINE_ENDPOINTS.DELETE(id)` (const:304) | `usePipelines.deletePipeline` (usePipelines:114) |
| `POST /admin/audio/pipelines/validate` | POST | `AudioPipelineController.validateYaml` (L96) | `PIPELINE_ENDPOINTS.VALIDATE` (const:306) | `usePipelines.validateConfig` (usePipelines:124) |
| `POST /admin/audio/pipelines/:id/assign-tenant` | POST | ❌ **Not in AudioPipelineController** | `PIPELINE_ENDPOINTS.ASSIGN_TENANT(id)` (const:308) | `usePipelines.assignToTenant` (usePipelines:132) |
| `POST /admin/audio/pipelines/:id/assign-user` | POST | ❌ **Not in AudioPipelineController** | `PIPELINE_ENDPOINTS.ASSIGN_USER(id)` (const:310) | ❌ **No hook calls this** |

> **Note:** `PIPELINE_ENDPOINTS.VALIDATE` is `/admin/audio/pipelines/validate`, but the controller endpoint at L96 is `POST validate-yaml` (path `validate-yaml`, not `validate`). **Path mismatch.**

### 1.9 DNA Writing Style (`DNA_STYLE_ENDPOINTS` / `useDnaStyle`)

| API Endpoint | Method | API Controller | SDK Constant | SDK Hook |
|---|---|---|---|---|
| `POST /dna-writing-styles/generate` | POST | `DnaWritingStyleController.generate` (L55) | `DNA_STYLE_ENDPOINTS.GENERATE` (const:134) | `useDnaStyle.generate` (useDnaStyle:45) |
| `GET /dna-writing-styles/my-style` | GET | `DnaWritingStyleController.getMyStyle` (L65) | `DNA_STYLE_ENDPOINTS.MY_STYLE` (const:138) | `useDnaStyle.getMyStyle` (useDnaStyle:35) |
| `PATCH /dna-writing-styles/:reportId` | PATCH | `DnaWritingStyleController.update` (L97) | `DNA_STYLE_ENDPOINTS.UPDATE(id)` (const:139) | `useDnaStyle.update` (useDnaStyle:51) |
| `GET /dna-writing-styles/:reportId/versions` | GET | `DnaWritingStyleController.getVersions` (L109) | `DNA_STYLE_ENDPOINTS.VERSIONS(id)` (const:140) | `useDnaStyle.getVersions` (useDnaStyle:61) |
| `GET /dna-writing-styles/jobs/:jobId` | GET | `DnaWritingStyleController.getJobStatus` (L122) | `DNA_STYLE_ENDPOINTS.JOB_STATUS(id)` (const:136) | `useDnaStyle.getJobStatus` (useDnaStyle:72) |
| `GET /dna-writing-styles/jobs/:jobId/stream` | SSE | `DnaWritingStyleController.streamJobStatus` (L131) | `DNA_STYLE_ENDPOINTS.JOB_STREAM(id)` (const:137) | ❌ **No hook streams this** |
| `GET /dna-writing-styles/doctor/:doctorId` | GET | `DnaWritingStyleController.getByDoctor` (L77) | `DNA_STYLE_ENDPOINTS.BY_DOCTOR(id)` (const:144) | `useDnaStyle.getByDoctor` (useDnaStyle:131) |
| `POST /admin/dna-writing-styles/generate/:doctorId` | POST | `DnaWritingStyleAdminController` | `DNA_STYLE_ENDPOINTS.GENERATE_FOR_DOCTOR(id)` (const:135) | ❌ **No hook calls this** |
| `GET /admin/dna-writing-styles` | GET | `DnaWritingStyleAdminController` | `DNA_STYLE_ENDPOINTS.ADMIN_LIST` (const:141) | ❌ **No hook calls this** |

### 1.10 Prompt Templates (`PROMPT_TEMPLATE_ENDPOINTS` / `usePrompts`)

| API Endpoint | Method | API Controller | SDK Constant | SDK Hook |
|---|---|---|---|---|
| `POST /prompt-templates` | POST | `PromptManagementController` | `PROMPT_TEMPLATE_ENDPOINTS.CREATE` (const:153) | `usePrompts` |
| `GET /prompt-templates` | GET | `PromptManagementController` | `PROMPT_TEMPLATE_ENDPOINTS.LIST` (const:154) | `usePrompts` |
| `GET /prompt-templates/:id` | GET | `PromptManagementController` | `PROMPT_TEMPLATE_ENDPOINTS.GET(id)` (const:155) | `usePrompts` |
| `PATCH /prompt-templates/:id` | PATCH | `PromptManagementController` | `PROMPT_TEMPLATE_ENDPOINTS.UPDATE(id)` (const:156) | `usePrompts` |
| `DELETE /prompt-templates/:id` | DELETE | `PromptManagementController` | `PROMPT_TEMPLATE_ENDPOINTS.DELETE(id)` (const:157) | `usePrompts` |
| `GET /prompt-templates/:id/versions` | GET | `PromptManagementController` | `PROMPT_TEMPLATE_ENDPOINTS.VERSIONS(id)` (const:158) | `usePrompts` |
| `GET /prompt-templates/:id/versions/:n` | GET | `PromptManagementController` | `PROMPT_TEMPLATE_ENDPOINTS.VERSION(id,n)` (const:159) | `usePrompts` |
| `POST /prompt-templates/assign-department` | POST | `PromptManagementController` | `PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT` (const:160) | `usePrompts` |
| `GET /prompt-templates/:id/usage` | GET | `PromptManagementController` | `PROMPT_TEMPLATE_ENDPOINTS.USAGE(id)` (const:162) | ❌ **No hook calls this** |
| `POST /prompt-templates/:id/versions/:n/activate` | POST | `PromptManagementController` | `PROMPT_TEMPLATE_ENDPOINTS.ACTIVATE_VERSION(id,n)` (const:164) | ❌ **No hook calls this** |

### 1.11 Departments (`DEPARTMENT_ENDPOINTS` / `useDepartments`)

All 9 department endpoints (`LIST`, `GET`, `CREATE`, `UPDATE`, `DELETE`, `ROOTS`, `CHILDREN`, `BY_CODE`, `PROMPT_CONFIG`) are mapped to `DepartmentController` at `@Controller('admin/departments')` and consumed by `useDepartments` hook. **Coverage: Complete.**

### 1.12 Tenants (`TENANT_ENDPOINTS` + `MY_TENANT_ENDPOINTS` / `useTenants`)

| SDK Constant | API Endpoint | Controller | Consumed |
|---|---|---|---|
| `TENANT_ENDPOINTS.LIST` | `GET /admin/tenants` | `TenantController.fetchAll` | `useTenants.list` |
| `TENANT_ENDPOINTS.GET(id)` | `GET /admin/tenants/:id` | `TenantController.fetchById` | `useTenants.get` |
| `TENANT_ENDPOINTS.GET_BY_CODE_NAME(cn)` | `GET /admin/tenants/code-name/:code-name` | `TenantController.fetchByCodeName` | `useTenants.getByCodeName` |
| `TENANT_ENDPOINTS.CREATE` | `POST /admin/tenants` | `TenantController.create` | `useTenants.create` |
| `TENANT_ENDPOINTS.UPDATE(id)` | `PATCH /admin/tenants/:id` | `TenantController.update` | `useTenants.update` |
| `TENANT_ENDPOINTS.DELETE(id)` | `DELETE /admin/tenants/:id` | `TenantController.delete` | `useTenants.delete` |
| `TENANT_ENDPOINTS.GET_CONFIGS(id)` | `GET /admin/tenants/configs/:identifier` | `TenantController.fetchTenantConfigs` | `useTenants.getConfigs` |
| `TENANT_ENDPOINTS.UPDATE_CONFIGS(id)` | `PATCH /admin/tenants/configs/:identifier` | `TenantController.updateTenantConfigs` | `useTenants.updateConfigs` |
| `MY_TENANT_ENDPOINTS.INFO` | `GET /tenant/me` | `MyTenantController.me` (L32) | `useTenants.getMyTenant` |
| `MY_TENANT_ENDPOINTS.CONFIG` | `GET /tenant/me/config` | `MyTenantController.myConfig` (L47) | `useTenants.getMyTenantConfig` |
| — | `PATCH /tenant/me/config` | `MyTenantController.updateMyConfig` (L63) | ❌ **Not in SDK constants or hooks** |

### 1.13 Users (`USER_ENDPOINTS` / `useUsers`)

All standard CRUD plus `GET_BY_EXTERNAL`, `BY_TENANT`, `ME` (`/auth/me` duplication) are covered. `useUsers` includes:
- `GET /admin/users` → `UserController.fetchAll` ✓
- `GET /admin/users/:id` → `UserController.fetchById` ✓  
- `POST /admin/users` → `UserController.create` ✓  
- `PATCH /admin/users/:id` → `UserController.update` ✓  
- `DELETE /admin/users/:id` → `UserController.delete` ✓  

**Gap:** `UserController` exposes `GET /admin/users/:id/settings`, `PATCH /admin/users/:id/settings/:namespace/:key`, `POST /admin/users/:id/roles`, and `DELETE /admin/users/:id/roles/:assignmentId` (L171–220). **None of these are in `USER_ENDPOINTS` or called by `useUsers`.**

**Also:** `ROLE_ENDPOINTS.USER_ROLES(userId)` (const:486) points to `/users/:userId/roles` (without `/admin` prefix), but the actual API route is `POST /admin/users/:id/roles` — **prefix mismatch**.

### 1.14 Roles (`ROLE_ENDPOINTS` / `useRoles`)

| SDK Constant | API Path | Controller | SDK Hook |
|---|---|---|---|
| `ROLE_ENDPOINTS.LIST` | `GET /admin/rbac/roles` | `RolesController.findAll` (L49) | `useRoles.list` |
| `ROLE_ENDPOINTS.GET(id)` | `GET /admin/rbac/roles/:id` | `RolesController.findOne` (L116) | `useRoles.get` |
| `ROLE_ENDPOINTS.CREATE` | `POST /admin/rbac/roles` | `RolesController.create` (L165) | `useRoles.create` |
| `ROLE_ENDPOINTS.UPDATE(id)` | `PATCH /admin/rbac/roles/:id` | `RolesController.patch` (L300) | `useRoles.update` |
| `ROLE_ENDPOINTS.DELETE(id)` | `DELETE /admin/rbac/roles/:id` | `RolesController.remove` (L386) | `useRoles.delete` |
| `ROLE_ENDPOINTS.ASSIGN_POLICY(rid,pid)` | `POST /admin/rbac/roles/:roleId/policies/:policyId` | `RolesController.assignPolicy` (L434) | `useRoles.assignPolicy` |
| `ROLE_ENDPOINTS.REMOVE_POLICY(rid,pid)` | `DELETE /admin/rbac/roles/:roleId/policies/:policyId` | `RolesController.removePolicy` (L500) | `useRoles.removePolicy` |
| `ROLE_ENDPOINTS.USER_ROLES(userId)` | `/users/:userId/roles` | ❌ **No controller at this path** | `useRoles.getUserRoles` |
| `ROLE_ENDPOINTS.USER_ROLE(uid,rid)` | `/users/:userId/roles/:roleId` | ❌ **No controller at this path** | ❌ **Not called** |
| `ROLE_ENDPOINTS.CHILDREN(id)` | `/admin/rbac/roles/:id/children` | ❌ **Not in RolesController** | `useRoles.getChildren` |
| `ROLE_ENDPOINTS.HIERARCHY(id)` | `/admin/rbac/roles/:id/hierarchy` | ❌ **Not in RolesController** | `useRoles.getHierarchy` |

**Note:** The `RolesController` implements `PUT :id` (full update, L219) which the SDK maps to `update` calling `PATCH`. SDK uses `PATCH /admin/rbac/roles/:id` which hits the `patch` method (L300) — this is fine.

### 1.15 Policies (`POLICY_ENDPOINTS` / `usePolicies`)

Full CRUD including `VALIDATE` covered between `PoliciesController` and `usePolicies`. **Coverage: Complete** (5/5 CRUD + validate).

### 1.16 Audit Logs (`AUDIT_LOG_ENDPOINTS` / `useAuditLog`)

| SDK Constant | API Controller Endpoint | SDK Calls |
|---|---|---|
| `AUDIT_LOG_ENDPOINTS.LIST` → `GET /admin/audit-logs` | `AuditLogController.fetchAll` (L33) | `useAuditLog.list` ✓ |
| `AUDIT_LOG_ENDPOINTS.GET(id)` → `GET /admin/audit-logs/:id` | `AuditLogController.fetchById` (L55) | `useAuditLog.get` ✓ |
| `AUDIT_LOG_ENDPOINTS.BY_RESOURCE(type,id)` → `GET /admin/audit-logs/resource/:type/:id` | `AuditLogController.fetchByResource` (L79) | `useAuditLog.getByResource` ✓ |
| `AUDIT_LOG_ENDPOINTS.BY_USER(uid)` → `GET /admin/audit-logs/user/:userId` | `AuditLogController.fetchByUser` (L130) | `useAuditLog.getByUser` ✓ |

**Gap:** API exposes `DELETE /admin/audit-logs/:id` (`AuditLogController.delete`, L143). No SDK constant or hook for this.

### 1.17 Monitoring (`MONITORING_ENDPOINTS` / `useMonitoring`)

All 4 endpoints aligned: `UPTIME`, `SERVICE_UPTIME(s)`, `HEARTBEATS(s)`, `SESSIONS` → `MonitoringController` (L21–74). **Coverage: Complete.**

### 1.18 Health (`HEALTH_ENDPOINTS` + `SERVICE_HEALTH_ENDPOINTS` / `useHealthCheck`)

| SDK Constant | API Route | Notes |
|---|---|---|
| `HEALTH_ENDPOINTS.HEALTH` → `/health` | `ApiHealthController.check` (L116) | ✓ |
| `HEALTH_ENDPOINTS.LIVE` → `/health/live` | `ApiHealthController.liveness` (L80) | ✓ |
| `HEALTH_ENDPOINTS.READY` → `/health/ready` | `ApiHealthController.readiness` (L88) | ✓ |
| `SERVICE_HEALTH_ENDPOINTS.SERVICES` → `/health/services` | `ApiHealthController.checkServices` (L143) | ✓ |
| — | `GET /health/startup` | `ApiHealthController.startup` (L102) | ❌ **Not in SDK** |
| — | `GET /health/services/:serviceKey` | `ApiHealthController.checkServiceByKey` (L179) | ❌ **Not in SDK** |

### 1.19 Storage (`STORAGE_ENDPOINTS` / `useStorage`)

| SDK Endpoint | API | Notes |
|---|---|---|
| `LIST_BUCKETS` → `GET /storage/buckets` | `StorageController.listBuckets` (L47) | ✓ |
| `GET_BUCKET(n)` → `GET /storage/buckets/:name` | `StorageController.getBucket` (L96) | ✓ |
| `CREATE_BUCKET` → `POST /storage/buckets` | `StorageController.createBucket` (L55) | ✓ |
| `DELETE_BUCKET(n)` → `DELETE /storage/buckets/:name` | `StorageController.deleteBucket` (L70) | ✓ |
| `LIST_FILES(b)` → `GET /storage/buckets/:name/files` | `StorageController.listFiles` (L108) | ✓ |
| `UPLOAD_FILE(b)` → `POST /storage/buckets/:name/files` | `StorageController.uploadFile` (L118) | ✓ (but SDK sends JSON body, API expects `multipart/form-data`) |
| `GET_FILE(b,k)` → `GET /storage/buckets/:name/files/:key` | `StorageController.getFileInfo` (L171) | ✓ |
| `DELETE_FILE(b,k)` → `DELETE /storage/buckets/:name/files/:key` | `StorageController.deleteFile` (L182) | ✓ |
| `HEALTH` → `GET /storage/health` | `StorageController.checkHealth` (L193) | ✓ |
| — | `PATCH /storage/buckets/:name` | `StorageController.updateBucket` (L83) | ❌ **Not in SDK** |

### 1.20 Voice Embedding (`VOICE_EMBEDDING_ENDPOINTS` / `useVoiceEmbedding`)

This is the most significant path mismatch (see §2 below).

| SDK Constant / Path | API Controller / Path |
|---|---|
| `UPLOAD(uid)` → `/users/:userId/voice-embedding` (POST) | `VoiceProfileController` → `POST /voice-profile/enroll` |
| `STATUS(uid)` → `/users/:userId/voice-embedding` (GET) | `VoiceProfileController` → `GET /voice-profile` |
| `REMOVE(uid)` → `/users/:userId/voice-embedding` (DELETE) | `VoiceProfileController` → `DELETE /voice-profile/:id` |

### 1.21 Global Settings (`GLOBAL_SETTINGS_ENDPOINTS` / `useGlobalSettings`)

Full CRUD including `BY_TENANT`, `TENANT_CONFIG` consumed between `useGlobalSettings` and `GlobalSettingsController` at `/admin/settings`. **Coverage: Complete.**

### 1.22 User Settings (`USER_SETTINGS_ENDPOINTS` / `useUserSettings`)

| SDK Constant | SDK Endpoint | API Route | API Controller |
|---|---|---|---|
| `LIST` | `GET /user/me/settings` | `GET /user/me/settings` | `UserSettingsController.getMySettings` (L27) ✓ |
| `GET(id)` | `GET /user/me/settings/:id` | ❌ **No such route in UserSettingsController** | Not implemented |
| `CREATE` | `POST /user/me/settings` | ❌ **No POST route in UserSettingsController** | Not implemented |
| `UPDATE(id)` | `PATCH /user/me/settings/:id` | `PATCH /user/me/settings/:namespace/:key` | Route shape mismatch — different path params |
| `MY_SETTINGS(uid)` | `GET /user/me/settings/user/:userId` | ❌ **No such route** | Not implemented |

### 1.23 API Keys (`API_KEY_ENDPOINTS` / `useApiKeys`)

| SDK Constant | SDK Endpoint | API Controller |
|---|---|---|
| `LIST` | `GET /admin/api-keys` | `ApiKeyController.fetchAll` ✓ |
| `GET(id)` | `GET /admin/api-keys/:id` | `ApiKeyController.fetchById` ✓ |
| `CREATE` | `POST /admin/api-keys` | `ApiKeyController.create` ✓ |
| `UPDATE(id)` | `PATCH /admin/api-keys/:id` | `ApiKeyController.update` ✓ |
| `DELETE(id)` | `DELETE /admin/api-keys/:id` | `ApiKeyController.delete` ✓ |
| `REVOKE(id)` | `POST /admin/api-keys/:id/revoke` | `ApiKeyController.revoke` ✓ |
| `USAGE(id)` | `GET /admin/api-keys/:id/usage` | ❌ **Not in ApiKeyController** |

### 1.24 NLP Proxy (`NLP_ENDPOINTS`)

| SDK Constant | SDK Endpoint | API |
|---|---|---|
| `CLASSIFY_TOKENS` → `/nlp/classify/tokens` | Used by NER plugin | Proxied via BaseProxyController ✓ |
| `CLASSIFY_TEXT` → `/nlp/classify/text` | Used by NER plugin | Proxied ✓ |
| `CORRECT` → `/nlp/correct` | — | Proxied ✓ |
| `SUGGEST` → `/nlp/suggest` | — | Proxied ✓ |

### 1.25 User Preferences (`PERSONALIZATION_ENDPOINTS`)

| SDK Constant | SDK Endpoint | API Route | Notes |
|---|---|---|---|
| `GET_PREFERENCES` → `/user/me/preferences` | `PersonalizationManager` | `UserPreferencesController` at `/user/me/preferences` | ✓ |
| `UPDATE_PREFERENCES` → `/user/me/preferences` (PATCH) | `PersonalizationManager` | `UserPreferencesController` | ✓ |

---

## 2. Drift / Gaps (with file:line citations)

### GAP-01 🔴 CRITICAL — Consultation Job HTTP Controller Missing

**SDK expects:** Three REST/SSE endpoints at `CONSULTATION_JOB_ENDPOINTS.*` (constants.ts:411–415):
- `GET /consultations/jobs/:jobId` (from `useConsultationJob.getJob`, useConsultationJob:65)
- `PATCH /consultations/jobs/:jobId/cancel` (useConsultationJob:85)
- `GET /consultations/jobs/:jobId/stream` (SSE, useConsultationJob:113)

**API provides:** None. The `ConsultationJobService.cancelJob()` (consultation-job.service.ts:302) and `getJobStatus()` (L286) exist in the application layer but are never wired to a controller route. The `ConsultationController` only calls `consultationJobService.createXxxJob()` — there is no GET or cancel endpoint.

**Impact:** Every `useConsultationJob` call to `getJob`, `cancelJob`, and `streamJob` returns HTTP 404. The streaming SSE for async summary jobs is completely broken.

---

### GAP-02 🔴 CRITICAL — Voice Embedding Complete Path Mismatch

**SDK:** `VOICE_EMBEDDING_ENDPOINTS` (constants.ts:549–553) resolves to:
- `POST /users/:userId/voice-embedding`
- `GET /users/:userId/voice-embedding`
- `DELETE /users/:userId/voice-embedding`

**API:** `VoiceProfileController` (voice-profile.controller.ts:31) is at `@Controller('voice-profile')` exposing:
- `POST /voice-profile/enroll` (with multipart/form-data, up to 3 files)
- `GET /voice-profile` (list, not by userId)
- `DELETE /voice-profile/:id` (by profile ID, not userId)

No controller matches `/users/:userId/voice-embedding`. Every `useVoiceEmbedding` call will return 404. Additionally, `useVoiceEmbedding.upload` calls `apiClient.post(endpoint, formData)` (useVoiceEmbedding:57) using the regular JSON `.post()` method, not `postFormData()` — so the Content-Type will be wrong even if the path existed.

---

### GAP-03 🔴 CRITICAL — User Settings Endpoint Mismatch

**SDK:** `USER_SETTINGS_ENDPOINTS` (constants.ts:400–406) declares:
- `GET /user/me/settings/:id` — no such route in `UserSettingsController`
- `POST /user/me/settings` — no such route (controller has no POST)
- `PATCH /user/me/settings/:id` — controller has `PATCH /user/me/settings/:namespace/:key` (2 params, not 1 id)
- `GET /user/me/settings/user/:userId` — no such route

**API:** `UserSettingsController` (user-settings.controller.ts:18) only has:
- `GET /user/me/settings` — returns ALL settings for current user
- `PATCH /user/me/settings/:namespace/:key` — updates by namespace+key, not by ID

**Impact:** `useUserSettings.get(id)`, `.create()`, `.update(id)`, and `.getMySettings(userId)` all call non-existent routes. Only `list()` works.

---

### GAP-04 🟠 HIGH — Role User-Management Endpoint Wrong Prefix

**SDK:** `ROLE_ENDPOINTS.USER_ROLES(userId)` (constants.ts:486) → `/users/:userId/roles`  
**API:** `UserController` at `POST /admin/users/:id/roles` (user.controller.ts:202) and `DELETE /admin/users/:id/roles/:assignmentId` (L212)

The SDK uses `/users/` (no `/admin` prefix); the actual route is under `/admin/users/`. All calls to `useRoles.getUserRoles()` and role-assignment operations via this constant will 404.

---

### GAP-05 🟠 HIGH — Pipeline Validate Path Mismatch

**SDK:** `PIPELINE_ENDPOINTS.VALIDATE` (constants.ts:306) → `POST /admin/audio/pipelines/validate`  
**API:** `AudioPipelineController.validateYaml` (audio-pipeline.controller.ts:96) → path is `validate-yaml` → actual full path is `POST /admin/audio/pipelines/validate-yaml`

**Impact:** `usePipelines.validateConfig()` (usePipelines:124) will 404 or hit the wrong route.

---

### GAP-06 🟠 HIGH — Pipeline Assign-Tenant Not Implemented

**SDK:** `PIPELINE_ENDPOINTS.ASSIGN_TENANT(id)` (constants.ts:308) and `ASSIGN_USER` (L310) called by `usePipelines.assignToTenant` (usePipelines:132).  
**API:** `AudioPipelineController` has no `assign-tenant` or `assign-user` method.

---

### GAP-07 🟡 MEDIUM — CONSULTATION_ENDPOINTS.UPDATE/CLOSE/REOPEN Orphaned

**SDK:** `CONSULTATION_ENDPOINTS.UPDATE`, `CLOSE`, `REOPEN` (constants.ts:34–38) exist but **no hook calls them** and no API route implements them in `ConsultationController` (no `PATCH /consultations/:id`, no `POST /consultations/:id/close`, no `POST /consultations/:id/reopen`).

---

### GAP-08 🟡 MEDIUM — CONTEXT_ENDPOINTS.WORKNOTES / ATTACHMENTS Not Implemented

**SDK:** `CONTEXT_ENDPOINTS.WORKNOTES(id)` (constants.ts:65) and `ATTACHMENTS(id)` (L67) defined but neither endpoint exists in `ConsultationController` and no hook calls them.

---

### GAP-09 🟡 MEDIUM — ENTITY_ENDPOINTS.GET_FOR_ITEM Not in API

**SDK:** `ENTITY_ENDPOINTS.GET_FOR_ITEM(id, cid)` (constants.ts:111) → `GET /consultations/:id/context/:contextItemId/named-entities`  
**API:** `ConsultationController` only has `getNamedEntities` for `GET /consultations/:id/named-entities`. No per-context-item NER endpoint exists. `useArca.extractEntities(contextItemId)` (useArca:831) will 404 when `contextItemId` is provided.

---

### GAP-10 🟡 MEDIUM — Storage uploadFile Wrong Content-Type

**SDK:** `useStorage.uploadFile` (useStorage:127) calls `client.post<StorageFile>(STORAGE_ENDPOINTS.UPLOAD_FILE(bucket), formData)` — this calls `AgenticClient.post()` (AgenticClient:351) which serializes the body as JSON (including Content-Type: application/json header).  
**API:** `StorageController.uploadFile` (storage.controller.ts:118) uses `@UseInterceptors(FileInterceptor('file'))` which expects `multipart/form-data`.

**Impact:** Uploads will fail with 400 (no file found). Should call `apiClient.postFormData()` or `uploadFormData()` instead.

---

### GAP-11 🟡 MEDIUM — PATCH /tenant/me/config Not in SDK

**API:** `MyTenantController.updateMyConfig` (my-tenant.controller.ts:63) at `PATCH /tenant/me/config` exists but there is no SDK constant (`MY_TENANT_ENDPOINTS` only has `INFO` and `CONFIG` for GET) and no hook call for updating tenant config via the "me" path.

---

### GAP-12 🟡 MEDIUM — Summary COMPREHENSIVE_ASYNC / APPROVE No Hook Calls

- `SUMMARY_ENDPOINTS.COMPREHENSIVE_ASYNC(id)` (constants.ts:92) — API implements `POST /:id/summary/comprehensive/async` (consultation.controller.ts:670) but no SDK hook calls it.
- `SUMMARY_ENDPOINTS.APPROVE(id,cid)` (constants.ts:97) — API implements `POST /:id/summary/:contextItemId/approve` (L700) but no SDK hook calls it.

---

### GAP-13 🟡 MEDIUM — DNA Admin Endpoints Not Surfaced

`DNA_STYLE_ENDPOINTS.GENERATE_FOR_DOCTOR`, `ADMIN_LIST`, `ADMIN_JOB_STATUS`, `ADMIN_JOB_STREAM` are in constants but no hook calls them.

---

### GAP-14 🟢 LOW — SUMMARY_ENDPOINTS.LATEST Not Called Directly

`SUMMARY_ENDPOINTS.LATEST(id)` (constants.ts:76) exists but no hook calls `GET /consultations/:id/summary/latest` directly. `loadSummaries()` fetches all and the store picks the latest. This is a missed optimization.

---

### GAP-15 🟢 LOW — Health/Services/:serviceKey Not in SDK

`GET /health/services/:serviceKey` (health.controller.ts:179) and `GET /health/startup` (L102) are not in SDK constants. Minor, as health is primarily used for monitoring dashboards.

---

## 3. Auth Flow Validation

### 3.1 Token Transport

**SDK sends** (AgenticClient.ts:113–121):
```
Authorization: Bearer <accessToken>
X-API-Key: <apiKey>          (if set)
X-Tenant-ID: <tenantId>      (if set)
```

**API reads** (context.interceptor.ts:57):
```
x-tenant-id   (header, lowercase)
```

**Mismatch:** The SDK sets `X-Tenant-ID` (mixed case) but `ContextInterceptor` reads `x-tenant-id` (lowercase). HTTP headers are case-insensitive per RFC 7230, and Node.js `http.IncomingMessage` normalizes headers to lowercase. This should work in practice but the inconsistency is worth noting.

**CORS allow-list** (main.ts:249–271) includes `X-Tenant-Id` (mixed case) and `X-Tenant-ID` is NOT in the list. In production this could cause CORS preflight failures for the tenant header. The correct header name must appear in `allowedHeaders`.

### 3.2 Token Refresh — Deduplication

**SDK:** `AgenticClient.deduplicatedRefresh()` (AgenticClient:711) uses a mutex (`inflightRefresh`) to ensure only one concurrent refresh call. On 401, it calls `onUnauthorizedHandler` which must be set by the consumer via `setOnUnauthorized()` (L730).  
**API:** `POST /auth/refresh` (auth.controller.ts:399) does NOT validate the refresh token signature or store issued tokens — it only parses the format `refresh_<userId>_<ts>_<random>` (L409) and issues a new JWT. There is **no refresh token revocation or blacklisting**.  
**Gap:** The SDK does not check if the 401 came from the refresh endpoint itself before calling `deduplicatedRefresh`. This is guarded by (AgenticClient:231):  
```typescript
!endpoint.includes(AgenticClient.AUTH_REFRESH_ENDPOINT)
```  
where `AUTH_REFRESH_ENDPOINT = '/auth/refresh'` (L74). This is correct.

### 3.3 Impersonation Flow

**SDK:** `useAuth.impersonate()` (useAuth:140–168) saves `currentToken` to store, calls `POST /auth/impersonate`, updates the client token with the impersonation token. `endImpersonation()` (L171–194) calls `POST /auth/revoke-impersonation` and restores original token.  
**API:** `AuthController.impersonate()` (auth.controller.ts:300) returns a short-lived impersonation token (15m default, L358). On revoke (L454), it merely tracks the audit — the token is **not server-side invalidated** (no token blacklist).  
**Alignment:** The flow is conceptually aligned. The gap is that the original refresh token is not stored by the SDK during impersonation — if the impersonation token expires, the SDK has no mechanism to refresh back to the admin session.

### 3.4 Tenant Scoping

**SDK:** Sets `X-Tenant-ID` header on every request via `AgenticClient`. The `tenantId` in the JWT payload is also carried by the token.  
**API:** `ContextInterceptor` reads `x-tenant-id` to **override** the tenant from JWT (context.interceptor.ts:56–59). This override-from-header pattern means a malicious client could call a different tenant's data by changing the header if authorization checks rely solely on the header rather than the JWT claim.  
**Assessment:** The `ConsultationController` uses `cls.get('tenantId')` for authorization checks. This could be overridable via header. This is an authorization design concern.

### 3.5 API Key Auth

**SDK:** Sends `X-API-Key: <apiKey>` header (AgenticClient:116).  
**API:** CORS allowedHeaders (main.ts:250) includes `X-API-Key`, `api-key`, `apikey`, `x-api-key`. The `ApiKeyController` and guards are present.  
**Alignment:** Correct. API key auth is a parallel auth path with JWT, not competing.

---

## 4. Real-Time Channel Validation

### 4.1 WebSocket — STT-V2 Streaming

**SDK Client:** `SttV2WebSocketClient` (SttV2WebSocketClient.ts:78)  
**SDK connects to:** `ws://host/ws/stt-v2/stream?sessionId=<sessionId>` (derived from `STT_V2_ENDPOINTS.WS_STREAM` = `/ws/stt-v2/stream`)  
**API Gateway:** `SttWsGateway` (`@WebSocketGateway({ path: '/ws/stt-v2/stream' })`, stt-ws.gateway.ts:16)

**Protocol Alignment:**

| Client → Server | SDK sends | API handles |
|---|---|---|
| Binary PCM (Int16 LE) | `sendAudioFrame(buffer)` (SttV2WebSocketClient:229) | `Buffer.isBuffer(rawData)` branch (stt-ws.gateway.ts:123) ✓ |
| JSON `{type:'audio', seq, data}` | `sendAudioFrameJson(seq, b64)` (L237) | `case 'audio'` (L151) ✓ |
| JSON `{type:'stop'}` | `sendStop()` (L249) | `case 'stop'` → `writeControlCommand('finalize')` (L158) ✓ |
| JSON `{type:'close'}` | `sendClose()` (L258) | `case 'close'` → session cleanup (L163) ✓ |

| Server → Client | API sends | SDK handles |
|---|---|---|
| `{type:'transcript', text, startTime, endTime, isFinal, ...}` | `bridgeService.subscribeToResults` result | `normalizeTranscript()` (SttV2WebSocketClient:430) ✓ |
| `{type:'status', status, message}` | Status messages | `isValidStatus` check (L546) ✓ |
| `{type:'error', code, message}` | Error messages | `isValidError` check (L554) ✓ |

**Assessment:** Protocol is **fully aligned**. SDK correctly normalizes both camelCase and snake_case variants from the server (L431–433 for timestamps, L436–440 for isFinal).

**Gap:** SDK `SttV2WebSocketClient` connects directly to `wsUrl` from `STT_V2_ENDPOINTS.WS_STREAM`, but the session `wsUrl` returned from `POST /audio/transcription-jobs/stream/session` is hardcoded to `'/ws/stt-v2/stream'` (transcription-job.controller.ts:283). The client must build the full WebSocket URL (`ws://host/ws/stt-v2/stream?sessionId=...`) — this construction is handled in `StreamingSessionManager` (not read) but must combine base URL with WS scheme conversion.

### 4.2 SSE — Transcription Job Streaming

**SDK Client:** `SSEClient` (SSEClient.ts) used in `useConsultationJob.streamJob()` (useConsultationJob:97–188).  
**SDK connects to:** `<baseUrl>/consultations/jobs/:jobId/stream` (useConsultationJob:113)  
**API:** NO endpoint at this path (see GAP-01). However, the transcription-job SSE at `GET /audio/transcription-jobs/:id/stream` (TranscriptionJobController:308) IS implemented and correctly streams via `realtimeService.subscribeToJob()`.

**SSE Auth:** `SSEClient` appends `?token=<authToken>` to the URL (SSEClient:65–66, 74–76) because `EventSource` cannot send custom headers.  
**API:** The `TranscriptionJobController.streamJob` endpoint is decorated `@Authorize()` which uses `JwtAuthGuard`. This guard reads `Authorization: Bearer` header — NOT from query params. **The SSE token query parameter is silently ignored by the guard.** SSE streams will fail with 401 unless the API is configured to accept token-in-query for EventSource.

### 4.3 SSE — DNA Writing Style Job Streaming

**SDK:** `useDnaStyle.getJobStatus()` polls via REST. No hook streams the DNA job SSE at `GET /dna-writing-styles/jobs/:jobId/stream` (dna-writing-style.controller.ts:131).  
**Gap:** The streaming endpoint exists in the API but no SDK hook subscribes to it (see GAP-13).

### 4.4 SharedConnectionManager (Cross-Tab)

**SDK:** `SharedConnectionManager` (SharedConnectionManager.ts:64) multiplexes SSE and WS across browser tabs via a `SharedWorker`. Falls back to direct `EventSource`/`WebSocket` when `SharedWorker` is unavailable.  
**Assessment:** This is a pure client-side abstraction layer. It delegates to `SSEClient` (direct path) or the SharedConnectionWorker which itself creates `EventSource`/`WebSocket`. The routing is the same — therefore the same SSE auth issue applies in the fallback path.

---

## 5. Error Contract Conformance

### 5.1 SDK Error Codes

The SDK `AgenticErrorCode` type (common.ts:56–67) defines:

```
NOT_INITIALIZED | API_ERROR | NETWORK_ERROR | AUTHENTICATION_ERROR |
VALIDATION_ERROR | NOT_FOUND | AUDIO_ERROR | PLUGIN_ERROR |
MODEL_LOAD_ERROR | STORAGE_ERROR | UNKNOWN_ERROR
```

Plus `RATE_LIMITED` (AgenticClient:59) — **not in `AgenticErrorCode`** (internal use only, thrown as `AgenticError('RATE_LIMITED', ...)` but `RATE_LIMITED` is not a member of the union type).

### 5.2 AgenticClient HTTP → Error Code Mapping

From `AgenticClient.request()` (AgenticClient:197–204):

| HTTP Status | SDK Error Code | Correct? |
|---|---|---|
| 401 | `AUTHENTICATION_ERROR` | ✓ |
| 404 | `NOT_FOUND` | ✓ |
| 400–499 (other) | `VALIDATION_ERROR` | ⚠️ Conflates 403 Forbidden with 400 Bad Request |
| 500+ | `API_ERROR` | ✓ |
| AbortError | `NETWORK_ERROR` | ✓ |
| TypeError | `NETWORK_ERROR` | ✓ |
| Other | `UNKNOWN_ERROR` | ✓ |

**Missing code:** `403 Forbidden` is mapped to `VALIDATION_ERROR`, which is semantically wrong. The API returns 403 in multiple cases: shared consultation access denied (consultation.controller.ts:205), DNA style access for another doctor (dna-writing-style.controller.ts:88), etc. The SDK has no `FORBIDDEN` or `PERMISSION_DENIED` code to distinguish authorization failures from input validation errors.

### 5.3 API Error Emission vs SDK Handling

The API uses NestJS built-in exceptions (`UnauthorizedException`, `BadRequestException`, `ForbiddenException`, `NotFoundException`, `ServiceUnavailableException`). These produce standard NestJS error JSON like `{ statusCode, message, error }`, **not** RFC 9457 `problem+json` format.

**SDK:** `AgenticClient.request()` (L196) reads `errorData.message` from the response body. This works for NestJS default errors.  
**Gap:** There is no `AGENTIC_E*` error code namespace in the API codebase. The canonical doc (`docs/developer-guide/HOPE-API-Integration-Guide.md`) references RFC 9457 but the API does not implement `problem+json` (Content-Type: `application/problem+json`).  
**SDK `errorUtils.ts`:** Has no mapping for RFC 9457 `type` URIs — it only checks `error instanceof AgenticError` (errorUtils:10–12). If the API ever adopts `problem+json`, the SDK error parsing would need updating.

### 5.4 Rate Limiting

**SDK:** Client-side rate limiting with `RATE_LIMITED` code (AgenticClient:59). This is a client-only construct — the API does not emit this code.  
**API:** Server-side throttling via `@nestjs/throttler` (e.g., auth routes at 10/min, health at 300/min). When throttled, the API returns HTTP 429 with `ThrottlerException`. The SDK maps 429 to `VALIDATION_ERROR` (400–499 branch) — **incorrect mapping**. Should be a distinct `RATE_LIMITED` or `API_ERROR` code.

---

## 6. Recommendations

### R-01 🔴 CRITICAL — Implement `GET|PATCH|SSE /consultations/jobs/:jobId*` Controller

Create a `ConsultationJobController` (or add routes to `ConsultationController`) exposing:
- `GET /consultations/jobs/:jobId` → `ConsultationJobService.getJobStatus()`
- `PATCH /consultations/jobs/:jobId/cancel` → `ConsultationJobService.cancelJob()`
- `GET /consultations/jobs/:jobId/stream` (SSE) → existing BullMQ job subscription

Until this is done, `useConsultationJob` is completely broken and async summary generation has no way for consumers to track job status.

### R-02 🔴 CRITICAL — Fix Voice Embedding: Align Controller Path or SDK Constants

**Option A (preferred):** Add a `GET|POST|DELETE /users/:userId/voice-embedding` endpoint to the existing `VoiceProfileController` that maps to the profile service. Update the controller `@Controller` path or add a parallel controller.

**Option B:** Update `VOICE_EMBEDDING_ENDPOINTS` to point to `/voice-profile/enroll`, `/voice-profile`, `/voice-profile/:id` and update `useVoiceEmbedding` to pass profile ID (not userId) for delete.

Also fix `useVoiceEmbedding.upload()` (useVoiceEmbedding:57) to call `apiClient.postFormData()` instead of `apiClient.post()`.

### R-03 🔴 CRITICAL — Fix User Settings CRUD

The `UserSettingsController` only has `GET` and `PATCH /:namespace/:key`. Either:
- Add `POST`, `GET /:id`, `DELETE /:id` routes to the controller, OR
- Remove `CREATE`, `GET`, `UPDATE(id)` from SDK constants and `useUserSettings`, leaving only `list()` and a `updateByKey(namespace, key, value)` method that calls `PATCH /user/me/settings/:namespace/:key`.

### R-04 🟠 HIGH — Fix Pipeline Validate Path: `validate-yaml` vs `validate`

Change `AudioPipelineController` to use `@Post('validate')` or update `PIPELINE_ENDPOINTS.VALIDATE` to `/admin/audio/pipelines/validate-yaml`. Pick one, be consistent.

### R-05 🟠 HIGH — Fix Role User-Management Endpoint Prefix

`ROLE_ENDPOINTS.USER_ROLES` must be `/admin/users/:userId/roles` (with admin prefix). Update constants.ts:486 and the corresponding hook calls.

### R-06 🟠 HIGH — Fix SSE Token Auth

`EventSource` cannot send `Authorization` headers. The API must support token-in-query auth for SSE endpoints:
```typescript
// In JwtAuthGuard or strategy, also check:
const token = request.query?.token ?? request.headers.authorization?.split(' ')[1];
```
Or use a short-lived SSE ticket token endpoint. Until this is fixed, all `streamJob` SSE calls will fail authentication in production.

### R-07 🟠 HIGH — Add `FORBIDDEN` Error Code to SDK

Add `'FORBIDDEN'` to `AgenticErrorCode` union (common.ts:56). In `AgenticClient.request()`, split 403 from the `VALIDATION_ERROR` bucket:
```typescript
response.status === 403 ? 'FORBIDDEN' :
response.status >= 400 && response.status < 500 ? 'VALIDATION_ERROR' :
```
Add `isForbiddenError()` to `errorUtils.ts`.

### R-08 🟡 MEDIUM — Implement Missing Pipeline Endpoints or Remove SDK Stubs

Either implement `POST /admin/audio/pipelines/:id/assign-tenant` in `AudioPipelineController`, or remove `PIPELINE_ENDPOINTS.ASSIGN_TENANT` and `usePipelines.assignToTenant()` to avoid silent 404s.

### R-09 🟡 MEDIUM — Wire PATCH /tenant/me/config to SDK

Add `MY_TENANT_ENDPOINTS.UPDATE_CONFIG = '/tenant/me/config'` to constants and a `updateMyTenantConfig()` method to `useTenants` calling `apiClient.patch(endpoint, configs)`.

### R-10 🟡 MEDIUM — Add 429 as `RATE_LIMITED` in AgenticClient

Map HTTP 429 to the `RATE_LIMITED` code (already used client-side) rather than `VALIDATION_ERROR`. Update AgenticClient:200:
```typescript
response.status === 429 ? 'RATE_LIMITED' :
```
Add `RATE_LIMITED` to the `AgenticErrorCode` union type.

### R-11 🟡 MEDIUM — Add Hook Coverage for Orphaned Endpoints

| Orphaned API Endpoint | Suggested Hook Addition |
|---|---|
| `GET /consultations/:id/chain` | `useArca.session.getChain(id)` |
| `GET /health/services/:serviceKey` | `useHealthCheck.getServiceHealth(key)` |
| `POST /consultations/:id/summary/:id/approve` | `useArca.summary.approveSummary(summaryId)` |
| `DELETE /admin/audit-logs/:id` | `useAuditLog.delete(id)` |
| `GET /audio/transcription-jobs/stats` | `useArcaSession` or standalone |
| `DNA_STYLE_ENDPOINTS.JOB_STREAM` | `useDnaStyle.streamJobStatus(jobId, callbacks)` |

### R-12 🟡 MEDIUM — DTO Codegen Strategy

There is **no shared code generation** between `@arcaai/applications` DTOs and `@arcaai/vox` types. The SDK maintains hand-typed mirrors (`types/auth.ts`, `types/consultation.ts`, etc.). Drift is already visible (LoginUserResponse has `firstName`/`lastName`/`phone` fields in the API DTO that `AuthUser` in the SDK omits — login.response.ts:34–43 vs auth.ts:8–14).

**Recommendation:** Adopt OpenAPI → TypeScript client codegen (e.g., `openapi-generator`, `orval`, or `hey-api`). The NestJS Swagger module already produces a full spec (`/api/v1/docs`). Generate SDK types from it in CI to prevent drift.

### R-13 🟢 LOW — Versioning Policy

The API has no versioning beyond `/api/v1` in the global prefix (main.ts:196). SDK constants hardcode paths without version segments. If the API introduces `/api/v2`, all SDK constants must be updated. Recommendation: Pass version as a constructor config param in `AgenticClient` and derive base URL accordingly, rather than embedding `/v1` paths in constants.

---

**Summary of Critical Findings:**

| Priority | Issue | Files |
|---|---|---|
| 🔴 | No ConsultationJob HTTP controller | `apps/api/src/modules/consultation/`, `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts` |
| 🔴 | Voice embedding 100% path mismatch + wrong content-type | `apps/api/src/modules/voice-profile/`, `packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts`, `core/constants.ts:549–553` |
| 🔴 | User settings CRUD routes don't exist in API | `apps/api/src/modules/user/controllers/user-settings.controller.ts`, `core/constants.ts:400–406` |
| 🟠 | Pipeline validate path mismatch | `core/constants.ts:306`, `apps/api/src/modules/pipeline/audio-pipeline.controller.ts:96` |
| 🟠 | Role user-routes wrong prefix | `core/constants.ts:486` |
| 🟠 | SSE JWT auth via query param not handled by API guard | `core/SSEClient.ts:65–66`, `apps/api/src/guards/jwtauth.guard.ts` |
| 🟠 | HTTP 403 mapped to `VALIDATION_ERROR` in SDK | `core/AgenticClient.ts:202` |