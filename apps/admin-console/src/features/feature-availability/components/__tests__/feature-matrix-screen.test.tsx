/**
 * TASK-932 R-8 — the feature-availability matrix.
 *
 * The screen exists so a platform admin can answer one question per cell: does
 * this feature exist for this tenant? What is worth pinning is the THIRD state
 * and what it costs to get wrong:
 *
 *  - "inherits" is not "off". A cell rendered as an explicit `false` would turn
 *    "follows the platform" into "pinned off", and the next platform change
 *    would silently not reach that tenant.
 *  - reset SENDS null. Sending the platform's current value instead looks
 *    identical today and diverges the next time the default moves.
 *  - the batch is one save with per-cell preconditions, and a refused cell is
 *    reported rather than swallowed.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { FeatureMatrix } from '../../api/types';
import { FeatureMatrixScreen } from '../feature-matrix-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ARCAAI = '60000000-0000-0000-0000-0000000000aa';
const GLOBAL = '50000000-0000-0000-0000-000000000000';

const MATRIX: FeatureMatrix = {
  features: [
    {
      key: 'console.mlflow.enabled',
      label: 'MLflow (console)',
      default: false,
      maxScope: 'tenant',
      killSwitch: true,
      category: 'Feature Availability',
    },
    {
      key: 'workflowExposure.enabled',
      label: 'Workflow exposure plane (public invoke)',
      default: true,
      maxScope: 'tenant',
      category: 'Feature Availability',
    },
    {
      key: 'registration.selfSignupEnabled',
      label: 'Self-service registration',
      default: false,
      // No per-tenant row: its consumer has no tenant to resolve against.
      maxScope: 'system',
      killSwitch: true,
      category: 'Feature Availability',
    },
  ],
  tenants: [
    { id: ARCAAI, name: 'ArcaAI', slug: 'arcaai' },
    { id: GLOBAL, name: 'Global', slug: 'global' },
  ],
  cells: [
    { key: 'console.mlflow.enabled', tenantId: 'system', value: false, version: 0 },
    { key: 'console.mlflow.enabled', tenantId: ARCAAI, value: true, version: 4 },
    { key: 'console.mlflow.enabled', tenantId: GLOBAL, value: null, version: 0 },
    { key: 'workflowExposure.enabled', tenantId: 'system', value: true, version: 2 },
    { key: 'workflowExposure.enabled', tenantId: ARCAAI, value: null, version: 0 },
    { key: 'workflowExposure.enabled', tenantId: GLOBAL, value: null, version: 0 },
    { key: 'registration.selfSignupEnabled', tenantId: 'system', value: false, version: 0 },
  ],
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(opts: { matrix?: FeatureMatrix; onPut?: (body: unknown) => Response } = {}): RecordedCall[] {
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
      const [path] = call.url.split('?');
      if (path === '/api/hope/admin/settings/features/matrix') {
        if (call.method === 'PUT') {
          return opts.onPut ? opts.onPut(call.body) : Response.json({ cells: [], errors: [] });
        }
        return Response.json(opts.matrix ?? MATRIX);
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

const putBody = (calls: RecordedCall[]) => calls.find((c) => c.method === 'PUT')?.body as { cells: unknown[] } | undefined;

/**
 * The desktop grid.
 *
 * jsdom applies no CSS, so BOTH the `md:` grid and the `md:hidden` tenant-picker
 * list render — every feature label appears twice. Every query is therefore
 * scoped to one of them, and the plain text look-ups use `findAllByText`.
 */
