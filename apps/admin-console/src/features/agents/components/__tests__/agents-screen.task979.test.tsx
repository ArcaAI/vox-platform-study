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
import type { Agent } from '../../api/types';
import { AgentsScreen } from '../agents-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The exact `f` encoding `?task=SPEECH_TO_TEXT` is expected to translate into (`grid-url-state.ts`'s positional-tuple codec, the same shape the Task column's multiSelect facet already produces). */
const SEEDED_TASK_FILTER = `f=${encodeURIComponent(JSON.stringify([['task', 'inArray', 'multiSelect', ['SPEECH_TO_TEXT']]]))}`;

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-1',
    tenantId: 'tnt-1',
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: 'TEXT_GENERATION',
    versionNumber: 1,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    status: 'DRAFT',
    isActive: false,
    modelId: 'm-llm',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    modelSlug: 'lms-gemma-4-e2b-it-qat',
    fallbacks: [],
    instruction: { systemPrompt: 'You are a scribe.' },
    parameters: {},
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: null,
    validationReport: null,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    resourceStatus: 'ENABLED',
    tags: [],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    version: 1,
    ...overrides,
  };
}

const AGENTS: Agent[] = [
  agent(),
  agent({ id: 'a-2', slug: 'clinic-transcription', name: 'Clinic transcription', task: 'SPEECH_TO_TEXT' }),
  agent({ id: 'a-3', slug: 'clinic-tts', name: 'Clinic TTS', task: 'TEXT_TO_SPEECH' }),
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
      if (path === '/api/hope/admin/agents') return Response.json(AGENTS);
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
    await waitFor(() => expect(screen.getByText('1 of 3 shown')).toBeTruthy());
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
    stubAgents();
    renderWithProviders(<AgentsScreen />, { searchParams: SEEDED_TASK_FILTER });
    await screen.findByText('Clinic transcription');
    await waitFor(() => expect(screen.getByText('1 of 3 shown')).toBeTruthy());

    const [clearButton] = screen.getAllByRole('button', { name: 'Clear filters' });
    fireEvent.click(clearButton);

    await waitFor(() => expect(screen.getByText('3 of 3 shown')).toBeTruthy());
    expect(screen.getByText('Clinic summarizer')).toBeTruthy();
    expect(screen.getByText('Clinic TTS')).toBeTruthy();
  });
});
