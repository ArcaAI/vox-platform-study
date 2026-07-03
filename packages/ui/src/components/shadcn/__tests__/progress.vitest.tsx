import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { Progress } from '../progress';

function root(container: HTMLElement) {
  return container.querySelector('[data-slot="progress"]') as HTMLElement;
}
function indicator(container: HTMLElement) {
  return container.querySelector('[data-slot="progress-indicator"]') as HTMLElement;
}

// TASK-404 (TASK-377 follow-up): `value` must reach the Radix root so it can
// report aria-valuenow / data-state natively, instead of always "indeterminate".
describe('Progress value forwarding', () => {
  it('reports aria-valuenow and data-state="loading" for an in-flight value', () => {
    const { container } = render(<Progress value={42} />);
    const el = root(container);
    expect(el).toHaveAttribute('aria-valuenow', '42');
    expect(el).toHaveAttribute('data-state', 'loading');
  });

  it('reports data-state="complete" when the value reaches the max', () => {
    const { container } = render(<Progress value={100} />);
    const el = root(container);
    expect(el).toHaveAttribute('aria-valuenow', '100');
    expect(el).toHaveAttribute('data-state', 'complete');
  });

  it('stays indeterminate (no aria-valuenow) when no value is given', () => {
    const { container } = render(<Progress />);
    const el = root(container);
    expect(el).not.toHaveAttribute('aria-valuenow');
    expect(el).toHaveAttribute('data-state', 'indeterminate');
  });

  it('keeps driving the indicator transform from the value', () => {
    const { container } = render(<Progress value={25} />);
    expect(indicator(container).style.transform).toBe('translateX(-75%)');
  });
});
