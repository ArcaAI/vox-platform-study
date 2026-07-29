/**
 * TDD tests for `GoldenSetsPanel`.
 *
 * Covers the sets list, the PHI-safe detail drawer, the `manage:HarnessEval`
 * gated create flows and axe cleanliness in both themes.
 *
 * PHI CONTRACT under test: `GET golden-sets/:id/cases` returns metadata ONLY —
 * the encrypted `transcript`/`referenceNote` columns are never surfaced by the
 * API. The panel must render nothing beyond that metadata, so one spec feeds a
 * payload carrying rogue clinical keys and asserts they never reach the DOM.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { GoldenCaseList, GoldenSet, GoldenSetList } from '../../api/types';
import { GoldenSetsPanel } from '../golden-sets-panel';
import { installFetchStub, type RecordedCall } from './fetch-stub';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const SET: GoldenSet = {
  id: 'gs-1',
  tenantId: 'tnt-1',
  name: 'GI consultations golden set',
  description: 'Curated GI encounters for regression scoring.',
  pinnedVersion: 'v2026.07',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  createdBy: 'u-1',
};

const SETS: GoldenSetList = { items: [SET], total: 1 };

const CASES: GoldenCaseList = {
  items: [
    {
      id: 'gc-1',
      tenantId: 'tnt-1',
      goldenSetId: 'gs-1',
      label: 'case-gi-007',
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
      createdBy: 'u-1',
    },
    {
      id: 'gc-2',
      tenantId: 'tnt-1',
      goldenSetId: 'gs-1',
      label: null,
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z',
      createdBy: null,
    },
  ],
  total: 2,
};

const MANAGE_RULES = [{ action: 'manage', subject: 'HarnessEval' }];
const READ_ONLY_RULES = [{ action: 'read', subject: 'HarnessEval' }];

interface StubOptions {
  sets?: Response | GoldenSetList;
  cases?: Response | GoldenCaseList | Record<string, unknown>;
  permissions?: Array<{ action: string; subject: string }>;
  custom?: (call: RecordedCall) => Response | unknown;
}

function stubRoutes({ sets = SETS, cases = CASES, permissions = MANAGE_RULES, custom }: StubOptions = {}) {
  return installFetchStub((call: RecordedCall) => {
    // The ability read is itself a POST, so it is answered before `custom`
    // gets a chance to blanket-fail write calls.
    if (call.url === '/api/hope/rbac/check/my-permissions') {
      return { userId: 'u-1', tenantId: 'tnt-1', permissions };
    }
    const handled = custom?.(call);
    if (handled !== undefined) return handled;
    if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/harness/golden-sets/gs-1/cases')) return cases;
    if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/harness/golden-sets/gs-1')) return SET;
    if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/harness/golden-sets')) return sets;
    return undefined;
  });
}

async function openDrawer() {
  fireEvent.click(await screen.findByText('GI consultations golden set'));
  return screen.findByRole('dialog');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GoldenSetsPanel', () => {
  it('renders content-shaped skeletons while the list loads', () => {
    // A never-settling fetch keeps every query pending: rule 10 requires
    // skeletons shaped like the loaded rows, never a spinner.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const { container } = renderWithProviders(<GoldenSetsPanel />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('lists golden sets with their name, description and pinned version', async () => {
    stubRoutes();
    renderWithProviders(<GoldenSetsPanel />);

    const list = await screen.findByRole('list', { name: 'Golden sets' });
    expect(within(list).getByText('GI consultations golden set')).toBeDefined();
    expect(within(list).getByText(/Curated GI encounters/)).toBeDefined();
    expect(within(list).getByText('v2026.07')).toBeDefined();
  });

  it('shows the empty state when the tenant has no golden sets', async () => {
    stubRoutes({ sets: { items: [], total: 0 } });
    renderWithProviders(<GoldenSetsPanel />);

    expect(await screen.findByText('No golden sets yet')).toBeDefined();
  });

  it('shows the error state with retry when the list read fails', async () => {
    stubRoutes({ sets: Response.json({ statusCode: 503, message: 'harness unreachable' }, { status: 503 }) });
    renderWithProviders(<GoldenSetsPanel />);

    expect(await screen.findByText('harness unreachable')).toBeDefined();
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('opens a detail drawer with the set metadata and its PHI-safe case list', async () => {
    const calls = stubRoutes();
    renderWithProviders(<GoldenSetsPanel />);

    const drawer = await openDrawer();
    expect(within(drawer).getByText('gs-1')).toBeDefined();
    expect(within(drawer).getByText('v2026.07')).toBeDefined();
    const cases = await within(drawer).findByRole('list', { name: 'Golden set cases' });
    expect(within(cases).getByText('case-gi-007')).toBeDefined();
    expect(within(cases).getByText('gc-2')).toBeDefined();
    await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/hope/admin/harness/golden-sets/gs-1/cases'))).toBe(true));
  });

  it('never renders clinical payload fields, even if a response carries them', async () => {
    stubRoutes({
      cases: {
        items: [
          {
            ...CASES.items[0],
            transcript: 'PATIENT SAYS SOMETHING PRIVATE',
            referenceNote: 'GOLD NOTE BODY',
          },
        ],
        total: 1,
      },
    });
    renderWithProviders(<GoldenSetsPanel />);

    const drawer = await openDrawer();
    await within(drawer).findByRole('list', { name: 'Golden set cases' });
    expect(screen.queryByText(/PATIENT SAYS SOMETHING PRIVATE/)).toBeNull();
    expect(screen.queryByText(/GOLD NOTE BODY/)).toBeNull();
  });

  it('shows the cases empty state for a set with no cases', async () => {
    stubRoutes({ cases: { items: [], total: 0 } });
    renderWithProviders(<GoldenSetsPanel />);

    const drawer = await openDrawer();
    expect(await within(drawer).findByText('No cases in this set')).toBeDefined();
  });

  it('hides both create actions without the manage:HarnessEval ability', async () => {
    stubRoutes({ permissions: READ_ONLY_RULES });
    renderWithProviders(<GoldenSetsPanel />);

    await screen.findByRole('list', { name: 'Golden sets' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New golden set' })).toBeNull());

    const drawer = await openDrawer();
    await within(drawer).findByRole('list', { name: 'Golden set cases' });
    expect(within(drawer).queryByRole('button', { name: 'Add case' })).toBeNull();
  });

  it('creates a golden set and toasts on success', async () => {
    const { toast } = await import('sonner');
    const calls = stubRoutes({
      custom: (call) => {
        if (call.method === 'POST' && call.url === '/api/hope/admin/harness/golden-sets') {
          return Response.json({ ...SET, id: 'gs-2', name: 'Cardiology set' }, { status: 201 });
        }
        return undefined;
      },
    });
    renderWithProviders(<GoldenSetsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'New golden set' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Cardiology set' } });
    fireEvent.change(screen.getByLabelText('Pinned version'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create set' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/harness/golden-sets');
    expect(post?.body).toEqual({ name: 'Cardiology set', pinnedVersion: 'v1' });
  });

  it('adds a case (write-only PHI) and toasts on success', async () => {
    const { toast } = await import('sonner');
    const calls = stubRoutes({
      custom: (call) => {
        if (call.method === 'POST' && call.url === '/api/hope/admin/harness/golden-sets/gs-1/cases') {
          return Response.json(CASES.items[0], { status: 201 });
        }
        return undefined;
      },
    });
    renderWithProviders(<GoldenSetsPanel />);

    const drawer = await openDrawer();
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Add case' }));
    fireEvent.change(await screen.findByLabelText('Transcript'), { target: { value: 'transcript text' } });
    fireEvent.change(screen.getByLabelText('Reference note'), { target: { value: 'reference note text' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'case-gi-008' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add case to set' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/golden-sets/gs-1/cases'));
    expect(post?.body).toEqual({ transcript: 'transcript text', referenceNote: 'reference note text', label: 'case-gi-008' });
  });

  it('surfaces a failed create as an error toast', async () => {
    const { toast } = await import('sonner');
    stubRoutes({
      custom: (call) => {
        if (call.method === 'POST') return Response.json({ statusCode: 403, message: 'Forbidden' }, { status: 403 });
        return undefined;
      },
    });
    renderWithProviders(<GoldenSetsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'New golden set' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create set' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('has no axe violations on the list and the detail drawer', async () => {
    stubRoutes();
    const { container } = renderWithProviders(<GoldenSetsPanel />);

    await screen.findByRole('list', { name: 'Golden sets' });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());

    // The drawer is portaled, so scan the sheet itself — scanning
    // `document.body` only re-reports Radix's own focus-guard/aria-hidden
    // scaffolding, which is not part of this component.
    const drawer = await openDrawer();
    await within(drawer).findByRole('list', { name: 'Golden set cases' });
    await waitFor(async () => expect(await axe(drawer)).toHaveNoViolations());
  });

  it('has no axe violations in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubRoutes();
      const { container } = renderWithProviders(<GoldenSetsPanel />);
      await screen.findByRole('list', { name: 'Golden sets' });
      await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
