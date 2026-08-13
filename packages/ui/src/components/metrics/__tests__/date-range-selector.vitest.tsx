import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { endOfMonth, endOfWeek, endOfYear, startOfMonth, startOfWeek, startOfYear } from 'date-fns';

import { DateRangeSelector, type RangePreset } from '../date-range-selector';

const VALUE = { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30), preset: 'week' as RangePreset };

function items(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="toggle-group-item"]'));
}

describe('DateRangeSelector', () => {
  it('emits the start/end of week via date-fns when "Week" is picked', () => {
    const onChange = vi.fn();
    render(<DateRangeSelector value={{ ...VALUE, preset: 'month' }} onChange={onChange} />);
    fireEvent.click(screen.getByText('Week'));
    const now = new Date();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ preset: 'week' }));
    const arg = onChange.mock.calls.at(-1)![0];
    expect(arg.from.getTime()).toBe(startOfWeek(now).getTime());
    expect(arg.to.getTime()).toBe(endOfWeek(now).getTime());
  });

  it('emits the start/end of month for "Month"', () => {
    const onChange = vi.fn();
    render(<DateRangeSelector value={VALUE} onChange={onChange} />);
    fireEvent.click(screen.getByText('Month'));
    const now = new Date();
    const arg = onChange.mock.calls.at(-1)![0];
    expect(arg.preset).toBe('month');
    expect(arg.from.getTime()).toBe(startOfMonth(now).getTime());
    expect(arg.to.getTime()).toBe(endOfMonth(now).getTime());
  });

  it('emits the start/end of year for "Year"', () => {
    const onChange = vi.fn();
    render(<DateRangeSelector value={VALUE} onChange={onChange} />);
    fireEvent.click(screen.getByText('Year'));
    const now = new Date();
    const arg = onChange.mock.calls.at(-1)![0];
    expect(arg.preset).toBe('year');
    expect(arg.from.getTime()).toBe(startOfYear(now).getTime());
    expect(arg.to.getTime()).toBe(endOfYear(now).getTime());
  });

  it('only renders the presets it is given', () => {
    const { container } = render(<DateRangeSelector value={VALUE} onChange={vi.fn()} presets={['week', 'month']} />);
    expect(items(container)).toHaveLength(2);
    expect(screen.queryByText('Year')).not.toBeInTheDocument();
  });

  it('opens a range calendar and emits preset="custom" when "Custom" is picked', () => {
    const onChange = vi.fn();
    const { container } = render(<DateRangeSelector value={VALUE} onChange={onChange} />);
    fireEvent.click(screen.getByText('Custom'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ preset: 'custom' }));
    expect(container.querySelector('[data-slot="calendar"]') ?? document.querySelector('[data-slot="calendar"]')).toBeTruthy();
  });

  it('emits a custom {from,to} when a day is chosen from the calendar', () => {
    const onChange = vi.fn();
    render(<DateRangeSelector value={VALUE} onChange={onChange} />);
    fireEvent.click(screen.getByText('Custom'));
    onChange.mockClear();
    // June 2026 is the visible month (defaultMonth = value.from).
    const day = document.querySelector('[data-day="6/15/2026"]') as HTMLElement;
    expect(day).toBeTruthy();
    fireEvent.click(day);
    const arg = onChange.mock.calls.at(-1)![0];
    expect(arg.preset).toBe('custom');
    expect(arg.from).toBeInstanceOf(Date);
    expect(arg.to).toBeInstanceOf(Date);
    expect(arg.to.getTime()).toBeGreaterThanOrEqual(arg.from.getTime());
  });

  it('renders the presets as a labelled, radio-style group (arrow-key navigable)', () => {
    const { container } = render(<DateRangeSelector value={VALUE} onChange={vi.fn()} />);
    const group = container.querySelector('[data-slot="toggle-group"]')!;
    expect(group).toHaveAttribute('aria-label', expect.stringMatching(/date range/i));
    const radios = items(container);
    expect(radios.every((r) => r.getAttribute('role') === 'radio')).toBe(true);
    // The active preset (week) is checked — Radix wires arrow-key roving across the radios.
    const week = radios.find((r) => r.getAttribute('aria-label') === 'Week')!;
    expect(week).toHaveAttribute('aria-checked', 'true');
  });
});
