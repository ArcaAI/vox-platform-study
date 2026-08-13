/**
 * consultation list column. Pure component: real rows in,
 * search/select/open callbacks out. No SDK or SSE.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsultationsColumn, type ConsultationListRow } from '../consultations-column';

const ROWS: ConsultationListRow[] = [
  { id: 'c-1', patientId: 'P-448', status: 'RECORDING', createdAt: '2026-07-06T14:02:00.000Z' },
  { id: 'c-2', patientId: 'P-702', status: 'CLOSED', createdAt: '2026-07-05T09:00:00.000Z' },
];

function setup(overrides: Partial<React.ComponentProps<typeof ConsultationsColumn>> = {}) {
  const props = {
    rows: ROWS,
    isLoading: false,
    error: null,
    selectedId: 'c-1',
    onSelect: vi.fn(),
    onOpenPatient: vi.fn(async () => undefined),
    activeIsRecording: true,
    ...overrides,
  };
  return { props, ...render(<ConsultationsColumn {...props} />) };
}

afterEach(cleanup);

describe('ConsultationsColumn', () => {
  it('renders each patient with a count and a REC badge on the active recording row', () => {
    setup();
    expect(screen.getByText('Consultations (2)')).toBeTruthy();
    expect(screen.getByText('P-448')).toBeTruthy();
    expect(screen.getByText('REC')).toBeTruthy();
  });

  it('filters rows by the search query', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/search consultations/i), { target: { value: '702' } });
    expect(screen.queryByText('P-448')).toBeNull();
    expect(screen.getByText('P-702')).toBeTruthy();
  });

  it('calls onSelect with the row when a consultation is clicked', () => {
    const { props } = setup({ selectedId: null, activeIsRecording: false });
    fireEvent.click(screen.getByText('P-702'));
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-2' }));
  });

  it('opens a new consultation from the New form', async () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: /new/i }));
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-900' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));
    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-900'));
  });

  it('validates a required patient id before opening', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: /new/i }));
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));
    expect(screen.getByText(/patient id is required/i)).toBeTruthy();
    expect(props.onOpenPatient).not.toHaveBeenCalled();
  });

  it('shows an empty state when there are no consultations', () => {
    setup({ rows: [] });
    expect(screen.getByText(/no consultations yet/i)).toBeTruthy();
  });

  it('renders a skeleton while loading', () => {
    const { container } = setup({ isLoading: true, rows: [] });
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it('shows an error message', () => {
    setup({ error: 'boom', rows: [] });
    expect(within(screen.getByRole('alert')).getByText('boom')).toBeTruthy();
  });
});
