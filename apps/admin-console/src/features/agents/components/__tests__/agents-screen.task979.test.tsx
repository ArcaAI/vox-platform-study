/**
 * TASK-979 — the Agents grid keeps its filters in the `f`-encoded URL param
 * (`grid-url-state.ts`) and never read a bare `task` param, so the four existing deep links
 * (`enrollment-blocked-card.tsx`, and the retired `/audio/pipelines`, `/ai-model-defaults`,
 * `/ai-configuration` redirects — all `?task=SPEECH_TO_TEXT`) landed on the unfiltered list.
 * `?task=<value>` now seeds the Task filter once at mount, translated into the grid's own `f`
 * filter state, and the `task` param is dropped from the URL in the same step — `f` stays the
 * single source of truth for "what is the active filter", so clearing it afterwards actually
 * clears it.
 *
 * Test-harness note: `NuqsTestingAdapter` (`hasMemory` off, the default `renderWithProviders`
 * uses) only reports state writes through `onUrlUpdate` — it deliberately does not feed a
 * self-triggered update back into a live re-render once an unrelated async update (here, the
 * `useAgents()` fetch resolving) forces nuqs to resync from its own un-mutated store. So the
 * "task → f, task dropped" translation is asserted via `onUrlUpdate` (matching the existing
 * convention, e.g. `users-list-screen.test.tsx`'s sort-header test), and the "narrows the grid" /
 * "clearing stays cleared" outcomes are asserted by mounting with the exact `f` encoding that
 * translation produces — proving the mechanism the deep link now feeds into.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { AgentLineage } from '../../api/types';
import { AgentsScreen } from '../agents-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The exact `f` encoding `?task=SPEECH_TO_TEXT` is expected to translate into (`grid-url-state.ts`'s positional-tuple codec, the same shape the Task column's multiSelect facet already produces). */
const SEEDED_TASK_FILTER = `f=${encodeURIComponent(JSON.stringify([['task', 'inArray', 'multiSelect', ['SPEECH_TO_TEXT']]]))}`;

/**
 * TASK-965 WS-4 — the grid reads the LINEAGE register, and `task` is that route's own first-class
 * query field, so the deep link's translated `f` rule is lifted back out of the filter grammar and
 * sent as `?task=`. The narrowing therefore happens on the SERVER; these fixtures are the three
 * lineages it folds.
 */
function lineage(slug: string, name: string, task: AgentLineage['task'], id: string): AgentLineage {
  return {
    slug,
    name,
    task,
    versionCount: 1,
    latestVersionNumber: 1,
    deprecatedCount: 0,
    active: { id, versionNumber: 1, publishedAt: '2026-09-02T10:00:00.000Z', publishedBy: null, modelSlug: 'lms-gemma-4-e2b-it-qat', compiledConfigChecksum: null },
    draft: null,
    assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 },
    origin: { sourceTenantId: null, sourceSlug: null },
    tags: [],
    updatedAt: '2026-09-02T10:00:00.000Z',
    hidden: false,
  };
}

const LINEAGES: AgentLineage[] = [
  lineage('clinic-summarizer', 'Clinic summarizer', 'TEXT_GENERATION', 'a-1'),
  lineage('clinic-transcription', 'Clinic transcription', 'SPEECH_TO_TEXT', 'a-2'),
  lineage('clinic-tts', 'Clinic TTS', 'TEXT_TO_SPEECH', 'a-3'),
];

function session() {
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
  };
  return { ...base, effectiveUser: { ...base.user, tenantId: null, departmentId: null }, effectiveIsElevated: true, effectiveTenantId: 'tnt-1' };
}

function stubAgents() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      const path = url.pathname;
      if (path.includes('/users/me/settings')) return Response.json([]);
      if ((init?.method ?? 'GET') !== 'GET') return Response.json({ ok: true });
      if (path === '/api/auth/session') return Response.json(session());
      if (path === '/api/hope/admin/agents/lineages') {
        const task = url.searchParams.get('task');
        const data = LINEAGES.filter((row) => !task || row.task === task);
        return Response.json({ count: data.length, page: 1, limit: 25, data });
      }
      if (path === '/api/hope/admin/agent-assignments') return Response.json([]);
      if (path === '/api/hope/admin/ai-models/catalogue') return Response.json({ providers: [], models: [] });
      // `CreateAgentWizard` (rendered unconditionally alongside the grid, `open`-gated) resolves
      // these regardless of dialog visibility — arrays/envelopes, matching `agents-screen.test.tsx`.
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([]);
      if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [] });
      return Response.json([]);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentsScreen — `?task=` deep link (TASK-979)', () => {
  it('translates `?task=SPEECH_TO_TEXT` into the grid’s own `f` filter and drops `task` from the URL', async () => {
    stubAgents();
    const onUrlUpdate = vi.fn();
    renderWithProviders(<AgentsScreen />, { searchParams: 'task=SPEECH_TO_TEXT', onUrlUpdate });
    await screen.findByText('Clinic transcription');
    await waitFor(() => {
      const last = onUrlUpdate.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams };
      expect(last.searchParams.get('task')).toBeNull();
      expect(last.searchParams.get('f')).toContain('SPEECH_TO_TEXT');
    });
  });

  it('the translated `f` filter narrows the grid to that task’s agents only', async () => {
    stubAgents();
    renderWithProviders(<AgentsScreen />, { searchParams: SEEDED_TASK_FILTER });
    await screen.findByText('Clinic transcription');
    // Server-side narrowing: the register answers one lineage and counts one.
    await waitFor(() => expect(screen.getByText('1 of 1 agents')).toBeTruthy());
    expect(screen.queryByText('Clinic summarizer')).toBeNull();
  });

  it('ignores an unrecognised task value without crashing, showing the unfiltered list', async () => {
    stubAgents();
    renderWithProviders(<AgentsScreen />, { searchParams: 'task=NOT_A_REAL_TASK' });
    await screen.findByText('Clinic summarizer');
    expect(screen.getByText('Clinic transcription')).toBeTruthy();
    expect(screen.getByText('Clinic TTS')).toBeTruthy();
  });

  it('clearing the filter afterwards actually clears it', async () => {
    // Mounted with `task` already absent (as it is once the deep link has been consumed) — a
    // lingering `task` param would have nothing to re-seed the rule from here, proving the
    // cleared state sticks.
    //
    // TASK-965 WS-4: asserted through `onUrlUpdate` rather than through the rendered rows. The
    // grid's read is server-driven now, so clearing the filter starts a FETCH, and the harness
    // note at the top of this file applies verbatim — `NuqsTestingAdapter` with `hasMemory` off
    // resyncs from its own un-mutated store the moment an async update lands, so the rendered
    // rows would report the store, not the write. The write is the behaviour under test.
    stubAgents();
    const onUrlUpdate = vi.fn();
    renderWithProviders(<AgentsScreen />, { searchParams: SEEDED_TASK_FILTER, onUrlUpdate });
    await screen.findByText('Clinic transcription');
    await waitFor(() => expect(screen.getByText('1 of 1 agents')).toBeTruthy());

    const [clearButton] = screen.getAllByRole('button', { name: 'Clear filters' });
    fireEvent.click(clearButton);

    await waitFor(() => {
      const last = onUrlUpdate.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams };
      expect(last.searchParams.get('f')).toBeNull();
      expect(last.searchParams.get('task')).toBeNull();
    });
  });
});
