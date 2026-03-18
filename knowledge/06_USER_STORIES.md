# User Stories

> **Project**: HOPE — Hybrid Agentic Medical Conversation System
> **Last Updated**: 2026-02-24
> **Total Stories**: 150

---

## Table of Contents

1. Overview
2. Persona Definitions
3. Doctor Consultation Workflow (1-15)
4. Audio & Transcription (16-25)
5. Admin — User Management (26-35)
6. Admin — RBAC (36-42)
7. Admin — Departments & Prompts (43-52)
8. Admin — System Monitoring (53-60)
9. Admin — Pipelines & Tenant Config (61-66)
10. SDK Developer Experience (67-76)
11. Frontend UI & Navigation (77-85)
12. Authentication & Security (86-92)
13. Testing & Quality Assurance (93-97)
14. Infrastructure & DevOps (98-100)
15. Consultation Lifecycle & Status (101-110)
16. Doctor-Department Relationship (111-116)
17. Prompt Template Lifecycle (117-126)
18. Pre-Summary Generation (127-133)
19. Full Summary Generation & Department Customization (134-143)
20. Doctor Review, Editing & Versioning (144-150)
21. Story Distribution Summary

---

## Overview

These user stories cover the full HOPE platform surface area, organized from general platform capabilities to deep-dive stories focused on core business entities — Doctor, Department, Prompt, Summary/Pre-Summary, and the medical consultation workflow (101-150).

### Core Business Flow

```
Doctor opens consultation → Records audio → STT transcribes →
Case notes added → Pre-summary generated (from previous consultations or case notes) →
Full summary generated (from generated pre-summary + transcript + department prompt + DNA style) →
Doctor reviews/edits → NER extraction → Consultation finalized
```

---

## Persona Definitions

| Persona | Description |
|---------|-------------|
| **Doctor** | Medical professional using the platform for patient consultation documentation |
| **Admin** | System administrator managing users, roles, departments, prompts, and tenant configuration |
| **Department Head** | Senior doctor or manager overseeing a clinical department's operations and quality |
| **Developer** | Software engineer integrating the `@arcaai/vox` SDK into a client application |
| **User** | Any authenticated user interacting with the frontend interface |
| **QA Engineer** | Quality assurance professional responsible for test coverage and validation |
| **DevOps Engineer** | Infrastructure engineer managing deployment, monitoring, and operations |
| **Security Engineer** | Security professional responsible for platform hardening and compliance |
| **Compliance Officer** | Regulatory affairs professional ensuring HIPAA/GDPR adherence |
| **System** | Automated behavior performed by the platform without user initiation |

---

## Doctor Consultation Workflow (1-15)

| # | User Story |
|---|-----------|
| 1 | As a **doctor**, I want to open a new consultation by entering a patient ID and appointment date, so that I can begin documenting the encounter. |
| 2 | As a **doctor**, I want to record audio during a consultation and see a live transcript appear in real time, so that I don't need to take manual notes. |
| 3 | As a **doctor**, I want to mute/unmute the microphone during a consultation, so that I can pause recording when discussing non-clinical matters. |
| 4 | As a **doctor**, I want to add case notes to a consultation context, so that structured clinical observations are captured alongside the transcript. |
| 5 | As a **doctor**, I want to generate a pre-summary from the consultation transcript, so that I can review an AI-drafted clinical note before finalization. |
| 6 | As a **doctor**, I want to generate a full summary using my department's prompt template and my personal DNA writing style, so that the output matches my documentation preferences. |
| 7 | As a **doctor**, I want to edit an AI-generated summary with a change reason, so that I can correct inaccuracies while maintaining an audit trail. |
| 8 | As a **doctor**, I want to view the version history of a summary, so that I can track how the document evolved over time. |
| 9 | As a **doctor**, I want to compare two versions of a summary side-by-side with a diff view, so that I can see exactly what changed between revisions. |
| 10 | As a **doctor**, I want to generate a comprehensive cross-chain summary spanning multiple consultations, so that referral documentation is complete. |
| 11 | As a **doctor**, I want to search consultations by patient ID and date range, so that I can quickly find past encounters. |
| 12 | As a **doctor**, I want to view a timeline of consultation chains (original, follow-ups, referrals), so that I understand the patient's care journey. |
| 13 | As a **doctor**, I want to load shared context from a referring doctor's consultation, so that I have the full clinical picture before seeing a referred patient. |
| 14 | As a **doctor**, I want the system to extract medical named entities (medications, conditions, procedures) from transcripts automatically, so that clinical data is structured. |
| 15 | As a **doctor**, I want to submit my writing samples to generate a DNA writing style profile, so that AI summaries match my personal documentation style. |

