/** Shared fixtures for the TASK-1036 management-screen tests (lineage register + version rows). */
import type { WorkflowDefinition, WorkflowLineage } from '../../../api/types';

export function lineage(overrides: Partial<WorkflowLineage> = {}): WorkflowLineage {
  return {
    slug: 'discharge',
    name: 'Discharge summary',
    paletteKey: 'summarization',
    versionCount: 4,
    latestVersionNumber: 3,
    deprecatedCount: 1,
    active: { id: 'd-v2', versionNumber: 2, publishedAt: '2026-09-02T10:00:00.000Z', publishedBy: null, registryChecksum: null, compiledConfigChecksum: 'sha256:two' },
    draft: { id: 'd-v3', versionNumber: 3, status: 'VALIDATED', updatedAt: '2026-09-03T10:00:00.000Z' },
    assignment: { tenantDefault: true, departmentCount: 0, selectorCount: 0 },
    origin: { sourceTemplateSlug: null, templateLocked: false },
    tags: ['dept:cardiology'],
    updatedAt: '2026-09-03T10:00:00.000Z',
    ...overrides,
  };
}

export const DRAFT_ONLY = lineage({
  slug: 'triage',
  name: 'Ward triage',
  versionCount: 1,
  latestVersionNumber: 1,
  deprecatedCount: 0,
  active: null,
  draft: { id: 't-v1', versionNumber: 1, status: 'DRAFT', updatedAt: '2026-09-01T10:00:00.000Z' },
  assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 },
  tags: [],
});

export const ALL_DEPRECATED = lineage({
  slug: 'old-flow',
  name: 'Old flow',
  versionCount: 2,
  latestVersionNumber: 2,
  deprecatedCount: 2,
  active: null,
  draft: null,
  assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 },
  tags: [],
});

export const LINEAGES = [lineage(), DRAFT_ONLY, ALL_DEPRECATED];

const REPORT_OK = { reportVersion: 1 as const, ok: true, findings: [], ruleSetVersion: 1, registryChecksum: 'r', evaluatedAt: '2026-09-03T10:00:00.000Z' };

export function version(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'd-v2',
    tenantId: 'tnt-1',
    slug: 'discharge',
    name: 'Discharge summary',
    description: null,
    paletteKey: 'summarization',
    versionNumber: 2,
    parentVersionId: null,
    status: 'PUBLISHED',
    graph: { version: 1, nodes: [], edges: [] },
    graphChecksum: 'g',
    compiledConfig: { ok: true },
    compiledConfigChecksum: 'sha256:two',
    registryChecksum: null,
    validationReport: REPORT_OK,
    needsReview: false,
    validatedAt: '2026-09-02T09:00:00.000Z',
    publishedAt: '2026-09-02T10:00:00.000Z',
    deprecatedAt: null,
    isActive: true,
    resourceStatus: 'ENABLED',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    version: 4,
    tags: [],
    ...overrides,
  };
}

/** v3 VALIDATED (ok report) · v2 PUBLISHED+active · v1 PUBLISHED inactive · v0 DEPRECATED. */
export const DISCHARGE_VERSIONS: WorkflowDefinition[] = [
  version({ id: 'd-v3', versionNumber: 3, status: 'VALIDATED', isActive: false, publishedAt: null, compiledConfig: null, compiledConfigChecksum: null }),
  version(),
  version({ id: 'd-v1', versionNumber: 1, isActive: false, publishedAt: '2026-08-01T10:00:00.000Z' }),
  version({ id: 'd-v0', versionNumber: 0, status: 'DEPRECATED', isActive: false, deprecatedAt: '2026-07-01T10:00:00.000Z' }),
];

export const TRIAGE_VERSIONS: WorkflowDefinition[] = [
  version({ id: 't-v1', slug: 'triage', name: 'Ward triage', versionNumber: 1, status: 'DRAFT', isActive: false, validationReport: null, publishedAt: null, compiledConfig: null, compiledConfigChecksum: null }),
];

export function session() {
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Global',
    impersonatingUserId: null,
    impersonatingUsername: null,
  };
  return { ...base, effectiveUser: { ...base.user, tenantId: null, departmentId: null }, effectiveIsElevated: true, effectiveTenantId: 'tnt-1' };
}

export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}
