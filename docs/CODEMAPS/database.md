# Database Schema Codemap

**Last Updated:** 2026-03-09  
**Database:** PostgreSQL 18  
**ORM:** Prisma 7  
**Schema Location:** [packages/database/src/prisma/schema.prisma](../../../../packages/database/src/prisma/schema.prisma)

---

## 📋 Purpose

Detailed reference for the database schema, relationships, indexes, and data models. Use this to understand the data structure and relationships across the HOPE platform.

---

## 🏛️ Entity Relationship Diagram

```
┌─────────────────┐
│     Tenant      │  (Account boundary)
└────────┬────────┘
         │
    ┌────┴──────────────────────────────────────────┐
    │                                               │
    ▼                                               ▼
┌────────────┐                          ┌──────────────────┐
│    User    │◄──────────────────────────│ConsultationSession
│  (Profile) │                          │  (Conversation)   
└────────────┘                          └──────────────────┘
    │                                          │
    ├─ email (unique)                         ├─ doctor_id (FK)
    ├─ role (admin|doctor|patient|support)   ├─ patient_id (FK)
    ├─ password_hash                         ├─ specialty
    └─ is_active                             ├─ status
                                              └─ messages[]
                                              
┌──────────────┐      ┌─────────────────┐
│   Message    │◄─────│ConsultationSession
│              │      └─────────────────┘
├─ session_id │
├─ sender_id  │
├─ content    │
└─ type       │

┌──────────────────┐
│  PatientProfile  │
├─ patient_id     │
├─ medications[]  │
├─ allergies[]    │
└─ history       │

┌──────────────┐
│   ApiKey     │
├─ tenant_id  │
├─ user_id    │
├─ key_hash   │
└─ expires_at │

┌───────────────┐
│  AuditLog     │
├─ tenant_id   │
├─ user_id     │
├─ action      │
├─ entity_type │
└─ changes     │

┌────────────────┐
│  StorageFile   │
├─ tenant_id    │
├─ bucket_key   │
├─ file_name    │
└─ size_bytes   │
```

---

## 📊 Core Tables

### Tenant
Account/organization boundary for isolation.

```sql
CREATE TABLE "Tenant" (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(255) UNIQUE,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_tenant_slug (slug)
);
```

**Fields:**
- `id` — Unique identifier
- `name` — Display name
- `slug` — URL-friendly identifier
- `created_at` — Creation timestamp
- `updated_at` — Last modification timestamp

**Usage:** All other entities include `tenant_id` for isolation

---

### User
User profiles and authentication.

```sql
CREATE TABLE "User" (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES "Tenant"(id),
  email         VARCHAR(255) NOT NULL,
  role          VARCHAR(50) NOT NULL,  -- admin|doctor|patient|support
  password_hash VARCHAR(255),
  first_name    VARCHAR(255),
  last_name     VARCHAR(255),
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW(),
  
  UNIQUE (tenant_id, email),
  INDEX idx_user_tenant (tenant_id),
  INDEX idx_user_email (email),
  INDEX idx_user_role (role)
);
```

**Fields:**
- `id` — User UUID
- `tenant_id` — Account owner
- `email` — Unique per tenant
- `role` — User type (admin/doctor/patient/support)
- `password_hash` — bcrypt hash
- `is_active` — Account status

**Queries:**
```sql
-- Find user by email (for login)
SELECT * FROM "User" 
WHERE tenant_id = $1 AND email = $2;

-- List doctors in tenant
SELECT * FROM "User"
WHERE tenant_id = $1 AND role = 'doctor';
```

---

### Session
Active user sessions for tracking.

```sql
CREATE TABLE "Session" (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES "User"(id),
  token_hash    VARCHAR(255) NOT NULL,
  expires_at    TIMESTAMP NOT NULL,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_session_user (user_id),
  INDEX idx_session_expires (expires_at)
);
```

**Usage:** Track active sessions for logout/revocation

---

### ApiKey
API credentials for programmatic access.

```sql
CREATE TABLE "ApiKey" (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES "Tenant"(id),
  user_id       UUID REFERENCES "User"(id),
  key_hash      VARCHAR(255) NOT NULL UNIQUE,
  description   TEXT,
  last_used_at  TIMESTAMP,
  expires_at    TIMESTAMP,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_apikey_tenant (tenant_id),
  INDEX idx_apikey_hash (key_hash)
);
```