---

## Audio & Transcription (16-25)

| # | User Story |
|---|-----------|
| 16 | As a **doctor**, I want real-time noise cancellation during recording, so that background noise doesn't degrade transcript quality. |
| 17 | As a **doctor**, I want voice activity detection (VAD) to automatically detect when I'm speaking, so that silence segments are excluded from transcription. |
| 18 | As a **doctor**, I want to upload a pre-recorded audio file for transcription, so that I can process recordings from external devices. |
| 19 | As a **doctor**, I want to track the progress of a transcription job (queued, processing, complete), so that I know when results are ready. |
| 20 | As a **doctor**, I want to select my preferred transcription language (English, Hindi, Tamil, Malayalam), so that the ASR model processes my speech correctly. |
| 21 | As a **doctor**, I want code-switching support during transcription (e.g., English-Hindi), so that multilingual consultations are accurately captured. |
| 22 | As a **doctor**, I want speaker diarization in transcripts, so that doctor and patient speech segments are labeled separately. |
| 23 | As a **doctor**, I want to record a 10-second voice sample for speaker embedding, so that the system can identify my voice for better diarization. |
| 24 | As a **doctor**, I want to choose between local (WebAssembly) and remote STT processing, so that I can balance privacy vs. accuracy. |
| 25 | As a **doctor**, I want word-level timestamps in transcriptions, so that I can click on a word and jump to that point in the audio. |

---

## Admin — User Management (26-35)

| # | User Story |
|---|-----------|
| 26 | As an **admin**, I want to create new user accounts with username and password, so that doctors and staff can access the system. |
| 27 | As an **admin**, I want to assign roles (SUPER_ADMIN, TENANT_ADMIN, ADMIN, DOCTOR, NURSE) to users, so that access is appropriately scoped. |
| 28 | As an **admin**, I want to view a paginated list of all users with their role badges, so that I can manage the user directory. |
| 29 | As an **admin**, I want to delete user accounts with a confirmation dialog, so that deactivation requires deliberate action. |
| 30 | As an **admin**, I want to impersonate a non-admin user, so that I can troubleshoot issues they're experiencing. |
| 31 | As an **admin**, I want to see a clear impersonation banner and be able to end the session at any time, so that I don't accidentally perform actions as the wrong user. |
| 32 | As an **admin**, I want to create and manage API keys for users (SDK, webhook, integration, service-account types), so that programmatic access is controlled. |
| 33 | As an **admin**, I want to view API key usage statistics, so that I can monitor access patterns. |
| 34 | As an **admin**, I want to revoke API keys immediately, so that compromised credentials are disabled without delay. |
| 35 | As an **admin**, I want to set IP restrictions on API keys, so that access is limited to known networks. |

---

## Admin — RBAC (36-42)

| # | User Story |
|---|-----------|
| 36 | As an **admin**, I want to create custom roles with a name and description, so that I can define access tiers beyond the defaults. |
| 37 | As an **admin**, I want to create CASL-based access policies (action, subject, conditions, fields), so that fine-grained permissions are enforced. |
| 38 | As an **admin**, I want to assign policies to roles with priority ordering, so that permission resolution follows a deterministic hierarchy. |
| 39 | As an **admin**, I want to define hierarchical roles (parent/child), so that child roles inherit parent permissions. |
| 40 | As an **admin**, I want to mark roles as system roles, so that built-in roles cannot be accidentally modified. |
| 41 | As an **admin**, I want to scope role assignments to specific tenants, so that multi-tenant access boundaries are respected. |
| 42 | As an **admin**, I want to view an audit trail of policy changes, so that RBAC modifications are traceable for compliance. |

---

## Admin — Departments & Prompts (43-52)

