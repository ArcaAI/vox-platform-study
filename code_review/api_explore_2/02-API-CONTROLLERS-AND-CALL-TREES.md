# API Controllers & Hierarchical Call Trees

This document answers the user's second and third questions:
1. **What code is handling those APIs?** (Exact Controller class, source file, handler method name, parameters, and decorators).
2. **What other APIs or Services does that handler function call in a tree manner?** (The hierarchical execution call tree from HTTP Controller → Injected Application Service → Domain Repositories → Downstream Microservices / Databases / Queues).

---

## 1. Architectural Call Hierarchy (The "Three-Tier Rule")

The HOPE gateway follows a strict three-tier architecture:

```
[Layer 1: Gateway / HTTP Plane] 
  apps/api/src/modules/<feature>/<name>.controller.ts
  • Terminates HTTP/WS, parses DTOs, validates headers, enforces Guards & Decorators.
  • Injects Application Service Interfaces (Tokens).
          │
          ▼ calls
[Layer 2: Application Plane]
  packages/applications/src/services/<domain>/<name>.service.ts
  • Coordinates business use cases, checks entity state machines, emits audit events.
  • Injects Domain Repositories, Temporal Clients, and External Microservice Clients.
          │
          ▼ calls
[Layer 3: Domain & Infrastructure Plane]
  packages/domains / packages/database / Downstream Microservices
  • Prisma PostgreSQL ORM (tenant-isolated via ClsService tenant context).
  • Downstream Python AI services (STT, Text, TTS, NLP, Guardrail).
  • Infrastructure: Redis (queues & tickets), S3/MinIO (blobs), Temporal (workflows).
```

---

## 2. Deep-Dive Call Trees for Core Workflows

### Flow 1: Clinical Consultation Lifecycle & Note Generation

#### A. Creating a New Consultation
- **Route:** `POST /api/v1/consultations`
- **Controller:** [`ConsultationController.create`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts)
- **Call Tree:**
```text
POST /api/v1/consultations
  └── ConsultationController.create(dto: CreateConsultationRequest)
        │  [Guards: UnifiedAuthGuard (checks 'create:Consultation'), PatientConsentGuard]
        ├── calls: this.consultationService.create(dto)
        │     └── ConsultationService.create() [@arcaai/applications]
        │           ├── calls: this.consultationRepository.create(data) [@arcaai/domains]
        │           │     └── Prisma Database: INSERT INTO "Consultation" (tenant-scoped)
        │           ├── calls: this.eventEmitter.emit('consultation.created', event)
        │           │     └── Redis / Event Bus notifies background listeners
        │           └── calls: this.timelineService.recordEvent(...)
        │                 └── Appends initial timeline marker into ConsultationTimeline
        └── returns: ConsultationResponse
```

#### B. Triggering Asynchronous Note Generation (SOAP Note)
- **Route:** `POST /api/v1/consultations/:id/summary`
- **Controller:** [`ConsultationController.generateSummaryAsync`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts)
- **Call Tree:**
```text
POST /api/v1/consultations/:id/summary
  └── ConsultationController.generateSummaryAsync(id, request)
        │  [Guards: UnifiedAuthGuard, PatientConsentGuard]
        ├── calls: this.verifyConsultationOwnership(id)
        │     └── checks caller doctorId matches consultation or has manage privileges
        ├── calls: this.consultationJobService.runIdempotent(key, task)
        │     └── Redis distributed lock ensures only ONE note generation runs per ID
        └── calls: this.startHarnessSummaryJob(id, request, tenantId, userId)
              └── calls: this.noteGenerationService.generate(GenerationTrigger.SUMMARY_REGENERATE, payload)
                    └── NoteGenerationService.generate() [@arcaai/applications]
                          ├── calls: this.harnessWorkflowClient.startWorkflow(...)
                          │     └── Temporal Orchestrator: Launches "HarnessLoopWorkflow"
                          │           ├── Phase 1: Guides (Load prompt templates & clinical rules)
                          │           ├── Phase 2: Generate (Call Python Text / LLM Service)
                          │           ├── Phase 3: Sensors (Calculate groundedness & citation scores)
                          │           └── Phase 4: Gate (Evaluate pass/fail criteria)
                          └── returns: { jobId, status: 'pending' }
```

