/**
 * `pickDefaultDefinition` — TASK-893 OD-1.
 *
 * `/workflow-studio` no longer shows a grid; it resolves straight into the studio. WHICH row it
 * opens is the whole point of this function: 11 of the 12 seeded definitions are PUBLISHED, and
 * landing on a published one opens a studio where every gesture is refused — the exact report
 * this ticket answers. So an editable version wins over a newer published one, and recency only
 * breaks ties within a status class.
 */
import { describe, expect, it } from 'vitest';
import { pickDefaultDefinition } from '../workflow-studio-screen';
import type { WorkflowDefinition, WorkflowDefinitionStatus } from '../../api/types';

function row(id: string, status: WorkflowDefinitionStatus, updatedAt: string): WorkflowDefinition {
  return {
    id,
    tenantId: 'tnt-1',
    slug: `slug-${id}`,
    name: `Workflow ${id}`,
    description: null,
    paletteKey: 'summarization',
    versionNumber: 1,
    parentVersionId: null,
    status,
    graph: { version: 1, nodes: [], edges: [] },
    graphChecksum: 'chk',
    compiledConfig: null,
    compiledConfigChecksum: null,
    registryChecksum: null,
    validationReport: null,
    needsReview: false,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    isActive: false,
    resourceStatus: 'ENABLED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    version: 1,
    tags: [],
  };
}

describe('pickDefaultDefinition', () => {
  it('returns null for an empty tenant, so the screen can show the create affordances instead', () => {
    expect(pickDefaultDefinition([])).toBeNull();
  });

  it('prefers the newest EDITABLE version over a newer published one', () => {
    const picked = pickDefaultDefinition([
      row('published-newest', 'PUBLISHED', '2026-09-07T12:00:00.000Z'),
      row('draft-older', 'DRAFT', '2026-09-01T12:00:00.000Z'),
      row('validated-newer', 'VALIDATED', '2026-09-05T12:00:00.000Z'),
    ]);
    expect(picked?.id).toBe('validated-newer');
  });

  it('falls back to the newest row of any status when nothing is editable', () => {
    const picked = pickDefaultDefinition([
      row('a', 'PUBLISHED', '2026-08-01T00:00:00.000Z'),
      row('b', 'DEPRECATED', '2026-09-06T00:00:00.000Z'),
      row('c', 'PUBLISHED', '2026-09-02T00:00:00.000Z'),
    ]);
    expect(picked?.id).toBe('b');
  });
});