**Usage:**
```sql
-- Rotate API key
UPDATE "ApiKey" SET is_active = false WHERE id = $1;
INSERT INTO "ApiKey" (...) VALUES (...);

-- Find active key
SELECT * FROM "ApiKey"
WHERE key_hash = $1 AND is_active = true
  AND (expires_at IS NULL OR expires_at > NOW());
```

---

### ConsultationSession
Doctor-patient consultation records.

```sql
CREATE TABLE "ConsultationSession" (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES "Tenant"(id),
  doctor_id      UUID NOT NULL REFERENCES "User"(id),
  patient_id     UUID NOT NULL REFERENCES "User"(id),
  specialty      VARCHAR(100),  -- cardiology|neurology|...
  chief_complaint TEXT,
  status         VARCHAR(50),   -- active|completed|archived
  started_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMP,
  summary_id     UUID REFERENCES "ConsultationSummary"(id),
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_consultation_tenant (tenant_id),
  INDEX idx_consultation_doctor (doctor_id),
  INDEX idx_consultation_patient (patient_id),
  INDEX idx_consultation_status (status),
  INDEX idx_consultation_dates (started_at, ended_at)
);
```

**Fields:**
- `doctor_id` / `patient_id` — Participants
- `specialty` — Medical specialty
- `chief_complaint` — Initial reason for visit
- `status` — active|completed|archived

**Queries:**
```sql
-- Get session details
SELECT * FROM "ConsultationSession"
WHERE id = $1 AND tenant_id = $2;

-- List today's consultations for doctor
SELECT * FROM "ConsultationSession"
WHERE doctor_id = $1
  AND DATE(started_at) = CURRENT_DATE;

-- Find completed sessions for archiving
SELECT * FROM "ConsultationSession"
WHERE status = 'completed'
  AND ended_at < NOW() - INTERVAL '30 days';
```

---

### Message
Individual chat/audio messages in consultations.

```sql
CREATE TABLE "Message" (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES "ConsultationSession"(id),
  sender_id       UUID NOT NULL REFERENCES "User"(id),
  content         TEXT NOT NULL,
  message_type    VARCHAR(50),  -- text|audio|summary|system
  audio_url       VARCHAR(500),  -- MinIO URL if audio
  transcription   TEXT,          -- If audio message
  entities        JSONB,         -- NER results
  created_at      TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_message_session (session_id),
  INDEX idx_message_sender (sender_id),
  INDEX idx_message_type (message_type),
  INDEX idx_message_date (created_at)
);
```

**Fields:**
- `content` — Text message
- `audio_url` — Link to audio file (for audio messages)
- `transcription` — STT result
- `entities` — Medical entities extracted by NLP

**Queries:**
```sql
-- Get conversation history
SELECT * FROM "Message"
WHERE session_id = $1
ORDER BY created_at ASC;

-- Get only audio messages
SELECT * FROM "Message"
WHERE session_id = $1 AND message_type = 'audio';
```

---

### ConsultationSummary
Generated medical summaries.

```sql
CREATE TABLE "ConsultationSummary" (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID NOT NULL UNIQUE REFERENCES "ConsultationSession"(id),
  summary_text     TEXT NOT NULL,
  structured_data  JSONB,  -- {diagnosis, medications, follow_up, ...}
  generated_by     VARCHAR(50),  -- llm_model_name
  generated_at     TIMESTAMP NOT NULL,
  reviewed_by      UUID REFERENCES "User"(id),
  reviewed_at      TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_summary_session (session_id),
  INDEX idx_summary_reviewed (reviewed_by)
);
```

**Fields:**
- `summary_text` — Human-readable summary
- `structured_data` — JSON with diagnosis, medications, etc.
- `generated_by` — Which LLM model created it
- `reviewed_by` — Doctor who reviewed/approved

**Structured Data Example:**
```json
{
  "chief_complaint": "chest pain",
  "diagnosis": [
    {
      "condition": "stable angina",
      "certainty": 0.85,
      "icd_code": "I20.0"
    }
  ],
  "medications": [
    {
      "name": "Nitroglycerin",
      "dosage": "0.4mg",
      "frequency": "as needed"
    }
  ],
  "follow_up": "Cardiology referral within 2 weeks"
}
```

