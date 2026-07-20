/**
 * TDD for the PermissionMatrix component (TASK-438 plan step 2): renders the
 * three cell states + legend, pairs every glyph with sr-only text (never
 * color-only), offers a card fallback for mobile, and is axe-clean.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { PermissionMatrix as PermissionMatrixData } from '../../lib/permission-matrix';
import { PermissionMatrix } from '../permission-matrix';


afterEach(cleanup);

const DATA: PermissionMatrixData = {
    rows: [
        { subject: 'Consultation', label: 'Consultation', cells: { read: 'granted', create: 'none', update: 'inherited', delete: 'none', manage: 'none' } },
        { subject: 'Patient', label: 'Patient record', cells: { read: 'conditional', create: 'none', update: 'none', delete: 'none', manage: 'none' } },
    ],
    legend: [
        { state: 'granted', glyph: '✓', label: 'Granted' },
        { state: 'inherited', glyph: '◐', label: 'Inherited from a system policy' },
        { state: 'conditional', glyph: '✓', label: 'Granted with conditions' },
        { state: 'none', glyph: '—', label: 'Not granted' },
    ],
};

describe('PermissionMatrix', () => {
    it('renders a table with a resource column and every action column', () => {
        render(<PermissionMatrix data={DATA} />);
        const table = screen.getByRole('table');
        expect(within(table).getByRole('columnheader', { name: 'Resource' })).toBeDefined();
        for (const action of ['Read', 'Create', 'Update', 'Delete', 'Manage']) {
            expect(within(table).getByRole('columnheader', { name: action })).toBeDefined();
        }
        expect(within(table).getByRole('rowheader', { name: 'Consultation' })).toBeDefined();
    });

    it('pairs each cell state with sr-only text, never color alone', () => {
        render(<PermissionMatrix data={DATA} />);
        // granted read + inherited update + conditional read all surface as text.
        expect(screen.getAllByText('Granted').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Inherited from a system policy').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Granted with conditions').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Not granted').length).toBeGreaterThanOrEqual(1);
    });

    it('always shows the legend', () => {
        render(<PermissionMatrix data={DATA} />);
        const legend = screen.getByRole('list', { name: 'Legend' });
        expect(within(legend).getByText('Granted')).toBeDefined();
        expect(within(legend).getByText('Not granted')).toBeDefined();
    });

    it('renders per-resource cards with action chips in the card layout', () => {
        render(<PermissionMatrix data={DATA} layout="cards" />);
        expect(screen.queryByRole('table')).toBeNull();
        const list = screen.getByRole('list', { name: 'Permissions by resource' });
        expect(within(list).getByText('Consultation')).toBeDefined();
        // Chip carries the action label plus the state as text.
        expect(within(list).getAllByText('Read').length).toBeGreaterThanOrEqual(1);
    });

    it('has no axe violations (table)', async () => {
        const { container } = render(<PermissionMatrix data={DATA} />);
        expect(await axe(container)).toHaveNoViolations();
    });

    it('has no axe violations (cards)', async () => {
        const { container } = render(<PermissionMatrix data={DATA} layout="cards" />);
        expect(await axe(container)).toHaveNoViolations();
    });
});