| # | User Story |
|---|-----------|
| 43 | As an **admin**, I want to view all medical departments (Medicine, Surgery, Orthopedics, etc.) in a card grid, so that I can see the organizational structure. |
| 44 | As an **admin**, I want to configure per-department prompt assignments (new patient, revisit, summary, DNA style), so that each department generates contextually appropriate outputs. |
| 45 | As an **admin**, I want to create new prompt templates with a name, category (SYSTEM, SUMMARY, DNA_ANALYSIS, CUSTOM), and content, so that AI generation uses curated instructions. |
| 46 | As an **admin**, I want to edit prompt templates with a change reason, so that modifications are versioned and auditable. |
| 47 | As an **admin**, I want to view the version history of a prompt template, so that I can roll back to a previous version if needed. |
| 48 | As an **admin**, I want to compare two prompt versions side-by-side, so that I can review what changed. |
| 49 | As an **admin**, I want to assign a prompt template to a department for a specific field (newPatientPromptId, revisitPromptId, summaryPromptId), so that departments use the right prompts. |
| 50 | As an **admin**, I want to search and filter prompt templates by name and category, so that I can find the right template quickly. |
| 51 | As an **admin**, I want to delete prompt templates with a confirmation dialog, so that removal is deliberate. |
| 52 | As an **admin**, I want to see badges on department cards showing which prompts are configured vs. missing, so that incomplete setups are visible at a glance. |

---

## Admin — System Monitoring (53-60)

| # | User Story |
|---|-----------|
| 53 | As an **admin**, I want to see a real-time service status bar showing health of all microservices (API, STT, SMR, NLP, TTS), so that I know if any service is degraded. |
| 54 | As an **admin**, I want to check system health, liveness, and readiness endpoints, so that I can verify deployment health. |
| 55 | As an **admin**, I want to view service uptime metrics with progress bars, so that I can identify reliability trends. |
| 56 | As an **admin**, I want to see the count of active sessions and processing jobs, so that I understand current system load. |
| 57 | As an **admin**, I want to load tenant-specific configuration by entering a tenant ID, so that I can inspect per-tenant settings. |
| 58 | As an **admin**, I want to view usage statistics (prompt usage, DNA style usage records), so that I understand feature adoption. |
| 59 | As an **admin**, I want to manage AI models in a registry (source, format, compute requirements), so that model deployments are tracked. |
| 60 | As an **admin**, I want to manage storage (MinIO buckets, audio files, reports), so that storage usage is visible and controllable. |

---

## Admin — Pipelines & Tenant Config (61-66)

| # | User Story |
|---|-----------|
| 61 | As an **admin**, I want to configure ASR pipelines per tenant (YAML-based), so that different organizations can use different transcription configurations. |
| 62 | As an **admin**, I want to manage tenant configurations (global settings, feature flags), so that I can customize behavior per organization. |
| 63 | As an **admin**, I want to create and manage tenants (name, key, description), so that the multi-tenant structure is maintained. |
| 64 | As an **admin**, I want to view and search audit logs with distributed tracing (correlationId, causationId), so that I can investigate incidents. |
| 65 | As an **admin**, I want to access Prisma Studio embedded in the admin panel, so that I can inspect and manage database records directly. |
| 66 | As an **admin**, I want to manage global settings as key-value pairs scoped to tenants, so that configuration is flexible and tenant-isolated. |

---

## SDK Developer Experience (67-76)

| # | User Story |
|---|-----------|
| 67 | As a **developer**, I want to configure the SDK via a single `AgenticProvider` with typed `AgenticConfig`, so that initialization is simple and type-safe. |
| 68 | As a **developer**, I want to override the API base URL, API key, tenant ID, and WebSocket URL at runtime via a settings panel, so that I can test against different environments without rebuilding. |
| 69 | As a **developer**, I want a `useArca()` hook that provides session, audio, context, summary, and pipeline methods, so that I have a unified API for all SDK features. |
| 70 | As a **developer**, I want the SDK to support cross-tab session sharing with audio source locking, so that only one tab captures audio at a time. |
| 71 | As a **developer**, I want `withRetry` and error classification utilities (isRetriableError, isNetworkError, isAuthError), so that I can build resilient applications. |
| 72 | As a **developer**, I want diff utilities (computeDiff, computePromptDiff, computeSummaryDiff, createUnifiedPatch), so that I can display content changes. |
| 73 | As a **developer**, I want pipeline control (pause/resume transcription, trigger NER/summarization manually), so that I can orchestrate processing stages. |
| 74 | As a **developer**, I want to build custom processing pipelines with sortable stages and priority ordering, so that I can customize the processing flow. |
| 75 | As a **developer**, I want to select between multiple STT/VAD/NER models from a registry, so that I can optimize for my use case. |
| 76 | As a **developer**, I want the SDK to persist user preferences (language, noise filter level, model selections) with hybrid local/backend sync, so that settings survive across sessions. |