---

### PatientProfile
Medical history and profile.

```sql
CREATE TABLE "PatientProfile" (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id         UUID NOT NULL UNIQUE REFERENCES "User"(id),
  date_of_birth      DATE,
  gender             VARCHAR(50),
  blood_type         VARCHAR(10),
  height_cm          INTEGER,
  weight_kg          DECIMAL(5,2),
  medications        TEXT[],    -- Array of medication names
  allergies          TEXT[],    -- Array of allergies
  chronic_conditions TEXT[],
  surgical_history   TEXT,
  family_history     TEXT,
  updated_at         TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_profile_patient (patient_id)
);
```

**Usage:** Store baseline patient medical information

---

### AuditLog
Compliance and audit trail.

```sql
CREATE TABLE "AuditLog" (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES "Tenant"(id),
  user_id       UUID REFERENCES "User"(id),  -- NULL for system
  action        VARCHAR(50),  -- CREATE|READ|UPDATE|DELETE
  entity_type   VARCHAR(100),  -- User|Message|Summary
  entity_id     UUID,
  changes       JSONB,  -- {before: {...}, after: {...}}
  ip_address    INET,
  user_agent    VARCHAR(500),
  created_at    TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_audit_tenant (tenant_id),
  INDEX idx_audit_user (user_id),
  INDEX idx_audit_entity (entity_type, entity_id),
  INDEX idx_audit_date (created_at)
);
```

**Usage:** HIPAA compliance, audit trails

**Queries:**
```sql
-- Find all changes to a patient's profile
SELECT * FROM "AuditLog"
WHERE entity_type = 'PatientProfile' AND entity_id = $1
ORDER BY created_at DESC;

-- Who accessed a consultation?
SELECT * FROM "AuditLog"
WHERE action = 'READ' AND entity_type = 'Message'
  AND entity_id IN (
    SELECT id FROM "Message" WHERE session_id = $1
  );
```

---

### StorageFile
File references (audio, documents).

```sql
CREATE TABLE "StorageFile" (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES "Tenant"(id),
  bucket_key  VARCHAR(500) NOT NULL,  -- MinIO path
  file_name   VARCHAR(255) NOT NULL,
  mime_type   VARCHAR(100),
  size_bytes  BIGINT,
  hash_sha256 VARCHAR(64),  -- For deduplication
  expires_at  TIMESTAMP,     -- For temp files
  created_at  TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_storage_tenant (tenant_id),
  INDEX idx_storage_key (bucket_key),
  UNIQUE (bucket_key)
);
```

**Usage:** Track uploaded audio, documents, etc.

---

## 🔍 Indexes Strategy

### Performance Indexes
```sql
-- User lookups (authentication)
CREATE INDEX idx_user_email_active 
ON "User"(tenant_id, email) 
WHERE is_active = true;

-- Consultation queries
CREATE INDEX idx_consultation_doctor_date 
ON "ConsultationSession"(doctor_id, started_at DESC);

-- Message ordering
CREATE INDEX idx_message_session_date 
ON "Message"(session_id, created_at DESC);

-- Audit compliance
CREATE INDEX idx_audit_date_tenant 
ON "AuditLog"(created_at DESC, tenant_id);
```

### Search Indexes (Full-text)
```sql
-- Medical text search
CREATE INDEX idx_summary_search 
ON "ConsultationSummary" 
USING GIN(to_tsvector('english', summary_text));
```

---

## 🔐 Tenant Isolation

All queries must include `tenant_id` verification:

```typescript
// Example: Get user's messages
const messages = await prisma.message.findMany({
  where: {
    session: {
      tenant_id: currentTenant.id,  // ← Required validation
    },
  },
});
```

Row-Level Security (optional extra layer):

```sql
-- Enable RLS
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see messages from their tenant
CREATE POLICY message_isolation ON "Message"
  USING (
    session_id IN (
      SELECT id FROM "ConsultationSession"
      WHERE tenant_id = current_setting('app.tenant_id')::uuid
    )
  );
```

---

## 🔗 Related Documentation

- [Database Package Codemap](./packages/database.md)
- [Domains Codemap](./packages/domains.md#-entity-relationships)
- [API Gateway Codemap](./services/api-gateway.md)

---

**Status**: ✅ Current | Schema documented
