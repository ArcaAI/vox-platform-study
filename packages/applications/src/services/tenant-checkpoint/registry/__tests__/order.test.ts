import { describe, expect, it, vi } from 'vitest';
import { insertOrder, loadFkEdges, type FkEdge } from '../order';

describe('insertOrder', () => {
  const edges: FkEdge[] = [
    { child: 'ContextItem', parent: 'Consultation', column: 'consultationId' },
    { child: 'AudioRecording', parent: 'ContextItem', column: 'contextItemId' },
    { child: 'Consultation', parent: 'Consultation', column: 'parentConsultationId' },
  ];

  it('puts parents before children and ignores self-edges', () => {
    expect(insertOrder(['ContextItem', 'Consultation', 'AudioRecording'], edges)).toEqual([
      'Consultation',
      'ContextItem',
      'AudioRecording',
    ]);
  });

  it('ignores edges to models outside the set and keeps input order among independents', () => {
    expect(insertOrder(['Tag', 'ContextItem', 'Department'], edges)).toEqual(['Tag', 'ContextItem', 'Department']);
  });

  it('throws on a cycle between two distinct tables, naming both', () => {
    const cyclic: FkEdge[] = [
      { child: 'A', parent: 'B', column: 'bId' },
      { child: 'B', parent: 'A', column: 'aId' },
    ];
    expect(() => insertOrder(['A', 'B', 'C'], cyclic)).toThrow(/A.*B|B.*A/);
  });
});

describe('loadFkEdges', () => {
  it('reads pg_constraint for schema core and maps tables back to models', async () => {
    const query = vi.fn().mockResolvedValue([
      { child: 'core."ContextItem"', parent: 'core."Consultation"', column: 'consultationId' },
      { child: 'core.updates', parent: 'core.rounds', column: 'roundId' },
    ]);
    const edges = await loadFkEdges(query as never);
    expect(edges).toEqual([
      { child: 'ContextItem', parent: 'Consultation', column: 'consultationId' },
      { child: 'FedlUpdate', parent: 'FedlRound', column: 'roundId' },
    ]);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("c.contype = 'f'");
    expect(sql).toContain("'core'::regnamespace");
  });
});
