/**
 * Edit-dialog regression tests — TASK-329 P5 (BUG: empty edit dialog).
 *
 * Root cause: the page rendered <EditDialog report={selectedReport} /> but
 * never set `selectedReport` (no Edit trigger), so the dialog opened with a
 * null report and the seeding effect never ran ⇒ empty form. The fix extracts:
 *   - buildEditFormValues(report): the report → form-values mapping, and
 *   - useEditDialogController(): the open/selected-report wiring (openFor).
 * These two together guarantee the dialog is opened *with* the report's data.
 */

import { renderHook, act } from '@testing-library/react';

import { buildEditFormValues } from '../components/edit-dialog';
import { useEditDialogController } from '../hooks/use-edit-dialog-controller';
import type { DnaReport } from '../api/dna-writing-styles';

const REPORT: DnaReport = {
  id: 'report-1',
  doctorId: 'doctor-1',
  reportData: {
    tone: 'Professional',
    vocabulary: 'Technical',
    structure: 'Structured',
    formality: 'Formal',
    sentenceLength: 'Medium',
    medicalTermUsage: 'High',
    abbreviationStyle: 'Standard',
  },
  styleText: 'Concise clinical documentation style.',
  isLatest: true,
  currentVersionNumber: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-10T00:00:00.000Z',
};

describe('buildEditFormValues', () => {
  it('prefills every style attribute + styleText from the report', () => {
    const values = buildEditFormValues(REPORT);

    expect(values.styleText).toBe('Concise clinical documentation style.');
    expect(values.tone).toBe('Professional');
    expect(values.vocabulary).toBe('Technical');
    expect(values.structure).toBe('Structured');
    expect(values.formality).toBe('Formal');
    expect(values.sentenceLength).toBe('Medium');
    expect(values.medicalTermUsage).toBe('High');
    expect(values.abbreviationStyle).toBe('Standard');
    // changeReason always starts blank — the user must justify each edit.
    expect(values.changeReason).toBe('');
  });

  it('returns blank values for a null report (no crash, empty form)', () => {
    const values = buildEditFormValues(null);
    expect(values.styleText).toBe('');
    expect(values.tone).toBe('');
    expect(values.changeReason).toBe('');
  });
});

describe('useEditDialogController', () => {
  it('starts closed with no report selected', () => {
    const { result } = renderHook(() => useEditDialogController());
    expect(result.current.open).toBe(false);
    expect(result.current.report).toBeNull();
  });

  it('openFor() seeds the selected report AND opens the dialog (the fix)', () => {
    const { result } = renderHook(() => useEditDialogController());

    act(() => result.current.openFor(REPORT));

    expect(result.current.open).toBe(true);
    expect(result.current.report).toEqual(REPORT);
    // The seeded report must map to a fully prefilled form — the regression.
    expect(buildEditFormValues(result.current.report).tone).toBe('Professional');
  });

  it('close() clears the selection so a stale report cannot leak into a reopen', () => {
    const { result } = renderHook(() => useEditDialogController());

    act(() => result.current.openFor(REPORT));
    act(() => result.current.close());

    expect(result.current.open).toBe(false);
    expect(result.current.report).toBeNull();
  });
});
