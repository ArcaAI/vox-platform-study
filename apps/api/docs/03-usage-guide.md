# API Gateway Usage Guide

**Version**: 2.0
**Last Updated**: 2026-02-22
**Audience**: Frontend Developers, Integration Partners, Third-party Developers

## Table of Contents

- [Introduction](#introduction)
- [Authentication](#authentication)
- [API Endpoints](#api-endpoints)
- [Request & Response Formats](#request--response-formats)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [WebSocket Communication](#websocket-communication)
- [SDK Integration](#sdk-integration)
- [Code Examples](#code-examples)
- [Best Practices](#best-practices)

---

## Introduction

The HOPE API Gateway provides a comprehensive REST API for managing medical conversation sessions, real-time audio transcription, and medical text analysis. This guide provides practical examples for integrating with the API.

### Base URLs

| Environment     | Base URL                       | WebSocket URL                |
| --------------- | ------------------------------ | ---------------------------- |
| **Development** | `http://localhost:8868`        | `ws://localhost:8868`        |
| **Staging**     | `https://staging-api.hope.com` | `wss://staging-api.hope.com` |
| **Production**  | `https://api.hope.com`         | `wss://api.hope.com`         |

All public API endpoints use the `/api/v1` prefix (e.g., `http://localhost:8868/api/v1/sessions`).

### Interactive Documentation

Access the interactive Swagger UI:

- **Development**: http://localhost:8868/api/v1/docs
- **Staging**: https://staging-api.hope.com/api/v1/docs (requires authentication)

---

## Authentication

The API Gateway supports three authentication methods:

### 1. API Key Authentication (Recommended for Service-to-Service)

Include the API key in the request header:

```http
X-API-Key: your-api-key-here
```

**Example:**

```bash
curl -X GET https://api.hope.com/api/v1/sessions \
  -H "X-API-Key: sk_live_abc123..."
```

### 2. JWT Bearer Token (Recommended for Web/Mobile Apps)

Include the JWT token in the Authorization header:

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Example:**

```bash
curl -X GET https://api.hope.com/api/v1/sessions \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### 3. OIDC Authentication (Enterprise SSO)

For web applications using enterprise SSO:

```javascript
// Redirect to OIDC login
window.location.href = 'https://api.hope.com/auth/oidc/login';

// Handle callback
// GET /auth/oidc/callback?code=...
```

---

## API Endpoints

### Health & Monitoring

#### Check API Health

```http
GET /health
```

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:45.123Z",
  "uptime": 86400
}
```

#### Detailed Health Check

```http
GET /health/ready
```

**Response:**

```json
{
  "status": "ok",
  "info": {
    "database": {
      "status": "up"
    },
    "redis": {
      "status": "up"
    },
    "sttService": {
      "status": "up"
    }
  },
  "details": {
    "database": {
      "status": "up",
      "responseTime": "12ms"
    }
  }
}
```

---

### Session Management

#### Create a New Session

```http
POST /api/v1/sessions
Content-Type: application/json
X-API-Key: your-api-key
```

**Request Body:**

```json
{
  "patientId": "patient_123",
  "sessionType": "CONSULTATION",
  "metadata": {
    "doctorName": "Dr. Smith",
    "department": "Cardiology",
    "appointmentType": "Follow-up"
  }
}
```

**Response (201 Created):**

```json
{
  "id": "session_456",
  "patientId": "patient_123",
  "sessionType": "CONSULTATION",
  "status": "ACTIVE",
  "metadata": {
    "doctorName": "Dr. Smith",
    "department": "Cardiology",
    "appointmentType": "Follow-up"
  },
  "createdAt": "2024-01-15T10:30:45.123Z",
  "updatedAt": "2024-01-15T10:30:45.123Z"
}
```

**cURL Example:**

```bash
curl -X POST https://api.hope.com/api/v1/sessions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sk_live_abc123..." \
  -d '{
    "patientId": "patient_123",
    "sessionType": "CONSULTATION",
    "metadata": {
      "doctorName": "Dr. Smith",
      "department": "Cardiology"
    }
  }'
```

#### Get Session by ID

```http
GET /api/v1/sessions/:id
X-API-Key: your-api-key
```

**Response (200 OK):**

```json
{
  "id": "session_456",
  "patientId": "patient_123",
  "sessionType": "CONSULTATION",
  "status": "ACTIVE",
  "metadata": {},
  "createdAt": "2024-01-15T10:30:45.123Z",
  "updatedAt": "2024-01-15T10:35:12.456Z"
}
```

#### List Sessions (Paginated)

```http
GET /api/v1/sessions?page=1&limit=20&sortBy=createdAt&sortOrder=desc
X-API-Key: your-api-key
```

**Response (200 OK):**

```json
{
  "data": [
    {
      "id": "session_456",
      "patientId": "patient_123",
      "sessionType": "CONSULTATION",
      "status": "ACTIVE",
      "createdAt": "2024-01-15T10:30:45.123Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

#### Get Sessions by Patient

```http
GET /api/v1/sessions/patient/:patientId?page=1&limit=10
X-API-Key: your-api-key
```

**Response (200 OK):**

```json
{
  "data": [
    {
      "id": "session_456",
      "patientId": "patient_123",
      "sessionType": "CONSULTATION",
      "status": "COMPLETED",
      "createdAt": "2024-01-15T10:30:45.123Z"
    },
    {
      "id": "session_789",
      "patientId": "patient_123",
      "sessionType": "FOLLOW_UP",
      "status": "ACTIVE",
      "createdAt": "2024-01-14T14:20:30.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 2,
    "totalPages": 1
  }
}
```

#### Update Session

```http
PUT /api/v1/sessions/:id
Content-Type: application/json
X-API-Key: your-api-key
```

**Request Body:**

```json
{
  "status": "COMPLETED",
  "metadata": {
    "endReason": "Consultation completed",
    "duration": 1800
  }
}
```

**Response (200 OK):**

```json
{
  "id": "session_456",
  "patientId": "patient_123",
  "sessionType": "CONSULTATION",
  "status": "COMPLETED",
  "metadata": {
    "doctorName": "Dr. Smith",
    "endReason": "Consultation completed",
    "duration": 1800
  },
  "updatedAt": "2024-01-15T11:00:00.000Z"
}
```

#### Validate Session

```http
POST /api/v1/sessions/:id/validate
X-API-Key: your-api-key
```

**Response (200 OK):**

```json
{
  "isValid": true,
  "session": {
    "id": "session_456",
    "status": "ACTIVE"
  },
  "reason": null
}
```

#### Sync Session Data

```http
POST /api/v1/sessions/:id/sync
Content-Type: application/json
X-API-Key: your-api-key
```

**Request Body:**

```json
{
  "syncData": {
    "transcriptUpdates": [],
    "audioChunks": [],
    "lastSyncedAt": "2024-01-15T10:55:00.000Z"
  }
}
```

#### Delete Session

```http
DELETE /api/v1/sessions/:id
X-API-Key: your-api-key
```

**Response (204 No Content)**

---

### Speech-to-Text v2 (Audio) Service

> STT v1 has been removed. All transcription is handled via STT endpoints under `/api/v1/audio/...`.

#### List Transcription Jobs

```http
GET /api/v1/audio/transcription-jobs
X-API-Key: your-api-key
```

**Response (200 OK):**

```json
{
  "data": [
    {
      "id": "job_abc123",
      "status": "COMPLETED",
      "createdAt": "2024-01-15T10:30:45.123Z"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 5 }
}
```

#### Create Transcription Job

```http
POST /api/v1/audio/transcription-jobs
Content-Type: application/json
X-API-Key: your-api-key
```

**Request Body:**

```json
{
  "sessionId": "session_456",
  "language": "en-US",
  "pipelineId": "pipeline_789"
}
```

#### Get Transcription Job by ID

```http
GET /api/v1/audio/transcription-jobs/:id
X-API-Key: your-api-key
```

#### List Pipelines

```http
GET /api/v1/audio/pipelines
X-API-Key: your-api-key
```

#### List AI Models

```http
GET /api/v1/audio/ai-models
X-API-Key: your-api-key
```

---

### Medical Summarization (Text) Service

> SMR endpoints are proxied to the SMR service on port 8862 via `/api/v1/text/...`.

#### Summarize Medical Transcript

```http
POST /api/v1/text/summarize
Content-Type: application/json
X-API-Key: your-api-key
```

**Request Body:**

```json
{
  "transcript": "Patient reports chest pain that started two days ago. Pain is described as sharp and intermittent. Patient has history of hypertension...",
  "sessionId": "session_456",
  "template": "SOAP",
  "options": {
    "includeEntities": true,
    "includeDiagnosis": true
  }
}
```

**Response (200 OK):**

```json
{
  "summary": {
    "subjective": "Patient reports sharp, intermittent chest pain for 2 days.",
    "objective": "History of hypertension.",
    "assessment": "Possible cardiac event, requires further evaluation.",
    "plan": "Order ECG, cardiac enzymes, refer to cardiology."
  },
  "entities": [
    {
      "text": "chest pain",
      "type": "SYMPTOM",
      "confidence": 0.95
    },
    {
      "text": "hypertension",
      "type": "CONDITION",
      "confidence": 0.98
    }
  ],
  "generatedAt": "2024-01-15T10:35:00.000Z"
}
```

---

## Request & Response Formats

### Standard Request Headers

```http
Content-Type: application/json
X-API-Key: your-api-key
X-Request-Id: unique-request-id (optional)
X-Tenant-Id: tenant-id (optional, auto-detected from auth)
```

### Standard Response Format

**Success Response:**

```json
{
  "data": { ... },
  "meta": {
    "timestamp": "2024-01-15T10:30:45.123Z",
    "requestId": "req_abc123"
  }
}
```

**Error Response:**

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Session with ID session_456 not found",
    "details": {},
    "timestamp": "2024-01-15T10:30:45.123Z",
    "requestId": "req_abc123"
  }
}
```

### Pagination

Paginated endpoints support the following query parameters:

| Parameter   | Type    | Default   | Description              |
| ----------- | ------- | --------- | ------------------------ |
| `page`      | integer | 1         | Page number              |
| `limit`     | integer | 20        | Items per page (max 100) |
| `sortBy`    | string  | createdAt | Field to sort by         |
| `sortOrder` | string  | desc      | Sort order (asc/desc)    |

**Example:**

```http
GET /api/v1/sessions?page=2&limit=50&sortBy=updatedAt&sortOrder=asc
```

---

## Error Handling

### HTTP Status Codes

| Status Code | Meaning               | Description                             |
| ----------- | --------------------- | --------------------------------------- |
| **200**     | OK                    | Request succeeded                       |
| **201**     | Created               | Resource created successfully           |
| **204**     | No Content            | Request succeeded, no content to return |
| **400**     | Bad Request           | Invalid request parameters              |
| **401**     | Unauthorized          | Missing or invalid authentication       |
| **403**     | Forbidden             | Insufficient permissions                |
| **404**     | Not Found             | Resource not found                      |
| **409**     | Conflict              | Resource conflict (e.g., duplicate)     |
| **429**     | Too Many Requests     | Rate limit exceeded                     |
| **500**     | Internal Server Error | Server error                            |
| **503**     | Service Unavailable   | Service temporarily unavailable         |

### Error Response Examples

#### 400 Bad Request

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": {
      "fields": [
        {
          "field": "patientId",
          "message": "patientId is required"
        }
      ]
    }
  }
}
```

#### 401 Unauthorized

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or missing API key"
  }
}
```

#### 429 Rate Limit Exceeded

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Please try again later.",
    "details": {
      "retryAfter": 60,
      "limit": 100,
      "remaining": 0,
      "resetAt": "2024-01-15T11:00:00.000Z"
    }
  }
}
```

---

## Rate Limiting

The API implements rate limiting to ensure fair usage:

### Rate Limit Headers

All responses include rate limit information:

```http
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 995
X-RateLimit-Reset: 1705316400
```

### Rate Limit Tiers

| Tier             | Requests per Hour | Burst Limit |
| ---------------- | ----------------- | ----------- |
| **Free**         | 100               | 20          |
| **Basic**        | 1,000             | 100         |
| **Professional** | 10,000            | 500         |
| **Enterprise**   | Custom            | Custom      |

### Handling Rate Limits

```javascript
const response = await fetch('https://api.hope.com/api/v1/sessions', {
  headers: {
    'X-API-Key': apiKey,
  },
});

if (response.status === 429) {
  const retryAfter = response.headers.get('Retry-After');
  console.log(`Rate limited. Retry after ${retryAfter} seconds`);
  await sleep(retryAfter * 1000);
  // Retry request
}
```

---

## WebSocket Communication

### Real-Time STT

**Connect to WebSocket:**

```javascript
const socket = io('wss://api.hope.com/stt', {
  auth: {
    token: 'your-api-key',
  },
});

socket.on('connect', () => {
  console.log('Connected to STT WebSocket');

  // Start session
  socket.emit('start-session', {
    sessionId: 'session_456',
    language: 'en-US',
  });
});

socket.on('session-started', (data) => {
  console.log('Session started:', data);
});

// Send audio chunks
socket.emit('audio-data', {
  sessionId: 'session_456',
  audio: audioBuffer,
  chunkIndex: 0,
});

// Receive transcription results
socket.on('transcription', (data) => {
  console.log('Transcription:', data.text);
  console.log('Is final:', data.isFinal);
});

socket.on('error', (error) => {
  console.error('WebSocket error:', error);
});
```

---

## SDK Integration

### Using AgenticSDK v2 (TypeScript/JavaScript)

```typescript
import { AgenticClient } from '@arcaai/agentic-sdk-v2';

const client = new AgenticClient({
  apiKey: 'your-api-key',
  baseUrl: 'https://api.hope.com/api/v1',
});

// Create session
const session = await client.sessions.create({
  patientId: 'patient_123',
  sessionType: 'CONSULTATION',
});

// Start STT
const transcription = await client.stt.startSession({
  sessionId: session.id,
  language: 'en-US',
});

// Listen to real-time transcription
transcription.on('data', (text) => {
  console.log('Transcribed:', text);
});
```

---

## Code Examples

### JavaScript/TypeScript

```typescript
// Using fetch API
async function createSession() {
  const response = await fetch('https://api.hope.com/api/v1/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'your-api-key',
    },
    body: JSON.stringify({
      patientId: 'patient_123',
      sessionType: 'CONSULTATION',
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  return data;
}
```

### Python

```python
import requests

def create_session():
    url = 'https://api.hope.com/api/v1/sessions'
    headers = {
        'Content-Type': 'application/json',
        'X-API-Key': 'your-api-key'
    }
    data = {
        'patientId': 'patient_123',
        'sessionType': 'CONSULTATION'
    }

    response = requests.post(url, json=data, headers=headers)
    response.raise_for_status()

    return response.json()
```

### cURL

```bash
# Create session
curl -X POST https://api.hope.com/api/v1/sessions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "patientId": "patient_123",
    "sessionType": "CONSULTATION"
  }'

# Create a transcription job
curl -X POST https://api.hope.com/api/v1/audio/transcription-jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"sessionId": "session_456", "language": "en-US"}'
```

---

## Best Practices

### 1. Error Handling

Always implement proper error handling:

```typescript
try {
  const session = await client.sessions.create(data);
  console.log('Session created:', session.id);
} catch (error) {
  if (error.status === 401) {
    console.error('Invalid API key');
  } else if (error.status === 429) {
    console.error('Rate limit exceeded');
  } else {
    console.error('Unexpected error:', error);
  }
}
```

### 2. Request Retries

Implement exponential backoff for retries:

```typescript
async function retryRequest(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status === 429 || error.status >= 500) {
        const delay = Math.pow(2, i) * 1000;
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
}
```

### 3. Security

- Never expose API keys in client-side code
- Use environment variables for sensitive data
- Implement proper authentication flows
- Rotate API keys regularly

### 4. Performance

- Implement caching where appropriate
- Use pagination for large datasets
- Batch requests when possible
- Use WebSockets for real-time features

---

## Support

For additional help:

- **Documentation**: https://docs.hope.com
- **API Status**: https://status.hope.com
- **Support Email**: support@hope.com
- **Developer Forum**: https://forum.hope.com

---

**Last Updated**: 2026-02-22
