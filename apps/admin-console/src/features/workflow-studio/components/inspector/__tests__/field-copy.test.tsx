/**
 * `FieldCopy` (TASK-893 B3) — summary inline, description behind a `?` popover; summary-absent
 * falls back to a truncated description with the full text still in the popover.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FieldCopy, summaryOf } from '../field-copy';

describe('FieldCopy', () => {
  it('renders nothing when there is no summary and no description', () => {
    const { container } = render(<FieldCopy label="Enabled" />);
    expect(container.querySelector('[data-slot="field-description"]')).toBeNull();
  });

  it('shows the summary inline, untruncated, with a popover for the full description', () => {
    render(<FieldCopy label="Enabled" summary="Skip this node without removing it." description="A much longer normative paragraph about the enabled flag." />);
    expect(screen.getByText('Skip this node without removing it.')).toBeTruthy();
    const trigger = screen.getByRole('button', { name: 'More about Enabled' });
    expect(trigger).toBeTruthy();
  });

  it('falls back to the (truncated) description when summary is absent', () => {
    render(<FieldCopy label="Enabled" description="A much longer normative paragraph about the enabled flag." />);
    const description = screen.getByText('A much longer normative paragraph about the enabled flag.');
    expect(description.className).toContain('truncate');
  });

  it('offers no popover when there is no description to show behind it', () => {
    render(<FieldCopy label="Enabled" summary="Skip this node without removing it." />);
    expect(screen.queryByRole('button', { name: /More about/ })).toBeNull();
  });

  it('the popover trigger names the field it belongs to', () => {
    render(<FieldCopy label="Retry policy" description="Long text." />);
    expect(screen.getByRole('button', { name: 'More about Retry policy' })).toBeTruthy();
  });
});

describe('summaryOf', () => {
  it('reads a string summary off a compiled descriptor', () => {
    expect(summaryOf({ summary: 'Short.' })).toBe('Short.');
  });

  it('returns undefined for a missing, empty, or non-string summary — never throws', () => {
    expect(summaryOf({})).toBeUndefined();
    expect(summaryOf({ summary: '' })).toBeUndefined();
    expect(summaryOf({ summary: 42 })).toBeUndefined();
  });
});