#### C. Doctor Review & Attestation (Signature Lock)
- **Route:** `POST /api/v1/consultations/:id/approve`
- **Controller:** [`ConsultationController.approve`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts)
- **Call Tree:**
```text
POST /api/v1/consultations/:id/approve
  └── ConsultationController.approve(id, dto: ApproveConsultationDto)
        │  [Guards: UnifiedAuthGuard (doctor JWT only), PatientConsentGuard]
        ├── calls: this.verifyConsultationOwnership(id)
        ├── calls: this.consultationService.approve(id, doctorId, signature)
        │     └── ConsultationService.approve() [@arcaai/applications]
        │           ├── validates: Consultation status is in GENERATED / REVIEW state
        │           ├── calls: this.consultationRepository.update(id, { state: 'SIGNED', attestedBy: doctorId })
        │           │     └── Prisma Database: WORM (Write Once Read Many) state transition
        │           ├── calls: this.eventEmitter.emit('consultation.attested', event)
        │           └── calls: this.auditLogService.record(...)
        │                 └── AuditLogRepository: Compliance audit record with doctor attribution
        └── returns: ConsultationResponse (locked against future edits)
```

---

### Flow 2: Live Speech-to-Text Audio Streaming (WebSocket)

#### A. Generating the Stream Ticket
- **Route:** `POST /api/v1/auth/stream-ticket`
- **Controller:** [`AuthController.generateStreamTicket`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/auth/auth.controller.ts)
- **Call Tree:**
```text
POST /api/v1/auth/stream-ticket
  └── AuthController.generateStreamTicket(request)
        │  [Guards: UnifiedAuthGuard]
        ├── calls: this.streamTicketService.issueTicket({ tenantId, userId, scope: 'stt_session' })
        │     └── StreamTicketService.issueTicket() [@arcaai/applications]
        │           ├── generates cryptographically random token UUID
        │           ├── calls: this.redisClient.setEx(`ticket:${token}`, 30, serializedMetadata)
        │           │     └── Redis: Stores ticket with strict 30-second TTL (single-use)
        │           └── returns: { ticket: token, expiresIn: 30 }
        └── returns ticket to client for WebSocket handshake
```

#### B. WebSocket Connection & Binary Audio Pipeline
- **Route:** `/ws/stt/stream?ticket=<token>`
- **Gateway:** [`SttWsGateway`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/speech/stt-ws.gateway.ts)
- **Call Tree:**
```text
WS /ws/stt/stream?ticket=<token>
  └── SttWsGateway.handleConnection(socket, request)
        ├── calls: this.streamTicketService.consumeTicket(ticket)
        │     └── Redis: Atomically GET and DELETE ticket (enforces single-use)
        ├── calls: this.originRegistry.validateOrigin(origin, tenantId)
        │     └── OriginTenantBindingGuard assertion: prevents unauthorized browser embeddings
        ├── calls: this.sttSessionManager.createSession(...)
        │     └── Establishes upstream connection to Python STT Service (port 8861)
        │
  ├── [On Message: Binary Audio Frames (PCM 16kHz)]
  │     └── SttWsGateway.handleAudioChunk(socket, buffer)
  │           ├── forwards buffer via TCP/IPC to downstream Python STT Engine (Whisper / FastConformer)
  │           └── receives real-time partial transcript events
  │                 └── pushes JSON { type: 'PARTIAL_TRANSCRIPT', text: '...' } to client socket
  │
  └── [On Message: 'STOP_RECORDING']
        └── SttWsGateway.handleStop(socket)
              ├── calls: Python STT Engine to finalize transcription and speaker diarization
              ├── calls: this.consultationService.appendTranscript(sessionId, finalTranscript)
              └── emits: 'transcription.completed' to trigger auto-pipeline summarization
```

---

### Flow 3: Downstream Text Generation Proxy (LLM Service)

