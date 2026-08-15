/**
 * Billing screen: spend banner, invoice list + compute-draft,
 * the invoice detail drawer (summary/lines/adjustments + DRAFT finalize/void),
 * empty state, the working-tenant gate, and axe-cleanliness.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { renderWithProviders } from '@/test/render';

import { BillingScreen } from '../billing-screen';

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

const INVOICES = [{ id: 'inv-1', tenantId: 'tnt-1', period: '2026-07', status: 'DRAFT', currency: 'USD', totalMicros: '199029940', finalizedAt: null, version: 1 }];

const SPEND = {
  period: '2026-08',
  periodStart: '2026-08-01T00:00:00.000Z',
  periodEnd: '2026-09-01T00:00:00.000Z',
  computedAt: '2026-08-08T00:00:00.000Z',
  overageSpendMicros: '29940',
  spendLimitMicros: '100000000',
  remainingMicros: '99970060',
  exceeded: false,
  utilizationPercent: 0,
  byokNotionalCostMicros: '0',
};

const INVOICE_DETAIL = {
  id: 'inv-1',
  tenantId: 'tnt-1',
  period: '2026-07',
  periodStart: '2026-07-01T00:00:00.000Z',
  periodEnd: '2026-08-01T00:00:00.000Z',
  status: 'DRAFT',
  currency: 'USD',
  subtotalMicros: '199029940',
  totalMicros: '199029940',
  finalizedAt: null,
  finalizedBy: null,
  version: 1,
  planTier: 'STARTER',
  planFeeBasis: 'PERIOD_END_PLAN',
  byokNotionalCostMicros: '0',
  rateCardVersions: ['2026-08-06-placeholder-v1'],
  lines: [
    { id: 'l1', kind: 'PLAN_FEE', capability: null, unit: null, quantity: '31', includedAllowance: null, overageQuantity: null, unitPriceMicros: '199000000', amountMicros: '199000000', description: 'STARTER plan fee — 31/31 days' },
    { id: 'l2', kind: 'OVERAGE', capability: 'STT', unit: 'SESSION_SECOND', quantity: '4990', includedAllowance: '10', overageQuantity: '4990', unitPriceMicros: '6', amountMicros: '29940', description: 'STT overage' },
  ],
  adjustments: [],
  adjustmentsTotalMicros: '0',
  amountAfterAdjustmentsMicros: '199029940',
};

interface StubConfig {
  session?: typeof SESSION;
  invoices?: unknown;
  rateCard?: unknown;
}

const RATE_ROWS = [
  {
    id: 'rate-1',
    tenantId: '00000000-0000-0000-0000-000000000000',
    plane: 'SELL',
    rowKind: 'USAGE_UNIT',
    planTier: null,
    capability: 'STT',
    provider: 'azure-speech',
    model: null,
    unit: 'SESSION_SECOND',
    contextBand: null,
    currency: 'USD',
    unitPriceMicros: '500',
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    effectiveTo: null,
    bookVersion: '2026-08-06-placeholder-v1',
    version: 3,
  },
  // A closed history row — repricing it again must not be offered.
  {
    id: 'rate-0',
    tenantId: '00000000-0000-0000-0000-000000000000',
    plane: 'SELL',
    rowKind: 'USAGE_UNIT',
    planTier: null,
    capability: 'STT',
    provider: null,
    model: null,
    unit: 'SESSION_SECOND',
    contextBand: null,
    currency: 'USD',
    unitPriceMicros: '6',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    effectiveTo: '2026-08-01T00:00:00.000Z',
    bookVersion: 'old',
    version: 2,
  },
];

const supersedeCalls: Array<{ body: Record<string, unknown>; ifMatch: string | null }> = [];

function stubFetch({ session = SESSION, invoices = INVOICES, rateCard = RATE_ROWS }: StubConfig = {}) {
  supersedeCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).split('?')[0];
      if (path === '/api/auth/session') return Response.json(session);
      if (path === '/api/hope/admin/billing/invoices/spend-status') return Response.json(SPEND);
      if (path === '/api/hope/admin/billing/invoices/inv-1') return Response.json(INVOICE_DETAIL, { headers: { ETag: '"1"' } });
      if (path === '/api/hope/admin/billing/invoices') return Response.json(invoices);
      if (path === '/api/hope/admin/billing/rate-card') return Response.json(rateCard);
      if (path === '/api/hope/admin/billing/rate-card/rate-1/supersede') {
        supersedeCalls.push({ body: JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')), ifMatch: new Headers((init as RequestInit | undefined)?.headers).get('If-Match') });
        return Response.json({ closed: RATE_ROWS[0], successor: { ...RATE_ROWS[0], unitPriceMicros: '1390' } }, { status: 201 });
      }
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BillingScreen', () => {
  it('renders the spend banner, the invoice list and the compute-draft action', async () => {
    stubFetch();
    renderWithProviders(<BillingScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Billing & invoices' })).toBeDefined();
    // Invoice total 199,029,940 micros = $199.03.
    expect(await screen.findByText('$199.03')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Compute draft' })).toBeDefined();
    // Spend banner overage 29,940 micros = $0.03.
    expect(await screen.findByText(/\$0\.03/)).toBeDefined();
  });

  it('opens the invoice detail drawer with lines and the DRAFT finalize action', async () => {
    stubFetch();
    renderWithProviders(<BillingScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'View' }));

    expect(await screen.findByText('STARTER plan fee — 31/31 days')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Finalize' })).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Void' })).toBeDefined();
  });

  it('shows the empty state when the tenant has no invoices', async () => {
    stubFetch({ invoices: [] });
    renderWithProviders(<BillingScreen />);

    expect(await screen.findByText('No invoices yet')).toBeDefined();
  });

  it('gates an elevated session without a working tenant behind the NoTenant empty state', async () => {
    stubFetch({ session: { ...SESSION, workingTenantId: null, workingTenantName: null, effectiveTenantId: null } });
    renderWithProviders(<BillingScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
  });

  it('has no axe violations with the invoice list rendered', async () => {
    stubFetch();
    const { container } = renderWithProviders(<BillingScreen />);
    await screen.findByText('$199.03');
    await waitFor(() => expect(document.querySelector('[role="status"]')).not.toBeNull());
    expect(await axe(container)).toHaveNoViolations();
  });

  describe('rate card (the write half)', () => {
    async function openRateCardTab() {
      renderWithProviders(<BillingScreen />);
      // Radix Tabs activates on mousedown, not click.
      const trigger = await screen.findByRole('tab', { name: 'Rate card' });
      fireEvent.mouseDown(trigger);
      fireEvent.click(trigger);
      return screen.findByRole('button', { name: 'Supersede' });
    }

    it('offers Supersede on an OPEN row only — a closed row is history', async () => {
      stubFetch();
      await openRateCardTab();

      // Two rows render, but only the open one is repriceable.
      expect(screen.getAllByRole('button', { name: 'Supersede' })).toHaveLength(1);
      expect(await screen.findByText('superseded')).toBeDefined();
    });

    it('sends the new price with If-Match carrying the row version (OCC)', async () => {
      stubFetch();
      fireEvent.click(await openRateCardTab());

      fireEvent.change(screen.getByLabelText(/New rate/), { target: { value: '1390' } });
      fireEvent.change(screen.getByLabelText(/Effective from/), { target: { value: '2026-09-01' } });
      fireEvent.change(screen.getByLabelText(/Book version/), { target: { value: '2026-09-01-commercial-v3' } });
      fireEvent.click(screen.getByRole('button', { name: 'Supersede', hidden: false }) ?? screen.getByText('Supersede'));

      await waitFor(() => expect(supersedeCalls).toHaveLength(1));
      expect(supersedeCalls[0].ifMatch).toBe('"3"');
      expect(supersedeCalls[0].body).toMatchObject({
        unitPriceMicros: '1390',
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        bookVersion: '2026-09-01-commercial-v3',
      });
    });

    it('keeps Supersede disabled until price, date and book version are all present', async () => {
      stubFetch();
      fireEvent.click(await openRateCardTab());

      const submit = screen.getAllByRole('button', { name: 'Supersede' }).at(-1)!;
      expect((submit as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(screen.getByLabelText(/New rate/), { target: { value: '1390' } });
      expect((submit as HTMLButtonElement).disabled).toBe(true); // book version still empty
      fireEvent.change(screen.getByLabelText(/Book version/), { target: { value: 'v3' } });
      expect((submit as HTMLButtonElement).disabled).toBe(false);
    });

    it('rejects a non-integer-micros price rather than sending it', async () => {
      stubFetch();
      fireEvent.click(await openRateCardTab());

      fireEvent.change(screen.getByLabelText(/New rate/), { target: { value: '1.39' } });
      fireEvent.change(screen.getByLabelText(/Book version/), { target: { value: 'v3' } });

      const submit = screen.getAllByRole('button', { name: 'Supersede' }).at(-1)!;
      expect((submit as HTMLButtonElement).disabled).toBe(true);
      expect(supersedeCalls).toHaveLength(0);
    });
  });
});
