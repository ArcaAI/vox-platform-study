import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { GlassBadge } from '@/components/registries/einui/glass-badge';

describe('GlassBadge', () => {
  it('renders without crashing', () => {
    const { container } = render(<GlassBadge>Test</GlassBadge>);
    expect(container.firstChild).toBeTruthy();
  });
});
