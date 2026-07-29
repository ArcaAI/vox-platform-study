import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { GlassProgress } from '@/components/registries/einui/glass-progress';

describe('GlassProgress', () => {
  it('renders without crashing', () => {
    const { container } = render(<GlassProgress value={50} />);
    expect(container.firstChild).toBeTruthy();
  });
});
