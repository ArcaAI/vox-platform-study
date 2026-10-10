/**
 * TASK-1059 lane CC — C-01 (effective identity picks the grid), C-02 (lifecycle DTO in the drawer),
 * C-06 (relations groups) and C-08 (patient mask) on the consultations screen.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Consultation } from '../../api/types';
import { ConsultationsScreen } from '../consultations-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROW: Consultation = {
  id: 'c-1',
  patientId: 'alaas:E2E-1058-P01',
  doctorId: 'usr-1',
  doctor: { id: 'usr-1', username: 'dr.one' },
  appointmentDate: '2026-10-09',
  status: 'CLOSED_COMPLETE',
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T11:00:00.000Z',
};

function item(type: string, id: string) {
  return { id, consultationId: 'c-1', type, source: 'SYSTEM', createdAt: ROW.createdAt, updatedAt: ROW.updatedAt };
}

const DETAIL: Consultation = {
  ...ROW,
  processing: 'IDLE',
  approval: { id: 'ap-1', approvedAt: '2026-10-09T10:50:00.000Z', approvedBy: 'usr-9', snapshotHash: 'h', itemCount: 6 },
  closedReason: 'APPROVED',
  closedAt: '2026-10-09T10:55:00.000Z',
  reopenCount: 2,
  reopenAllowed: false,
  recordable: false,
  currentEncounterSeq: 2,
  encounters: [
    { seq: 1, visitType: 'new-visit', externalRef: 'VISIT-1', startedAt: '2026-10-09T10:00:00.000Z', endedAt: '2026-10-09T10:20:00.000Z', recordingStartMs: 0, recordingEndMs: 1000 },
    { seq: 2, visitType: 'revisit', externalRef: null, startedAt: '2026-10-09T10:30:00.000Z', endedAt: null, recordingStartMs: null, recordingEndMs: null },
  ],
  lastActivityAt: '2026-10-09T10:54:00.000Z',
  autoCloseAt: null,
  externalRef: 'EXT-77',
  language: 'ml-en',
  contextItems: [
    item('STRUCTURED', 'a'),
    item('TRANSCRIPT_SEGMENT', 'b'),
    item('TRANSCRIPT_SEGMENT', 'c'),
    item('FULL_TRANSCRIPT', 'd'),
    item('FACT_LEDGER', 'e'),
    item('ENCOUNTER_RECAP', 'f'),
  ],
};

function session(extra: Record<string, unknown>) {
  return {
    user: { id: 'u-1', username: 'root', email: 'r@h', roles: ['SUPER_ADMIN'], tenantId: null },
    isElevated: true,
    workingTenantId: null,
    workingTenantName: null,
    impersonatingUserId: null,
    impersonatingUsername: null,
    ...extra,
  };
}

function stub(sessionBody: unknown, detail: Consultation = DETAIL) {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://t').pathname;
      paths.push(path);
      if (path === '/api/auth/session') return Response.json(sessionBody);
      if (path === '/api/hope/admin/consultations/aggregate')
        return Response.json({ buckets: [], totals: { total: 0, newVisits: 0, revisits: 0 }, granularity: 'day', refreshedAt: ROW.createdAt });
      if (path === '/api/hope/admin/consultations/c-1') return Response.json(detail);
      if (path === '/api/hope/admin/consultations') return Response.json({ data: [ROW], count: 1, page: 1, limit: 25 });
      if (path === '/api/hope/users/me/settings') return Response.json([]);
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
  return paths;
}

describe('ConsultationsScreen — effective identity (C-01)', () => {
  it('shows the grid, not the cross-tenant aggregate, for a super admin impersonating a tenant admin', async () => {
    const paths = stub(
      session({
        impersonatingUserId: 'u-t',
        effectiveIsElevated: false,
        effectiveTenantId: 't-1',
        effectiveUser: { id: 'u-t', username: 'tadmin', email: '', roles: ['TENANT_ADMIN'], tenantId: 't-1', departmentId: null },
      }),
    );
    renderWithProviders(<ConsultationsScreen />);

    expect(await screen.findByText('dr.one')).toBeDefined();
    expect(screen.queryByText(/select a working tenant to browse consultation rows/i)).toBeNull();
    expect(paths).toContain('/api/hope/admin/consultations');
  });

  it('still shows the aggregate for an elevated effective identity with no tenant', async () => {
    stub(session({ effectiveIsElevated: true, effectiveTenantId: null }));
    renderWithProviders(<ConsultationsScreen />);
    expect(await screen.findByText(/select a working tenant to browse consultation rows/i)).toBeDefined();
  });
});

describe('Consultation drawer — lifecycle DTO, relations, mask', () => {
  async function openDrawer(detail?: Consultation) {
    stub(session({ workingTenantId: 't-1', effectiveIsElevated: true, effectiveTenantId: 't-1' }), detail);
    renderWithProviders(<ConsultationsScreen />);
    fireEvent.click(await screen.findByText('dr.one'));
    return await screen.findByRole('dialog');
  }

  it('renders approval, close, reopen, encounters, activity clock, reference and language', async () => {
    const dialog = await openDrawer();
    await within(dialog).findByText('Approved');
    expect(within(dialog).getByText(/by usr-9/)).toBeDefined();
    expect(within(dialog).getByText(/6 items/)).toBeDefined();
    expect(within(dialog).getByText('Closed').nextSibling?.textContent).toMatch(/^Approved/);
    expect(within(dialog).getByText('2 times')).toBeDefined();
    expect(within(dialog).getByText('Reopen allowed').nextSibling?.textContent).toBe('No');
    expect(within(dialog).getByText('Recordable').nextSibling?.textContent).toBe('No');
    expect(within(dialog).getByText('#2')).toBeDefined();
    expect(within(dialog).getByText('Last activity')).toBeDefined();
    expect(within(dialog).getByText('EXT-77')).toBeDefined();
    expect(within(dialog).getByText('ml-en')).toBeDefined();
    expect(within(dialog).getByRole('heading', { name: 'Encounters (2)' })).toBeDefined();
    expect(within(dialog).getByText(/New visit/)).toBeDefined();
    expect(within(dialog).getByText(/in progress/)).toBeDefined();
    // autoCloseAt is null: legitimately empty, so no row.
    expect(within(dialog).queryByText('Auto-closes')).toBeNull();
  });

  it('hides lifecycle rows and the encounters section for a row that carries none', async () => {
    const dialog = await openDrawer({ ...ROW, contextItems: [] });
    await within(dialog).findByText('Doctor');
    for (const label of ['Approved', 'Closed', 'Reopened', 'Reopen allowed', 'Recordable', 'Auto-closes', 'External reference', 'Spoken language']) {
      expect(within(dialog).queryByText(label)).toBeNull();
    }
    expect(within(dialog).queryByRole('heading', { name: /Encounters/ })).toBeNull();
  });

  it('groups STRUCTURED, segments, full transcript, fact ledger and recaps in Relations (C-06)', async () => {
    const dialog = await openDrawer();
    const relations = (await within(dialog).findByRole('heading', { name: 'Relations' })).closest('section') as HTMLElement;
    for (const [label, count] of [
      ['Structured data', '1'],
      ['Transcript segments', '2'],
      ['Full transcript', '1'],
      ['Fact ledger', '1'],
      ['Encounter recaps', '1'],
    ] as const) {
      expect(within(relations).getByText(label).parentElement?.textContent).toContain(count);
    }
  });

  it('masks the patient as namespace plus the last four characters (C-08)', async () => {
    const dialog = await openDrawer();
    expect(await within(dialog).findByText('alaas:E…P01'.replace('P01', '-P01'))).toBeDefined();
    expect(within(dialog).queryByText('alaas:E2E-1058-P01')).toBeNull();
  });
});

