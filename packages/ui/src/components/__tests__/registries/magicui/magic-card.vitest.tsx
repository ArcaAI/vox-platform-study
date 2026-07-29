import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MagicCard } from '../../../registries/magicui/magic-card';

describe('MagicCard', () => {
  it('renders without crashing', () => {
    const { container } = render(<MagicCard>Test</MagicCard>);
    expect(container.firstChild).toBeTruthy();
  });
});
