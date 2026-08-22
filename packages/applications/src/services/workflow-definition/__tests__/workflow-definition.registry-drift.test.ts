/**
 * TASK-790 W2 — registry-drift detection actually fires (TASK-789 finding H-2).
 *
 * `node-registry.ts` documents that a definition's stamped `registryChecksum` "is compared
 * against this at read time to trigger TASK-716's NEEDS_REVIEW re-validation". It never was:
 * `needsReview` is never assigned `true` anywhere in `packages/applications` or `apps/api` —
 * only entity/factory/mapper/DTO plumbing and a factory `?? false` default. Meanwhile the
 * seeded SYSTEM row's checksum (computed over 7 registry entries) is already stale against the
 * running registry (30 entries), so the drift this was meant to surface exists TODAY and is
 * invisible.
 *
 * The comparison is a READ-TIME derivation, not a write: PUBLISHED rows are hard-immutable by
 * service convention (`assertMutable`), and a read must never mutate. The stored column is
 * still honoured — it is OR'd, so an explicitly-flagged row stays flagged.
 */
import { describe, it, expect } from 'vitest';
import { registryChecksum } from '@arcaai/workflow-contract';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionDtoMapper } from '../workflow-definition.dto.mapper';

/** The checksum the seed stamped, over the 7-entry registry of the time (`seed/21-workflow-definition.ts`). */
const STALE_SEEDED_CHECKSUM = '2ae7222a00000000000000000000000000000000000000000000000000000000';

const entity = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'def-1',
    tenantId: 'tenant-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    paletteKey: 'summarization',
    versionNumber: 1,
    parentVersionId: null,
    status: overrides.status ?? WorkflowDefinitionStatus.PUBLISHED,
    graph: { version: 1, nodes: [], edges: [] },
    graphChecksum: 'c',
    compiledConfig: null,
    compiledConfigChecksum: null,
    registryChecksum: overrides.registryChecksum ?? STALE_SEEDED_CHECKSUM,
    validationReport: null,
    needsReview: overrides.needsReview ?? false,
    validatedAt: null,
    publishedAt: new Date('2026-08-16T00:00:00Z'),
    deprecatedAt: null,
    isActive: true,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-08-16T00:00:00Z'),
    updatedAt: new Date('2026-08-16T00:00:00Z'),
    version: 1,
    tags: [],
    ...overrides,
  }) as any;

describe('TASK-790 W2 — registryChecksum drift sets needsReview on read (H-2)', () => {
  it('flags a published definition stamped with a stale registry checksum', () => {
    const dto = WorkflowDefinitionDtoMapper.toResponse(entity({ registryChecksum: STALE_SEEDED_CHECKSUM }));

    expect(dto.needsReview).toBe(true);
  });

  it('does not flag a definition stamped with the CURRENT registry checksum', () => {
    const dto = WorkflowDefinitionDtoMapper.toResponse(entity({ registryChecksum: registryChecksum() }));

    expect(dto.needsReview).toBe(false);
  });

  it('does not flag a DRAFT — registryChecksum is null until publish, so a draft cannot drift', () => {
    const dto = WorkflowDefinitionDtoMapper.toResponse(entity({ status: WorkflowDefinitionStatus.DRAFT, registryChecksum: null }));

    expect(dto.needsReview).toBe(false);
  });

  it('honours an explicitly stored needsReview even with no drift', () => {
    const dto = WorkflowDefinitionDtoMapper.toResponse(entity({ registryChecksum: registryChecksum(), needsReview: true }));

    expect(dto.needsReview).toBe(true);
  });

  it('surfaces the running checksum alongside the stamped one so a client can see WHAT drifted', () => {
    const dto = WorkflowDefinitionDtoMapper.toResponse(entity({ registryChecksum: STALE_SEEDED_CHECKSUM }));

    expect(dto.registryChecksum).toBe(STALE_SEEDED_CHECKSUM);
    expect(dto.currentRegistryChecksum).toBe(registryChecksum());
  });
});
