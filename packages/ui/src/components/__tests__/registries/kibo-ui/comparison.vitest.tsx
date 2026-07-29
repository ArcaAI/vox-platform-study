import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Comparison, ComparisonItem, ComparisonHandle } from '../../../registries/kibo-ui/comparison';

describe('Comparison', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Comparison>
        <ComparisonItem position="left">
          <div>Left</div>
        </ComparisonItem>
        <ComparisonItem position="right">
          <div>Right</div>
        </ComparisonItem>
        <ComparisonHandle />
      </Comparison>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
