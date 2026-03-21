# Project Brief, Requirements & Scope of Work

> **Project**: HOPE — Hybrid Agentic Medical Conversation System
> **Last Updated**: 2026-02-19

---

## Table of Contents

1. [Project Brief](#project-brief)
2. [Problem Statement](#problem-statement)
3. [Vision and Goals](#vision-and-goals)
4. [Target Audience](#target-audience)
5. [Functional Requirements](#functional-requirements)
6. [Non-Functional Requirements](#non-functional-requirements)
7. [Scope of Work](#scope-of-work)
8. [Key Features — MVP](#key-features--mvp)
9. [Post-MVP Features](#post-mvp-features)
10. [Technical Constraints](#technical-constraints)
11. [Success Metrics](#success-metrics)
12. [Risk Assessment](#risk-assessment)
13. [Acceptance Criteria](#acceptance-criteria)
14. [Assumptions and Exclusions](#assumptions-and-exclusions)

---

## Project Brief

HOPE is a **cloud-first, self-hosted, modular, AI-native healthcare platform** that captures, processes, and summarizes medical conversations in real time. It replaces an existing Azure-dependent system with a microservices-first, privacy-first architecture featuring intelligent client-side progressive enhancement.

The platform combines reliable cloud processing for consistent performance with progressive client-side AI enhancement for privacy and reduced latency, creating a comprehensive solution that saves doctors time while improving documentation quality.

---

## Problem Statement

Healthcare professionals spend significant time on documentation, often missing critical details during patient conversations and struggling with manual note-taking that disrupts the natural flow of medical consultations. Current solutions:

- Lack real-time multilingual support
- Fail to provide intelligent medical summaries
- Lack comprehensive feedback mechanisms for continuous improvement
- Lack the flexibility needed for diverse medical environments with varying backend system integrations

---

## Vision and Goals

**Vision**: Transform medical documentation by providing doctors with an intelligent AI assistant that captures, understands, and summarizes patient conversations in real-time through cloud-first processing with intelligent client-side enhancement.

### Primary Goals

| # | Goal | Target |
|---|------|--------|
| 1 | Real-time conversation transcription | <2s cloud latency (Tier 1) → <500ms client-side (Tier 3) |
| 2 | Transcription accuracy | 95%+ via cloud processing, feedback integration, and continuous model improvement |
| 3 | Intelligent medical summaries | <2 seconds using domain-driven backend LLM services |
| 4 | Batch audio processing | Upload queuing, job status tracking, result retrieval |
| 5 | Scalability | 1000+ concurrent doctors, 99.9% availability |
| 6 | Progressive privacy | Cloud baseline (Tier 1) → Local processing (Tier 3) with MLFlow model management |

---

## Target Audience

### Primary Users

Medical doctors and healthcare professionals across diverse practice settings.

| Attribute | Detail |
|-----------|--------|
| Profile | Technology-comfortable healthcare providers seeking efficiency improvements |
| Environments | Single-doctor clinics to large hospital networks, urban and rural, telehealth |
| Languages | English and Malayalam (expandable) |
| Device Requirements | Modern web browser; 4 GB RAM baseline, 8 GB recommended for Tier 3 |
| Workflow | Seamless integration with existing practice management systems via React web interface and NestJS backend APIs |

### Secondary Users

- Healthcare administrators and IT departments responsible for deployment and management
- Healthcare software developers requiring AgenticSDK integration for medical conversation processing

---

## Functional Requirements

### Core Processing

- Real-time STT from doctor's speech input with speaker diarization
- Contextual summarization based on specialty and historical data (SOAP / narrative notes)
- Real-time TTS playback of generated notes or instructions
- Medical entity recognition (ICD-10, SNOMED code mapping)
- Alert generation from clinical rules or ML insights
- Personalization of documentation style per doctor
- Feedback system for continuous improvement (transcript corrections, quality ratings)

### Medical Workflow

- Consultation lifecycle management (create, update, close)
- Audio recording with session management and crash recovery
- Case notes and work notes during consultations
- AI-powered summary generation (sync and async)
- Named entity recognition with medical terminology correction
- Activity tracking and version control for all document changes

### Integration

- Full integration with EHR/HMS systems (FHIR-compliant APIs planned)
- Multi-language support (English, Malayalam; Hindi, Tamil planned)
- Batch audio processing (wav, mp3, m4a) with job queuing (BullMQ) and status tracking

---

## Non-Functional Requirements

| Category | Specification |
|----------|---------------|
| **Latency** | STT: <800ms/chunk, Summary: <2s, TTS: <1.5s |
| **Availability** | 99.95% uptime |
| **Scalability** | Horizontal auto-scaling of AI microservices |
| **Security** | TLS 1.3, RBAC (CASL), AES-256 at rest |
| **Compliance** | HIPAA, GDPR, NDHM adherence |
| **Observability** | Centralized logging (Loki), metrics (Prometheus), dashboards (Grafana), tracing (OpenTelemetry) |
| **Modularity** | Swappable STT/LLM/TTS backends via service abstraction |
| **Multi-tenancy** | All data scoped by `tenantId` with policy-based isolation |

---

## Scope of Work

### Core Deliverables

#### 1. AI Microservices

| Service | Description | Latency Target |
|---------|-------------|----------------|
| **STT Service** | Healthcare-optimized speech-to-text (Whisper ONNX, NeMo, Azure), VAD (Silero v5), diarization (Pyannote) | <800ms per 15s chunk |
| **SMR Service** | Adaptive summarizer — multi-LLM (Azure OpenAI, Ollama), specialty-specific prompts, SOAP/narrative generation | <2s per summary |
| **TTS Service** | Multi-lingual text-to-speech (Azure TTS, 400+ voices, 140+ languages), batch synthesis, WebSocket streaming | <1.5s per synthesis |
| **NLP Service** | Medical NLP — text classification, NER (medical entities), diagnosis classification, spell correction | <500ms per request |
| **Feedback Handler** | User feedback collection, integration with reinforcement learning pipeline, privacy-compliant handling | — |
| **Federated Learning** | MLFlow-integrated orchestrator, global coordination server + customer-deployed client nodes, zero data exfiltration | — |

#### 2. Platform Infrastructure

| Component | Technology |
|-----------|-----------|
| API Gateway | NestJS with JWT/OIDC/API Key auth, RBAC, rate limiting, WebSocket proxy |
| Database | PostgreSQL (multi-tenant, Prisma ORM) |
| Cache & Queue | Redis (BullMQ for async jobs, pub/sub for events) |
| Object Storage | MinIO (S3-compatible — audio, reports, model artifacts) |
| Vector Database | Qdrant (speaker embeddings, semantic search) |
| Secrets Management | HashiCorp Vault |
| Monitoring | Prometheus + Grafana + Loki |
| Model Registry | MLflow with experiment tracking and versioning |

#### 3. API Development

- Consultation APIs (CRUD, lifecycle management)
- Context item APIs (transcripts, case notes, summaries, audio recordings)
- Summary APIs (sync/async generation, job status)
- STT/TTS proxy APIs (session management, WebSocket forwarding)
- NLP APIs (NER, classification, diagnosis)
- Admin APIs (roles, policies, departments, prompts, API keys)
- Audit log APIs (query, resource, user activity)

#### 4. Deployment and Orchestration

- Docker containers for all microservices (multi-stage builds)
- Docker Compose for local development and CI
- Kubernetes manifests with Helm charts (in progress)
- CI/CD via GitHub Actions and GitLab CI
- Container registry setup

#### 5. Client SDK

- `@arcaai/vox` — React SDK for medical consultations
- Audio processing plugins: Room, VAD, Noise Filter, Pipeline, Med-NER
- Progressive enhancement (Tier 1-3 based on device capabilities)
- SDK usage examples and common integration patterns

---

## Key Features — MVP

### Progressive Enhancement Tiers

| Tier | RAM | Capabilities | Processing |
|------|-----|-------------|-----------|
| **Tier 1 — Baseline** | 2 GB | Cloud STT, manual editing, basic reports | All server-side |
| **Tier 2 — Enhanced** | 4 GB | Real-time streaming, entity highlighting, offline recording | Hybrid |
| **Tier 3 — Optimized** | 8 GB | Client-side STT (WASM/Whisper), local NLP, full offline | Mostly client-side |

### Core Features

- **Real-time conversation capture** with cloud-first audio processing and progressive client-side enhancement
- **Hybrid processing architecture** — cloud STT baseline with progressive local enhancement
- **Medical entity recognition** — ICD-10 and SNOMED code mapping
- **AI-powered medical report generation** — consultation summaries, progress notes, discharge summaries
- **Comprehensive session management** — start/pause/resume, crash recovery, multi-device sync
- **Multi-tenant RBAC** — policy-based, database-level filtering, audit trail
- **Batch audio processing** — upload queuing, job tracking, result retrieval via SSE/WebSocket

---

## Post-MVP Features

### Advanced AI

- GPU-accelerated client-side processing (WebGPU, Tier 4)
- Privacy-preserving federated learning with A/B testing
- Extended language support (Hindi, Tamil, regional languages)
- Drug interaction detection, symptom correlation, diagnostic suggestions
- Clinical decision support integration

### Enterprise Integration

- FHIR-compliant APIs for EMR/EHR systems
- Advanced analytics dashboard (practice insights, quality metrics)
- Voice biometrics for personalized doctor models
- Mobile applications with offline capabilities
- Enhanced HIPAA/GDPR compliance automation

### Advanced Workflows

- Multi-patient conversation support (family consultations, team meetings)
- Conversation intelligence (protocol adherence, quality improvement)
- Automated quality scoring and peer review workflows

---

## Technical Constraints

| Constraint | Details |
|-----------|---------|
| **Browser** | Modern browsers with WebAssembly (Tier 3), WebAudio API, IndexedDB, WebSocket |
| **Device** | Tier 1: 2 GB RAM, Tier 2: 4 GB RAM, Tier 3: 8 GB RAM |
| **Model Size** | <10 MB cloud access, <50 MB enhanced models, <100 MB full client-side |
| **Latency** | Tier 1: <2s cloud STT, Tier 2: <1s enhanced, Tier 3: <500ms client-side |
| **Network** | Cloud-first with progressive offline enhancement |
| **Language** | Initial: English + Malayalam; extensible architecture |
| **Privacy** | Cloud baseline with encryption → Enhanced local processing → Full local (Tier 3) |

---

## Success Metrics

### Achieved (STT/TTS Services)

| Metric | Value |
|--------|-------|
| STT End-to-end latency | ~100-200ms |
| TTS Synthesis latency | <2s standard, <5s batch |
| System availability | 99.9% with health monitoring |
| Concurrent capacity | 50+ STT sessions, 100+ TTS sessions per instance (auto-scaling) |
| Multi-language | English + Malayalam STT; 140+ languages TTS |

### Target Metrics (Full Platform)

| Metric | Target |
|--------|--------|
| Cloud STT latency | <2s (Tier 1), <1s (Tier 2), <500ms (Tier 3) |
| Medical report generation | <2 seconds |
| Doctor satisfaction | >90% approval on transcription accuracy and report quality |
| Documentation time savings | 50%+ reduction per consultation |
| Concurrent capacity | 1000+ simultaneous conversations |
| User feedback engagement | 80%+ participation in model improvement |

---

## Risk Assessment

| Category | Risk | Mitigation |
|----------|------|-----------|
| **Technical** | Model performance, latency targets | Rigorous testing, alternative model options, progressive enhancement fallbacks |
| **Security** | Data breaches, compliance violations | Security audits, penetration testing, comprehensive audit logging |
| **Integration** | EHR/HMS compatibility | Early integration testing, API validation, FHIR compliance |
| **Browser** | Inconsistent WebAssembly support | Progressive enhancement with guaranteed cloud fallbacks |
| **Privacy** | Patient data compliance | Progressive privacy architecture, AES-256 encryption, comprehensive audit trails |
| **Memory** | Browser memory leaks during long sessions | Memory monitoring, progressive model loading, session management |
| **Reliability** | Backend service failures | Microservices resilience, intelligent fallback mechanisms, error handling |

---

## Acceptance Criteria

1. Successful deployment of all microservices per specifications
2. Demonstration of all functional requirements
3. Verification of non-functional requirements through testing (90% unit, 80% integration coverage)
4. Completion of security and compliance validation
5. Successful User Acceptance Testing (UAT)
6. Delivery of complete documentation package

---

## Assumptions and Exclusions

### Assumptions

- Customer provides timely access to existing systems and data for integration
- Technical specification serves as the definitive requirements source
- Customer provides clear feedback during development and UAT phases
- Required third-party services/APIs will be made available

### Exclusions

- Hardware procurement and data center infrastructure
- Ongoing operational costs post-deployment
- Data migration from existing Azure systems (separate scope)
- End-user training beyond documentation and train-the-trainer sessions
- Features not explicitly defined in the technical specification

---

## Related Documentation

- [Technical Architecture](./02_TECHNICAL_ARCHITECTURE.md) — System architecture, data model, communication patterns
- [Quality Control](./03_QUALITY_CONTROL.md) — Testing strategy, CI/CD pipeline, coverage targets
- [Access Control](./04_ACCESS_CONTROL.md) — Authentication, RBAC, tenant isolation, audit logging