---

## Frontend UI & Navigation (77-85)

| # | User Story |
|---|-----------|
| 77 | As a **user**, I want a collapsible sidebar navigation following the shadcn/ui dashboard-01 pattern, so that I can efficiently navigate between all 23+ pages. |
| 78 | As a **user**, I want breadcrumb navigation in the header showing the current section and page, so that I always know where I am. |
| 79 | As a **user**, I want to toggle between light and dark themes, so that I can use the app comfortably in any lighting. |
| 80 | As a **user**, I want a keyboard shortcut (Cmd/Ctrl+B) to toggle the sidebar, so that I can maximize content area when needed. |
| 81 | As a **user**, I want the sidebar to collapse to icons on smaller screens, so that the layout remains usable on tablets. |
| 82 | As a **user**, I want a mobile-responsive sidebar that opens as a sheet overlay, so that I can navigate on phones. |
| 83 | As a **user**, I want "NEW" badges on recently added sidebar items, so that I can discover new features. |
| 84 | As a **user**, I want collapsible sub-menus in the sidebar (e.g., Admin section expanding to show Overview, Dashboard, Prompts, Departments), so that deeply nested navigation is organized. |
| 85 | As a **user**, I want a connection status badge in the header showing whether the backend is reachable, so that I'm aware of connectivity issues. |

---

## Authentication & Security (86-92)

| # | User Story |
|---|-----------|
| 86 | As a **user**, I want to authenticate via JWT/OIDC so that my identity is verified against an enterprise identity provider. |
| 87 | As a **user**, I want to authenticate via API key so that I can access the system programmatically. |
| 88 | As a **user**, I want login to be gated before any SDK content loads, so that unauthenticated users cannot access clinical data. |
| 89 | As an **admin**, I want HIPAA-compliant audit logging for every data access and modification, so that compliance requirements are met. |
| 90 | As a **security engineer**, I want CSRF protection, rate limiting, and security headers on all API endpoints, so that the platform is hardened against common attacks. |
| 91 | As a **security engineer**, I want multi-tenant data isolation enforced at the database query level, so that tenants cannot access each other's data. |
| 92 | As a **compliance officer**, I want all API keys to display only the raw key once at creation time, so that secrets are never stored in plaintext after initial display. |

---

## Testing & Quality Assurance (93-97)

| # | User Story |
|---|-----------|
| 93 | As a **QA engineer**, I want E2E smoke tests for all 23+ routes verifying that each page renders without JS errors, so that regressions are caught early. |
| 94 | As a **QA engineer**, I want dedicated E2E interaction tests for the admin panel's 10 tabs (Users, Roles, Policies, Pipelines, Prompts, Models, Departments, Storage, Tenants, Statistics), so that admin functionality is validated end-to-end. |
| 95 | As a **QA engineer**, I want E2E tests for edge cases (rapid navigation, browser back/forward, XSS input, special characters, viewport resize), so that the app is robust under unusual conditions. |
| 96 | As a **QA engineer**, I want E2E tests for the transcription and summarization pages with streaming/polling interactions, so that the core AI-powered workflows are validated. |
| 97 | As a **QA engineer**, I want unit tests for all shared business logic services (consultation, user, prompt, tenant, DNA style), so that domain logic is verified in isolation. |

---

## Infrastructure & DevOps (98-100)

| # | User Story |
|---|-----------|
| 98 | As a **DevOps engineer**, I want Docker Compose configurations for local development (PostgreSQL, Redis, MinIO, Qdrant), so that developers can spin up the full stack with one command. |
| 99 | As a **DevOps engineer**, I want Prometheus metrics exposed from all services, so that I can build Grafana dashboards for production monitoring. |
| 100 | As a **DevOps engineer**, I want a 404 catch-all route in the SPA, so that users who hit unknown URLs see a helpful error page instead of a blank screen. |

---

## Consultation Lifecycle & Status (101-110)

These stories address **Gap G4**: no explicit consultation status/lifecycle field in the current schema.

