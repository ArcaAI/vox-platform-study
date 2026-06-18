/**
 * ResourceType enum parity guard — TASK-366.
 *
 * Every value declared in the domain-layer `ResourceType` enum is an
 * authoritative value that application services pass to
 * `broadcastSysEvent(...)`, which persists it on `AuditLog.resourceType`.
 * Each one MUST therefore also exist in the database enum that Prisma
 * generates from `audit.prisma`.
 *
 * When they drift, the AuditLog INSERT fails at runtime with
 * "Invalid value for argument `resourceType`. Expected ResourceType." and
 * rolls the originating create/update/delete back into a 500/404. That was
 * the TASK-366 bug: `UserVoiceProfile`, `Highlight`, `UserDepartment`,
 * `TenantFrontendConfig` and `AsrPipelineVersion` lived in the domain enum
 * (and were emitted by their services) but had never been added to the DB
 * enum when their tables were created.
 *
 * The reverse direction is allowed — the DB enum may hold values the domain
 * layer never emits (e.g. `Session`, `AudioRecording`) — so this asserts a
 * subset relationship, not equality.
 */
import { describe, it, expect } from 'vitest';
import { ResourceType as PrismaResourceType } from '@arcaai/database';
import { ResourceType as DomainResourceType } from '../index';

describe('ResourceType enum parity (domain ⊆ database)', () => {
  it('every domain ResourceType value exists in the database enum', () => {
    const databaseValues = new Set<string>(Object.values(PrismaResourceType));

    const missingFromDatabase = Object.values(DomainResourceType).filter((value) => !databaseValues.has(value));

    expect(
      missingFromDatabase,
      'Domain ResourceType values are missing from the database enum. Add each ' +
        'to packages/database/src/prisma/db_main/audit.prisma AND a migration ' +
        `(ALTER TYPE "core"."ResourceType" ADD VALUE ...): ${missingFromDatabase.join(', ')}`,
    ).toEqual([]);
  });
});
