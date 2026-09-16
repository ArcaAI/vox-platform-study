/**
 * The one line under the schema header that answers "who depends on this?".
 * A line, not a tab — the answer is a sentence, and only the detail behind
 * `View` is a list.
 *
 * Every verdict carries TEXT: colour alone never says accepts vs refuses
 * (rule 11 §7).
 */

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { ContextSchemaUsagesResponse } from '../../api/types';
import { SchemaUsagesLine } from '../schema-usages-line';

afterEach(cleanup);

const ALL_ACCEPT: ContextSchemaUsagesResponse = {
  schemaId: 's-1',
  againstVersion: 3,
  workflows: [
    {
      definitionId: 'wd-1',
      slug: 'cardio',
      name: 'Cardiology intake',
      versionNumber: 3,
      status: 'PUBLISHED',
      isActive: true,
      binding: 'latest',
      boundVersion: null,
      verdict: 'accepts',
      problems: [],
    },
    {
      definitionId: 'wd-2',
      slug: 'ortho',
      name: 'Ortho intake',
      versionNumber: 2,
      status: 'PUBLISHED',
      isActive: true,
      binding: 'latest',
      boundVersion: null,
      verdict: 'accepts',
      problems: [],
    },
  ],
  agents: [
    {
      agentId: 'a-1',
      slug: 'note',
      name: 'Note writer',
      versionNumber: 1,
      status: 'PUBLISHED',
      isActive: true,
      binding: 'latest',
      boundVersion: null,
      verdict: 'accepts',
      problems: [],
    },
  ],
};

const SOME_REFUSE: ContextSchemaUsagesResponse = {
  ...ALL_ACCEPT,
  workflows: [
    ALL_ACCEPT.workflows[0],
    {
      ...ALL_ACCEPT.workflows[1],
      binding: 'pinned',
      boundVersion: 2,
      verdict: 'refuses',
      problems: ['/referral: not declared in the bound version v2'],
    },
  ],
};

describe('SchemaUsagesLine', () => {
  it('summarises accepting consumers in one sentence', () => {
    renderWithProviders(<SchemaUsagesLine usages={ALL_ACCEPT} isPending={false} error={null} />);

    expect(screen.getByText(/Used by 2 workflows and 1 agent/)).toBeDefined();
    expect(screen.getByText(/all accept v3/)).toBeDefined();
  });

  it('leads with the refusal count when a consumer would refuse', () => {
    renderWithProviders(<SchemaUsagesLine usages={SOME_REFUSE} isPending={false} error={null} />);

    expect(screen.getByText(/1 will refuse v3/)).toBeDefined();
  });

  it('says nothing uses it rather than showing an empty View', () => {
    renderWithProviders(
      <SchemaUsagesLine usages={{ schemaId: 's-1', againstVersion: 3, workflows: [], agents: [] }} isPending={false} error={null} />,
    );

    expect(screen.getByText(/No workflow or agent uses this schema yet/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
  });

  it('shows a skeleton while loading and an honest line when the read failed', () => {
    const { container, rerender } = renderWithProviders(<SchemaUsagesLine usages={undefined} isPending error={null} />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);

    rerender(<SchemaUsagesLine usages={undefined} isPending={false} error={new Error('boom')} />);
    expect(screen.getByText(/could not be read/)).toBeDefined();
  });

  it('opens a plain dialog listing every consumer with its binding and verdict as text', () => {
    renderWithProviders(<SchemaUsagesLine usages={SOME_REFUSE} isPending={false} error={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByText('Cardiology intake')).toBeDefined();
    // The accepting workflow AND the accepting agent both follow the pin.
    expect(within(dialog).getAllByText('follows latest')).toHaveLength(2);
    expect(within(dialog).getAllByText('Accepts')).toHaveLength(2);
    expect(within(dialog).getByText('Ortho intake')).toBeDefined();
    expect(within(dialog).getByText('pinned v2')).toBeDefined();
    expect(within(dialog).getByText('Refuses')).toBeDefined();
    expect(within(dialog).getByText('/referral: not declared in the bound version v2')).toBeDefined();
  });

  it('has no axe violations in the line and in the opened dialog', async () => {
    const { container } = renderWithProviders(<SchemaUsagesLine usages={SOME_REFUSE} isPending={false} error={null} />);
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
  });
});
