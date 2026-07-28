import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { NeonGradientCard } from '../../../registries/magicui/neon-gradient-card';

describe('NeonGradientCard', () => {
  it('renders without crashing', () => {
    const { container } = render(<NeonGradientCard>Test</NeonGradientCard>);
    expect(container.firstChild).toBeTruthy();
  });
});