| # | User Story | Priority | Gap |
|---|-----------|----------|-----|
| 101 | As a **doctor**, I want each consultation to have an explicit status (OPEN, RECORDING, TRANSCRIBING, SUMMARIZING, REVIEW, CLOSED), so that I know the current stage of my documentation workflow. | Critical | G4 |
| 102 | As a **doctor**, I want to "close" a consultation to mark it as finalized, so that no further edits are possible without explicit reopening — ensuring clinical documentation integrity. | Critical | G4 |
| 103 | As an **admin**, I want to see a dashboard of consultation statuses across all doctors (how many open, how many closed today), so that I can monitor documentation completion rates. | High | G4 |
| 104 | As a **doctor**, I want the system to prevent generating a summary if no transcript exists yet, so that summaries are always based on actual conversation content. | High | G4 |
| 105 | As a **doctor**, I want to reopen a closed consultation with a reason code (e.g., "correction", "addendum"), so that I can make justified amendments while maintaining audit history. | High | G4 |
| 106 | As a **doctor**, I want automatic status transitions (OPEN -> RECORDING when audio starts, RECORDING -> TRANSCRIBING when audio stops), so that I don't need to manually update the workflow stage. | Medium | G4 |
| 107 | As a **compliance officer**, I want all consultation status changes to be logged in the audit trail with timestamp, user, and reason, so that the lifecycle is fully traceable for regulatory review. | High | G4 |
| 108 | As a **doctor**, I want to see a progress indicator on my consultation showing which steps are complete (audio, transcript, case notes, summary, NER), so that I know what remains. | Medium | G4 |
| 109 | As a **department head**, I want a report showing average time-to-close for consultations in my department, so that I can identify bottlenecks in the documentation workflow. | Medium | G4 |
| 110 | As a **system**, I want to auto-flag consultations that have been open for more than 48 hours, so that incomplete documentation doesn't go unnoticed. | Low | G4 |

---

## Doctor-Department Relationship (111-116)

These stories address **Gap G8**: no direct doctor-department association on the User entity.

| # | User Story | Priority | Gap |
|---|-----------|----------|-----|
| 111 | As an **admin**, I want to assign a doctor to a primary department, so that the system can auto-select the correct department prompt templates when the doctor opens a consultation. | High | G8 |
| 112 | As a **doctor**, I want the system to default to my primary department when opening a new consultation, while allowing me to override to a different department for cross-specialty consults. | High | G8 |
| 113 | As an **admin**, I want to assign a doctor to multiple departments (primary + secondary), so that specialists who work across departments are properly represented. | Medium | G8 |
| 114 | As a **department head**, I want to see all doctors assigned to my department with their consultation counts, so that I can manage workload distribution. | Medium | G8 |
| 115 | As a **doctor**, I want the system to remember which department I last used per patient context, so that follow-up consultations automatically inherit the same department assignment. | Low | G8 |
| 116 | As an **admin**, I want to see a doctor's cross-department consultation history, so that I understand multi-specialty involvement patterns. | Low | G8 |

---

## Prompt Template Lifecycle (117-126)

These stories address **Gap G3** (variable substitution), **Gap G6** (no FK validation), and **Gap G11** (no rollback).

| # | User Story | Priority | Gap |
|---|-----------|----------|-----|
| 117 | As an **admin**, I want prompt template variables (e.g., `{conversation_language}`, `{pre_summary_text}`) to be automatically substituted at generation time, so that templates produce contextually accurate outputs. | Critical | G3 |
| 118 | As an **admin**, I want to define required variables for a prompt template with types and default values, so that the system validates all variables are provided before calling the LLM. | High | G3 |
| 119 | As an **admin**, I want to "activate" a previous prompt template version as the current version, so that I can quickly roll back a bad prompt change without re-entering content. | High | G11 |
| 120 | As an **admin**, I want to preview a prompt template by running it against sample consultation data, so that I can verify the output quality before deploying it to production. | High | — |
| 121 | As an **admin**, I want to A/B test two prompt template versions against the same consultation data, so that I can compare output quality before committing to a new version. | Medium | — |
| 122 | As an **admin**, I want to mark a prompt template as "draft" vs "published", so that in-progress edits don't affect live summary generation. | Medium | — |
| 123 | As an **admin**, I want to clone an existing prompt template from another department, so that I can create specialty variants without starting from scratch. | Medium | — |
| 124 | As an **admin**, I want the system to validate that all department prompt ID references (newPatientPromptId, revisitPromptId, preSummaryPromptId) point to existing templates, so that invalid references are caught before they cause runtime failures. | High | G6 |
| 125 | As an **admin**, I want to see prompt usage analytics (how many times each template was used, across which departments, with what satisfaction scores), so that I can identify underperforming templates. | Medium | — |
| 126 | As an **admin**, I want to receive an alert when a prompt template generates summaries with low doctor-edit rates (indicating high quality) or high edit rates (indicating poor quality), so that I can prioritize template improvements. | Low | — |

