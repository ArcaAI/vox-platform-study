/**
 * ResourceType enum parity guard.
 *
 * The domain-layer `ResourceType` enum (`@arcaai/domains`) and the database
 * enum that Prisma generates from `audit.prisma` (`@arcaai/database`) MUST be
 * kept in lock-step. Drift in either direction is a bug:
 *
 *   - A value in the DOMAIN enum but missing from the DATABASE enum makes the
 *     `AuditLog` INSERT throw at runtime ("Invalid value for argument
 *     `resourceType`. Expected ResourceType.") and rolls the originating
 *     create/update/delete back into a 500/404. This was a real bug
 *     (`UserVoiceProfile`, `Highlight`, `UserDepartment`, `TenantFrontendConfig`,
 *     `AsrPipelineVersion`).
 *
 *   - A value in the DATABASE enum but missing from the DOMAIN enum means the
 *     application layer can never emit or exhaustively handle that resource
 *     type (`AudioRecording`, `SummaryMeta`, `NamedEntity` had drifted this
 *     way; the dead `Session`, `SessionEvent`, `SessionSyncLog` scaffolding was
 *     removed from both enums entirely afterward).
 *
 * To fix a failure: add the missing value(s) to BOTH
 *   - packages/database/src/prisma/db_main/audit.prisma (+ an ADD VALUE migration), and
 *   - packages/domains/src/enums/generated/ResourceType.ts
 */
import { describe, it, expect } from 'vitest';
import { ResourceType as PrismaResourceType } from '@arcaai/database';
import { ResourceType as DomainResourceType } from '../index';

describe('ResourceType enum parity (domain ⇔ database)', () => {
  const databaseValues = new Set<string>(Object.values(PrismaResourceType));
  const domainValues = new Set<string>(Object.values(DomainResourceType));

  it('every domain ResourceType value exists in the database enum', () => {
    const missingFromDatabase = Object.values(DomainResourceType).filter((value) => !databaseValues.has(value));

    expect(
      missingFromDatabase,
      'Domain ResourceType values are missing from the database enum. Add each ' +
        'to packages/database/src/prisma/db_main/audit.prisma AND a migration ' +
        `(ALTER TYPE "core"."ResourceType" ADD VALUE ...): ${missingFromDatabase.join(', ')}`,
    ).toEqual([]);
  });

  it('every database ResourceType value exists in the domain enum', () => {
    const missingFromDomain = Object.values(PrismaResourceType).filter((value) => !domainValues.has(value));

    expect(
      missingFromDomain,
      'Database ResourceType values are missing from the domain enum. Add each ' +
        'to packages/domains/src/enums/generated/ResourceType.ts: ' +
        `${missingFromDomain.join(', ')}`,
    ).toEqual([]);
  });
});
