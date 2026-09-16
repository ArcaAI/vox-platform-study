/**
 * TASK-951 (D-1/D-11) — `FieldRoleTable`, the field-role table rendered per
 * STRUCTURED/ONE kind in `DefinitionEditor`: Department (+ `by` select),
 * Visit type (only string properties whose `enum` is a subset of
 * `new-visit`/`revisit`), External ref, Stream context and "Materialise as
 * case notes". Covers eligible-field filtering per role, marker
 * set/delete via "None", the `by` toggle, "held elsewhere" disabling
 * (department/visitType/externalRef/streamContext are capped at one kind
 * per definition; `materializeAs` is NOT — several kinds may carry it,
 * gated only on the kind's own shape), the extended accordion-trigger
 * badges, and an axe scan in both themes. The sibling "Identity (user)"
 * role is covered by `definition-editor.user-identity.task950.test.tsx`.
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

async function openSelect(name: RegExp | string): Promise<void> {
  const trigger = await screen.findByRole('combobox', { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

/** A STRUCTURED/ONE kind carrying one eligible field per role, plus an eligible `notes` array. */
function encounterKind(overrides: Partial<ContextKindDeclaration> = {}): ContextKindDeclaration {
  return {
    key: 'encounter',
    label: 'Encounter',
    primitive: 'STRUCTURED',
    phiClass: 'NON_PHI',
    cardinality: 'ONE',
    lifecycle: 'PRE',
    producedBy: ['CLIENT'],
    fields: {
      type: 'object',
      properties: {
        doctor_id: { type: 'string' },
        department_code: { type: 'string' },
        department_name: { type: 'string' },
        visit_type: { type: 'string', enum: ['new-visit', 'revisit'] },
        event_id: { type: 'string' },
        age: { type: 'number' },
        notes: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      },
      required: ['doctor_id', 'event_id', 'department_code', 'visit_type'],
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

describe('FieldRoleTable (TASK-951)', () => {
  it('Department and External ref offer every string field; Visit type offers only the eligible enum field', async () => {
    renderWithProviders(<Harness initial={definitionWith([encounterKind()])} />);
    await expandKind(/encounter/);
    await openSelect('Department');
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'None',
      'doctor_id',
      'department_code',
      'department_name',
      'visit_type',
      'event_id',
    ]);
    cleanup();

    renderWithProviders(<Harness initial={definitionWith([encounterKind()])} />);
    await expandKind(/encounter/);
    await openSelect('External ref');
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'None',
      'doctor_id',
      'department_code',
      'department_name',
      'visit_type',
      'event_id',
    ]);
    cleanup();

    renderWithProviders(<Harness initial={definitionWith([encounterKind()])} />);
    await expandKind(/encounter/);
    await openSelect('Visit type');
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual(['None', 'visit_type']);
  });

  it('selecting a field sets the marker (department defaults `by` to code) — "None" deletes the key entirely', async () => {
    let captured: ContextSchemaDefinition | undefined;
    renderWithProviders(<Harness initial={definitionWith([encounterKind()])} onDefinition={(next) => (captured = next)} />);
    await expandKind(/encounter/);

    await openSelect('Department');
    fireEvent.click(await screen.findByRole('option', { name: 'department_code' }));
    await waitFor(() => expect(captured?.kinds[0]?.department).toEqual({ field: 'department_code', by: 'code' }));

    await openSelect('Visit type');
    fireEvent.click(await screen.findByRole('option', { name: 'visit_type' }));
    await waitFor(() => expect(captured?.kinds[0]?.visitType).toEqual({ field: 'visit_type' }));

    await openSelect('External ref');
    fireEvent.click(await screen.findByRole('option', { name: 'event_id' }));
    await waitFor(() => expect(captured?.kinds[0]?.externalRef).toEqual({ field: 'event_id' }));

    // "None" removes the key outright — never leaves it `undefined`/`null`.
    await openSelect('Department');
    fireEvent.click(await screen.findByRole('option', { name: 'None' }));
    await waitFor(() => expect(Object.keys(captured!.kinds[0]!)).not.toContain('department'));
  });

  it('the department `by` select toggles between code and name, and stays disabled until a field is chosen', async () => {
    let captured: ContextSchemaDefinition | undefined;
    renderWithProviders(<Harness initial={definitionWith([encounterKind()])} onDefinition={(next) => (captured = next)} />);
    await expandKind(/encounter/);

    const byTriggerBefore = (await screen.findByRole('combobox', { name: 'by' })) as HTMLButtonElement;
    expect(byTriggerBefore.disabled).toBe(true);

    await openSelect('Department');
    fireEvent.click(await screen.findByRole('option', { name: 'department_code' }));
    await waitFor(() => expect(captured?.kinds[0]?.department?.field).toBe('department_code'));

    const byTriggerAfter = (await screen.findByRole('combobox', { name: 'by' })) as HTMLButtonElement;
    expect(byTriggerAfter.disabled).toBe(false);

    fireEvent.pointerDown(byTriggerAfter, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('option', { name: 'name' }));
    await waitFor(() => expect(captured?.kinds[0]?.department).toEqual({ field: 'department_code', by: 'name' }));
  });

  it('disables department/visit-type/external-ref/stream-context on a second kind once another kind already carries the marker', async () => {
    const kinds = [
      encounterKind({
        key: 'encounter',
        department: { field: 'department_code', by: 'code' },
        visitType: { field: 'visit_type' },
        externalRef: { field: 'event_id' },
        streamContext: true,
      }),
      encounterKind({ key: 'other_encounter', label: 'Other Encounter' }),
    ];
    renderWithProviders(<Harness initial={definitionWith(kinds)} />);
    await expandKind(/^encounter\b/);
    await expandKind(/other_encounter/);

    const otherPanel = (await screen.findByText('other_encounter')).closest('[data-slot="accordion-item"]') as HTMLElement;
    expect(otherPanel).toBeTruthy();
    const scoped = within(otherPanel);

    expect(((await scoped.findByRole('combobox', { name: 'Department' })) as HTMLButtonElement).disabled).toBe(true);
    expect(((await scoped.findByRole('combobox', { name: 'Visit type' })) as HTMLButtonElement).disabled).toBe(true);
    expect(((await scoped.findByRole('combobox', { name: 'External ref' })) as HTMLButtonElement).disabled).toBe(true);
    expect(((await scoped.findByRole('switch', { name: /Stream context/ })) as HTMLButtonElement).disabled).toBe(true);

    const reasons = scoped.getAllByText(/Held by/);
    expect(reasons).toHaveLength(4);
    for (const reason of reasons) expect(reason.textContent).toContain('encounter');
  });

  it('"Materialise as case notes" is gated on shape, not on "held elsewhere" — several kinds may carry it', async () => {
    const alreadyMarked = encounterKind({ key: 'already_marked', label: 'Already Marked', materializeAs: 'CASE_NOTE' });
    const eligible = encounterKind({ key: 'encounter' });
    const ineligible = encounterKind({
      key: 'other_encounter',
      label: 'Other Encounter',
      fields: { type: 'object', properties: { note: { type: 'string' } } },
    });
    let captured: ContextSchemaDefinition | undefined;
    renderWithProviders(<Harness initial={definitionWith([alreadyMarked, eligible, ineligible])} onDefinition={(next) => (captured = next)} />);
    await expandKind(/already_marked/);
    await expandKind(/^encounter\b/);
    await expandKind(/other_encounter/);

    const alreadyPanel = (await screen.findByText('already_marked')).closest('[data-slot="accordion-item"]') as HTMLElement;
    const eligiblePanel = (await screen.findByText(/^encounter$/)).closest('[data-slot="accordion-item"]') as HTMLElement;
    const otherPanel = (await screen.findByText('other_encounter')).closest('[data-slot="accordion-item"]') as HTMLElement;

    const alreadySwitch = within(alreadyPanel).getByRole('switch', { name: /Materialise notes as case notes/ }) as HTMLButtonElement;
    const eligibleSwitch = within(eligiblePanel).getByRole('switch', { name: /Materialise notes as case notes/ }) as HTMLButtonElement;
    const otherSwitch = within(otherPanel).getByRole('switch', { name: /Materialise notes as case notes/ }) as HTMLButtonElement;

    // A kind already marked stays enabled and checked — never disabled by a sibling ("held elsewhere" does not apply here).
    expect(alreadySwitch.disabled).toBe(false);
    expect(alreadySwitch.getAttribute('data-state')).toBe('checked');
    // A second, differently-shaped kind is free to carry the marker too — not capped at one kind per definition.
    expect(eligibleSwitch.disabled).toBe(false);
    expect(eligibleSwitch.getAttribute('data-state')).toBe('unchecked');
    // The shape gate is independent: a kind without an eligible `notes` array is disabled regardless of siblings.
    expect(otherSwitch.disabled).toBe(true);
    expect(within(otherPanel).getByText(/Requires a “notes” array/)).toBeDefined();

    fireEvent.click(eligibleSwitch);
    await waitFor(() => expect(captured?.kinds[1]?.materializeAs).toBe('CASE_NOTE'));
    // Both marked kinds now coexist, and the already-marked one is untouched by the new one.
    expect(captured?.kinds[0]?.materializeAs).toBe('CASE_NOTE');
  });

  it('renders Department/Visit type/Reference id/Stream/Case notes badges beside Required, with field-naming aria-labels', async () => {
    const marked = encounterKind({
      required: true,
      department: { field: 'department_code', by: 'code' },
      visitType: { field: 'visit_type' },
      externalRef: { field: 'event_id' },
      streamContext: true,
      materializeAs: 'CASE_NOTE',
    });
    renderWithProviders(<Harness initial={definitionWith([marked])} />);

    expect((await screen.findByText('Department')).getAttribute('aria-label')).toBe('Department field: department_code (by code)');
    expect((await screen.findByText('Visit type')).getAttribute('aria-label')).toBe('Visit type field: visit_type');
    // The badge reads "Reference id": an admin authors "your own reference id",
    // and `Ext. ref` was console shorthand for the `externalRef` column name.
    expect((await screen.findByText('Reference id')).getAttribute('aria-label')).toBe('Reference id field: event_id');
    expect((await screen.findByText('Stream')).getAttribute('aria-label')).toBe('Stream context kind: encounter');
    expect((await screen.findByText('Case notes')).getAttribute('aria-label')).toBe('Case notes field: notes');
  });

  it('has no axe violations with every role set, in both themes', async () => {
    const marked = encounterKind({
      department: { field: 'department_code', by: 'code' },
      visitType: { field: 'visit_type' },
      externalRef: { field: 'event_id' },
      streamContext: true,
      materializeAs: 'CASE_NOTE',
    });
    const { container } = renderWithProviders(<Harness initial={definitionWith([marked])} />);
    await expandKind(/encounter/);
    expect(await axe(container)).toHaveNoViolations();
    cleanup();

    document.documentElement.classList.add('dark');
    const dark = renderWithProviders(<Harness initial={definitionWith([marked])} />);
    await expandKind(/encounter/);
    expect(await axe(dark.container)).toHaveNoViolations();
  });
});
