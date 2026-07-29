import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Ripple } from '../../../registries/magicui/ripple';

describe('Ripple', () => {
  it('renders without crashing', () => {
    const { container } = render(<Ripple />);
    expect(container.firstChild).toBeTruthy();
  });
});
