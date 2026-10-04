/**
 * TASK-1036 R1 — agent tag suggestions: the caller tenant's own agents only (never SYSTEM),
 * normalised to lower case (Q16), counted per LINEAGE (a slug with four versions is one agent,
 * not four), ranked by count then alphabetically, `q` a case-insensitive substring, `limit`
 * 20 by default and capped at 100.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentService } from '../agent.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

function service(rows: Array<{ slug: string; tags: string[] }>) {
  const agentRepository = { findAllForTenant: vi.fn(async () => rows) };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };
  const svc = new AgentService(agentRepository as never, {} as never, {} as never, { emit: vi.fn() } as never, cls as never, {} as never);
  return { svc, agentRepository };
}

describe('AgentService.listTagSuggestions', () => {
  it('counts per lineage, normalises to lower case, ranks by count then name', async () => {
    const { svc, agentRepository } = service([
      { slug: 'note', tags: ['Dept:Cardiology', 'phase:live'] },
      { slug: 'note', tags: ['dept:cardiology'] }, // a second VERSION of the same lineage
      { slug: 'triage', tags: ['dept:cardiology', 'dept:er'] },
      { slug: 'summary', tags: ['dept:er'] },
    ]);
    expect(await svc.listTagSuggestions({})).toEqual([
      { tag: 'dept:cardiology', count: 2 },
      { tag: 'dept:er', count: 2 },
      { tag: 'phase:live', count: 1 },
    ]);
    expect(agentRepository.findAllForTenant).toHaveBeenCalledWith(TENANT);
  });

  it('filters by a case-insensitive substring and honours limit (capped at 100)', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ slug: `a${i}`, tags: [`k:v${String(i).padStart(3, '0')}`, 'other:x'] }));
    const { svc } = service(rows);
    const filtered = await svc.listTagSuggestions({ q: 'K:V00', limit: 5 });
    expect(filtered.map((s) => s.tag)).toEqual(['k:v000', 'k:v001', 'k:v002', 'k:v003', 'k:v004']);
    expect(await svc.listTagSuggestions({ q: 'k:', limit: 1000 })).toHaveLength(100);
    expect(await svc.listTagSuggestions({ q: 'k:' })).toHaveLength(20);
  });
});
