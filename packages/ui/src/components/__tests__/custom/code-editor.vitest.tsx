import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';
import { CodeEditor } from '../../custom/code-editor';

expect.extend(axeMatchers);

const VALID = '{\n  "a": 1\n}';

describe('CodeEditor', () => {
  it('renders the value and highlights it as JSON tokens', () => {
    render(<CodeEditor value={VALID} onChange={() => {}} aria-label="Config JSON" />);
    const textarea = screen.getByLabelText('Config JSON') as HTMLTextAreaElement;
    expect(textarea.value).toBe(VALID);
    // The highlight overlay tokenizes the key.
    expect(screen.getByText('"a"')).toBeDefined();
  });

  it('round-trips typing through onChange', () => {
    const onChange = vi.fn();
    render(<CodeEditor value={VALID} onChange={onChange} aria-label="Config JSON" />);
    const textarea = screen.getByLabelText('Config JSON');
    fireEvent.change(textarea, { target: { value: '{"a":2}' } });
    expect(onChange).toHaveBeenCalledWith('{"a":2}');
  });

  it('marks the field invalid and reports the error line/column', () => {
    render(<CodeEditor value={'{\n  "a":\n}'} onChange={() => {}} aria-label="Config JSON" />);
    const textarea = screen.getByLabelText('Config JSON');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    // The toolbar surfaces a human-readable location.
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/line/i);
    expect(status.textContent).toMatch(/3/);
  });

  it('shows a valid badge for well-formed JSON', () => {
    render(<CodeEditor value={VALID} onChange={() => {}} aria-label="Config JSON" />);
    expect(screen.getByLabelText('Config JSON').getAttribute('aria-invalid')).toBe('false');
    expect(screen.getByRole('status').textContent).toMatch(/valid json/i);
  });

  it('formats (pretty-prints) via the Format action', () => {
    const onChange = vi.fn();
    render(<CodeEditor value={'{"a":1,"b":2}'} onChange={onChange} aria-label="Config JSON" />);
    fireEvent.click(screen.getByRole('button', { name: /format/i }));
    expect(onChange).toHaveBeenCalledWith('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('does not format invalid JSON (Format disabled)', () => {
    const onChange = vi.fn();
    render(<CodeEditor value={'{ nope }'} onChange={onChange} aria-label="Config JSON" />);
    const format = screen.getByRole('button', { name: /format/i }) as HTMLButtonElement;
    expect(format.disabled).toBe(true);
  });

  it('blocks edits when readOnly', () => {
    const onChange = vi.fn();
    render(<CodeEditor value={VALID} onChange={onChange} aria-label="Config JSON" readOnly />);
    const textarea = screen.getByLabelText('Config JSON') as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    // No Format action in read-only mode.
    expect(screen.queryByRole('button', { name: /format/i })).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<CodeEditor value={VALID} onChange={() => {}} aria-label="Config JSON" />);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
