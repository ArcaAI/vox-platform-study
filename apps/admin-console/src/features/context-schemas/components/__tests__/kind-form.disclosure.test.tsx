/**
 * Progressive disclosure inside the kind editor.
 *
 * A STRUCTURED kind used to put 23 controls in front of an admin at once. The
 * six that decide what a kind IS stay open; the JSON-Schema/PHI/lifecycle
 * machinery and the field-role table are behind closed disclosures. The count
 * assertions below are the contract — if a control moves into Basics, this test
 * is where that decision is recorded.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { ContextKindDeclaration } from '../../api/types';
import { KindForm } from '../kind-form';

afterEach(cleanup);

function structuredKind(overrides: Partial<ContextKindDeclaration> = {}): ContextKindDeclaration {
  return {
    key: 'vitals',
    label: 'Vitals',
    primitive: 'STRUCTURED',
    phiClass: 'PHI',
    cardinality: 'ONE',
    lifecycle: 'PRE',
    producedBy: ['CLIENT'],
    fields: { type: 'object', properties: { bp: { type: 'string' } } },
    ...overrides,
  };
}

/** Everything an admin could operate without opening a disclosure. */
function visibleControlCount(container: HTMLElement): number {
  return container.querySelectorAll(
    'input:not([type="hidden"]), textarea, button[role="combobox"], [role="checkbox"], [role="switch"], .cm-content[contenteditable]',
  ).length;
}

describe('KindForm disclosures', () => {
  it('shows only the six Basics controls at first sight', () => {
    const { container } = renderWithProviders(<KindForm kind={structuredKind()} onChange={() => {}} onRemove={() => {}} />);

    expect(screen.getByLabelText(/^Key/)).toBeDefined();
    expect(screen.getByLabelText(/^Label/)).toBeDefined();
    expect(screen.getByLabelText(/^Primitive/)).toBeDefined();
    expect(screen.getByRole('group', { name: 'Produced by' })).toBeDefined();
    expect(screen.getByLabelText(/Required/)).toBeDefined();
    expect(screen.getByLabelText('Description')).toBeDefined();

    // Key, Label, Primitive, 3 × Produced by, Required, Description = 8 DOM
    // controls across the 6 labelled groups.
    expect(visibleControlCount(container)).toBe(8);

    // Advanced machinery is not on screen until asked for.
    expect(screen.queryByLabelText('PHI class')).toBeNull();
    expect(screen.queryByLabelText('Cardinality')).toBeNull();
    expect(screen.queryByLabelText('Lifecycle')).toBeNull();
    expect(screen.queryByLabelText(/Fields \(JSON Schema\)/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove kind/ })).toBeNull();
  });

  it('reveals PHI class, cardinality, lifecycle, fields, constraints, deprecation and remove under Advanced', () => {
    renderWithProviders(<KindForm kind={structuredKind()} onChange={() => {}} onRemove={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));

    expect(screen.getByLabelText('PHI class')).toBeDefined();
    expect(screen.getByLabelText('Cardinality')).toBeDefined();
    expect(screen.getByLabelText('Lifecycle')).toBeDefined();
    expect(screen.getByLabelText('Fields JSON Schema')).toBeDefined();
    expect(screen.getByLabelText(/MIME types/)).toBeDefined();
    expect(screen.getByLabelText('Max bytes')).toBeDefined();
    expect(screen.getByLabelText('Mark this kind deprecated')).toBeDefined();
    expect(screen.getByRole('button', { name: /Remove kind/ })).toBeDefined();
  });

  it('keeps the field-role table behind its own disclosure, with the sentence that says what a role is', () => {
    renderWithProviders(<KindForm kind={structuredKind()} onChange={() => {}} onRemove={() => {}} />);

    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Field roles/ }));

    expect(screen.getByText('Mark which fields tell HOPE the clinician, the department, the visit type or your own reference id.')).toBeDefined();
    expect(screen.getByRole('table')).toBeDefined();
  });

  it('offers no Field roles disclosure for a kind that cannot carry one', () => {
    renderWithProviders(<KindForm kind={structuredKind({ primitive: 'TEXT', fields: undefined })} onChange={() => {}} onRemove={() => {}} />);

    expect(screen.queryByRole('button', { name: /Field roles/ })).toBeNull();
  });

  it('still edits through onChange once a disclosure is open', () => {
    const onChange = vi.fn();
    renderWithProviders(<KindForm kind={structuredKind()} onChange={onChange} onRemove={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    fireEvent.change(screen.getByLabelText('Max bytes'), { target: { value: '2048' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ constraints: expect.objectContaining({ maxBytes: 2048 }) }));
  });

  it('has no axe violations closed or fully open', async () => {
    const { container } = renderWithProviders(<KindForm kind={structuredKind()} onChange={() => {}} onRemove={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByRole('button', { name: /Field roles/ }));
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
