/**
 * Soft-Delete Extension Unit Tests
 *
 * Tests the exported pure functions that power the soft-delete Prisma extension:
 *   - applySoftDeleteFilter: mutates query args to exclude DELETED records
 *   - modelHasSoftDelete: determines if a model has a resourceStatus column
 *   - MODELS_WITHOUT_SOFT_DELETE: the authoritative set of excluded models
 *
 * These tests exercise the REAL functions directly -- no hand-rolled handler
 * simulations. The Prisma client/adapter mocks exist only to satisfy the
 * module's top-level imports; the functions under test don't use them.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../generated/core-prisma-client/client.js', () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $extends: vi.fn().mockReturnThis(),
  })),
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {},
    PrismaClientUnknownRequestError: class extends Error {},
    PrismaClientRustPanicError: class extends Error {},
    PrismaClientInitializationError: class extends Error {},
    PrismaClientValidationError: class extends Error {},
  },
}));

vi.mock('../env.js', () => ({}));

import { applySoftDeleteFilter, modelHasSoftDelete, MODELS_WITHOUT_SOFT_DELETE } from '../client';

// ---------------------------------------------------------------------------
// applySoftDeleteFilter — pure function tests
// ---------------------------------------------------------------------------

describe('applySoftDeleteFilter', () => {
  it('should add resourceStatus filter when where clause has no resourceStatus', () => {
    const args = { where: { name: 'test' } };
    applySoftDeleteFilter(args);

    expect(args.where).toEqual({
      name: 'test',
      resourceStatus: { not: 'DELETED' },
    });
  });

  it('should add resourceStatus filter when where clause is empty', () => {
    const args = { where: {} };
    applySoftDeleteFilter(args);

    expect(args.where).toEqual({ resourceStatus: { not: 'DELETED' } });
  });

  it('should create where clause when undefined', () => {
    const args: { where?: Record<string, unknown> } = {};
    applySoftDeleteFilter(args);

    expect(args.where).toEqual({ resourceStatus: { not: 'DELETED' } });
  });

  it('should preserve existing fields when adding filter', () => {
    const args = {
      where: {
        tenantId: 'tenant-1',
        OR: [{ name: 'a' }, { name: 'b' }],
        AND: [{ active: true }],
      },
    };
    applySoftDeleteFilter(args);

    expect(args.where).toEqual({
      tenantId: 'tenant-1',
      OR: [{ name: 'a' }, { name: 'b' }],
      AND: [{ active: true }],
      resourceStatus: { not: 'DELETED' },
    });
  });

  describe('should NOT override explicit resourceStatus', () => {
    const bypassCases = [
      { resourceStatus: 'ENABLED', label: 'string ENABLED' },
      { resourceStatus: 'DISABLED', label: 'string DISABLED' },
      { resourceStatus: 'ARCHIVED', label: 'string ARCHIVED' },
      { resourceStatus: 'DELETED', label: 'string DELETED' },
      { resourceStatus: { in: ['ENABLED', 'DELETED'] }, label: 'in array' },
      { resourceStatus: { not: 'ARCHIVED' }, label: 'not condition' },
      { resourceStatus: { notIn: ['DELETED'] }, label: 'notIn condition' },
      { resourceStatus: { equals: 'ENABLED' }, label: 'equals condition' },
    ];

    bypassCases.forEach(({ resourceStatus, label }) => {
      it(`preserves explicit ${label}`, () => {
        const args = { where: { resourceStatus } };
        applySoftDeleteFilter(args);

        expect(args.where!.resourceStatus).toEqual(resourceStatus);
      });
    });
  });

  describe('should override falsy resourceStatus values', () => {
    const falsyCases = [
      { resourceStatus: null, label: 'null' },
      { resourceStatus: undefined, label: 'undefined' },
      { resourceStatus: '', label: 'empty string' },
      { resourceStatus: 0, label: 'zero' },
      { resourceStatus: false, label: 'false' },
    ];

    falsyCases.forEach(({ resourceStatus, label }) => {
      it(`replaces falsy ${label} with filter`, () => {
        const args = { where: { resourceStatus } };
        applySoftDeleteFilter(args);

        expect(args.where!.resourceStatus).toEqual({ not: 'DELETED' });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// modelHasSoftDelete — pure function tests
// ---------------------------------------------------------------------------

describe('modelHasSoftDelete', () => {
  describe('returns true for models WITH resourceStatus', () => {
    const modelsWithSoftDelete = ['User', 'Consultation', 'ContextItem', 'Department', 'Tenant', 'ApiKey', 'AiModel', 'Role', 'Webhook', 'Media'];

    modelsWithSoftDelete.forEach((model) => {
      it(`${model} (PascalCase)`, () => {
        expect(modelHasSoftDelete(model)).toBe(true);
      });
    });
  });

  describe('returns false for models WITHOUT resourceStatus (PascalCase)', () => {
    const expected = [
      'ContextItemVersion',
      'PromptVersion',
      'DnaWritingStyleVersion',
      'AsrPipelineVersion',
      'DnaUsageRecord',
      'PromptUsageRecord',
      'AudioRecording',
      'SummaryMeta',
      'NamedEntity',
      'TranscriptionJob',
      'HarnessAuditEvent',
      // ordered ops-telemetry trajectory: retention-pruned
      // (hard delete), no resourceStatus column, so soft-delete is skipped.
      'AgentTrajectoryStep',
      // per-transcript segment annotation: no resourceStatus column
      // (segments live/die with their parent transcript), so soft-delete skips it.
      'TranscriptSegment',
      // Gate-edit mining store: derived append-only corpus, pruned
      // wholesale rather than soft-deleted, so it has no resourceStatus column.
      'GateEditExemplar',
      // The usage ledger and everything derived from it. All four
      // are APPEND-ONLY metering artifacts with hard retention (raw events 18
      // months, rollups indefinitely) rather than the ENABLED/DELETED
      // soft-delete lifecycle, so none carries a `resourceStatus` column and
      // `softDelete()`/`restore()` must throw for them. Correcting a usage fact
      // is a compensating event, never a delete.
      'AiUsageEvent',
      'AiUsageOutbox',
      'AiUsageRollupHourly',
      'AiUsageRollupDaily',
      // Rule 6 — the provider-reconciliation audit trail.
      'ProviderReconciliationRun',
      // A credit memo against a FINALIZED invoice. Finalized
      // periods are immutable, so an adjustment can never be retracted by
      // deleting it; the correction path is another adjustment. No
      // `resourceStatus` column.
      'BillingAdjustment',
      // #6 — append-only plan-change facts for fee proration. A plan
      // window is corrected by appending, never by deleting closed history.
      'TenantPlanHistory',
      // Service Version & Release Registry. ServiceInstance is a
      // heartbeated runtime observation pruned wholesale by the existing
      // scheduler surface, not soft-deleted. ChangelogEntry moves
      // DRAFT -> PUBLISHED only. UserChangelogAcknowledgement rows are
      // immutable acknowledgement facts. None carries a `resourceStatus`
      // column (ServiceRelease is DELIBERATELY NOT here — it keeps the
      // standard lifecycle).
      'ServiceInstance',
      'ChangelogEntry',
      'UserChangelogAcknowledgement',
      // An immutable published snapshot of a tenant's context
      // declaration (the PromptVersion / AsrPipelineVersion shape). A
      // ContextItem validated against version N must resolve version N
      // forever, so retraction is not available and the table carries no
      // `resourceStatus` column. The MUTABLE head `ConsultationContextSchema`
      // is deliberately NOT here — it keeps the standard lifecycle.
      'ConsultationContextSchemaVersion',
      // An immutable snapshot of a DepartmentAgent's
      // loop-configuration surface (the same PromptVersion /
      // ConsultationContextSchemaVersion shape). A consultation loop pinned
      // to version N must resolve version N forever, so retraction is not
      // available and the table carries no `resourceStatus` column. The
      // MUTABLE head `DepartmentAgent` is deliberately NOT here — it keeps
      // the standard lifecycle.
      'DepartmentAgentVersion',
      // A WORM record of one agent promotion between tenants.
      // Written once, never updated (a re-promotion writes a NEW row), so the
      // table is an audit history whose whole value is that entries cannot be
      // retracted. No `resourceStatus` column.
      'AgentPromotion',
      // WorkflowRun (TASK-723) — the runs/observability read model. Same
      // operational-telemetry posture as AgentTrajectoryStep: hard-retention
      // history, no `resourceStatus` column.
      'WorkflowRun',
      // TASK-733 — append-only WORM change log for workflow assignments (no
      // `resourceStatus` column; rows are immutable).
      'WorkflowAssignmentChange',
      // DocumentTemplateVersion (TASK-810) — an immutable published snapshot of
      // a clinical-document SHAPE plus the artifacts compiled from it. The same
      // PromptVersion / ConsultationContextSchemaVersion posture: a document
      // generated against version N must resolve version N forever, so there is
      // no `resourceStatus` column and no retraction. The MUTABLE head
      // `DocumentTemplate` is deliberately NOT here — it keeps the standard
      // lifecycle. A DB trigger enforces the same thing one layer down (OD-13).
      'DocumentTemplateVersion',
    ];

    expected.forEach((model) => {
      it(model, () => {
        expect(modelHasSoftDelete(model)).toBe(false);
      });
    });

    it('matches the MODELS_WITHOUT_SOFT_DELETE set exactly', () => {
      expect(new Set(expected)).toEqual(MODELS_WITHOUT_SOFT_DELETE);
    });
  });

  describe('returns false for models WITHOUT resourceStatus (camelCase)', () => {
    const camelCaseModels = [
      'contextItemVersion',
      'promptVersion',
      'dnaWritingStyleVersion',
      'asrPipelineVersion',
      'dnaUsageRecord',
      'promptUsageRecord',
      'audioRecording',
      'summaryMeta',
      'namedEntity',
      'transcriptionJob',
      'harnessAuditEvent',
      'agentTrajectoryStep',
      'gateEditExemplar',
    ];

    camelCaseModels.forEach((model) => {
      it(model, () => {
        expect(modelHasSoftDelete(model)).toBe(false);
      });
    });
  });

  it('returns true for unknown models (safe default)', () => {
    expect(modelHasSoftDelete('SomeNewModel')).toBe(true);
    expect(modelHasSoftDelete('FutureTable')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extension handler contract tests
//
// These verify the contract that the Prisma $allModels handlers follow:
//   "if modelHasSoftDelete(model) && operation != findUnique → applySoftDeleteFilter"
//
// We call the real functions in the same order the extension does, so any
// drift between the test and the production extension is immediately visible
// by comparing this file to createExtendedPrismaClient in client.ts.
// ---------------------------------------------------------------------------

describe('Extension handler contract', () => {
  const FILTERED_OPERATIONS = ['findMany', 'findFirst', 'count', 'aggregate', 'groupBy'] as const;

  /**
   * Simulates what the real extension handler does for a given operation.
   * Kept intentionally minimal so it's easy to compare with client.ts.
   */
  function simulateExtensionHandler(operation: string, model: string, args: { where?: Record<string, unknown> }) {
    if (operation !== 'findUnique' && modelHasSoftDelete(model)) {
      applySoftDeleteFilter(args);
    }
  }

  describe('models WITH resourceStatus', () => {
    FILTERED_OPERATIONS.forEach((op) => {
      it(`${op} adds resourceStatus filter`, () => {
        const args = { where: { tenantId: 'tenant-1' } };
        simulateExtensionHandler(op, 'Department', args);

        expect(args.where!.resourceStatus).toEqual({ not: 'DELETED' });
      });
    });

    it('findUnique does NOT add filter', () => {
      const args = { where: { id: 'dept-123' } };
      simulateExtensionHandler('findUnique', 'Department', args);

      expect(args.where!.resourceStatus).toBeUndefined();
    });
  });

  describe('models WITHOUT resourceStatus', () => {
    const excludedModels = Array.from(MODELS_WITHOUT_SOFT_DELETE);

    excludedModels.forEach((model) => {
      FILTERED_OPERATIONS.forEach((op) => {
        it(`${model}.${op} does NOT add filter`, () => {
          const args = { where: { contextItemId: 'item-123' } };
          simulateExtensionHandler(op, model, args);

          expect(args.where!.resourceStatus).toBeUndefined();
          expect(args.where).toEqual({ contextItemId: 'item-123' });
        });
      });
    });
  });

  describe('preserves non-where args', () => {
    it('does not touch skip, take, orderBy', () => {
      const args = {
        where: { tenantId: 'tenant-1' },
        skip: 10,
        take: 20,
        orderBy: { createdAt: 'desc' },
      } as any;

      simulateExtensionHandler('findMany', 'User', args);

      expect(args.skip).toBe(10);
      expect(args.take).toBe(20);
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.where.resourceStatus).toEqual({ not: 'DELETED' });
    });
  });
});