- **Route:** `POST /api/v1/text-generations`
- **Controller:** [`TextProxyController.generate`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts)
- **Call Tree:**
```text
POST /api/v1/text-generations
  └── TextProxyController.generate(body, headers)
        │  [Guards: UnifiedAuthGuard, TieredThrottlerGuard]
        ├── calls: this.entitlementsService.checkQuota(tenantId, 'llm_tokens')
        │     └── Verifies tenant monthly spend limit / token budget has not been exceeded
        ├── calls: this.aiRoutingPolicyService.resolveModel(tenantId, task: 'text_generation')
        │     └── Resolves active model configuration (e.g., Azure OpenAI, LM Studio, Bedrock, Ollama)
        ├── calls: this.guardrailRelay.preEvaluate(prompt)
        │     └── Calls Python Guardrail Service: Checks prompt for injection, PII, and unsafe content
        │           ├── If blocked: throws GuardrailViolationException (HTTP 422)
        │           └── If clean: proceeds to generation
        ├── calls: this.httpService.post(pythonTextServiceUrl + '/generate', payload)
        │     └── HTTP call to Downstream Python Text Microservice (port 8862)
        │           └── Dispatches inference to LLM Provider
        ├── calls: this.usageLedgerService.recordTokenUsage(...)
        │     └── Appends token count and compute latency into UsageLedger (PostgreSQL / Redis)
        └── returns: GeneratedTextResponse
```

---

### Flow 4: Harness Policy & Temporal Orchestration

- **Route:** `POST /api/v1/internal/harness/callback`
- **Controller:** [`HarnessInternalController.receiveStepCallback`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/harness-internal.controller.ts)
- **Call Tree:**
```text
POST /api/v1/internal/harness/callback
  └── HarnessInternalController.receiveStepCallback(payload)
        │  [Guards: HarnessServiceTokenGuard (validates internal service secret)]
        ├── calls: this.harnessAssuranceService.updateStepProgress(payload)
        │     └── Stores sensor scores (e.g. UMLS term coverage, hallucination risk)
        ├── calls: this.redisPublisher.publish(`harness:progress:${consultationId}`, payload)
        │     └── Broadcasts progress to SSE listener on doctor's browser
        ├── calls: this.consultationRepository.updateDraftSection(...)
        │     └── Updates intermediate SOAP note section (Subjective, Objective, Assessment, Plan)
        └── returns: { acknowledged: true }
```

---

### Flow 5: Agent Governance & Dynamic Routing

- **Route:** `POST /api/v1/admin/agent-assignments`
- **Controller:** [`AgentAssignmentAdminController.create`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/agent-admin/agent-assignment-admin.controller.ts)
- **Call Tree:**
```text
POST /api/v1/admin/agent-assignments
  └── AgentAssignmentAdminController.create(request: UpsertAgentAssignmentRequest)
        │  [Guards: UnifiedAuthGuard ('manage:Agent'), @ForbidApiKey()]
        ├── calls: this.assignments.upsert(request)
        │     └── AgentAssignmentService.upsert() [@arcaai/applications]
        │           ├── calls: this.agentRepository.findPublishedActiveBySlug(tenantId, slug)
        │           │     └── Verifies the targeted agent is PUBLISHED, ACTIVE, and owned by tenant
        │           ├── calls: this.departmentRepository.findDepartment(departmentId)
        │           │     └── Enforces tenant isolation (department must belong to caller tenant)
        │           ├── calls: this.assignmentRepository.upsertAssignment(data)
        │           │     └── Prisma Database: Writes new assignment row
        │           ├── calls: this.changeRepository.appendChangeLog(...)
        │           │     └── WORM Audit Trail: Appends reason & actor into ChangeHistory
        │           └── returns: AgentAssignmentResponse
        ├── calls helper: this.withLanguageWarnings(assignment)
        │     └── calls: this.languageCapability.warningsForAgent(tenantId, agentSlug)
        │           └── AsrLanguageCapabilityService [@arcaai/applications]
        │                 └── Analyzes if ASR model only partially supports requested languages
        └── returns: AgentAssignmentResponse (with advisory language warnings if applicable)
```

---

## 3. Full Call Tree Index

For the full list of all 818 routes, their exact controller handlers, and their extracted call trees:
- Open [`inventory/call-trees-by-module.md`](file:///Users/apple/repos/VOX/review/api_explore_2/inventory/call-trees-by-module.md) to inspect every module in detail.
- Query [`inventory/api-route-call-tree-catalog.json`](file:///Users/apple/repos/VOX/review/api_explore_2/inventory/api-route-call-tree-catalog.json) programmatically for automated tooling or IDE integration.