---

## Pre-Summary Generation (127-133)

These stories address **Gap G7**: pre-summary content not injected into the final summary prompt.

| # | User Story | Priority | Gap |
|---|-----------|----------|-----|
| 127 | As a **doctor**, I want a pre-summary to be automatically generated from historical case notes when I open a follow-up consultation, so that I have a concise overview of the patient's prior visits without manually reviewing each one. | Critical | G7 |
| 128 | As a **doctor**, I want the pre-summary to be injected as context into the final summary prompt, so that the AI-generated summary incorporates historical findings and ongoing treatment plans. | Critical | G7 |
| 129 | As a **doctor**, I want to review and edit the pre-summary before it's used as context for final summary generation, so that inaccurate historical data doesn't propagate into the current note. | High | — |
| 130 | As a **doctor**, I want the pre-summary to indicate which past consultations contributed to it (with dates and departments), so that I can verify the source material. | High | — |
| 131 | As a **doctor**, I want pre-summaries to be weighted by recency and relevance (recent visits > old visits, same department > different department), so that the most pertinent history is emphasized. | Medium | — |
| 132 | As a **doctor**, I want to regenerate a pre-summary with different weighting (e.g., include only the last 3 visits, or only visits from my department), so that I can control what historical context feeds into my summary. | Medium | — |
| 133 | As a **doctor**, I want pre-summaries for new/referral patients to include shared case notes from the referring doctor's consultation chain, so that the referral context is captured. | High | — |

---

## Full Summary Generation & Department Customization (134-143)

These stories address **Gap G5** (DNA style not applied), **Gap G9** (JSON enforcement missing), and **Gap G3** (variable substitution).

| # | User Story | Priority | Gap |
|---|-----------|----------|-----|
| 134 | As a **doctor**, I want the system to automatically select the correct prompt template based on my department and whether this is a new patient vs follow-up, so that I don't need to manually choose a template each time. | Critical | — |
| 135 | As a **doctor**, I want my DNA writing style to be automatically applied when generating summaries, so that clinical notes match my personal documentation style without manual configuration. | Critical | G5 |
| 136 | As a **doctor**, I want to choose between SOAP format and narrative format for my summary output, with the department default pre-selected, so that I can use the format I prefer. | High | — |
| 137 | As a **doctor**, I want the summary to include department-specific section headings (e.g., "Fitness for Surgery" for Surgery, "Bone Marrow Aspiration & Biopsy" for Hematology), so that the output follows my specialty's documentation standards. | High | — |
| 138 | As a **doctor**, I want the system to retry summary generation with a corrective prompt if the initial output contains placeholders or invalid JSON, so that I receive a usable summary on the first attempt. | High | G9 |
| 139 | As a **doctor**, I want to generate a summary in the same language as the consultation conversation (or a specific target language), so that documentation matches the clinical context. | High | G3 |
| 140 | As a **doctor**, I want the summary to contain source attribution (which transcript segments, case notes, and pre-summaries contributed to each section), so that I can verify claims against the original content. | Medium | — |
| 141 | As a **doctor**, I want to see real-time streaming of the summary as it's generated token-by-token, so that I get immediate feedback instead of waiting for the full generation. | Medium | — |
| 142 | As a **department head**, I want to set a default summary format (SOAP vs narrative) and abbreviation density (high/medium/low) for my department, so that all doctors start with the department standard. | Medium | — |
| 143 | As a **doctor**, I want to regenerate a summary with different parameters (different prompt, different DNA style, include/exclude NER) without losing the previous version, so that I can compare outputs. | Medium | — |

---

## Doctor Review, Editing & Versioning (144-150)

