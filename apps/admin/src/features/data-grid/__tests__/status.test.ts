import type { Row } from '@tanstack/react-table';
import { describe, expect, it } from 'vitest';
import { multiSelectFilterFn, resourceStatusLabel, resourceStatusRole } from '../status';

function rowWith(value: string): Row<unknown> {
    return { getValue: () => value } as unknown as Row<unknown>;
}

const noop = () => undefined;

describe('resourceStatusRole', () => {
    it('maps known statuses to semantic color roles', () => {
        expect(resourceStatusRole('ENABLED')).toBe('success');
        expect(resourceStatusRole('DISABLED')).toBe('warning');
        expect(resourceStatusRole('ARCHIVED')).toBe('neutral');
        expect(resourceStatusRole(undefined)).toBe('neutral');
    });
});

describe('resourceStatusLabel', () => {
    it('title-cases the status value', () => {
        expect(resourceStatusLabel('ENABLED')).toBe('Enabled');
        expect(resourceStatusLabel(undefined)).toBe('Unknown');
    });
});

describe('multiSelectFilterFn', () => {
    it('keeps all rows when the filter set is empty', () => {
        expect(multiSelectFilterFn(rowWith('ENABLED'), 'resourceStatus', [], noop)).toBe(true);
    });

    it('keeps rows whose value is in the selected set', () => {
        expect(multiSelectFilterFn(rowWith('ENABLED'), 'resourceStatus', ['ENABLED', 'DISABLED'], noop)).toBe(true);
    });

    it('drops rows whose value is not selected', () => {
        expect(multiSelectFilterFn(rowWith('ARCHIVED'), 'resourceStatus', ['ENABLED'], noop)).toBe(false);
    });
});
