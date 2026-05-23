# HOPE API Integration Guide

**Version**: 1.1
**Last Updated**: 2026-05-18
**Audience**: Integration Developers, SDK Implementers, Third-party Developers

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Authentication](#authentication)
- [Core Workflows](#core-workflows)
  - [1. Live Transcription](#1-live-transcription-streaming)
  - [2. Bulk Upload Transcription](#2-bulk-upload-transcription-batch)
  - [3. Summarization](#3-summarization)
  - [4. DNA Writing Style](#4-dna-writing-style)
- [Visit Types](#visit-types)
- [Debug Mode](#debug-mode)
- [API Request Examples with Seed Data](#api-request-examples-with-seed-data)
- [Error Handling](#error-handling)
- [Troubleshooting](#troubleshooting)

---

## Overview

The HOPE API Gateway provides healthcare AI services including:
- **Live Transcription**: Real-time speech-to-text via WebSocket
- **Bulk Transcription**: Batch audio file processing
- **Summarization**: Medical transcript summarization with pre-summary and full summary
- **DNA Writing Style**: Personalized writing style analysis and application

### Base Configuration

| Environment | API Base URL | WebSocket URL | Port |
|-------------|--------------|---------------|------|
| Development | `http://localhost:8868/api/v1` | `ws://localhost:8868` | 8868 |
| Staging | `https://staging-api.hope.com/api/v1` | `wss://staging-api.hope.com` | - |
| Production | `https://api.hope.com/api/v1` | `wss://api.hope.com` | - |

### Service Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway (NestJS :8868)               │
│  /api/v1/audio/*     → STT v2 Service (:8861)              │
│  /api/v1/text/*      → SMR Service (:8862)                 │
│  /api/v1/speech/*    → TTS Service (:8863)                 │
│  /api/v1/nlp/*       → NLP Service (:8864)                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

### 1. Obtain API Credentials

Before making any API calls, you need:

1. **API Key** (for service-to-service): Contact your tenant administrator
2. **JWT Token** (for user sessions): Authenticate via OIDC or login endpoint
3. **Tenant ID**: Your organization's unique identifier

### 2. Required Headers

All authenticated requests must include one of:

```http
# Option 1: API Key (recommended for backends)
X-API-Key: sk_live_your-api-key-here

# Option 2: JWT Bearer Token (for user sessions)
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Optional headers:
```http
Content-Type: application/json
X-Request-Id: unique-correlation-id
X-Tenant-Id: tenant-id (auto-detected from auth if not provided)
```

### 3. Create a Consultation Session

**IMPORTANT**: Most transcription and summarization workflows require an active consultation. Create one first:

```http
POST /api/v1/consultations/open
Content-Type: application/json
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "patientId": "patient_12345",
  "appointmentDate": "2026-05-18",
  "visitType": "NEW_PATIENT",
  "metadata": {
    "department": "Cardiology",
    "appointmentType": "Initial Consultation"
  }
}
```

**Response:**
```json
{
  "id": "consultation_abc123",
  "patientId": "patient_12345",
  "doctorId": "doctor_xyz789",
  "status": "OPEN",
  "visitType": "NEW_PATIENT",
  "appointmentDate": "2026-05-18",
  "createdAt": "2026-05-18T10:30:00.000Z"
}
```

### 4. Get Pipeline ID

Transcription requires a pipeline configuration:

```http
GET /api/v1/audio/pipelines
Authorization: Bearer <token>
```

**Response:**
```json
{
  "data": [
    {
      "id": "pipeline_default_en",
      "name": "Default English Pipeline",
      "language": "en",
      "sampleRate": 16000,
      "isDefault": true
    },
    {
      "id": "pipeline_default_vi",
      "name": "Default Vietnamese Pipeline",
      "language": "vi",
      "sampleRate": 16000
    }
  ]
}
```

---

## Authentication

### API Key Authentication

Best for backend services and automated systems:

```bash
curl -X GET "https://api.hope.com/api/v1/consultations" \
  -H "X-API-Key: sk_live_abc123xyz"
```

### JWT Bearer Token

Best for user-facing applications:

```bash
curl -X GET "https://api.hope.com/api/v1/consultations" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
```

### OIDC Authentication Flow

For enterprise SSO integration:

```javascript
// 1. Redirect to OIDC login
window.location.href = 'https://api.hope.com/auth/oidc/login';

// 2. Handle callback with authorization code
// GET /auth/oidc/callback?code=authorization_code

// 3. Use returned session cookie for subsequent requests
```

---

## Core Workflows

### 1. Live Transcription (Streaming)

Real-time audio transcription via WebSocket for live consultations.

#### Step 1: Create Streaming Session

```http
POST /api/v1/audio/transcription-jobs/stream/session
Content-Type: application/json
Authorization: Bearer <token>
```

**Request:**
```json
{
  "pipelineId": "pipeline_default_en",
  "consultationId": "consultation_abc123",
  "sampleRate": 16000,
  "language": "en"
}
```

**Response:**
```json
{
  "sessionId": "session_xyz789",
  "status": "CREATED",
  "wsUrl": "/ws/stt-v2/stream",
  "maxConcurrent": 10,
  "currentActive": 3
}
```

#### Step 2: Connect WebSocket

```javascript
const socket = new WebSocket('wss://api.hope.com/ws/stt-v2/stream?sessionId=session_xyz789');

socket.onopen = () => {
  console.log('Connected to STT WebSocket');
};

// Receive transcription results
socket.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case 'partial':
      // Interim transcription (may change)
      console.log('Partial:', data.text);
      break;
    case 'final':
      // Final transcription segment
      console.log('Final:', data.text, 'Speaker:', data.speaker);
      break;
    case 'status':
      console.log('Status:', data.status, data.message);
      break;
    case 'error':
      console.error('Error:', data.code, data.message);
      break;
  }
};

socket.onerror = (error) => {
  console.error('WebSocket error:', error);
};
```

#### Step 3: Send Audio Data

**Option A: Binary Audio Frames (Recommended)**
```javascript
// Send raw PCM audio as binary
const audioBuffer = new Int16Array(audioSamples);
socket.send(audioBuffer.buffer);
```

**Option B: Base64 Encoded JSON**
```javascript
socket.send(JSON.stringify({
  type: 'audio',
  seq: 1,
  data: btoa(String.fromCharCode(...new Uint8Array(audioBuffer)))
}));
```

#### Step 4: Stop and Close Session

```javascript
// Signal end of audio stream
socket.send(JSON.stringify({ type: 'stop' }));

// Close session gracefully
socket.send(JSON.stringify({ type: 'close' }));
```

**Or via REST API:**
```http
DELETE /api/v1/audio/transcription-jobs/stream/session/{sessionId}
Authorization: Bearer <token>
```

#### Audio Format Requirements

| Parameter | Requirement |
|-----------|-------------|
| Format | PCM 16-bit signed little-endian (`pcm_s16le`) |
| Sample Rate | 16000 Hz (recommended) or as specified in pipeline |
| Channels | Mono (1 channel) |
| Encoding | Raw PCM or Base64 in JSON |

---

### 2. Bulk Upload Transcription (Batch)

For processing pre-recorded audio files.

#### Step 1: Upload Audio and Create Job

```http
POST /api/v1/audio/transcription-jobs/transcribe
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

**Form Data:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | Audio file (max 100MB) |
| `pipelineId` | String | Yes | Pipeline configuration ID |
| `consultationId` | String | No | Associated consultation |
| `language` | String | No | Override language (e.g., `en`, `vi`, `auto`) |

**Supported Audio Formats:**
- `audio/wav`, `audio/wave`, `audio/x-wav`
- `audio/mpeg`, `audio/mp3`
- `audio/mp4`, `audio/x-m4a`
- `audio/ogg`, `audio/flac`
- `audio/webm`, `audio/aac`

**cURL Example:**
```bash
curl -X POST "https://api.hope.com/api/v1/audio/transcription-jobs/transcribe" \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/recording.wav" \
  -F "pipelineId=pipeline_default_en" \
  -F "consultationId=consultation_abc123" \
  -F "language=en"
```

**Response:**
```json
{
  "id": "job_def456",
  "status": "QUEUED",
  "sseUrl": "/api/v1/audio/transcription-jobs/job_def456/stream",
  "audioUri": "s3://tenant-audio/2026/05/consultations/consultation_abc123/job_def456/raw/recording.wav"
}
```

#### Step 2: Monitor Job Progress via SSE

```javascript
const eventSource = new EventSource(
  'https://api.hope.com/api/v1/audio/transcription-jobs/job_def456/stream',
  { headers: { 'Authorization': 'Bearer <token>' } }
);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.status) {
    case 'PROCESSING':
      console.log('Processing...', data.progress + '%');
      break;
    case 'COMPLETED':
      console.log('Transcription complete:', data.transcript);
      eventSource.close();
      break;
    case 'FAILED':
      console.error('Job failed:', data.error);
      eventSource.close();
      break;
  }
};
```

#### Step 3: Get Job Result

```http
GET /api/v1/audio/transcription-jobs/{jobId}
Authorization: Bearer <token>
```

**Response:**
```json
{
  "id": "job_def456",
  "status": "COMPLETED",
  "createdAt": "2026-05-18T10:30:00.000Z",
  "completedAt": "2026-05-18T10:32:15.000Z",
  "result": {
    "transcript": "Patient reports chest pain...",
    "segments": [
      {
        "start": 0.0,
        "end": 5.2,
        "text": "Patient reports chest pain",
        "speaker": "SPEAKER_1",
        "confidence": 0.95
      }
    ],
    "language": "en",
    "duration": 125.5
  }
}
```

#### Additional Job Operations

**Get Jobs by Consultation:**
```http
GET /api/v1/audio/transcription-jobs/consultation/{consultationId}
```

**Cancel Job:**
```http
POST /api/v1/audio/transcription-jobs/{jobId}/cancel
```

**Retry Failed Job:**
```http
POST /api/v1/audio/transcription-jobs/{jobId}/retry
```

---

### 3. Summarization

Generate clinical summaries from transcripts.

#### Pre-Summary Generation

Pre-summaries are quick summaries generated from case notes before a consultation:

```http
POST /api/v1/consultations/{consultationId}/summary/pre-summary
Content-Type: application/json
Authorization: Bearer <token>
```

**Request:**
```json
{
  "caseNoteIds": ["context_item_abc", "context_item_def"],
  "dnaStyleId": "dna_style_123",
  "options": {
    "provider": "anthropic",
    "model": "claude-3-sonnet",
    "temperature": 0.3,
    "maxTokens": 2000
  }
}
```

#### Full Summary Generation

Generate comprehensive summaries from transcripts:

```http
POST /api/v1/consultations/{consultationId}/summary
Content-Type: application/json
Authorization: Bearer <token>
```

**Request:**
```json
{
  "contextItemIds": ["transcript_context_id"],
  "template": "SOAP",
  "dnaStyleId": "dna_style_123",
  "includeNER": true,
  "options": {
    "provider": "anthropic",
    "model": "claude-3-opus",
    "temperature": 0.2
  }
}
```

**Response:**
```json
{
  "id": "summary_ghi789",
  "consultationId": "consultation_abc123",
  "type": "RAW_SUMMARY",
  "content": "## Subjective\nPatient reports sharp, intermittent chest pain...\n\n## Objective\n...",
  "structuredData": {
    "subjective": "Patient reports sharp, intermittent chest pain...",
    "objective": "Blood pressure 120/80, heart rate 72...",
    "assessment": "Possible cardiac event requiring evaluation",
    "plan": "Order ECG, cardiac enzymes, cardiology referral"
  },
  "namedEntities": [
    { "text": "chest pain", "type": "SYMPTOM", "confidence": 0.95 },
    { "text": "hypertension", "type": "CONDITION", "confidence": 0.98 }
  ],
  "createdAt": "2026-05-18T10:35:00.000Z"
}
```

#### Async Summary Generation

For long-running summarization jobs:

```http
POST /api/v1/consultations/{consultationId}/summary/async
```

**Response:**
```json
{
  "jobId": "async_job_xyz",
  "status": "pending",
  "consultationId": "consultation_abc123",
  "createdAt": "2026-05-18T10:35:00.000Z"
}
```

#### Streaming Summarization (SSE)

For real-time token-by-token summary generation, use the streaming endpoints:

**Step 1: Create Streaming Task**

```http
POST /api/v1/text/generate
Content-Type: application/json
Authorization: Bearer <token>
```

**Request:**
```json
{
  "prompt": "Generate a clinical summary from the following transcript:\n\nPatient reports chest pain...",
  "system_prompt": "You are a medical documentation assistant. Generate a comprehensive clinical summary.",
  "provider": "ollama",
  "model": "qwen2.5:32b",
  "temperature": 0.3,
  "max_tokens": 4096,
  "stream": true
}
```

**Response (202 Accepted):**
```json
{
  "task_id": "task_abc123",
  "status": "pending",
  "stream_url": "/api/v1/text/tasks/task_abc123/stream"
}
```

**Step 2: Connect to SSE Stream**

```http
GET /api/v1/text/tasks/{taskId}/stream
Accept: text/event-stream
Authorization: Bearer <token>
```

**JavaScript Example:**
```javascript
// Create streaming task
const taskRes = await fetch('/api/v1/text/generate', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer <token>'
  },
  body: JSON.stringify({
    prompt: `Generate a clinical summary from:\n\n${transcript}`,
    system_prompt: 'You are a medical documentation assistant...',
    stream: true,
    provider: 'ollama',
    model: 'qwen2.5:32b',
    temperature: 0.3,
    max_tokens: 4096
  })
});

const { task_id } = await taskRes.json();

// Connect to SSE stream
const eventSource = new EventSource(
  `/api/v1/text/tasks/${task_id}/stream`,
  { headers: { 'Authorization': 'Bearer <token>' } }
);

let fullText = '';

eventSource.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);

    // Extract text from various response formats
    const chunk = data.content || data.text || data.delta?.content || '';

    if (chunk) {
      fullText += chunk;
      updateUI(fullText);  // Update UI with accumulated text
    }

    // Check for completion
    if (data.done || data.finish_reason === 'stop') {
      console.log('Streaming complete');
      eventSource.close();
    }
  } catch (e) {
    // Skip non-JSON keepalive messages
  }
};

eventSource.onerror = (error) => {
  console.error('SSE error:', error);
  eventSource.close();
};
```

**SSE Event Format:**
```
data: {"type":"chunk","content":"Patient","index":0}

data: {"type":"chunk","content":" presents","index":1}

data: {"type":"chunk","content":" with","index":2}

data: {"type":"done","finish_reason":"stop","usage":{"prompt_tokens":150,"completion_tokens":500}}
```

**Streaming Pre-Summary:**
```javascript
const streamPreSummary = async (contextText, onChunk) => {
  const taskRes = await fetch('/api/v1/text/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer <token>' },
    body: JSON.stringify({
      prompt: `Generate a pre-summary from:\n\n${contextText}`,
      system_prompt: 'Generate a concise pre-summary focusing on key findings, diagnoses, medications.',
      stream: true,
      temperature: 0.3,
      max_tokens: 2048
    })
  });

  const { task_id } = await taskRes.json();

  // Use fetch + ReadableStream for better control
  const response = await fetch(`/api/v1/text/tasks/${task_id}/stream`, {
    headers: { 'Authorization': 'Bearer <token>', 'Accept': 'text/event-stream' }
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value).split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.content) onChunk(data.content);
        } catch {}
      }
    }
  }
};
```

#### Task Management

**Get Task Status:**
```http
GET /api/v1/text/tasks/{taskId}
Authorization: Bearer <token>
```

**Response:**
```json
{
  "task_id": "task_abc123",
  "status": "completed",
  "content": "Full generated text...",
  "provider": "ollama",
  "model": "qwen2.5:32b",
  "usage": {
    "prompt_tokens": 150,
    "completion_tokens": 500,
    "total_tokens": 650
  },
  "latency_ms": 3500,
  "finish_reason": "stop",
  "created_at": "2026-05-18T10:30:00.000Z"
}
```

**Cancel Running Task:**
```http
POST /api/v1/text/tasks/{taskId}/cancel
Authorization: Bearer <token>
```

#### Direct Text Generation (Debug Mode)

For testing and debugging, use the assembled generation endpoint:

```http
POST /api/v1/text/generate/assembled
Content-Type: application/json
Authorization: Bearer <token>
```

**Request:**
```json
{
  "type": "summary",
  "visit_type": "new_visit",
  "context_item_ids": ["context_abc", "context_def"],
  "prompt_template_id": "template_123",
  "dna_writing_style_id": "dna_456",
  "provider": "anthropic",
  "model": "claude-3-opus",
  "temperature": 0.3,
  "max_tokens": 4000,
  "stream": false,
  "debug": true
}
```

**Note:** `debug: true` requires `SUPER_ADMIN`, `GLOBAL_ADMIN`, or `TENANT_ADMIN` role.

---

### 4. DNA Writing Style

DNA Writing Style analyzes a doctor's writing patterns to personalize generated summaries.

#### Generate DNA Report

Train a new DNA writing style from sample documents:

```http
POST /api/v1/dna-writing-styles/generate
Content-Type: application/json
Authorization: Bearer <token>
```

**Request:**
```json
{
  "sampleDocumentIds": [
    "doc_sample_1",
    "doc_sample_2",
    "doc_sample_3"
  ],
  "name": "Dr. Smith's Writing Style",
  "description": "Based on cardiology clinic notes"
}
```

**Response:**
```json
{
  "jobId": "dna_job_abc123",
  "status": "QUEUED",
  "message": "DNA style generation started"
}
```

#### Monitor DNA Generation Job

**Get Job Status:**
```http
GET /api/v1/dna-writing-styles/jobs/{jobId}
Authorization: Bearer <token>
```

**Response:**
```json
{
  "jobId": "dna_job_abc123",
  "state": "completed",
  "progress": 100,
  "result": {
    "reportId": "dna_report_xyz",
    "styleText": "Writing style analysis: Prefers concise sentences..."
  },
  "startedAt": "2026-05-18T10:30:00.000Z",
  "completedAt": "2026-05-18T10:32:00.000Z"
}
```

#### Stream Job Status via SSE

Monitor DNA generation progress in real-time:

```http
GET /api/v1/dna-writing-styles/jobs/{jobId}/stream
Accept: text/event-stream
Authorization: Bearer <token>
```

**JavaScript Example:**
```javascript
const monitorDnaJob = (jobId, callbacks) => {
  const eventSource = new EventSource(
    `/api/v1/dna-writing-styles/jobs/${jobId}/stream`,
    { headers: { 'Authorization': 'Bearer <token>' } }
  );

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.state || data.status) {
        case 'queued':
          callbacks.onQueued?.();
          break;
        case 'processing':
        case 'active':
          callbacks.onProgress?.(data.progress || 0);
          break;
        case 'completed':
          callbacks.onComplete?.(data.result);
          eventSource.close();
          break;
        case 'failed':
          callbacks.onError?.(data.error || 'Job failed');
          eventSource.close();
          break;
      }
    } catch (e) {
      // Skip keepalive messages
    }
  };

  eventSource.onerror = (error) => {
    callbacks.onError?.('SSE connection error');
    eventSource.close();
  };

  return () => eventSource.close();  // Return cleanup function
};

// Usage
const cleanup = monitorDnaJob('dna_job_abc123', {
  onQueued: () => console.log('Job queued...'),
  onProgress: (pct) => updateProgressBar(pct),
  onComplete: (result) => {
    console.log('DNA style created:', result.reportId);
    console.log('Style text:', result.styleText);
  },
  onError: (err) => console.error('Failed:', err)
});

// Later: cleanup() to close connection
```

**SSE Event Format:**
```
data: {"jobId":"dna_job_abc123","state":"queued","progress":0}

data: {"jobId":"dna_job_abc123","state":"active","progress":25}

data: {"jobId":"dna_job_abc123","state":"active","progress":75}

data: {"jobId":"dna_job_abc123","state":"completed","progress":100,"result":{"reportId":"dna_report_xyz","styleText":"Writing style analysis..."}}
```

**Admin Endpoint (for all users):**
```http
GET /api/v1/admin/dna-writing-styles/jobs/{jobId}/stream
Accept: text/event-stream
Authorization: Bearer <admin-token>
```

#### Get Current User's DNA Style

```http
GET /api/v1/dna-writing-styles/my-style
Authorization: Bearer <token>
```

**Response:**
```json
{
  "id": "dna_report_xyz",
  "doctorId": "doctor_abc",
  "name": "Dr. Smith's Writing Style",
  "styleText": "Writing style characteristics:\n- Prefers active voice\n- Uses medical abbreviations...",
  "status": "ACTIVE",
  "version": 3,
  "createdAt": "2026-05-18T10:00:00.000Z",
  "updatedAt": "2026-05-18T10:32:00.000Z"
}
```

#### Update DNA Report

```http
PATCH /api/v1/dna-writing-styles/{reportId}
Content-Type: application/json
Authorization: Bearer <token>
```

**Request:**
```json
{
  "name": "Updated Style Name",
  "styleText": "Modified writing style preferences...",
  "status": "ACTIVE"
}
```

#### Get Version History

```http
GET /api/v1/dna-writing-styles/{reportId}/versions
Authorization: Bearer <token>
```

---

## Visit Types

The API supports different visit types that affect summarization behavior:

### New Visit (`new_visit` / `NEW_PATIENT`)

First consultation for a patient or a new chief complaint:

```json
{
  "visit_type": "new_visit",
  "context_item_ids": ["transcript_id"],
  "prompt_template_id": "new_patient_template"
}
```

**Characteristics:**
- Full patient history review
- Comprehensive assessment
- Detailed plan documentation

### Same-Day Revisit (`sameday-revisit` / `REVISIT`)

Follow-up within the same day:

```json
{
  "visitType": "REVISIT",
  "parentConsultationId": "original_consultation_id"
}
```

**Characteristics:**
- References parent consultation context
- Focuses on changes since last visit
- Inherits shared context items

### Referral (`referral` / `REFERRAL`)

Patient referred from another provider:

```json
{
  "visit_type": "referral",
  "context_item_ids": ["referral_letter_id", "transcript_id"]
}
```

**Characteristics:**
- Includes referral context
- References external provider notes
- Comprehensive intake assessment

### Consultation Chaining

Get all related consultations for a patient on the same day:

```http
GET /api/v1/consultations/{consultationId}/chain
```

This returns the new-visit (root) and all same-day revisits.

---

## Debug Mode

Debug mode provides additional diagnostic information for troubleshooting.

### Enabling Debug Mode

Add `debug: true` to supported requests:

```json
{
  "type": "summary",
  "context_item_ids": ["context_abc"],
  "debug": true
}
```

**Requirements:** User must have one of: `SUPER_ADMIN`, `GLOBAL_ADMIN`, `TENANT_ADMIN`

### Debug Response Fields

```json
{
  "result": "Generated summary text...",
  "_debug": {
    "assembled": true,
    "type": "summary",
    "visit_type": "new_visit",
    "prompt_template_id": "template_123",
    "prompt_template_name": "Default SOAP Template",
    "dna_writing_style_id": "dna_456",
    "context_item_ids": ["context_abc"],
    "prompt_length": 2500,
    "system_prompt_length": 850,
    "model_used": "claude-3-opus",
    "tokens_used": 1234,
    "processing_time_ms": 3500
  }
}
```

### Debug Logging

Enable verbose logging for transcription sessions:

```json
{
  "pipelineId": "pipeline_default_en",
  "consultationId": "consultation_abc123",
  "debug": {
    "logAudioChunks": true,
    "logPartialTranscripts": true,
    "saveRawAudio": true
  }
}
```

---

## API Request Examples with Seed Data

### Complete New-Visit Workflow

```bash
# 1. Create consultation
curl -X POST "http://localhost:8868/api/v1/consultations/open" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "patientId": "patient_seed_001",
    "appointmentDate": "2026-05-18",
    "visitType": "NEW_PATIENT",
    "metadata": {
      "department": "General Medicine",
      "chiefComplaint": "Chest pain"
    }
  }'

# Response: { "id": "consultation_new_001", ... }

# 2. Create streaming session for live transcription
curl -X POST "http://localhost:8868/api/v1/audio/transcription-jobs/stream/session" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "pipelineId": "pipeline_default_en",
    "consultationId": "consultation_new_001",
    "sampleRate": 16000,
    "language": "en"
  }'

# Response: { "sessionId": "session_live_001", "wsUrl": "/ws/stt-v2/stream", ... }

# 3. After transcription, generate summary
curl -X POST "http://localhost:8868/api/v1/consultations/consultation_new_001/summary" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "contextItemIds": ["transcript_context_001"],
    "template": "SOAP",
    "dnaStyleId": "dna_seed_style_001",
    "includeNER": true,
    "options": {
      "provider": "anthropic",
      "model": "claude-3-sonnet"
    }
  }'
```

### Complete Same-Day Revisit Workflow

```bash
# 1. Create revisit consultation (linked to new-visit)
curl -X POST "http://localhost:8868/api/v1/consultations/open" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "patientId": "patient_seed_001",
    "appointmentDate": "2026-05-18",
    "visitType": "REVISIT",
    "parentConsultationId": "consultation_new_001",
    "metadata": {
      "reason": "Follow-up on chest pain"
    }
  }'

# Response: { "id": "consultation_revisit_001", "parentConsultationId": "consultation_new_001", ... }

# 2. Upload pre-recorded audio for batch transcription
curl -X POST "http://localhost:8868/api/v1/audio/transcription-jobs/transcribe" \
  -H "Authorization: Bearer <token>" \
  -F "file=@./followup_recording.wav" \
  -F "pipelineId=pipeline_default_en" \
  -F "consultationId=consultation_revisit_001"

# Response: { "id": "job_batch_001", "sseUrl": "/api/v1/audio/transcription-jobs/job_batch_001/stream", ... }

# 3. Get shared context from parent consultation
curl -X GET "http://localhost:8868/api/v1/consultations/consultation_revisit_001/context/shared" \
  -H "Authorization: Bearer <token>"

# 4. Generate comprehensive summary across the chain
curl -X POST "http://localhost:8868/api/v1/consultations/consultation_revisit_001/summary/comprehensive" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "dnaStyleId": "dna_seed_style_001",
    "template": "PROGRESS_NOTE",
    "includeNER": true
  }'
```

### Bulk Transcription with Pre-Summary

```bash
# 1. Upload multiple audio files
curl -X POST "http://localhost:8868/api/v1/audio/transcription-jobs/transcribe" \
  -H "Authorization: Bearer <token>" \
  -F "file=@./recording_1.mp3" \
  -F "pipelineId=pipeline_default_en" \
  -F "consultationId=consultation_abc123"

# 2. Check job status
curl -X GET "http://localhost:8868/api/v1/audio/transcription-jobs/job_id_here" \
  -H "Authorization: Bearer <token>"

# 3. Generate pre-summary from case notes
curl -X POST "http://localhost:8868/api/v1/consultations/consultation_abc123/summary/pre-summary" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "caseNoteIds": ["case_note_001", "case_note_002"],
    "dnaStyleId": "dna_style_001",
    "options": {
      "provider": "anthropic",
      "model": "claude-3-haiku",
      "maxTokens": 1000
    }
  }'
```

### DNA Writing Style Training

```bash
# 1. Generate DNA report from samples
curl -X POST "http://localhost:8868/api/v1/dna-writing-styles/generate" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "sampleDocumentIds": [
      "doc_sample_001",
      "doc_sample_002",
      "doc_sample_003",
      "doc_sample_004",
      "doc_sample_005"
    ],
    "name": "My Clinical Writing Style",
    "description": "Based on last 5 clinic notes"
  }'

# Response: { "jobId": "dna_job_001", "status": "QUEUED" }

# 2. Monitor progress
curl -X GET "http://localhost:8868/api/v1/dna-writing-styles/jobs/dna_job_001" \
  -H "Authorization: Bearer <token>"

# 3. Use in summary generation
curl -X POST "http://localhost:8868/api/v1/consultations/consultation_abc123/summary" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "contextItemIds": ["transcript_001"],
    "dnaStyleId": "dna_report_from_job",
    "template": "SOAP"
  }'
```

---

## Error Handling

### Standard Error Response Format

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable error description",
    "details": {
      "field": "pipelineId",
      "reason": "Pipeline not found"
    },
    "timestamp": "2026-05-18T10:30:00.000Z",
    "requestId": "req_abc123"
  }
}
```

### Common Error Codes

| Code | HTTP Status | Description | Resolution |
|------|-------------|-------------|------------|
| `UNAUTHORIZED` | 401 | Missing or invalid authentication | Check API key or token |
| `FORBIDDEN` | 403 | Insufficient permissions | Verify user roles |
| `RESOURCE_NOT_FOUND` | 404 | Resource doesn't exist | Check resource ID |
| `VALIDATION_ERROR` | 400 | Invalid request parameters | Review request body |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests | Implement backoff |
| `SERVICE_UNAVAILABLE` | 503 | Downstream service unavailable | Retry with backoff |

### Retry Strategy

```javascript
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status === 429 || error.status >= 500) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
}
```

---

## Troubleshooting

### WebSocket Connection Issues

**Problem:** WebSocket disconnects immediately
**Solution:** Ensure `sessionId` is included in query params:
```
ws://localhost:8868/ws/stt-v2/stream?sessionId=session_xyz789
```

**Problem:** "No active session" error
**Solution:** Create streaming session via REST API first, then connect WebSocket.

### Transcription Quality Issues

**Problem:** Poor transcription accuracy
**Solutions:**
1. Verify audio format matches pipeline requirements (16kHz, mono, PCM)
2. Check audio quality (avoid background noise)
3. Try different language setting
4. Use `debug: true` to check audio processing

### Summarization Failures

**Problem:** Summary generation timeout
**Solutions:**
1. Use async endpoints for long transcripts
2. Split large transcripts into chunks
3. Reduce `max_tokens` parameter

**Problem:** DNA style not applied
**Solutions:**
1. Verify `dnaStyleId` exists and is ACTIVE
2. Check user has access to the DNA report
3. Ensure DNA report generation completed successfully

### Rate Limiting

**Problem:** 429 Too Many Requests
**Solutions:**
1. Implement exponential backoff
2. Check `X-RateLimit-*` headers
3. Contact admin for rate limit increase
