import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RippleButton } from '../../../registries/magicui/ripple-button';

describe('RippleButton', () => {
  it('renders without crashing', () => {
    const { container } = render(<RippleButton>Test</RippleButton>);
    expect(container.firstChild).toBeTruthy();
  });
});
