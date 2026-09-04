import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CelExpressionField, celSyntaxProblem } from '../cel-expression-field';

describe('celSyntaxProblem', () => {
  it.each([
    ['', null],
    ['trigger.priority > 3 && has(vars.x)', null],
    ['size(nodes.n1.items) == 0', null],
    ['"a (b" == x', null],
    ['(a + b', 'Missing closing ")".'],
    ['a + b)', 'Unexpected ")" at position 6.'],
    ['"unterminated', 'Unterminated string literal.'],
    ['[1, 2}', 'Unexpected "}" at position 6.'],
  ])('%s -> %s', (expression, problem) => {
    expect(celSyntaxProblem(expression)).toBe(problem);
  });
});

describe('CelExpressionField', () => {
  it('is a labelled textarea that reports a syntax problem inline and inserts references', () => {
    const onChange = vi.fn();
    render(<CelExpressionField id="when" label="When" value="(a" onChange={onChange} references={['trigger', 'vars.count']} />);
    const box = screen.getByLabelText(/when/i);
    expect(box.tagName).toBe('TEXTAREA');
    expect(screen.getByText('Missing closing ")".')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'vars.count' }));
    expect(onChange).toHaveBeenCalledWith('(a vars.count');
    fireEvent.change(box, { target: { value: '(a)' } });
    expect(onChange).toHaveBeenCalledWith('(a)');
  });
});
