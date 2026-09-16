/**
 * TASK-950 (D-1/D-12a) — the "Identity (user)" row of the field-role table
 * (TASK-951 D-11 renamed the standalone "User identity field" picker into
 * `FieldRoleTable`; this file keeps its original TASK-950 name and keeps
 * testing the identity role's behavior end to end, updated for the new
 * label/wording) on a STRUCTURED / ONE kind: offers only that kind's string
 * properties, writes/deletes `kind.userIdentity`, enforces "at most one
 * marker per definition" with a visible "Held by «kind»" reason, stays
 * absent on kinds the marker cannot apply to, and renders an `Identity`
 * badge on a marked kind — plus an axe scan in both themes.
 */

import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { ContextKindDeclaration, ContextSchemaDefinition } from '../../api/types';
import { DefinitionEditor } from '../definition-editor';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
  cleanup();
});

/**
 * Expand a kind's collapsed Accordion item so its fields render, then open that
 * kind's own "Field roles" disclosure — the roles table moved behind one when
 * the kind editor adopted progressive disclosure, so reaching it is two clicks
 * scoped to the same accordion item.
 */
async function expandKind(keyPattern: RegExp): Promise<void> {
  const trigger = await screen.findByRole('button', { name: keyPattern });
  fireEvent.click(trigger);
  const item = trigger.closest('[data-slot="accordion-item"]');
  const roles = item ? within(item as HTMLElement).queryByRole('button', { name: /Field roles/ }) : null;
  if (roles) fireEvent.click(roles);
}

function structuredOneKind(overrides: Partial<ContextKindDeclaration> = {}): ContextKindDeclaration {
  return {
    key: 'context',
    label: 'Context',
    primitive: 'STRUCTURED',
    phiClass: 'NON_PHI',
    cardinality: 'ONE',
    lifecycle: 'ANY',
    producedBy: ['CLIENT'],
    fields: {
      type: 'object',
      properties: {
        consultant_id: { type: 'string' },
        visit_type: { type: 'string' },
        age: { type: 'number' },
      },
    },
    ...overrides,
  };
}

function definitionWith(kinds: ContextKindDeclaration[]): ContextSchemaDefinition {
  return { schemaVersion: '1.0', kinds, outputs: [] };
}

/** Keeps local state so `onDefinitionChange` actually re-renders what's checked, and reports every change. */
function Harness({ initial, onDefinition }: { initial: ContextSchemaDefinition; onDefinition?: (next: ContextSchemaDefinition) => void }) {
  const [definition, setDefinition] = useState(initial);
  return (
    <DefinitionEditor
      definition={definition}
      onDefinitionChange={(next) => {
        setDefinition(next);
        onDefinition?.(next);
      }}
      problems={null}
    />
  );
}

describe('DefinitionEditor — user identity field (TASK-950)', () => {
  it('offers only the STRUCTURED/ONE kind’s string properties, plus None', async () => {
    renderWithProviders(<Harness initial={definitionWith([structuredOneKind()])} />);
    await expandKind(/context/);

    const trigger = await screen.findByRole('combobox', { name: /Identity \(user\)/ });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['None', 'consultant_id', 'visit_type']);
  });

  it('selecting a property sets kind.userIdentity and shows the Identity badge', async () => {
    let captured: ContextSchemaDefinition | undefined;
    renderWithProviders(<Harness initial={definitionWith([structuredOneKind()])} onDefinition={(next) => (captured = next)} />);
    await expandKind(/context/);

    const trigger = await screen.findByRole('combobox', { name: /Identity \(user\)/ });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('option', { name: 'consultant_id' }));

    await waitFor(() => expect(captured?.kinds[0]?.userIdentity).toEqual({ field: 'consultant_id' }));
    const badge = await screen.findByText('Identity');
    expect(badge.getAttribute('aria-label')).toBe('Identity field: consultant_id');
  });

  it('"None" deletes the key entirely — never leaves userIdentity: undefined/null', async () => {
    let captured: ContextSchemaDefinition | undefined;
    const marked = structuredOneKind({ userIdentity: { field: 'consultant_id' } });
    renderWithProviders(<Harness initial={definitionWith([marked])} onDefinition={(next) => (captured = next)} />);
    await expandKind(/context/);

    expect(await screen.findByText('Identity')).toBeDefined();

    const trigger = await screen.findByRole('combobox', { name: /Identity \(user\)/ });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('option', { name: 'None' }));

    await waitFor(() => expect(captured).toBeDefined());
    expect(Object.keys(captured!.kinds[0]!)).not.toContain('userIdentity');
    expect(screen.queryByText('Identity')).toBeNull();
  });

  it('disables a second kind’s select with a visible "Held by" reason once another kind already carries the marker', async () => {
    const kinds = [
      structuredOneKind({ key: 'context', userIdentity: { field: 'consultant_id' } }),
      structuredOneKind({ key: 'other_context', label: 'Other Context' }),
    ];
    renderWithProviders(<Harness initial={definitionWith(kinds)} />);
    await expandKind(/^context\b/);
    await expandKind(/other_context/);

    const triggers = (await screen.findAllByRole('combobox', { name: /Identity \(user\)/ })) as HTMLButtonElement[];
    expect(triggers).toHaveLength(2);
    expect(triggers[0]!.disabled).toBe(false);
    expect(triggers[1]!.disabled).toBe(true);
    const reason = screen.getByText(/Held by/);
    expect(reason.textContent).toContain('context');
  });

  it('renders no select on a non-STRUCTURED kind or a MANY-cardinality kind', async () => {
    const kinds: ContextKindDeclaration[] = [
      structuredOneKind({ key: 'context' }),
      {
        key: 'transcript_note',
        label: 'Transcript',
        primitive: 'TEXT',
        phiClass: 'PHI',
        cardinality: 'ONE',
        lifecycle: 'ANY',
        producedBy: ['AGENT'],
      },
      structuredOneKind({ key: 'clinical_flags', label: 'Clinical Flags', cardinality: 'MANY' }),
    ];
    renderWithProviders(<Harness initial={definitionWith(kinds)} />);
    await expandKind(/^context\b/);
    await expandKind(/transcript_note/);
    await expandKind(/clinical_flags/);

    const selects = await screen.findAllByRole('combobox', { name: /Identity \(user\)/ });
    expect(selects).toHaveLength(1);
  });

  it('has no axe violations with the select and Identity badge rendered, in both themes', async () => {
    const marked = structuredOneKind({ userIdentity: { field: 'consultant_id' } });
    const { container } = renderWithProviders(<Harness initial={definitionWith([marked])} />);
    await expandKind(/context/);
    expect(await screen.findByText('Identity')).toBeDefined();
    expect(await axe(container)).toHaveNoViolations();
    cleanup();

    document.documentElement.classList.add('dark');
    const dark = renderWithProviders(<Harness initial={definitionWith([marked])} />);
    await expandKind(/context/);
    expect(await screen.findByText('Identity')).toBeDefined();
    expect(await axe(dark.container)).toHaveNoViolations();
  });
});
