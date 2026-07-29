import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Shimmer } from '../../../registries/ai-elements/shimmer';

describe('Shimmer', () => {
  it('renders without crashing', () => {
    const { container } = render(<Shimmer>Loading...</Shimmer>);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders the text content', () => {
    const { getByText } = render(<Shimmer>Thinking...</Shimmer>);
    expect(getByText('Thinking...')).toBeTruthy();
  });
});