// ---------------------------------------------------------------------------
// AsrPipelineVersion 400 regression
//
// AsrPipelineVersion is an immutable version-history table with NO
// `resourceStatus` column (see prisma db_main/stt.prisma + the
// 20260602000000 migration). It was missing from MODELS_WITHOUT_SOFT_DELETE,
// so the soft-delete extension injected `resourceStatus: { not: 'DELETED' }`
// into every read — an invalid Prisma `where` for a column that does not
// exist. At runtime that throws PrismaClientValidationError on
// `GET /admin/audio/pipelines/:id/versions`, which the API exception
// interceptor collapses to a bare `400 Bad Request`. The model must be
// soft-delete-exempt, exactly like its sibling version tables
// (PromptVersion, DnaWritingStyleVersion, ContextItemVersion).
// ---------------------------------------------------------------------------

describe('AsrPipelineVersion is soft-delete exempt (no resourceStatus column)', () => {
  it('modelHasSoftDelete returns false for both casings', () => {
    expect(modelHasSoftDelete('AsrPipelineVersion')).toBe(false);
    expect(modelHasSoftDelete('asrPipelineVersion')).toBe(false);
  });

  it('the soft-delete handler does NOT inject resourceStatus for an AsrPipelineVersion read', () => {
    // Mirrors the production $allModels.findMany handler in client.ts:
    //   if (modelHasSoftDelete(model)) applySoftDeleteFilter(args)
    const args: { where?: Record<string, unknown> } = { where: { asrPipelineId: 'pipeline-1' } };
    if (modelHasSoftDelete('asrPipelineVersion')) {
      applySoftDeleteFilter(args);
    }
    // The query that actually reaches Postgres must stay a valid `where` for a
    // table with no `resourceStatus` column (the GET /versions 400 root cause).
    expect(args.where).toEqual({ asrPipelineId: 'pipeline-1' });
    expect(args.where?.resourceStatus).toBeUndefined();
  });
});