| # | User Story | Priority | Gap |
|---|-----------|----------|-----|
| 144 | As a **doctor**, I want all my edits to a summary to be tracked as a new version with a diff view, so that I can see exactly what I changed and the audit trail is complete. | High | — |
| 145 | As a **doctor**, I want to annotate specific summary sections with correction reasons (e.g., "medication dosage incorrect", "diagnosis updated"), so that the AI can learn from my corrections over time. | Medium | — |
| 146 | As a **doctor**, I want to revert a summary to any previous version, so that I can undo unintended changes. | Medium | — |
| 147 | As a **doctor**, I want to see which parts of a summary were AI-generated vs doctor-edited, so that I can assess AI accuracy for my workflow. | Medium | — |
| 148 | As a **doctor**, I want an "approve" action that marks the summary as doctor-reviewed and locks it from further AI modification, so that my final clinical judgment is preserved. | High | — |
| 149 | As a **doctor**, I want the NER extraction to run automatically after I approve a summary, so that the structured medical entities (medications, conditions, procedures) are extracted from my finalized content. | Medium | — |
| 150 | As a **doctor**, I want to flag specific named entities as incorrect and provide the correct entity, so that the NER model's training data is improved over time. | Low | — |

---

## Story Distribution Summary

| Category | Stories | Count | Primary Persona |
|----------|---------|-------|-----------------|
| Doctor Consultation Workflow | 1-15 | 15 | Doctor |
| Audio & Transcription | 16-25 | 10 | Doctor |
| Admin — User Management | 26-35 | 10 | Admin |
| Admin — RBAC | 36-42 | 7 | Admin |
| Admin — Departments & Prompts | 43-52 | 10 | Admin |
| Admin — System Monitoring | 53-60 | 8 | Admin |
| Admin — Pipelines & Tenant Config | 61-66 | 6 | Admin |
| SDK Developer Experience | 67-76 | 10 | Developer |
| Frontend UI & Navigation | 77-85 | 9 | User |
| Authentication & Security | 86-92 | 7 | Mixed |
| Testing & QA | 93-97 | 5 | QA Engineer |
| Infrastructure & DevOps | 98-100 | 3 | DevOps |
| Consultation Lifecycle & Status | 101-110 | 10 | Doctor / Admin |
| Doctor-Department Relationship | 111-116 | 6 | Admin / Doctor |
| Prompt Template Lifecycle | 117-126 | 10 | Admin |
| Pre-Summary Generation | 127-133 | 7 | Doctor |
| Summary Generation & Customization | 134-143 | 10 | Doctor |
| Doctor Review & Versioning | 144-150 | 7 | Doctor |
| **Total** | **1-150** | **150** | |

### By Priority (Stories 101-150)

| Priority | Count | Stories |
|----------|-------|---------|
| Critical | 8 | 101, 102, 117, 127, 128, 134, 135, 138 (via G9) |
| High | 18 | 103-105, 107, 111-112, 118-119, 120, 124, 129-130, 133, 136-139, 144, 148 |
| Medium | 18 | 106, 108-109, 113-114, 121-123, 125, 131-132, 140-143, 145-147, 149 |
| Low | 6 | 110, 115-116, 126, 150 |

### By Gap Reference (Stories 101-150)

| Gap | Description | Stories |
|-----|-------------|---------|
| G3 | Prompt variable substitution not implemented | 117, 118, 139 |
| G4 | No consultation lifecycle status | 101-110 |
| G5 | DNA style not applied in SMR v2 | 135 |
| G6 | No FK constraints on department prompt IDs | 124 |
| G7 | Pre-summary not injected into final summary | 127, 128 |
| G8 | No doctor-department direct association | 111-116 |
| G9 | JSON enforcement not integrated | 138 |
| G11 | No prompt rollback mechanism | 119 |

---

## Related Documentation

- [Project Brief & Requirements](./01_PROJECT_BRIEF_AND_REQUIREMENTS.md) — Business context, SOW, feature scope
- [Technical Architecture](./02_TECHNICAL_ARCHITECTURE.md) — System architecture, data model, communication patterns
- [Quality Control](./03_QUALITY_CONTROL.md) — Testing strategy, CI/CD pipeline, coverage targets
- [Access Control](./04_ACCESS_CONTROL.md) — Authentication, RBAC, tenant isolation, audit logging
- [API List](./05_API_LIST.md) — Full API endpoint reference
