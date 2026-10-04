/**
 * `InlineName` — TASK-1036 review R-C #12.
 *
 *  - Enter (commit) and Escape (cancel) hand focus BACK to the name's button, so a keyboard user is
 *    not dropped onto <body> when the input unmounts (WCAG 2.4.3).
 *  - An empty rename is not dropped silently: the old name stays AND a message says why.
 *  - Leaving the field by blur does not steal focus back — the author moved on.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { InlineName } from '../inline-name';

afterEach(cleanup);

function begin() {
  fireEvent.click(screen.getByRole('button', { name: /Discharge Summary/ }));
  return screen.getByRole('textbox', { name: 'Workflow name' });
}

describe('InlineName — focus and empty names (R-C #12)', () => {
  it('Enter commits and returns focus to the name button', () => {
    const onChange = vi.fn();
    render(<InlineName name="Discharge Summary" onChange={onChange} />);
    const input = begin();
    fireEvent.change(input, { target: { value: 'Discharge Summary v2' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onChange).toHaveBeenCalledWith('Discharge Summary v2');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Discharge Summary/ }));
  });

  it('Escape cancels and returns focus to the name button', () => {
    render(<InlineName name="Discharge Summary" onChange={vi.fn()} />);
    const input = begin();
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Discharge Summary/ }));
  });

  it('an empty name keeps the old one and SAYS so', () => {
    const onChange = vi.fn();
    render(<InlineName name="Discharge Summary" onChange={onChange} />);
    const input = begin();
    fireEvent.change(input, { target: { value: '   ' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onChange).not.toHaveBeenCalled();
    const notice = () => document.querySelector('[data-slot="inline-name-notice"]') as HTMLElement;
    expect(notice().getAttribute('aria-live')).toBe('polite');
    expect(notice().textContent).toMatch(/can’t be empty.*kept “Discharge Summary”/i);
    // The next rename clears the message.
    begin();
    expect(notice().textContent).toBe('');
  });

  it('blur commits without pulling focus back', () => {
    const onChange = vi.fn();
    render(
      <>
        <InlineName name="Discharge Summary" onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );
    const input = begin();
    fireEvent.change(input, { target: { value: 'Blurred' } });
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => {
      elsewhere.focus();
      fireEvent.blur(input);
    });
    expect(onChange).toHaveBeenCalledWith('Blurred');
    expect(document.activeElement).toBe(elsewhere);
  });

  it('0 axe violations, editing and not', async () => {
    const { container } = render(<InlineName name="Discharge Summary" onChange={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
    begin();
    expect(await axe(container)).toHaveNoViolations();
  });
});
