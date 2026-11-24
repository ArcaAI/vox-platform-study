# Incident Report: Consultation Lifecycle 400 (`PERSISTENCE.QUERY_INVALID`)

- **Date:** 25 October 2026
- **Service Affected:** API Gateway (`hope-api-gateway`) / Consultation Scribe
- **Error Code:** `PERSISTENCE.QUERY_INVALID` (HTTP 400 Bad Request)
- **Correlation ID:** `req_7_1792917865535`
- **Impacted Route:** `POST /api/v1/consultations/open`
- **Status:** **Resolved**

---

## 1. Executive Summary

Clinicians encountering errors in the Consultation Scribe UI received an HTTP 400 error (`PERSISTENCE.QUERY_INVALID`) when attempting to open or finalize consultations. 

Investigation of the API Gateway logs using the request's `correlationId` revealed that Prisma failed to deserialize consultation database records due to an enum mismatch: the database contained historical rows with obsolete statuses (`DRAINING` and `TIMED_OUT`) that were pruned as part of the recent consultation lifecycle schema simplification (TASK-1045).

The legacy rows were migrated directly in PostgreSQL to their mapped 7-state equivalents, immediately restoring normal service operation.

---

## 2. Incident Details

### Client Response
```json
{
  "statusCode": 400,
  "code": "PERSISTENCE.QUERY_INVALID",
  "message": "Bad Request",
  "error": "Bad Request",
  "correlationId": "req_7_1792917865535"
}
```

### Server Error Log (API Gateway)
```text
prisma:error
Invalid `prisma.consultation.findFirst()` invocation:

Value 'DRAINING' not found in enum 'ConsultationStatus'
{
  "level": "error",
  "message": "Request failed",
  "requestId": "req_7_1792917865535",
  "route": "/api/v1/consultations/open",
  "status": 400,
  "code": "PERSISTENCE.QUERY_INVALID",
  "errorName": "PrismaClientKnownRequestError",
  "prismaCode": "P2023",
  "modelName": "Consultation",
  "prismaMessage": "Value 'DRAINING' not found in enum 'ConsultationStatus'"
}
```

---

## 3. Root Cause Analysis

1. **Schema Evolution (TASK-1045):**
   The consultation lifecycle was refactored and simplified from an older 12-state model down to a strict **7-state model** in `enums.prisma`:
   - `OPEN`
   - `RECORDING`
   - `PAUSED`
   - `STOPPED`
   - `APPROVED`
   - `CLOSED_COMPLETE`
   - `CLOSED_INCOMPLETE`

2. **Orphaned Database State:**
   While the application codebase and generated Prisma Client were updated to the 7-state enum, the cluster database (`hope_db` on `postgres-pgvector-db-0`) retained 4 historical consultation records stored with legacy statuses:
   - `DRAINING`: 2 rows
   - `TIMED_OUT`: 2 rows

3. **Prisma Deserialization Failure:**
   When a user opened or queried a consultation, `prisma.consultation.findFirst()` loaded records from `core."Consultation"`. Because `'DRAINING'` was no longer declared in the Prisma Client's TypeScript enum, Prisma threw error `P2023` (*Value not found in enum*).

4. **Sanitized Error Masking:**
   The API Gateway's `ExceptionInterceptor` correctly sanitizes database errors to prevent leaking internal database schemas or patient details to public clients. As a result, the unmapped Prisma `P2023` error was surfaced to the UI as the generic fallback error code: `PERSISTENCE.QUERY_INVALID`.

---

## 4. Remediation Steps Applied

### Step 1: Database Inspection
Connected to `postgres-pgvector-db-0` in `project-hope-vox-infra` and confirmed the status distribution in `core."Consultation"`:

```sql
SELECT status, count(*) FROM core."Consultation" GROUP BY status;
```

**Output Before Fix:**
| Status | Count | Classification |
| :--- | :---: | :--- |
| `DRAINING` | 2 | **Obsolete (Legacy)** |
| `TIMED_OUT` | 2 | **Obsolete (Legacy)** |
| `OPEN` | 1 | Valid |
| `STOPPED` | 2 | Valid |
| `CLOSED_COMPLETE` | 2 | Valid |
| `CLOSED_INCOMPLETE` | 20 | Valid |

---

### Step 2: Data Migration
Applied the official TASK-1045 migration mapping:
- `DRAINING` ➔ `STOPPED`
- `TIMED_OUT` ➔ `CLOSED_INCOMPLETE`

```sql
UPDATE core."Consultation" 
SET status = 'STOPPED' 
WHERE status = 'DRAINING';

UPDATE core."Consultation" 
SET status = 'CLOSED_INCOMPLETE' 
WHERE status = 'TIMED_OUT';
```

---

### Step 3: Verification
Re-queried `core."Consultation"`:

```sql
SELECT status, count(*) FROM core."Consultation" GROUP BY status;
```

**Output After Fix:**
| Status | Count | Status |
| :--- | :---: | :--- |
| `OPEN` | 1 | Valid |
| `STOPPED` | 4 | Valid |
| `CLOSED_COMPLETE` | 2 | Valid |
| `CLOSED_INCOMPLETE` | 22 | Valid |

Total non-compliant records remaining: **0**.

---

## 5. Current Status & Verification

- All records in `core."Consultation"` conform 100% to the active `ConsultationStatus` enum.
- Requests to `/api/v1/consultations/open` and related lifecycle endpoints execute without Prisma deserialization errors.
- Issue is fully resolved in the cluster environment.
