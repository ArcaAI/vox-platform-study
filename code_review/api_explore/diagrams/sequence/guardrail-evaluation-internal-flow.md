# Internal Guardrail Evaluation Ingestion Flow (`guardrail-evaluation-internal-flow`)

> **Interactive Diagram:** [`guardrail-evaluation-internal-flow.html`](guardrail-evaluation-internal-flow.html)  
> **Source Repository:** [ArcaAI/project-hope](https://github.com/ArcaAI/project-hope/tree/dev-2.2)  
> **Target Branch:** `dev-2.2`  
> **Verified Revision:** `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`

---

## 1. Overview & API Endpoints

This document provides architectural documentation and code references for the **guardrail-evaluation-internal-flow** workflow registered in the API Gateway.

- **Primary Route:** `POST /api/v1/internal/guardrail/evaluations`
- **Handler Method:** [`GuardrailEvalIntCtrl.ingest()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/guardrail-evaluation-internal/guardrail-evaluation-internal.controller.ts#L64-L74)
- **Source File:** [`apps/api/src/modules/guardrail-evaluation-internal/guardrail-evaluation-internal.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/guardrail-evaluation-internal/guardrail-evaluation-internal.controller.ts#L64-L74)
- **Functional Summary:** Internal service-to-service ingestion of asynchronous guardrail evaluation verdicts, confidence scores, and safety flags.

---

## 2. Sequence Diagram Architecture

Open the interactive HTML diagram [`guardrail-evaluation-internal-flow.html`](guardrail-evaluation-internal-flow.html) to view full SVG lifelines, participant activations, and inspect the code evidence passport beacons.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Caller / Client
    participant GW as API Gateway (NestJS)
    participant Ctrl as GuardrailEvalIntCtrl
    participant Svc as Domain Service
    participant DB as Postgres (Prisma)
    participant Engine as Guardrail Engine Node

    Client->>GW: POST /api/v1/internal/guardrail/evaluations
    GW->>Ctrl: Route to ingest()
    Ctrl->>Svc: Invoke domain business logic
    Svc->>Engine: Evaluate Safety Rules / Probe Health
    Engine-->>Svc: Safety Verdict / Node Status
    Svc->>DB: Query / Persist Evaluation Records
    DB-->>Svc: Persisted Entity Result
    Svc-->>Ctrl: Processed Domain DTO
    Ctrl-->>GW: Formatted DTO Response
    GW-->>Client: 200 / 202 Response Payload
```

---

## 3. Code References & Verification (dev-2.2)

| Participant / Layer | Local Repository Path | Source Method / Symbol | GitHub Blob URL (`dev-2.2`) |
|---|---|---|---|
| API Gateway | `apps/api/src/main.ts` | Bootstrap & Routing | [main.ts#L1](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/main.ts#L1) |
| Controller | `apps/api/src/modules/guardrail-evaluation-internal/guardrail-evaluation-internal.controller.ts` | `GuardrailEvalIntCtrl.ingest()` (L64-74) | [guardrail-evaluation-internal.controller.ts#L64-L74](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/guardrail-evaluation-internal/guardrail-evaluation-internal.controller.ts#L64-L74) |

---

## 4. Dependencies & Services

### Injected NestJS Services
- **GuardrailEvaluationInternalService**
- **InternalServiceTokenGuard**
- **PrismaService**

### Data Stores & External Systems
- PostgreSQL (GuardrailEvaluation, EvaluationMetric tables)
- Internal Mutual TLS / Service Tokens

---

## 5. HTTP Status Codes & Error Handling

| Status Code | Description | Condition |
|---|---|---|
| `200 OK` / `202 Accepted` | Success | Request validated, evaluated, and processed successfully. |
| `400 Bad Request` | Validation Error | Malformed body, missing required query/body fields. |
| `401 Unauthorized` | Auth Failure | Missing, expired, or malformed JWT Bearer token or service secret. |
| `403 Forbidden` | Access Denied | Insufficient permissions or tenant boundary violation. |
| `404 Not Found` | Not Found | Target evaluation entity or consultation does not exist. |
| `429 Too Many Requests` | Rate Limited | Request rate limit or token quota exceeded. |
| `500 Internal Error` | Server Failure | Unhandled exception or downstream dependency failure. |