function grid(): HTMLElement {
  const table = document.querySelector('table');
  if (!(table instanceof HTMLElement)) throw new Error('matrix table not rendered');
  return table;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FeatureMatrixScreen — the three states', () => {
  it('renders a cell with no tenant row as aria-checked="mixed", not as unchecked', async () => {
    stubFetch();
    renderWithProviders(<FeatureMatrixScreen />);

    await screen.findAllByText('MLflow (console)');
    // Global holds no row for MLflow: it INHERITS, and inheriting the platform's
    // `false` is a different fact from being pinned off.
    const inherited = within(grid()).getByRole('checkbox', { name: /MLflow \(console\) for Global/ });
    expect(inherited.getAttribute('aria-checked')).toBe('mixed');
    // ...and its accessible name says WHAT it inherits, so the row is readable
    // without comparing it against the platform column by eye.
    expect(inherited.getAttribute('aria-label')).toMatch(/inherits off/);
  });

  it('renders an explicit tenant override as checked', async () => {
    stubFetch();
    renderWithProviders(<FeatureMatrixScreen />);

    await screen.findAllByText('MLflow (console)');
    const overridden = within(grid()).getByRole('checkbox', { name: /MLflow \(console\) for ArcaAI/ });
    expect(overridden.getAttribute('aria-checked')).toBe('true');
  });

  it('cycles inherit → on → off → inherit on activation', async () => {
    stubFetch();
    renderWithProviders(<FeatureMatrixScreen />);

    await screen.findAllByText('MLflow (console)');
    const cell = () => within(grid()).getByRole('checkbox', { name: /MLflow \(console\) for Global/ });

    expect(cell().getAttribute('aria-checked')).toBe('mixed');
    fireEvent.click(cell());
    expect(cell().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(cell());
    expect(cell().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(cell());
    // Back to inheriting — reachable in the cycle, not only from a menu.
    expect(cell().getAttribute('aria-checked')).toBe('mixed');
  });

  it('disables the tenant cells of a platform-only feature and says why', async () => {
    stubFetch();
    renderWithProviders(<FeatureMatrixScreen />);

    await screen.findAllByText('Self-service registration');
    const tenantCell = within(grid()).getByRole('checkbox', { name: /Self-service registration for ArcaAI/ });
    expect(tenantCell.hasAttribute('disabled')).toBe(true);
    expect(tenantCell.getAttribute('title')).toMatch(/no per-tenant row/i);

    // The platform column stays editable — the feature IS settable, just not per tenant.
    const platformCell = within(grid()).getByRole('checkbox', { name: /Self-service registration for Platform default/ });
    expect(platformCell.hasAttribute('disabled')).toBe(false);
  });
});

describe('FeatureMatrixScreen — saving', () => {
  it('sends ONE batch carrying every edit, with the per-cell precondition', async () => {
    const calls = stubFetch();
    renderWithProviders(<FeatureMatrixScreen />);
    await screen.findAllByText('MLflow (console)');

    fireEvent.click(within(grid()).getByRole('checkbox', { name: /MLflow \(console\) for Global/ }));
    fireEvent.click(within(grid()).getByRole('checkbox', { name: /Workflow exposure plane \(public invoke\) for ArcaAI/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(putBody(calls)).toBeDefined());
    expect(putBody(calls)!.cells).toEqual([
      // No stored row ⇒ no version to precondition a FIRST write against.
      { key: 'console.mlflow.enabled', tenantId: GLOBAL, value: true },
      { key: 'workflowExposure.enabled', tenantId: ARCAAI, value: true },
    ]);
  });

  it('carries expectedVersion for a cell that already has a row', async () => {
    const calls = stubFetch();
    renderWithProviders(<FeatureMatrixScreen />);
    await screen.findAllByText('MLflow (console)');

    // ArcaAI's MLflow row is version 4.
    fireEvent.click(within(grid()).getByRole('checkbox', { name: /MLflow \(console\) for ArcaAI/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(putBody(calls)).toBeDefined());
    expect(putBody(calls)!.cells).toEqual([{ key: 'console.mlflow.enabled', tenantId: ARCAAI, value: false, expectedVersion: 4 }]);
  });

  it('sends null to RESET, never the platform value copied down', async () => {
    // Copying looks identical today and diverges silently the next time the
    // platform default moves — the tenant would be pinned to a stale value
    // nobody chose. `null` is what removes the row and restores inheritance.
    const calls = stubFetch();
    renderWithProviders(<FeatureMatrixScreen />);
    await screen.findAllByText('MLflow (console)');

    const cell = () => within(grid()).getByRole('checkbox', { name: /MLflow \(console\) for ArcaAI/ });
    fireEvent.click(cell()); // true -> false
    fireEvent.click(cell()); // false -> inherit
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(putBody(calls)).toBeDefined());
    expect(putBody(calls)!.cells).toEqual([{ key: 'console.mlflow.enabled', tenantId: ARCAAI, value: null, expectedVersion: 4 }]);
  });

  it('resets a whole row to the platform default in one action', async () => {
    const calls = stubFetch();
    renderWithProviders(<FeatureMatrixScreen />);
    await screen.findAllByText('MLflow (console)');

    fireEvent.click(screen.getByRole('button', { name: 'MLflow (console)' }));
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(putBody(calls)).toBeDefined());
    // ONLY the tenant that actually holds an override is touched. Sending a
    // reset for a tenant already inheriting would be a no-op write per tenant,
    // and on a real deployment that is one row per tenant per feature.
    expect(putBody(calls)!.cells).toEqual([{ key: 'console.mlflow.enabled', tenantId: ARCAAI, value: null, expectedVersion: 4 }]);
  });

  it('keeps Save disabled until something is actually different', async () => {
    stubFetch();
    renderWithProviders(<FeatureMatrixScreen />);
    await screen.findAllByText('MLflow (console)');

    const save = () => screen.getByRole('button', { name: /Save changes/ });
    expect(save().hasAttribute('disabled')).toBe(true);

    const cell = () => within(grid()).getByRole('checkbox', { name: /MLflow \(console\) for ArcaAI/ });
    fireEvent.click(cell());
    expect(save().hasAttribute('disabled')).toBe(false);

    // Cycled back to the stored value: not an edit any more, so the batch must
    // not carry a no-op write.
    fireEvent.click(cell());
    fireEvent.click(cell());
    expect(save().hasAttribute('disabled')).toBe(true);
  });

  it('surfaces a per-cell refusal instead of reporting the whole save as fine', async () => {
    const calls = stubFetch({
      onPut: () =>
        Response.json({
          cells: [],
          errors: [{ key: 'console.mlflow.enabled', tenantId: ARCAAI, status: 412, message: 'version drift' }],
        }),
    });
    renderWithProviders(<FeatureMatrixScreen />);
    await screen.findAllByText('MLflow (console)');

    fireEvent.click(within(grid()).getByRole('checkbox', { name: /MLflow \(console\) for ArcaAI/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(await screen.findByText(/1 change\(s\) were not applied/)).toBeDefined();
    expect(screen.getByText(/version drift/)).toBeDefined();
  });
});

describe('FeatureMatrixScreen — presentation', () => {
  it('renders a skeleton that mirrors the matrix while it loads', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = renderWithProviders(<FeatureMatrixScreen />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<FeatureMatrixScreen />);
    await screen.findAllByText('MLflow (console)');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows an empty state rather than an empty grid when the registry declares no features', async () => {
    stubFetch({ matrix: { features: [], tenants: [], cells: [] } });
    renderWithProviders(<FeatureMatrixScreen />);
    expect(await screen.findByText('No feature-availability settings')).toBeDefined();
  });
});
