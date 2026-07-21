/**
 * TDD unit tests for the type-aware ValueEditorPane: the control
 * mapping per dataType and the `isValueValid` gate that drives Save-disabled.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isJsonType, isValueValid, ValueEditorPane } from '../value-editor-pane';

afterEach(cleanup);

describe('isValueValid', () => {
    it('accepts any string for scalar types', () => {
        expect(isValueValid('String', 'anything')).toBe(true);
        expect(isValueValid('Integer', 'not-a-number')).toBe(true);
        expect(isValueValid('Boolean', 'true')).toBe(true);
    });

    it('requires parseable JSON for Json/Array', () => {
        expect(isJsonType('Json')).toBe(true);
        expect(isJsonType('Array')).toBe(true);
        expect(isValueValid('Json', '{"a":1}')).toBe(true);
        expect(isValueValid('Json', '{ bad json')).toBe(false);
        expect(isValueValid('Array', '[1, 2,]')).toBe(false);
    });
});

describe('ValueEditorPane', () => {
    it('renders a switch for Boolean and toggles the string value', () => {
        const onChange = vi.fn();
        render(<ValueEditorPane id="v" dataType="Boolean" value="false" onChange={onChange} />);
        const toggle = screen.getByRole('switch');
        fireEvent.click(toggle);
        expect(onChange).toHaveBeenCalledWith('true');
    });

    it('renders the code editor for Json (Format + validity toolbar)', () => {
        render(<ValueEditorPane id="v" dataType="Json" value="{ bad" onChange={vi.fn()} ariaLabel="Value" />);
        expect(screen.getByRole('textbox', { name: 'Value' })).toBeDefined();
        expect(screen.getByRole('button', { name: 'Format' })).toBeDefined();
        expect(screen.getByText(/Invalid JSON/)).toBeDefined();
    });

    it('renders a numeric-inputmode input for Integer', () => {
        render(<ValueEditorPane id="v" dataType="Integer" value="42" onChange={vi.fn()} />);
        expect(screen.getByRole('textbox').getAttribute('inputmode')).toBe('numeric');
    });

    it('renders a read-only notice for Binary', () => {
        render(<ValueEditorPane id="v" dataType="Binary" value="" onChange={vi.fn()} />);
        expect(screen.getByText(/Binary values cannot be edited/)).toBeDefined();
        expect(screen.queryByRole('textbox')).toBeNull();
    });
});
