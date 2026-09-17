/**
 * Governance tab (Eval panel): selecting a template shows the Eval gate panel —
 * a golden-set picker, the last runs + scores for the picked set, and a manual
 * run-now (independent of the promotion gate that runs automatically on
 * Approve). Golden-set CRUD and the full eval-runs grid stay on
 * `/harness/observability` (rule 13 "one authoritative editor per resource").
 *
 * / OD-11 removed the picker's DEFAULT. It used to pre-select the
 * golden set attached to a `DepartmentAgent` bound to this template, and to
 * annotate each option with the agents holding it. That binding moved onto the
 * workflow NODE that references the template (`config.evalGate`), so there is
 * no per-template agent list to read here — the admin picks a set explicitly,
 * and the gate that actually blocks an approval reads the node.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { EvalGoldenSetList, PromptTemplate, PromptVersion } from '../../api/types';
import { GovernanceTab } from '../governance-tab';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'pt-1',
    name: 'Cardiology Notes',
    content: 'You are a clinical scribe.',
    category: 'SUMMARY',
    status: 'PUBLISHED',
    currentVersionNumber: 5,
    departmentId: 'd-1',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    version: 5,
    ...overrides,
  };
}

function version(versionNumber: number, overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: `pv-${versionNumber}`,
    promptTemplateId: 'pt-1',
    versionNumber,
    content: `Prompt body v${versionNumber}`,
    changedBy: 'dr.lee',
    createdAt: '2026-06-20T10:00:00.000Z',
    ...overrides,
  };
}

const GOLDEN_SETS: EvalGoldenSetList = {
  items: [
    { id: 'gs-1', name: 'GI consultations golden set', description: null, pinnedVersion: null },
    { id: 'gs-2', name: 'Cardiology golden set', description: null, pinnedVersion: 'v2' },
  ],
  total: 2,
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

function defaultHandler(call: RecordedCall): Response | undefined {
  const path = pathOf(call);
  if (call.method === 'GET' && path === '/api/hope/admin/prompt-templates') {
    return Response.json({ data: [template()], count: 1, limit: 50, page: 1 });
  }
  if (call.method === 'GET' && path === '/api/hope/admin/prompt-templates/pt-1') {
    return Response.json(template(), { headers: { etag: '"5"' } });
  }
  if (call.method === 'GET' && path === '/api/hope/admin/prompt-templates/pt-1/versions') {
    return Response.json([version(5)]);
  }
  if (call.method === 'GET' && path === '/api/hope/admin/harness/golden-sets') {
    return Response.json(GOLDEN_SETS);
  }
  if (call.method === 'GET' && path === '/api/hope/admin/harness/eval-runs') {
    return Response.json({ items: [], total: 0 });
  }
  return undefined;
}

async function selectTemplate() {
  fireEvent.click(await screen.findByText('Cardiology Notes'));
  return screen.findByText('Eval gate');
}

/** The panel starts unselected now, so most cases have to pick a set first. */
async function pickGoldenSet(value = 'gs-1') {
  const picker = await screen.findByRole('combobox', { name: 'Golden set' });
  fireEvent.change(picker, { target: { value } });
  return picker;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GovernanceTab — Eval panel', () => {
  it('offers every golden set and pre-selects NONE — the binding lives on the workflow node now', async () => {
    stubFetch((call) => defaultHandler(call));
    renderWithProviders(<GovernanceTab />);
    await selectTemplate();

    const picker = (await screen.findByRole('combobox', { name: 'Golden set' })) as HTMLSelectElement;
    expect(picker.value).toBe('');
    expect(screen.getByRole('option', { name: 'GI consultations golden set' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Cardiology golden set' })).toBeDefined();
  });

  it('says plainly that a manual run does not gate promotion', async () => {
    stubFetch((call) => defaultHandler(call));
    renderWithProviders(<GovernanceTab />);
    await selectTemplate();
    await pickGoldenSet();

    expect(screen.getByText(/does not gate promotion/)).toBeDefined();
  });

  it('lists the last eval runs for the picked golden set', async () => {
    stubFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === '/api/hope/admin/harness/eval-runs') {
        return Response.json({
          items: [
            {
              id: 'run-1',
              tenantId: 'tnt-1',
              goldenSetId: 'gs-1',
              status: 'COMPLETED',
              startedAt: '2026-07-10T10:00:00.000Z',
              completedAt: '2026-07-10T10:05:00.000Z',
              aggregateScores: { overall: 0.9134 },
              createdAt: '2026-07-10T10:00:00.000Z',
            },
          ],
          total: 1,
        });
      }
      return defaultHandler(call);
    });
    renderWithProviders(<GovernanceTab />);
    await selectTemplate();
    await pickGoldenSet();

    const runs = await screen.findByRole('list', { name: 'Recent eval runs' });
    expect(within(runs).getByText('COMPLETED')).toBeDefined();
    expect(within(runs).getByText(/overall: 0.91/)).toBeDefined();
  });

  // EvalRun.triggerType (MANUAL/PROMOTION/CI) is now on the
  // wire (EvalRunResponse) — the "last runs" list should badge it so an admin
  // can tell an automatic promotion-gate run from a manual check.
  it('badges each run with its trigger type (MANUAL/PROMOTION/CI)', async () => {
    stubFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === '/api/hope/admin/harness/eval-runs') {
        return Response.json({
          items: [
            {
              id: 'run-1',
              tenantId: 'tnt-1',
              goldenSetId: 'gs-1',
              status: 'COMPLETED',
              triggerType: 'PROMOTION',
              startedAt: '2026-07-10T10:00:00.000Z',
              completedAt: '2026-07-10T10:05:00.000Z',
              aggregateScores: { overall: 0.9134 },
              createdAt: '2026-07-10T10:00:00.000Z',
            },
            {
              id: 'run-2',
              tenantId: 'tnt-1',
              goldenSetId: 'gs-1',
              status: 'COMPLETED',
              triggerType: 'MANUAL',
              startedAt: '2026-07-09T10:00:00.000Z',
              completedAt: '2026-07-09T10:05:00.000Z',
              aggregateScores: {},
              createdAt: '2026-07-09T10:00:00.000Z',
            },
          ],
          total: 2,
        });
      }
      return defaultHandler(call);
    });
    renderWithProviders(<GovernanceTab />);
    await selectTemplate();
    await pickGoldenSet();

    const runs = await screen.findByRole('list', { name: 'Recent eval runs' });
    expect(within(runs).getByText('PROMOTION')).toBeDefined();
    expect(within(runs).getByText('MANUAL')).toBeDefined();
  });

  it('switches the picker to another golden set and refetches its runs', async () => {
    const calls = stubFetch((call) => defaultHandler(call));
    renderWithProviders(<GovernanceTab />);
    await selectTemplate();
    await pickGoldenSet();

    fireEvent.change(await screen.findByRole('combobox', { name: 'Golden set' }), { target: { value: 'gs-2' } });

    await waitFor(() => expect(calls.some((call) => call.method === 'GET' && call.url.includes('goldenSetId=gs-2'))).toBe(true));
  });

  it('runs the eval now and toasts the verdict', async () => {
    const { toast } = await import('sonner');
    const calls = stubFetch((call) => {
      if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/harness/golden-sets/gs-1/run') {
        return Response.json({ runId: 'run-9', passed: true, failures: [], aggregates: { overall: 0.95 } }, { status: 201 });
      }
      return defaultHandler(call);
    });
    renderWithProviders(<GovernanceTab />);
    await selectTemplate();
    await pickGoldenSet();

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(calls.some((call) => call.method === 'POST' && pathOf(call) === '/api/hope/admin/harness/golden-sets/gs-1/run')).toBe(true);
  });

  it('toasts an error verdict when the manual run fails the gate', async () => {
    const { toast } = await import('sonner');
    stubFetch((call) => {
      if (call.method === 'POST' && pathOf(call) === '/api/hope/admin/harness/golden-sets/gs-1/run') {
        return Response.json({ runId: 'run-9', passed: false, failures: ['pdsqi9 below threshold'], aggregates: {} }, { status: 201 });
      }
      return defaultHandler(call);
    });
    renderWithProviders(<GovernanceTab />);
    await selectTemplate();
    await pickGoldenSet();

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('pdsqi9 below threshold')));
  });

  it('links to the Harness Observability board to manage golden sets', async () => {
    stubFetch((call) => defaultHandler(call));
    renderWithProviders(<GovernanceTab />);
    await selectTemplate();

    const link = screen.getByRole('link', { name: /Manage golden sets/ });
    expect(link.getAttribute('href')).toBe('/harness/observability');
  });

  it('has no axe violations with the Eval panel rendered', async () => {
    stubFetch((call) => defaultHandler(call));
    const { container } = renderWithProviders(<GovernanceTab />);
    await selectTemplate();
    await pickGoldenSet();

    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  // TASK-973 L2 — the list's search already hit GET admin/prompt-templates
  // server-side (`search` is applied as a `name` contains match in
  // prompt-management.service.ts:813); the missing piece was the 300ms
  // debounce required by the house pattern (departments-screen.tsx:60-70).
  describe('template search debounce', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('debounces the search 300ms before hitting GET admin/prompt-templates', async () => {
      const calls = stubFetch((call) => defaultHandler(call));
      renderWithProviders(<GovernanceTab />);

      // The search input renders synchronously (not gated on the list load).
      const input = screen.getByRole('textbox', { name: 'Search templates' });
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
      const baseline = calls.length;

      fireEvent.change(input, { target: { value: 'cardio' } });
      // Still nothing new — the keystroke has not hit the server yet.
      expect(calls.length).toBe(baseline);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(calls.length).toBe(baseline);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(baseline));
      expect(calls.some((call) => call.method === 'GET' && call.url.includes('/admin/prompt-templates') && call.url.includes('search=cardio'))).toBe(
        true,
      );
    });
  });

  /**
   * R10: "the whole content scrolls instead of just the list". The tab is a
   * master-detail pane, so the page frame must hand it the height and the two
   * columns must each own their scroll — the flex chain from the ScreenTemplate
   * content region down to the list has to be unbroken, or `lg:h-full` on the
   * list Card and `overflow-y-auto` on the `ul` resolve against nothing and go
   * inert (which is exactly what happened).
   *
   * Asserted as a CLASS CHAIN rather than by measuring: happy-dom applies no
   * stylesheet and lays nothing out, so scroll behaviour itself is only
   * provable in a real browser (evidence/lane-F-governance-*.png).
   */
  describe('fill-height master-detail (R10)', () => {
    it('grows the section and the grid so the columns can own their scroll', async () => {
      stubFetch((call) => defaultHandler(call));
      renderWithProviders(<GovernanceTab />);
      await screen.findByText('Cardiology Notes');

      const section = screen.getByRole('heading', { name: /prompt governance/i }).closest('section')!;
      // Grows into the height the page frame hands it, and does not itself scroll.
      expect(section.className).toContain('flex-1');
      expect(section.className).toContain('min-h-0');
      expect(section.className).toContain('flex-col');
      expect(section.className).not.toContain('overflow-y-auto');

      const grid = section.querySelector('div.grid') as HTMLElement;
      expect(grid.className).toContain('flex-1');
      expect(grid.className).toContain('min-h-0');
    });

    it('keeps the header block out of the growing region', async () => {
      stubFetch((call) => defaultHandler(call));
      renderWithProviders(<GovernanceTab />);
      await screen.findByText('Cardiology Notes');

      const section = screen.getByRole('heading', { name: /prompt governance/i }).closest('section')!;
      const header = section.firstElementChild as HTMLElement;
      expect(header.className).not.toContain('flex-1');
    });

    it('gives the list its own bounded scroll container', async () => {
      stubFetch((call) => defaultHandler(call));
      renderWithProviders(<GovernanceTab />);
      await screen.findByText('Cardiology Notes');

      const list = screen.getByText('Cardiology Notes').closest('ul') as HTMLElement;
      expect(list.className).toContain('overflow-y-auto');
      expect(list.className).toContain('min-h-0');
      // The Card between the grid cell and the `ul` is what resolves that height.
      const card = list.parentElement as HTMLElement;
      expect(card.className).toContain('lg:h-full');
      expect(card.className).toContain('min-h-0');
    });

    it('scrolls the detail column independently, and keeps that region keyboard reachable', async () => {
      stubFetch((call) => defaultHandler(call));
      renderWithProviders(<GovernanceTab />);
      await selectTemplate();

      const detail = await screen.findByRole('region', { name: 'Template governance detail' });
      // Desktop-only: stacked below `lg` the grid is the single scroller, so
      // scrolling here too would nest two scroll areas in one panel.
      expect(detail.className).toContain('lg:overflow-y-auto');
      expect(detail.className).toContain('min-h-0');
      // A scroll container with no focusable content of its own (the unselected
      // empty state) is unreachable by keyboard otherwise — WCAG 2.1.1, the same
      // fix the DetailDrawer body carries.
      expect(detail.getAttribute('tabindex')).toBe('0');
    });

    it('has no axe violations on the fill-height layout', async () => {
      stubFetch((call) => defaultHandler(call));
      const { container } = renderWithProviders(<GovernanceTab />);
      await selectTemplate();
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
