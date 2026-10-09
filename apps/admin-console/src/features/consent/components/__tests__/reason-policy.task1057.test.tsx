/**
 * TASK-1057 — consent evidence (`consent.record`) and the revoke reason (`consent.revoke`)
 * follow the platform policy: offered as optional when off, blocking the submit when required.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { ConsentGrant } from '../../api/types';
import { RecordConsentDialog } from '../record-consent-dialog';
import { RevokeConsentDialog } from '../revoke-consent-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const GRANT: ConsentGrant = {
  id: 'grant-1',
  externalPatientId: 'PAT-1',
  purpose: 'AI_DOCUMENTATION',
  grantedAt: '2026-08-01T00:00:00.000Z',
  grantedBy: 'clinician-1',
  grantMethod: 'VERBAL_ATTESTED',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  version: 1,
};

interface Call {
  url: string;
  body: unknown;
}

function stub(actionId: string, mode: 'required' | 'not-required'): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('action-confirmations/effective')) {
        return Response.json({ items: [{ actionId, kind: actionId === 'consent.record' ? 'evidence' : 'reason', mode, locked: false, maxLength: 500 }] });
      }
      calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return Response.json(GRANT);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('consent.record evidence', () => {
  it('required: Record consent stays disabled until evidence is given, then sends evidenceRef', async () => {
    const calls = stub('consent.record', 'required');
    renderWithProviders(<RecordConsentDialog open onOpenChange={vi.fn()} patientId="PAT-1" />);
    fireEvent.click(await screen.findByRole('checkbox'));
    const record = screen.getByRole('button', { name: 'Record consent' }) as HTMLButtonElement;
    await waitFor(() => expect(record.disabled).toBe(true));
    fireEvent.change(screen.getByLabelText(/Evidence reference/), { target: { value: 's3://consents/abc.pdf' } });
    expect(record.disabled).toBe(false);
    fireEvent.click(record);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.body).toMatchObject({ evidenceRef: 's3://consents/abc.pdf' });
  });

  it('not-required: records without evidence', async () => {
    const calls = stub('consent.record', 'not-required');
    renderWithProviders(<RecordConsentDialog open onOpenChange={vi.fn()} patientId="PAT-1" />);
    fireEvent.click(await screen.findByRole('checkbox'));
    await screen.findByText('(optional)');
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.body).not.toHaveProperty('evidenceRef');
  });
});

describe('consent.revoke reason', () => {
  it('required: Withdraw stays disabled until a reason is typed, then sends it', async () => {
    const calls = stub('consent.revoke', 'required');
    renderWithProviders(<RevokeConsentDialog grant={GRANT} onOpenChange={vi.fn()} />);
    const withdraw = screen.getByRole('button', { name: 'Withdraw consent' }) as HTMLButtonElement;
    await waitFor(() => expect(withdraw.disabled).toBe(true));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'patient called' } });
    expect(withdraw.disabled).toBe(false);
    fireEvent.click(withdraw);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.body).toEqual({ reason: 'patient called', expectedVersion: 1 });
  });

  it('not-required: withdraws without a reason', async () => {
    const calls = stub('consent.revoke', 'not-required');
    renderWithProviders(<RevokeConsentDialog grant={GRANT} onOpenChange={vi.fn()} />);
    await screen.findByText('(optional)');
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent' }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.body).toEqual({ expectedVersion: 1 });
  });
});
