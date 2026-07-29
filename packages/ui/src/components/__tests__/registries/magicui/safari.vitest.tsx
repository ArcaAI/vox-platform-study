import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Safari } from '../../../registries/magicui/safari';

describe('Safari', () => {
  it('renders without crashing', () => {
    const { container } = render(<Safari url="https://example.com" />);
    expect(container.firstChild).toBeTruthy();
  });
});
