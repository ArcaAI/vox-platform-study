# Database Package Codemap

**Last Updated:** 2026-03-14  
**Package:** `@arcaai/database`  
**Language:** TypeScript  
**ORM:** Prisma 7  
**Database:** PostgreSQL 18  
**Entry Point:** [src/index.ts](../../../../packages/database/src/index.ts)

---

## 📋 Purpose

Single source of truth for data access and schema definition. Provides Prisma ORM client, migrations, seeding, and database schema for the entire HOPE platform. Used by API Gateway and all backend services.

---

## 🗂️ Directory Structure

```
packages/database/src/
├── index.ts                   # Main export point
├── client.ts                  # Prisma client initialization
├── env.ts                     # Environment variable validation
│
├── prisma/                    # Prisma schema & migrations
│   ├── schema.prisma          # Database schema definition
│   ├── db_main/               # Main database migrations
│   │   ├── migration.lock
│   │   └── [timestamp]_*.sql  # Migration files
│   └── seed.ts                # Database seeding script
│
├── generated/                 # Generated files (Prisma)
│   ├── core-prisma-client/    # Prisma client (auto-generated)
│   └── index.ts               # Index of all models
│
├── integration/               # Integration utilities
│   ├── db.ts                  # Singleton Prisma instance
│   ├── transaction.ts         # Transaction helpers
│   └── middleware.ts          # Prisma middleware/hooks
│
└── __tests__/                 # Database integration tests
    ├── seed.test.ts
    └── migrations.test.ts
```

---

## 📊 Database Schema

### Core Entities

#### Multi-Tenancy
- **Tenant** — Tenant/account
  - `id` (UUID)
  - `name` string
  - `created_at` timestamp
  - `updated_at` timestamp

#### Users & Auth
- **User** — User profiles
  - `id` (UUID)
  - `tenant_id` (FK)
  - `email` string (unique per tenant)
  - `role` enum (admin | doctor | patient | support)
  - `password_hash` string (bcrypt)
  - `is_active` boolean
  - `created_at` timestamp

- **ApiKey** — API credentials
  - `id` (UUID)
  - `tenant_id` (FK)
  - `user_id` (FK)
  - `key_hash` string
  - `last_used_at` timestamp
  - `expires_at` timestamp (optional)

- **Session** — User sessions
  - `id` (UUID)
  - `user_id` (FK)
  - `token_hash` string
  - `expires_at` timestamp
  - `ip_address` string
  - `user_agent` string

#### Consultations
- **ConsultationSession** — Consultation metadata
  - `id` (UUID)
  - `tenant_id` (FK)
  - `doctor_id` (FK to User)
  - `patient_id` (FK to User)
  - `specialty` enum
  - `status` enum (active | completed | archived)
  - `started_at` timestamp
  - `ended_at` timestamp

- **Message** — Chat/consultation messages
  - `id` (UUID)
  - `session_id` (FK)
  - `sender_id` (FK to User)
  - `content` text
  - `message_type` enum (text | audio | summary)
  - `created_at` timestamp

#### Medical Data
- **PatientProfile** — Medical history
  - `id` (UUID)
  - `patient_id` (FK)
  - `medical_history` jsonb
  - `allergies` string[]
  - `medications` string[]
  - `updated_at` timestamp

- **ConsultationSummary** — Generated summaries
  - `id` (UUID)
  - `session_id` (FK)
  - `summary_text` text
  - `structured_data` jsonb (ICD-10, medications, etc.)
  - `generated_at` timestamp

#### Audit & Compliance
- **AuditLog** — Compliance logging
  - `id` (UUID)
  - `tenant_id` (FK)
  - `user_id` (FK, nullable)
  - `action` enum (CREATE | READ | UPDATE | DELETE)
  - `entity_type` string
  - `entity_id` UUID
  - `changes` jsonb (before/after)
  - `created_at` timestamp

#### File Storage
- **StorageFile** — Uploaded files (audio, documents)
  - `id` (UUID)
  - `tenant_id` (FK)
  - `bucket_key` string
  - `file_name` string
  - `mime_type` string
  - `size_bytes` integer
  - `created_at` timestamp
  - `expires_at` timestamp (optional)

---

## 🔐 Multi-Tenancy & Isolation

### Tenant Isolation Strategy
```sql
-- All tables include tenant_id as required column
-- RLS policies enforced at application level
-- Row-level security can be enabled for extra protection

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON "User"
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### Connection String
```
DATABASE_URL=postgresql://user:pass@localhost:5432/hope_db
```

---

## 🔌 Key Exports

### Prisma Client
```typescript
import { db } from '@arcaai/database/client';

// All Prisma operations available
await db.user.findUnique({ where: { id: userId } });
await db.consultationSession.create({ data: {...} });
```

### Types/Interfaces
```typescript
import type { User, ConsultationSession } from '@arcaai/database/client';
```

### Seeding
```bash
pnpm --filter @arcaai/database seed
```

---

## 🔄 Migrations Workflow

### Create Migration
```bash
# Make schema changes in src/prisma/schema.prisma
pnpm --filter @arcaai/database db:migrate
```

### Apply Migrations (Production)
```bash
pnpm --filter @arcaai/database db:migrate:deploy
```

### Reset Database (Development)
```bash
pnpm --filter @arcaai/database db:push:force
pnpm --filter @arcaai/database seed
```

---

## 🧩 Prisma Configuration

```prisma
// packages/database/src/prisma/schema.prisma

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
  output   = "../generated/core-prisma-client"
}

// Models defined here...
model Tenant {
  id        String   @id @default(cuid())
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  users            User[]
  consultations    ConsultationSession[]
  auditLogs        AuditLog[]
  storageFiles     StorageFile[]
}
```

---

## 🧪 Testing

**Run Seeding**:
```bash
pnpm --filter @arcaai/database seed
```

**Test Migrations**:
```bash
pnpm --filter @arcaai/database db:migrate
```

**Prisma Studio** (GUI):
```bash
pnpm db:studio
```

---

## 🔗 Dependencies

### External
- `@prisma/client@^7.0.0` — Prisma ORM client
- `@prisma/adapter-pg@^7.0.0` — PostgreSQL driver
- `@prisma/engines` — Native PostgreSQL engine

### Usage (API Gateway)
- API Gateway uses this package for all database access
- Python services use PostgreSQL directly (read-only)

---

## 📌 Integration Points

| Service | Usage |
|---------|-------|
| **API Gateway** | Primary ORM for all CRUD operations |
| **STT V2** | Read-only: Load configuration |
| **SMR V2** | Read-only: Conversation metadata |
| **NLP** | Read-only: Medical knowledge base |

---

## 🔗 Related Codemaps

- [Domains Package](./domains.md) — DDD entities layered on top
- [Applications Package](./applications.md) — Service layer using this package
- [API Gateway](../services/api-gateway.md) — Primary consumer

---

**Status**: ✅ Current | Schema is production-ready
