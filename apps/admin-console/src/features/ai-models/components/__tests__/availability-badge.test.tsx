import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AvailabilityBadge } from '../availability-badge';

afterEach(cleanup);

/** Never colour alone (rule 11 §10): every measured state has its own label. */
describe('AvailabilityBadge', () => {
  it.each([
    ['AVAILABLE', 'Available'],
    ['MISSING', 'Missing'],
    ['PARTIAL', 'Partial'],
    ['NOT_APPLICABLE', 'Not applicable'],
    ['UNKNOWN', 'Not inventoried'],
  ] as const)('labels %s as "%s"', (availability, label) => {
    render(<AvailabilityBadge availability={availability} />);
    expect(screen.getByText(label)).toBeDefined();
  });

  it('shows when the inventory last measured the row', () => {
    render(<AvailabilityBadge availability="AVAILABLE" checkedAt={new Date(Date.now() - 5 * 60_000).toISOString()} />);
    expect(screen.getByText('Available')).toBeDefined();
    expect(screen.getByText(/ago/)).toBeDefined();
  });
});
