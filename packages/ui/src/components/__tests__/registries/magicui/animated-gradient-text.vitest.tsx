import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AnimatedGradientText } from '../../../registries/magicui/animated-gradient-text';

describe('AnimatedGradientText', () => {
  it('renders without crashing', () => {
    const { container } = render(<AnimatedGradientText>Test</AnimatedGradientText>);
    expect(container.firstChild).toBeTruthy();
  });
});
