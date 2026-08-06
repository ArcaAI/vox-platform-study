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

  // TASK-615 — the two generic drift checks above only prove the two enums
  // AGREE; they would both stay green if a value were missing from BOTH. These
  // named assertions pin the three billing-plane resource types that actually
  // emit sys-events, so dropping one from the schema is a test failure rather
  // than a silent 500 on the first AuditLog INSERT (the TASK-366 failure mode).
  //
  // Deliberately ABSENT and asserted so below: the ledger, its outbox and the
  // rollups. They are append-only metering telemetry that emits NO sys-event
  // (the AgentTrajectoryStep precedent), so giving them a ResourceType would
  // advertise an audit surface that does not exist.
  describe('TASK-615 billing-plane resource types', () => {
    it.each(['AiPriceBook', 'BillingInvoice', 'BillingAdjustment'])('%s exists in BOTH enums (its mutations emit sys-events)', (value) => {
      expect(databaseValues.has(value), `${value} missing from the database ResourceType enum (audit.prisma)`).toBe(true);
      expect(domainValues.has(value), `${value} missing from the domain ResourceType enum`).toBe(true);
    });

    it.each(['AiUsageEvent', 'AiUsageOutbox', 'AiUsageRollupHourly', 'AiUsageRollupDaily', 'BillingInvoiceLine'])(
      '%s is deliberately NOT a ResourceType (no sys-events on write)',
      (value) => {
        expect(databaseValues.has(value)).toBe(false);
        expect(domainValues.has(value)).toBe(false);
      },
    );
  });
});
